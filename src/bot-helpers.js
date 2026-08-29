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
  isMainBot,
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

// ─── DB channel readiness ──────────────────────────────────────────────────────
// Shared by /batch, /store, and their admin-dashboard button equivalents
// (admin:batch_start, admin:store_start) so the two entry points can't drift.
// Previously the dashboard buttons skipped this check entirely, letting an
// admin forward files for minutes before discovering no DB channel was set.
// Returns null when everything is ready, or an HTML error string to display.
export async function getDbChannelReadinessError() {
  const dbChannelId = await getDbChannelId();
  if (!dbChannelId) {
    const mainBotUsername = await getMainBotUsername();
    const setLink = `https://t.me/${mainBotUsername}?start=setting`;
    return `❌ <b>Database Channel not set!</b>\n\nPlease configure your DB Channel ID in the bot settings first.\n\n<a href="${setLink}">⚙️ Open Settings</a>`;
  }
  if (!(await isBotAdmin(dbChannelId))) {
    return `❌ <b>Permissions Required!</b>\n\nI am not an administrator in the DB channel (<code>${dbChannelId}</code>) or I don't have permission to post messages.\n\n<b>To fix this:</b>\n1. Add this bot as an Admin in your DB channel.\n2. Ensure 'Post Messages' permission is enabled.`;
  }
  return null;
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

// ─── Shared UI builders ───────────────────────────────────────────────────────
// Centralized so the admin dashboard and start-menu keyboards can't drift out
// of sync across the different entry points that render them: the /setting
// command, /start?start=setting payload, and the admin:dashboard callback for
// the dashboard; and the initial /start vs. the "Back" button for the start
// menu. Previously each entry point rebuilt these inline and went stale
// independently (e.g. one was missing the "Security & Auto Delete" button;
// another skipped the multi-bot clone-dashboard branch).

export function getAdminDashboardKeyboard() {
  return {
    inline_keyboard: [
      [{ text: toSmallCaps('Statistics'), callback_data: 'admin:stats' }, { text: toSmallCaps('Broadcast'), callback_data: 'admin:broadcast_prompt' }],
      [{ text: toSmallCaps('User Control'), callback_data: 'admin:user_mgmt' }, { text: toSmallCaps('File Control'), callback_data: 'admin:file_mgmt' }],
      [{ text: toSmallCaps('Security & Auto Delete'), callback_data: 'admin:auto_del_mgmt' }, { text: toSmallCaps('Settings'), callback_data: 'admin:fs_settings' }],
      [{ text: toSmallCaps('Back to Main Menu'), callback_data: 'user:back_start' }],
    ]
  };
}

export async function buildStartMenuButtons(admin) {
  const buttons = [
    [{ text: 'My Profile', callback_data: 'user:me' }, { text: 'About', callback_data: 'user:about' }]
  ];
  if (admin) {
    if (isMainBot()) {
      buttons.unshift([{ text: 'Admin Dashboard', callback_data: 'admin:dashboard' }]);
    } else {
      const botId = await getBotId();
      if (botId) {
        const mainBotUsername = await getMainBotUsername();
        buttons.unshift([{ text: 'Clone Dashboard', url: `https://t.me/${mainBotUsername}?start=clone_view_${botId}` }]);
      }
    }
  }
  return buttons.map(row => row.map(btn => ({ ...btn, text: toSmallCaps(btn.text) })));
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

// ─── Force subscribe gate ───────────────────────────────────────────────────────
// Shared by /start and the user: callback handler, both of which need to show
// the same "join these channels" gate. Returns null when the user already has
// access; otherwise { text, replyMarkup } ready to hand straight to
// sendTelegramMessage/editTelegramMessage. `payload` (when present) is baked
// into the "Try Again" callback_data so retrying can resume wherever the user
// was headed, instead of falling back to the plain /start screen.
export async function buildForceSubscribeGate(chatId, payload = '') {
  const sub = await checkSubscription(chatId, chatId);
  if (sub.ok) return null;

  const s = await getSettings();
  const text = s?.forceSubscribeMsg || '❌ <b>Access Denied!</b>\n\nYou must join our channels to use this bot.';

  const buttons = sub.notJoined.map(c => {
    const btnText = c.buttonLabel ? esc(c.buttonLabel) : `Join ${esc(c.title)}`;
    return [{
      text: toSmallCaps(btnText),
      url: c.inviteLink || `https://t.me/${String(c.id).replace('-100', '')}`
    }];
  });

  buttons.push([{ text: toSmallCaps('Try Again'), callback_data: `sub_check:${payload || ''}` }]);

  return { text, replyMarkup: { inline_keyboard: buttons } };
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

// ─── Loading animation ──────────────────────────────────────────────────────────
// Shared "Files are loading..." progress bar used by both batch delivery and
// single-file delivery in start.js. Returns the loading message so the caller
// can delete it once the actual file(s) have been sent.
export async function showLoadingAnimation(chatId) {
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
  return loadingMsg;
}

// ─── deliverBatch ─────────────────────────────────────────────────────────────
export async function deliverBatch(toChatId, batch, protectContent = false) {
  const { dbChannelId, dbMessageIds, dbFirstMsgId, dbLastMsgId } = batch;
  const sentMessageIds = [];

  if (Array.isArray(dbMessageIds)) {
    const count = dbMessageIds.length;
    for (const msgId of dbMessageIds) {
      const res = await copyFromDbChannel(toChatId, dbChannelId, msgId, protectContent);
      if (res?.ok && res?.messageId) sentMessageIds.push(res.messageId);
      if (count > 5) await new Promise((r) => setTimeout(r, 50));
    }
  }
  else if (dbFirstMsgId && dbLastMsgId) {
    const count = dbLastMsgId - dbFirstMsgId + 1;
    for (let msgId = dbFirstMsgId; msgId <= dbLastMsgId; msgId++) {
      const res = await copyFromDbChannel(toChatId, dbChannelId, msgId, protectContent);
      if (res?.ok && res?.messageId) sentMessageIds.push(res.messageId);
      if (count > 5) await new Promise((r) => setTimeout(r, 50));
    }
  }

  await scheduleAutoDelete(toChatId, sentMessageIds);
  return sentMessageIds;
}

export async function scheduleAutoDelete(chatId, messageIds) {
  if (!messageIds || (Array.isArray(messageIds) && messageIds.length === 0)) return;

  const s = await getSettings();
  if (s?.autoDeleteEnabled !== '1') return;

  const timerSeconds = parseInt(s?.autoDeleteTimer, 10) || 300; // default 5 mins
  const ms = timerSeconds * 1000;
  const ids = Array.isArray(messageIds) ? messageIds : [messageIds];

  const formatTimerLabel = (sec) => {
    if (sec < 60) return `${sec} seconds`;
    if (sec < 3600) return `${Math.round(sec / 60)} minute(s)`;
    return `${Math.round(sec / 3600)} hour(s)`;
  };

  const timerLabel = formatTimerLabel(timerSeconds);

  const warnMsg = await sendTelegramMessage(chatId, `⚠️ <b>Note:</b> These file(s) will be automatically deleted in <b>${timerLabel}</b>!`);
  if (warnMsg?.ok && warnMsg?.messageId) ids.push(warnMsg.messageId);

  setTimeout(async () => {
    for (const msgId of ids) {
      await deleteTelegramMessage(chatId, msgId).catch(() => {});
    }
  }, ms);
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
