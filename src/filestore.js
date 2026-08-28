import { getCollection, getSettings } from './bot-common.js';

// ─── Single file helpers ───────────────────────────────────────────────────────

/**
 * Generate a unique random code for a single file entry.
 * @returns {string}  e.g. "file_AbCdEfGhIjKl"
 */
export function generateFileCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `file_${result}`;
}

/**
 * Store a single file mapping in MongoDB.
 * @param {string} fileCode   The generated code (from generateFileCode)
 * @param {object} dataObj    Data to store (e.g. { fileId, type } or { dbChannelId, dbMessageId, type })
 */
export async function storeFile(fileCode, dataObj) {
  const files = await getCollection('files');
  await files.updateOne(
    { _id: fileCode },
    { $set: { ...dataObj, createdAt: new Date().toISOString() } },
    { upsert: true }
  );
}

/**
 * Retrieve a single file mapping from MongoDB.
 * @param {string} fileCode
 * @returns {Promise<{ fileId: string, type: string } | null>}
 */
export async function getFile(fileCode) {
  const files = await getCollection('files');
  return await files.findOne({ _id: fileCode });
}

// ─── Admin single-file waiting state ──────────────────────────────────────────

/**
 * Put an admin into "waiting for a single file upload" mode.
 * TTL of 10 minutes prevents permanently stuck states.
 * @param {number|string} chatId
 */
export async function setAdminWaitingForFile(chatId) {
  const sessions = await getCollection('sessions');
  const key = `admin:filestore:waiting:${chatId}`;
  await sessions.updateOne(
    { _id: key },
    { $set: { val: '1', expiresAt: new Date(Date.now() + 600 * 1000) } },
    { upsert: true }
  );
}

/**
 * Atomically check and clear the single-file waiting flag.
 * @param {number|string} chatId
 * @returns {Promise<boolean>}  true if the admin was waiting
 */
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

// ─── Batch helpers ─────────────────────────────────────────────────────────────

/**
 * Generate a unique random code for a batch entry.
 * @returns {string}  e.g. "batch_AbCdEfGhIjKl"
 */
export function generateBatchCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `batch_${result}`;
}

/**
 * Persist a completed batch record.
 * All IDs refer to the bot's own DB channel — never the source channel.
 *
 * @param {string}   batchCode
 * @param {number}   dbChannelId   The bot's database channel ID
 * @param {number[]} dbMessageIds  Copied message IDs inside the DB channel
 */
export async function storeBatch(batchCode, dbChannelId, dbMessageIds) {
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
}

/**
 * Retrieve a batch record.
 * @param {string} batchCode
 * @returns {Promise<{
 *   type: 'batch',
 *   dbChannelId: number,
 *   dbMessageIds: number[],
 *   createdAt: string
 * } | null>}
 */
export async function getBatch(batchCode) {
  const files = await getCollection('files');
  return await files.findOne({ _id: batchCode });
}

// ─── Batch creation session state ─────────────────────────────────────────────

/**
 * Save the current batch-creation session for an admin.
 *
 * @param {number|string} chatId
 * @param {{
 *   step: 'first' | 'last' | 'collect',
 *   collectedIds?: number[],
 *   srcChannelId?: number,
 *   srcFirstMsgId?: number,
 *   dbFirstMsgId?: number
 * }} state
 */
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

/**
 * Update only the session metadata (e.g. `step`) without touching the
 * collected-IDs list.
 *
 * @param {number|string} chatId
 * @param {object} metaPatch  Fields to merge into existing session meta (never include collectedIds)
 */
export async function updateBatchSessionMeta(chatId, metaPatch) {
  const sessions = await getCollection('sessions');
  const key = `admin:batch:session:${chatId}`;
  await sessions.updateOne(
    { _id: key },
    { $set: metaPatch }
  );
}

/**
 * Atomicly add an ID to the batch session.
 */
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

/**
 * Retrieve the current batch-creation session for an admin.
 * @param {number|string} chatId
 * @returns {Promise<{
 *   step: 'first' | 'last' | 'collect',
 *   collectedIds?: number[],
 *   srcChannelId?: number,
 *   srcFirstMsgId?: number,
 *   dbFirstMsgId?: number
 * } | null>}
 */
export async function getBatchSession(chatId) {
  const sessions = await getCollection('sessions');
  const key = `admin:batch:session:${chatId}`;
  const doc = await sessions.findOne({ _id: key });
  if (doc && doc.expiresAt > new Date()) {
    return doc;
  }
  return null;
}

/**
 * Delete the batch-creation session (after completion or cancellation).
 * @param {number|string} chatId
 */
export async function clearBatchSession(chatId) {
  const sessions = await getCollection('sessions');
  const key = `admin:batch:session:${chatId}`;
  await sessions.deleteOne({ _id: key });
}

// ─── URL shortener ────────────────────────────────────────────────────────────

/**
 * Generate a shortened link via the configured shortener API.
 * Returns null if no shortener is configured or the API call fails.
 *
 * Expected API shape: GET {url}?api={key}&url={target}
 * Response may use: { short_url } | { link } | { url }
 *
 * @param {string}       targetUrl
 * @param {string|null}  [botId]   Unused (reserved parameter, kept for call-site compatibility)
 * @returns {Promise<string | null>}
 */
/**
 * Execute weekly cleanup for files/records created between Sunday and Monday.
 * Deletes matching records from MongoDB and optionally deletes associated messages if requested.
 */
export async function runWeeklyCleanup() {
  const files = await getCollection('files');
  const allFiles = await files.find({}).toArray();

  let deletedCount = 0;
  const deletedIds = [];

  for (const item of allFiles) {
    if (!item.createdAt) continue;
    const dt = new Date(item.createdAt);
    const day = dt.getUTCDay(); // 0 = Sunday, 1 = Monday
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

export async function getShortenedLink(targetUrl, botId = null) {
  const s = await getSettings();
  if (!s?.shortenerUrl || !s?.shortenerKey) return null;

  try {
    const apiUrl = `${s.shortenerUrl}?api=${s.shortenerKey}&url=${encodeURIComponent(targetUrl)}`;
    const res    = await fetch(apiUrl);
    if (!res.ok) return null;
    const data   = await res.json();
    // Support common shortener response shapes
    return data.short_url ?? data.link ?? data.url ?? null;
  } catch (err) {
    console.error('getShortenedLink error:', err.message);
    return null;
  }
}
