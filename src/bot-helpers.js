import { randomBytes } from 'node:crypto';
import {
  getCollection, getSettings, log, esc, getToken, isRateLimited,
  sendTelegramMessage, sendTelegramDocument, sendTelegramVideo,
  sendTelegramAudio, sendTelegramPhoto, sendTelegramFileBuffer,
  editTelegramMessage,
  answerCallbackQuery, sendChatAction,
  deleteTelegramMessage, deleteTelegramMessages, copyTelegramMessages,
  getChatMember, getChat,
  createChatInviteLink,
  botContext, logHistory,
  toSmallCaps,
  getWebhookSecret,
  getMainToken,
  isMainBot,
  isSafePublicUrl,
} from './bot-common.js';

export const GROUP_TYPES = new Set(['group', 'supergroup']);

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
      [{ text: toSmallCaps('File Management'), callback_data: 'admin:file_mgmt' }, { text: toSmallCaps('User Control'), callback_data: 'admin:user_mgmt' }],
      [{ text: toSmallCaps('Security & Auto Delete'), callback_data: 'admin:auto_del_mgmt' }, { text: toSmallCaps('Banners & Images'), callback_data: 'admin:banners_mgmt' }],
      [{ text: toSmallCaps('Bot Settings'), callback_data: 'admin:fs_settings' }, { text: toSmallCaps('Back to Main Menu'), callback_data: 'user:back_start' }],
    ]
  };
}

export function getExportHubKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: toSmallCaps('Single Files'), callback_data: 'admin:export_type:media' },
        { text: toSmallCaps('Batches'), callback_data: 'admin:export_type:batch' }
      ],
      [
        { text: toSmallCaps('All Links (Combined)'), callback_data: 'admin:export_type:all' }
      ],
      [
        { text: toSmallCaps('Back to File Management'), callback_data: 'admin:file_mgmt' }
      ]
    ]
  };
}

export function getExportTimeKeyboard(filterType = 'all') {
  const typeLabel = filterType === 'batch' ? 'Batches' : filterType === 'media' ? 'Files' : 'Links';
  return {
    inline_keyboard: [
      [
        { text: toSmallCaps('Last 15 Mins'), callback_data: `admin:exp_time:900:${filterType}` },
        { text: toSmallCaps('Last 30 Mins'), callback_data: `admin:exp_time:1800:${filterType}` }
      ],
      [
        { text: toSmallCaps('Last 1 Hour'), callback_data: `admin:exp_time:3600:${filterType}` },
        { text: toSmallCaps('Last 6 Hours'), callback_data: `admin:exp_time:21600:${filterType}` }
      ],
      [
        { text: toSmallCaps(`Today's ${typeLabel}`), callback_data: `admin:exp_today:${filterType}` },
        { text: toSmallCaps(`All Time ${typeLabel}`), callback_data: `admin:exp_all:${filterType}` }
      ],
      [
        { text: toSmallCaps('Custom Duration'), callback_data: `admin:exp_custom_prompt:${filterType}` }
      ],
      [
        { text: toSmallCaps('Back to Export Hub'), callback_data: 'admin:export_hub' }
      ]
    ]
  };
}

export function getExportLinksKeyboard() {
  return getExportHubKeyboard();
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
export async function copyMessage(toChatId, fromChatId, msgId, protectContent = false, replyMarkup = null) {
  const token = getToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const body = {
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: msgId,
      protect_content: protectContent,
    };
    if (replyMarkup) body.reply_markup = replyMarkup;

    const response = await fetch(`https://api.telegram.org/bot${token}/copyMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      log('error', 'copyMessage failed', { toChatId, fromChatId, msgId, telegramError: data });
      const desc = (data.description || '').toLowerCase();
      const isNotFound = desc.includes('message to copy not found') ||
                         desc.includes('message_id_invalid') ||
                         desc.includes('chat not found');
      return { ok: false, reason: data.description || 'unknown_error', isNotFound, telegramError: data };
    }
    return { ok: true, messageId: data.result?.message_id };
  } catch (err) {
    log('error', 'copyMessage network error', { errorMessage: err.message, msgId });
    return { ok: false, reason: 'network_error' };
  }
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

    const { getAdminIds } = await import('./bot-users.js');
    const adminIds = getAdminIds();
    if (!adminIds.length) return;

    const alertText = `🚨 <b>CRITICAL ALERT: Storage Channel Struck / Inaccessible!</b>\n\n` +
      `• <b>Channel:</b> <code>${channelId}</code> (${channelType})\n` +
      `• <b>Telegram Error:</b> <code>${esc(errorReason)}</code>\n` +
      `• <b>Time:</b> <code>${new Date().toISOString()}</code>\n\n` +
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

    const { logActivity } = await import('./bot-logs.js');
    logActivity({
      eventType: 'channel_alert',
      targetCode: String(channelId),
      targetType: 'channel',
      details: `Channel ${channelId} (${channelType}) fatal error: ${errorReason}`,
    }).catch(() => {});
  } catch (err) {
    log('error', 'alertAdminChannelFailure error', { channelId, errorMessage: err.message });
  }
}

export async function copyIntoDbChannel(dbChannelId, fromChatId, msgId, protectContent = false) {
  return botContext.run({ token: getMainToken() }, () => copyMessage(dbChannelId, fromChatId, msgId, protectContent));
}

export async function copyFromDbChannel(toChatId, dbChannelId, msgId, protectContent = false) {
  return botContext.run({ token: getMainToken() }, async () => {
    const res = await copyMessage(toChatId, dbChannelId, msgId, protectContent);
    if (!res?.ok && isChannelFatalError(res?.reason)) {
      alertAdminChannelFailure(dbChannelId, 'DB Storage Channel', res.reason).catch(() => {});
    }
    return res;
  });
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

export async function forwardMessage(toChatId, fromChatId, msgId, protectContent = false) {
  const token = getToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const body = {
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: msgId,
      protect_content: protectContent,
    };
    const response = await fetch(`https://api.telegram.org/bot${token}/forwardMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      log('error', 'forwardMessage failed', { toChatId, fromChatId, msgId, telegramError: data });
      return { ok: false, reason: data.description || 'unknown_error', telegramError: data };
    }
    return { ok: true, message: data.result, messageId: data.result?.message_id };
  } catch (err) {
    log('error', 'forwardMessage network error', { errorMessage: err.message, msgId });
    return { ok: false, reason: 'network_error' };
  }
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

  return { text, replyMarkup: { inline_keyboard: buttons }, photo: s?.bannerFsub || null };
}

export async function checkSubscription(chatId, userId) {
  return botContext.run({ token: getMainToken() }, async () => {
    let s = await getSettings();
    const sessions = await getCollection('sessions');

    const globalMode = s?.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(s?.forceSubscribeChannels, globalMode);
    if (!channels.length) return { ok: true };

    const results = await Promise.all(channels.map(async (chan) => {
      const cid = chan.id;
      const mode = chan.mode || globalMode || 'normal';
      try {
        const res = await getChatMember(cid, userId);

        if (!res.ok) {
          log('error', 'checkSubscription: getChatMember failed', { cid, userId, res });
        }
        const status = res.ok ? res.result?.status : null;
        const isMember = ['creator', 'administrator', 'member'].includes(status) ||
          (status === 'restricted' && Boolean(res.result?.is_member));

        if (!isMember) {
          if (mode === 'join_request') {
            const pendingKey = `fsub:pending:${cid}:${userId}`;
            const pendingDoc = await sessions.findOne({ _id: pendingKey });
            const pending = pendingDoc && pendingDoc.expiresAt > new Date() ? pendingDoc.val : null;
            if (pending === '1') return null;
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

          return {
            id: cid,
            title: title,
            buttonLabel: chan.buttonLabel || chan.label || null,
            inviteLink: inviteLink
          };
        }
        return null;
      } catch (err) {
        log('error', 'checkSubscription error', { cid, userId, errorMessage: err.message });
        return null;
      }
    }));

    const notJoined = results.filter(Boolean);
    if (notJoined.length > 0) {
      return { ok: false, notJoined };
    }
    return { ok: true };
  });
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
          return {
            id: c.id,
            title,
            mode: c.mode || globalMode,
            isOk: chatRes.ok && adminRes,
            accessible: chatRes.ok,
            isAdmin: adminRes,
            error: !chatRes.ok ? (chatRes.description || chatRes.reason || 'Cannot access channel') : (!adminRes ? 'Bot is not an admin' : null),
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
export async function deliverBatch(toChatId, batch, protectContent = false, batchCode = null, onProgress = null) {
  const { dbChannelId, dbMessageIds, dbFirstMsgId, dbLastMsgId, backupDbChannelId, backupDbMessageIds } = batch;
  const sentMessageIds = [];
  let failedCount = 0;

  const totalCount = Array.isArray(dbMessageIds)
    ? dbMessageIds.length
    : (dbFirstMsgId && dbLastMsgId ? dbLastMsgId - dbFirstMsgId + 1 : 0);

  if (Array.isArray(dbMessageIds)) {
    // Attempt fast batch copy via Telegram copyMessages first if no backup channel is needed
    const hasBackup = Boolean(backupDbChannelId && Array.isArray(backupDbMessageIds) && backupDbMessageIds.length);
    let batchCopied = false;

    // Telegram copyMessages requires IDs to be strictly increasing
    const isIncreasing = dbMessageIds.every((id, idx) => idx === 0 || id > dbMessageIds[idx - 1]);
    if (isIncreasing && !hasBackup && dbMessageIds.length > 1) {
      const copyBatchRes = await botContext.run({ token: getMainToken() }, () =>
        copyTelegramMessages(toChatId, dbChannelId, dbMessageIds, protectContent)
      );
      if (copyBatchRes?.ok && copyBatchRes.messageIds.length === dbMessageIds.length) {
        sentMessageIds.push(...copyBatchRes.messageIds);
        batchCopied = true;
        if (typeof onProgress === 'function') {
          await onProgress(sentMessageIds.length, totalCount).catch(() => {});
        }
      }
    }

    if (!batchCopied) {
      for (let i = 0; i < dbMessageIds.length; i++) {
        const msgId = dbMessageIds[i];
        let res = await copyFromDbChannel(toChatId, dbChannelId, msgId, protectContent);

        // Seamless failover to backup DB channel if primary message fails
        if ((!res?.ok || !res?.messageId) && backupDbChannelId && Array.isArray(backupDbMessageIds) && backupDbMessageIds[i]) {
          res = await copyFromDbChannel(toChatId, backupDbChannelId, backupDbMessageIds[i], protectContent);
        }

        if (res?.ok && res?.messageId) {
          sentMessageIds.push(res.messageId);
        } else {
          failedCount++;
        }
        if (typeof onProgress === 'function') {
          await onProgress(sentMessageIds.length + failedCount, totalCount).catch(() => {});
        }
        if (totalCount > 3) await new Promise((r) => setTimeout(r, 60));
      }
    }
  }
  else if (dbFirstMsgId && dbLastMsgId) {
    const rangeIds = [];
    for (let msgId = dbFirstMsgId; msgId <= dbLastMsgId; msgId++) {
      rangeIds.push(msgId);
    }

    let batchCopied = false;
    if (rangeIds.length > 1) {
      const copyBatchRes = await botContext.run({ token: getMainToken() }, () =>
        copyTelegramMessages(toChatId, dbChannelId, rangeIds, protectContent)
      );
      if (copyBatchRes?.ok && copyBatchRes.messageIds.length === rangeIds.length) {
        sentMessageIds.push(...copyBatchRes.messageIds);
        batchCopied = true;
        if (typeof onProgress === 'function') {
          await onProgress(sentMessageIds.length, totalCount).catch(() => {});
        }
      }
    }

    if (!batchCopied) {
      for (let msgId = dbFirstMsgId; msgId <= dbLastMsgId; msgId++) {
        let res = await copyFromDbChannel(toChatId, dbChannelId, msgId, protectContent);
        if (res?.ok && res?.messageId) {
          sentMessageIds.push(res.messageId);
        } else {
          failedCount++;
        }
        if (typeof onProgress === 'function') {
          await onProgress(sentMessageIds.length + failedCount, totalCount).catch(() => {});
        }
        if (totalCount > 3) await new Promise((r) => setTimeout(r, 60));
      }
    }
  }

  if (failedCount > 0 && sentMessageIds.length === 0) {
    await sendTelegramMessage(toChatId, `❌ <b>Batch Unavailable</b>\n\nThe files in this batch are no longer available in storage (they may have been removed from the database channel).`, null, protectContent);
  } else if (failedCount > 0) {
    await sendTelegramMessage(toChatId, `⚠️ <b>Note:</b> ${failedCount} file(s) in this batch could not be retrieved because they were deleted from storage.`, null, protectContent);
  }

  if (sentMessageIds.length > 0) {
    await scheduleAutoDelete(toChatId, sentMessageIds, batchCode);
  }
  return sentMessageIds;
}

export async function getSponsorButton() {
  try {
    const s = await getSettings();
    if (s?.sponsorBtnEnabled !== '1') return null;
    const text = (s?.sponsorBtnText || '').trim();
    const url = (s?.sponsorBtnUrl || '').trim();
    if (!text || !url) return null;
    if (isSafePublicUrl(url) || url.startsWith('tg://') || url.startsWith('https://t.me/')) {
      return { text: toSmallCaps(text), url };
    }
    return null;
  } catch {
    return null;
  }
}

export async function scheduleAutoDelete(chatId, messageIds, fileOrBatchCode = null) {
  if (!messageIds || (Array.isArray(messageIds) && messageIds.length === 0)) return;

  const s = await getSettings();
  const sponsorBtn = await getSponsorButton();

  // If auto-delete is disabled, attach sponsor ad button if configured
  if (s?.autoDeleteEnabled !== '1') {
    if (sponsorBtn) {
      await sendTelegramMessage(chatId, `✨ <b>Enjoy your download!</b>`, {
        inline_keyboard: [[sponsorBtn]]
      }, s?.protectContent === '1').catch(() => {});
    }
    return;
  }

  const timerSeconds = parseInt(s?.autoDeleteTimer, 10) || 300; // default 5 mins
  const ms = timerSeconds * 1000;
  const ids = Array.isArray(messageIds) ? messageIds : [messageIds];

  const formatTimerLabel = (sec) => {
    if (sec < 60) return `${sec} seconds`;
    if (sec < 3600) return `${Math.round(sec / 60)} minute(s)`;
    return `${Math.round(sec / 3600)} hour(s)`;
  };

  const timerLabel = formatTimerLabel(timerSeconds);

  const warnText = `⚠️ <b>Note:</b> These file(s) will be automatically deleted in <b>${timerLabel}</b>!\n\n💡 <i>Forward them to your <b>Saved Messages</b> to keep them permanently.</i>`;
  const inline_keyboard = [
    [{ text: toSmallCaps('How to Save'), callback_data: 'user:save_tip' }]
  ];
  if (sponsorBtn) {
    inline_keyboard.push([sponsorBtn]);
  }
  const warnKb = { inline_keyboard };

  const warnMsg = await sendTelegramMessage(chatId, warnText, warnKb, s?.protectContent === '1');
  if (warnMsg?.ok && warnMsg?.messageId) ids.push(warnMsg.messageId);

  // Generate unique atomic job ID
  const jobId = `auto_del_${chatId}_${Date.now()}_${randomBytes(4).toString('hex')}`;

  // Persist to MongoDB so deletions survive Render restarts / redeployments
  try {
    const autoDeletes = await getCollection('auto_deletes');
    await autoDeletes.insertOne({
      _id: jobId,
      chatId,
      messageIds: ids,
      fileOrBatchCode: fileOrBatchCode || null,
      deleteAt: new Date(Date.now() + ms),
      createdAt: new Date(),
    });
  } catch (err) {
    log('error', 'Failed to persist auto-delete job to database', { errorMessage: err.message });
  }

  // Set in-memory timeout with atomic findOneAndDelete to prevent race condition / double messages
  setTimeout(async () => {
    try {
      const autoDeletes = await getCollection('auto_deletes');
      const claimed = await autoDeletes.findOneAndDelete({ _id: jobId });
      const job = claimed?.value !== undefined ? claimed.value : claimed;
      if (!job) {
        // Already processed by background worker or another instance
        return;
      }

      await deleteTelegramMessages(chatId, ids).catch(() => {});

      if (fileOrBatchCode) {
        try {
          const botUsername = await getBotUsername();
          const reGetUrl = `https://t.me/${botUsername}?start=${fileOrBatchCode}`;
          const kb = {
            inline_keyboard: [
              [{ text: toSmallCaps('Get File Again'), url: reGetUrl }]
            ]
          };
          if (sponsorBtn) kb.inline_keyboard.push([sponsorBtn]);

          await sendTelegramMessage(
            chatId,
            `🗑️ <b>Files Deleted</b>\n\nYour file(s) have been deleted automatically according to the auto-delete timer.`,
            kb
          );
        } catch (err) {
          log('error', 'Failed to send auto-delete follow-up', { errorMessage: err.message });
        }
      }
    } catch (err) {
      log('error', 'Auto-delete timer error', { errorMessage: err.message });
    }
  }, ms);
}

// ─── Background Auto-Delete Worker ───────────────────────────────────────────
let autoDeleteWorkerRunning = false;

export async function processDueAutoDeletes() {
  try {
    const autoDeletes = await getCollection('auto_deletes');
    const now = new Date();
    const dueJobs = await autoDeletes.find({ deleteAt: { $lte: now } }).limit(50).toArray();

    for (const job of dueJobs) {
      // Atomically claim the job before deleting any Telegram messages
      const claimed = await autoDeletes.findOneAndDelete({ _id: job._id });
      const doc = claimed?.value !== undefined ? claimed.value : claimed;
      if (!doc) {
        // Already claimed and processed by setTimeout or another polling worker
        continue;
      }

      if (doc.chatId && Array.isArray(doc.messageIds)) {
        await deleteTelegramMessages(doc.chatId, doc.messageIds).catch(() => {});

        if (doc.fileOrBatchCode) {
          try {
            const botUsername = await getBotUsername();
            const reGetUrl = `https://t.me/${botUsername}?start=${doc.fileOrBatchCode}`;
            const sponsorBtn = await getSponsorButton();
            const kb = {
              inline_keyboard: [
                [{ text: toSmallCaps('Get File Again'), url: reGetUrl }]
              ]
            };
            if (sponsorBtn) kb.inline_keyboard.push([sponsorBtn]);

            await sendTelegramMessage(
              doc.chatId,
              `🗑️ <b>Files Deleted</b>\n\nYour file(s) have been deleted automatically according to the auto-delete timer.`,
              kb
            );
          } catch {}
        }
      }
    }
  } catch (err) {
    log('error', 'processDueAutoDeletes error', { errorMessage: err.message });
  }
}

export function startAutoDeleteWorker(intervalMs = 15000) {
  if (autoDeleteWorkerRunning) return;
  autoDeleteWorkerRunning = true;
  // Run once immediately upon startup
  processDueAutoDeletes().catch(() => {});
  // Recurring polling
  setInterval(() => {
    processDueAutoDeletes().catch(() => {});
  }, intervalMs);
}

// ─── Database Backup System ───────────────────────────────────────────────────
export async function generateDatabaseBackupBuffer() {
  const collectionsToExport = ['files', 'batches', 'bundles', 'users', 'channels', 'settings'];
  const backupData = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    collections: {}
  };

  for (const colName of collectionsToExport) {
    try {
      const coll = await getCollection(colName);
      const docs = await coll.find({}).toArray();
      backupData.collections[colName] = docs;
    } catch {
      backupData.collections[colName] = [];
    }
  }

  const jsonStr = JSON.stringify(backupData, null, 2);
  const buffer = Buffer.from(jsonStr, 'utf-8');
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `backup_${dateStr}_${Date.now()}.json`;

  return {
    buffer,
    filename,
    sizeBytes: buffer.length,
    summary: {
      files: backupData.collections.files?.length || 0,
      batches: backupData.collections.batches?.length || 0,
      bundles: backupData.collections.bundles?.length || 0,
      users: backupData.collections.users?.length || 0,
    }
  };
}

export async function sendDatabaseBackup(targetChatId) {
  const backup = await generateDatabaseBackupBuffer();
  const dateStr = new Date().toISOString().slice(0, 10);
  const sizeKb = (backup.sizeBytes / 1024).toFixed(1);

  const caption = `💾 <b>Database Backup</b>\n\n` +
    `📅 Date: <b>${dateStr}</b>\n` +
    `📊 Records:\n` +
    `• Files: <b>${backup.summary.files}</b>\n` +
    `• Batches: <b>${backup.summary.batches}</b>\n` +
    `• Bundles: <b>${backup.summary.bundles}</b>\n` +
    `• Users: <b>${backup.summary.users}</b>\n` +
    `💾 Size: <b>${sizeKb} KB</b>`;

  return sendTelegramFileBuffer(targetChatId, backup.buffer, backup.filename, caption);
}

let dailyBackupWorkerStarted = false;
export function startDailyBackupWorker() {
  if (dailyBackupWorkerStarted) return;
  dailyBackupWorkerStarted = true;

  // Schedule daily backup every 24 hours
  setInterval(async () => {
    try {
      const { getLogChannelId } = await import('./bot-logs.js');
      const { getAdminIds } = await import('./bot-users.js');
      const logChannelId = await getLogChannelId();
      const adminIds = getAdminIds();
      const targetChatId = logChannelId || (adminIds.length > 0 ? adminIds[0] : null);

      if (targetChatId) {
        await sendDatabaseBackup(targetChatId);
        log('info', 'Automated daily database backup completed', { targetChatId });
      }
    } catch (err) {
      log('error', 'Daily backup worker error', { errorMessage: err.message });
    }
  }, 24 * 60 * 60 * 1000);
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
// ─── Health Monitoring ────────────────────────────────────────────────────────
export async function getWebhookInfo() {
  const token = getToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const data = await res.json();
    return data?.result || {};
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export async function pingDatabase() {
  try {
    const { getDb } = await import('./bot-common.js');
    const db = await getDb();
    if (!db || typeof db.command !== 'function') {
      return { ok: true, latency: 0, mock: true };
    }
    const start = Date.now();
    await db.command({ ping: 1 });
    return { ok: true, latency: Date.now() - start, mock: false };
  } catch (err) {
    return { ok: false, latency: -1, error: err.message };
  }
}

export async function checkShortenerHealth(serviceUrl, apiKey) {
  if (!serviceUrl || !apiKey) return { status: 'not_configured' };
  if (!isSafePublicUrl(serviceUrl)) return { status: 'unsafe_url' };
  try {
    const testUrl = 'https://www.google.com';
    const apiUrl = `${serviceUrl}?api=${apiKey}&url=${encodeURIComponent(testUrl)}`;
    const start = Date.now();
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(5000) });
    const latency = Date.now() - start;
    if (!res.ok) return { status: 'error', latency, httpStatus: res.status };
    return { status: 'online', latency };
  } catch (err) {
    return { status: 'offline', error: err.message };
  }
}

export function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// ─── setMyCommands ────────────────────────────────────────────────────────────
export async function setMyCommands() {
  const token = getToken();
  if (!token) return;

  const { getAdminIds } = await import('./bot-users.js');
  const adminIds = getAdminIds();

  const userCommands = [
    { command: 'start',       description: toSmallCaps('Open the main menu') },
    { command: 'temptoken',   description: toSmallCaps('Create temporary file sharing token') },
    { command: 'mytokens',    description: toSmallCaps('View active temporary tokens') },
    { command: 'revoketoken', description: toSmallCaps('Invalidate an active token') },
    { command: 'me',          description: toSmallCaps('View your profile & referral link') },
    { command: 'ping',        description: toSmallCaps('Bot latency, uptime & system info') },
    { command: 'help',        description: toSmallCaps('How to use this bot') },
  ];

  try {
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: userCommands }),
    });

    if (adminIds.length > 0) {
      const adminCommands = [
        ...userCommands,
        { command: 'setting',    description: toSmallCaps('Open admin dashboard') },
        { command: 'status',     description: toSmallCaps('Full system health monitor') },
        { command: 'userstats',  description: toSmallCaps('User stats & download activity chart') },
        { command: 'topfiles',   description: toSmallCaps('Top 10 most downloaded files & batches') },
        { command: 'todaylinks', description: toSmallCaps("List all links created today with downloads") },
        { command: 'backup',     description: toSmallCaps('Export database backup as JSON file') },
        { command: 'broadcast',  description: toSmallCaps('Send a message to all users') },
        { command: 'batch',      description: toSmallCaps('Create a batch link from a channel range') },
        { command: 'bundle',     description: toSmallCaps('Create multi-quality bundle') },
        { command: 'store',      description: toSmallCaps('Store a single file') },
        { command: 'bulkstore',  description: toSmallCaps('Bulk store files with link export') },
        { command: 'ban',        description: toSmallCaps('Ban a user by chat ID or @username') },
        { command: 'unban',      description: toSmallCaps('Unban a user by chat ID or @username') },
        { command: 'banlist',    description: toSmallCaps('List all banned users with 1-click unban') },
        { command: 'user',       description: toSmallCaps('Inspect user profile & moderation status') },
        { command: 'toprefs',    description: toSmallCaps('Referral leaderboard') },
        { command: 'delete',     description: toSmallCaps('Delete stored file, batch, or bundle') },
        { command: 'editfile',   description: toSmallCaps('Rename title of stored record') },
        { command: 'checkchannels', description: toSmallCaps('Channel health diagnostic check') },
        { command: 'rebuildchannel', description: toSmallCaps('Auto-restore storage files to new channel') },
        { command: 'adminhelp',  description: toSmallCaps('Admin command reference') },
      ];
      for (const aId of adminIds) {
        if (!/^-?\d+$/.test(aId)) continue;
        await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            commands: adminCommands,
            scope: { type: 'chat', chat_id: Number(aId) },
          }),
        }).catch(err => log('warn', `setMyCommands failed for admin ${aId}`, { errorMessage: err.message }));
      }
    }
  } catch (err) {
    log('error', 'setMyCommands failed', { errorMessage: err.message });
  }
}
