import { getCollection, getSettings } from './bot-common.js';

export function generateFileCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `file_${result}`;
}

export async function storeFile(fileCode, dataObj) {
  const files = await getCollection('files');
  await files.updateOne(
    { _id: fileCode },
    { $set: { ...dataObj, createdAt: new Date().toISOString() } },
    { upsert: true }
  );
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
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `batch_${result}`;
}

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

export async function getShortenedLink(targetUrl, botId = null) {
  const s = await getSettings();
  if (!s?.shortenerUrl || !s?.shortenerKey) return null;

  try {
    const apiUrl = `${s.shortenerUrl}?api=${s.shortenerKey}&url=${encodeURIComponent(targetUrl)}`;
    const res    = await fetch(apiUrl);
    if (!res.ok) return null;
    const data   = await res.json();
    return data.short_url ?? data.link ?? data.url ?? null;
  } catch (err) {
    console.error('getShortenedLink error:', err.message);
    return null;
  }
}
