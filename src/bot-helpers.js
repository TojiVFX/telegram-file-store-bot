import {
  getCollection, getSettings, log, esc, getToken, isRateLimited,
  sendTelegramMessage, sendTelegramDocument, sendTelegramVideo,
  sendTelegramAudio, sendTelegramPhoto,
  editTelegramMessage,
  answerCallbackQuery, sendChatAction,
  deleteTelegramMessage,
  getChatMember, getChat,
  createChatInviteLink,
  botContext, logHistory,
  toSmallCaps,
  getWebhookSecret,
  getMainToken,
} from './bot-common.js';

export const GROUP_TYPES = new Set(['group', 'supergroup']);

// ─── DB channel & Bot Helpers ─────────────────────────────────────────────────
export async function getDbChannelId() {
  const s = await getSettings();
  if (s?.dbChannelId) return Number(s.dbChannelId);

  const raw = (process.env.TELEGRAM_DB_CHANNEL_ID || '').trim();
  return raw ? Number(raw) : null;
}

export async function getBotId() {
  const token = getToken();
  return token.split(':')[0];
}

export async function isBotAdmin(channelId) {
  if (!channelId) return false;
  const botId = await getBotId();
  const res = await getChatMember(channelId, botId);
  if (res.ok) {
    const status = res.result?.status;
    // Must be admin or creator
    return ['administrator', 'creator'].includes(status);
  }
  return false;
}

// ─── Bot username cache ───────────────────────────────────────────────────────
const botUsernameCache = new Map();

export async function getBotUsername(customToken = null) {
  const token = customToken || getToken();
  if (!token) return null;

  const tokenPrefix = token.slice(0, 10);
  if (botUsernameCache.has(tokenPrefix)) {
    const cached = botUsernameCache.get(tokenPrefix);
    const ctx = botContext.getStore();
    if (!customToken && ctx) ctx.username = cached;
    return cached;
  }

  const ctx = botContext.getStore();
  if (!customToken && ctx?.username) {
    botUsernameCache.set(tokenPrefix, ctx.username);
    return ctx.username;
  }

  try {
    const sessions = await getCollection('sessions');
    const cacheKey = `bot:username:${tokenPrefix}`;
    const cacheDoc = await sessions.findOne({ _id: cacheKey });
    const cached = cacheDoc && cacheDoc.expiresAt > new Date() ? cacheDoc.val : null;

    if (cached) {
      botUsernameCache.set(tokenPrefix, cached);
      if (!customToken && ctx) ctx.username = cached;
      return cached;
    }

    const res  = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    if (data.ok) {
      const username = (data.result.username || '').toLowerCase();
      botUsernameCache.set(tokenPrefix, username);
      if (!customToken && ctx) ctx.username = username;
      // Cache for 1 hour
      await sessions.updateOne(
        { _id: cacheKey },
        { $set: { val: username, expiresAt: new Date(Date.now() + 3600 * 1000) } },
        { upsert: true }
      );
      return username;
    }
  } catch (err) {
    log('error', 'getBotUsername failed', { errorMessage: err.message });
  }
  return null;
}

export async function getMainBotUsername() {
  const mainToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^bot/i, '');
  return await getBotUsername(mainToken);
}

// ─── Text helpers ─────────────────────────────────────────────────────────────
export function isCommand(text)                 { return /^\/[a-z_]+(@\S+)?(\s|$)/i.test(text); }
export function mentionsBot(text, botUsername)  { return botUsername && text.toLowerCase().includes(`@${botUsername}`); }

/**
 * Resolves a user ID from either a numeric ID or a @username.
 */
export async function resolveUser(input) {
  if (!input) return null;
  const clean = input.trim();
  if (/^\d+$/.test(clean)) return clean;

  const username = clean.startsWith('@') ? clean.slice(1) : clean;
  const users = await getCollection('users');

  // Try direct username lookup on the users collection (using index)
  const user = await users.findOne({ username: username.toLowerCase() });
  if (user) return user._id;

  // Try getChat (only works if it's a public username)
  try {
    const token = getToken();
    const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: `@${username}` }),
    });
    const data = await res.json();
    if (data.ok && data.result?.id) {
      const targetId = String(data.result.id);
      // Upsert user into users table with username
      await users.updateOne(
        { _id: targetId },
        { $set: { username: username.toLowerCase() } },
        { upsert: true }
      );
      return targetId;
    }
  } catch (err) {
    log('error', 'resolveUser: getChat failed', { username, errorMessage: err.message });
  }

  return null;
}

// ─── copyMessage ──────────────────────────────────────────────────────────────
export async function copyMessage(toChatId, fromChatId, msgId, protectContent = false) {
  const token = getToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/copyMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: toChatId, from_chat_id: fromChatId, message_id: msgId, protect_content: protectContent }),
    });
    const data = await response.json();
    if (!response.ok) {
      log('error', 'copyMessage failed', { toChatId, fromChatId, msgId, telegramError: data });
      return { ok: false, reason: data.description || 'unknown_error' };
    }
    return { ok: true, messageId: data.result?.message_id };
  } catch (err) {
    log('error', 'copyMessage network error', { errorMessage: err.message, msgId });
    return { ok: false, reason: 'network_error' };
  }
}

export async function copyIntoDbChannel(dbChannelId, fromChatId, msgId, protectContent = false) {
  return botContext.run({ token: getMainToken() }, () => copyMessage(dbChannelId, fromChatId, msgId, protectContent));
}

export async function copyFromDbChannel(toChatId, dbChannelId, msgId, protectContent = false) {
  return botContext.run({ token: getMainToken() }, () => copyMessage(toChatId, dbChannelId, msgId, protectContent));
}

// ─── extractChannelMessage ────────────────────────────────────────────────────
export async function extractChannelMessage(message) {
  if (message.forward_from_chat?.type === 'channel') {
    return {
      channelId: message.forward_from_chat.id,
      msgId:     message.forward_from_message_id,
    };
  }
  if (message.forward_origin?.type === 'channel') {
    return {
      channelId: message.forward_origin.chat?.id,
      msgId:     message.forward_origin.message_id,
    };
  }
  const text = (message.text || message.caption || '').trim();
  const privateMatch = text.match(/t\.me\/c\/(\d+)\/(\d+)/);
  if (privateMatch) {
    return {
      channelId: Number(`-100${privateMatch[1]}`),
      msgId:     parseInt(privateMatch[2], 10),
    };
  }
  const publicMatch = text.match(/t\.me\/([a-zA-Z][a-zA-Z0-9_]{3,})\/(\d+)/);
  if (publicMatch && publicMatch[1] !== 'c') {
    const username = publicMatch[1];
    const msgId    = parseInt(publicMatch[2], 10);
    const token    = getToken();
    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ chat_id: `@${username}` }),
      });
      const data = await resp.json();
      if (data.ok && data.result?.type === 'channel') {
        return { channelId: data.result.id, msgId };
      }
    } catch (err) {
      log('error', 'extractChannelMessage: getChat failed', { username, errorMessage: err.message });
    }
  }
  return null;
}

export function getForceSubChannelsList(forceSubscribeChannelsRaw, globalMode = 'normal') {
  if (!forceSubscribeChannelsRaw) {
    return [];
  }

  if (Array.isArray(forceSubscribeChannelsRaw)) {
    return forceSubscribeChannelsRaw.filter(
      c => c && c.id && String(c.id).trim() !== '[object Object]' && String(c.id).trim() !== ''
    );
  }
  if (typeof forceSubscribeChannelsRaw === 'object') {
    return [];
  }

  const str = String(forceSubscribeChannelsRaw).trim();
  if (!str || str === '[object Object]') {
    return [];
  }
  let channels = [];
  if (str.startsWith('[')) {
    try {
      channels = JSON.parse(str);
    } catch (_) {
      // fallback
    }
  }
  if (!Array.isArray(channels) || !channels.length) {
    channels = str.split(',').map(id => id.trim()).filter(Boolean).map(id => ({
      id,
      title: id,
      mode: globalMode
    }));
  }

  return channels.filter(c => c && c.id && String(c.id).trim() !== '[object Object]' && String(c.id).trim() !== '');
}

export async function checkSubscription(chatId, userId) {
  return botContext.run({ token: getMainToken() }, async () => {
    let s = await getSettings();
    const sessions = await getCollection('sessions');

    const globalMode = s?.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(s?.forceSubscribeChannels, globalMode);
    if (!channels.length) return { ok: true };

    const notJoined = [];

    for (const chan of channels) {
      const cid = chan.id;
      const mode = chan.mode || globalMode || 'normal';
      try {
        const res = await getChatMember(cid, userId);

        if (!res.ok) {
          log('error', 'checkSubscription: getChatMember failed', { cid, userId, res });
        }
        const status = res.ok ? res.result?.status : null;
        const isMember = ['creator', 'administrator', 'member'].includes(status);

        if (!isMember) {
          if (mode === 'join_request') {
            const pendingKey = `fsub:pending:${cid}:${userId}`;
            const pendingDoc = await sessions.findOne({ _id: pendingKey });
            const pending = pendingDoc && pendingDoc.expiresAt > new Date() ? pendingDoc.val : null;
            if (pending === '1') continue;
          }

          const chatRes = await getChat(cid);
          const title = chan.title || (chatRes.ok ? chatRes.result.title : cid);

          let inviteLink = null;
          const cacheKey = `fsub:link:main:${cid}:${mode}`;
          const cacheDoc = await sessions.findOne({ _id: cacheKey });
          inviteLink = cacheDoc && cacheDoc.expiresAt > new Date() ? cacheDoc.val : null;

          if (!inviteLink) {
            const createsJoinRequest = (mode === 'join_request');
            const linkRes = await createChatInviteLink(cid, createsJoinRequest);
            if (linkRes.ok && linkRes.result?.invite_link) {
              inviteLink = linkRes.result.invite_link;
              await sessions.updateOne(
                { _id: cacheKey },
                { $set: { val: inviteLink, expiresAt: new Date(Date.now() + 24 * 3600 * 1000) } },
                { upsert: true }
              );
            } else {
              inviteLink = chatRes.ok ? chatRes.result.invite_link : null;
            }
          }

          notJoined.push({
            id: cid,
            title: title,
            inviteLink: inviteLink
          });
        }
      } catch (err) {
        log('error', 'checkSubscription error', { cid, userId, errorMessage: err.message });
      }
    }

    if (notJoined.length > 0) {
      return { ok: false, notJoined };
    }
    return { ok: true };
  });
}

// ─── deliverBatch ─────────────────────────────────────────────────────────────
export async function deliverBatch(toChatId, batch, protectContent = false) {
  const { dbChannelId, dbMessageIds, dbFirstMsgId, dbLastMsgId } = batch;
  if (Array.isArray(dbMessageIds)) {
    const count = dbMessageIds.length;
    for (const msgId of dbMessageIds) {
      await copyFromDbChannel(toChatId, dbChannelId, msgId, protectContent);
      if (count > 5) await new Promise((r) => setTimeout(r, 50));
    }
  }
  else if (dbFirstMsgId && dbLastMsgId) {
    const count = dbLastMsgId - dbFirstMsgId + 1;
    for (let msgId = dbFirstMsgId; msgId <= dbLastMsgId; msgId++) {
      await copyFromDbChannel(toChatId, dbChannelId, msgId, protectContent);
      if (count > 5) await new Promise((r) => setTimeout(r, 50));
    }
  }
}

export async function registerWebhook(token, webhookUrl) {
  const body = {
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query', 'chat_join_request', 'chat_member', 'my_chat_member'],
  };
  const secret = getWebhookSecret();
  if (secret) body.secret_token = secret;
  else log('error', 'registerWebhook: TELEGRAM_WEBHOOK_SECRET is not set — webhook registered without secret_token');

  return fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── setMyCommands ────────────────────────────────────────────────────────────
export async function setMyCommands() {
  const token   = getToken();
  const adminId = (process.env.ADMIN_CHAT_ID || '').trim();
  if (!token) return;

  const userCommands = [
    { command: 'start',       description: toSmallCaps('Open the main menu') },
    { command: 'me',          description: toSmallCaps('View your profile & referral link') },
    { command: 'ping',        description: toSmallCaps('Check bot latency') },
    { command: 'help',        description: toSmallCaps('How to use this bot') },
  ];

  try {
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: userCommands }),
    });

    if (adminId) {
      const adminCommands = [
        ...userCommands,
        { command: 'userstats',  description: toSmallCaps('User & filestore statistics (admin)') },
        { command: 'ban',        description: toSmallCaps('Ban a user by chat ID (admin)') },
        { command: 'unban',      description: toSmallCaps('Unban a user by chat ID (admin)') },
        { command: 'banlist',    description: toSmallCaps('List all banned users (admin)') },
        { command: 'broadcast',  description: toSmallCaps('Send a message to all users (admin)') },
        { command: 'batch',      description: toSmallCaps('Create a batch link from a channel range (admin)') },
        { command: 'store',      description: toSmallCaps('Store a single file (admin)') },
        { command: 'setting',    description: toSmallCaps('Open admin dashboard (admin)') },
        { command: 'adminhelp',  description: toSmallCaps('Admin command reference') },
      ];
      await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands: adminCommands,
          scope: { type: 'chat', chat_id: Number(adminId) },
        }),
      });
    }
  } catch (err) {
    log('error', 'setMyCommands failed', { errorMessage: err.message });
  }
}
