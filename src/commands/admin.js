import crypto from 'crypto';
import {
  getCollection, getSettings, updateSettings, log, sendTelegramMessage, editTelegramMessage,
  deleteTelegramMessage, toSmallCaps, getMainToken, esc, logHistory, getChat,
  sendTelegramFileBuffer, isSafePublicUrl, sendChatAction, copyTelegramMessages
} from '../bot-common.js';
import {
  getBotUsername, getDbChannelId, getBackupDbChannelId, checkSubscription, isBotAdmin,
  extractChannelMessage, copyIntoDbChannel, copyFromDbChannel, getMainBotUsername, resolveUser,
  forwardMessage, extractChannelMessageRange, getForceSubChannelsList,
  resolveChannelIdFromMessageOrText
} from '../bot-helpers.js';
import {
  getBatchSession, setBatchSession, addIdToBatch, clearBatchSession, updateBatchSessionMeta,
  checkAndClearAdminWaiting, setAdminWaitingForFile, storeFile, generateFileCode,
  isBulkStoreActive, setBulkStoreActive, addToStoreSession, getStoreSession, clearStoreSession,
  generateLinksExportText, generateRawLinksText, generateBundleCode, storeBundle, getBundleSession,
  setBundleSession, addQualityToBundle, clearBundleSession, detectMediaQuality, formatBytes,
  cleanMediaFileName, extractMediaTitle, sortQualities, extractMediaUniqueId, findFileByUniqueId,
  storeBatch, generateBatchCode, rebuildChannelStorage, getFile, getBatch, parseDurationString,
  getFilesWithinDuration, formatDurationLabel, formatDuration
} from '../filestore.js';
import { handleStartPayload } from './start.js';
import { banUser, unbanUser, getBannedList, broadcastToAll, getUserStats, addReferral } from '../bot-users.js';
import { logActivity } from '../bot-logs.js';
import {
  isStealthStorageEnabled, generateCloakedCaption, sanitizeMediaTitle, generateSaltedFileFingerprint
} from '../stealth-engine.js';
import { renderStorageAudit } from '../callbacks/admin/storage-audit.js';
import { setStandbyChannelId } from '../phoenix-protocol.js';
import { addWorkerBot, addStandbyWorkerBot, addWorkerBotsBulk } from '../ghost-fleet.js';

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

      await sendTelegramMessage(chatId, `📋 <b>Bulk Store Complete! (${codes.length} Files Stored)</b>\n\nTap box to expand and copy all links:\n<blockquote expandable><pre>${rawBlock}</pre></blockquote>`, {
        inline_keyboard: [
          [{ text: toSmallCaps('Store More Files'), callback_data: 'admin:bulk_store_start' }],
          [{ text: toSmallCaps('Back to File Management'), callback_data: 'admin:file_mgmt' }]
        ]
      });

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

      const fileUniqueId = extractMediaUniqueId(message);
      if (fileUniqueId) {
        const existing = await findFileByUniqueId(fileUniqueId);
        if (existing) {
          const code = existing._id;
          const count = await addToStoreSession(chatId, code);
          const bot = await getBotUsername();
          const link = `https://t.me/${bot}?start=${code}`;

          const quality = existing.quality || detectMediaQuality(message);
          const rawSize = existing.fileSize || message.video?.file_size || message.document?.file_size || message.audio?.file_size || 0;
          const sizeLabel = existing.fileSizeLabel || formatBytes(rawSize);
          const title = existing.title || extractMediaTitle(message);

          const detailsLine = (type === 'video' || type === 'document')
            ? `\n📁 <b>Title:</b> <code>${esc(title)}</code>\n📀 <b>Quality:</b> <code>${quality} • ${sizeLabel}</code>\n`
            : (rawSize ? `\n💾 <b>Size:</b> <code>${sizeLabel}</code>\n` : '\n');

          await sendTelegramMessage(chatId, `⚡ <b>File Already Exists (${count} Stored, Deduplicated)</b>\n<i>Reused existing record to avoid duplicate storage in DB channel.</i>${detailsLine}Link: <code>${link}</code>\n\nSend another file, or tap below when finished:`, {
            inline_keyboard: [
              [{ text: toSmallCaps(`Done & Get All Links (${count})`), callback_data: 'admin:bulk_store_done' }],
              [{ text: toSmallCaps('Cancel'), callback_data: 'admin:bulk_store_cancel' }]
            ]
          });

          logActivity({
            eventType: 'file_deduplicated',
            userId: chatId,
            username: message.from?.username,
            firstName: message.from?.first_name,
            targetCode: code,
            targetType: 'file',
            details: `Bulk store deduplicated ${code} (${fileUniqueId})`,
            metadata: { fileUniqueId, fileCode: code, mode: 'bulk' }
          }).catch(() => {});

          return true;
        }
      }

      const code = generateFileCode();
      const stealth = await isStealthStorageEnabled();
      const cloakedCaption = stealth ? generateCloakedCaption(code) : null;

      const copyResult = await copyIntoDbChannel(dbChannelId, chatId, message.message_id, cloakedCaption);
      if (copyResult.ok) {
        let backupMessageId = null;
        const backupDbChannelId = await getBackupDbChannelId();
        if (backupDbChannelId) {
          const backupRes = await copyIntoDbChannel(backupDbChannelId, chatId, message.message_id, cloakedCaption);
          if (backupRes?.ok) backupMessageId = backupRes.messageId;
        }

        const quality = detectMediaQuality(message);
        const rawSize = message.video?.file_size || message.document?.file_size || message.audio?.file_size || 0;
        const sizeLabel = formatBytes(rawSize);
        const rawTitle = extractMediaTitle(message);
        const title = (stealth && rawTitle) ? sanitizeMediaTitle(rawTitle) : rawTitle;
        const rawFileName = message.document?.file_name || message.video?.file_name || message.audio?.file_name || '';
        const fileName = (stealth && rawFileName) ? sanitizeMediaTitle(rawFileName) : rawFileName;
        const saltedFingerprint = (stealth && fileUniqueId) ? generateSaltedFileFingerprint(fileUniqueId) : undefined;

        await storeFile(code, {
          dbChannelId,
          dbMessageId: copyResult.messageId,
          backupDbChannelId: backupMessageId ? backupDbChannelId : undefined,
          backupDbMessageId: backupMessageId || undefined,
          type: type,
          fileId: message.document?.file_id || message.video?.file_id || message.audio?.file_id || message.photo?.[0]?.file_id,
          fileUniqueId: fileUniqueId || undefined,
          saltedFingerprint,
          title: title || undefined,
          fileName: fileName || undefined,
          stealth: stealth || undefined,
          quality: (type === 'video' || type === 'document') ? quality : undefined,
          fileSize: rawSize || undefined,
          fileSizeLabel: rawSize ? sizeLabel : undefined,
          accessCount: 0
        }, { userId: chatId, username: message.from?.username, firstName: message.from?.first_name });
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
        const stealth = await isStealthStorageEnabled();
        const cloakedCaption = stealth ? generateCloakedCaption('BATCH') : null;
        const copyResult = await copyIntoDbChannel(dbChannelId, extracted.channelId, extracted.msgId, cloakedCaption);
        if (!copyResult.ok) {
          await sendTelegramMessage(chatId, `❌ <b>Failed to copy message.</b>\nReason: ${copyResult.reason}`);
          return true;
        }
        let backupFirstId = null;
        const backupDbChannelId = await getBackupDbChannelId();
        if (backupDbChannelId) {
          const bRes = await copyIntoDbChannel(backupDbChannelId, extracted.channelId, extracted.msgId, cloakedCaption);
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

          sendChatAction(chatId, 'upload_document').catch(() => {});
          const initSummary = `⏳ <b>Creating Batch...</b>\n\n` +
            `• Range: <code>#${batchSession.srcFirstMsgId}</code> to <code>#${extracted.msgId}</code>\n` +
            `• Total Files: <b>${totalFiles}</b>\n` +
            `────────────────────────\n` +
            `<i>Delivering to storage... [▒▒▒▒▒▒▒▒▒▒] 0% (1/${totalFiles} saved)</i>`;
          const progressMsg = await sendTelegramMessage(chatId, initSummary);

          let lastProgressEdit = Date.now();
          let processedCount = 1; // first file was already saved at step === 'first'
          const backupDbChannelId = await getBackupDbChannelId();

          const remainingSrcIds = [];
          for (let srcId = batchSession.srcFirstMsgId + 1; srcId <= extracted.msgId; srcId++) {
            remainingSrcIds.push(srcId);
          }

          const collectedIds = [...(batchSession.collectedIds || [])];
          const backupCollectedIds = [...(batchSession.backupCollectedIds || [])];
          const CHUNK_SIZE = 100;

          for (let i = 0; i < remainingSrcIds.length; i += CHUNK_SIZE) {
            const chunk = remainingSrcIds.slice(i, i + CHUNK_SIZE);

            // Fast path: bulk copy entire chunk (up to 100 files in 1 call)
            let copyRes = await copyTelegramMessages(dbChannelId, batchSession.srcChannelId, chunk, false);
            let backupRes = null;
            if (backupDbChannelId) {
              backupRes = await copyTelegramMessages(backupDbChannelId, batchSession.srcChannelId, chunk, false);
            }

            if (copyRes?.ok && Array.isArray(copyRes.messageIds) && copyRes.messageIds.length > 0) {
              collectedIds.push(...copyRes.messageIds);
              if (backupRes?.ok && Array.isArray(backupRes.messageIds) && backupRes.messageIds.length > 0) {
                backupCollectedIds.push(...backupRes.messageIds);
              }
              processedCount += copyRes.messageIds.length;
            } else {
              // Smart fallback: Only if bulk copy completely failed, fall back to item-by-item copy with pacing
              log('warn', 'Batch range bulk copy failed, using paced fallback', {
                chunkSize: chunk.length, reason: copyRes?.reason
              });
              for (let j = 0; j < chunk.length; j++) {
                const srcId = chunk[j];
                const r = await copyIntoDbChannel(dbChannelId, batchSession.srcChannelId, srcId);
                let backupId = null;
                if (backupDbChannelId && r.ok) {
                  const bRes = await copyIntoDbChannel(backupDbChannelId, batchSession.srcChannelId, srcId);
                  if (bRes.ok && bRes.messageId) backupId = bRes.messageId;
                }
                if (r.ok && r.messageId) {
                  collectedIds.push(r.messageId);
                  if (backupId) backupCollectedIds.push(backupId);
                }
                processedCount++;
                if (totalFiles > 20) await new Promise((r) => setTimeout(r, 350));
              }
            }

            // Update live progress bar
            const now = Date.now();
            if (now - lastProgressEdit >= 1500 || processedCount >= totalFiles) {
              lastProgressEdit = now;
              sendChatAction(chatId, 'upload_document').catch(() => {});
              const pct = Math.min(100, Math.round((processedCount / totalFiles) * 100));
              const filled = Math.round((pct / 100) * 10);
              const bar = '█'.repeat(filled) + '▒'.repeat(10 - filled);
              if (progressMsg?.messageId) {
                const updatedStatus = `⏳ <b>Creating Batch...</b>\n\n` +
                  `• Range: <code>#${batchSession.srcFirstMsgId}</code> to <code>#${extracted.msgId}</code>\n` +
                  `• Total Files: <b>${totalFiles}</b>\n` +
                  `────────────────────────\n` +
                  `<i>Delivering to storage... ${bar} ${pct}% (${processedCount}/${totalFiles} saved)</i>`;
                await editTelegramMessage(chatId, progressMsg.messageId, updatedStatus).catch(() => {});
              }
            }
          }

          const batchCode = generateBatchCode();
          await storeBatch(batchCode, dbChannelId, collectedIds, { userId: chatId, username: message.from?.username, firstName: message.from?.first_name }, { backupDbChannelId, backupDbMessageIds: backupCollectedIds });
          await clearBatchSession(chatId);
          const botUsername = await getBotUsername();
          const finalSuccessText = `✅ <b>Batch Created!</b>\n\nFiles: <b>${collectedIds.length}</b>\nLink: <code>https://t.me/${botUsername}?start=${batchCode}</code>\n<i>(Tap link to copy)</i>`;
          const finalKeyboard = {
            inline_keyboard: [
              [{ text: toSmallCaps('Generate Temp Link'), callback_data: `admin:temp_token_for:${batchCode}` }],
              [{ text: toSmallCaps('Create Another Batch'), callback_data: 'admin:batch_start' }, { text: toSmallCaps("Today's Links"), callback_data: 'admin:today_links' }],
              [{ text: toSmallCaps('Back to Dashboard'), callback_data: 'admin:dashboard' }]
            ]
          };

          if (progressMsg?.messageId) {
            const editRes = await editTelegramMessage(chatId, progressMsg.messageId, finalSuccessText, finalKeyboard);
            if (!editRes?.ok) {
              await sendTelegramMessage(chatId, finalSuccessText, finalKeyboard);
            }
          } else {
            await sendTelegramMessage(chatId, finalSuccessText, finalKeyboard);
          }
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

      const stealth = await isStealthStorageEnabled();
      const cloakedCaption = stealth ? generateCloakedCaption('BATCH') : null;
      const copyResult = await copyIntoDbChannel(dbChannelId, chatId, message.message_id, cloakedCaption);
      if (copyResult.ok) {
        let backupMsgId = null;
        const backupDbChannelId = await getBackupDbChannelId();
        if (backupDbChannelId) {
          const bRes = await copyIntoDbChannel(backupDbChannelId, chatId, message.message_id, cloakedCaption);
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

      await storeBundle(bundleCode, title, dbChannelId, bSession.qualities, { userId: chatId, username: message.from?.username, firstName: message.from?.first_name }, { backupDbChannelId });
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
        await processBundleRange(chatId, range, bundleSession.sessionMsgId, bundleSession.title, { userId: chatId, username: message.from?.username, firstName: message.from?.first_name });
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
            if (nMsg?.messageId) {
              await setBundleSession(chatId, { ...bundleSession, step: 'last', srcChannelId: extracted.channelId, srcFirstMsgId: extracted.msgId, sessionMsgId: nMsg.messageId });
            }
          }
        } else {
          const nMsg = await sendTelegramMessage(chatId, text, kb);
          if (nMsg?.messageId) {
            await setBundleSession(chatId, { ...bundleSession, step: 'last', srcChannelId: extracted.channelId, srcFirstMsgId: extracted.msgId, sessionMsgId: nMsg.messageId });
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
          await processBundleRange(chatId, range, bundleSession.sessionMsgId, bundleSession.title, { userId: chatId, username: message.from?.username, firstName: message.from?.first_name });
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

      const stealth = await isStealthStorageEnabled();
      const cloakedCaption = stealth ? generateCloakedCaption('BUNDLE') : null;
      const copyResult = await copyIntoDbChannel(dbChannelId, chatId, message.message_id, cloakedCaption);
      if (copyResult.ok) {
        let backupMsgId = null;
        const backupDbChannelId = await getBackupDbChannelId();
        if (backupDbChannelId) {
          const bRes = await copyIntoDbChannel(backupDbChannelId, chatId, message.message_id, cloakedCaption);
          if (bRes.ok && bRes.messageId) backupMsgId = bRes.messageId;
        }

        const quality = detectMediaQuality(message);
        const rawSize = message.video?.file_size || message.document?.file_size || message.audio?.file_size || 0;
        const sizeLabel = formatBytes(rawSize);
        const qualityFileId = message.video?.file_id || message.document?.file_id || message.audio?.file_id;
        const rawFileName = message.document?.file_name || message.video?.file_name || message.audio?.file_name || '';
        const qItem = {
          quality,
          fileSize: rawSize,
          fileSizeLabel: sizeLabel,
          dbMessageId: copyResult.messageId,
          backupDbMessageId: backupMsgId,
          fileName: rawFileName,
          fileId: qualityFileId || undefined,
          type: message.video ? 'video' : (message.document ? 'document' : 'media')
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
            if (nMsg?.messageId) {
              await setBundleSession(chatId, { ...bundleSession, title: currentTitle, sessionMsgId: nMsg.messageId });
            }
          }
        } else {
          const nMsg = await sendTelegramMessage(chatId, text, kb);
          if (nMsg?.messageId) {
            await setBundleSession(chatId, { ...bundleSession, title: currentTitle, sessionMsgId: nMsg.messageId });
          }
        }
        return true;
      }
    }
  }

  const wsDoc = await sessions.findOne({ _id: `admin:waiting_setting:${chatId}` });
  const waitingFor = wsDoc && wsDoc.expiresAt > new Date() ? wsDoc.val : null;
  if (waitingFor) {
    if (rawText && rawText.startsWith('/')) {
      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });
      if (rawText === '/cancel') {
        await sendTelegramMessage(chatId, `✅ Cancelled.`);
        return true;
      }
      return null;
    }

    if (waitingFor === 'fs_fsub_msg_forward') {
      const res = await resolveChannelIdFromMessageOrText(message, rawText, {
        errorContext: 'channel'
      });
      if (!res.ok) {
        await sendTelegramMessage(chatId, res.error);
        return true;
      }
      const { targetCid, targetTitle } = res;

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
      const res = await resolveChannelIdFromMessageOrText(message, rawText, {
        errorContext: 'backup channel'
      });
      if (!res.ok) {
        await sendTelegramMessage(chatId, res.error);
        return true;
      }
      const { targetCid } = res;

      await updateSettings({ backupDbChannelId: String(targetCid) });
      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });

      await sendTelegramMessage(chatId, `✅ <b>Backup DB Channel Configured!</b>\n\nChannel ID: <code>${targetCid}</code>\n\nAll newly stored files and batches will now automatically be mirrored to this channel.`);

      await renderStorageAudit(chatId);
      return true;
    }

    if (waitingFor === 'standby_channel_id') {
      const res = await resolveChannelIdFromMessageOrText(message, rawText, {
        errorContext: 'standby channel'
      });
      if (!res.ok) {
        await sendTelegramMessage(chatId, res.error);
        return true;
      }
      const { targetCid } = res;

      await setStandbyChannelId(targetCid);
      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });

      await sendTelegramMessage(chatId, `🔥 <b>The Phoenix Protocol Armed!</b>\n\nStandby Channel ID: <code>${targetCid}</code>\n\nIf your primary database channel ever suffers a fatal ban or strike, the bot will autonomously failover to this channel and rebuild your files with 0 downtime.`);

      await renderStorageAudit(chatId);
      return true;
    }

    if (waitingFor === 'relay_chat_id') {
      const res = await resolveChannelIdFromMessageOrText(message, rawText, {
        allowGroup: true,
        errorContext: 'relay group/channel',
        notAdminError: `❌ <b>Main Bot is not an admin in this Relay chat!</b>\n\nPlease add the Main Bot as an administrator in the relay group/channel with Post & Delete Messages permissions and try again.`
      });
      if (!res.ok) {
        await sendTelegramMessage(chatId, res.error);
        return true;
      }
      const { targetCid } = res;

      await updateSettings({ relayChatId: String(targetCid) });
      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });

      await sendTelegramMessage(chatId, `✅ <b>Air-Gapped Relay Tunnel Configured!</b>\n\n• Relay Chat ID: <code>${targetCid}</code>\n\nAll worker deliveries will now transit through this tunnel. <b>Your Main DB Channel remains 100% sacred and isolated with ZERO workers inside it!</b>`, {
        inline_keyboard: [[{ text: toSmallCaps('Ghost Fleet Manager'), callback_data: 'admin:ghost_fleet' }]]
      });

      return true;
    }

    if (waitingFor === 'rebuild_channel_id') {
      const res = await resolveChannelIdFromMessageOrText(message, rawText, {
        errorContext: 'target channel',
        formatError: `❌ <b>Please forward a message directly from the target channel, or send the channel ID directly</b> (e.g. <code>-1001234567890</code>).`,
        notAdminError: `❌ <b>Bot is not an admin in this channel!</b>\n\nPlease add the bot as an administrator in the channel with Post Messages permissions and try again.`
      });
      if (!res.ok) {
        await sendTelegramMessage(chatId, res.error);
        return true;
      }
      const { targetCid } = res;

      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });

      const statusMsg = await sendTelegramMessage(chatId, `🔄 <b>Rebuilding Channel Storage...</b>\n\nTarget Channel: <code>${targetCid}</code>\n<i>Scanning database files...</i>`);
      const statusMsgId = statusMsg?.messageId;

      let lastProgressEdit = 0;
      const onProgress = async ({ processed, total, restored, failed, skipped }) => {
        const now = Date.now();
        if (now - lastProgressEdit > 1500 || processed === total) {
          lastProgressEdit = now;
          const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
          const barLength = 10;
          const filled = Math.min(barLength, Math.round((pct / 100) * barLength));
          const bar = '▓'.repeat(filled) + '░'.repeat(barLength - filled);

          const progressText = `🔄 <b>Rebuilding Channel Storage...</b>\n\n` +
            `Target Channel: <code>${targetCid}</code>\n` +
            `Progress: [${bar}] <b>${pct}%</b> (${processed}/${total})\n\n` +
            `• Restored: <b>${restored}</b>\n` +
            `• Failed: <b>${failed}</b>\n` +
            `• Skipped: <b>${skipped}</b>\n\n` +
            `<i>Please do not stop the bot while rebuild is in progress...</i>`;

          if (statusMsgId) {
            await editTelegramMessage(chatId, statusMsgId, progressText).catch(() => {});
          }
        }
      };

      const result = await rebuildChannelStorage(targetCid, onProgress);

      if (!result?.ok) {
        await sendTelegramMessage(chatId, `❌ <b>Rebuild failed:</b> ${result?.reason || 'Unknown error'}`);
        return true;
      }

      await updateSettings({ dbChannelId: String(targetCid) });

      const summaryText = `🎉 <b>Channel Rebuild Complete!</b>\n\n` +
        `• Target Channel: <code>${targetCid}</code>\n` +
        `• Total Eligible: <b>${result.total}</b>\n` +
        `• Successfully Restored: <b>${result.restored}</b>\n` +
        `• Failed: <b>${result.failed}</b>\n` +
        `• Skipped (no file_id): <b>${result.skipped}</b>\n\n` +
        `✅ <b>DB Channel Updated:</b> New uploads and all restored links will now use this channel seamlessly without downtime.`;

      if (statusMsgId) {
        await editTelegramMessage(chatId, statusMsgId, summaryText, {
          inline_keyboard: [
            [{ text: toSmallCaps('Storage & Backup Audit'), callback_data: 'admin:storage_audit' }],
            [{ text: toSmallCaps('Open Settings'), callback_data: 'admin:fs_settings' }]
          ]
        }).catch(() => {});
      } else {
        await sendTelegramMessage(chatId, summaryText, {
          inline_keyboard: [
            [{ text: toSmallCaps('Storage & Backup Audit'), callback_data: 'admin:storage_audit' }],
            [{ text: toSmallCaps('Open Settings'), callback_data: 'admin:fs_settings' }]
          ]
        });
      }
      return true;
    }

    if (waitingFor === 'dbChannelId') {
      const res = await resolveChannelIdFromMessageOrText(message, rawText, {
        errorContext: 'DB channel',
        formatError: `❌ <b>Please forward a message directly from the DB channel, or send the channel ID directly</b> (e.g. <code>-100123456789</code>).\n\nSend /cancel to abort.`
      });
      if (!res.ok) {
        await sendTelegramMessage(chatId, res.error);
        return true;
      }
      const { targetCid } = res;

      await updateSettings({ dbChannelId: String(targetCid) });
      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });
      await sendTelegramMessage(chatId, `✅ <b>Database Channel Configured!</b>\n\nChannel ID: <code>${targetCid}</code>`, {
        inline_keyboard: [[{ text: toSmallCaps('Back to Settings'), callback_data: 'admin:fs_settings' }]]
      });
      return true;
    }

    if (waitingFor === 'fs_fsub_bulk_import') {
      const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) {
        await sendTelegramMessage(chatId, `❌ <b>No channels provided.</b> Send channel IDs or /cancel to abort.`);
        return true;
      }

      const s = await getSettings();
      const globalMode = s?.forceSubscribeMode || 'normal';
      const existingChannels = getForceSubChannelsList(s?.forceSubscribeChannels, globalMode);
      const channelMap = new Map(existingChannels.map(c => [String(c.id), c]));

      let addedCount = 0;
      let updatedCount = 0;
      const errors = [];

      for (const line of lines) {
        const [rawId, mode, label, title] = line.split(':').map(part => (part || '').trim());
        if (!/^-100\d+$/.test(rawId)) {
          errors.push(`Invalid ID: <code>${esc(rawId)}</code>`);
          continue;
        }

        const validMode = (mode === 'join_request' || mode === 'normal') ? mode : globalMode;
        let channelTitle = title;
        if (!channelTitle) {
          try {
            const chatRes = await getChat(rawId);
            if (chatRes?.ok && chatRes.result?.title) {
              channelTitle = chatRes.result.title;
            }
          } catch {}
        }
        if (!channelTitle) channelTitle = rawId;

        const channelObj = {
          id: rawId,
          mode: validMode,
          buttonLabel: label || null,
          title: channelTitle
        };

        if (channelMap.has(rawId)) {
          channelMap.set(rawId, { ...channelMap.get(rawId), ...channelObj });
          updatedCount++;
        } else {
          channelMap.set(rawId, channelObj);
          addedCount++;
        }
      }

      const finalChannels = Array.from(channelMap.values());
      await updateSettings({ forceSubscribeChannels: JSON.stringify(finalChannels) });
      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });

      let resp = `✅ <b>Bulk Import Complete!</b>\n\n• Added: <b>${addedCount}</b>\n• Updated: <b>${updatedCount}</b>\n• Total Channels: <b>${finalChannels.length}</b>`;
      if (errors.length) {
        resp += `\n\n⚠️ <i>Warnings / Skipped:</i>\n${errors.join('\n')}`;
      }
      await sendTelegramMessage(chatId, resp, {
        inline_keyboard: [[{ text: toSmallCaps('Force Subscribe Settings'), callback_data: 'admin:fs_cfg:fsub' }]]
      });
      return true;
    }

    if (waitingFor.startsWith('fs_fsub_lbl_')) {
      const idx = parseInt(waitingFor.replace('fs_fsub_lbl_', ''), 10);
      const s = await getSettings();
      const globalMode = s?.forceSubscribeMode || 'normal';
      const channels = getForceSubChannelsList(s?.forceSubscribeChannels, globalMode);
      if (channels[idx]) {
        channels[idx].buttonLabel = rawText.trim();
        await updateSettings({ forceSubscribeChannels: JSON.stringify(channels) });
        await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });
        await sendTelegramMessage(chatId, `✅ <b>Updated Button Label!</b>\n\nChannel: <b>${esc(channels[idx].title || channels[idx].id)}</b>\nLabel: <code>${esc(rawText.trim())}</code>`, {
          inline_keyboard: [[{ text: toSmallCaps('Back to Force Sub'), callback_data: 'admin:fs_cfg:fsub' }]]
        });
        return true;
      } else {
        await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });
        await sendTelegramMessage(chatId, `❌ Channel not found at specified index.`);
        return true;
      }
    }

    if (waitingFor === 'logChannelId') {
      const trimmed = rawText.trim();
      if (!/^-100\d+$/.test(trimmed) && !/^@[a-zA-Z0-9_]{4,}$/.test(trimmed)) {
        await sendTelegramMessage(chatId, `❌ <b>Invalid Log Channel ID!</b>\n\nMust be in format <code>-100dddddddddd</code> or <code>@channel_username</code>. Please try again or send /cancel.`);
        return true;
      }
    } else if (waitingFor === 'sponsorBtnText') {
      const trimmed = rawText.trim();
      if (!trimmed || trimmed.length > 50) {
        await sendTelegramMessage(chatId, `❌ <b>Invalid button text!</b> Must be between 1 and 50 characters. Please try again or send /cancel.`);
        return true;
      }
    } else if (waitingFor === 'sponsorBtnUrl') {
      const trimmed = rawText.trim();
      if (!isSafePublicUrl(trimmed) && !trimmed.startsWith('tg://') && !trimmed.startsWith('https://t.me/')) {
        await sendTelegramMessage(chatId, `❌ <b>Invalid button URL!</b> Must be a valid public HTTP/HTTPS or Telegram URL (e.g. <code>https://t.me/...</code>). Please try again or send /cancel.`);
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

    let value = rawText.trim();
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
    else if (['sponsorBtnText', 'sponsorBtnUrl'].includes(waitingFor)) backCb = 'admin:sponsor_mgmt';
    else if (['startText'].includes(waitingFor)) backCb = 'admin:fs_cfg:start';
    else if (['forceSubscribeChannels', 'forceSubscribeMsg'].includes(waitingFor)) backCb = 'admin:fs_cfg:fsub';
    else if (['shortenerUrl', 'shortenerKey', 'backupShortenerUrl', 'backupShortenerKey', 'validityHours', 'tutorialFileId', 'shortenerRatio'].includes(waitingFor)) backCb = 'admin:fs_cfg:tkn';

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
        await sendTelegramMessage(chatId, `📋 <b>${title} (${records.length})</b>\n\nTap box to expand and copy all links:\n<blockquote expandable><pre>${rawBlock}</pre></blockquote>`);
      }

      await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>${title}</b> (${records.length} records)`, {
        inline_keyboard: [[{ text: toSmallCaps('Back to Export Hub'), callback_data: 'admin:export_hub' }]]
      });
      return true;
    }

    if (waitingAction === 'broadcast') {
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });

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
            { text: toSmallCaps('📌 Send & Pin to All'), callback_data: 'admin:broadcast_confirm_pin' }
          ],
          [{ text: toSmallCaps('Cancel'), callback_data: 'admin:broadcast_cancel_draft' }]
        ]
      });

      return true;
    }

    if (waitingAction === 'ban') {
      const parts = rawText.trim().split(/\s+/);
      const targetArg = parts[0];
      const targetId = await resolveUser(targetArg);
      if (!targetId) {
        await sendTelegramMessage(chatId, `❌ Invalid user or username: <code>${esc(targetArg)}</code>`);
        return true;
      }

      let durationSeconds = null;
      let reason = null;

      if (parts.length > 1) {
        const potentialDuration = parseDurationString(parts[1]);
        if (potentialDuration !== null) {
          durationSeconds = potentialDuration;
          if (parts.length > 2) {
            reason = parts.slice(2).join(' ');
          }
        } else {
          reason = parts.slice(1).join(' ');
        }
      }

      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
      await banUser(targetId, durationSeconds, reason, chatId);
      logHistory(`banned_tg: ${targetId}`, 'tg').catch(() => {});

      let confirmText = `✅ User <code>${targetId}</code> has been banned.`;
      if (durationSeconds) {
        confirmText += `\nDuration: <b>${formatDuration(durationSeconds)}</b>`;
      } else {
        confirmText += `\nDuration: <b>Permanent</b>`;
      }
      if (reason) {
        confirmText += `\nReason: <code>${esc(reason)}</code>`;
      }

      await sendTelegramMessage(chatId, confirmText, {
        inline_keyboard: [[{ text: toSmallCaps('Back to User Mgmt'), callback_data: 'admin:user_mgmt' }]]
      });
      return true;
    }

    if (waitingAction === 'unban') {
      const targetArg = rawText.trim().split(/\s+/)[0];
      const targetId = await resolveUser(targetArg);
      if (!targetId) {
        await sendTelegramMessage(chatId, `❌ Invalid user or username: <code>${esc(targetArg)}</code>`);
        return true;
      }
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
      await unbanUser(targetId);
      logHistory(`unbanned_tg: ${targetId}`, 'tg').catch(() => {});
      await sendTelegramMessage(chatId, `✅ User <code>${targetId}</code> has been unbanned.`, {
        inline_keyboard: [[{ text: toSmallCaps('Back to User Mgmt'), callback_data: 'admin:user_mgmt' }]]
      });
      return true;
    }

    if (waitingAction === 'add_worker') {
      const tokenCandidate = rawText.trim();
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });

      const addRes = await addWorkerBotsBulk(tokenCandidate, 'active');
      if (addRes.ok) {
        let msg = `🎉 <b>Ghost Fleet Active Worker${addRes.total > 1 ? 's' : ''} Added!</b>\n\n`;
        msg += `• Successfully Added: <b>${addRes.successCount} / ${addRes.total}</b>\n`;
        for (const item of (addRes.successList || [])) {
          msg += `  ✅ @${esc(item.worker?.username || item.worker?.botId)}\n`;
        }
        if (addRes.failedCount > 0) {
          msg += `\n⚠️ <i>${addRes.failedCount} token(s) failed verification.</i>\n`;
        }
        msg += `\nThese active delivery nodes are now live in the round-robin rotation!`;
        await sendTelegramMessage(chatId, msg, {
          inline_keyboard: [
            [{ text: toSmallCaps('🟢 View Active Workers'), callback_data: 'admin:workers_active' }],
            [{ text: toSmallCaps('« Ghost Fleet Dashboard'), callback_data: 'admin:ghost_fleet' }]
          ]
        });
      } else {
        await sendTelegramMessage(chatId, `❌ <b>Failed to add worker:</b>\n${esc(addRes.reason || 'Invalid token')}`, {
          inline_keyboard: [[{ text: toSmallCaps('Back to Ghost Fleet'), callback_data: 'admin:ghost_fleet' }]]
        });
      }
      return true;
    }

    if (waitingAction === 'add_standby_worker') {
      const tokenCandidate = rawText.trim();
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });

      const addRes = await addWorkerBotsBulk(tokenCandidate, 'standby');
      if (addRes.ok) {
        let msg = `🛡️ <b>Standby Reserve Worker${addRes.total > 1 ? 's' : ''} Added!</b>\n\n`;
        msg += `• Successfully Added: <b>${addRes.successCount} / ${addRes.total}</b>\n`;
        for (const item of (addRes.successList || [])) {
          msg += `  🟡 @${esc(item.worker?.username || item.worker?.botId)}\n`;
        }
        if (addRes.failedCount > 0) {
          msg += `\n⚠️ <i>${addRes.failedCount} token(s) failed verification.</i>\n`;
        }
        msg += `\nThese standby reserve nodes will automatically hot-swap into rotation if any active worker bot fails or gets rate limited!`;
        await sendTelegramMessage(chatId, msg, {
          inline_keyboard: [
            [{ text: toSmallCaps('🛡️ View Standby Reserve'), callback_data: 'admin:workers_standby' }],
            [{ text: toSmallCaps('« Ghost Fleet Dashboard'), callback_data: 'admin:ghost_fleet' }]
          ]
        });
      } else {
        await sendTelegramMessage(chatId, `❌ <b>Failed to add standby worker:</b>\n${esc(addRes.reason || 'Invalid token')}`, {
          inline_keyboard: [[{ text: toSmallCaps('Back to Ghost Fleet'), callback_data: 'admin:ghost_fleet' }]]
        });
      }
      return true;
    }
  }

  const wpDoc = await sessions.findOne({ _id: `admin:waiting_premium_user:${chatId}` });
  const isWaitingPremium = wpDoc && wpDoc.expiresAt > new Date() ? wpDoc.val : null;
  if (isWaitingPremium) {
    if (rawText === '/cancel') {
      await sessions.deleteOne({ _id: `admin:waiting_premium_user:${chatId}` });
      await sessions.deleteOne({ _id: `admin:premium_msg_id:${chatId}` });
      await sessions.deleteOne({ _id: `admin:premium_target:${chatId}` });
      await sendTelegramMessage(chatId, `✅ <b>Grant VIP cancelled.</b>`, {
        inline_keyboard: [[{ text: toSmallCaps('Back to User Mgmt'), callback_data: 'admin:user_mgmt' }]]
      });
      return true;
    }

    const targetUserId = await resolveUser(rawText);

    if (!targetUserId) {
      await sendTelegramMessage(chatId, `❌ User <code>${esc(rawText.trim())}</code> not found. If specifying by @username, the user must have started the bot first.`);
      return true;
    }

    const users = await getCollection('users');
    const u = await users.findOne({ _id: String(targetUserId) });
    const userLabel = u?.username ? `<code>${targetUserId}</code> (@${esc(u.username)})` : `<code>${targetUserId}</code>`;

    await sessions.updateOne(
      { _id: `admin:premium_target:${chatId}` },
      { $set: { val: String(targetUserId), expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await sessions.deleteOne({ _id: `admin:waiting_premium_user:${chatId}` });

    const pmDoc = await sessions.findOne({ _id: `admin:premium_msg_id:${chatId}` });
    const msgId = pmDoc && pmDoc.expiresAt > new Date() ? pmDoc.val : null;
    const durationKb = {
      inline_keyboard: [
        [{ text: toSmallCaps('1 Day'), callback_data: 'admin:fs_set_premium:1' }, { text: toSmallCaps('7 Days'), callback_data: 'admin:fs_set_premium:7' }, { text: toSmallCaps('30 Days'), callback_data: 'admin:fs_set_premium:30' }],
        [{ text: toSmallCaps('90 Days'), callback_data: 'admin:fs_set_premium:90' }, { text: toSmallCaps('365 Days'), callback_data: 'admin:fs_set_premium:365' }, { text: toSmallCaps('♾️ Lifetime'), callback_data: 'admin:fs_set_premium:lifetime' }],
        [{ text: toSmallCaps('❌ Revoke VIP'), callback_data: 'admin:fs_set_premium:revoke' }, { text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]
      ]
    };

    if (msgId) {
      await editTelegramMessage(chatId, msgId, `⭐ <b>Select Duration</b> for ${userLabel}:`, durationKb);
      await deleteTelegramMessage(chatId, message.message_id);
    } else {
      await sendTelegramMessage(chatId, `⭐ <b>Select Duration</b> for ${userLabel}:`, durationKb);
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
      const fileUniqueId = extractMediaUniqueId(message);
      if (fileUniqueId) {
        const existing = await findFileByUniqueId(fileUniqueId);
        if (existing) {
          const bot = await getBotUsername();
          const link = `https://t.me/${bot}?start=${existing._id}`;
          const title = existing.title || extractMediaTitle(message);
          const quality = existing.quality || detectMediaQuality(message);
          const rawSize = existing.fileSize || message.video?.file_size || message.document?.file_size || message.audio?.file_size || 0;
          const sizeLabel = existing.fileSizeLabel || formatBytes(rawSize);

          const detailsLine = (type === 'video' || type === 'document')
            ? `\n\n📁 <b>Title:</b> <code>${esc(title)}</code>\n📀 <b>Quality:</b> <code>${quality}</code> • <b>Size:</b> <code>${sizeLabel}</code>\n`
            : (rawSize ? `\n\n💾 <b>Size:</b> <code>${sizeLabel}</code>\n` : '\n\n');

          await sendTelegramMessage(chatId, `⚡ <b>File Already Exists in Storage! (Deduplicated)</b>\n<i>Reused existing database record instead of uploading a duplicate.</i>${detailsLine}<b>Link:</b>\n<code>${link}</code>\n<i>(Tap link to copy)</i>`, {
            inline_keyboard: [
              [{ text: toSmallCaps('Generate Temp Link'), callback_data: `admin:temp_token_for:${existing._id}` }],
              [{ text: toSmallCaps('Store Another File'), callback_data: 'admin:store_start' }, { text: toSmallCaps('Bulk Store Mode'), callback_data: 'admin:bulk_store_start' }],
              [{ text: toSmallCaps("Today's Links"), callback_data: 'admin:today_links' }, { text: toSmallCaps('Back to Dashboard'), callback_data: 'admin:dashboard' }]
            ]
          });

          logActivity({
            eventType: 'file_deduplicated',
            userId: chatId,
            username: message.from?.username,
            firstName: message.from?.first_name,
            targetCode: existing._id,
            targetType: 'file',
            details: `Deduplicated upload for ${existing._id} (${fileUniqueId})`,
            metadata: { fileUniqueId, fileCode: existing._id, mode: 'single' }
          }).catch(() => {});

          return true;
        }
      }

      const code = generateFileCode();
      const stealth = await isStealthStorageEnabled();
      const cloakedCaption = stealth ? generateCloakedCaption(code) : null;

      const copyResult = await copyIntoDbChannel(dbChannelId, chatId, message.message_id, cloakedCaption);
      if (copyResult.ok) {
        let backupMessageId = null;
        const backupDbChannelId = await getBackupDbChannelId();
        if (backupDbChannelId) {
          const backupRes = await copyIntoDbChannel(backupDbChannelId, chatId, message.message_id, cloakedCaption);
          if (backupRes?.ok) backupMessageId = backupRes.messageId;
        }

        const quality = detectMediaQuality(message);
        const rawSize = message.video?.file_size || message.document?.file_size || message.audio?.file_size || 0;
        const sizeLabel = formatBytes(rawSize);
        const rawTitle = extractMediaTitle(message);
        const title = (stealth && rawTitle) ? sanitizeMediaTitle(rawTitle) : rawTitle;
        const rawFileName = message.document?.file_name || message.video?.file_name || message.audio?.file_name || '';
        const fileName = (stealth && rawFileName) ? sanitizeMediaTitle(rawFileName) : rawFileName;
        const saltedFingerprint = (stealth && fileUniqueId) ? generateSaltedFileFingerprint(fileUniqueId) : undefined;

        await storeFile(code, {
          dbChannelId,
          dbMessageId: copyResult.messageId,
          backupDbChannelId: backupMessageId ? backupDbChannelId : undefined,
          backupDbMessageId: backupMessageId || undefined,
          type: type,
          fileId: message.document?.file_id || message.video?.file_id || message.audio?.file_id || message.photo?.[0]?.file_id,
          fileUniqueId: fileUniqueId || undefined,
          saltedFingerprint,
          title: title || undefined,
          fileName: fileName || undefined,
          stealth: stealth || undefined,
          quality: (type === 'video' || type === 'document') ? quality : undefined,
          fileSize: rawSize || undefined,
          fileSizeLabel: rawSize ? sizeLabel : undefined,
          accessCount: 0
        }, { userId: chatId, username: message.from?.username, firstName: message.from?.first_name });
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

export async function processBundleRange(chatId, range, sessionMsgId = null, explicitTitle = '', creator = {}) {
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
    activeMsgId = sMsg?.messageId;
  }

  const qualities = [];
  let detectedTitle = explicitTitle || '';

  let lastProgressEdit = Date.now();
  let processedCount = 0;

  for (let srcId = firstMsgId; srcId <= lastMsgId; srcId++) {
    processedCount++;
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

    const now = Date.now();
    if (activeMsgId && (now - lastProgressEdit >= 1500 || processedCount === totalCount)) {
      lastProgressEdit = now;
      sendChatAction(chatId, 'upload_document').catch(() => {});
      const pct = Math.min(100, Math.round((processedCount / totalCount) * 100));
      const filled = Math.round((pct / 100) * 10);
      const bar = '█'.repeat(filled) + '▒'.repeat(10 - filled);
      const updatedStatus = `⏳ <b>Processing Bundle...</b>\n\n` +
        `• Range: <code>#${firstMsgId}</code> to <code>#${lastMsgId}</code>\n` +
        `• Qualities Found: <b>${qualities.length}</b>\n` +
        `────────────────────────\n` +
        `<i>Fetching resolutions... ${bar} ${pct}% (${processedCount}/${totalCount})</i>`;
      await editTelegramMessage(chatId, activeMsgId, updatedStatus).catch(() => {});
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

  // storeBundle() already writes the 'bundle_create' activity log entry
  // (with proper username/firstName attribution below) — a second,
  // unattributed logActivity() call used to run right after this and would
  // show up in the log channel with no name attached. Removed.
  await storeBundle(bundleCode, finalTitle, dbChannelId, qualities, { userId: chatId, username: creator.username, firstName: creator.firstName }, { backupDbChannelId });
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
