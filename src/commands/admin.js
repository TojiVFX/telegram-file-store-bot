import crypto from 'crypto';
import {
  getCollection, getSettings, updateSettings, log, sendTelegramMessage, editTelegramMessage, deleteTelegramMessage, toSmallCaps, getMainToken, esc, logHistory
} from '../bot-common.js';
import {
  getBotUsername, getDbChannelId, getBackupDbChannelId, checkSubscription, isBotAdmin, extractChannelMessage, copyIntoDbChannel, copyFromDbChannel, getMainBotUsername, resolveUser,
  forwardMessage, extractChannelMessageRange
} from '../bot-helpers.js';
import {
  getBatchSession, setBatchSession, addIdToBatch, clearBatchSession, updateBatchSessionMeta, checkAndClearAdminWaiting, setAdminWaitingForFile, storeFile, generateFileCode,
  isBulkStoreActive, setBulkStoreActive, addToStoreSession, getStoreSession, clearStoreSession, generateLinksExportText, generateRawLinksText,
  generateBundleCode, storeBundle, getBundleSession, setBundleSession, addQualityToBundle, clearBundleSession, detectMediaQuality, formatBytes,
  cleanMediaFileName, extractMediaTitle, sortQualities
} from '../filestore.js';
import { handleStartPayload } from './start.js';
import { banUser, unbanUser, getBannedList, broadcastToAll, getUserStats, addReferral } from '../bot-users.js';

export async function processAdminMessage(chatId, rawText, message, req) {
  const sessions = await getCollection('sessions');

  const bulkActive = await isBulkStoreActive(chatId);
  if (bulkActive) {
    if (rawText === '/cancel') {
      await setBulkStoreActive(chatId, false);
      await clearStoreSession(chatId);
      await sendTelegramMessage(chatId, `✅ <b>Bulk Store cancelled.</b>`, {
        inline_keyboard: [[{ text: toSmallCaps('Back to File Management'), callback_data: 'admin:file_mgmt' }]]
      });
      return true;
    }

    if (rawText === '/done') {
      const codes = await getStoreSession(chatId);
      await setBulkStoreActive(chatId, false);
      await clearStoreSession(chatId);
      if (!codes.length) {
        await sendTelegramMessage(chatId, `⚠️ <b>No files were stored in this session.</b>`, {
          inline_keyboard: [[{ text: toSmallCaps('Back to File Management'), callback_data: 'admin:file_mgmt' }]]
        });
        return true;
      }

      const bot = await getBotUsername();
      const filesColl = await getCollection('files');
      const storedRecords = await filesColl.find({ _id: { $in: codes } }).toArray();

      const rawBlock = generateRawLinksText(codes, bot);
      const txtContent = generateLinksExportText(storedRecords.length ? storedRecords : codes.map(c => ({ _id: c })), bot, 'Bulk Stored Files');
      const buffer = Buffer.from(txtContent, 'utf-8');
      const filename = `bulk_store_${codes.length}_links_${new Date().toISOString().slice(0, 10)}.txt`;

      await sendTelegramMessage(chatId, `📋 <b>Bulk Store Complete! (${codes.length} Files Stored)</b>\n\nTap the box below to copy all links at once:\n<pre>${rawBlock}</pre>`, {
        inline_keyboard: [
          [{ text: toSmallCaps('Store More Files'), callback_data: 'admin:bulk_store_start' }],
          [{ text: toSmallCaps('Back to File Management'), callback_data: 'admin:file_mgmt' }]
        ]
      });

      const { sendTelegramFileBuffer } = await import('../bot-common.js');
      await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>Exported ${codes.length} Links (.txt)</b>`);
      return true;
    }

    const hasMedia = message.document || message.video || message.audio || (message.photo && message.photo.length > 0);
    if (hasMedia) {
      const dbChannelId = await getDbChannelId();
      if (!dbChannelId) {
        await setBulkStoreActive(chatId, false);
        await clearStoreSession(chatId);
        await sendTelegramMessage(chatId, `❌ <b>Database Channel is not configured.</b>\n\nPlease set it in the bot settings first.`);
        return true;
      }

      let type = message.document ? 'document' : message.video ? 'video' : message.audio ? 'audio' : message.photo ? 'photo' : 'file';
      const copyResult = await copyIntoDbChannel(dbChannelId, chatId, message.message_id);
      if (copyResult.ok) {
        let backupMessageId = null;
        const backupDbChannelId = await getBackupDbChannelId();
        if (backupDbChannelId) {
          const backupRes = await copyIntoDbChannel(backupDbChannelId, chatId, message.message_id);
          if (backupRes?.ok) backupMessageId = backupRes.messageId;
        }

        const quality = detectMediaQuality(message);
        const rawSize = message.video?.file_size || message.document?.file_size || message.audio?.file_size || 0;
        const sizeLabel = formatBytes(rawSize);
        const title = extractMediaTitle(message);
        const rawFileName = message.document?.file_name || message.video?.file_name || message.audio?.file_name || '';

        const code = generateFileCode();
        await storeFile(code, {
          dbChannelId,
          dbMessageId: copyResult.messageId,
          backupDbChannelId: backupMessageId ? backupDbChannelId : undefined,
          backupDbMessageId: backupMessageId || undefined,
          type: type,
          fileId: message.document?.file_id || message.video?.file_id || message.audio?.file_id || message.photo?.[0]?.file_id,
          title: title || undefined,
          fileName: rawFileName || undefined,
          quality: (type === 'video' || type === 'document') ? quality : undefined,
          fileSize: rawSize || undefined,
          fileSizeLabel: rawSize ? sizeLabel : undefined,
          accessCount: 0
        }, { userId: chatId });
        const count = await addToStoreSession(chatId, code);
        const bot = await getBotUsername();
        const link = `https://t.me/${bot}?start=${code}`;

        const detailsLine = (type === 'video' || type === 'document')
          ? `\n📁 <b>Title:</b> <code>${esc(title)}</code>\n📀 <b>Quality:</b> <code>${quality} • ${sizeLabel}</code>\n`
          : (rawSize ? `\n💾 <b>Size:</b> <code>${sizeLabel}</code>\n` : '\n');

        await sendTelegramMessage(chatId, `📥 <b>File ${count} Stored!</b>${detailsLine}Link: <code>${link}</code>\n\nSend another file, or tap below when finished:`, {
          inline_keyboard: [
            [{ text: toSmallCaps(`Done & Get All Links (${count})`), callback_data: 'admin:bulk_store_done' }],
            [{ text: toSmallCaps('Cancel'), callback_data: 'admin:bulk_store_cancel' }]
          ]
        });
        return true;
      } else {
        await sendTelegramMessage(chatId, `❌ <b>Failed to store file.</b>\n\nMake sure the bot is an administrator in the DB channel and has permission to post messages.`);
        return true;
      }
    }
  }

  const batchSession = await getBatchSession(chatId);

  if (batchSession) {
    const dbChannelId = await getDbChannelId();
    if (!dbChannelId) {
      await clearBatchSession(chatId);
      await sendTelegramMessage(chatId, `❌ <b>Database Channel is not configured.</b>\n\nPlease set it in the bot settings first.`);
      return true;
    }

    const extracted = await extractChannelMessage(message);
    if (extracted) {
      if (batchSession.step === 'first') {
        const copyResult = await copyIntoDbChannel(dbChannelId, extracted.channelId, extracted.msgId);
        if (!copyResult.ok) {
          await sendTelegramMessage(chatId, `❌ <b>Failed to copy message.</b>\nReason: ${copyResult.reason}`);
          return true;
        }
        let backupFirstId = null;
        const backupDbChannelId = await getBackupDbChannelId();
        if (backupDbChannelId) {
          const bRes = await copyIntoDbChannel(backupDbChannelId, extracted.channelId, extracted.msgId);
          if (bRes.ok && bRes.messageId) backupFirstId = bRes.messageId;
        }
        await setBatchSession(chatId, {
          step:               'last',
          collectedIds:       [copyResult.messageId],
          backupCollectedIds: backupFirstId ? [backupFirstId] : [],
          srcChannelId:       extracted.channelId,
          srcFirstMsgId:      extracted.msgId,
          dbFirstMsgId:       copyResult.messageId,
          backupDbFirstMsgId: backupFirstId,
        });
        await sendTelegramMessage(chatId, `` +
          `✅ <b>First message saved!</b>\n\n` +
          `Now forward the <b>last message</b> for a range, or keep forwarding <b>individual files</b>.`
        );
        return true;
      }
      if (batchSession.step === 'last') {
        if (extracted.channelId === batchSession.srcChannelId && extracted.msgId > batchSession.srcFirstMsgId) {
          const totalFiles = extracted.msgId - batchSession.srcFirstMsgId + 1;
          if (totalFiles > 500) {
             await sendTelegramMessage(chatId, `⚠️ <b>Range too large!</b>\n\nYou can only add up to 500 files at once. This range is <b>${totalFiles}</b> files.`);
             return true;
          }
          const backupDbChannelId = await getBackupDbChannelId();
          for (let srcId = batchSession.srcFirstMsgId + 1; srcId <= extracted.msgId; srcId++) {
            const r = await copyIntoDbChannel(dbChannelId, batchSession.srcChannelId, srcId);
            let backupId = null;
            if (backupDbChannelId && r.ok) {
              const bRes = await copyIntoDbChannel(backupDbChannelId, batchSession.srcChannelId, srcId);
              if (bRes.ok && bRes.messageId) backupId = bRes.messageId;
            }
            if (r.ok && r.messageId) await addIdToBatch(chatId, r.messageId, backupId);
            if (totalFiles > 5) await new Promise((r) => setTimeout(r, 50));
          }
          const updatedSession = await getBatchSession(chatId);
          const collectedIds = updatedSession?.collectedIds || [];
          const backupCollectedIds = updatedSession?.backupCollectedIds || [];
          const { storeBatch, generateBatchCode } = await import('../filestore.js');
          const batchCode = generateBatchCode();
          await storeBatch(batchCode, dbChannelId, collectedIds, {}, { backupDbChannelId, backupDbMessageIds: backupCollectedIds });
          await clearBatchSession(chatId);
          const botUsername = await getBotUsername();
          await sendTelegramMessage(chatId, `✅ <b>Batch Created!</b>\n\nFiles: <b>${collectedIds.length}</b>\nLink: <code>https://t.me/${botUsername}?start=${batchCode}</code>\n<i>(Tap link to copy)</i>`, {
            inline_keyboard: [
              [{ text: toSmallCaps('Generate Temp Link'), callback_data: `admin:temp_token_for:${batchCode}` }],
              [{ text: toSmallCaps('Create Another Batch'), callback_data: 'admin:batch_start' }, { text: toSmallCaps("Today's Links"), callback_data: 'admin:today_links' }],
              [{ text: toSmallCaps('Back to Dashboard'), callback_data: 'admin:dashboard' }]
            ]
          });
          return true;
        } else {
          await sendTelegramMessage(chatId, `❌ <b>Invalid message for range!</b>\n\nThe last message must be from the same channel as the first message and must have a larger message ID.\n\nPlease try forwarding a valid last message from the channel, or send /cancel to abort.`);
          return true;
        }
      }
    }

    const hasFile = message.document || message.video || message.audio || (message.photo && message.photo.length > 0);
    if (hasFile) {
      const currentCount = batchSession.collectedIds ? batchSession.collectedIds.length : 0;
      if (currentCount >= 500) {
        await sendTelegramMessage(chatId, `⚠️ <b>Batch Limit Reached!</b>\n\nYou can only add up to 500 files per batch. Please finish this batch or cancel.`, {
          inline_keyboard: [
            [{ text: toSmallCaps('Finish Batch'), callback_data: 'admin:batch_done' }],
            [{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]
          ]
        });
        return true;
      }

      const copyResult = await copyIntoDbChannel(dbChannelId, chatId, message.message_id);
      if (copyResult.ok) {
        let backupMsgId = null;
        const backupDbChannelId = await getBackupDbChannelId();
        if (backupDbChannelId) {
          const bRes = await copyIntoDbChannel(backupDbChannelId, chatId, message.message_id);
          if (bRes.ok && bRes.messageId) backupMsgId = bRes.messageId;
        }
        const count = await addIdToBatch(chatId, copyResult.messageId, backupMsgId);

        if (batchSession.step !== 'collect') {
           await updateBatchSessionMeta(chatId, { step: 'collect' });
        }

        await sendTelegramMessage(chatId, `📥 <b>File added!</b> (Total: ${count})`, {
          inline_keyboard: [
            [{ text: toSmallCaps('Finish Batch'), callback_data: 'admin:batch_done' }],
            [{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]
          ]
        });
        return true;
      }
    }
  }

  const bundleSession = await getBundleSession(chatId);
  if (bundleSession) {
    if (rawText === '/cancel') {
      await clearBundleSession(chatId);
      const cancelText = `✅ <b>Bundle session cancelled.</b>`;
      const cancelKb = { inline_keyboard: [[{ text: toSmallCaps('Back to File Management'), callback_data: 'admin:file_mgmt' }]] };
      if (bundleSession.sessionMsgId) {
        const eRes = await editTelegramMessage(chatId, bundleSession.sessionMsgId, cancelText, cancelKb);
        if (!eRes?.ok) await sendTelegramMessage(chatId, cancelText, cancelKb);
      } else {
        await sendTelegramMessage(chatId, cancelText, cancelKb);
      }
      return true;
    }

    if (rawText === '/done') {
      const bSession = await getBundleSession(chatId);
      if (!bSession || !bSession.qualities?.length) {
        await sendTelegramMessage(chatId, `⚠️ <b>No files added to bundle yet.</b> Please send video files or links first, or send /cancel.`);
        return true;
      }

      const dbChannelId = await getDbChannelId();
      const backupDbChannelId = await getBackupDbChannelId();
      const bundleCode = generateBundleCode();
      const title = bSession.title || bSession.qualities[0].fileName || 'Multi-Quality Release';

      await storeBundle(bundleCode, title, dbChannelId, bSession.qualities, { userId: chatId }, { backupDbChannelId });
      await clearBundleSession(chatId);

      const bot = await getBotUsername();
      const shareLink = `https://t.me/${bot}?start=${bundleCode}`;
      const sortedQualities = sortQualities(bSession.qualities);
      const qList = sortedQualities.map(q => `• <b>${q.quality}</b> (${q.fileSizeLabel})`).join('\n');

      const text = `🎛 <b>Multi-Quality Bundle Created!</b>\n\n` +
        `<b>Title:</b> ${esc(title)}\n` +
        `<b>Resolutions Included (${sortedQualities.length}):</b>\n${qList}\n\n` +
        `<b>Share Link:</b>\n<code>${shareLink}</code>\n<i>(Tap link to copy)</i>`;

      const kb = {
        inline_keyboard: [
          [{ text: toSmallCaps('Generate Temp Link'), callback_data: `admin:temp_token_for:${bundleCode}` }],
          [{ text: toSmallCaps('Create Another Bundle'), callback_data: 'admin:bundle_start' }, { text: toSmallCaps("Today's Links"), callback_data: 'admin:today_links' }],
          [{ text: toSmallCaps('Back to Dashboard'), callback_data: 'admin:dashboard' }]
        ]
      };

      if (bSession.sessionMsgId) {
        const eRes = await editTelegramMessage(chatId, bSession.sessionMsgId, text, kb);
        if (!eRes?.ok) await sendTelegramMessage(chatId, text, kb);
      } else {
        await sendTelegramMessage(chatId, text, kb);
      }
      return true;
    }

    // Check if user sent two links in one message (e.g. "https://t.me/c/.../101 https://t.me/c/.../104")
    if (rawText) {
      const range = await extractChannelMessageRange(rawText);
      if (range) {
        await processBundleRange(chatId, range, bundleSession.sessionMsgId, bundleSession.title);
        return true;
      }
    }

    // Check if user sent a channel link or forwarded a channel message:
    const extracted = await extractChannelMessage(message);
    if (extracted) {
      if (bundleSession.step === 'first' || !bundleSession.srcFirstMsgId) {
        await setBundleSession(chatId, {
          ...bundleSession,
          step: 'last',
          srcChannelId: extracted.channelId,
          srcFirstMsgId: extracted.msgId
        });

        const text = `🎛 <b>Create Multi-Quality Bundle</b>\n\n` +
          `✅ <b>First Message Saved:</b> <code>#${extracted.msgId}</code>\n\n` +
          `Now send the <b>target message link</b> (or forward the last video for this episode):\n` +
          `Example: <code>https://t.me/c/.../${extracted.msgId + 2}</code>`;

        const kb = { inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]] };

        if (bundleSession.sessionMsgId) {
          const eRes = await editTelegramMessage(chatId, bundleSession.sessionMsgId, text, kb);
          if (!eRes?.ok) {
            const nMsg = await sendTelegramMessage(chatId, text, kb);
            if (nMsg?.result?.message_id) {
              await setBundleSession(chatId, { ...bundleSession, step: 'last', srcChannelId: extracted.channelId, srcFirstMsgId: extracted.msgId, sessionMsgId: nMsg.result.message_id });
            }
          }
        } else {
          const nMsg = await sendTelegramMessage(chatId, text, kb);
          if (nMsg?.result?.message_id) {
            await setBundleSession(chatId, { ...bundleSession, step: 'last', srcChannelId: extracted.channelId, srcFirstMsgId: extracted.msgId, sessionMsgId: nMsg.result.message_id });
          }
        }
        return true;
      }

      if (bundleSession.step === 'last') {
        if (extracted.channelId === bundleSession.srcChannelId && extracted.msgId > bundleSession.srcFirstMsgId) {
          const range = {
            channelId: extracted.channelId,
            firstMsgId: bundleSession.srcFirstMsgId,
            lastMsgId: extracted.msgId,
            totalCount: extracted.msgId - bundleSession.srcFirstMsgId + 1
          };
          await processBundleRange(chatId, range, bundleSession.sessionMsgId, bundleSession.title);
          return true;
        } else {
          await sendTelegramMessage(chatId, `❌ <b>Invalid target message!</b>\n\nTarget message must be from the same channel as the first message (#${bundleSession.srcFirstMsgId}) and have a higher message ID. Please try again or send /cancel.`);
          return true;
        }
      }
    }

    const hasFile = message.document || message.video || message.audio;

    if (!hasFile && rawText && !rawText.startsWith('/')) {
      await setBundleSession(chatId, { ...bundleSession, title: rawText.trim() });
      const text = `✏️ <b>Title set to:</b> <code>${esc(rawText.trim())}</code>\n\nNow send the first message link, forward video resolutions (480p, 720p, 1080p), or tap <b>[Finish Bundle]</b> when done:`;
      const kb = {
        inline_keyboard: [
          [{ text: toSmallCaps('Finish Bundle'), callback_data: 'admin:bundle_done' }],
          [{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]
        ]
      };
      if (bundleSession.sessionMsgId) {
        const eRes = await editTelegramMessage(chatId, bundleSession.sessionMsgId, text, kb);
        if (!eRes?.ok) await sendTelegramMessage(chatId, text, kb);
      } else {
        await sendTelegramMessage(chatId, text, kb);
      }
      return true;
    }

    if (hasFile) {
      const dbChannelId = await getDbChannelId();
      if (!dbChannelId) {
        await sendTelegramMessage(chatId, `❌ <b>DB Channel not configured!</b>`);
        return true;
      }

      const copyResult = await copyIntoDbChannel(dbChannelId, chatId, message.message_id);
      if (copyResult.ok) {
        let backupMsgId = null;
        const backupDbChannelId = await getBackupDbChannelId();
        if (backupDbChannelId) {
          const bRes = await copyIntoDbChannel(backupDbChannelId, chatId, message.message_id);
          if (bRes.ok && bRes.messageId) backupMsgId = bRes.messageId;
        }

        const quality = detectMediaQuality(message);
        const rawSize = message.video?.file_size || message.document?.file_size || 0;
        const sizeLabel = formatBytes(rawSize);
        const fileName = message.document?.file_name || message.video?.file_name || message.caption || `${quality} Video`;

        const qItem = {
          quality,
          fileSize: rawSize,
          fileSizeLabel: sizeLabel,
          dbMessageId: copyResult.messageId,
          backupDbMessageId: backupMsgId,
          fileName
        };

        await addQualityToBundle(chatId, qItem);

        let currentTitle = bundleSession.title;
        if (!currentTitle) {
          currentTitle = extractMediaTitle(message);
          await setBundleSession(chatId, { ...bundleSession, title: currentTitle });
        }

        const updatedSession = await getBundleSession(chatId);
        const sorted = sortQualities(updatedSession?.qualities || [qItem]);
        const qList = sorted.map(q => `• <b>${q.quality}</b> (${q.fileSizeLabel})`).join('\n');

        const text = `🎛 <b>Multi-Quality Bundle Creator</b>\n\n` +
          `📌 <b>Detected Title:</b> <code>${esc(currentTitle || 'Not set')}</code>\n\n` +
          `📥 <b>Resolutions Added (${sorted.length}):</b>\n${qList}\n\n` +
          `Forward the next resolution or target link, or tap <b>[Finish Bundle]</b> below:\n` +
          `<i>(💡 Send any text message to rename the title)</i>`;

        const kb = {
          inline_keyboard: [
            [{ text: toSmallCaps('Finish Bundle'), callback_data: 'admin:bundle_done' }],
            [{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]
          ]
        };

        if (bundleSession.sessionMsgId) {
          const eRes = await editTelegramMessage(chatId, bundleSession.sessionMsgId, text, kb);
          if (!eRes?.ok) {
            const nMsg = await sendTelegramMessage(chatId, text, kb);
            if (nMsg?.result?.message_id) {
              await setBundleSession(chatId, { ...bundleSession, title: currentTitle, sessionMsgId: nMsg.result.message_id });
            }
          }
        } else {
          const nMsg = await sendTelegramMessage(chatId, text, kb);
          if (nMsg?.result?.message_id) {
            await setBundleSession(chatId, { ...bundleSession, title: currentTitle, sessionMsgId: nMsg.result.message_id });
          }
        }
        return true;
      }
    }
  }

  const wsDoc = await sessions.findOne({ _id: `admin:waiting_setting:${chatId}` });
  const waitingFor = wsDoc && wsDoc.expiresAt > new Date() ? wsDoc.val : null;
  if (waitingFor) {
    if (rawText === '/cancel') {
      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });
      await sendTelegramMessage(chatId, `✅ Cancelled.`);
      return true;
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
        return true;
      }

      if (!(await isBotAdmin(targetCid))) {
        await sendTelegramMessage(chatId, `❌ <b>Bot is not an admin in this channel!</b>\n\nPlease add the bot as an administrator in the channel with Post Messages permissions and try again.`);
        return true;
      }

      await sessions.updateOne(
        { _id: `admin:fsub_pending_add:${chatId}` },
        { $set: { val: { id: targetCid, title: targetTitle }, expiresAt: new Date(Date.now() + 600 * 1000) } },
        { upsert: true }
      );
      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });

      await sendTelegramMessage(chatId, `Choose Force Sub Mode`, {
        inline_keyboard: [
          [{ text: toSmallCaps("Normal Mode"), callback_data: "admin:fs_fsub_setmode:normal" }],
          [{ text: toSmallCaps("Join Request Mode"), callback_data: "admin:fs_fsub_setmode:join_request" }],
          [{ text: toSmallCaps("Cancel"), callback_data: "admin:cancel_session" }]
        ]
      });
      return true;
    }

    if (waitingFor === 'backup_db_channel') {
      const forwardChat   = message.forward_from_chat;
      const forwardOrigin = message.forward_origin;
      const typedId        = rawText.trim();

      let targetCid;
      if (forwardChat?.type === 'channel') {
        targetCid = forwardChat.id;
      } else if (forwardOrigin?.type === 'channel' && forwardOrigin.chat) {
        targetCid = forwardOrigin.chat.id;
      } else if (/^-100\d+$/.test(typedId)) {
        targetCid = typedId;
      } else {
        await sendTelegramMessage(chatId, `❌ <b>Please forward a message directly from the backup channel, or send the channel ID directly</b> (e.g. <code>-100123456789</code>).`);
        return true;
      }

      if (!(await isBotAdmin(targetCid))) {
        await sendTelegramMessage(chatId, `❌ <b>Bot is not an admin in this backup channel!</b>\n\nPlease add the bot as an administrator in the channel with Post Messages permissions and try again.`);
        return true;
      }

      await updateSettings({ backupDbChannelId: String(targetCid) });
      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });

      await sendTelegramMessage(chatId, `✅ <b>Backup DB Channel Configured!</b>\n\nChannel ID: <code>${targetCid}</code>\n\nAll newly stored files and batches will now automatically be mirrored to this channel.`);

      const { renderStorageAudit } = await import('../callbacks/admin-callbacks.js');
      await renderStorageAudit(chatId);
      return true;
    }

    if (waitingFor === 'dbChannelId') {
      if (!/^-100\d+$/.test(rawText)) {
        await sendTelegramMessage(chatId, `❌ <b>Invalid DB Channel ID!</b>\n\nChannel ID must match pattern <code>-100dddddddddd</code>. Please try again or send /cancel.`);
        return true;
      }
    } else if (waitingFor === 'forceSubscribeChannels') {
      const trimmed = rawText.trim();
      if (trimmed !== '') {
        const channels = trimmed.split(',').map(s => s.trim());
        const allValid = channels.every(c => /^-100\d+$/.test(c));
        if (!allValid) {
          await sendTelegramMessage(chatId, `❌ <b>Invalid Force Subscribe Channel ID(s)!</b>\n\nMust be a comma-separated list of Channel IDs matching <code>-100dddddddddd</code>. Please try again or send /cancel.`);
          return true;
        }
      }
    }

    let value = rawText;
    if (waitingFor === 'tutorialFileId') value = message.video?.file_id || message.document?.file_id;

    const isBannerSetting = ['startPhoto', 'bannerFsub', 'bannerVerify', 'bannerDelivery', 'bannerProfile'].includes(waitingFor);
    if (isBannerSetting) {
      value = message.photo?.[message.photo.length - 1]?.file_id ||
              (message.document?.mime_type?.startsWith('image/') ? message.document.file_id : null) ||
              (rawText && rawText.startsWith('http') ? rawText.trim() : null);
    }

    if (!value) {
      await sendTelegramMessage(chatId, `❌ <b>Invalid input.</b> Please send a valid ${isBannerSetting ? 'photo or image link' : 'value'}, or send /cancel to abort.`);
      return true;
    }
    await updateSettings({ [waitingFor]: value });
    await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });

    let backCb = 'admin:fs_settings';
    if (isBannerSetting) backCb = 'admin:banners_mgmt';
    else if (['startText'].includes(waitingFor)) backCb = 'admin:fs_cfg:start';
    else if (['forceSubscribeChannels', 'forceSubscribeMsg'].includes(waitingFor)) backCb = 'admin:fs_cfg:fsub';
    else if (['shortenerUrl', 'shortenerKey', 'backupShortenerUrl', 'backupShortenerKey', 'validityHours', 'tutorialFileId'].includes(waitingFor)) backCb = 'admin:fs_cfg:tkn';

    await sendTelegramMessage(chatId, `✅ Updated <b>${waitingFor}</b>!`, {
      inline_keyboard: [[{ text: toSmallCaps('Back to Settings'), callback_data: backCb }]]
    });
    return true;
  }

  const waDoc = await sessions.findOne({ _id: `admin:waiting_action:${chatId}` });
  const waitingAction = waDoc && waDoc.expiresAt > new Date() ? waDoc.val : null;
  if (waitingAction) {
    if (rawText.startsWith('/')) {
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
      if (rawText === '/cancel') {
        await sendTelegramMessage(chatId, `✅ Cancelled.`);
        return true;
      }
      // If admin typed any other command (e.g. /start, /setting, /ping), exit waiting state and run command
      return null;
    }

    if (waitingAction === 'temp_token_input') {
      const targetCode = rawText.trim();
      const { getFile, getBatch } = await import('../filestore.js');
      const fileDoc = await getFile(targetCode);
      const batchDoc = !fileDoc ? await getBatch(targetCode) : null;

      if (!fileDoc && !batchDoc) {
        await sendTelegramMessage(chatId, `❌ <b>File or Batch not found!</b>\n\nNo stored record matches <code>${esc(targetCode)}</code>. Please try again or send /cancel to abort.`);
        return true;
      }

      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
      const durKb = {
        inline_keyboard: [
          [
            { text: toSmallCaps('15 Mins'), callback_data: `admin:gen_temp:${targetCode}:900` },
            { text: toSmallCaps('1 Hour'), callback_data: `admin:gen_temp:${targetCode}:3600` },
            { text: toSmallCaps('6 Hours'), callback_data: `admin:gen_temp:${targetCode}:21600` }
          ],
          [
            { text: toSmallCaps('12 Hours'), callback_data: `admin:gen_temp:${targetCode}:43200` },
            { text: toSmallCaps('24 Hours'), callback_data: `admin:gen_temp:${targetCode}:86400` },
            { text: toSmallCaps('3 Days'), callback_data: `admin:gen_temp:${targetCode}:259200` }
          ],
          [
            { text: toSmallCaps('7 Days'), callback_data: `admin:gen_temp:${targetCode}:604800` }
          ],
          [{ text: toSmallCaps('Back to File Control'), callback_data: 'admin:file_mgmt' }]
        ]
      };
      await sendTelegramMessage(chatId, `⏱ <b>Select Expiration Duration</b> for <code>${esc(targetCode)}</code>:`, durKb);
      return true;
    }

    if (waitingAction.startsWith('export_custom_duration')) {
      const presetType = waitingAction.split(':')[1] || 'all';
      const { parseDurationString, getFilesWithinDuration, generateLinksExportText, generateRawLinksText, formatDurationLabel } = await import('../filestore.js');
      const lower = rawText.trim().toLowerCase();
      const isBatchOnly = lower.includes('batch') || presetType === 'batch';
      const isFileOnly = (!isBatchOnly && lower.includes('file')) || presetType === 'media';
      const filterType = isBatchOnly ? 'batch' : isFileOnly ? 'media' : 'all';

      // Strip words like 'batches', 'batch', 'files', 'file' to isolate duration number
      const cleanInput = lower.replace(/\b(batches|batch|files|file)\b/g, '').trim();
      let seconds = parseDurationString(cleanInput);

      // If user sent a plain number, treat as minutes
      if (!seconds && /^\d+$/.test(cleanInput)) {
        seconds = parseInt(cleanInput, 10) * 60;
      }

      if (!seconds || seconds <= 0) {
        await sendTelegramMessage(chatId, `❌ <b>Invalid duration.</b>\n\nPlease send e.g. <code>15m</code>, <code>30</code>, <code>1h</code>, or <code>30m batch</code>, or send /cancel to abort.`);
        return true;
      }

      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });

      const records = await getFilesWithinDuration(seconds, filterType);
      const durationLabel = formatDurationLabel(seconds);
      const typeLabel = isBatchOnly ? 'Batches' : isFileOnly ? 'Single Files' : 'Links';

      if (!records.length) {
        await sendTelegramMessage(chatId, `⚠️ <i>No ${typeLabel.toLowerCase()} found created within the last ${durationLabel}.</i>`, {
          inline_keyboard: [[{ text: toSmallCaps('Back to Export Hub'), callback_data: 'admin:export_hub' }]]
        });
        return true;
      }

      const bot = await getBotUsername();
      const title = `${typeLabel} in Last ${durationLabel}`;
      const txtContent = generateLinksExportText(records, bot, title);
      const buffer = Buffer.from(txtContent, 'utf-8');
      const filename = `filestore_${filterType}_${Math.round(seconds / 60)}m_${new Date().toISOString().slice(0, 10)}.txt`;

      if (records.length <= 30) {
        const rawBlock = generateRawLinksText(records, bot);
        await sendTelegramMessage(chatId, `📋 <b>${title} (${records.length})</b>\n\nTap box to copy all links at once:\n<pre>${rawBlock}</pre>`);
      }

      const { sendTelegramFileBuffer } = await import('../bot-common.js');
      await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>${title}</b> (${records.length} records)`, {
        inline_keyboard: [[{ text: toSmallCaps('Back to Export Hub'), callback_data: 'admin:export_hub' }]]
      });
      return true;
    }

    if (waitingAction === 'broadcast') {
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });

      const { getUserStats } = await import('../bot-users.js');
      const stats = await getUserStats();

      // Inspect message to detect media, forward origin, and attached inline buttons
      const isForward = !!(message.forward_origin || message.forward_from || message.forward_from_chat);
      let mediaType = 'Text';
      if (message.photo) mediaType = 'Photo';
      else if (message.video) mediaType = 'Video';
      else if (message.document) mediaType = 'Document';
      else if (message.audio) mediaType = 'Audio';
      else if (message.animation) mediaType = 'Animation / GIF';
      else if (message.sticker) mediaType = 'Sticker';
      else if (message.voice) mediaType = 'Voice Note';

      const captionOrText = message.caption || message.text || rawText || '';
      const hasButtons = !!message.reply_markup;

      // Save draft message reference for preview and confirmation
      await sessions.updateOne(
        { _id: `admin:broadcast_draft:${chatId}` },
        {
          $set: {
            fromChatId: chatId,
            messageId: message.message_id,
            mediaType,
            isForward,
            hasButtons,
            captionOrText,
            replyMarkup: message.reply_markup || null,
            expiresAt: new Date(Date.now() + 600 * 1000)
          }
        },
        { upsert: true }
      );

      const previewCard = `📢 <b>Broadcast Preview</b>\n\n` +
        `• <b>Target Audience:</b> <b>${stats.totalUsers}</b> registered users\n` +
        `• <b>Type:</b> <b>${mediaType}${isForward ? ' (Forwarded)' : ''}</b>\n` +
        `• <b>Inline Buttons:</b> <b>${hasButtons ? 'Yes (Preserved)' : 'None'}</b>\n` +
        `• <b>Open Graph:</b> <b>Allowed</b>\n\n` +
        (captionOrText ? `<b>Content:</b>\n────────────────────\n${captionOrText.slice(0, 300)}${captionOrText.length > 300 ? '...' : ''}\n────────────────────\n\n` : '') +
        `You can send a test preview to your private chat first to check formatting before delivering to all users.`;

      await sendTelegramMessage(chatId, previewCard, {
        inline_keyboard: [
          [{ text: toSmallCaps('Send Test Preview to Me'), callback_data: 'admin:broadcast_test' }],
          [
            { text: toSmallCaps('Confirm & Send to All'), callback_data: 'admin:broadcast_confirm' },
            { text: toSmallCaps('Cancel'), callback_data: 'admin:broadcast_cancel_draft' }
          ]
        ]
      });

      return true;
    }

    if (waitingAction === 'ban') {
      const targetId = rawText.match(/(\d+)/)?.[1];
      if (!targetId) {
        await sendTelegramMessage(chatId, `❌ Invalid User ID.`);
        return true;
      }
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
      await banUser(targetId);
      logHistory(`banned_tg: ${targetId}`, 'tg').catch(() => {});
      await sendTelegramMessage(chatId, `✅ User <code>${targetId}</code> has been banned.`, {
        inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'admin:user_mgmt' }]]
      });
      return true;
    }

    if (waitingAction === 'unban') {
      const targetId = rawText.match(/(\d+)/)?.[1];
      if (!targetId) {
        await sendTelegramMessage(chatId, `❌ Invalid User ID.`);
        return true;
      }
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
      await unbanUser(targetId);
      logHistory(`unbanned_tg: ${targetId}`, 'tg').catch(() => {});
      await sendTelegramMessage(chatId, `✅ User <code>${targetId}</code> has been unbanned.`, {
        inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'admin:user_mgmt' }]]
      });
      return true;
    }
  }

  const wpDoc = await sessions.findOne({ _id: `admin:waiting_premium_user:${chatId}` });
  const isWaitingPremium = wpDoc && wpDoc.expiresAt > new Date() ? wpDoc.val : null;
  if (isWaitingPremium) {
    const targetUserId = await resolveUser(rawText);

    if (!targetUserId) {
      await sendTelegramMessage(chatId, `❌ User not found.`);
      return true;
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
        [{ text: toSmallCaps('7 Days'), callback_data: 'admin:fs_set_premium:7' }, { text: toSmallCaps('30 Days'), callback_data: 'admin:fs_set_premium:30' }],
        [{ text: toSmallCaps('365 Days'), callback_data: 'admin:fs_set_premium:365' }],
        [{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]
      ]
    };

    if (msgId) {
      await editTelegramMessage(chatId, msgId, `⭐ <b>Select Duration</b> for <code>${targetUserId}</code>:`, durationKb);
      await deleteTelegramMessage(chatId, message.message_id);
    } else {
      await sendTelegramMessage(chatId, `⭐ <b>Select Duration</b> for <code>${targetUserId}</code>:`, durationKb);
    }
    return true;
  }

  if (await checkAndClearAdminWaiting(chatId)) {
    const dbChannelId = await getDbChannelId();
    if (!dbChannelId) {
      await sendTelegramMessage(chatId, `❌ <b>Database Channel is not configured.</b>\n\nPlease set it in the bot settings first.`);
      return true;
    }

    let type = message.document ? 'document' : message.video ? 'video' : message.audio ? 'audio' : message.photo ? 'photo' : null;
    if (type) {
      const copyResult = await copyIntoDbChannel(dbChannelId, chatId, message.message_id);
      if (copyResult.ok) {
        let backupMessageId = null;
        const backupDbChannelId = await getBackupDbChannelId();
        if (backupDbChannelId) {
          const backupRes = await copyIntoDbChannel(backupDbChannelId, chatId, message.message_id);
          if (backupRes?.ok) backupMessageId = backupRes.messageId;
        }

        const quality = detectMediaQuality(message);
        const rawSize = message.video?.file_size || message.document?.file_size || message.audio?.file_size || 0;
        const sizeLabel = formatBytes(rawSize);
        const title = extractMediaTitle(message);
        const rawFileName = message.document?.file_name || message.video?.file_name || message.audio?.file_name || '';

        const code = generateFileCode();
        await storeFile(code, {
          dbChannelId,
          dbMessageId: copyResult.messageId,
          backupDbChannelId: backupMessageId ? backupDbChannelId : undefined,
          backupDbMessageId: backupMessageId || undefined,
          type: type,
          fileId: message.document?.file_id || message.video?.file_id || message.audio?.file_id || message.photo?.[0]?.file_id,
          title: title || undefined,
          fileName: rawFileName || undefined,
          quality: (type === 'video' || type === 'document') ? quality : undefined,
          fileSize: rawSize || undefined,
          fileSizeLabel: rawSize ? sizeLabel : undefined,
          accessCount: 0
        }, { userId: chatId });
        const bot = await getBotUsername();
        const link = `https://t.me/${bot}?start=${code}`;

        const detailsLine = (type === 'video' || type === 'document')
          ? `\n\n📁 <b>Title:</b> <code>${esc(title)}</code>\n📀 <b>Quality:</b> <code>${quality}</code> • <b>Size:</b> <code>${sizeLabel}</code>\n`
          : (rawSize ? `\n\n💾 <b>Size:</b> <code>${sizeLabel}</code>\n` : '\n\n');

        await sendTelegramMessage(chatId, `✅ <b>File Stored!</b>${detailsLine}<b>Link:</b>\n<code>${link}</code>\n<i>(Tap link to copy)</i>`, {
          inline_keyboard: [
            [{ text: toSmallCaps('Generate Temp Link'), callback_data: `admin:temp_token_for:${code}` }],
            [{ text: toSmallCaps('Store Another File'), callback_data: 'admin:store_start' }, { text: toSmallCaps('Bulk Store Mode'), callback_data: 'admin:bulk_store_start' }],
            [{ text: toSmallCaps("Today's Links"), callback_data: 'admin:today_links' }, { text: toSmallCaps('Back to Dashboard'), callback_data: 'admin:dashboard' }]
          ]
        });
      } else {
        await sendTelegramMessage(chatId, `❌ <b>Failed to store file.</b>\n\nMake sure the bot is an administrator in the DB channel and has permission to post messages.`);
      }
    }
    return true;
  }

  return null;
}

export async function processBundleRange(chatId, range, sessionMsgId = null, explicitTitle = '') {
  const dbChannelId = await getDbChannelId();
  if (!dbChannelId) {
    const errText = `❌ <b>Database Channel is not configured.</b>\n\nPlease set it in the bot settings first.`;
    if (sessionMsgId) {
      await editTelegramMessage(chatId, sessionMsgId, errText);
    } else {
      await sendTelegramMessage(chatId, errText);
    }
    return;
  }

  const backupDbChannelId = await getBackupDbChannelId();
  const { channelId, firstMsgId, lastMsgId, totalCount } = range;

  if (totalCount > 15) {
    const errorText = `⚠️ <b>Range too large for Quality Bundle!</b>\n\nA quality bundle is meant for resolution variants of a single release (max 15 files). For bulk archiving (${totalCount} files), please use <b>/batch</b> instead.`;
    if (sessionMsgId) {
      await editTelegramMessage(chatId, sessionMsgId, errorText, {
        inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
      });
    } else {
      await sendTelegramMessage(chatId, errorText);
    }
    return;
  }

  const statusText = `⏳ <b>Processing Bundle...</b>\n\nFetching resolutions #${firstMsgId} to #${lastMsgId} from channel...`;
  let activeMsgId = sessionMsgId;
  if (activeMsgId) {
    await editTelegramMessage(chatId, activeMsgId, statusText);
  } else {
    const sMsg = await sendTelegramMessage(chatId, statusText);
    activeMsgId = sMsg?.result?.message_id;
  }

  const qualities = [];
  let detectedTitle = explicitTitle || '';

  for (let srcId = firstMsgId; srcId <= lastMsgId; srcId++) {
    // 1. Try forwardMessage to preserve complete message metadata (video, document, caption)
    let fwdRes = await forwardMessage(dbChannelId, channelId, srcId);
    let dbMsgId = null;
    let msgObj = null;

    if (fwdRes?.ok && fwdRes?.messageId) {
      dbMsgId = fwdRes.messageId;
      msgObj = fwdRes.message;
    } else {
      // Fallback to copyIntoDbChannel
      const copyRes = await copyIntoDbChannel(dbChannelId, channelId, srcId);
      if (copyRes?.ok && copyRes?.messageId) {
        dbMsgId = copyRes.messageId;
      }
    }

    if (dbMsgId) {
      let backupMsgId = null;
      if (backupDbChannelId) {
        const bRes = await copyIntoDbChannel(backupDbChannelId, channelId, srcId);
        if (bRes?.ok && bRes?.messageId) backupMsgId = bRes.messageId;
      }

      const quality = msgObj ? detectMediaQuality(msgObj) : 'Standard';
      const rawSize = msgObj?.video?.file_size || msgObj?.document?.file_size || 0;
      const sizeLabel = formatBytes(rawSize);
      const fileName = msgObj?.document?.file_name || msgObj?.video?.file_name || '';

      if (!detectedTitle && msgObj) {
        detectedTitle = extractMediaTitle(msgObj);
      }

      qualities.push({
        quality,
        fileSize: rawSize,
        fileSizeLabel: sizeLabel,
        dbMessageId: dbMsgId,
        backupDbMessageId: backupMsgId,
        fileName
      });
    }

    if (totalCount > 4) {
      await new Promise(r => setTimeout(r, 60));
    }
  }

  if (!qualities.length) {
    const failText = `❌ <b>Failed to create bundle.</b>\n\nNo accessible media messages found in range #${firstMsgId}–#${lastMsgId}. Make sure the bot is an administrator in the channel.`;
    if (activeMsgId) {
      await editTelegramMessage(chatId, activeMsgId, failText, {
        inline_keyboard: [[{ text: toSmallCaps('Back to File Management'), callback_data: 'admin:file_mgmt' }]]
      });
    } else {
      await sendTelegramMessage(chatId, failText);
    }
    return;
  }

  const finalTitle = explicitTitle || detectedTitle || 'Multi-Quality Release';
  const bundleCode = generateBundleCode();

  await storeBundle(bundleCode, finalTitle, dbChannelId, qualities, { userId: chatId }, { backupDbChannelId });
  await clearBundleSession(chatId);

  const bot = await getBotUsername();
  const shareLink = `https://t.me/${bot}?start=${bundleCode}`;
  const sortedQualities = sortQualities(qualities);
  const qList = sortedQualities.map(q => `• <b>${q.quality}</b> (${q.fileSizeLabel})`).join('\n');

  const text = `🎛 <b>Multi-Quality Bundle Created!</b>\n\n` +
    `<b>Title:</b> ${esc(finalTitle)}\n` +
    `<b>Resolutions Included (${sortedQualities.length}):</b>\n${qList}\n\n` +
    `<b>Share Link:</b>\n<code>${shareLink}</code>\n<i>(Tap link to copy)</i>`;

  const kb = {
    inline_keyboard: [
      [{ text: toSmallCaps('Generate Temp Link'), callback_data: `admin:temp_token_for:${bundleCode}` }],
      [{ text: toSmallCaps('Create Another Bundle'), callback_data: 'admin:bundle_start' }, { text: toSmallCaps("Today's Links"), callback_data: 'admin:today_links' }],
      [{ text: toSmallCaps('Back to Dashboard'), callback_data: 'admin:dashboard' }]
    ]
  };

  if (activeMsgId) {
    const editRes = await editTelegramMessage(chatId, activeMsgId, text, kb);
    if (!editRes?.ok) {
      await sendTelegramMessage(chatId, text, kb);
    }
  } else {
    await sendTelegramMessage(chatId, text, kb);
  }
}
