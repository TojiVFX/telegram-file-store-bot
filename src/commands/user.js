import {
  getCollection, getSettings, sendTelegramMessage, editTelegramMessage, deleteTelegramMessage, toSmallCaps, getMainToken, esc
} from '../bot-common.js';
import {
  getBotUsername, getDbChannelId, checkSubscription, isBotAdmin, extractChannelMessage, copyIntoDbChannel, copyFromDbChannel, getMainBotUsername, resolveUser, checkChannelsHealth
} from '../bot-helpers.js';
import {
  getBatchSession, setBatchSession, addIdToBatch, clearBatchSession, updateBatchSessionMeta, checkAndClearAdminWaiting, setAdminWaitingForFile, storeFile, generateFileCode,
  generateTempToken, getTempToken, revokeTempToken, listActiveTempTokens, parseDurationString, formatDuration,
  recordVerificationRedeemed, deleteStoredRecord, updateStoredRecordTitle
} from '../filestore.js';
import { handleStartPayload } from './start.js';
import { banUser, unbanUser, getBannedList, getBannedUsers, broadcastToAll, getUserStats, addReferral, hasPremium, getReferralStats, upsertUser, getUserProfile, getTopReferrers } from '../bot-users.js';
import { processAdminMessage } from './admin.js';
import { logActivity } from '../bot-logs.js';

export async function processMessageUpdate(chatId, rawText, message, admin, req) {
  const users = await getCollection('users');
  const sessions = await getCollection('sessions');

  const userExists = await users.findOne({ _id: String(chatId) });
  const isNewUser = !userExists;

  upsertUser(message);

  if (isNewUser) {
    (async () => {
      try {
        const total = await users.countDocuments();
        logActivity({
          eventType: 'new_user_joined',
          userId: chatId,
          username: message.from?.username,
          firstName: message.from?.first_name,
          details: `First-time user interaction (Total Users: ${total})`,
        });
      } catch {}
    })();
  }

  if (admin) {
    const adminRes = await processAdminMessage(chatId, rawText, message, req);
    if (adminRes) return;
  }

  if (/^\/start/i.test(rawText)) {
    const payload = rawText.split(' ')[1];
    if (payload?.startsWith('ref_')) {
      const cs = await getSettings();

      if (cs.referralDisabled !== '1') {
        const referrerId = payload.slice(4);
        if (referrerId !== String(chatId) && isNewUser) {
          const { savePendingReferral } = await import('../bot-users.js');
          await savePendingReferral(referrerId, chatId);
        }
      }
      return handleStartPayload(chatId, null, message, admin);
    }
    if (payload?.startsWith('verify_')) {
      const tkn = payload.slice(7);
      const verifySession = await sessions.findOne({ _id: `verify:tkn:${tkn}` });
      const rawV = verifySession && verifySession.expiresAt > new Date() ? verifySession.val : null;
      if (!rawV) {
        await sendTelegramMessage(chatId, `❌ Link expired.`);
        return;
      }

      if (rawV.creatorChatId && String(rawV.creatorChatId) !== String(chatId)) {
        await sendTelegramMessage(chatId, `❌ <b>Access Denied:</b> This verification link was generated for another user.`);
        return;
      }

      const { payload: originalPayload } = rawV;
      // start.js stores `issuedValidityHours` (with fallback to legacy `validityHours`)
      const rawHours = rawV.issuedValidityHours !== undefined ? rawV.issuedValidityHours : rawV.validityHours;

      // `rawHours` was already normalized by `parseValidityHours()` when
      // the verify link was generated in start.js (0 stays 0, blank/invalid
      // falls back to 24). Here we guard against a missing/odd value
      // before doing arithmetic with it.
      const hours = Number.isFinite(rawHours) ? rawHours : 24;

      // A validity of 0 hours means the admin wants the token to expire
      // immediately, i.e. the user must re-verify on every single request.
      // We still write a session doc (so downstream code that checks for its
      // existence behaves consistently), but its expiresAt is already in the
      // past, so the `expiresAt > new Date()` check used everywhere else
      // will correctly treat it as "no valid token" right away. Mongo's TTL
      // index on `sessions.expiresAt` will also physically clean it up.
      const tokenKey = `user:token:main:${chatId}`;
      const expiresAt = hours > 0
        ? new Date(Date.now() + hours * 3600 * 1000)
        : new Date(Date.now() - 1000);

      await sessions.updateOne(
        { _id: tokenKey },
        { $set: { val: '1', expiresAt } },
        { upsert: true }
      );

      await sessions.deleteOne({ _id: `verify:tkn:${tkn}` });
      recordVerificationRedeemed().catch(() => {});
      await sendTelegramMessage(chatId, `✅ Verified!`);

      logActivity({
        eventType: 'token_verify_success',
        userId: chatId,
        username: message.from?.username,
        firstName: message.from?.first_name,
        targetCode: originalPayload,
        targetType: 'token',
        details: `Shortener token verified successfully (valid ${hours}h)`,
      }).catch(() => {});

      return handleStartPayload(chatId, originalPayload, message, admin);
    }
    return handleStartPayload(chatId, payload, message, admin);
  }

  const canGenerate = admin;

  if (/^\/(bundle|quality)/i.test(rawText) && canGenerate) {
    const customTitle = rawText.replace(/^\/(bundle|quality)/i, '').trim();
    const dbChannelId = await getDbChannelId();
    if (!dbChannelId) {
      const mainBotUsername = await getMainBotUsername();
      const setLink = `https://t.me/${mainBotUsername}?start=setting`;

      await sendTelegramMessage(chatId, `❌ <b>Database Channel not set!</b>\n\nPlease configure your DB Channel ID in the bot settings first.\n\n<a href="${setLink}">⚙️ Open Settings</a>`);
      return;
    }

    if (!(await isBotAdmin(dbChannelId))) {
      const helpMsg = `❌ <b>Permissions Required!</b>\n\nI am not an administrator in the DB channel (<code>${dbChannelId}</code>) or I don't have permission to post messages.\n\n<b>To fix this:</b>\n1. Add this bot as an Admin in your DB channel.\n2. Ensure 'Post Messages' permission is enabled.`;
      await sendTelegramMessage(chatId, helpMsg);
      return;
    }

    const { setBundleSession } = await import('../filestore.js');
    await setBundleSession(chatId, { step: 'collect', qualities: [], title: customTitle || '' });

    const titleNote = customTitle
      ? `📌 <b>Release Title:</b> <code>${esc(customTitle)}</code>\n\n`
      : `📌 <b>Release Title:</b> <i>Not set</i> (type the anime/movie name anytime to set it)\n\n`;

    await sendTelegramMessage(chatId, `🎛 <b>Create Multi-Quality Bundle</b>\n\n${titleNote}Send or forward each video resolution for this release (e.g. 480p, 720p, 1080p).\n\n💡 <i>The bot auto-detects video resolution and file size!</i>\n\nSend /done when finished, or /cancel to abort.`, {
      inline_keyboard: [
        [{ text: toSmallCaps('Finish Bundle'), callback_data: 'admin:bundle_done' }],
        [{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]
      ]
    });
    return;
  }

  if (/^\/bundle/i.test(rawText) && canGenerate) {
    const dbChannelId = await getDbChannelId();
    if (!dbChannelId) {
      const mainBotUsername = await getMainBotUsername();
      const setLink = `https://t.me/${mainBotUsername}?start=setting`;
      await sendTelegramMessage(chatId, `❌ <b>Database Channel not set!</b>\n\nPlease configure your DB Channel ID in the bot settings first.\n\n<a href="${setLink}">⚙️ Open Settings</a>`);
      return;
    }

    if (!(await isBotAdmin(dbChannelId))) {
      const helpMsg = `❌ <b>Permissions Required!</b>\n\nI am not an administrator in the DB channel (<code>${dbChannelId}</code>) or I don't have permission to post messages.\n\n<b>To fix this:</b>\n1. Add this bot as an Admin in your DB channel.\n2. Ensure 'Post Messages' permission is enabled.`;
      await sendTelegramMessage(chatId, helpMsg);
      return;
    }

    const { extractChannelMessageRange, extractChannelMessage } = await import('../bot-helpers.js');

    // 1. Check if user sent range directly with command: /bundle <link1> <link2>
    const range = await extractChannelMessageRange(rawText);
    if (range) {
      const { processBundleRange } = await import('../commands/admin.js');
      await processBundleRange(chatId, range, null, '', { userId: chatId, username: message.from?.username, firstName: message.from?.first_name });
      return;
    }

    // 2. Check if user sent single first link with command: /bundle <link1>
    const { setBundleSession } = await import('../filestore.js');
    const single = await extractChannelMessage(message);

    if (single) {
      const promptMsg = await sendTelegramMessage(chatId, `🎛 <b>Create Multi-Quality Bundle</b>\n\n` +
        `✅ <b>First Message Saved:</b> <code>#${single.msgId}</code>\n\n` +
        `Now send the <b>target message link</b> (or forward the last video):\n` +
        `Example: <code>https://t.me/c/.../${single.msgId + 2}</code>`, {
        inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
      });

      await setBundleSession(chatId, {
        step: 'last',
        srcChannelId: single.channelId,
        srcFirstMsgId: single.msgId,
        qualities: [],
        title: '',
        sessionMsgId: promptMsg?.result?.message_id
      });
      return;
    }

    // 3. Plain /bundle interactive start:
    const promptMsg = await sendTelegramMessage(chatId, `🎛 <b>Create Multi-Quality Bundle</b>\n\n` +
      `Send the <b>first message link</b> (or forward the first video):\n` +
      `Example: <code>https://t.me/c/1234567890/101</code>\n\n` +
      `<i>💡 You can also send both links together:</i>\n` +
      `<code>https://t.me/c/.../101 https://t.me/c/.../104</code>`, {
      inline_keyboard: [
        [{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]
      ]
    });

    await setBundleSession(chatId, {
      step: 'first',
      qualities: [],
      title: '',
      sessionMsgId: promptMsg?.result?.message_id
    });
    return;
  }

  if (/^\/batch/i.test(rawText) && canGenerate) {
    const dbChannelId = await getDbChannelId();
    if (!dbChannelId) {
      const mainBotUsername = await getMainBotUsername();
      const setLink = `https://t.me/${mainBotUsername}?start=setting`;

      await sendTelegramMessage(chatId, `❌ <b>Database Channel not set!</b>\n\nPlease configure your DB Channel ID in the bot settings first.\n\n<a href="${setLink}">⚙️ Open Settings</a>`);
      return;
    }

    if (!(await isBotAdmin(dbChannelId))) {
      const mainBotUsername = await getMainBotUsername();
      const helpMsg = `❌ <b>Permissions Required!</b>\n\nI am not an administrator in the DB channel (<code>${dbChannelId}</code>) or I don't have permission to post messages.\n\n<b>To fix this:</b>\n1. Add this bot as an Admin in your DB channel.\n2. Ensure 'Post Messages' permission is enabled.`;
      await sendTelegramMessage(chatId, helpMsg);
      return;
    }

    await setBatchSession(chatId, { step: 'first', collectedIds: [] });
    await sendTelegramMessage(chatId, `📦 <b>Batch Mode</b>\n\nForward the first message or start sending files.`);
    return;
  }

  if (/^\/store/i.test(rawText) && canGenerate) {
    const dbChannelId = await getDbChannelId();
    if (!dbChannelId) {
       const mainBotUsername = await getMainBotUsername();
       const setLink = `https://t.me/${mainBotUsername}?start=setting`;

       await sendTelegramMessage(chatId, `❌ <b>Database Channel not set!</b>\n\nPlease configure your DB Channel ID in the bot settings first.\n\n<a href="${setLink}">⚙️ Open Settings</a>`);
       return;
    }

    if (!(await isBotAdmin(dbChannelId))) {
      const mainBotUsername = await getMainBotUsername();
      const helpMsg = `❌ <b>Permissions Required!</b>\n\nI am not an administrator in the DB channel (<code>${dbChannelId}</code>) or I don't have permission to post messages.\n\n<b>To fix this:</b>\n1. Add this bot as an Admin in your DB channel.\n2. Ensure 'Post Messages' permission is enabled.`;
      await sendTelegramMessage(chatId, helpMsg);
      return;
    }

    await setAdminWaitingForFile(chatId);
    await sendTelegramMessage(chatId, `📁 Send the file to store.`);
    return;
  }

  if (/^\/cancel/i.test(rawText) && admin) {
    const { clearBundleSession } = await import('../filestore.js');
    await clearBatchSession(chatId);
    await clearBundleSession(chatId);
    await checkAndClearAdminWaiting(chatId);
    await sendTelegramMessage(chatId, `✅ Cancelled.`);
    return;
  }

  if (/^\/userstats/i.test(rawText) && admin) {
    const s = await getUserStats();
    const { getDownloadActivity } = await import('../filestore.js');
    const activity = await getDownloadActivity(7);

    let chart = '';
    if (activity.length > 0) {
      const maxCount = Math.max(...activity.map(d => d.count), 1);
      const barWidth = 8;
      chart = `\n\n<b>Download Activity (Last 7 Days)</b>\n\n`;
      for (const day of activity) {
        const filled = Math.round((day.count / maxCount) * barWidth);
        const bar = '▓'.repeat(filled) + '░'.repeat(barWidth - filled);
        chart += `${day.label} ${bar} <b>${day.count}</b>\n`;
      }
    }

    await sendTelegramMessage(chatId, `📊 <b>Stats</b>\n\nUsers: <b>${s.totalUsers}</b>\nBanned: <b>${s.bannedCount}</b>\nActive Today: <b>${s.todayActive}</b>\nStored Links: <b>${s.filestoreLinks}</b>\nChannels: <b>${s.filestoreChannels}</b>${chart}`);
    return;
  }

  if (/^\/(backup|exportdb)/i.test(rawText) && admin) {
    const { sendTelegramFileBuffer } = await import('../bot-common.js');
    const filesColl = await getCollection('files');
    const allFiles = await filesColl.find({}).toArray();

    const jsonStr = JSON.stringify(allFiles, null, 2);
    const buffer = Buffer.from(jsonStr, 'utf-8');
    const filename = `filestore_backup_${new Date().toISOString().slice(0, 10)}.json`;
    const caption = `💾 <b>Database Backup</b>\n\nTotal Stored Records: <b>${allFiles.length}</b>\nSize: <b>${(buffer.length / 1024).toFixed(2)} KB</b>`;

    await sendTelegramFileBuffer(chatId, buffer, filename, caption);
    return;
  }

  if (/^\/topfiles/i.test(rawText) && admin) {
    const { getTopFiles, getDailyFileStats } = await import('../filestore.js');
    const [topList, daily] = await Promise.all([getTopFiles(10), getDailyFileStats()]);
    const botUsername = await getBotUsername();

    let header = `📊 <b>Traffic Dashboard</b>\n\n` +
      `<b>Today</b>\n` +
      `• Links Created: <b>${daily.createdToday}</b>\n` +
      `• Downloads: <b>${daily.downloadsToday}</b>\n\n` +
      `<b>All Time</b>\n` +
      `• Total Links: <b>${daily.totalLinks}</b>\n` +
      `• Total Downloads: <b>${daily.allTimeDownloads}</b>\n`;

    if (!topList.length) {
      await sendTelegramMessage(chatId, header + `\n<i>No downloads recorded yet.</i>`);
      return;
    }

    let report = header + `\n<b>Top 10 Most Downloaded</b>\n\n`;
    for (let i = 0; i < topList.length; i++) {
      const item = topList[i];
      const link = `https://t.me/${botUsername}?start=${item._id}`;
      report += `<b>${i + 1}.</b> <code>${item._id}</code> (${item.type || 'file'})\n` +
                `   📥 Downloads: <b>${item.accessCount || 0}</b>\n` +
                `   🔗 ${link}\n\n`;
    }

    await sendTelegramMessage(chatId, report, {
      inline_keyboard: [
        [{ text: toSmallCaps("Today's Links"), callback_data: 'admin:today_links' }]
      ]
    });
    return;
  }

  if (/^\/todaylinks/i.test(rawText) && admin) {
    const { getTodayFiles } = await import('../filestore.js');
    const todayFiles = await getTodayFiles();
    const botUsername = await getBotUsername();

    if (!todayFiles.length) {
      await sendTelegramMessage(chatId, `<b>Links Created Today</b>\n\n<i>No links have been created today yet.</i>`);
      return;
    }

    const displayLimit = 20;
    const slice = todayFiles.slice(0, displayLimit);
    let report = `<b>Links Created Today (${todayFiles.length})</b>\n\n`;
    for (let i = 0; i < slice.length; i++) {
      const item = slice[i];
      const link = `https://t.me/${botUsername}?start=${item._id}`;
      report += `<b>${i + 1}.</b> <code>${item._id}</code> (${item.type || 'file'})\n` +
                `   • Downloads: <b>${item.accessCount || 0}</b>\n` +
                `   • Link: ${link}\n\n`;
    }
    if (todayFiles.length > displayLimit) {
      report += `<i>Showing first ${displayLimit} of ${todayFiles.length} links. Export all as .txt or copy text below:</i>`;
    }

    await sendTelegramMessage(chatId, report, {
      inline_keyboard: [
        [{ text: toSmallCaps('Copy All Links (Text)'), callback_data: 'admin:today_copy_text' }, { text: toSmallCaps('Export Today (.txt)'), callback_data: 'admin:export_today_txt' }]
      ]
    });
    return;
  }

  if (/^\/bulkstore/i.test(rawText) && admin) {
    const { getDbChannelReadinessError } = await import('../bot-helpers.js');
    const dbError = await getDbChannelReadinessError();
    if (dbError) {
      await sendTelegramMessage(chatId, dbError);
      return;
    }

    const { setBulkStoreActive, clearStoreSession } = await import('../filestore.js');
    await clearStoreSession(chatId);
    await setBulkStoreActive(chatId, true);

    const text = `📦 <b>Bulk Store Mode Active</b>\n\n` +
      `Forward or send files (documents, videos, audio, photos) one by one.\n` +
      `Each file will be stored automatically, and you will get <b>all links in one copyable list</b> and as a <b>.txt document</b> when finished.\n\n` +
      `When done, tap <b>Done & Get All Links</b> or send /done.\nSend /cancel to abort.`;

    await sendTelegramMessage(chatId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Done & Get All Links (0)'), callback_data: 'admin:bulk_store_done' }],
        [{ text: toSmallCaps('Cancel'), callback_data: 'admin:bulk_store_cancel' }]
      ]
    });
    return;
  }

  if (/^\/exportlinks/i.test(rawText) && admin) {
    const parts = rawText.trim().split(/\s+/).slice(1);
    const { getExportLinksKeyboard } = await import('../bot-helpers.js');

    if (parts.length === 0) {
      const text = `📄 <b>Export Links Hub</b>\n\nSelect a time duration or category to export links as a <b>.txt</b> document and get a 1-tap copyable text block:\n\nYou can also run directly with arguments:\n• <code>/exportlinks 15m</code>\n• <code>/exportlinks 30m batch</code>\n• <code>/exportlinks 1h</code>\n• <code>/exportlinks today</code>`;
      await sendTelegramMessage(chatId, text, getExportLinksKeyboard());
      return;
    }

    const argStr = parts.join(' ').toLowerCase();
    const isToday = /\btoday\b/i.test(argStr);
    const isAll = /\ball\b/i.test(argStr);
    const isBatchOnly = /\b(batch|batches)\b/i.test(argStr);
    const isFileOnly = /\b(file|files)\b/i.test(argStr);
    const filterType = isBatchOnly ? 'batch' : isFileOnly ? 'media' : 'all';

    const { getTodayFiles, getFilesWithinDuration, generateLinksExportText, generateRawLinksText, formatDurationLabel, parseDurationString } = await import('../filestore.js');
    const { sendTelegramFileBuffer } = await import('../bot-common.js');
    const botUsername = await getBotUsername();

    if (isToday) {
      const todayFiles = await getTodayFiles();
      const filtered = isBatchOnly ? todayFiles.filter(f => f.type === 'batch') : isFileOnly ? todayFiles.filter(f => f.type !== 'batch') : todayFiles;
      if (!filtered.length) {
        await sendTelegramMessage(chatId, `⚠️ <i>No ${isBatchOnly ? 'batches' : 'links'} created today.</i>`);
        return;
      }
      const title = `Today's ${isBatchOnly ? 'Batches' : 'Links'}`;
      const txtContent = generateLinksExportText(filtered, botUsername, title);
      const buffer = Buffer.from(txtContent, 'utf-8');
      const filename = `filestore_today_${filterType}_${new Date().toISOString().slice(0, 10)}.txt`;

      if (filtered.length <= 30) {
        const rawBlock = generateRawLinksText(filtered, botUsername);
        await sendTelegramMessage(chatId, `📋 <b>${title} (${filtered.length})</b>\n\nTap box to copy all links:\n<pre>${rawBlock}</pre>`);
      }

      await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>${title} Export</b> (${filtered.length} records)`);
      return;
    }

    if (isAll) {
      const filesColl = await getCollection('files');
      const query = {};
      if (filterType !== 'all') query.type = filterType;
      const allFiles = await filesColl.find(query).sort({ createdAt: -1 }).toArray();
      if (!allFiles.length) {
        await sendTelegramMessage(chatId, `⚠️ <i>No stored records found in database.</i>`);
        return;
      }
      const title = `All Stored ${isBatchOnly ? 'Batches' : 'Links'}`;
      const txtContent = generateLinksExportText(allFiles, botUsername, title);
      const buffer = Buffer.from(txtContent, 'utf-8');
      const filename = `filestore_all_${filterType}_${new Date().toISOString().slice(0, 10)}.txt`;
      await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>${title} Export</b> (${allFiles.length} records)`);
      return;
    }

    // Parse time duration (e.g. 15m, 30m, 1h, 120, 2h)
    const cleanDuration = argStr.replace(/\b(batch|batches|files|file)\b/g, '').trim();
    let seconds = parseDurationString(cleanDuration);
    if (!seconds && /^\d+$/.test(cleanDuration)) {
      seconds = parseInt(cleanDuration, 10) * 60;
    }

    if (!seconds || seconds <= 0) {
      await sendTelegramMessage(chatId, `❌ <b>Invalid time parameter!</b>\n\n<b>Usage Examples:</b>\n• <code>/exportlinks 15m</code> (last 15 minutes)\n• <code>/exportlinks 30m batch</code> (last 30 minutes, batches only)\n• <code>/exportlinks 1h</code> (last 1 hour)\n• <code>/exportlinks today</code> (today's links)\n• <code>/exportlinks all</code> (entire database)`);
      return;
    }

    const records = await getFilesWithinDuration(seconds, filterType);
    const durationLabel = formatDurationLabel(seconds);
    const typeLabel = isBatchOnly ? 'Batches' : isFileOnly ? 'Single Files' : 'Links';

    if (!records.length) {
      await sendTelegramMessage(chatId, `⚠️ <i>No ${typeLabel.toLowerCase()} found created within the last ${durationLabel}.</i>`);
      return;
    }

    const title = `${typeLabel} in Last ${durationLabel}`;
    const txtContent = generateLinksExportText(records, botUsername, title);
    const buffer = Buffer.from(txtContent, 'utf-8');
    const filename = `filestore_${filterType}_${Math.round(seconds / 60)}m_${new Date().toISOString().slice(0, 10)}.txt`;

    if (records.length <= 30) {
      const rawBlock = generateRawLinksText(records, botUsername);
      await sendTelegramMessage(chatId, `📋 <b>${title} (${records.length})</b>\n\nTap box to copy all links at once:\n<pre>${rawBlock}</pre>`);
    }

    await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>${title}</b> (${records.length} records)`);
    return;
  }

  if (/^\/broadcast\s+/i.test(rawText) && admin) {
    const t = rawText.split(/\s+/).slice(1).join(' ');
    const { getUserStats } = await import('../bot-users.js');
    const s = await getUserStats();

    await sessions.updateOne(
      { _id: `admin:broadcast_draft:${chatId}` },
      {
        $set: {
          text: t,
          captionOrText: t,
          fromChatId: chatId,
          messageId: message.message_id,
          expiresAt: new Date(Date.now() + 600 * 1000)
        }
      },
      { upsert: true }
    );

    const previewCard = `📢 <b>Broadcast Preview</b>\n\n` +
      `<b>Target Audience:</b> <b>${s.totalUsers}</b> registered users\n\n` +
      `<b>Message Content:</b>\n` +
      `────────────────────\n` +
      `${t}\n` +
      `────────────────────\n\n` +
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
    return;
  }

  if (/^\/backup/i.test(rawText) && admin) {
    const statusMsg = await sendTelegramMessage(chatId, `⏳ <i>Generating full database backup...</i>`);
    try {
      const { sendDatabaseBackup } = await import('../bot-helpers.js');
      const sendRes = await sendDatabaseBackup(chatId);
      if (statusMsg?.ok && statusMsg?.messageId) {
        await deleteTelegramMessage(chatId, statusMsg.messageId).catch(() => {});
      }
      if (!sendRes?.ok) {
        await sendTelegramMessage(chatId, `❌ <b>Failed to send database backup:</b> ${sendRes?.reason || 'Unknown error'}`);
      }
    } catch (err) {
      await sendTelegramMessage(chatId, `❌ <b>Database backup failed:</b> ${err.message}`);
    }
    return;
  }

  if (/^\/ban(\s+|$)/i.test(rawText) && admin) {
    let targetArg = null;
    let durationArg = null;
    let reasonArg = null;

    const parts = rawText.trim().split(/\s+/).slice(1);
    const replyUser = message.reply_to_message?.from || message.reply_to_message?.forward_from;

    if (replyUser && (!parts.length || (!/^\d+$/.test(parts[0]) && !parts[0].startsWith('@')))) {
      targetArg = String(replyUser.id);
      if (parts.length > 0) {
        const potentialDuration = parseDurationString(parts[0]);
        if (potentialDuration !== null) {
          durationArg = potentialDuration;
          if (parts.length > 1) reasonArg = parts.slice(1).join(' ');
        } else {
          reasonArg = parts.join(' ');
        }
      }
    } else if (parts.length > 0) {
      targetArg = parts[0];
      if (parts.length > 1) {
        const potentialDuration = parseDurationString(parts[1]);
        if (potentialDuration !== null) {
          durationArg = potentialDuration;
          if (parts.length > 2) reasonArg = parts.slice(2).join(' ');
        } else {
          reasonArg = parts.slice(1).join(' ');
        }
      }
    }

    if (!targetArg) {
      await sendTelegramMessage(chatId, `❌ <b>Usage:</b>\n• <code>/ban &lt;user_id|@username&gt; [duration] [reason]</code>\n• Reply to a message with <code>/ban [duration] [reason]</code>\n\nExample: <code>/ban @spammer 24h spamming</code>`);
      return;
    }

    const targetId = await resolveUser(targetArg);
    if (!targetId) {
      await sendTelegramMessage(chatId, `❌ Could not resolve user <code>${esc(targetArg)}</code>.`);
      return;
    }

    await banUser(targetId, durationArg, reasonArg, chatId);
    const durLabel = durationArg ? formatDuration(durationArg) : 'Permanent';
    let text = `✅ User <code>${targetId}</code> has been banned.\nDuration: <b>${durLabel}</b>`;
    if (reasonArg) text += `\nReason: <code>${esc(reasonArg)}</code>`;

    await sendTelegramMessage(chatId, text, {
      inline_keyboard: [[{ text: `🔓 Unban`, callback_data: `admin:unban:${targetId}` }]]
    });
    return;
  }

  if (/^\/unban(\s+|$)/i.test(rawText) && admin) {
    const parts = rawText.trim().split(/\s+/).slice(1);
    const replyUser = message.reply_to_message?.from || message.reply_to_message?.forward_from;
    let targetArg = null;

    if (parts.length > 0) {
      targetArg = parts[0];
    } else if (replyUser) {
      targetArg = String(replyUser.id);
    }

    if (!targetArg) {
      await sendTelegramMessage(chatId, `❌ <b>Usage:</b>\n• <code>/unban &lt;user_id|@username&gt;</code>\n• Reply to a message with <code>/unban</code>`);
      return;
    }

    const targetId = await resolveUser(targetArg);
    if (!targetId) {
      await sendTelegramMessage(chatId, `❌ Could not resolve user <code>${esc(targetArg)}</code>.`);
      return;
    }

    await unbanUser(targetId);
    await sendTelegramMessage(chatId, `✅ User <code>${targetId}</code> has been unbanned.`);
    return;
  }

  if (/^\/banlist/i.test(rawText) && admin) {
    const list = await getBannedUsers();
    if (!list.length) {
      await sendTelegramMessage(chatId, `No banned users.`);
      return;
    }
    const maxShow = 15;
    const displayList = list.slice(0, maxShow);
    const now = Date.now();

    let banText = `🚫 <b>Banned Users (${list.length}):</b>\n\n`;
    const buttons = [];

    for (const u of displayList) {
      let expiryStr = 'Permanent';
      if (u.bannedUntil) {
        const remSec = Math.max(0, Math.round((new Date(u.bannedUntil).getTime() - now) / 1000));
        expiryStr = remSec < 60 ? `${remSec}s left` : remSec < 3600 ? `${Math.round(remSec / 60)}m left` : `${Math.round(remSec / 3600)}h left`;
      }
      banText += `• <code>${u._id}</code> ${u.username ? `(@${esc(u.username)})` : ''}\n`;
      banText += `  └ <i>${expiryStr}</i>${u.banReason ? ` • Reason: <code>${esc(u.banReason)}</code>` : ''}\n`;

      buttons.push([{
        text: `🔓 Unban ${u.username ? '@' + u.username : u._id}`,
        callback_data: `admin:unban:${u._id}`
      }]);
    }

    if (list.length > maxShow) {
      banText += `\n<i>...and ${list.length - maxShow} more banned users.</i>`;
    }

    await sendTelegramMessage(chatId, banText, { inline_keyboard: buttons });
    return;
  }

  if (/^\/user(\s+|$)/i.test(rawText) && admin) {
    const parts = rawText.trim().split(/\s+/).slice(1);
    const replyUser = message.reply_to_message?.from || message.reply_to_message?.forward_from;
    const targetArg = parts[0] || (replyUser ? String(replyUser.id) : null);

    if (!targetArg) {
      await sendTelegramMessage(chatId, `❌ <b>Usage:</b>\n• <code>/user &lt;id|@username&gt;</code>\n• Reply to any user message with <code>/user</code>`);
      return;
    }

    const profile = await getUserProfile(targetArg);
    if (!profile) {
      await sendTelegramMessage(chatId, `❌ User not found in database for <code>${esc(targetArg)}</code>.`);
      return;
    }

    const profileText = `👤 <b>User Profile Inspection</b>\n\n` +
      `• <b>User ID:</b> <code>${profile.userId}</code>\n` +
      `• <b>Username:</b> ${profile.username}\n` +
      `• <b>Name:</b> <b>${esc(profile.fullName)}</b>\n` +
      `• <b>Joined At:</b> <code>${profile.joinedAt}</code>\n` +
      `• <b>Last Seen:</b> <code>${profile.lastSeen}</code>\n` +
      `• <b>Account Status:</b> <b>${profile.banStatus}</b>\n` +
      `• <b>Premium:</b> <b>${profile.premiumStatus}</b>\n` +
      `• <b>Referrals Count:</b> <b>${profile.referralCount}</b>\n` +
      `• <b>Referred By:</b> <code>${profile.referrerId}</code>`;

    const buttons = [];
    if (profile.isBanned) {
      buttons.push([{ text: `🔓 Unban User`, callback_data: `admin:unban:${profile.userId}` }]);
    } else {
      buttons.push([{ text: `🚫 Ban User`, callback_data: `admin:ban_prompt` }]);
    }

    await sendTelegramMessage(chatId, profileText, { inline_keyboard: buttons });
    return;
  }

  if (/^\/toprefs/i.test(rawText)) {
    const leaders = await getTopReferrers(10);
    if (!leaders.length) {
      await sendTelegramMessage(chatId, `🏆 <b>Referral Leaderboard</b>\n\nNo referral data available yet.`);
      return;
    }

    let text = `🏆 <b>Viral Referral Leaderboard (Top 10)</b>\n\n`;
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

    leaders.forEach((u, idx) => {
      const medal = medals[idx] || `${idx + 1}.`;
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : `User ${u._id}`);
      text += `${medal} <b>${esc(name)}</b> — <b>${u.referralCount || 0}</b> referrals\n`;
      text += `   └ ID: <code>${u._id}</code>\n`;
    });

    text += `\n<i>Share your referral link using /me to climb the leaderboard!</i>`;
    await sendTelegramMessage(chatId, text);
    return;
  }

  if (/^\/delete\s+(\S+)/i.test(rawText) && admin) {
    const code = rawText.match(/^\/delete\s+(\S+)/i)[1].trim();
    const delRes = await deleteStoredRecord(code);
    if (!delRes.ok) {
      await sendTelegramMessage(chatId, `❌ Record <code>${esc(code)}</code> not found or could not be deleted.`);
      return;
    }
    await sendTelegramMessage(chatId, `🗑 <b>Record Deleted Successfully!</b>\n\n• Code: <code>${esc(delRes.code)}</code>\n• Type: <b>${delRes.type}</b>\n• Title: <b>${esc(delRes.title)}</b>\n\n<i>Database record and channel messages have been purged.</i>`);
    return;
  }

  if (/^\/(editfile|rename)\s+(\S+)\s+(.+)/i.test(rawText) && admin) {
    const match = rawText.match(/^\/(editfile|rename)\s+(\S+)\s+(.+)/i);
    const code = match[2].trim();
    const newTitle = match[3].trim();

    const editRes = await updateStoredRecordTitle(code, newTitle);
    if (!editRes.ok) {
      await sendTelegramMessage(chatId, `❌ Record <code>${esc(code)}</code> not found or update failed.`);
      return;
    }
    await sendTelegramMessage(chatId, `✏️ <b>Record Title Updated!</b>\n\n• Code: <code>${esc(editRes.code)}</code>\n• Type: <b>${editRes.type}</b>\n• Old Title: <s>${esc(editRes.oldTitle)}</s>\n• New Title: <b>${esc(editRes.newTitle)}</b>`);
    return;
  }

  if (/^\/checkchannels/i.test(rawText) && admin) {
    const statusMsg = await sendTelegramMessage(chatId, `🔍 <i>Running diagnostic health check on all channels...</i>`);
    const diag = await checkChannelsHealth();

    if (statusMsg?.ok && statusMsg?.messageId) {
      await deleteTelegramMessage(chatId, statusMsg.messageId).catch(() => {});
    }

    let report = `📡 <b>Channel Health Diagnostics</b>\n\n`;

    report += `📦 <b>Storage Channels:</b>\n`;
    if (diag.db.primary) {
      const icon = diag.db.primary.isOk ? '🟢' : '🔴';
      report += `${icon} <b>Primary DB:</b> <code>${diag.db.primary.id}</code> (${esc(diag.db.primary.title)})\n`;
      if (!diag.db.primary.isOk) report += `   └ ⚠️ <i>${esc(diag.db.primary.error || 'Error')}</i>\n`;
    } else {
      report += `⚪ <b>Primary DB:</b> <i>Not configured</i>\n`;
    }

    if (diag.db.backup) {
      const icon = diag.db.backup.isOk ? '🟢' : '🔴';
      report += `${icon} <b>Backup DB:</b> <code>${diag.db.backup.id}</code> (${esc(diag.db.backup.title)})\n`;
      if (!diag.db.backup.isOk) report += `   └ ⚠️ <i>${esc(diag.db.backup.error || 'Error')}</i>\n`;
    } else {
      report += `⚪ <b>Backup DB:</b> <i>Not configured</i>\n`;
    }

    report += `\n📢 <b>Force-Subscribe Channels (${diag.fsub.length}):</b>\n`;
    if (!diag.fsub.length) {
      report += `<i>No force-subscribe channels configured.</i>\n`;
    } else {
      for (const f of diag.fsub) {
        const icon = f.isOk ? '🟢' : '🔴';
        report += `${icon} <b>${esc(f.title)}</b> (<code>${f.id}</code>) [${f.mode}]\n`;
        if (!f.isOk) report += `   └ ⚠️ <i>${esc(f.error || 'Error')}</i>\n`;
      }
    }

    await sendTelegramMessage(chatId, report, {
      inline_keyboard: [
        [{ text: toSmallCaps('Open Settings'), callback_data: 'admin:fs_settings' }]
      ]
    });
    return;
  }

  if (/^\/rebuildchannel/i.test(rawText) && admin) {
    const parts = rawText.trim().split(/\s+/);
    const targetChannelRaw = parts[1];

    if (!targetChannelRaw) {
      const guideText = `🛠 <b>One-Click Channel Rebuilder</b>\n\n` +
        `This tool automatically recovers files from Telegram's cloud CDN using cached File IDs and re-uploads them into a new DB Storage channel, updating all database records without breaking existing user links!\n\n` +
        `<b>Usage:</b>\n` +
        `<code>/rebuildchannel &lt;new_channel_id&gt;</code>\n\n` +
        `<b>Example:</b>\n` +
        `<code>/rebuildchannel -1001234567890</code>\n\n` +
        `<b>Requirements:</b>\n` +
        `1. Create a new private Telegram channel.\n` +
        `2. Add this bot as an <b>Administrator</b> with 'Post Messages' permission.\n` +
        `3. Obtain the Channel ID.\n` +
        `4. Run the command above.`;

      await sendTelegramMessage(chatId, guideText, {
        inline_keyboard: [
          [{ text: toSmallCaps('Storage & Backup Audit'), callback_data: 'admin:storage_audit' }]
        ]
      });
      return;
    }

    const targetChannelId = Number(targetChannelRaw);
    if (isNaN(targetChannelId) || !targetChannelRaw.startsWith('-100')) {
      await sendTelegramMessage(chatId, `❌ <b>Invalid Channel ID!</b>\n\nPlease provide a valid Telegram supergroup/channel ID starting with <code>-100</code> (e.g. <code>-1001234567890</code>).`);
      return;
    }

    const isBotAdminInTarget = await isBotAdmin(targetChannelId);
    if (!isBotAdminInTarget) {
      await sendTelegramMessage(chatId, `❌ <b>Bot is not an Admin!</b>\n\nThe bot must be added to channel <code>${targetChannelId}</code> as an <b>Administrator</b> with permissions to post messages before rebuilding.`);
      return;
    }

    const statusMsg = await sendTelegramMessage(chatId, `🔄 <b>Rebuilding Channel Storage...</b>\n\nTarget Channel: <code>${targetChannelId}</code>\n<i>Scanning database files...</i>`);
    const statusMsgId = statusMsg?.result?.message_id || statusMsg?.messageId;

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
          `Target Channel: <code>${targetChannelId}</code>\n` +
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

    const { rebuildChannelStorage } = await import('../filestore.js');
    const result = await rebuildChannelStorage(targetChannelId, onProgress);

    if (!result?.ok) {
      await sendTelegramMessage(chatId, `❌ <b>Rebuild failed:</b> ${result?.reason || 'Unknown error'}`);
      return;
    }

    const { updateSettings } = await import('../bot-common.js');
    await updateSettings({ dbChannelId: String(targetChannelId) });

    const summaryText = `🎉 <b>Channel Rebuild Complete!</b>\n\n` +
      `• Target Channel: <code>${targetChannelId}</code>\n` +
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
    return;
  }

  if (/^\/me$/i.test(rawText.trim())) {
    const cs = await getSettings();
    const botUsername = await getBotUsername();
    const { getReferralStats, hasPremium } = await import('../bot-users.js');
    const refs = await getReferralStats(chatId);
    const premium = await hasPremium(chatId);
    let premiumText = 'Standard';
    if (premium) {
      const users = await getCollection('users');
      const user = await users.findOne({ _id: String(chatId) });
      const globalTtl = user && user.premiumUntil ? Math.round((new Date(user.premiumUntil).getTime() - Date.now()) / 1000) : 0;
      premiumText = `Premium (${globalTtl > 0 ? Math.ceil(globalTtl / (24 * 3600)) : 'Lifetime'} days left)`;
    }
    const refLink = `https://t.me/${botUsername}?start=ref_${chatId}`;
    const text = `<b>Your Profile</b>\n\nID: <code>${chatId}</code>\nStatus: <b>${premiumText}</b>\nReferrals: <b>${refs}</b>\n\n🔗 <b>Your Referral Link:</b>\n<code>${refLink}</code>\n\n<i>Share this link to earn Premium access! 3 referrals = 24h Premium.</i>`;

    if (cs?.bannerProfile) {
      const { sendTelegramPhoto } = await import('../bot-common.js');
      await sendTelegramPhoto(chatId, cs.bannerProfile, text);
    } else {
      await sendTelegramMessage(chatId, text);
    }
    return;
  }

  if (/^\/setting/i.test(rawText) && admin) {
    const { getAdminDashboardKeyboard } = await import('../bot-helpers.js');
    const text = `<b>Admin Dashboard</b>\n\nSelect a category to manage the bot:`;
    await sendTelegramMessage(chatId, text, getAdminDashboardKeyboard());
    return;
  }

  if (/^\/adminhelp/i.test(rawText) && admin) {
    let helpText = `<b>Admin Dashboard</b>\n\nYou can manage all bot features through the interactive dashboard. Click the button below to open it.`;
    let kb = { inline_keyboard: [[{ text: toSmallCaps('Open Dashboard'), callback_data: 'admin:dashboard' }]] };
    await sendTelegramMessage(chatId, helpText, kb);
    return;
  }
  if (/^\/status/i.test(rawText) && admin) {
    const statusMsg = await sendTelegramMessage(chatId, `🔍 <b>Checking system health...</b>`);

    const { getWebhookInfo, pingDatabase, checkShortenerHealth, formatUptime } = await import('../bot-helpers.js');

    const [webhook, dbPing, settings] = await Promise.all([
      getWebhookInfo(),
      pingDatabase(),
      getSettings(),
    ]);

    // Webhook status
    const whUrl = webhook.url || 'Not set';
    const whActive = webhook.url ? '✅ Active' : '❌ Not Set';
    const whPending = webhook.pending_update_count ?? 0;
    const whLastError = webhook.last_error_message ? `\n   ⚠️ Last Error: <i>${esc(webhook.last_error_message)}</i>` : '';

    // DB Status
    const dbIcon = dbPing.ok ? '✅' : '❌';
    const dbLabel = dbPing.mock ? 'In-Memory (Mock)' : (dbPing.ok ? `Connected (${dbPing.latency}ms)` : `Disconnected — ${dbPing.error || 'Unknown'}`);

    // Shorteners (check in parallel)
    const [primaryHealth, backupHealth] = await Promise.all([
      checkShortenerHealth(settings?.shortenerUrl, settings?.shortenerKey),
      checkShortenerHealth(settings?.backupShortenerUrl, settings?.backupShortenerKey),
    ]);

    function shortenerLabel(h) {
      if (h.status === 'not_configured') return '⚪ Not Configured';
      if (h.status === 'online') return `✅ Online (${h.latency}ms)`;
      if (h.status === 'error') return `⚠️ Error (HTTP ${h.httpStatus})`;
      return `❌ Offline`;
    }

    // Uptime + Memory
    const uptime = formatUptime(process.uptime());
    const mem = process.memoryUsage();
    const memUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
    const rssMB = (mem.rss / 1024 / 1024).toFixed(1);

    // File stats
    const filesColl = await getCollection('files');
    const totalFiles = await filesColl.countDocuments();
    const recentlyAccessed = await filesColl.countDocuments({
      lastAccessedAt: { $exists: true, $gte: new Date(Date.now() - 24 * 3600 * 1000).toISOString() }
    });

    const text = `🩺 <b>System Health Monitor</b>\n\n` +
      `<b>Webhook</b>\n` +
      `• Status: ${whActive}\n` +
      `• Pending Updates: <b>${whPending}</b>${whLastError}\n\n` +
      `<b>Database</b>\n` +
      `• Connection: ${dbIcon} <b>${dbLabel}</b>\n` +
      `• Total Stored Files: <b>${totalFiles}</b>\n` +
      `• Accessed (24h): <b>${recentlyAccessed}</b>\n\n` +
      `<b>Shortener Services</b>\n` +
      `• Primary: ${shortenerLabel(primaryHealth)}\n` +
      `• Backup: ${shortenerLabel(backupHealth)}\n\n` +
      `<b>Server</b>\n` +
      `• Uptime: <b>${uptime}</b>\n` +
      `• Memory: <b>${memUsedMB} MB</b> (RSS: ${rssMB} MB)\n` +
      `• Node: <b>${process.version}</b>\n` +
      `• Platform: <b>${process.platform} ${process.arch}</b>`;

    if (statusMsg.ok) {
      await editTelegramMessage(chatId, statusMsg.messageId, text);
    }
    return;
  }

  if (/^\/auditlinks/i.test(rawText) && admin) {
    const { renderStorageAudit } = await import('../callbacks/admin-callbacks.js');
    await renderStorageAudit(chatId);
    return;
  }

  if (/^\/scanbroken/i.test(rawText) && admin) {
    const parts = rawText.trim().split(/\s+/);
    const limit = parseInt(parts[1], 10) || 50;

    const { getDbChannelId, getBackupDbChannelId } = await import('../bot-helpers.js');
    const { scanAndRepairBrokenLinks } = await import('../filestore.js');

    const primaryCid = await getDbChannelId();
    const backupCid = await getBackupDbChannelId();

    if (!primaryCid) {
      await sendTelegramMessage(chatId, `❌ <b>Primary DB Channel not configured!</b>`);
      return;
    }

    const statusMsg = await sendTelegramMessage(chatId, `🩺 <b>Scanning stored links... (Limit: ${limit})</b>\nPlease wait.`);

    let lastEdit = Date.now();
    const report = await scanAndRepairBrokenLinks(primaryCid, backupCid, limit, async (curr, total, stats) => {
      if (Date.now() - lastEdit > 3000 || curr === total) {
        lastEdit = Date.now();
        const pct = Math.round((curr / total) * 100);
        const filled = Math.round(pct / 10);
        const bar = '█'.repeat(filled) + '▒'.repeat(10 - filled);
        const progText = `🩺 <b>Scanning stored links...</b>\n\nProgress: <code>${bar}</code> ${pct}% (${curr}/${total})\n• Healthy: <b>${stats.healthy}</b>\n• Auto-Healed: <b>${stats.healed}</b>\n• Dead: <b>${stats.unrecoverable}</b>`;
        if (statusMsg.ok) {
          await editTelegramMessage(chatId, statusMsg.messageId, progText).catch(() => {});
        }
      }
    });

    const finalText = `🩺 <b>Link Health & Auto-Repair Report</b>\n\n` +
      `• Records Scanned: <b>${report.totalScanned}</b>\n` +
      `• Healthy Links: <b>${report.healthy}</b>\n` +
      `• Auto-Healed from Backup: <b>${report.healed}</b> (Restored!)\n` +
      `• Dead / Unrecoverable: <b>${report.unrecoverable}</b>\n\n` +
      (report.healed > 0 ? `<i>✅ ${report.healed} broken links were automatically repaired using your backup channel!</i>` : `<i>All scanned links are currently intact and accessible.</i>`);

    if (statusMsg.ok) {
      await editTelegramMessage(chatId, statusMsg.messageId, finalText, {
        inline_keyboard: [[{ text: toSmallCaps('Storage & Backup Audit'), callback_data: 'admin:storage_audit' }]]
      });
    }
    return;
  }

  if (/^\/ping/i.test(rawText)) {
    const start = Date.now();
    const msg = await sendTelegramMessage(chatId, `Pinging...`);
    if (msg.ok) {
      const latency = Date.now() - start;
      const { pingDatabase, formatUptime } = await import('../bot-helpers.js');
      const dbPing = await pingDatabase();

      const uptime = formatUptime(process.uptime());
      const mem = process.memoryUsage();
      const memUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
      const memTotalMB = (mem.heapTotal / 1024 / 1024).toFixed(1);
      const rssMB = (mem.rss / 1024 / 1024).toFixed(1);

      const dbIcon = dbPing.ok ? '✅' : '❌';
      const dbLabel = dbPing.mock ? 'In-Memory (Mock)' : (dbPing.ok ? `Connected (${dbPing.latency}ms)` : 'Disconnected');

      const text = `🏓 <b>Pong!</b>\n\n` +
        `• API Latency: <b>${latency}ms</b>\n` +
        `• Server Uptime: <b>${uptime}</b>\n` +
        `• Memory: <b>${memUsedMB} / ${memTotalMB} MB</b> (RSS: ${rssMB} MB)\n` +
        `• DB Status: ${dbIcon} <b>${dbLabel}</b>\n` +
        `• Node: <b>${process.version}</b>\n` +
        `• Platform: <b>${process.platform} ${process.arch}</b>`;

      await editTelegramMessage(chatId, msg.messageId, text);
    }
    return;
  }

  if (/^\/me/i.test(rawText)) {
    const cs = await getSettings();

    if (cs.referralDisabled === '1') {
       await sendTelegramMessage(chatId, `<b>Your Profile</b>\n\nID: <code>${chatId}</code>\n<i>Referral system is disabled on this bot.</i>`);
       return;
    }

    const refs = await getReferralStats(chatId);
    const premium = await hasPremium(chatId);
    let premiumText = 'Standard';
    if (premium) {
      const user = await users.findOne({ _id: String(chatId) });
      const globalTtl = user && user.premiumUntil ? Math.round((new Date(user.premiumUntil).getTime() - Date.now()) / 1000) : 0;
      premiumText = `Premium (${globalTtl > 0 ? Math.ceil(globalTtl / (24 * 3600)) : 'Lifetime'} days left)`;
    }
    const botUsername = await getBotUsername();
    const refLink = `https://t.me/${botUsername}?start=ref_${chatId}`;
    const text = `<b>Your Profile</b>\n\nID: <code>${chatId}</code>\nStatus: <b>${premiumText}</b>\nReferrals: <b>${refs}</b>\n\n🔗 <b>Your Referral Link:</b>\n<code>${refLink}</code>\n\n<i>Share this link to earn Premium access! 3 referrals = 24h Premium.</i>`;
    await sendTelegramMessage(chatId, text);
    return;
  }

  if (/^\/(temptoken|sharetemp)/i.test(rawText)) {
    const parts = rawText.trim().split(/\s+/);
    const targetCode = parts[1];
    const durationInput = parts[2];
    const maxUsesInput = parts[3];
    const botUsername = await getBotUsername();

    if (!targetCode) {
      const helpMsg = `<b>Time-Limited File Sharing</b>\n\n` +
        `Generate temporary access tokens/links for files or batches stored in the bot.\n\n` +
        `<b>Usage:</b>\n` +
        `<code>/temptoken &lt;file_code_or_batch_code&gt; [duration] [max_downloads]</code>\n\n` +
        `<b>Examples:</b>\n` +
        `• <code>/temptoken file_abc123 1h</code> (Valid for 1 hour)\n` +
        `• <code>/temptoken file_abc123 24h 1</code> (Valid for 24h or 1 download only)\n` +
        `• <code>/temptoken batch_xyz789 24h</code> (Valid for 24 hours)\n` +
        `• <code>/temptoken file_abc123 30m</code> (Valid for 30 minutes)\n\n` +
        `• <code>/mytokens</code> — View your active temporary tokens\n` +
        `• <code>/revoketoken &lt;token_code&gt;</code> — Invalidate a token`;
      await sendTelegramMessage(chatId, helpMsg, {
        inline_keyboard: [
          [{ text: toSmallCaps('My Active Tokens'), callback_data: 'user:my_tokens' }]
        ]
      });
      return;
    }

    if (durationInput) {
      const durationSeconds = parseDurationString(durationInput);
      if (!durationSeconds) {
        await sendTelegramMessage(chatId, `❌ <b>Invalid duration!</b>\n\nPlease specify a valid time like <code>30m</code>, <code>1h</code>, <code>6h</code>, <code>24h</code>, <code>3d</code>, or <code>7d</code>.`);
        return;
      }

      const maxUses = maxUsesInput && parseInt(maxUsesInput, 10) > 0 ? parseInt(maxUsesInput, 10) : null;

      const genRes = await generateTempToken(targetCode, durationSeconds, {
        createdBy: chatId,
        creatorName: message.from?.first_name || 'User',
        maxUses,
      });

      if (!genRes.ok) {
        if (genRes.reason === 'target_not_found') {
          await sendTelegramMessage(chatId, `❌ <b>File/Batch not found!</b>\n\nNo file or batch with code <code>${esc(targetCode)}</code> exists.`);
        } else {
          await sendTelegramMessage(chatId, `❌ <b>Failed to generate temporary token.</b>`);
        }
        return;
      }

      const shareLink = `https://t.me/${botUsername}?start=${genRes.token}`;
      const text = `⏳ <b>Temporary Access Token Generated!</b>\n\n` +
        `📁 Target: <code>${esc(genRes.tokenDoc.targetCode)}</code> (${genRes.tokenDoc.targetType})\n` +
        `⏱ Validity: <b>${genRes.durationLabel}</b>\n` +
        `📅 Expires at: <code>${new Date(genRes.expiresAt).toUTCString()}</code>\n\n` +
        `🔗 <b>Temporary Share Link:</b>\n<code>${shareLink}</code>\n\n` +
        `<i>This link will automatically expire after the validity duration.</i>`;

      await sendTelegramMessage(chatId, text, {
        inline_keyboard: [
          [{ text: toSmallCaps('Revoke Token'), callback_data: `user:revoke_token:${genRes.token}` }],
          [{ text: toSmallCaps('My Active Tokens'), callback_data: 'user:my_tokens' }]
        ]
      });
      return;
    }

    // If duration was not provided, show interactive duration selector
    const durKb = {
      inline_keyboard: [
        [
          { text: toSmallCaps('15 Mins'), callback_data: `user:gen_temp:${targetCode}:900` },
          { text: toSmallCaps('1 Hour'), callback_data: `user:gen_temp:${targetCode}:3600` },
          { text: toSmallCaps('6 Hours'), callback_data: `user:gen_temp:${targetCode}:21600` }
        ],
        [
          { text: toSmallCaps('12 Hours'), callback_data: `user:gen_temp:${targetCode}:43200` },
          { text: toSmallCaps('24 Hours'), callback_data: `user:gen_temp:${targetCode}:86400` },
          { text: toSmallCaps('3 Days'), callback_data: `user:gen_temp:${targetCode}:259200` }
        ],
        [
          { text: toSmallCaps('7 Days'), callback_data: `user:gen_temp:${targetCode}:604800` }
        ]
      ]
    };
    await sendTelegramMessage(chatId, `⏱ <b>Select Expiration Duration</b> for <code>${esc(targetCode)}</code>:`, durKb);
    return;
  }

  if (/^\/(mytokens|temptokens)/i.test(rawText)) {
    const list = await listActiveTempTokens(admin ? null : chatId, 15);
    if (!list || list.length === 0) {
      await sendTelegramMessage(chatId, `ℹ️ <b>No active temporary tokens found.</b>\n\nCreate one using <code>/temptoken &lt;file_code&gt; [duration]</code>.`);
      return;
    }

    const botUsername = await getBotUsername();
    let text = `📋 <b>Active Temporary Access Tokens</b> (${list.length})\n\n`;
    const buttons = [];

    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const remainingSec = Math.max(0, Math.round((new Date(t.expiresAt).getTime() - Date.now()) / 1000));
      const remStr = formatDuration(remainingSec);
      const link = `https://t.me/${botUsername}?start=${t._id}`;

      text += `<b>${i + 1}.</b> <code>${t._id}</code> → <code>${t.targetCode}</code>\n` +
              `   ⏱ Left: <b>${remStr}</b> | Uses: <b>${t.useCount || 0}</b>\n` +
              `   🔗 ${link}\n\n`;

      buttons.push([
        { text: toSmallCaps(`Revoke #${i + 1} (${t._id.slice(-6)})`), callback_data: `user:revoke_token:${t._id}` }
      ]);
    }

    await sendTelegramMessage(chatId, text, { inline_keyboard: buttons });
    return;
  }

  if (/^\/revoketoken\s+(\S+)/i.test(rawText)) {
    const targetToken = rawText.match(/\/revoketoken\s+(\S+)/i)[1].trim();
    const revokeRes = await revokeTempToken(targetToken, chatId, admin);
    if (!revokeRes.ok) {
      if (revokeRes.reason === 'not_found') {
        await sendTelegramMessage(chatId, `❌ Token <code>${esc(targetToken)}</code> not found.`);
      } else if (revokeRes.reason === 'unauthorized') {
        await sendTelegramMessage(chatId, `❌ You are not authorized to revoke this token.`);
      } else {
        await sendTelegramMessage(chatId, `❌ Failed to revoke token.`);
      }
      return;
    }
    await sendTelegramMessage(chatId, `✅ Token <code>${esc(targetToken)}</code> has been revoked and can no longer be accessed.`);
    return;
  }

  if (/^\/help/i.test(rawText)) {
    const helpText = `📖 <b>Bot Help & Guide</b>\n\n` +
      `- <b>Getting Files:</b> Click the links provided to you.\n` +
      `- <b>Temporary File Tokens:</b> Use <code>/temptoken &lt;code&gt; [duration]</code> to create time-limited share links.\n` +
      `- <b>My Tokens:</b> Use <code>/mytokens</code> to manage your active temporary links.\n` +
      `- <b>Referrals:</b> Share your link from /me to earn Premium.\n` +
      `- <b>Premium:</b> Bypass verification and support the bot.\n\nNeed more help? Contact our support.`;
    await sendTelegramMessage(chatId, helpText);
    return;
  }

  return;
}
