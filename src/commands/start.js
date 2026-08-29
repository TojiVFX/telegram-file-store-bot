import crypto from 'crypto';
import {
  getCollection, getSettings, sendTelegramMessage, sendTelegramVideo, sendTelegramPhoto, sendTelegramDocument, sendTelegramAudio, editTelegramMessage, deleteTelegramMessage, toSmallCaps, esc
} from '../bot-common.js';
import {
  getBotUsername, deliverBatch, getAdminDashboardKeyboard, buildStartMenuButtons, buildForceSubscribeGate, showLoadingAnimation
} from '../bot-helpers.js';
import { getBatch, getFile, getShortenedLink } from '../filestore.js';
import { hasPremium, getReferralStats, addReferral } from '../bot-users.js';

export async function handleStartPayload(chatId, payload, message, admin, res) {
  const botUsername = await getBotUsername();
  const sessions = await getCollection('sessions');

  // 1. Force Subscribe Check (skip if admin)
  if (!admin) {
    const gate = await buildForceSubscribeGate(chatId, payload);
    if (gate) {
      await sendTelegramMessage(chatId, gate.text, gate.replyMarkup);
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
      const validityHours = parseInt(s?.validityHours) || 24;

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
    const loadingMsg = await showLoadingAnimation(chatId);
    const s = await getSettings();
    await deliverBatch(chatId, b, s?.protectContent === '1');
    await deleteTelegramMessage(chatId, loadingMsg.messageId);
    return res.status(200).send('OK');
  }

  if (payload === 'setting' && admin) {
    const text = `<b>Admin Dashboard</b>\n\nSelect a category to manage the bot:`;
    await sendTelegramMessage(chatId, text, getAdminDashboardKeyboard());
    return res.status(200).send('OK');
  }

  if (payload?.startsWith('file_')) {
    const f = await getFile(payload);
    const s = await getSettings();
    const protect = s?.protectContent === '1';
    if (f) {
      const loadingMsg = await showLoadingAnimation(chatId);

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

  const styledButtons = await buildStartMenuButtons(admin);

  if (startPhoto) {
    await sendTelegramPhoto(chatId, startPhoto, startMsg, { inline_keyboard: styledButtons });
  } else {
    await sendTelegramMessage(chatId, startMsg, { inline_keyboard: styledButtons });
  }
  return res.status(200).send('OK');
}
