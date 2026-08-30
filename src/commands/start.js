import crypto from 'crypto';
import {
  getCollection, getSettings, sendTelegramMessage, sendTelegramVideo, sendTelegramPhoto, editTelegramMessage, deleteTelegramMessage, toSmallCaps, getMainToken, esc, parseValidityHours
} from '../bot-common.js';
import {
  getBotUsername, getDbChannelId, checkSubscription, deliverBatch, getMainBotUsername
} from '../bot-helpers.js';
import { getBatch, getFile, getShortenedLink } from '../filestore.js';
import { hasPremium, getReferralStats, addReferral } from '../bot-users.js';

export async function handleStartPayload(chatId, payload, message, admin, res) {
  const botUsername = await getBotUsername();
  const sessions = await getCollection('sessions');

  // 1. Force Subscribe Check (skip if admin)
  if (!admin) {
    const sub = await checkSubscription(chatId, chatId);
    if (!sub.ok) {
      const s = await getSettings();
      const customMsg = s?.forceSubscribeMsg || '❌ <b>Access Denied!</b>\n\nYou must join our channels to use this bot.';

      const buttons = sub.notJoined.map(c => {
        const btnText = c.buttonLabel ? esc(c.buttonLabel) : `Join ${esc(c.title)}`;
        return [{
          text: toSmallCaps(btnText),
          url: c.inviteLink || `https://t.me/${String(c.id).replace('-100', '')}`
        }];
      });

      buttons.push([{ text: toSmallCaps('Try Again'), callback_data: `sub_check:${payload || ''}` }]);

      await sendTelegramMessage(chatId, customMsg, { inline_keyboard: buttons });
      return res.status(200).send('OK');
    }
  }

  if (payload && (payload.startsWith('batch_') || payload.startsWith('file_'))) {
    // Check if user has premium
    const premium = await hasPremium(chatId);

    if (premium) {
      await sendTelegramMessage(chatId, `✨ <b>You are free like a bird!</b> Premium access is active.`);
    }

    // 2. Token Verification Check (skip if admin or premium)
    if (!admin && !premium) {
      const s = await getSettings();
      const verEnabled = s?.enabled === '1';
      const tutorialFileId = s?.tutorialFileId;
      // NOTE: `parseValidityHours` treats 0 as a real, intentional value
      // (token must expire immediately -> re-verify every time), unlike the
      // old `parseInt(s?.validityHours) || 24` which silently turned 0 into 24.
      const validityHours = parseValidityHours(s?.validityHours);

      const userTokenDoc = await sessions.findOne({ _id: `user:token:main:${chatId}` });
      const hasUserToken = userTokenDoc && userTokenDoc.expiresAt > new Date();

      if (verEnabled && !hasUserToken) {
        const tkn = crypto.randomBytes(16).toString('hex');
        await sessions.updateOne(
          { _id: `verify:tkn:${tkn}` },
          { $set: { val: { payload, validityHours }, expiresAt: new Date(Date.now() + 600 * 1000) } },
          { upsert: true }
        );
        const target = `https://t.me/${botUsername}?start=verify_${tkn}`;
        const short = await getShortenedLink(target);
        const kb = { inline_keyboard: [[{ text: toSmallCaps('Verify Token'), url: short || target }]] };
        const text = `<blockquote>🔐 <b>Verification Required</b>\n\nPlease complete the token verification link below to access your requested file(s). Verification is valid for <b>${validityHours} hours</b>.</blockquote>`;
        const protect = s?.protectContent === '1';
        if (tutorialFileId) await sendTelegramVideo(chatId, tutorialFileId, text, kb, protect);
        else await sendTelegramMessage(chatId, text, kb, protect);
        return res.status(200).send('OK');
      }
    }
  }

  if (payload?.startsWith('batch_')) {
    const b = await getBatch(payload);
    if (!b) {
      const s = await getSettings();
      await sendTelegramMessage(chatId, `❌ Not found.`, null, s?.protectContent === '1');
      return res.status(200).send('OK');
    }
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
    const s = await getSettings();
    await deliverBatch(chatId, b, s?.protectContent === '1');
    await deleteTelegramMessage(chatId, loadingMsg.messageId);
    return res.status(200).send('OK');
  }

  if (payload === 'setting' && admin) {
    const text = `<b>Admin Dashboard</b>\n\nSelect a category to manage the bot:`;
    await sendTelegramMessage(chatId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Statistics'), callback_data: 'admin:stats' }, { text: toSmallCaps('Broadcast'), callback_data: 'admin:broadcast_prompt' }],
        [{ text: toSmallCaps('User Control'), callback_data: 'admin:user_mgmt' }, { text: toSmallCaps('File Control'), callback_data: 'admin:file_mgmt' }],
        [{ text: toSmallCaps('Settings'), callback_data: 'admin:fs_settings' }],
        [{ text: toSmallCaps('Back to Main Menu'), callback_data: 'user:back_start' }],
      ]
    });
    return res.status(200).send('OK');
  }

  if (payload?.startsWith('file_')) {
    const f = await getFile(payload);
    const s = await getSettings();
    const protect = s?.protectContent === '1';
    if (f) {
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

      const { scheduleAutoDelete } = await import('../bot-helpers.js');
      let sentMsgId = null;

      if (f.dbChannelId && f.dbMessageId) {
        const { copyFromDbChannel } = await import('../bot-helpers.js');
        const resCopy = await copyFromDbChannel(chatId, f.dbChannelId, f.dbMessageId, protect);
        if (resCopy?.ok && resCopy?.messageId) sentMsgId = resCopy.messageId;
      } else {
        let resSend;
        if (f.type === 'video') resSend = await sendTelegramVideo(chatId, f.fileId, '', null, protect);
        else if (f.type === 'document') resSend = await sendTelegramDocument(chatId, f.fileId, '', null, protect);
        else if (f.type === 'audio') resSend = await sendTelegramAudio(chatId, f.fileId, '', null, protect);
        else if (f.type === 'photo') resSend = await sendTelegramPhoto(chatId, f.fileId, '', null, protect);
        if (resSend?.result?.message_id) sentMsgId = resSend.result.message_id;
      }

      if (sentMsgId) {
        await scheduleAutoDelete(chatId, [sentMsgId]);
      }

      await deleteTelegramMessage(chatId, loadingMsg.messageId);
    } else {
      await sendTelegramMessage(chatId, `❌ Not found.`);
    }
    return res.status(200).send('OK');
  }

  let startMsg = `👋 <b>Welcome to Filestore Bot!</b>\n\nI can store files and provide permanent sharing links. Use the buttons below or commands to explore.`;
  let startPhoto = null;

  const s = await getSettings();
  if (s.startText) {
    startMsg = s.startText
      .replace(/{mention}/g, `<a href="tg://user?id=${chatId}">${esc(message.from?.first_name || 'User')}</a>`)
      .replace(/{first_name}/g, esc(message.from?.first_name || ''))
      .replace(/{last_name}/g, esc(message.from?.last_name || ''));
  }
  if (s.startPhoto) startPhoto = s.startPhoto;

  const buttons = [
    [{ text: 'My Profile', callback_data: 'user:me' }, { text: 'About', callback_data: 'user:about' }]
  ];
  if (admin) {
    buttons.unshift([{ text: 'Admin Dashboard', callback_data: 'admin:dashboard' }]);
  }

  const styledButtons = buttons.map(row => row.map(btn => ({ ...btn, text: toSmallCaps(btn.text) })));

  if (startPhoto) {
    await sendTelegramPhoto(chatId, startPhoto, startMsg, { inline_keyboard: styledButtons });
  } else {
    await sendTelegramMessage(chatId, startMsg, { inline_keyboard: styledButtons });
  }
  return res.status(200).send('OK');
}
