import {
  getCollection, getSettings, sendTelegramMessage, editTelegramMessage, deleteTelegramMessage, toSmallCaps, getMainToken, esc
} from '../bot-common.js';
import {
  getBotUsername, getDbChannelId, checkSubscription, isBotAdmin, extractChannelMessage, copyIntoDbChannel, copyFromDbChannel, getMainBotUsername, resolveUser
} from '../bot-helpers.js';
import {
  getBatchSession, setBatchSession, addIdToBatch, clearBatchSession, updateBatchSessionMeta, checkAndClearAdminWaiting, setAdminWaitingForFile, storeFile, generateFileCode,
  generateTempToken, getTempToken, revokeTempToken, listActiveTempTokens, parseDurationString, formatDuration
} from '../filestore.js';
import { handleStartPayload } from './start.js';
import { banUser, unbanUser, getBannedList, broadcastToAll, getUserStats, addReferral, hasPremium, getReferralStats } from '../bot-users.js';
import { processAdminMessage } from './admin.js';

export async function processMessageUpdate(chatId, rawText, message, admin, req, res) {
  const users = await getCollection('users');
  const sessions = await getCollection('sessions');

  const userExists = await users.findOne({ _id: String(chatId) });
  const isNewUser = !userExists;

  const { upsertUser } = await import('../bot-users.js');
  await upsertUser(message);

  if (admin) {
    const adminRes = await processAdminMessage(chatId, rawText, message, req, res);
    if (adminRes) return adminRes;
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
      return handleStartPayload(chatId, null, message, admin, res);
    }
    if (payload?.startsWith('verify_')) {
      const tkn = payload.slice(7);
      const verifySession = await sessions.findOne({ _id: `verify:tkn:${tkn}` });
      const rawV = verifySession && verifySession.expiresAt > new Date() ? verifySession.val : null;
      if (!rawV) {
        await sendTelegramMessage(chatId, `❌ Link expired.`);
        return res.status(200).send('OK');
      }

      if (rawV.creatorChatId && String(rawV.creatorChatId) !== String(chatId)) {
        await sendTelegramMessage(chatId, `baka\nits not your verification token`);
        return res.status(200).send('OK');
      }

      const { payload: originalPayload, validityHours } = rawV;

      // `validityHours` was already normalized by `parseValidityHours()` when
      // the verify link was generated in start.js (0 stays 0, blank/invalid
      // falls back to 24). Here we just guard against a missing/odd value
      // before doing arithmetic with it.
      const hours = Number.isFinite(validityHours) ? validityHours : 24;

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
      await sendTelegramMessage(chatId, `✅ Verified!`);
      return handleStartPayload(chatId, originalPayload, message, admin, res);
    }
    return handleStartPayload(chatId, payload, message, admin, res);
  }

  const canGenerate = admin;

  if (/^\/(bundle|quality)/i.test(rawText) && canGenerate) {
    const customTitle = rawText.replace(/^\/(bundle|quality)/i, '').trim();
    const dbChannelId = await getDbChannelId();
    if (!dbChannelId) {
      const mainBotUsername = await getMainBotUsername();
      const setLink = `https://t.me/${mainBotUsername}?start=setting`;

      await sendTelegramMessage(chatId, `❌ <b>Database Channel not set!</b>\n\nPlease configure your DB Channel ID in the bot settings first.\n\n<a href="${setLink}">⚙️ Open Settings</a>`);
      return res.status(200).send('OK');
    }

    if (!(await isBotAdmin(dbChannelId))) {
      const helpMsg = `❌ <b>Permissions Required!</b>\n\nI am not an administrator in the DB channel (<code>${dbChannelId}</code>) or I don't have permission to post messages.\n\n<b>To fix this:</b>\n1. Add this bot as an Admin in your DB channel.\n2. Ensure 'Post Messages' permission is enabled.`;
      await sendTelegramMessage(chatId, helpMsg);
      return res.status(200).send('OK');
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
    return res.status(200).send('OK');
  }

  if (/^\/batch/i.test(rawText) && canGenerate) {
    const dbChannelId = await getDbChannelId();
    if (!dbChannelId) {
      const mainBotUsername = await getMainBotUsername();
      const setLink = `https://t.me/${mainBotUsername}?start=setting`;

      await sendTelegramMessage(chatId, `❌ <b>Database Channel not set!</b>\n\nPlease configure your DB Channel ID in the bot settings first.\n\n<a href="${setLink}">⚙️ Open Settings</a>`);
      return res.status(200).send('OK');
    }

    if (!(await isBotAdmin(dbChannelId))) {
      const mainBotUsername = await getMainBotUsername();
      const helpMsg = `❌ <b>Permissions Required!</b>\n\nI am not an administrator in the DB channel (<code>${dbChannelId}</code>) or I don't have permission to post messages.\n\n<b>To fix this:</b>\n1. Add this bot as an Admin in your DB channel.\n2. Ensure 'Post Messages' permission is enabled.`;
      await sendTelegramMessage(chatId, helpMsg);
      return res.status(200).send('OK');
    }

    await setBatchSession(chatId, { step: 'first', collectedIds: [] });
    await sendTelegramMessage(chatId, `📦 <b>Batch Mode</b>\n\nForward the first message or start sending files.`);
    return res.status(200).send('OK');
  }

  if (/^\/store/i.test(rawText) && canGenerate) {
    const dbChannelId = await getDbChannelId();
    if (!dbChannelId) {
       const mainBotUsername = await getMainBotUsername();
       const setLink = `https://t.me/${mainBotUsername}?start=setting`;

       await sendTelegramMessage(chatId, `❌ <b>Database Channel not set!</b>\n\nPlease configure your DB Channel ID in the bot settings first.\n\n<a href="${setLink}">⚙️ Open Settings</a>`);
       return res.status(200).send('OK');
    }

    if (!(await isBotAdmin(dbChannelId))) {
      const mainBotUsername = await getMainBotUsername();
      const helpMsg = `❌ <b>Permissions Required!</b>\n\nI am not an administrator in the DB channel (<code>${dbChannelId}</code>) or I don't have permission to post messages.\n\n<b>To fix this:</b>\n1. Add this bot as an Admin in your DB channel.\n2. Ensure 'Post Messages' permission is enabled.`;
      await sendTelegramMessage(chatId, helpMsg);
      return res.status(200).send('OK');
    }

    await setAdminWaitingForFile(chatId);
    await sendTelegramMessage(chatId, `📁 Send the file to store.`);
    return res.status(200).send('OK');
  }

  if (/^\/cancel/i.test(rawText) && admin) {
    await clearBatchSession(chatId);
    await checkAndClearAdminWaiting(chatId);
    await sendTelegramMessage(chatId, `✅ Cancelled.`);
    return res.status(200).send('OK');
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
    return res.status(200).send('OK');
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
    return res.status(200).send('OK');
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
      return res.status(200).send('OK');
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
    return res.status(200).send('OK');
  }

  if (/^\/todaylinks/i.test(rawText) && admin) {
    const { getTodayFiles } = await import('../filestore.js');
    const todayFiles = await getTodayFiles();
    const botUsername = await getBotUsername();

    if (!todayFiles.length) {
      await sendTelegramMessage(chatId, `<b>Links Created Today</b>\n\n<i>No links have been created today yet.</i>`);
      return res.status(200).send('OK');
    }

    let report = `<b>Links Created Today (${todayFiles.length})</b>\n\n`;
    for (let i = 0; i < todayFiles.length; i++) {
      const item = todayFiles[i];
      const link = `https://t.me/${botUsername}?start=${item._id}`;
      report += `<b>${i + 1}.</b> <code>${item._id}</code> (${item.type || 'file'})\n` +
                `   • Downloads: <b>${item.accessCount || 0}</b>\n` +
                `   • Link: ${link}\n\n`;
    }

    await sendTelegramMessage(chatId, report, {
      inline_keyboard: [
        [{ text: toSmallCaps('Copy All Links (Text)'), callback_data: 'admin:today_copy_text' }, { text: toSmallCaps('Export Today (.txt)'), callback_data: 'admin:export_today_txt' }]
      ]
    });
    return res.status(200).send('OK');
  }

  if (/^\/bulkstore/i.test(rawText) && admin) {
    const { getDbChannelReadinessError } = await import('../bot-helpers.js');
    const dbError = await getDbChannelReadinessError();
    if (dbError) {
      await sendTelegramMessage(chatId, dbError);
      return res.status(200).send('OK');
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
    return res.status(200).send('OK');
  }

  if (/^\/exportlinks/i.test(rawText) && admin) {
    const parts = rawText.trim().split(/\s+/).slice(1);
    const { getExportLinksKeyboard } = await import('../bot-helpers.js');

    if (parts.length === 0) {
      const text = `📄 <b>Export Links Hub</b>\n\nSelect a time duration or category to export links as a <b>.txt</b> document and get a 1-tap copyable text block:\n\nYou can also run directly with arguments:\n• <code>/exportlinks 15m</code>\n• <code>/exportlinks 30m batch</code>\n• <code>/exportlinks 1h</code>\n• <code>/exportlinks today</code>`;
      await sendTelegramMessage(chatId, text, getExportLinksKeyboard());
      return res.status(200).send('OK');
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
        return res.status(200).send('OK');
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
      return res.status(200).send('OK');
    }

    if (isAll) {
      const filesColl = await getCollection('files');
      const query = {};
      if (filterType !== 'all') query.type = filterType;
      const allFiles = await filesColl.find(query).sort({ createdAt: -1 }).toArray();
      if (!allFiles.length) {
        await sendTelegramMessage(chatId, `⚠️ <i>No stored records found in database.</i>`);
        return res.status(200).send('OK');
      }
      const title = `All Stored ${isBatchOnly ? 'Batches' : 'Links'}`;
      const txtContent = generateLinksExportText(allFiles, botUsername, title);
      const buffer = Buffer.from(txtContent, 'utf-8');
      const filename = `filestore_all_${filterType}_${new Date().toISOString().slice(0, 10)}.txt`;
      await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>${title} Export</b> (${allFiles.length} records)`);
      return res.status(200).send('OK');
    }

    // Parse time duration (e.g. 15m, 30m, 1h, 120, 2h)
    const cleanDuration = argStr.replace(/\b(batch|batches|files|file)\b/g, '').trim();
    let seconds = parseDurationString(cleanDuration);
    if (!seconds && /^\d+$/.test(cleanDuration)) {
      seconds = parseInt(cleanDuration, 10) * 60;
    }

    if (!seconds || seconds <= 0) {
      await sendTelegramMessage(chatId, `❌ <b>Invalid time parameter!</b>\n\n<b>Usage Examples:</b>\n• <code>/exportlinks 15m</code> (last 15 minutes)\n• <code>/exportlinks 30m batch</code> (last 30 minutes, batches only)\n• <code>/exportlinks 1h</code> (last 1 hour)\n• <code>/exportlinks today</code> (today's links)\n• <code>/exportlinks all</code> (entire database)`);
      return res.status(200).send('OK');
    }

    const records = await getFilesWithinDuration(seconds, filterType);
    const durationLabel = formatDurationLabel(seconds);
    const typeLabel = isBatchOnly ? 'Batches' : isFileOnly ? 'Single Files' : 'Links';

    if (!records.length) {
      await sendTelegramMessage(chatId, `⚠️ <i>No ${typeLabel.toLowerCase()} found created within the last ${durationLabel}.</i>`);
      return res.status(200).send('OK');
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
    return res.status(200).send('OK');
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
          { text: toSmallCaps('Cancel'), callback_data: 'admin:broadcast_cancel_draft' }
        ]
      ]
    });
    return res.status(200).send('OK');
  }

  if (/^\/ban\s+(\d+)/i.test(rawText) && admin) {
    const targetId = rawText.match(/\/ban\s+(\d+)/i)[1];
    await banUser(targetId);
    await sendTelegramMessage(chatId, `✅ User <code>${targetId}</code> has been banned.`);
    return res.status(200).send('OK');
  }

  if (/^\/unban\s+(\d+)/i.test(rawText) && admin) {
    const targetId = rawText.match(/\/unban\s+(\d+)/i)[1];
    await unbanUser(targetId);
    await sendTelegramMessage(chatId, `✅ User <code>${targetId}</code> has been unbanned.`);
    return res.status(200).send('OK');
  }

  if (/^\/banlist/i.test(rawText) && admin) {
    const list = await getBannedList();
    if (!list.length) await sendTelegramMessage(chatId, `No banned users.`);
    else await sendTelegramMessage(chatId, `🚫 <b>Banned Users:</b>\n\n${list.map(id => `<code>${id}</code>`).join('\n')}`);
    return res.status(200).send('OK');
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
    return res.status(200).send('OK');
  }

  if (/^\/setting/i.test(rawText) && admin) {
    const { getAdminDashboardKeyboard } = await import('../bot-helpers.js');
    const text = `<b>Admin Dashboard</b>\n\nSelect a category to manage the bot:`;
    await sendTelegramMessage(chatId, text, getAdminDashboardKeyboard());
    return res.status(200).send('OK');
  }

  if (/^\/adminhelp/i.test(rawText) && admin) {
    let helpText = `<b>Admin Dashboard</b>\n\nYou can manage all bot features through the interactive dashboard. Click the button below to open it.`;
    let kb = { inline_keyboard: [[{ text: toSmallCaps('Open Dashboard'), callback_data: 'admin:dashboard' }]] };
    await sendTelegramMessage(chatId, helpText, kb);
    return res.status(200).send('OK');
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
    return res.status(200).send('OK');
  }

  if (/^\/auditlinks/i.test(rawText) && admin) {
    const { renderStorageAudit } = await import('../callbacks/admin-callbacks.js');
    await renderStorageAudit(chatId);
    return res.status(200).send('OK');
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
      return res.status(200).send('OK');
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
    return res.status(200).send('OK');
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
    return res.status(200).send('OK');
  }

  if (/^\/me/i.test(rawText)) {
    const cs = await getSettings();

    if (cs.referralDisabled === '1') {
       await sendTelegramMessage(chatId, `<b>Your Profile</b>\n\nID: <code>${chatId}</code>\n<i>Referral system is disabled on this bot.</i>`);
       return res.status(200).send('OK');
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
    return res.status(200).send('OK');
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
      return res.status(200).send('OK');
    }

    if (durationInput) {
      const durationSeconds = parseDurationString(durationInput);
      if (!durationSeconds) {
        await sendTelegramMessage(chatId, `❌ <b>Invalid duration!</b>\n\nPlease specify a valid time like <code>30m</code>, <code>1h</code>, <code>6h</code>, <code>24h</code>, <code>3d</code>, or <code>7d</code>.`);
        return res.status(200).send('OK');
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
        return res.status(200).send('OK');
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
      return res.status(200).send('OK');
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
    return res.status(200).send('OK');
  }

  if (/^\/(mytokens|temptokens)/i.test(rawText)) {
    const list = await listActiveTempTokens(admin ? null : chatId, 15);
    if (!list || list.length === 0) {
      await sendTelegramMessage(chatId, `ℹ️ <b>No active temporary tokens found.</b>\n\nCreate one using <code>/temptoken &lt;file_code&gt; [duration]</code>.`);
      return res.status(200).send('OK');
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
    return res.status(200).send('OK');
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
      return res.status(200).send('OK');
    }
    await sendTelegramMessage(chatId, `✅ Token <code>${esc(targetToken)}</code> has been revoked and can no longer be accessed.`);
    return res.status(200).send('OK');
  }

  if (/^\/help/i.test(rawText)) {
    const helpText = `📖 <b>Bot Help & Guide</b>\n\n` +
      `- <b>Getting Files:</b> Click the links provided to you.\n` +
      `- <b>Temporary File Tokens:</b> Use <code>/temptoken &lt;code&gt; [duration]</code> to create time-limited share links.\n` +
      `- <b>My Tokens:</b> Use <code>/mytokens</code> to manage your active temporary links.\n` +
      `- <b>Referrals:</b> Share your link from /me to earn Premium.\n` +
      `- <b>Premium:</b> Bypass verification and support the bot.\n\nNeed more help? Contact our support.`;
    await sendTelegramMessage(chatId, helpText);
    return res.status(200).send('OK');
  }

  return res.status(200).send('OK');
}
