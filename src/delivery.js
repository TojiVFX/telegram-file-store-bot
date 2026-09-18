import { randomBytes } from 'node:crypto';
import {
  getCollection, getSettings, log, getToken,
  sendTelegramMessage, editTelegramMessage, deleteTelegramMessages,
  copyTelegramMessages, botContext, toSmallCaps, getMainToken,
  copyMessage, forwardMessage
} from './bot-common.js';
import {
  getBotUsername, getMainBotUsername, isChannelFatalError, alertAdminChannelFailure
} from './channel-helpers.js';
import { getSponsorButton } from './ui-builders.js';
import {
  getRelayChatId, deliverViaRelayTunnel, deliverBatchViaRelayTunnel
} from './ghost-fleet.js';

export { copyMessage, forwardMessage };

export async function copyIntoDbChannel(dbChannelId, fromChatId, msgId, protectContent = false, customCaption = null) {
  return botContext.run({ token: getMainToken() }, () => copyMessage(dbChannelId, fromChatId, msgId, protectContent, null, 2, customCaption));
}

export async function copyFromDbChannel(toChatId, dbChannelId, msgId, protectContent = false) {
  const token = getToken();
  const isWorker = token !== getMainToken();

  // If running in a worker context, check if an Air-Gapped Relay Tunnel is active
  if (isWorker) {
    const relayChatId = await getRelayChatId();
    if (relayChatId) {
      const relayRes = await deliverViaRelayTunnel(toChatId, dbChannelId, msgId, protectContent);
      if (relayRes?.ok) return relayRes;
    }
  }

  let res = await copyMessage(toChatId, dbChannelId, msgId, protectContent);
  if (!res?.ok && isWorker) {
    // If worker bot lacks channel access and no relay, fallback to main bot token
    res = await botContext.run({ token: getMainToken() }, () => copyMessage(toChatId, dbChannelId, msgId, protectContent));
  }
  if (!res?.ok && isChannelFatalError(res?.reason)) {
    alertAdminChannelFailure(dbChannelId, 'DB Storage Channel', res.reason).catch(() => {});
  }
  return res;
}

// ─── Loading animation ──────────────────────────────────────────────────────────
export async function showLoadingAnimation(chatId) {
  const loadingMsg = await sendTelegramMessage(chatId, `⏳ <b>Files are loading...</b>\n\n[▒▒▒▒▒▒▒▒▒▒] 0%`);
  const steps = [
    { p: 30, b: '[███▒▒▒▒▒▒▒]' },
    { p: 70, b: '[███████▒▒▒]' },
    { p: 100, b: '[██████████]' }
  ];
  for (const step of steps) {
    await new Promise(r => setTimeout(r, 400));
    await editTelegramMessage(chatId, loadingMsg.messageId, `⏳ <b>Files are loading...</b>\n\n${step.b} ${step.p}%`);
  }
  return loadingMsg;
}

// ─── deliverBatch ─────────────────────────────────────────────────────────────
export async function deliverBatch(toChatId, batch, protectContent = false, batchCode = null, onProgress = null) {
  const { dbMessageIds, dbFirstMsgId, dbLastMsgId, backupDbChannelId, backupDbMessageIds, stagedTransitMsgIds } = batch;
  const dbChannelId = batch.dbChannelId || await getDbChannelId();
  const sentMessageIds = [];
  let failedCount = 0;
  const healedIndices = [];

  const totalCount = Array.isArray(dbMessageIds)
    ? dbMessageIds.length
    : (dbFirstMsgId && dbLastMsgId ? dbLastMsgId - dbFirstMsgId + 1 : 0);

  const isWorker = getToken() !== getMainToken();
  let hasRelay = false;
  if (isWorker) {
    hasRelay = Boolean(await getRelayChatId());
  }

  if (Array.isArray(dbMessageIds)) {
    let batchCopied = false;

    // Telegram copyMessages requires IDs to be strictly increasing
    const isIncreasing = dbMessageIds.every((id, idx) => idx === 0 || id > dbMessageIds[idx - 1]);
    if (isIncreasing && !hasRelay && dbMessageIds.length > 0) {
      const CHUNK_SIZE = 100;
      for (let i = 0; i < dbMessageIds.length; i += CHUNK_SIZE) {
        const chunk = dbMessageIds.slice(i, i + CHUNK_SIZE);
        let copyBatchRes = await copyTelegramMessages(toChatId, dbChannelId, chunk, protectContent);
        if (!copyBatchRes?.ok && getToken() !== getMainToken()) {
          copyBatchRes = await botContext.run({ token: getMainToken() }, () =>
            copyTelegramMessages(toChatId, dbChannelId, chunk, protectContent)
          );
        }
        if (copyBatchRes?.ok && copyBatchRes.messageIds.length === chunk.length) {
          sentMessageIds.push(...copyBatchRes.messageIds);
          if (typeof onProgress === 'function') {
            await onProgress(sentMessageIds.length, totalCount, 'delivering').catch(() => {});
          }
          if (i + CHUNK_SIZE < dbMessageIds.length) {
            await new Promise((r) => setTimeout(r, 200));
          }
        } else {
          // Chunk failed (e.g. some message in this chunk was deleted from primary channel)
          // Fallback to item-by-item delivery with backup channel failover for this chunk
          for (let j = 0; j < chunk.length; j++) {
            const globalIdx = i + j;
            const msgId = chunk[j];
            let res = await copyFromDbChannel(toChatId, dbChannelId, msgId, protectContent);

            if ((!res?.ok || !res?.messageId) && backupDbChannelId && Array.isArray(backupDbMessageIds) && backupDbMessageIds[globalIdx]) {
              const backupRes = await copyFromDbChannel(toChatId, backupDbChannelId, backupDbMessageIds[globalIdx], protectContent);
              if (backupRes?.ok && backupRes?.messageId) {
                res = backupRes;
                dbMessageIds[globalIdx] = backupDbMessageIds[globalIdx];
                healedIndices.push({ index: globalIdx, backupMsgId: backupDbMessageIds[globalIdx], backupChannelId: backupDbChannelId });
              }
            }

            if (res?.ok && res?.messageId) {
              sentMessageIds.push(res.messageId);
            } else {
              failedCount++;
            }
            if (typeof onProgress === 'function') {
              await onProgress(sentMessageIds.length + failedCount, totalCount, 'delivering').catch(() => {});
            }
            if (totalCount > 1) await new Promise((r) => setTimeout(r, 350));
          }
        }
      }
      batchCopied = true;
    }

    if (!batchCopied && hasRelay) {
      const relayRes = await deliverBatchViaRelayTunnel(toChatId, dbChannelId, dbMessageIds, backupDbChannelId, backupDbMessageIds, protectContent, onProgress, stagedTransitMsgIds);
      if (relayRes?.ok) {
        sentMessageIds.push(...relayRes.sentMessageIds);
        failedCount += relayRes.failedCount || 0;
        batchCopied = true;
        if (relayRes.healedIndices && relayRes.healedIndices.length > 0) {
          for (const h of relayRes.healedIndices) {
            dbMessageIds[h.index] = h.backupMsgId;
          }
          healedIndices.push(...relayRes.healedIndices);
        }
      }
    }

    if (!batchCopied) {
      for (let i = 0; i < dbMessageIds.length; i++) {
        const msgId = dbMessageIds[i];
        let res = await copyFromDbChannel(toChatId, dbChannelId, msgId, protectContent);

        // Seamless failover to backup DB channel if primary message fails
        if ((!res?.ok || !res?.messageId) && backupDbChannelId && Array.isArray(backupDbMessageIds) && backupDbMessageIds[i]) {
          const backupRes = await copyFromDbChannel(toChatId, backupDbChannelId, backupDbMessageIds[i], protectContent);
          if (backupRes?.ok && backupRes?.messageId) {
            res = backupRes;
            dbMessageIds[i] = backupDbMessageIds[i];
            healedIndices.push({ index: i, backupMsgId: backupDbMessageIds[i], backupChannelId: backupDbChannelId });
          }
        }

        if (res?.ok && res?.messageId) {
          sentMessageIds.push(res.messageId);
        } else {
          failedCount++;
        }
        if (typeof onProgress === 'function') {
          await onProgress(sentMessageIds.length + failedCount, totalCount, 'delivering').catch(() => {});
        }
        if (totalCount > 1) await new Promise((r) => setTimeout(r, 850));
      }
    }
  }
  else if (dbFirstMsgId && dbLastMsgId) {
    const rangeIds = [];
    for (let msgId = dbFirstMsgId; msgId <= dbLastMsgId; msgId++) {
      rangeIds.push(msgId);
    }

    let batchCopied = false;
    if (rangeIds.length > 0 && !hasRelay) {
      const CHUNK_SIZE = 100;
      for (let i = 0; i < rangeIds.length; i += CHUNK_SIZE) {
        const chunk = rangeIds.slice(i, i + CHUNK_SIZE);
        let copyBatchRes = await copyTelegramMessages(toChatId, dbChannelId, chunk, protectContent);
        if (!copyBatchRes?.ok && getToken() !== getMainToken()) {
          copyBatchRes = await botContext.run({ token: getMainToken() }, () =>
            copyTelegramMessages(toChatId, dbChannelId, chunk, protectContent)
          );
        }
        if (copyBatchRes?.ok && copyBatchRes.messageIds.length === chunk.length) {
          sentMessageIds.push(...copyBatchRes.messageIds);
          if (typeof onProgress === 'function') {
            await onProgress(sentMessageIds.length, totalCount, 'delivering').catch(() => {});
          }
          if (i + CHUNK_SIZE < rangeIds.length) {
            await new Promise((r) => setTimeout(r, 500));
          }
        } else {
          // Fallback for this chunk
          for (let j = 0; j < chunk.length; j++) {
            const msgId = chunk[j];
            let res = await copyFromDbChannel(toChatId, dbChannelId, msgId, protectContent);
            if (res?.ok && res?.messageId) {
              sentMessageIds.push(res.messageId);
            } else {
              failedCount++;
            }
            if (typeof onProgress === 'function') {
              await onProgress(sentMessageIds.length + failedCount, totalCount, 'delivering').catch(() => {});
            }
            if (totalCount > 1) await new Promise((r) => setTimeout(r, 850));
          }
        }
      }
      batchCopied = true;
    }

    if (!batchCopied && hasRelay) {
      const relayRes = await deliverBatchViaRelayTunnel(toChatId, dbChannelId, rangeIds, backupDbChannelId, backupDbMessageIds, protectContent, onProgress, stagedTransitMsgIds);
      if (relayRes?.ok) {
        sentMessageIds.push(...relayRes.sentMessageIds);
        failedCount += relayRes.failedCount || 0;
        batchCopied = true;
      }
    }

    if (!batchCopied) {
      for (let msgId = dbFirstMsgId; msgId <= dbLastMsgId; msgId++) {
        let res = await copyFromDbChannel(toChatId, dbChannelId, msgId, protectContent);
        if (res?.ok && res?.messageId) {
          sentMessageIds.push(res.messageId);
        } else {
          failedCount++;
        }
        if (typeof onProgress === 'function') {
          await onProgress(sentMessageIds.length + failedCount, totalCount, 'delivering').catch(() => {});
        }
        if (totalCount > 1) await new Promise((r) => setTimeout(r, 350));
      }
    }
  }

  if (failedCount > 0 && sentMessageIds.length === 0) {
    await sendTelegramMessage(toChatId, `❌ <b>Batch Unavailable</b>\n\nThe files in this batch are no longer available in storage (they may have been removed from the database channel).`, null, protectContent);
  } else if (failedCount > 0) {
    await sendTelegramMessage(toChatId, `⚠️ <b>Note:</b> ${failedCount} file(s) in this batch could not be retrieved because they were deleted from storage.`, null, protectContent);
  }

  // Proactive Link Healer: persist any healed batch item message pointers to MongoDB
  if (healedIndices.length > 0 && batchCode) {
    try {
      const files = await getCollection('files');
      await files.updateOne(
        { _id: batchCode },
        {
          $set: {
            dbMessageIds,
            autoHealedAt: new Date(),
            healedCount: healedIndices.length
          }
        }
      );
      log('info', 'Proactive Link Healer: Auto-healed batch message IDs in DB', { batchCode, healedCount: healedIndices.length });
    } catch (err) {
      log('warn', 'Failed to save auto-healed batch record', { batchCode, error: err.message });
    }
  }

  if (sentMessageIds.length > 0) {
    await scheduleAutoDelete(toChatId, sentMessageIds, batchCode);
  }
  return sentMessageIds;
}

export async function scheduleAutoDelete(chatId, messageIds, fileOrBatchCode = null) {
  if (!messageIds || (Array.isArray(messageIds) && messageIds.length === 0)) return;

  const s = await getSettings();
  const sponsorBtn = await getSponsorButton();

  // If auto-delete is disabled, attach sponsor ad button if configured
  if (s?.autoDeleteEnabled !== '1') {
    if (sponsorBtn) {
      await sendTelegramMessage(chatId, `✨ <b>Enjoy your download!</b>`, {
        inline_keyboard: [[sponsorBtn]]
      }, s?.protectContent === '1').catch(() => {});
    }
    return;
  }

  const timerSeconds = parseInt(s?.autoDeleteTimer, 10) || 300; // default 5 mins
  const ms = timerSeconds * 1000;
  const ids = [...new Set((Array.isArray(messageIds) ? messageIds : [messageIds]).filter(Boolean))];

  const formatTimerLabel = (sec) => {
    if (sec < 60) return `${sec} seconds`;
    if (sec < 3600) return `${Math.round(sec / 60)} minute(s)`;
    return `${Math.round(sec / 3600)} hour(s)`;
  };

  const timerLabel = formatTimerLabel(timerSeconds);

  const warnText = `⚠️ <b>Note:</b> These file(s) will be automatically deleted in <b>${timerLabel}</b>!\n\n💡 <i>Forward them to your <b>Saved Messages</b> to keep them permanently.</i>`;
  const inline_keyboard = [
    [{ text: toSmallCaps('How to Save'), callback_data: 'user:save_tip' }]
  ];
  if (sponsorBtn) {
    inline_keyboard.push([sponsorBtn]);
  }
  const warnKb = { inline_keyboard };

  const warnMsg = await sendTelegramMessage(chatId, warnText, warnKb, s?.protectContent === '1');
  const warnMsgId = (warnMsg?.ok && warnMsg?.messageId) ? warnMsg.messageId : null;
  if (warnMsgId) ids.push(warnMsgId);

  // Generate unique atomic job ID
  const jobId = `auto_del_${chatId}_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const t30Delay = (timerSeconds >= 60) ? (timerSeconds - 30) * 1000 : null;

  // Persist to MongoDB so deletions survive Render restarts / redeployments
  let dbPersisted = false;
  try {
    const autoDeletes = await getCollection('auto_deletes');
    await autoDeletes.insertOne({
      _id: jobId,
      chatId,
      messageIds: ids,
      fileOrBatchCode: fileOrBatchCode || null,
      warnMsgId,
      warnAt: t30Delay ? new Date(Date.now() + t30Delay) : null,
      warned: false,
      deleteAt: new Date(Date.now() + ms),
      createdAt: new Date(),
    });
    dbPersisted = true;
  } catch (err) {
    log('error', 'Failed to persist auto-delete job to database', { errorMessage: err.message });
  }

  // T-Minus 30s Warning timer (for timers >= 60s)
  if (warnMsgId && t30Delay) {
    const t30Timer = setTimeout(async () => {
      try {
        const t30Text = `⏳ <b>T-Minus 30s Warning!</b>\n\nThese file(s) will be automatically deleted in <b>30 seconds</b>!\n\n💡 <i>Forward them to your <b>Saved Messages</b> NOW to keep them permanently.</i>`;
        await editTelegramMessage(chatId, warnMsgId, t30Text, warnKb).catch(() => {});
        if (dbPersisted) {
          const autoDeletes = await getCollection('auto_deletes');
          await autoDeletes.updateOne({ _id: jobId }, { $set: { warned: true } }).catch(() => {});
        }
      } catch {}
    }, t30Delay);
    t30Timer.unref?.();
  }

  // Set in-memory timeout with atomic findOneAndDelete to prevent race condition / double messages
  const delTimer = setTimeout(async () => {
    try {
      if (dbPersisted) {
        const autoDeletes = await getCollection('auto_deletes');
        const claimed = await autoDeletes.findOneAndDelete({ _id: jobId });
        const job = claimed?.value !== undefined ? claimed.value : claimed;
        if (!job) {
          // Already processed by background worker or another instance
          return;
        }
      }

      await deleteTelegramMessages(chatId, ids).catch(() => {});

      if (fileOrBatchCode) {
        try {
          const mainBot = await getMainBotUsername();
          const botUsername = mainBot || await getBotUsername();
          const reGetUrl = `https://t.me/${botUsername}?start=${fileOrBatchCode}`;
          const kb = {
            inline_keyboard: [
              [{ text: toSmallCaps('♻️ Re-send Files'), callback_data: `user:resend:${fileOrBatchCode}` }],
              [{ text: toSmallCaps('Open in Main Bot'), url: reGetUrl }]
            ]
          };
          if (sponsorBtn) kb.inline_keyboard.push([sponsorBtn]);

          await sendTelegramMessage(
            chatId,
            `🗑️ <b>Files Deleted</b>\n\nYour file(s) have been deleted automatically according to the auto-delete timer.`,
            kb
          );
        } catch (err) {
          log('error', 'Failed to send auto-delete follow-up', { errorMessage: err.message });
        }
      }
    } catch (err) {
      log('error', 'Auto-delete timer error', { errorMessage: err.message });
    }
  }, ms);
  delTimer.unref?.();
}

// ─── Background Auto-Delete Worker ───────────────────────────────────────────
let autoDeleteWorkerRunning = false;

export async function processDueAutoDeletes() {
  try {
    const autoDeletes = await getCollection('auto_deletes');
    const now = new Date();

    // 1. Process due T-Minus 30s warnings for active viewers
    try {
      const dueWarns = await autoDeletes.find({
        warned: { $ne: true },
        warnAt: { $lte: now },
        deleteAt: { $gt: now }
      }).limit(20).toArray();

      for (const wJob of dueWarns) {
        if (wJob.chatId && wJob.warnMsgId) {
          const t30Text = `⏳ <b>T-Minus 30s Warning!</b>\n\nThese file(s) will be automatically deleted in <b>30 seconds</b>!\n\n💡 <i>Forward them to your <b>Saved Messages</b> NOW to keep them permanently.</i>`;
          const kb = {
            inline_keyboard: [
              [{ text: toSmallCaps('How to Save'), callback_data: 'user:save_tip' }]
            ]
          };
          await editTelegramMessage(wJob.chatId, wJob.warnMsgId, t30Text, kb).catch(() => {});
          await autoDeletes.updateOne({ _id: wJob._id }, { $set: { warned: true } }).catch(() => {});
        }
      }
    } catch {}

    // 2. Process due deletions
    const dueJobs = await autoDeletes.find({ deleteAt: { $lte: now } }).limit(50).toArray();

    for (const job of dueJobs) {
      // Atomically claim the job before deleting any Telegram messages
      const claimed = await autoDeletes.findOneAndDelete({ _id: job._id });
      const doc = claimed?.value !== undefined ? claimed.value : claimed;
      if (!doc) {
        // Already claimed and processed by setTimeout or another polling worker
        continue;
      }

      if (doc.chatId && Array.isArray(doc.messageIds)) {
        await deleteTelegramMessages(doc.chatId, doc.messageIds).catch(() => {});

        if (doc.fileOrBatchCode) {
          try {
            const mainBot = await getMainBotUsername();
            const botUsername = mainBot || await getBotUsername();
            const reGetUrl = `https://t.me/${botUsername}?start=${doc.fileOrBatchCode}`;
            const sponsorBtn = await getSponsorButton();
            const kb = {
              inline_keyboard: [
                [{ text: toSmallCaps('♻️ Re-send Files'), callback_data: `user:resend:${doc.fileOrBatchCode}` }],
                [{ text: toSmallCaps('Open in Main Bot'), url: reGetUrl }]
              ]
            };
            if (sponsorBtn) kb.inline_keyboard.push([sponsorBtn]);

            await sendTelegramMessage(
              doc.chatId,
              `🗑️ <b>Files Deleted</b>\n\nYour file(s) have been deleted automatically according to the auto-delete timer.`,
              kb
            );
          } catch {}
        }
      }
    }
  } catch (err) {
    log('error', 'processDueAutoDeletes error', { errorMessage: err.message });
  }
}

export function startAutoDeleteWorker(intervalMs = 30000) {
  if (autoDeleteWorkerRunning) return;
  autoDeleteWorkerRunning = true;
  // Run once immediately upon startup
  processDueAutoDeletes().catch(() => {});
  // Recurring polling with unref to minimize event loop wakeups
  const timer = setInterval(() => {
    processDueAutoDeletes().catch(() => {});
  }, intervalMs);
  timer.unref?.();
}
