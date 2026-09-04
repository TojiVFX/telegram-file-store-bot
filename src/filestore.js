import { getCollection, getSettings, log } from './bot-common.js';
import { logActivity } from './bot-logs.js';

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Shared random-code generator backing both generateFileCode() and
 * generateBatchCode() below, so the two can't drift apart (a third, private
 * copy of this same logic used to live in callbacks/admin-callbacks.js).
 */
function generateCode(prefix, length = 12) {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  }
  return `${prefix}_${result}`;
}

export function generateFileCode() {
  return generateCode('file');
}

export async function storeFile(fileCode, dataObj, uploader = {}) {
  const files = await getCollection('files');
  await files.updateOne(
    { _id: fileCode },
    { $set: { ...dataObj, createdAt: new Date().toISOString() } },
    { upsert: true }
  );

  logActivity({
    eventType: 'file_store',
    userId: uploader.userId || dataObj.uploaderId,
    username: uploader.username,
    firstName: uploader.firstName,
    targetCode: fileCode,
    targetType: 'file',
    details: `Uploaded single file ${fileCode}`,
    metadata: {
      type: dataObj.type || 'media',
      dbChannelId: dataObj.dbChannelId,
      dbMessageId: dataObj.dbMessageId,
    }
  }).catch(() => {});
}

export async function getFile(fileCode) {
  const files = await getCollection('files');
  return await files.findOne({ _id: fileCode });
}

export async function setAdminWaitingForFile(chatId) {
  const sessions = await getCollection('sessions');
  const key = `admin:filestore:waiting:${chatId}`;
  await sessions.updateOne(
    { _id: key },
    { $set: { val: '1', expiresAt: new Date(Date.now() + 600 * 1000) } },
    { upsert: true }
  );
}

export async function checkAndClearAdminWaiting(chatId) {
  const sessions = await getCollection('sessions');
  const key = `admin:filestore:waiting:${chatId}`;
  const doc = await sessions.findOne({ _id: key });
  if (doc && doc.expiresAt > new Date()) {
    await sessions.deleteOne({ _id: key });
    return true;
  }
  return false;
}

export function generateBatchCode() {
  return generateCode('batch');
}

export async function storeBatch(batchCode, dbChannelId, dbMessageIds, creator = {}) {
  const files = await getCollection('files');
  await files.updateOne(
    { _id: batchCode },
    {
      $set: {
        type: 'batch',
        dbChannelId,
        dbMessageIds,
        createdAt: new Date().toISOString(),
      }
    },
    { upsert: true }
  );

  const count = Array.isArray(dbMessageIds) ? dbMessageIds.length : 'multiple';
  logActivity({
    eventType: 'batch_create',
    userId: creator.userId,
    username: creator.username,
    firstName: creator.firstName,
    targetCode: batchCode,
    targetType: 'batch',
    details: `Created batch ${batchCode} (${count} items)`,
    metadata: { count, dbChannelId }
  }).catch(() => {});
}

export async function getBatch(batchCode) {
  const files = await getCollection('files');
  return await files.findOne({ _id: batchCode });
}

export async function setBatchSession(chatId, state) {
  const { collectedIds, ...meta } = state;
  const sessions = await getCollection('sessions');
  const key = `admin:batch:session:${chatId}`;
  const expiresAt = new Date(Date.now() + 600 * 1000);

  const updateData = { ...meta, expiresAt };
  if (Object.prototype.hasOwnProperty.call(state, 'collectedIds')) {
    updateData.collectedIds = collectedIds || [];
  }

  await sessions.updateOne(
    { _id: key },
    { $set: updateData },
    { upsert: true }
  );
}

export async function updateBatchSessionMeta(chatId, metaPatch) {
  const sessions = await getCollection('sessions');
  const key = `admin:batch:session:${chatId}`;
  await sessions.updateOne(
    { _id: key },
    { $set: metaPatch }
  );
}

export async function addIdToBatch(chatId, messageId) {
  const sessions = await getCollection('sessions');
  const key = `admin:batch:session:${chatId}`;
  await sessions.updateOne(
    { _id: key },
    { $push: { collectedIds: messageId } }
  );
  const doc = await sessions.findOne({ _id: key });
  return doc && doc.collectedIds ? doc.collectedIds.length : 0;
}

export async function getBatchSession(chatId) {
  const sessions = await getCollection('sessions');
  const key = `admin:batch:session:${chatId}`;
  const doc = await sessions.findOne({ _id: key });
  if (doc && doc.expiresAt > new Date()) {
    return doc;
  }
  return null;
}

export async function clearBatchSession(chatId) {
  const sessions = await getCollection('sessions');
  const key = `admin:batch:session:${chatId}`;
  await sessions.deleteOne({ _id: key });
}

// ─── Bulk Store Session ─────────────────────────────────────────────────────
// Tracks accumulated file codes across multiple individual /store operations
// so all links can be shown together at the end.

export async function addToStoreSession(chatId, code) {
  const sessions = await getCollection('sessions');
  const key = `admin:store:session:${chatId}`;
  await sessions.updateOne(
    { _id: key },
    { $push: { codes: code }, $set: { expiresAt: new Date(Date.now() + 1800 * 1000) } },
    { upsert: true }
  );
  const doc = await sessions.findOne({ _id: key });
  return doc?.codes?.length || 0;
}

export async function getStoreSession(chatId) {
  const sessions = await getCollection('sessions');
  const key = `admin:store:session:${chatId}`;
  const doc = await sessions.findOne({ _id: key });
  if (doc && doc.expiresAt > new Date()) return doc.codes || [];
  return [];
}

export async function clearStoreSession(chatId) {
  const sessions = await getCollection('sessions');
  const key = `admin:store:session:${chatId}`;
  await sessions.deleteOne({ _id: key });
}

export async function isBulkStoreActive(chatId) {
  const sessions = await getCollection('sessions');
  const doc = await sessions.findOne({ _id: `admin:bulk_store:active:${chatId}` });
  return !!(doc && doc.expiresAt > new Date());
}

export async function setBulkStoreActive(chatId, active = true) {
  const sessions = await getCollection('sessions');
  const key = `admin:bulk_store:active:${chatId}`;
  if (active) {
    await sessions.updateOne(
      { _id: key },
      { $set: { val: 1, expiresAt: new Date(Date.now() + 1800 * 1000) } },
      { upsert: true }
    );
  } else {
    await sessions.deleteOne({ _id: key });
  }
}

export function generateLinksExportText(files, botUsername, title = 'STORED LINKS') {
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  let out = `======================================================\n`;
  out += `TELEGRAM FILE STORE BOT - ${title.toUpperCase()}\n`;
  out += `Generated: ${nowStr}\n`;
  out += `Total Records: ${files.length}\n`;
  out += `======================================================\n\n`;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const code = f._id || f;
    const type = f.type || 'file';
    const downloads = f.accessCount || 0;
    const created = f.createdAt ? String(f.createdAt).slice(0, 19).replace('T', ' ') : 'N/A';
    const link = `https://t.me/${botUsername}?start=${code}`;

    out += `${i + 1}. [${type.toUpperCase()}] ${code}\n`;
    out += `   Downloads: ${downloads}\n`;
    out += `   Created:   ${created}\n`;
    out += `   Link:      ${link}\n\n`;
  }
  return out;
}

export function generateRawLinksText(files, botUsername) {
  return files.map(f => `https://t.me/${botUsername}?start=${f._id || f}`).join('\n');
}

export async function getFilesWithinDuration(seconds, filterType = null) {
  try {
    const files = await getCollection('files');
    const sinceDate = new Date(Date.now() - seconds * 1000).toISOString();
    const query = { createdAt: { $gte: sinceDate } };
    if (filterType && filterType !== 'all') {
      query.type = filterType;
    }
    return await files.find(query).sort({ createdAt: -1 }).toArray();
  } catch (err) {
    log('error', 'getFilesWithinDuration failed', { errorMessage: err.message });
    return [];
  }
}

export function formatDurationLabel(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} Mins`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} Hours`;
  return `${Math.round(seconds / 86400)} Days`;
}

export async function runWeeklyCleanup() {
  const files = await getCollection('files');
  const allFiles = await files.find({}).toArray();

  let deletedCount = 0;
  const deletedIds = [];

  for (const item of allFiles) {
    if (!item.createdAt) continue;
    const dt = new Date(item.createdAt);
    const day = dt.getUTCDay();
    if (day === 0 || day === 1) {
      deletedIds.push(item._id);
      deletedCount++;
    }
  }

  if (deletedIds.length > 0) {
    await files.deleteMany({ _id: { $in: deletedIds } });
  }

  return {
    deletedRecords: deletedCount,
  };
}

export async function incrementAccessCount(code) {
  if (!code) return;
  try {
    const files = await getCollection('files');
    await files.updateOne(
      { _id: code },
      { $inc: { accessCount: 1 }, $set: { lastAccessedAt: new Date().toISOString() } }
    );
  } catch (err) {
    log('error', 'incrementAccessCount failed', { code, errorMessage: err.message });
  }
}

export async function getTopFiles(limit = 10) {
  try {
    const files = await getCollection('files');
    return await files.find({ accessCount: { $gt: 0 } })
      .sort({ accessCount: -1 })
      .limit(limit)
      .toArray();
  } catch (err) {
    log('error', 'getTopFiles failed', { errorMessage: err.message });
    return [];
  }
}

export async function getDownloadActivity(days = 7) {
  try {
    const files = await getCollection('files');
    const allFiles = await files.find({
      lastAccessedAt: { $exists: true },
      accessCount: { $gt: 0 }
    }).toArray();

    // Build day-by-day map for last N days
    const dayMap = {};
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dayMap[key] = { label: dayNames[d.getDay()], date: key, count: 0 };
    }

    // Count accesses per day from lastAccessedAt
    for (const f of allFiles) {
      const dateKey = String(f.lastAccessedAt).slice(0, 10);
      if (dayMap[dateKey]) {
        dayMap[dateKey].count += (f.accessCount || 0);
      }
    }

    return Object.values(dayMap);
  } catch (err) {
    log('error', 'getDownloadActivity failed', { errorMessage: err.message });
    return [];
  }
}

export async function getDailyFileStats() {
  try {
    const files = await getCollection('files');
    const today = new Date().toISOString().slice(0, 10);

    // Links created today
    const createdToday = await files.countDocuments({
      createdAt: { $exists: true, $gte: today }
    });

    // Total downloads today (files accessed today)
    const accessedToday = await files.find({
      lastAccessedAt: { $exists: true, $gte: today },
      accessCount: { $gt: 0 }
    }).toArray();
    const downloadsToday = accessedToday.reduce((sum, f) => sum + (f.accessCount || 0), 0);

    // All-time totals
    const totalLinks = await files.countDocuments();
    const totalDownloads = await files.find({ accessCount: { $gt: 0 } }).toArray();
    const allTimeDownloads = totalDownloads.reduce((sum, f) => sum + (f.accessCount || 0), 0);

    return {
      createdToday,
      downloadsToday,
      totalLinks,
      allTimeDownloads,
    };
  } catch (err) {
    log('error', 'getDailyFileStats failed', { errorMessage: err.message });
    return { createdToday: 0, downloadsToday: 0, totalLinks: 0, allTimeDownloads: 0 };
  }
}

export async function getTodayFiles() {
  try {
    const files = await getCollection('files');
    const today = new Date().toISOString().slice(0, 10);
    return await files.find({
      createdAt: { $exists: true, $gte: today }
    }).sort({ createdAt: -1 }).toArray();
  } catch (err) {
    log('error', 'getTodayFiles failed', { errorMessage: err.message });
    return [];
  }
}

async function requestShortenerUrl(serviceUrl, apiKey, targetUrl) {
  if (!serviceUrl || !apiKey) return null;
  try {
    const apiUrl = `${serviceUrl}?api=${apiKey}&url=${encodeURIComponent(targetUrl)}`;
    const res = await fetch(apiUrl);
    if (!res.ok) {
      log('warn', 'Shortener service returned non-ok status', { status: res.status, serviceUrl });
      return null;
    }

    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      log('warn', 'Shortener response not valid JSON', { serviceUrl, preview: raw.slice(0, 150) });
      return null;
    }

    const short = data.short_url ?? data.shortenedUrl ?? data.link ?? data.url ?? null;
    return short;
  } catch (err) {
    log('warn', 'Shortener request failed', { serviceUrl, errorMessage: err.message });
    return null;
  }
}

export async function getShortenedLink(targetUrl, botId = null) {
  const s = await getSettings();

  // 1. Try Primary Shortener
  if (s?.shortenerUrl && s?.shortenerKey) {
    const primaryShort = await requestShortenerUrl(s.shortenerUrl, s.shortenerKey, targetUrl);
    if (primaryShort) return primaryShort;
    log('warn', 'Primary shortener failed — attempting backup shortener if configured');
  }

  // 2. Try Backup Shortener if configured
  if (s?.backupShortenerUrl && s?.backupShortenerKey) {
    const backupShort = await requestShortenerUrl(s.backupShortenerUrl, s.backupShortenerKey, targetUrl);
    if (backupShort) {
      log('info', 'Successfully shortened link via backup shortener');
      return backupShort;
    }
  }

  log('error', 'getShortenedLink: all configured shorteners failed or not configured', {
    hasPrimary: !!(s?.shortenerUrl && s?.shortenerKey),
    hasBackup: !!(s?.backupShortenerUrl && s?.backupShortenerKey),
  });
  return null;
}

// ─── Time-Limited Access Tokens ───────────────────────────────────────────────

export function formatDuration(seconds) {
  const s = Number(seconds);
  if (isNaN(s) || s <= 0) return '0s';
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const mins = Math.round(s / 60);
    return `${mins} min${mins === 1 ? '' : 's'}`;
  }
  if (s < 86400) {
    const hours = Math.round((s / 3600) * 10) / 10;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round((s / 86400) * 10) / 10;
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function parseDurationString(input) {
  if (!input) return null;
  const clean = String(input).trim().toLowerCase();
  
  // Match patterns like "30m", "1h", "12h", "1d", "7d", "300s", "2 hours", "3 days"
  const match = clean.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours|d|day|days|w|week|weeks)?$/i);
  if (!match) return null;

  const val = parseFloat(match[1]);
  if (isNaN(val) || val <= 0) return null;

  const unit = (match[2] || 'h').toLowerCase();
  if (['s', 'sec', 'secs', 'seconds'].includes(unit)) {
    return Math.round(val);
  }
  if (['m', 'min', 'mins', 'minutes'].includes(unit)) {
    return Math.round(val * 60);
  }
  if (['h', 'hr', 'hrs', 'hours'].includes(unit)) {
    return Math.round(val * 3600);
  }
  if (['d', 'day', 'days'].includes(unit)) {
    return Math.round(val * 86400);
  }
  if (['w', 'week', 'weeks'].includes(unit)) {
    return Math.round(val * 7 * 86400);
  }

  // Default to hours if no unit specified
  return Math.round(val * 3600);
}

export function generateTempTokenCode() {
  return generateCode('temp', 14);
}

export async function generateTempToken(targetCode, durationSeconds, options = {}) {
  const cleanTarget = String(targetCode || '').trim();
  if (!cleanTarget) {
    return { ok: false, reason: 'missing_target_code' };
  }

  // Verify target file or batch exists
  let targetType = 'file';
  let targetDoc = null;

  if (cleanTarget.startsWith('batch_')) {
    targetType = 'batch';
    targetDoc = await getBatch(cleanTarget);
  } else if (cleanTarget.startsWith('file_')) {
    targetType = 'file';
    targetDoc = await getFile(cleanTarget);
  } else {
    // Try file first, then batch
    targetDoc = await getFile(cleanTarget);
    if (targetDoc) {
      targetType = 'file';
    } else {
      targetDoc = await getBatch(cleanTarget);
      if (targetDoc) {
        targetType = 'batch';
      }
    }
  }

  if (!targetDoc) {
    return { ok: false, reason: 'target_not_found', targetCode: cleanTarget };
  }

  const duration = Math.max(30, parseInt(durationSeconds, 10) || 3600); // min 30s, default 1 hour
  const tokenCode = generateTempTokenCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + duration * 1000);

  const tokenDoc = {
    _id: tokenCode,
    targetCode: targetDoc._id || cleanTarget,
    targetType,
    durationSeconds: duration,
    durationLabel: formatDuration(duration),
    createdAt: now.toISOString(),
    expiresAt,
    createdBy: options.createdBy ? String(options.createdBy) : null,
    creatorName: options.creatorName || null,
    maxUses: options.maxUses ? parseInt(options.maxUses, 10) : null,
    useCount: 0,
    revoked: false,
    label: options.label || null,
  };

  const tempTokens = await getCollection('temp_tokens');
  await tempTokens.updateOne(
    { _id: tokenCode },
    { $set: tokenDoc },
    { upsert: true }
  );

  logActivity({
    eventType: 'temp_token_create',
    userId: options.createdBy,
    username: options.creatorUsername,
    firstName: options.creatorName,
    targetCode: tokenCode,
    targetType: 'temp_token',
    details: `Generated ${formatDuration(duration)} token for ${targetDoc._id || cleanTarget}`,
    metadata: {
      targetCode: targetDoc._id || cleanTarget,
      targetType,
      durationSeconds: duration,
      durationLabel: formatDuration(duration),
      maxUses: options.maxUses || null,
    }
  }).catch(() => {});

  return {
    ok: true,
    token: tokenCode,
    tokenDoc,
    expiresAt,
    durationSeconds: duration,
    durationLabel: formatDuration(duration),
  };
}

export async function getTempToken(tokenCode) {
  if (!tokenCode) return { ok: false, reason: 'missing_token' };
  const tempTokens = await getCollection('temp_tokens');
  const doc = await tempTokens.findOne({ _id: String(tokenCode).trim() });

  if (!doc) {
    return { ok: false, reason: 'not_found' };
  }

  if (doc.revoked) {
    return { ok: false, reason: 'revoked', tokenDoc: doc };
  }

  const now = new Date();
  const exp = new Date(doc.expiresAt);
  if (isNaN(exp.getTime()) || exp <= now) {
    return { ok: false, reason: 'expired', tokenDoc: doc };
  }

  if (doc.maxUses != null && doc.useCount >= doc.maxUses) {
    return { ok: false, reason: 'limit_reached', tokenDoc: doc };
  }

  return { ok: true, tokenDoc: doc };
}

export async function consumeTempToken(tokenCode, consumerChatId = null, consumerInfo = {}) {
  const tempTokens = await getCollection('temp_tokens');
  const updateOp = {
    $inc: { useCount: 1 },
    $set: { lastAccessedAt: new Date().toISOString() }
  };
  await tempTokens.updateOne({ _id: tokenCode }, updateOp);

  logActivity({
    eventType: 'temp_token_access',
    userId: consumerChatId,
    username: consumerInfo.username,
    firstName: consumerInfo.firstName,
    targetCode: tokenCode,
    targetType: 'temp_token',
    details: `Accessed temporary token ${tokenCode}`,
  }).catch(() => {});
}

export async function revokeTempToken(tokenCode, requesterChatId = null, isAdmin = false) {
  const tempTokens = await getCollection('temp_tokens');
  const doc = await tempTokens.findOne({ _id: String(tokenCode).trim() });

  if (!doc) {
    return { ok: false, reason: 'not_found' };
  }

  if (!isAdmin && doc.createdBy && requesterChatId && String(doc.createdBy) !== String(requesterChatId)) {
    return { ok: false, reason: 'unauthorized' };
  }

  await tempTokens.updateOne(
    { _id: doc._id },
    { $set: { revoked: true, revokedAt: new Date().toISOString() } }
  );

  logActivity({
    eventType: 'temp_token_revoke',
    userId: requesterChatId,
    targetCode: tokenCode,
    targetType: 'temp_token',
    details: `Revoked temporary token ${tokenCode} (target: ${doc.targetCode})`,
  }).catch(() => {});

  return { ok: true, tokenDoc: doc };
}

export async function listActiveTempTokens(createdBy = null, limit = 20) {
  const tempTokens = await getCollection('temp_tokens');
  const now = new Date();
  const filter = {
    expiresAt: { $gt: now },
    revoked: { $ne: true },
  };

  if (createdBy) {
    filter.createdBy = String(createdBy);
  }

  const result = await tempTokens.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
  return result;
}
