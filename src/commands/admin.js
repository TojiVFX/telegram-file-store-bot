import crypto from 'crypto';
import {
  getCollection, getSettings, updateSettings, log, sendTelegramMessage, editTelegramMessage, deleteTelegramMessage, toSmallCaps, getMainToken, esc
} from '../bot-common.js';
import {
  getBotUsername, getDbChannelId, getBackupDbChannelId, checkSubscription, isBotAdmin, extractChannelMessage, copyIntoDbChannel, copyFromDbChannel, getMainBotUsername, resolveUser
} from '../bot-helpers.js';
import {
  getBatchSession, setBatchSession, addIdToBatch, clearBatchSession, updateBatchSessionMeta, checkAndClearAdminWaiting, setAdminWaitingForFile, storeFile, generateFileCode,
  isBulkStoreActive, setBulkStoreActive, addToStoreSession, getStoreSession, clearStoreSession, generateLinksExportText, generateRawLinksText,
  generateBundleCode, storeBundle, getBundleSession, setBundleSession, addQualityToBundle, clearBundleSession, detectMediaQuality, formatBytes
} from '../filestore.js';
import { handleStartPayload } from './start.js';
import { banUser, unbanUser, getBannedList, broadcastToAll, getUserStats, addReferral } from '../bot-users.js';

export async function processAdminMessage(chatId, rawText, message, req, res) {
  const sessions = await getCollection('sessions');
  const bulkActive = await isBulkStoreActive(chatId);
  if (bulkActive) {
    if (rawText === '/cancel') {
      await setBulkStoreActive(chatId, false);
      await clearStoreSession(chatId);
      await sendTelegramMessage(chatId, `✅ <b>Bulk Store cancelled.</b>`, {
        inline_keyboard: [[{ text: toSmallCaps('Back to File Management'), callback_data: 'admin:file_mgmt' }]]
      });
      return res.status(200).send('OK');
    }

    if (rawText === '/done') {
      const codes = await getStoreSession(chatId);
      await setBulkStoreActive(chatId, false);
      await clearStoreSession(chatId);
      if (!codes.length) {
        await sendTelegramMessage(chatId, `⚠️ <b>No files were stored in this session.</b>`, {
          inline_keyboard: [[{ text: toSmallCaps('Back to File Management'), callback_data: 'admin:file_mgmt' }]]
        });
        return res.status(200).send('OK');
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
      return res.status(200).send('OK');
    }

    const hasMedia = message.document || message.video || message.audio || (message.photo && message.photo.length > 0);
    if (hasMedia) {
      const dbChannelId = await getDbChannelId();
      if (!dbChannelId) {
        await setBulkStoreActive(chatId, false);
        await clearStoreSession(chatId);
        await sendTelegramMessage(chatId, `❌ <b>Database Channel is not configured.</b>\n\nPlease set it in the bot settings first.`);
        return res.status(200).send('OK');
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

        const code = generateFileCode();
        await storeFile(code, {
          dbChannelId,
          dbMessageId: copyResult.messageId,
          backupDbChannelId: backupMessageId ? backupDbChannelId : undefined,
          backupDbMessageId: backupMessageId || undefined,
          type: type,
          fileId: message.document?.file_id || message.video?.file_id || message.audio?.file_id || message.photo?.[0]?.file_id
        });
        const count = await addToStoreSession(chatId, code);
        const bot = await getBotUsername();
        const link = `https://t.me/${bot}?start=${code}`;

        await sendTelegramMessage(chatId, `📥 <b>File ${count} Stored!</b>\nCode: <code>${code}</code>\nLink: <code>${link}</code>\n\nSend another file, or tap below when finished:`, {
          inline_keyboard: [
            [{ text: toSmallCaps(`Done & Get All Links (${count})`), callback_data: 'admin:bulk_store_done' }],
            [{ text: toSmallCaps('Cancel'), callback_data: 'admin:bulk_store_cancel' }]
          ]
        });
        return res.status(200).send('OK');
      } else {
        await sendTelegramMessage(chatId, `❌ <b>Failed to store file.</b>\n\nMake sure the bot is an administrator in the DB channel and has permission to post messages.`);
        return res.status(200).send('OK');
      }
    }
  }

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
        return res.status(200).send('OK');
      }
      if (batchSession.step === 'last') {
        if (extracted.channelId === batchSession.srcChannelId && extracted.msgId > batchSession.srcFirstMsgId) {
          const totalFiles = extracted.msgId - batchSession.srcFirstMsgId + 1;
          if (totalFiles > 500) {
             await sendTelegramMessage(chatId, `⚠️ <b>Range too large!</b>\n\nYou can only add up to 500 files at once. This range is <b>${totalFiles}</b> files.`);
             return res.status(200).send('OK');
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
            [{ text: toSmallCaps('Finish Batch'), callback_data: 'admin:batch_done' }],
            [{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]
          ]
        });
        return res.status(200).send('OK');
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
        return res.status(200).send('OK');
      }
    }
  }

  const bundleSession = await getBundleSession(chatId);
  if (bundleSession) {
    if (rawText === '/cancel') {
      await clearBundleSession(chatId);
      await sendTelegramMessage(chatId, `✅ <b>Bundle session cancelled.</b>`, {
        inline_keyboard: [[{ text: toSmallCaps('Back to File Management'), callback_data: 'admin:file_mgmt' }]]
      });
      return res.status(200).send('OK');
    }

    if (rawText === '/done') {
      const bSession = await getBundleSession(chatId);
      if (!bSession || !bSession.qualities?.length) {
        await sendTelegramMessage(chatId, `⚠️ <b>No files added to bundle yet.</b> Please send video files first or send /cancel.`);
        return res.status(200).send('OK');
      }

      const dbChannelId = await getDbChannelId();
      const backupDbChannelId = await getBackupDbChannelId();
      const bundleCode = generateBundleCode();
      const title = bSession.title || bSession.qualities[0].fileName || 'Multi-Quality Release';

      await storeBundle(bundleCode, title, dbChannelId, bSession.qualities, { userId: chatId }, { backupDbChannelId });
      await clearBundleSession(chatId);

      const bot = await getBotUsername();
      const shareLink = `https://t.me/${bot}?start=${bundleCode}`;
      const qList = bSession.qualities.map(q => `• <b>${q.quality}</b> (${q.fileSizeLabel})`).join('\n');

      const text = `🎛 <b>Multi-Quality Bundle Created!</b>\n\n` +
        `<b>Title:</b> ${esc(title)}\n` +
        `<b>Resolutions Included (${bSession.qualities.length}):</b>\n${qList}\n\n` +
        `<b>Share Link:</b>\n<code>${shareLink}</code>\n<i>(Tap link to copy)</i>`;

      await sendTelegramMessage(chatId, text, {
        inline_keyboard: [
          [{ text: toSmallCaps('Create Another Bundle'), callback_data: 'admin:bundle_start' }],
          [{ text: toSmallCaps('Back to File Management'), callback_data: 'admin:file_mgmt' }]
        ]
      });
      return res.status(200).send('OK');
    }

    const hasFile = message.document || message.video || message.audio;

    if (!hasFile && rawText && !rawText.startsWith('/')) {
      await setBundleSession(chatId, { ...bundleSession, title: rawText.trim() });
      await sendTelegramMessage(chatId, `✏️ <b>Title set to:</b> <code>${esc(rawText.trim())}</code>\n\nNow send or forward your video resolutions (480p, 720p, 1080p), or tap <b>[Finish Bundle]</b> when done:`, {
        inline_keyboard: [
          [{ text: toSmallCaps('Finish Bundle'), callback_data: 'admin:bundle_done' }],
          [{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]
        ]
      });
      return res.status(200).send('OK');
    }

    if (hasFile) {
      const dbChannelId = await getDbChannelId();
      if (!dbChannelId) {
        await sendTelegramMessage(chatId, `❌ <b>DB Channel not configured!</b>`);
        return res.status(200).send('OK');
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

        const totalCount = await addQualityToBundle(chatId, qItem);

        let currentTitle = bundleSession.title;
        if (!currentTitle) {
          const cap = message.caption || '';
          const epMatch = cap.match(/Episode\s*[-:]*\s*(\d+)/i);
          const langMatch = cap.match(/Language\s*[-:]*\s*([a-zA-Z]+)/i);
          if (epMatch) {
            currentTitle = `Episode ${epMatch[1]}` + (langMatch ? ` [${langMatch[1]}]` : '');
          } else if (message.document?.file_name || message.video?.file_name) {
            currentTitle = (message.document?.file_name || message.video?.file_name).replace(/\.(mkv|mp4|avi|webm)$/i, '');
          } else {
            currentTitle = 'Multi-Quality Release';
          }
          await setBundleSession(chatId, { ...bundleSession, title: currentTitle });
        }

        await sendTelegramMessage(chatId, `📥 <b>Added:</b> <code>${quality} • ${sizeLabel}</code>\n📌 <b>Title:</b> <code>${esc(currentTitle || 'Not set')}</code>\nTotal Resolutions: <b>${totalCount}</b>\n\nSend the next resolution, or tap <b>[Finish Bundle]</b> below:\n<i>(💡 Send any text message to rename the title)</i>`, {
          inline_keyboard: [
            [{ text: toSmallCaps('Finish Bundle'), callback_data: 'admin:bundle_done' }],
            [{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]
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
          [{ text: toSmallCaps("Normal Mode"), callback_data: "admin:fs_fsub_setmode:normal" }],
          [{ text: toSmallCaps("Join Request Mode"), callback_data: "admin:fs_fsub_setmode:join_request" }],
          [{ text: toSmallCaps("Cancel"), callback_data: "admin:cancel_session" }]
        ]
      });
      return res.status(200).send('OK');
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
        return res.status(200).send('OK');
      }

      if (!(await isBotAdmin(targetCid))) {
        await sendTelegramMessage(chatId, `❌ <b>Bot is not an admin in this backup channel!</b>\n\nPlease add the bot as an administrator in the channel with Post Messages permissions and try again.`);
        return res.status(200).send('OK');
      }

      await updateSettings({ backupDbChannelId: String(targetCid) });
      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });

      await sendTelegramMessage(chatId, `✅ <b>Backup DB Channel Configured!</b>\n\nChannel ID: <code>${targetCid}</code>\n\nAll newly stored files and batches will now automatically be mirrored to this channel.`);

      const { renderStorageAudit } = await import('../callbacks/admin-callbacks.js');
      await renderStorageAudit(chatId);
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

    const isBannerSetting = ['startPhoto', 'bannerFsub', 'bannerVerify', 'bannerDelivery', 'bannerProfile'].includes(waitingFor);
    if (isBannerSetting) {
      value = message.photo?.[message.photo.length - 1]?.file_id ||
              (message.document?.mime_type?.startsWith('image/') ? message.document.file_id : null) ||
              (rawText && rawText.startsWith('http') ? rawText.trim() : null);
    }

    if (!value) {
      await sendTelegramMessage(chatId, `❌ <b>Invalid input.</b> Please send a valid ${isBannerSetting ? 'photo or image link' : 'value'}, or send /cancel to abort.`);
      return res.status(200).send('OK');
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
    return res.status(200).send('OK');
  }

  const waDoc = await sessions.findOne({ _id: `admin:waiting_action:${chatId}` });
  const waitingAction = waDoc && waDoc.expiresAt > new Date() ? waDoc.val : null;
  if (waitingAction) {
    if (rawText.startsWith('/')) {
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
      if (rawText === '/cancel') {
        await sendTelegramMessage(chatId, `✅ Cancelled.`);
        return res.status(200).send('OK');
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
        return res.status(200).send('OK');
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
      return res.status(200).send('OK');
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
        return res.status(200).send('OK');
      }

      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });

      const records = await getFilesWithinDuration(seconds, filterType);
      const durationLabel = formatDurationLabel(seconds);
      const typeLabel = isBatchOnly ? 'Batches' : isFileOnly ? 'Single Files' : 'Links';

      if (!records.length) {
        await sendTelegramMessage(chatId, `⚠️ <i>No ${typeLabel.toLowerCase()} found created within the last ${durationLabel}.</i>`, {
          inline_keyboard: [[{ text: toSmallCaps('Back to Export Hub'), callback_data: 'admin:export_hub' }]]
        });
        return res.status(200).send('OK');
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
      return res.status(200).send('OK');
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

      return res.status(200).send('OK');
    }

    if (waitingAction === 'ban') {
      const targetId = rawText.match(/(\d+)/)?.[1];
      if (!targetId) return sendTelegramMessage(chatId, `❌ Invalid User ID.`);
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
      await banUser(targetId);
      await logHistory(`banned_tg: ${targetId}`, 'tg');
      await sendTelegramMessage(chatId, `✅ User <code>${targetId}</code> has been banned.`, {
        inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'admin:user_mgmt' }]]
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
        inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'admin:user_mgmt' }]]
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
        let backupMessageId = null;
        const backupDbChannelId = await getBackupDbChannelId();
        if (backupDbChannelId) {
          const backupRes = await copyIntoDbChannel(backupDbChannelId, chatId, message.message_id);
          if (backupRes?.ok) backupMessageId = backupRes.messageId;
        }

        const code = generateFileCode();
        await storeFile(code, {
          dbChannelId,
          dbMessageId: copyResult.messageId,
          backupDbChannelId: backupMessageId ? backupDbChannelId : undefined,
          backupDbMessageId: backupMessageId || undefined,
          type: type,
          fileId: message.document?.file_id || message.video?.file_id || message.audio?.file_id || message.photo?.[0]?.file_id
        });
        const bot = await getBotUsername();
        await sendTelegramMessage(chatId, `✅ <b>File Stored!</b>\n\nLink: <code>https://t.me/${bot}?start=${code}</code>\n<i>(Tap link to copy)</i>`, {
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
    return res.status(200).send('OK');
  }

  return null;
}
