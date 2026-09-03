import { getCollection, getSettings, getDb, toSmallCaps, esc, editTelegramMessage, answerCallbackQuery } from '../bot-common.js';
import { getBotUsername, buildStartMenuButtons, buildForceSubscribeGate } from '../bot-helpers.js';
import { generateTempToken, revokeTempToken, listActiveTempTokens, formatDuration } from '../filestore.js';

export async function handleUserCallback(chatId, messageId, action, cq, from, msg, admin, res) {
  if (action === 'save_tip') {
    await answerCallbackQuery(
      cq.id,
      '💡 How to keep your files:\n\nTap and hold any file message, select "Forward", then choose "Saved Messages". You will keep it permanently even after auto-delete!',
      true
    );
    return res.status(200).send('OK');
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
      return res.status(200).send('OK');
    }
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
      return res.status(200).send('OK');
    }

    const shareLink = `https://t.me/${botUsername}?start=${genRes.token}`;
    const text = `⏳ <b>Temporary Access Token Generated!</b>\n\n` +
      `📁 Target: <code>${esc(genRes.tokenDoc.targetCode)}</code> (${genRes.tokenDoc.targetType})\n` +
      `⏱ Validity: <b>${genRes.durationLabel}</b>\n` +
      `📅 Expires at: <code>${new Date(genRes.expiresAt).toUTCString()}</code>\n\n` +
      `🔗 <b>Temporary Share Link:</b>\n<code>${shareLink}</code>\n\n` +
      `<i>This link will automatically expire after the validity duration.</i>`;

    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Revoke Token'), callback_data: `user:revoke_token:${genRes.token}` }],
        [{ text: toSmallCaps('My Active Tokens'), callback_data: 'user:my_tokens' }],
        [{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]
      ]
    });
    return res.status(200).send('OK');
  }

  if (action === 'my_tokens') {
    const list = await listActiveTempTokens(admin ? null : chatId, 15);
    if (!list || list.length === 0) {
      await editTelegramMessage(chatId, messageId, `ℹ️ <b>No active temporary tokens found.</b>\n\nCreate one using <code>/temptoken &lt;file_code&gt; [duration]</code>.`, {
        inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]]
      });
      return res.status(200).send('OK');
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
    return res.status(200).send('OK');
  }

  if (action.startsWith('revoke_token:')) {
    const tokenId = action.split(':')[1];
    const revokeRes = await revokeTempToken(tokenId, chatId, admin);
    if (!revokeRes.ok) {
      await editTelegramMessage(chatId, messageId, `❌ Failed to revoke token <code>${esc(tokenId)}</code> (${revokeRes.reason}).`, {
        inline_keyboard: [[{ text: toSmallCaps('My Tokens'), callback_data: 'user:my_tokens' }]]
      });
      return res.status(200).send('OK');
    }

    await editTelegramMessage(chatId, messageId, `✅ Token <code>${esc(tokenId)}</code> has been revoked and can no longer be accessed.`, {
      inline_keyboard: [
        [{ text: toSmallCaps('My Tokens'), callback_data: 'user:my_tokens' }],
        [{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]
      ]
    });
    return res.status(200).send('OK');
  }

  if (action === 'me') {
    if (cs.referralDisabled === '1') {
       const text = `<b>Your Profile</b>\n\nID: <code>${chatId}</code>\n<i>Referral system is disabled on this bot.</i>`;
       await editTelegramMessage(chatId, messageId, text, {
         inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]]
       });
       return res.status(200).send('OK');
    }

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

    if (cs.bannerProfile) {
      const { editTelegramCaption, deleteTelegramMessage, sendTelegramPhoto } = await import('../bot-common.js');
      const capRes = await editTelegramCaption(chatId, messageId, text, {
        inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]]
      });
      if (!capRes.ok) {
        await deleteTelegramMessage(chatId, messageId).catch(() => {});
        await sendTelegramPhoto(chatId, cs.bannerProfile, text, {
          inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]]
        });
      }
    } else {
      await editTelegramMessage(chatId, messageId, text, {
        inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]]
      });
    }
  } else if (action === 'help') {
    const helpText = `<b>Bot Help & Guide</b>\n\n- <b>Getting Files:</b> Click the links provided to you.\n- <b>Referrals:</b> Share your link from /me to earn Premium.\n- <b>Premium:</b> Bypass verification and support the bot.\n\nNeed more help? Contact our support.`;
    await editTelegramMessage(chatId, messageId, helpText, {
      inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]]
    });
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

    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Developer'), url: 'tg://user?id=6998631274' }, { text: toSmallCaps('Help'), callback_data: 'user:help' }],
        [{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]
      ]
    });
  } else if (action === 'back_start') {
    if (admin) {
      const sessions = await getCollection('sessions');
      await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
      await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });
      await sessions.deleteOne({ _id: `admin:broadcast_draft:${chatId}` });
    }

    const s = await getSettings();
    let startMsg = s.startText || `👋 <b>Welcome to Filestore Bot!</b>\n\nI can store files and provide permanent sharing links. Use the buttons below or commands to explore.`;
    if (s.startText) {
      startMsg = s.startText
        .replace(/{mention}/g, `<a href="tg://user?id=${chatId}">${esc(from?.first_name || 'User')}</a>`)
        .replace(/{first_name}/g, esc(from?.first_name || ''))
        .replace(/{last_name}/g, esc(from?.last_name || ''));
    }

    const styledButtons = await buildStartMenuButtons(admin);

    if (s.startPhoto) {
      const { editTelegramCaption, deleteTelegramMessage, sendTelegramPhoto } = await import('../bot-common.js');
      const capRes = await editTelegramCaption(chatId, messageId, startMsg, { inline_keyboard: styledButtons });
      if (!capRes.ok) {
        await deleteTelegramMessage(chatId, messageId).catch(() => {});
        await sendTelegramPhoto(chatId, s.startPhoto, startMsg, { inline_keyboard: styledButtons });
      }
    } else {
      await editTelegramMessage(chatId, messageId, startMsg, { inline_keyboard: styledButtons });
    }
  }
  return res.status(200).send('OK');
}
