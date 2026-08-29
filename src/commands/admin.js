import crypto from 'crypto';
import {
  getCollection, getSettings, updateSettings, log, sendTelegramMessage, editTelegramMessage, deleteTelegramMessage, toSmallCaps, getMainToken, esc
} from '../bot-common.js';
import {
  getBotUsername, getDbChannelId, checkSubscription, isBotAdmin, extractChannelMessage, copyIntoDbChannel, copyFromDbChannel, getMainBotUsername, resolveUser
} from '../bot-helpers.js';
import {
  getBatchSession, setBatchSession, addIdToBatch, clearBatchSession, updateBatchSessionMeta, checkAndClearAdminWaiting, setAdminWaitingForFile, storeFile, generateFileCode
} from '../filestore.js';
import { handleStartPayload } from './start.js';
import { banUser, unbanUser, getBannedList, broadcastToAll, getUserStats, addReferral } from '../bot-users.js';

export async function processAdminMessage(chatId, rawText, message, req, res) {
  const sessions = await getCollection('sessions');
  const batchSession = await getBatchSession(chatId);

  if (batchSession) {
    const dbChannelId = await getDbChannelId();
    if (!dbChannelId) {
      await clearBatchSession(chatId);
      await sendTelegramMessage(chatId, `❌ <b>Database Channel is not configured.</b>\n\nPlease set it in the bot settings first.`);
      return res.status(200).send('OK');
    }

    const extracted = await extractChannelMessage(message);
    if (extracted) {
      if (batchSession.step === 'first') {
        const copyResult = await copyIntoDbChannel(dbChannelId, extracted.channelId, extracted.msgId);
        if (!copyResult.ok) {
          await sendTelegramMessage(chatId, `❌ <b>Failed to copy message.</b>\nReason: ${copyResult.reason}`);
          return res.status(200).send('OK');
        }
        await setBatchSession(chatId, {
          step:          'last',
          collectedIds:  [copyResult.messageId],
          srcChannelId:  extracted.channelId,
          srcFirstMsgId: extracted.msgId,
          dbFirstMsgId:  copyResult.messageId,
        });
        await sendTelegramMessage(chatId, `` +
          `✅ <b>First message saved!</b>\n\n` +
          `Now forward the <b>last message</b> for a range, or keep forwarding <b>individual files</b>.`
        );
        return res.status(200).send('OK');
      }
      if (batchSession.step === 'last') {
        if (extracted.channelId === batchSession.srcChannelId && extracted.msgId > batchSession.srcFirstMsgId) {
          const totalFiles = extracted.msgId - batchSession.srcFirstMsgId + 1;
          if (totalFiles > 500) {
             await sendTelegramMessage(chatId, `⚠️ <b>Range too large!</b>\n\nYou can only add up to 500 files at once. This range is <b>${totalFiles}</b> files.`);
             return res.status(200).send('OK');
          }
          for (let srcId = batchSession.srcFirstMsgId + 1; srcId <= extracted.msgId; srcId++) {
            const r = await copyIntoDbChannel(dbChannelId, batchSession.srcChannelId, srcId);
            if (r.ok && r.messageId) await addIdToBatch(chatId, r.messageId);
            if (totalFiles > 5) await new Promise((r) => setTimeout(r, 50));
          }
          const updatedSession = await getBatchSession(chatId);
          const collectedIds = updatedSession?.collectedIds || [];
          const { storeBatch, generateBatchCode } = await import('../filestore.js');
          const batchCode = generateBatchCode();
          await storeBatch(batchCode, dbChannelId, collectedIds);
          await clearBatchSession(chatId);
          const botUsername = await getBotUsername();
          await sendTelegramMessage(chatId, `✅ <b>Batch Created!</b>\n\nFiles: <b>${collectedIds.length}</b>\nLink: https://t.me/${botUsername}?start=${batchCode}`, {
            inline_keyboard: [[{ text: '⬅️ Back to Dashboard', callback_data: 'admin:dashboard' }]]
          });
          return res.status(200).send('OK');
        } else {
          await sendTelegramMessage(chatId, `❌ <b>Invalid message for range!</b>\n\nThe last message must be from the same channel as the first message and must have a larger message ID.\n\nPlease try forwarding a valid last message from the channel, or send /cancel to abort.`);
          return res.status(200).send('OK');
        }
      }
    }

    const hasFile = message.document || message.video || message.audio || (message.photo && message.photo.length > 0);
    if (hasFile) {
      const currentCount = batchSession.collectedIds ? batchSession.collectedIds.length : 0;
      if (currentCount >= 500) {
        await sendTelegramMessage(chatId, `⚠️ <b>Batch Limit Reached!</b>\n\nYou can only add up to 500 files per batch. Please finish this batch or cancel.`, {
          inline_keyboard: [
            [{ text: '✅ Finish Batch', callback_data: 'admin:batch_done' }],
            [{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]
          ]
        });
        return res.status(200).send('OK');
      }

      const copyResult = await copyIntoDbChannel(dbChannelId, chatId, message.message_id);
      if (copyResult.ok) {
        const count = await addIdToBatch(chatId, copyResult.messageId);

        if (batchSession.step !== 'collect') {
           await updateBatchSessionMeta(chatId, { step: 'collect' });
        }

        await sendTelegramMessage(chatId, `📥 <b>File added!</b> (Total: ${count})`, {
          inline_keyboard: [
            [{ text: '✅ Finish Batch', callback_data: 'admin:batch_done' }],
            [{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]
          ]
        });
        return res.status(200).send('OK');
      }
    }
  }

  const wsDoc = await sessions.findOne({ _id: `admin:waiting_setting:${chatId}` });
  const waitingFor = wsDoc && wsDoc.expiresAt > new Date() ? wsDoc.val : null;
  if (waitingFor) {
    if (rawText === '/cancel') {
      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });
      await sendTelegramMessage(chatId, `✅ Cancelled.`);
      return res.status(200).send('OK');
    }

    if (waitingFor === 'fs_fsub_msg_forward') {
      const forwardChat   = message.forward_from_chat;
      const forwardOrigin = message.forward_origin;
      const typedId        = rawText.trim();

      let targetCid;
      let targetTitle;

      if (forwardChat?.type === 'channel') {
        targetCid   = forwardChat.id;
        targetTitle = forwardChat.title;
      } else if (forwardOrigin?.type === 'channel' && forwardOrigin.chat) {
        targetCid   = forwardOrigin.chat.id;
        targetTitle = forwardOrigin.chat.title;
      } else if (/^-100\d+$/.test(typedId)) {
        targetCid   = typedId;
        targetTitle = typedId;
      } else {
        await sendTelegramMessage(chatId, `❌ <b>Please forward a message directly from the channel, or send the channel ID directly</b> (e.g. <code>-100123456789</code>).`);
        return res.status(200).send('OK');
      }

      if (!(await isBotAdmin(targetCid))) {
        await sendTelegramMessage(chatId, `❌ <b>Bot is not an admin in this channel!</b>\n\nPlease add the bot as an administrator in the channel with Post Messages permissions and try again.`);
        return res.status(200).send('OK');
      }

      await sessions.updateOne(
        { _id: `admin:fsub_pending_add:${chatId}` },
        { $set: { val: { id: targetCid, title: targetTitle }, expiresAt: new Date(Date.now() + 600 * 1000) } },
        { upsert: true }
      );
      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });

      await sendTelegramMessage(chatId, `Choose Force Sub Mode`, {
        inline_keyboard: [
          [{ text: "Normal Mode", callback_data: "admin:fs_fsub_setmode:normal" }],
          [{ text: "Join Request Mode", callback_data: "admin:fs_fsub_setmode:join_request" }],
          [{ text: "❌ Cancel", callback_data: "admin:cancel_session" }]
        ]
      });
      return res.status(200).send('OK');
    }

    if (waitingFor === 'dbChannelId') {
      if (!/^-100\d+$/.test(rawText)) {
        await sendTelegramMessage(chatId, `❌ <b>Invalid DB Channel ID!</b>\n\nChannel ID must match pattern <code>-100dddddddddd</code>. Please try again or send /cancel.`);
        return res.status(200).send('OK');
      }
    } else if (waitingFor === 'forceSubscribeChannels') {
      const trimmed = rawText.trim();
      if (trimmed !== '') {
        const channels = trimmed.split(',').map(s => s.trim());
        const allValid = channels.every(c => /^-100\d+$/.test(c));
        if (!allValid) {
          await sendTelegramMessage(chatId, `❌ <b>Invalid Force Subscribe Channel ID(s)!</b>\n\nMust be a comma-separated list of Channel IDs matching <code>-100dddddddddd</code>. Please try again or send /cancel.`);
          return res.status(200).send('OK');
        }
      }
    }

    let value = rawText;
    if (waitingFor === 'tutorialFileId') value = message.video?.file_id || message.document?.file_id;
    if (waitingFor === 'startPhoto') value = message.photo?.[message.photo.length - 1]?.file_id;

    if (!value) return res.status(200).send('OK');
    await updateSettings({ [waitingFor]: value });
    await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });

    let backCb = 'admin:fs_settings';
    if (['startText', 'startPhoto'].includes(waitingFor)) backCb = 'admin:fs_cfg:start';
    else if (['forceSubscribeChannels', 'forceSubscribeMsg'].includes(waitingFor)) backCb = 'admin:fs_cfg:fsub';
    else if (['shortenerUrl', 'shortenerKey', 'validityHours', 'tutorialFileId'].includes(waitingFor)) backCb = 'admin:fs_cfg:tkn';

    await sendTelegramMessage(chatId, `✅ Updated <b>${waitingFor}</b>!`, {
      inline_keyboard: [[{ text: '⬅️ Back to Settings', callback_data: backCb }]]
    });
    return res.status(200).send('OK');
  }

  const waDoc = await sessions.findOne({ _id: `admin:waiting_action:${chatId}` });
  const waitingAction = waDoc && waDoc.expiresAt > new Date() ? waDoc.val : null;
  if (waitingAction) {
    if (rawText === '/cancel') {
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
      await sendTelegramMessage(chatId, `✅ Cancelled.`);
      return res.status(200).send('OK');
    }

    if (waitingAction === 'broadcast') {
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });

      const { sent } = await broadcastToAll(rawText);
      await logHistory(`broadcast_tg: ${sent} users`, 'tg');
      await sendTelegramMessage(chatId, `✅ <b>Broadcast Complete!</b>\n\nSent to: <b>${sent} users</b>`, {
        inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin:dashboard' }]]
      });
      return res.status(200).send('OK');
    }

    if (waitingAction === 'ban') {
      const targetId = rawText.match(/(\d+)/)?.[1];
      if (!targetId) return sendTelegramMessage(chatId, `❌ Invalid User ID.`);
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
      await banUser(targetId);
      await logHistory(`banned_tg: ${targetId}`, 'tg');
      await sendTelegramMessage(chatId, `✅ User <code>${targetId}</code> has been banned.`, {
        inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin:user_mgmt' }]]
      });
      return res.status(200).send('OK');
    }

    if (waitingAction === 'unban') {
      const targetId = rawText.match(/(\d+)/)?.[1];
      if (!targetId) return sendTelegramMessage(chatId, `❌ Invalid User ID.`);
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
      await unbanUser(targetId);
      await logHistory(`unbanned_tg: ${targetId}`, 'tg');
      await sendTelegramMessage(chatId, `✅ User <code>${targetId}</code> has been unbanned.`, {
        inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin:user_mgmt' }]]
      });
      return res.status(200).send('OK');
    }
  }

  const wpDoc = await sessions.findOne({ _id: `admin:waiting_premium_user:${chatId}` });
  const isWaitingPremium = wpDoc && wpDoc.expiresAt > new Date() ? wpDoc.val : null;
  if (isWaitingPremium) {
    const targetUserId = await resolveUser(rawText);

    if (!targetUserId) {
      await sendTelegramMessage(chatId, `❌ User not found.`);
      return res.status(200).send('OK');
    }

    await sessions.updateOne(
      { _id: `admin:premium_target:${chatId}` },
      { $set: { val: targetUserId, expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await sessions.deleteOne({ _id: `admin:waiting_premium_user:${chatId}` });

    const pmDoc = await sessions.findOne({ _id: `admin:premium_msg_id:${chatId}` });
    const msgId = pmDoc && pmDoc.expiresAt > new Date() ? pmDoc.val : null;
    const durationKb = {
      inline_keyboard: [
        [{ text: '7 Days', callback_data: 'admin:fs_set_premium:7' }, { text: '30 Days', callback_data: 'admin:fs_set_premium:30' }],
        [{ text: '365 Days', callback_data: 'admin:fs_set_premium:365' }],
        [{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]
      ]
    };

    if (msgId) {
      await editTelegramMessage(chatId, msgId, `⭐ <b>Select Duration</b> for <code>${targetUserId}</code>:`, durationKb);
      await deleteTelegramMessage(chatId, message.message_id);
    } else {
      await sendTelegramMessage(chatId, `⭐ <b>Select Duration</b> for <code>${targetUserId}</code>:`, durationKb);
    }
    return res.status(200).send('OK');
  }

  if (await checkAndClearAdminWaiting(chatId)) {
    const dbChannelId = await getDbChannelId();
    if (!dbChannelId) {
      await sendTelegramMessage(chatId, `❌ <b>Database Channel is not configured.</b>\n\nPlease set it in the bot settings first.`);
      return res.status(200).send('OK');
    }

    let type = message.document ? 'document' : message.video ? 'video' : message.audio ? 'audio' : message.photo ? 'photo' : null;
    if (type) {
      const copyResult = await copyIntoDbChannel(dbChannelId, chatId, message.message_id);
      if (copyResult.ok) {
        const code = generateFileCode();
        await storeFile(code, {
          dbChannelId,
          dbMessageId: copyResult.messageId,
          type: type,
          fileId: message.document?.file_id || message.video?.file_id || message.audio?.file_id || message.photo?.[0]?.file_id
        });
        const bot = await getBotUsername();
        await sendTelegramMessage(chatId, `✅ <b>File Stored!</b>\n\nLink: https://t.me/${bot}?start=${code}`, {
          inline_keyboard: [[{ text: '⬅️ Back to Dashboard', callback_data: 'admin:dashboard' }]]
        });
      } else {
        await sendTelegramMessage(chatId, `❌ <b>Failed to store file.</b>\n\nMake sure the bot is an administrator in the DB channel and has permission to post messages.`);
      }
    }
    return res.status(200).send('OK');
  }

  return null;
}
