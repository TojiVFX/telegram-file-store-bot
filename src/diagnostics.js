import {
  getCollection, getSettings, log, esc, getToken,
  getMainToken, getWebhookSecret, sendTelegramMessage,
  editTelegramMessage, toSmallCaps, formatISTTime,
  isSafePublicUrl, getDb
} from './bot-common.js';
import { getAdminIds } from './auth.js';

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
        { command: 'exportlinks', description: toSmallCaps('Export links by duration as .txt') },
        { command: 'backup',     description: toSmallCaps('Export database backup as JSON file') },
        { command: 'broadcast',  description: toSmallCaps('Send a message to all users') },
        { command: 'batch',      description: toSmallCaps('Create a batch link from a channel range') },
        { command: 'bundle',     description: toSmallCaps('Create multi-quality bundle') },
        { command: 'store',      description: toSmallCaps('Store a single file') },
        { command: 'bulkstore',  description: toSmallCaps('Bulk store files with link export') },
        { command: 'auditlinks', description: toSmallCaps('Storage audit & link health') },
        { command: 'scanbroken', description: toSmallCaps('Scan & auto-repair broken links') },
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

// ─── Interactive Diagnostic Renderers ─────────────────────────────────────────

export async function renderPingReport(chatId, messageId = null, initialMsgLatency = null) {
  const token = getToken() || getMainToken();
  const apiStart = Date.now();
  let apiLatency = 0;
  try {
    await fetch(`https://api.telegram.org/bot${token}/getMe`);
    apiLatency = Date.now() - apiStart;
  } catch {}

  const dbPing = await pingDatabase();
  const uptime = formatUptime(process.uptime());
  const mem = process.memoryUsage();
  const memUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const memTotalMB = (mem.heapTotal / 1024 / 1024).toFixed(1);
  const rssMB = (mem.rss / 1024 / 1024).toFixed(1);

  const dbIcon = dbPing.ok ? '✅' : '❌';
  const dbLabel = dbPing.mock ? 'In-Memory (Mock)' : (dbPing.ok ? `Connected (${dbPing.latency}ms)` : 'Disconnected');

  let text = `🏓 <b>Pong!</b>\n\n` +
    `• <b>API Ping (getMe):</b> <b>${apiLatency}ms</b> ⚡\n`;

  if (initialMsgLatency !== null) {
    text += `• <b>Chat Dispatch:</b> <b>${initialMsgLatency}ms</b> 📨\n`;
  }

  text += `• <b>DB Latency:</b> ${dbIcon} <b>${dbLabel}</b>\n` +
    `• <b>Server Uptime:</b> <b>${uptime}</b>\n` +
    `• <b>Memory:</b> <b>${memUsedMB} / ${memTotalMB} MB</b> (RSS: ${rssMB} MB)\n` +
    `• <b>Node:</b> <b>${process.version}</b>\n` +
    `• <b>Platform:</b> <b>${process.platform} ${process.arch}</b>\n` +
    `• <b>Bot API:</b> <b>v8.0+ (Telegram 10.3+)</b>\n\n` +
    `<i>Updated: ${formatISTTime(new Date(), true)}</i>`;

  const kb = {
    inline_keyboard: [
      [{ text: toSmallCaps('🔄 Refresh Ping'), callback_data: 'user:refresh_ping' }]
    ]
  };

  if (messageId) {
    return editTelegramMessage(chatId, messageId, text, kb);
  } else {
    return sendTelegramMessage(chatId, text, kb);
  }
}

export async function renderSystemStatus(chatId, messageId = null) {
  const [webhook, dbPing, settings] = await Promise.all([
    getWebhookInfo(),
    pingDatabase(),
    getSettings(),
  ]);

  const whActive = webhook.url ? '✅ Active' : '❌ Not Set';
  const whPending = webhook.pending_update_count ?? 0;
  const whLastError = webhook.last_error_message ? `\n   ⚠️ Last Error: <i>${esc(webhook.last_error_message)}</i>` : '';

  const dbIcon = dbPing.ok ? '✅' : '❌';
  const dbLabel = dbPing.mock ? 'In-Memory (Mock)' : (dbPing.ok ? `Connected (${dbPing.latency}ms)` : `Disconnected — ${dbPing.error || 'Unknown'}`);

  const [primaryHealth, backupHealth] = await Promise.all([
    checkShortenerHealth(settings?.shortenerUrl, settings?.shortenerKey),
    checkShortenerHealth(settings?.backupShortenerUrl, settings?.backupShortenerKey),
  ]);

  function shortenerLabel(h) {
    if (h.status === 'not_configured') return '⚪ Not Configured';
    if (h.status === 'online') return `✅ Online (${h.latency}ms)`;
    if (h.status === 'error') return `⚠️ Error (HTTP ${h.httpStatus})`;
    return `❌ Offline`;
  }

  const uptime = formatUptime(process.uptime());
  const mem = process.memoryUsage();
  const memUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const rssMB = (mem.rss / 1024 / 1024).toFixed(1);

  const filesColl = await getCollection('files');
  const totalFiles = await filesColl.countDocuments();
  const recentlyAccessed = await filesColl.countDocuments({
    lastAccessedAt: { $exists: true, $gte: new Date(Date.now() - 24 * 3600 * 1000).toISOString() }
  });

  const text = `🩺 <b>System Health Monitor</b>\n\n` +
    `<b>Webhook</b>\n` +
    `• Status: ${whActive}\n` +
    `• Pending Updates: <b>${whPending}</b>${whLastError}\n\n` +
    `<b>Database</b>\n` +
    `• Connection: ${dbIcon} <b>${dbLabel}</b>\n` +
    `• Total Stored Files: <b>${totalFiles}</b>\n` +
    `• Accessed (24h): <b>${recentlyAccessed}</b>\n\n` +
    `<b>Shortener Services</b>\n` +
    `• Primary: ${shortenerLabel(primaryHealth)}\n` +
    `• Backup: ${shortenerLabel(backupHealth)}\n\n` +
    `<b>Server</b>\n` +
    `• Uptime: <b>${uptime}</b>\n` +
    `• Memory: <b>${memUsedMB} MB</b> (RSS: ${rssMB} MB)\n` +
    `• Node: <b>${process.version}</b>\n` +
    `• Platform: <b>${process.platform} ${process.arch}</b>\n` +
    `• Bot API: <b>v8.0+ (Telegram 10.3+)</b>\n\n` +
    `<i>Updated: ${formatISTTime(new Date(), true)}</i>`;

  const kb = {
    inline_keyboard: [
      [{ text: toSmallCaps('🔄 Refresh Status'), callback_data: 'user:refresh_status' }]
    ]
  };

  if (messageId) {
    return editTelegramMessage(chatId, messageId, text, kb);
  } else {
    return sendTelegramMessage(chatId, text, kb);
  }
}
