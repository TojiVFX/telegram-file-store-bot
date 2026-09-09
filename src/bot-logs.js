import { randomBytes } from 'crypto';
import { getCollection, getSettings, sendTelegramMessage, esc } from './bot-common.js';

// ─── Event Icons & Labels ─────────────────────────────────────────────────────
export const EVENT_META = {
  file_store:           { icon: '📁', label: 'File Upload' },
  file_deduplicated:    { icon: '⚡', label: 'File Deduplicated' },
  batch_create:         { icon: '📦', label: 'Batch Created' },
  bundle_create:        { icon: '🎛️', label: 'Bundle Created' },
  temp_token_create:    { icon: '⏳', label: 'Token Generated' },
  temp_token_access:    { icon: '🔓', label: 'Token Accessed' },
  temp_token_revoke:    { icon: '🚫', label: 'Token Revoked' },
  token_verify_success: { icon: '🔐', label: 'Token Verified' },
  file_access:          { icon: '📥', label: 'File Download' },
  batch_access:         { icon: '🗂️', label: 'Batch Download' },
  bundle_access:        { icon: '🎬', label: 'Bundle Viewed' },
  new_user_joined:      { icon: '🎉', label: 'New User Joined' },
  user_start:           { icon: '👋', label: 'User Started' },
  user_ban:             { icon: '⛔', label: 'User Banned' },
  user_unban:           { icon: '✅', label: 'User Unbanned' },
  user_blocked_bot:     { icon: '🛑', label: 'User Blocked Bot' },
  broadcast:            { icon: '📢', label: 'Broadcast Sent' },
  channel_connected:    { icon: '📡', label: 'Channel Connected' },
  cleanup:              { icon: '🧹', label: 'Cleanup Run' },
  system_error:         { icon: '⚠️', label: 'System Alert' },
};

/**
 * Essential milestones and security events sent to the Telegram Log Channel.
 * Routine high-frequency traffic (user_start, file_access, batch_access, bundle_access)
 * is recorded in the database for stats but NOT sent to the log channel to prevent spam.
 */
export const CHANNEL_BROADCAST_EVENTS = new Set([
  'new_user_joined',       // Brand new user joined the bot
  'user_blocked_bot',     // User stopped or blocked the bot
  'file_store',           // Admin uploaded/stored a new file
  'file_deduplicated',    // Admin uploaded a file that was deduplicated
  'batch_create',         // Admin created a batch
  'bundle_create',        // Admin created a multi-quality bundle
  'token_verify_success', // User solved shortener verification
  'user_ban',             // User banned
  'user_unban',           // User unbanned
  'broadcast',            // Global broadcast completed/cancelled
  'channel_connected',    // Bot added as admin in channel
  'system_error',         // System error or shortener alert
]);

/**
 * Returns configured Telegram Log Channel ID from environment or database settings
 */
export async function getLogChannelId() {
  const envChannel = (process.env.LOG_CHANNEL_ID || '').trim();
  if (envChannel) return envChannel;
  try {
    const s = await getSettings();
    return (s?.logChannelId || '').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Logs an activity event to MongoDB and broadcasts filtered milestone events to the log channel
 */
export async function logActivity(entry) {
  try {
    const logs = await getCollection('activity_logs');
    const now = new Date();
    const doc = {
      _id: `act_${Date.now()}_${randomBytes(4).toString('hex')}`,
      timestamp: now,
      isoTime: now.toISOString(),
      eventType: entry.eventType || 'generic',
      userId: entry.userId ? String(entry.userId) : null,
      username: entry.username ? String(entry.username).replace(/^@/, '') : null,
      firstName: entry.firstName ? String(entry.firstName) : null,
      targetCode: entry.targetCode ? String(entry.targetCode) : null,
      targetType: entry.targetType ? String(entry.targetType) : null,
      details: entry.details || '',
      metadata: entry.metadata || {},
      status: entry.status || 'success',
    };

    await logs.insertOne(doc);

    // Only forward milestone events to the Telegram Log Channel (skips routine user_start / download spam)
    (async () => {
      try {
        const logChannelId = await getLogChannelId();
        if (!logChannelId) return;

        const s = await getSettings().catch(() => ({}));
        const shouldBroadcast = s?.logAllEvents === '1' || CHANNEL_BROADCAST_EVENTS.has(doc.eventType);
        if (!shouldBroadcast) return;

        const text = `📡 <b>Activity Log Feed</b>\n\n${formatLogEntryTelegram(doc)}`;
        await sendTelegramMessage(logChannelId, text);
      } catch {}
    })();

    return doc;
  } catch (err) {
    console.error('Failed to log activity event:', err.message);
    return null;
  }
}

/**
 * Helper to log and broadcast critical system alerts
 */
export async function logSystemAlert(title, error, metadata = {}) {
  const details = typeof error === 'string' ? error : error?.message || 'Unknown error';
  return logActivity({
    eventType: 'system_error',
    details: `${title}: ${details}`,
    metadata,
    status: 'error'
  });
}

/**
 * Retrieves activity logs with optional filtering and pagination
 */
export async function getActivityLogs(options = {}) {
  const { eventType, userId, limit = 15, skip = 0 } = options;
  const logs = await getCollection('activity_logs');
  const filter = {};

  if (eventType && eventType !== 'all') {
    if (eventType === 'uploads') {
      filter.eventType = { $in: ['file_store', 'batch_create', 'file_deduplicated'] };
    } else if (eventType === 'tokens') {
      filter.eventType = { $in: ['temp_token_create', 'temp_token_access', 'temp_token_revoke'] };
    } else if (eventType === 'access') {
      filter.eventType = { $in: ['file_access', 'batch_access', 'temp_token_access'] };
    } else {
      filter.eventType = eventType;
    }
  }

  if (userId) {
    filter.userId = String(userId);
  }

  const count = await logs.countDocuments(filter);
  const items = await logs.find(filter)
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  return {
    logs: items,
    total: count,
    skip,
    limit,
    hasMore: skip + items.length < count,
  };
}

/**
 * Calculates summary statistics of user activity
 */
export async function getActivitySummary(hours = 24) {
  const logs = await getCollection('activity_logs');
  const cutoff = new Date(Date.now() - hours * 3600 * 1000);
  const recentLogs = await logs.find({ timestamp: { $gte: cutoff } }).sort({ timestamp: -1 }).toArray();

  const totalAllTime = await logs.countDocuments({});

  const stats = {
    timeframeHours: hours,
    totalRecent: recentLogs.length,
    totalAllTime,
    fileUploads: 0,
    batchCreates: 0,
    tokensCreated: 0,
    tokensAccessed: 0,
    filesDelivered: 0,
    activeUserIds: new Set(),
  };

  for (const item of recentLogs) {
    if (item.userId) stats.activeUserIds.add(item.userId);
    switch (item.eventType) {
      case 'file_store':
        stats.fileUploads++;
        break;
      case 'batch_create':
        stats.batchCreates++;
        break;
      case 'temp_token_create':
        stats.tokensCreated++;
        break;
      case 'temp_token_access':
        stats.tokensAccessed++;
        break;
      case 'file_access':
      case 'batch_access':
        stats.filesDelivered++;
        break;
    }
  }

  return {
    ...stats,
    uniqueActiveUsers: stats.activeUserIds.size,
    recentLogs: recentLogs.slice(0, 10),
  };
}

/**
 * Formats a single activity log item for Telegram display
 */
export function formatLogEntryTelegram(log, idx = null) {
  const meta = EVENT_META[log.eventType] || { icon: '📝', label: log.eventType };
  const d = new Date(log.timestamp);
  const timeStr = !isNaN(d.getTime())
    ? d.toTimeString().split(' ')[0] + ' UTC'
    : 'Recently';

  let userTag = '<code>System</code>';
  if (log.username) {
    const cleanUser = String(log.username).replace(/^@/, '').trim();
    userTag = `@${cleanUser}`;
    if (log.firstName) {
      userTag += ` (${esc(log.firstName)})`;
    }
  } else if (log.userId) {
    const displayName = esc(log.firstName || 'User');
    userTag = `<a href="tg://user?id=${log.userId}">${displayName}</a> (<code>${log.userId}</code>)`;
  } else if (log.firstName) {
    userTag = esc(log.firstName);
  }

  let line = `${meta.icon} <b>${meta.label}</b> [<code>${timeStr}</code>]\n` +
             `   👤 <b>User:</b> ${userTag}\n`;

  if (log.details) {
    line += `   📄 <b>Info:</b> ${esc(log.details)}\n`;
  }
  if (log.targetCode) {
    line += `   🎯 <b>Target:</b> <code>${esc(log.targetCode)}</code>\n`;
  }

  return line;
}

/**
 * Clears old logs beyond a retention threshold (e.g. 30 days)
 */
export async function clearOldLogs(retentionDays = 30) {
  const logs = await getCollection('activity_logs');
  const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000);
  const result = await logs.deleteMany({ timestamp: { $lt: cutoff } });
  return result?.deletedCount || 0;
}
