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

export async function storeBatch(batchCode, dbChannelId, dbMessageIds, creator = {}, backupData = {}) {
  const files = await getCollection('files');
  const updateData = {
    type: 'batch',
    dbChannelId,
    dbMessageIds,
    createdAt: new Date().toISOString(),
  };
  if (backupData.backupDbChannelId && Array.isArray(backupData.backupDbMessageIds) && backupData.backupDbMessageIds.length) {
    updateData.backupDbChannelId = backupData.backupDbChannelId;
    updateData.backupDbMessageIds = backupData.backupDbMessageIds;
  }
  await files.updateOne(
    { _id: batchCode },
    { $set: updateData },
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
    metadata: { count, dbChannelId, backupDbChannelId: backupData.backupDbChannelId }
  }).catch(() => {});
}

export async function getBatch(batchCode) {
  const files = await getCollection('files');
  return await files.findOne({ _id: batchCode });
}

export async function setBatchSession(chatId, state) {
  const { collectedIds, backupCollectedIds, ...meta } = state;
  const sessions = await getCollection('sessions');
  const key = `admin:batch:session:${chatId}`;
  const expiresAt = new Date(Date.now() + 600 * 1000);

  const updateData = { ...meta, expiresAt };
  if (Object.prototype.hasOwnProperty.call(state, 'collectedIds')) {
    updateData.collectedIds = collectedIds || [];
  }
  if (Object.prototype.hasOwnProperty.call(state, 'backupCollectedIds')) {
    updateData.backupCollectedIds = backupCollectedIds || [];
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

export async function addIdToBatch(chatId, messageId, backupMessageId = null) {
  const sessions = await getCollection('sessions');
  const key = `admin:batch:session:${chatId}`;
  const pushData = { collectedIds: messageId };
  if (backupMessageId) {
    pushData.backupCollectedIds = backupMessageId;
  }
  await sessions.updateOne(
    { _id: key },
    { $push: pushData }
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

// ─── Multi-Quality Bundle Store ─────────────────────────────────────────────

export function generateBundleCode() {
  return generateCode('bundle');
}

export function cleanMediaFileName(rawName) {
  if (!rawName || typeof rawName !== 'string') return '';

  let name = rawName.trim();

  // 1. Strip file extension (.mkv, .mp4, .avi, .ts, .webm, .m4v, .mov, .flv, etc.)
  name = name.replace(/\.(mkv|mp4|avi|ts|webm|m4v|mov|flv|wmv|3gp)$/i, '');

  // 2. Strip bracketed release group prefix at the start, e.g. [SubsPlease], [Erai-raws], [Judas], (ASW)
  name = name.replace(/^(\[[^\]]+\]|\([^)]+\))\s*/g, '');

  // 3. Strip bracketed CRC hashes or tags at the end, e.g. [F4B3C5], [1080p], (720p), etc.
  name = name.replace(/\s*(\[[0-9A-Fa-f]{6,8}\]|\b[0-9A-Fa-f]{8}\b)\s*$/g, '');

  // 4. Replace dots and underscores with spaces
  name = name.replace(/[._]+/g, ' ');

  // 5. Strip common video/audio encoding tags, source tags, and resolution keywords
  const noiseRegex = /\b(2160p|1080p|720p|480p|360p|4k|uhd|fhd|hd|sd|hevc|x264|x265|h264|h265|avc|10bit|8bit|web-?dl|webrip|web|bluray|blu-?ray|brrip|bdrip|dvdrip|hdtv|pdtv|dsr|aac|flac|mp3|ac3|eac3|ddp\d*|remux)\b/gi;
  name = name.replace(noiseRegex, ' ');

  // 6. Strip standalone empty brackets like [] or ()
  name = name.replace(/\[\s*\]|\(\s*\)/g, ' ');

  // 7. Clean up multiple spaces, leading/trailing hyphens/colons/whitespace
  name = name.replace(/\s{2,}/g, ' ');
  name = name.replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '').trim();

  return name;
}

export function extractMediaTitle(message) {
  if (!message) return 'Multi-Quality Release';

  const rawFileName = message.document?.file_name || message.video?.file_name || '';
  const cleanName = cleanMediaFileName(rawFileName);

  const caption = message.caption || message.text || '';

  // Extract episode metadata from caption (e.g. "📟 Episode - 1" or "Ep: 05")
  let epLabel = '';
  const epMatch = caption.match(/(?:Episode|Ep|EP)\s*[-:]*\s*(\d+)/i);
  if (epMatch) {
    epLabel = `Episode ${epMatch[1]}`;
  }

  // Extract language metadata from caption (e.g. "🎧 Language - Hindi")
  let langLabel = '';
  const langMatch = caption.match(/(?:Language|Lang|Audio)\s*[-:]*\s*([a-zA-Z\s]+?)(?=\n|$|[,\/&])/i);
  if (langMatch) {
    const rawLang = langMatch[1].trim();
    if (rawLang && rawLang.length <= 20) {
      langLabel = rawLang;
    }
  }

  // If we have a clean filename from the file:
  if (cleanName) {
    let finalTitle = cleanName;

    // Check if cleanName already has an episode indicator (e.g. "S02E01", "E01", "Ep 1", "Episode 1", "- 01")
    const hasEpInName = /(?:S\d+)?E\d+|\b(?:Episode|Ep)\.?\s*\d+|-\s*\d+\b/i.test(finalTitle);

    if (!hasEpInName && epLabel) {
      finalTitle += ` - ${epLabel}`;
    }

    if (langLabel && !new RegExp(`\\b${langLabel}\\b`, 'i').test(finalTitle)) {
      finalTitle += ` [${langLabel}]`;
    }

    return finalTitle;
  }

  // Fallback: check forwarded channel title
  const forwardTitle = message.forward_from_chat?.title || message.forward_origin?.chat?.title || '';
  const cleanFwdTitle = forwardTitle ? forwardTitle.replace(/\s*\|.*$/, '').trim() : '';

  if (epLabel) {
    const base = cleanFwdTitle ? `${cleanFwdTitle} - ${epLabel}` : epLabel;
    return langLabel ? `${base} [${langLabel}]` : base;
  }

  if (cleanFwdTitle) {
    return langLabel ? `${cleanFwdTitle} [${langLabel}]` : cleanFwdTitle;
  }

  return 'Multi-Quality Release';
}

export function detectMediaQuality(message) {
  if (!message) return 'Standard';

  const text = (message.caption || message.text || '').toLowerCase();
  const docName = (message.document?.file_name || message.video?.file_name || '').toLowerCase();
  const combined = `${docName} ${text}`;

  // 1. Explicit resolution tags in caption or filename (highest precision)
  if (/\b(2160p|4k)\b/i.test(combined)) return '4K';
  if (/\b1080p\b/i.test(combined)) return '1080p';
  if (/\b720p\b/i.test(combined)) return '720p';
  if (/\b480p\b/i.test(combined)) return '480p';
  if (/\b360p\b/i.test(combined)) return '360p';

  // 2. Video pixel dimensions from Telegram video metadata
  const height = message.video?.height;
  const width = message.video?.width;
  const effectiveHeight = height && width ? Math.min(height, width) : (height || 0);

  if (effectiveHeight >= 2000) return '4K';
  if (effectiveHeight >= 1000) return '1080p';
  if (effectiveHeight >= 700) return '720p';
  if (effectiveHeight >= 450) return '480p';
  if (effectiveHeight >= 300) return '360p';

  // 3. Secondary tags (UHD, FHD, HD, SD)
  if (/\buhd\b/i.test(combined)) return '4K';
  if (/\bfhd\b/i.test(combined)) return '1080p';
  if (/\bhd\b/i.test(combined)) return '720p';
  if (/\bsd\b/i.test(combined)) return '480p';

  return 'Standard';
}

export function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return 'Unknown Size';
  const b = parseInt(bytes, 10);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(0)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function sortQualities(qualities) {
  if (!Array.isArray(qualities)) return [];
  const ORDER = { '360p': 1, '480p': 2, '720p': 3, '1080p': 4, '4k': 5, '4K': 5, '2160p': 5 };
  return [...qualities].sort((a, b) => {
    const oa = ORDER[a.quality] || 99;
    const ob = ORDER[b.quality] || 99;
    if (oa !== ob) return oa - ob;
    return (a.fileSize || 0) - (b.fileSize || 0);
  });
}

export async function storeBundle(bundleCode, title, dbChannelId, qualities, creator = {}, backupData = {}) {
  const files = await getCollection('files');
  const sorted = sortQualities(qualities);
  const updateData = {
    type: 'bundle',
    title: title || 'Multi-Quality Release',
    dbChannelId,
    qualities: sorted,
    createdAt: new Date().toISOString(),
    accessCount: 0
  };
  if (backupData.backupDbChannelId) {
    updateData.backupDbChannelId = backupData.backupDbChannelId;
  }
  await files.updateOne(
    { _id: bundleCode },
    { $set: updateData },
    { upsert: true }
  );

  logActivity({
    eventType: 'bundle_create',
    userId: creator.userId,
    username: creator.username,
    firstName: creator.firstName,
    targetCode: bundleCode,
    targetType: 'bundle',
    details: `Created bundle ${bundleCode} (${qualities.length} resolutions)`,
    metadata: { count: qualities.length, dbChannelId, backupDbChannelId: backupData.backupDbChannelId }
  }).catch(() => {});
}

export async function getBundle(bundleCode) {
  const files = await getCollection('files');
  return await files.findOne({ _id: bundleCode });
}

export async function setBundleSession(chatId, state) {
  const sessions = await getCollection('sessions');
  const key = `admin:bundle:session:${chatId}`;
  const expiresAt = new Date(Date.now() + 600 * 1000);
  await sessions.updateOne(
    { _id: key },
    { $set: { ...state, expiresAt } },
    { upsert: true }
  );
}

export async function getBundleSession(chatId) {
  const sessions = await getCollection('sessions');
  const key = `admin:bundle:session:${chatId}`;
  const doc = await sessions.findOne({ _id: key });
  if (doc && doc.expiresAt > new Date()) {
    return doc;
  }
  return null;
}

export async function addQualityToBundle(chatId, qualityItem) {
  const sessions = await getCollection('sessions');
  const key = `admin:bundle:session:${chatId}`;
  await sessions.updateOne(
    { _id: key },
    { $push: { qualities: qualityItem } }
  );
  const doc = await sessions.findOne({ _id: key });
  return doc?.qualities?.length || 0;
}

export async function clearBundleSession(chatId) {
  const sessions = await getCollection('sessions');
  const key = `admin:bundle:session:${chatId}`;
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
    const bundleInfo = f.type === 'bundle' && Array.isArray(f.qualities) ? ` (${f.qualities.map(q => q.quality).join(', ')})` : '';
    const fileQualityInfo = f.quality && f.fileSizeLabel ? ` (${f.quality} • ${f.fileSizeLabel})` : (f.quality ? ` (${f.quality})` : (f.fileSizeLabel ? ` (${f.fileSizeLabel})` : ''));

    out += `${i + 1}. [${type.toUpperCase()}] ${code}${bundleInfo}${f.type !== 'bundle' ? fileQualityInfo : ''}\n`;
    if (f.title) {
      out += `   Title:     ${f.title}\n`;
    } else if (f.fileName) {
      out += `   File:      ${f.fileName}\n`;
    }
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

export async function getStorageAuditStats() {
  const files = await getCollection('files');
  const total = await files.countDocuments({});
  const mirrored = await files.countDocuments({
    backupDbChannelId: { $exists: true, $ne: null }
  });
  return {
    total,
    mirrored,
    unmirrored: Math.max(0, total - mirrored)
  };
}

export async function runRetroactiveMirror(primaryChannelId, backupChannelId, limit = 50) {
  const { copyIntoDbChannel } = await import('./bot-helpers.js');
  const files = await getCollection('files');

  const unmirrored = await files.find({
    $or: [{ backupDbChannelId: { $exists: false } }, { backupDbChannelId: null }]
  }).limit(limit).toArray();

  let mirroredSuccess = 0;
  let mirroredFailed = 0;

  for (const item of unmirrored) {
    if (item.type === 'batch' && Array.isArray(item.dbMessageIds)) {
      const backupIds = [];
      for (const msgId of item.dbMessageIds) {
        const res = await copyIntoDbChannel(backupChannelId, primaryChannelId, msgId);
        if (res?.ok && res?.messageId) {
          backupIds.push(res.messageId);
        }
        await new Promise(r => setTimeout(r, 60));
      }
      if (backupIds.length > 0) {
        await files.updateOne(
          { _id: item._id },
          { $set: { backupDbChannelId: backupChannelId, backupDbMessageIds: backupIds } }
        );
        mirroredSuccess++;
      } else {
        mirroredFailed++;
      }
    } else if (item.dbMessageId) {
      const res = await copyIntoDbChannel(backupChannelId, primaryChannelId, item.dbMessageId);
      if (res?.ok && res?.messageId) {
        await files.updateOne(
          { _id: item._id },
          { $set: { backupDbChannelId: backupChannelId, backupDbMessageId: res.messageId } }
        );
        mirroredSuccess++;
      } else {
        mirroredFailed++;
      }
      await new Promise(r => setTimeout(r, 60));
    }
  }

  return {
    processed: unmirrored.length,
    mirroredSuccess,
    mirroredFailed
  };
}

export async function scanAndRepairBrokenLinks(primaryChannelId, backupChannelId, limit = 50, onProgress = null) {
  const { checkChannelMessageExists, copyIntoDbChannel } = await import('./bot-helpers.js');
  const files = await getCollection('files');

  const records = await files.find({}).limit(limit).toArray();

  let healthy = 0;
  let healed = 0;
  let unrecoverable = 0;

  for (let i = 0; i < records.length; i++) {
    const item = records[i];
    if (onProgress) {
      await onProgress(i + 1, records.length, { healthy, healed, unrecoverable });
    }

    if (item.type === 'batch') {
      if (Array.isArray(item.dbMessageIds) && item.dbMessageIds.length) {
        let batchModified = false;
        const newDbIds = [...item.dbMessageIds];
        let allHealthy = true;

        for (let j = 0; j < item.dbMessageIds.length; j++) {
          const pMsgId = item.dbMessageIds[j];
          const status = await checkChannelMessageExists(primaryChannelId, pMsgId);
          if (!status.alive) {
            allHealthy = false;
            const bMsgId = item.backupDbMessageIds?.[j];
            if (backupChannelId && bMsgId) {
              const bStatus = await checkChannelMessageExists(backupChannelId, bMsgId);
              if (bStatus.alive) {
                const copyRes = await copyIntoDbChannel(primaryChannelId, backupChannelId, bMsgId);
                if (copyRes?.ok && copyRes?.messageId) {
                  newDbIds[j] = copyRes.messageId;
                  batchModified = true;
                }
              }
            }
          }
          await new Promise(r => setTimeout(r, 40));
        }

        if (batchModified) {
          await files.updateOne({ _id: item._id }, { $set: { dbMessageIds: newDbIds } });
          healed++;
        } else if (allHealthy) {
          healthy++;
        } else {
          unrecoverable++;
        }
      }
    } else if (item.type === 'bundle') {
      if (Array.isArray(item.qualities) && item.qualities.length) {
        let bundleModified = false;
        const newQualities = [...item.qualities];
        let allHealthy = true;

        for (let j = 0; j < item.qualities.length; j++) {
          const q = item.qualities[j];
          const status = await checkChannelMessageExists(primaryChannelId, q.dbMessageId);
          if (!status.alive) {
            allHealthy = false;
            const bMsgId = q.backupDbMessageId;
            const bChannel = q.backupDbChannelId || item.backupDbChannelId || backupChannelId;
            if (bChannel && bMsgId) {
              const bStatus = await checkChannelMessageExists(bChannel, bMsgId);
              if (bStatus.alive) {
                const copyRes = await copyIntoDbChannel(primaryChannelId, bChannel, bMsgId);
                if (copyRes?.ok && copyRes?.messageId) {
                  newQualities[j] = { ...q, dbMessageId: copyRes.messageId };
                  bundleModified = true;
                }
              }
            }
          }
          await new Promise(r => setTimeout(r, 40));
        }

        if (bundleModified) {
          await files.updateOne({ _id: item._id }, { $set: { qualities: newQualities } });
          healed++;
        } else if (allHealthy) {
          healthy++;
        } else {
          unrecoverable++;
        }
      }
    } else if (item.dbMessageId) {
      // Single file
      const status = await checkChannelMessageExists(primaryChannelId, item.dbMessageId);
      if (status.alive) {
        healthy++;
      } else {
        const bMsgId = item.backupDbMessageId;
        const bChannel = item.backupDbChannelId || backupChannelId;
        if (bChannel && bMsgId) {
          const bStatus = await checkChannelMessageExists(bChannel, bMsgId);
          if (bStatus.alive) {
            const copyRes = await copyIntoDbChannel(primaryChannelId, bChannel, bMsgId);
            if (copyRes?.ok && copyRes?.messageId) {
              await files.updateOne({ _id: item._id }, { $set: { dbMessageId: copyRes.messageId } });
              healed++;
            } else {
              unrecoverable++;
            }
          } else {
            unrecoverable++;
          }
        } else {
          unrecoverable++;
        }
      }
      await new Promise(r => setTimeout(r, 40));
    }
  }

  return {
    totalScanned: records.length,
    healthy,
    healed,
    unrecoverable
  };
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
