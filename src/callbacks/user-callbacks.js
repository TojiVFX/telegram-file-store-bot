import { getCollection, getSettings, getDb, toSmallCaps, esc } from '../bot-common.js';
import { getBotUsername, getForceSubChannelsList } from '../bot-helpers.js';
import { editTelegramMessage, answerCallbackQuery, deleteTelegramMessage } from '../bot-common.js';
import { handleStartPayload } from '../commands/start.js';

export async function handleUserCallback(chatId, messageId, action, cq, from, msg, admin, res) {
  // Answer instantly to dismiss the button loading spinner immediately
  answerCallbackQuery(cq.id).catch(() => {});

  const botId = await getCurrentBotId();
  const botUsername = await getBotUsername();
  const cs = await getSettings();

  // 1. Force Subscribe Check (skip if admin)
  if (!admin) {
    const { checkSubscription } = await import('../bot-helpers.js');
    const sub = await checkSubscription(chatId, chatId);
    if (!sub.ok) {
      const customMsg = cs?.forceSubscribeMsg || '❌ <b>Access Denied!</b>\n\nYou must join our channels to use this bot.';

      const buttons = sub.notJoined.map(c => {
        const btnText = c.buttonLabel ? esc(c.buttonLabel) : `Join ${esc(c.title)}`;
        return [{
          text: toSmallCaps(btnText),
          url: c.inviteLink || `https://t.me/${String(c.id).replace('-100', '')}`
        }];
      });

      buttons.push([{ text: toSmallCaps('Try Again'), callback_data: `sub_check:` }]);

      const styledButtons = buttons.map(row => row.map(btn => {
        if ('callback_data' in btn && btn.callback_data) {
          return { ...btn, text: toSmallCaps(btn.text) };
        }
        return btn;
      }));

      await editTelegramMessage(chatId, messageId, customMsg, { inline_keyboard: styledButtons });
      return res.status(200).send('OK');
    }
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
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'user:back_start' }]]
    });
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
    const s = await getSettings();
    let startMsg = s.startText || `👋 <b>Welcome to Filestore Bot!</b>\n\nI can store files and provide permanent sharing links. Use the buttons below or commands to explore.`;
    if (s.startText) {
      startMsg = s.startText
        .replace(/{mention}/g, `<a href="tg://user?id=${chatId}">${esc(from?.first_name || 'User')}</a>`)
        .replace(/{first_name}/g, esc(from?.first_name || ''))
        .replace(/{last_name}/g, esc(from?.last_name || ''));
    }

    const { isMainBot } = await import('../bot-common.js');
    const { getMainBotUsername } = await import('../bot-helpers.js');
    const buttons = [
      [{ text: 'My Profile', callback_data: 'user:me' }, { text: 'About', callback_data: 'user:about' }]
    ];
    if (admin) {
      if (isMainBot()) {
        buttons.unshift([{ text: 'Admin Dashboard', callback_data: 'admin:dashboard' }]);
      } else if (botId) {
        const mainBotUsername = await getMainBotUsername();
        buttons.unshift([{ text: 'Clone Dashboard', url: `https://t.me/${mainBotUsername}?start=clone_view_${botId}` }]);
      }
    }
    const styledButtons = buttons.map(row => row.map(btn => ({ ...btn, text: toSmallCaps(btn.text) })));
    await editTelegramMessage(chatId, messageId, startMsg, { inline_keyboard: styledButtons });
  }
  return res.status(200).send('OK');
}

async function getCurrentBotId() {
  const { getCurrentBotId: helperGetBotId } = await import('../bot-common.js');
  return helperGetBotId();
}
