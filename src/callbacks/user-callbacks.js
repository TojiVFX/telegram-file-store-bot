import {
  getCollection, getSettings, getDb, toSmallCaps, esc, editTelegramMessage,
  answerCallbackQuery, getToken, getCurrentBotId, formatISTDateTime,
  editTelegramCaption, deleteTelegramMessage, sendTelegramPhoto, sendChatAction,
  sendTelegramMessage, sendTelegramVideo, sendTelegramDocument
} from '../bot-common.js';
import {
  getBotUsername, buildStartMenuButtons, buildForceSubscribeGate,
  formatStartMessage, getMainBotUsername, renderPingReport, renderSystemStatus,
  getUserHelpMessage, copyFromDbChannel, scheduleAutoDelete
} from '../bot-helpers.js';
import {
  generateTempToken, revokeTempToken, listActiveTempTokens, formatDuration,
  setBulkStoreActive, clearStoreSession, getBundle, incrementAccessCount
} from '../filestore.js';
import { getReferralStats, hasPremium, getPremiumDetails, getUserProfile } from '../bot-users.js';
import { getAdminId } from '../auth.js';
import { verifyCaptchaAnswer, sendCaptchaChallenge } from '../anti-scraper.js';
import { handleStartPayload, checkRequestCooldown, updateRequestCooldown } from '../commands/start.js';
import { buildUnifiedProfileCard } from '../commands/user.js';

export async function handleUserCallback(chatId, messageId, action, cq, from, msg, admin) {
  if (action === 'save_tip') {
    await answerCallbackQuery(
      cq.id,
      '💡 How to keep your files:\n\nTap and hold any file message, select "Forward", then choose "Saved Messages". You will keep it permanently even after auto-delete!',
      true
    );
    return;
  }

  if (action === 'clone_health') {
    await answerCallbackQuery(cq.id).catch(() => {});
    const currentBotId = getCurrentBotId();
    const workerUsername = await getBotUsername();
    const mainBotUsername = await getMainBotUsername();

    // Measure Telegram API ping latency
    const pingStart = Date.now();
    let apiStatus = '🟢 Online';
    let latencyMs = 0;
    try {
      const res = await fetch(`https://api.telegram.org/bot${getToken()}/getMe`);
      latencyMs = Date.now() - pingStart;
      if (!res.ok) apiStatus = '🔴 API Warning';
    } catch {
      apiStatus = '🔴 Network Error';
    }

    const report = `🟢 <b>Worker Node Health & Diagnostic</b>\n\n` +
      `• <b>Node ID:</b> <code>${currentBotId || 'Worker'}</code>\n` +
      `• <b>Bot:</b> @${esc(workerUsername || 'Worker')}\n` +
      `• <b>Status:</b> ${apiStatus}\n` +
      `• <b>API Latency:</b> <b>${latencyMs}ms</b>\n` +
      `• <b>Role:</b> Ghost Fleet Delivery Node\n` +
      `• <b>Main Gateway:</b> @${esc(mainBotUsername || 'MainBot')}\n\n` +
      `<i>Node is healthy and ready to receive dispatch delivery jobs from the Main Gateway.</i>`;

    const buttons = [
      [{ text: toSmallCaps('⚙️ Manage in Main Bot'), url: `https://t.me/${mainBotUsername}?start=clone_view_${currentBotId}` }],
      [{ text: toSmallCaps('🔄 Refresh Health'), callback_data: 'user:clone_health' }]
    ];

    await editTelegramMessage(chatId, messageId, report, { inline_keyboard: buttons });
    return;
  }

  if (action === 'refresh_ping') {
    await answerCallbackQuery(cq.id, '🏓 Refreshing ping...').catch(() => {});
    await renderPingReport(chatId, messageId);
    return;
  }

  if (action === 'refresh_status') {
    if (!admin) {
      await answerCallbackQuery(cq.id, '⛔ Admin only.', true).catch(() => {});
      return;
    }
    await answerCallbackQuery(cq.id, '🩺 Refreshing status...').catch(() => {});
    await renderSystemStatus(chatId, messageId);
    return;
  }

  // Answer instantly to dismiss the button loading spinner immediately
  answerCallbackQuery(cq.id).catch(() => {});

  const botUsername = await getBotUsername();
  const cs = await getSettings();

  // 1. Force Subscribe Check (skip if admin)
  if (!admin) {
    const gate = await buildForceSubscribeGate(chatId);
    if (gate) {
      await editTelegramMessage(chatId, messageId, gate.text, gate.replyMarkup);
      return;
    }
  }

  if (action.startsWith('resend:')) {
    const targetCode = action.replace(/^resend:/, '').trim();
    if (!targetCode) return;

    const cd = checkRequestCooldown(chatId);
    if (cd.limited && !admin) {
      await answerCallbackQuery(cq.id, `⏳ Please wait ${cd.remainingSec}s before requesting again.`, true).catch(() => {});
      return;
    }

    await answerCallbackQuery(cq.id, '♻️ Delivering files again...').catch(() => {});
    return handleStartPayload(chatId, targetCode, { from }, admin, false);
  }

  if (action.startsWith('gen_temp:')) {
    const parts = action.split(':');
    const targetCode = parts[1];
    const durationSec = parseInt(parts[2], 10) || 3600;

    const genRes = await generateTempToken(targetCode, durationSec, {
      createdBy: chatId,
      creatorName: from?.first_name || 'User',
    });

    if (!genRes.ok) {
      await editTelegramMessage(chatId, messageId, `❌ <b>Failed to generate temporary link.</b>\n\nTarget file or batch <code>${esc(targetCode)}</code> could not be found.`, {
        inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]]
      });
      return;
    }

    const shareLink = `https://t.me/${botUsername}?start=${genRes.token}`;
    const text = `⏳ <b>Temporary Access Token Generated!</b>\n\n` +
      `📁 Target: <code>${esc(genRes.tokenDoc.targetCode)}</code> (${genRes.tokenDoc.targetType})\n` +
      `⏱ Validity: <b>${genRes.durationLabel}</b>\n` +
      `📅 Expires at: <code>${formatISTDateTime(genRes.expiresAt)}</code>\n\n` +
      `🔗 <b>Temporary Share Link:</b>\n<code>${shareLink}</code>\n\n` +
      `<i>This link will automatically expire after the validity duration.</i>`;

    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Revoke Token'), callback_data: `user:revoke_token:${genRes.token}` }],
        [{ text: toSmallCaps('My Active Tokens'), callback_data: 'user:my_tokens' }],
        [{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]
      ]
    });
    return;
  }

  if (action === 'my_tokens') {
    const list = await listActiveTempTokens(admin ? null : chatId, 15);
    if (!list || list.length === 0) {
      await editTelegramMessage(chatId, messageId, `ℹ️ <b>No active temporary tokens found.</b>\n\nCreate one using <code>/temptoken &lt;file_code&gt; [duration]</code>.`, {
        inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]]
      });
      return;
    }

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

    buttons.push([{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]);

    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
    return;
  }

  if (action.startsWith('revoke_token:')) {
    const tokenId = action.split(':')[1];
    const revokeRes = await revokeTempToken(tokenId, chatId, admin);
    if (!revokeRes.ok) {
      await editTelegramMessage(chatId, messageId, `❌ Failed to revoke token <code>${esc(tokenId)}</code> (${revokeRes.reason}).`, {
        inline_keyboard: [[{ text: toSmallCaps('My Tokens'), callback_data: 'user:my_tokens' }]]
      });
      return;
    }

    await editTelegramMessage(chatId, messageId, `✅ Token <code>${esc(tokenId)}</code> has been revoked and can no longer be accessed.`, {
      inline_keyboard: [
        [{ text: toSmallCaps('My Tokens'), callback_data: 'user:my_tokens' }],
        [{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]
      ]
    });
    return;
  }

  if (action === 'me' || action === 'my_plan') {
    const profile = await buildUnifiedProfileCard(chatId);

    if (profile.banner) {
      const capRes = await editTelegramCaption(chatId, messageId, profile.text, {
        inline_keyboard: profile.buttons
      });
      if (!capRes.ok) {
        await deleteTelegramMessage(chatId, messageId).catch(() => {});
        await sendTelegramPhoto(chatId, profile.banner, profile.text, {
          inline_keyboard: profile.buttons
        });
      }
    } else {
      await editTelegramMessage(chatId, messageId, profile.text, {
        inline_keyboard: profile.buttons
      });
    }
    return;
  } else if (action === 'help') {
    const { text, replyMarkup } = getUserHelpMessage(admin);
    await editTelegramMessage(chatId, messageId, text, replyMarkup);
  } else if (action === 'about') {
    let usedStorage = 0;
    try {
      const db = await getDb();
      const stats = await db.command({ dbStats: 1 });
      usedStorage = stats.storageSize || stats.dataSize || 0;
    } catch (err) {
      console.error('Failed to fetch native MongoDB stats:', err.message);
      // Fallback
      usedStorage = 10 * 1024 * 1024;
    }

    const totalStorage = 512 * 1024 * 1024; // 512MB limit of MongoDB Atlas free tier
    const percent = Math.min(100, Math.round((usedStorage / totalStorage) * 100));
    const barWidth = 10;
    const filled = Math.round((percent / 100) * barWidth);
    const bar = '█'.repeat(filled) + '▒'.repeat(barWidth - filled);

    const text = `<b>ℹ️ About This Bot</b>\n\nThis bot allows you to store and share files securely.\n\n` +
                 `📊 <b>Database Status:</b>\n` +
                 `${bar} ${percent}%\n` +
                 `Used: <b>${(usedStorage / (1024 * 1024)).toFixed(2)} MB</b> / <b>${(totalStorage / (1024 * 1024)).toFixed(2)} MB</b>\n\n` +
                 `<i>Powering your file sharing experience.</i>`;

    const adminId = getAdminId();
    const contactUrl = cs?.supportContact || (adminId ? `tg://user?id=${adminId}` : `https://t.me/${botUsername}`);

    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Developer'), url: contactUrl }, { text: toSmallCaps('Help'), callback_data: 'user:help' }],
        [{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]
      ]
    });
  } else if (action === 'back_start') {
    if (admin) {
      const sessions = await getCollection('sessions');
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });
      await sessions.deleteOne({ _id: `admin:broadcast_draft:${chatId}` });
      await setBulkStoreActive(chatId, false);
      await clearStoreSession(chatId);
    }

    const s = await getSettings();
    const startMsg = formatStartMessage(s?.startText, from, chatId);

    const styledButtons = await buildStartMenuButtons(admin);

    if (s.startPhoto) {
      const capRes = await editTelegramCaption(chatId, messageId, startMsg, { inline_keyboard: styledButtons });
      if (!capRes.ok) {
        await deleteTelegramMessage(chatId, messageId).catch(() => {});
        await sendTelegramPhoto(chatId, s.startPhoto, startMsg, { inline_keyboard: styledButtons });
      }
    } else {
      await editTelegramMessage(chatId, messageId, startMsg, { inline_keyboard: styledButtons });
    }
  }

  if (action.startsWith('captcha:')) {
    const parts = action.split(':');
    const token = parts[1];
    const chosenIndex = parseInt(parts[2], 10);
    const verifyRes = await verifyCaptchaAnswer(chatId, token, chosenIndex);
    if (!verifyRes.ok) {
      await answerCallbackQuery(cq.id, '❌ Incorrect! Please solve the new challenge.', true);
      await deleteTelegramMessage(chatId, messageId).catch(() => {});
      if (verifyRes.originalPayload) {
        await sendCaptchaChallenge(chatId, verifyRes.originalPayload);
      }
      return;
    }
    await answerCallbackQuery(cq.id, '✅ Verified! Delivering files...', false);
    await deleteTelegramMessage(chatId, messageId).catch(() => {});
    await handleStartPayload(chatId, verifyRes.originalPayload, { from: cq.from }, admin, true);
    return;
  }

  if (action.startsWith('dl_q:')) {
    const parts = action.split(':');
    const bundleCode = parts[1];
    const qIndex = parseInt(parts[2], 10);

    if (!admin) {
      const cd = checkRequestCooldown(chatId);
      if (cd.limited) {
        await answerCallbackQuery(cq.id, `⏳ Please wait ${cd.remainingSec}s before downloading another file!`, true);
        return;
      }
      updateRequestCooldown(chatId);
    }

    const bundle = await getBundle(bundleCode);
    if (!bundle || !bundle.qualities?.[qIndex]) {
      await answerCallbackQuery(cq.id, 'File or quality not found.', true);
      return;
    }

    const q = bundle.qualities[qIndex];
    await answerCallbackQuery(cq.id, `Sending ${q.quality}...`);

    sendChatAction(chatId, 'upload_document').catch(() => {});

    const s = await getSettings();
    const protect = s?.protectContent === '1';

    let sentMsgId = null;
    let resCopy = await copyFromDbChannel(chatId, bundle.dbChannelId, q.dbMessageId, protect);
    if ((!resCopy?.ok || !resCopy?.messageId) && (bundle.backupDbChannelId || q.backupDbChannelId) && q.backupDbMessageId) {
      const backupCid = q.backupDbChannelId || bundle.backupDbChannelId;
      const backupRes = await copyFromDbChannel(chatId, backupCid, q.backupDbMessageId, protect);
      if (backupRes?.ok && backupRes?.messageId) {
        resCopy = backupRes;
        // Proactive Link Healer: Auto-heal bundle quality pointer in MongoDB
        const files = await getCollection('files');
        files.updateOne(
          { _id: bundleCode },
          {
            $set: {
              [`qualities.${qIndex}.dbMessageId`]: q.backupDbMessageId,
              [`qualities.${qIndex}.dbChannelId`]: backupCid,
              [`qualities.${qIndex}.autoHealedAt`]: new Date(),
            }
          }
        ).catch(() => {});
      }
    }
    if (resCopy?.ok && resCopy?.messageId) {
      sentMsgId = resCopy.messageId;
    } else if (q.fileId) {
      // Triple-layer fallback: direct bot-to-user send via cached file_id
      const caption = q.fileName ? `<b>${esc(q.fileName)}</b>` : '';
      const resSend = (q.type === 'document')
        ? await sendTelegramDocument(chatId, q.fileId, caption, null, protect)
        : await sendTelegramVideo(chatId, q.fileId, caption, null, protect);
      if (resSend?.messageId) {
        sentMsgId = resSend.messageId;
      }
    }

    if (sentMsgId) {
      const deleteIds = messageId ? [sentMsgId, messageId] : [sentMsgId];
      await scheduleAutoDelete(chatId, deleteIds, bundleCode);
    } else {
      await sendTelegramMessage(chatId, `❌ <b>Failed to deliver file</b> (Storage message missing or unreadable).`);
    }

    incrementAccessCount(bundleCode);
    return;
  }

  if (action.startsWith('dl_q_all:')) {
    const bundleCode = action.split(':').slice(1).join(':');

    if (!admin) {
      const cd = checkRequestCooldown(chatId);
      if (cd.limited) {
        await answerCallbackQuery(cq.id, `⏳ Please wait ${cd.remainingSec}s before downloading another file!`, true);
        return;
      }
      updateRequestCooldown(chatId);
    }

    const bundle = await getBundle(bundleCode);
    if (!bundle || !bundle.qualities?.length) {
      await answerCallbackQuery(cq.id, 'Bundle not found.', true);
      return;
    }

    await answerCallbackQuery(cq.id, 'Delivering all resolutions...');

    sendChatAction(chatId, 'upload_document').catch(() => {});

    const s = await getSettings();
    const protect = s?.protectContent === '1';

    const sentIds = [];
    let anyHealed = false;
    for (let i = 0; i < bundle.qualities.length; i++) {
      const q = bundle.qualities[i];
      let resCopy = await copyFromDbChannel(chatId, bundle.dbChannelId, q.dbMessageId, protect);
      if ((!resCopy?.ok || !resCopy?.messageId) && (bundle.backupDbChannelId || q.backupDbChannelId) && q.backupDbMessageId) {
        const backupCid = q.backupDbChannelId || bundle.backupDbChannelId;
        const backupRes = await copyFromDbChannel(chatId, backupCid, q.backupDbMessageId, protect);
        if (backupRes?.ok && backupRes?.messageId) {
          resCopy = backupRes;
          bundle.qualities[i].dbMessageId = q.backupDbMessageId;
          bundle.qualities[i].dbChannelId = backupCid;
          anyHealed = true;
        }
      }
      if (resCopy?.ok && resCopy?.messageId) {
        sentIds.push(resCopy.messageId);
      } else if (q.fileId) {
        const caption = q.fileName ? `<b>${esc(q.fileName)}</b>` : '';
        const resSend = (q.type === 'document')
          ? await sendTelegramDocument(chatId, q.fileId, caption, null, protect)
          : await sendTelegramVideo(chatId, q.fileId, caption, null, protect);
        if (resSend?.messageId) {
          sentIds.push(resSend.messageId);
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }

    if (anyHealed) {
      const files = await getCollection('files');
      files.updateOne(
        { _id: bundleCode },
        { $set: { qualities: bundle.qualities, autoHealedAt: new Date() } }
      ).catch(() => {});
    }

    if (sentIds.length > 0) {
      const deleteIds = messageId ? [...sentIds, messageId] : sentIds;
      await scheduleAutoDelete(chatId, deleteIds, bundleCode);
    }
    incrementAccessCount(bundleCode);
    return;
  }

  return;
}
