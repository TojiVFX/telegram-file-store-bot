import { randomBytes } from 'crypto';
import { getCollection, esc } from './bot-common.js';

// ─── Event Icons & Labels ─────────────────────────────────────────────────────
export const EVENT_META = {
  file_store:         { icon: '📁', label: 'File Upload' },
  batch_create:       { icon: '📦', label: 'Batch Created' },
  temp_token_create:  { icon: '⏳', label: 'Token Generated' },
  temp_token_access:  { icon: '🔓', label: 'Token Accessed' },
  temp_token_revoke:  { icon: '🚫', label: 'Token Revoked' },
  file_access:        { icon: '📥', label: 'File Download' },
  batch_access:       { icon: '🗂️', label: 'Batch Download' },
  user_start:         { icon: '👋', label: 'User Started' },
  user_ban:           { icon: '⛔', label: 'User Banned' },
  user_unban:         { icon: '✅', label: 'User Unbanned' },
  broadcast:          { icon: '📢', label: 'Broadcast' },
  cleanup:            { icon: '🧹', label: 'Cleanup' },
};

/**
 * Logs an activity event to MongoDB (or mock collection)
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
    return doc;
  } catch (err) {
    console.error('Failed to log activity event:', err.message);
    return null;
  }
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
      filter.eventType = { $in: ['file_store', 'batch_create'] };
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

  const userTag = log.username
    ? `@${log.username}`
    : (log.firstName ? `${log.firstName} (<code>${log.userId || 'Anon'}</code>)` : `<code>${log.userId || 'System'}</code>`);

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
