import {
  getCollection, getSettings, log, getToken, getMainToken, esc
} from '../bot-common.js';
import {
  getBotUsername, isBotAdmin, registerWebhook, setMyCommands
} from '../bot-helpers.js';
import { verifyTelegramWebhook } from '../auth.js';
import { validateEnv } from '../env-validator.js';
import {
  isBanned, isAdmin, upsertUser
} from '../bot-users.js';
import { handleUserCallback } from '../callbacks/user-callbacks.js';
import { handleAdminCallback } from '../callbacks/admin-callbacks.js';
import { processMessageUpdate } from '../commands/user.js';

export default async function handler(req, res) {
  const envCheck = validateEnv();
  if (!envCheck.ok) {
    return res.status(500).send(`Server misconfigured: ${envCheck.message}`);
  }

  if (req.method !== 'POST') return res.status(200).send('Filestore Bot is running');

  if (!verifyTelegramWebhook(req)) {
    log('warn', 'Rejected webhook request with invalid/missing secret token', {
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
    });
    return res.status(401).send('Unauthorized');
  }

  const { botContext } = await import('../bot-common.js');
  return botContext.run({ token: getMainToken() }, () => handleUpdate(req, res));
}

const registeredCommandsCache = new Set();

async function handleUpdate(req, res) {
  const token = getToken();
  const tokenPrefix = token ? token.slice(0, 10) : '';
  const sessions = await getCollection('sessions');

  if (tokenPrefix) {
    try {
      if (!registeredCommandsCache.has(tokenPrefix)) {
        const key = `bot:commands:registered:${tokenPrefix}`;
        const now = new Date();
        const existing = await sessions.findOne({ _id: key });
        let claimed = false;
        if (!existing || existing.expiresAt < now) {
          await sessions.updateOne(
            { _id: key },
            { $set: { val: '1', expiresAt: new Date(Date.now() + 3600 * 1000) } },
            { upsert: true }
          );
          claimed = true;
        }
        registeredCommandsCache.add(tokenPrefix);
        if (claimed) {
          setMyCommands().catch(err => log('error', 'Initial setMyCommands failed', { errorMessage: err.message }));
        }
      }
    } catch (err) {
      log('error', 'commandsSetAt check failed', { errorMessage: err.message });
    }
  }

  const update = req.body || {};

  if (update.chat_join_request) {
    const cjr = update.chat_join_request;
    const chatId = cjr.chat.id;
    const userId = cjr.from.id;
    const pendingKey = `fsub:pending:${chatId}:${userId}`;
    await sessions.updateOne(
      { _id: pendingKey },
      { $set: { val: '1', expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) } },
      { upsert: true }
    );
    return res.status(200).send('OK');
  }

  if (update.chat_member) {
    const cm = update.chat_member;
    const chatId = cm.chat.id;
    const userId = cm.new_chat_member?.user?.id;
    const status = cm.new_chat_member?.status;
    if (['member', 'administrator', 'creator'].includes(status)) {
      const pendingKey = `fsub:pending:${chatId}:${userId}`;
      await sessions.deleteOne({ _id: pendingKey });
    }
    return res.status(200).send('OK');
  }

  if (update.my_chat_member) {
    const mcm = update.my_chat_member;
    const chat = mcm.chat;
    const newStatus = mcm.new_chat_member?.status;
    const promoterId = mcm.from?.id;
    const { getAdminId } = await import('../bot-users.js');
    const adminId = getAdminId();

    if (newStatus === 'administrator' && chat.type === 'channel') {
      if (promoterId === adminId) {
        const { sendTelegramMessage } = await import('../bot-common.js');
        const channels = await getCollection('channels');
        await Promise.all([
          sendTelegramMessage(adminId, `✅ <b>Bot added as Admin!</b>\n\nI am now an administrator in <b>${esc(chat.title)}</b>.\n\nYou can now use /batch to create links from this channel.`),
          channels.updateOne(
            { _id: String(chat.id) },
            { $set: { title: chat.title, addedAt: new Date() } },
            { upsert: true }
          )
        ]);
      }
    }
    return res.status(200).send('OK');
  }

  if (update.callback_query) {
    const cq        = update.callback_query;
    const { id: cbId, data, from, message: msg } = cq;
    const chatId    = msg?.chat?.id;
    const messageId = msg?.message_id;
    const admin     = await isAdmin(chatId);

    if (data.startsWith('user:')) {
      const action = data.slice(5);
      return handleUserCallback(chatId, messageId, action, cq, from, msg, admin, res);
    }

    if (data.startsWith('admin:')) {
      if (!admin) return res.status(200).send('OK');

      const action = data.slice(6);
      return handleAdminCallback(chatId, messageId, action, cq, req, res);
    }

    if (data.startsWith('sub_check:')) {
      const { answerCallbackQuery, deleteTelegramMessage } = await import('../bot-common.js');
      const { checkSubscription } = await import('../bot-helpers.js');
      const payload = data.slice('sub_check:'.length);

      const sub = await checkSubscription(chatId, chatId);
      if (!sub.ok) {
        await answerCallbackQuery(cbId, "❌ You still haven't joined all the required channels.", true);
        return res.status(200).send('OK');
      }

      await answerCallbackQuery(cbId, '✅ Verified!');
      await deleteTelegramMessage(chatId, messageId);

      const { handleStartPayload } = await import('../commands/start.js');
      const pseudoMessage = { chat: msg.chat, from, message_id: messageId };
      return handleStartPayload(chatId, payload, pseudoMessage, admin, res);
    }

    return res.status(200).send('OK');
  }

  const { message } = update;
  if (!message?.chat?.id) return res.status(200).send('OK');

  const chatId   = message.chat.id;
  const rawText  = (message.text?.trim() || message.caption?.trim() || '');

  const admin = await isAdmin(chatId);
  if (await isBanned(chatId) && !admin) return res.status(200).send('OK');

  const { isRateLimited } = await import('../bot-common.js');
  if (!admin && await isRateLimited(chatId)) {
    log('warn', 'Rate limit exceeded', { chatId });
    return res.status(200).send('OK');
  }

  return processMessageUpdate(chatId, rawText, message, admin, req, res);
}
