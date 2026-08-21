import {
  getCollection, getSettings, sendTelegramMessage, editTelegramMessage, deleteTelegramMessage, toSmallCaps, getMainToken, esc
} from '../bot-common.js';
import {
  getBotUsername, getDbChannelId, checkSubscription, isBotAdmin, extractChannelMessage, copyIntoDbChannel, copyFromDbChannel, getMainBotUsername, resolveUser
} from '../bot-helpers.js';
import {
  getBatchSession, setBatchSession, addIdToBatch, clearBatchSession, updateBatchSessionMeta, checkAndClearAdminWaiting, setAdminWaitingForFile, storeFile, generateFileCode
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
          await addReferral(referrerId, chatId);
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
      const { payload: originalPayload, validityHours } = rawV;

      const tokenKey = `user:token:main:${chatId}`;
      const expiresAt = new Date(Date.now() + (validityHours || 24) * 3600 * 1000);
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
    await sendTelegramMessage(chatId, `📊 <b>Stats</b>\n\nUsers: ${s.totalUsers}\nLinks: ${s.filestoreLinks}`);
    return res.status(200).send('OK');
  }

  if (/^\/broadcast\s+/i.test(rawText) && admin) {
    const t = rawText.split(/\s+/).slice(1).join(' ');
    const { sent } = await broadcastToAll(t);
    await sendTelegramMessage(chatId, `✅ Sent to ${sent} users.`);
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

  if (/^\/setting/i.test(rawText) && admin) {
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

  if (/^\/adminhelp/i.test(rawText) && admin) {
    let helpText = `🛠 <b>Admin Dashboard</b>\n\nYou can manage all bot features through the interactive dashboard. Click the button below to open it.`;
    let kb = { inline_keyboard: [[{ text: '🛠 Open Dashboard', callback_data: 'admin:dashboard' }]] };
    await sendTelegramMessage(chatId, helpText, kb);
    return res.status(200).send('OK');
  }

  if (/^\/ping/i.test(rawText)) {
    const start = Date.now();
    const msg = await sendTelegramMessage(chatId, `🏓 Pinging...`);
    if (msg.ok) {
      await editTelegramMessage(chatId, msg.messageId, `🏓 Pong!\nLatency: <b>${Date.now() - start}ms</b>`);
    }
    return res.status(200).send('OK');
  }

  if (/^\/me/i.test(rawText)) {
    const cs = await getSettings();

    if (cs.referralDisabled === '1') {
       await sendTelegramMessage(chatId, `👤 <b>Your Profile</b>\n\n🆔 ID: <code>${chatId}</code>\n<i>Referral system is disabled on this bot.</i>`);
       return res.status(200).send('OK');
    }

    const refs = await getReferralStats(chatId);
    const premium = await hasPremium(chatId);
    let premiumText = '❌ Standard';
    if (premium) {
      const user = await users.findOne({ _id: String(chatId) });
      const globalTtl = user && user.premiumUntil ? Math.round((new Date(user.premiumUntil).getTime() - Date.now()) / 1000) : 0;
      premiumText = `✅ Premium (${globalTtl > 0 ? Math.ceil(globalTtl / (24 * 3600)) : 'Lifetime'} days left)`;
    }
    const botUsername = await getBotUsername();
    const refLink = `https://t.me/${botUsername}?start=ref_${chatId}`;
    const text = `👤 <b>Your Profile</b>\n\n🆔 ID: <code>${chatId}</code>\n🌟 Status: <b>${premiumText}</b>\n👥 Referrals: <b>${refs}</b>\n\n🔗 <b>Your Referral Link:</b>\n<code>${refLink}</code>\n\n<i>Share this link to earn Premium access! 3 referrals = 24h Premium.</i>`;
    await sendTelegramMessage(chatId, text);
    return res.status(200).send('OK');
  }

  if (/^\/help/i.test(rawText)) {
    const helpText = `📖 <b>Bot Help & Guide</b>\n\n- <b>Getting Files:</b> Click the links provided to you.\n- <b>Referrals:</b> Share your link from /me to earn Premium.\n- <b>Premium:</b> Bypass verification and support the bot.\n\nNeed more help? Contact our support.`;
    await sendTelegramMessage(chatId, helpText);
    return res.status(200).send('OK');
  }

  return res.status(200).send('OK');
}
