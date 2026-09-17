import {
  getCollection, getSettings, log, esc, getToken,
  sendTelegramMessage, getChatMember, getChat,
  createChatInviteLink, botContext, toSmallCaps,
  formatISTDateTime, getMainToken
} from './bot-common.js';
import { getAdminIds } from './auth.js';
import { logActivity } from './bot-logs.js';
import { getForceSubChannelsList } from './force-subscribe.js';

let channelFailoverHandler = null;

export function registerChannelFailoverHandler(handler) {
  channelFailoverHandler = handler;
}

export function triggerChannelFailover(reason) {
  if (typeof channelFailoverHandler === 'function') {
    return channelFailoverHandler(reason);
  }
}

// ─── DB channel & Bot Helpers ─────────────────────────────────────────────────
export async function getDbChannelId() {
  const s = await getSettings();
  if (s?.dbChannelId) return Number(s.dbChannelId);

  const raw = (process.env.TELEGRAM_DB_CHANNEL_ID || '').trim();
  return raw ? Number(raw) : null;
}

export async function getBackupDbChannelId() {
  const s = await getSettings();
  if (s?.backupDbChannelId) return Number(s.backupDbChannelId);

  const raw = (process.env.TELEGRAM_BACKUP_DB_CHANNEL_ID || process.env.BACKUP_DB_CHANNEL_ID || '').trim();
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
    const member = res.result;
    const status = member?.status;
    if (status === 'creator') return true;
    if (status === 'administrator') {
      return member.can_post_messages !== false;
    }
  }
  return false;
}

/**
 * Resolves a channel or chat ID from a forwarded message or typed ID string,
 * validates Telegram ID format, and optionally verifies bot administrator permissions.
 *
 * @param {object} message Telegram message object
 * @param {string} rawText Raw user text input
 * @param {object} [options={}] Configuration options
 * @param {boolean} [options.requireAdmin=true] Whether to verify bot admin rights
 * @param {boolean} [options.allowGroup=false] Whether non-channel chats (supergroups/groups) are accepted
 * @param {string} [options.errorContext='channel'] Context label for error messages (e.g. 'backup channel', 'DB channel')
 * @param {string} [options.formatError] Custom error string when input is not a valid channel forward or ID
 * @param {string} [options.notAdminError] Custom error string when bot lacks admin rights
 * @returns {Promise<{ ok: boolean, targetCid?: number|string, targetTitle?: string, error?: string }>}
 */
export async function resolveChannelIdFromMessageOrText(message, rawText, options = {}) {
  const {
    requireAdmin = true,
    allowGroup = false,
    errorContext = 'channel',
    formatError,
    notAdminError
  } = options;

  const forwardChat = message?.forward_from_chat;
  const forwardOrigin = message?.forward_origin;
  const typedId = (rawText || '').trim();

  let targetCid;
  let targetTitle;

  if (allowGroup) {
    if (forwardChat?.id) {
      targetCid = forwardChat.id;
      targetTitle = forwardChat.title || String(forwardChat.id);
    } else if (forwardOrigin?.chat?.id) {
      targetCid = forwardOrigin.chat.id;
      targetTitle = forwardOrigin.chat.title || String(forwardOrigin.chat.id);
    }
  } else {
    if (forwardChat?.type === 'channel') {
      targetCid = forwardChat.id;
      targetTitle = forwardChat.title || String(forwardChat.id);
    } else if (forwardOrigin?.type === 'channel' && forwardOrigin.chat) {
      targetCid = forwardOrigin.chat.id;
      targetTitle = forwardOrigin.chat.title || String(forwardOrigin.chat.id);
    }
  }

  if (!targetCid && /^-100\d+$/.test(typedId)) {
    targetCid = typedId;
    targetTitle = typedId;
  }

  if (!targetCid) {
    const error = formatError || `❌ <b>Please forward a message directly from the ${errorContext}, or send the ${errorContext.includes('chat') ? 'chat' : 'channel'} ID directly</b> (e.g. <code>-100123456789</code>).`;
    return { ok: false, error };
  }

  if (requireAdmin) {
    const isAdmin = await isBotAdmin(targetCid);
    if (!isAdmin) {
      const error = notAdminError || `❌ <b>Bot is not an admin in this ${errorContext}!</b>\n\nPlease add the bot as an administrator in the channel with Post Messages permissions and try again.`;
      return { ok: false, targetCid, targetTitle, error };
    }
  }

  return { ok: true, targetCid, targetTitle };
}

// ─── DB channel readiness ──────────────────────────────────────────────────────
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

// ─── Multi-Instance State Decision: botUsernameCache ────────────────────────
// Decision: Acceptable as local-only per-instance Map.
// Purpose: In-memory cache of resolved Telegram bot usernames keyed by token prefix.
// Rationale: Bot usernames are immutable for the lifetime of a bot token unless changed
// in BotFather (which requires token rotation/restart). Local cache avoids redundant getMe calls.
const botUsernameCache = new Map();

export function pruneBotHelperCaches() {
  if (botUsernameCache.size > 50) {
    botUsernameCache.clear();
  }
}

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

export async function resolveUser(input) {
  if (!input) return null;
  const raw = String(input).trim();
  const users = await getCollection('users');

  // If numeric string or number
  if (/^-?\d+$/.test(raw)) {
    return await users.findOne({ _id: String(raw) });
  }

  // If username with or without leading @
  const username = raw.replace(/^@/, '').toLowerCase();
  return await users.findOne({ username });
}

export function isChannelFatalError(errorStr) {
  if (!errorStr) return false;
  const lower = String(errorStr).toLowerCase();
  return lower.includes('chat not found') ||
         lower.includes('bot was kicked') ||
         lower.includes('chat_admin_required') ||
         lower.includes('channel_private') ||
         lower.includes('have no rights to send a message') ||
         lower.includes('bot is not a member') ||
         lower.includes('user is deactivated');
}

export async function alertAdminChannelFailure(channelId, channelType = 'DB Channel', errorReason = 'Channel Inaccessible') {
  if (!channelId) return;
  try {
    const sessions = await getCollection('sessions');
    const alertKey = `alert:channel_fail:${channelId}`;

    const existing = await sessions.findOne({ _id: alertKey });
    if (existing && existing.expiresAt > new Date()) {
      return; // Deduplicated within 15-minute cooldown window
    }

    // Set 15-minute cooldown per channel
    await sessions.updateOne(
      { _id: alertKey },
      { $set: { val: errorReason, expiresAt: new Date(Date.now() + 15 * 60 * 1000) } },
      { upsert: true }
    );

    const adminIds = getAdminIds();
    if (!adminIds.length) return;

    const alertText = `🚨 <b>CRITICAL ALERT: Storage Channel Struck / Inaccessible!</b>\n\n` +
      `• <b>Channel:</b> <code>${channelId}</code> (${channelType})\n` +
      `• <b>Telegram Error:</b> <code>${esc(errorReason)}</code>\n` +
      `• <b>Time:</b> <code>${formatISTDateTime(new Date(), true)}</code>\n\n` +
      `⚠️ <i>The bot detected a fatal error while accessing files from this channel. If this channel was banned, user links will fail unless backup channel or raw file_id fallback is available.</i>\n\n` +
      `<b>Recommended Actions:</b>\n` +
      `1. Check if the channel is still visible in Telegram.\n` +
      `2. If banned/removed, create a new private channel & make the bot admin.\n` +
      `3. Update your DB channel in /setting or run <code>/rebuildchannel &lt;new_channel_id&gt;</code> to restore all files automatically.`;

    const kb = {
      inline_keyboard: [
        [{ text: toSmallCaps('Open Settings'), callback_data: 'admin:fs_settings' }],
        [{ text: toSmallCaps('Storage & Backup Audit'), callback_data: 'admin:storage_audit' }]
      ]
    };

    for (const aId of adminIds) {
      await sendTelegramMessage(aId, alertText, kb).catch(() => {});
    }

    logActivity({
      eventType: 'channel_alert',
      targetCode: String(channelId),
      targetType: 'channel',
      details: `Channel ${channelId} (${channelType}) fatal error: ${errorReason}`,
    }).catch(() => {});

    // Autonomous self-healing: Trigger The Phoenix Protocol if primary DB storage channel is struck
    if (channelType === 'DB Channel' && isChannelFatalError(errorReason) && channelFailoverHandler) {
      channelFailoverHandler(errorReason)?.catch?.(() => {});
    }
  } catch (err) {
    log('error', 'alertAdminChannelFailure error', { channelId, errorMessage: err.message });
  }
}

export async function checkChannelMessageExists(channelId, messageId) {
  const token = getMainToken();
  if (!token) return { alive: false, reason: 'missing_token' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: channelId,
        message_id: messageId,
        reply_markup: {}
      })
    });
    const data = await res.json();
    if (res.ok) {
      return { alive: true };
    }
    const desc = (data.description || '').toLowerCase();
    if (desc.includes('message is not modified')) {
      return { alive: true };
    }
    return { alive: false, reason: data.description || 'not_found' };
  } catch (err) {
    return { alive: false, reason: err.message };
  }
}

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

export async function extractChannelMessageRange(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  // Match private channel links: t.me/c/1234567890/101
  const privateRegex = /t\.me\/c\/(\d+)\/(\d+)/g;
  const privateMatches = [...rawText.matchAll(privateRegex)];

  if (privateMatches.length >= 2) {
    const c1 = privateMatches[0][1];
    const c2 = privateMatches[1][1];
    if (c1 === c2) {
      const id1 = parseInt(privateMatches[0][2], 10);
      const id2 = parseInt(privateMatches[1][2], 10);
      const firstMsgId = Math.min(id1, id2);
      const lastMsgId = Math.max(id1, id2);
      return {
        channelId: Number(`-100${c1}`),
        firstMsgId,
        lastMsgId,
        totalCount: lastMsgId - firstMsgId + 1
      };
    }
  }

  // Match public channel links: t.me/username/101
  const publicRegex = /t\.me\/([a-zA-Z][a-zA-Z0-9_]{3,})\/(\d+)/g;
  const publicMatches = [];
  let m;
  while ((m = publicRegex.exec(rawText)) !== null) {
    if (m[1] !== 'c') {
      publicMatches.push(m);
    }
  }

  if (publicMatches.length >= 2) {
    const u1 = publicMatches[0][1].toLowerCase();
    const u2 = publicMatches[1][1].toLowerCase();
    if (u1 === u2) {
      const id1 = parseInt(publicMatches[0][2], 10);
      const id2 = parseInt(publicMatches[1][2], 10);
      const firstMsgId = Math.min(id1, id2);
      const lastMsgId = Math.max(id1, id2);

      const token = getToken();
      let channelId = null;
      try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: `@${publicMatches[0][1]}` }),
        });
        const data = await resp.json();
        if (data.ok && data.result?.type === 'channel') {
          channelId = data.result.id;
        }
      } catch (err) {
        log('error', 'extractChannelMessageRange: getChat failed', { username: u1, errorMessage: err.message });
      }

      return {
        channelId: channelId || `@${publicMatches[0][1]}`,
        firstMsgId,
        lastMsgId,
        totalCount: lastMsgId - firstMsgId + 1
      };
    }
  }

  return null;
}

export async function checkChannelsHealth() {
  return botContext.run({ token: getMainToken() }, async () => {
    const s = await getSettings();
    const globalMode = s?.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(s?.forceSubscribeChannels, globalMode);
    const primaryDb = await getDbChannelId();
    const backupDb = await getBackupDbChannelId();

    const results = {
      fsub: [],
      db: {
        primary: null,
        backup: null,
      }
    };

    // 1. Check Force Subscribe Channels concurrently
    if (channels.length > 0) {
      results.fsub = await Promise.all(channels.map(async (c) => {
        try {
          const chatRes = await getChat(c.id);
          const adminRes = await isBotAdmin(c.id);
          const title = c.title && c.title !== c.id ? c.title : (chatRes.ok ? chatRes.result?.title : c.id);
          const isPublic = Boolean(chatRes.result?.username);
          const channelMode = c.mode || globalMode;
          const requiresAdmin = channelMode === 'join_request' || !isPublic;
          const isOk = chatRes.ok && (!requiresAdmin || adminRes);
          return {
            id: c.id,
            title,
            mode: channelMode,
            isOk,
            accessible: chatRes.ok,
            isAdmin: adminRes,
            error: !chatRes.ok ? (chatRes.description || chatRes.reason || 'Cannot access channel') : (requiresAdmin && !adminRes ? 'Bot is not an admin' : null),
          };
        } catch (err) {
          return {
            id: c.id,
            title: c.title || c.id,
            mode: c.mode || globalMode,
            isOk: false,
            accessible: false,
            isAdmin: false,
            error: err.message,
          };
        }
      }));
    }

    // 2. Check Primary DB Channel
    if (primaryDb) {
      try {
        const chatRes = await getChat(primaryDb);
        const adminRes = await isBotAdmin(primaryDb);
        results.db.primary = {
          id: primaryDb,
          title: chatRes.ok ? chatRes.result?.title : 'Primary DB Channel',
          isOk: chatRes.ok && adminRes,
          accessible: chatRes.ok,
          isAdmin: adminRes,
          error: !chatRes.ok ? (chatRes.description || chatRes.reason || 'Inaccessible') : (!adminRes ? 'Bot is not an admin' : null),
        };
      } catch (err) {
        results.db.primary = { id: primaryDb, title: 'Primary DB Channel', isOk: false, error: err.message };
      }
    }

    // 3. Check Backup DB Channel
    if (backupDb) {
      try {
        const chatRes = await getChat(backupDb);
        const adminRes = await isBotAdmin(backupDb);
        results.db.backup = {
          id: backupDb,
          title: chatRes.ok ? chatRes.result?.title : 'Backup DB Channel',
          isOk: chatRes.ok && adminRes,
          accessible: chatRes.ok,
          isAdmin: adminRes,
          error: !chatRes.ok ? (chatRes.description || chatRes.reason || 'Inaccessible') : (!adminRes ? 'Bot is not an admin' : null),
        };
      } catch (err) {
        results.db.backup = { id: backupDb, title: 'Backup DB Channel', isOk: false, error: err.message };
      }
    }

    return results;
  });
}

export async function getChannelDisplayDetails(channelId) {
  if (!channelId) return null;
  const adminRes = await isBotAdmin(channelId);
  let title = null;
  let link = null;
  let username = null;
  let accessible = false;

  try {
    const chatRes = await getChat(channelId);
    if (chatRes.ok && chatRes.result) {
      accessible = true;
      title = chatRes.result.title || null;
      if (chatRes.result.username) {
        username = chatRes.result.username;
        link = `https://t.me/${username}`;
      } else if (chatRes.result.invite_link) {
        link = chatRes.result.invite_link;
      }
    }
  } catch (err) {
    log('warn', 'getChannelDisplayDetails: getChat failed', { channelId, error: err?.message });
  }

  // If no direct link found yet and bot is an admin, check cached invite link or generate a new one
  if (!link && adminRes) {
    try {
      const sessions = await getCollection('sessions');
      const cacheKey = `channel:link:${channelId}`;
      const cacheDoc = await sessions.findOne({ _id: cacheKey });
      if (cacheDoc && cacheDoc.val && cacheDoc.expiresAt > new Date()) {
        link = cacheDoc.val;
      } else {
        const linkRes = await createChatInviteLink(channelId, false);
        if (linkRes.ok && linkRes.result?.invite_link) {
          link = linkRes.result.invite_link;
          await sessions.updateOne(
            { _id: cacheKey },
            { $set: { val: link, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) } },
            { upsert: true }
          );
        }
      }
    } catch (err) {
      log('warn', 'getChannelDisplayDetails: createChatInviteLink failed', { channelId, error: err?.message });
    }
  }

  return {
    id: channelId,
    title: title || 'Private Storage Channel',
    username,
    link,
    isAdmin: adminRes,
    accessible
  };
}
