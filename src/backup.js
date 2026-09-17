import {
  getCollection, sendTelegramFileBuffer, formatISTDateTime, log
} from './bot-common.js';
import { getLogChannelId } from './bot-logs.js';
import { getAdminIds } from './auth.js';

// ─── Database Backup System ───────────────────────────────────────────────────
export async function generateDatabaseBackupBuffer() {
  const collectionsToExport = ['files', 'users', 'channels', 'settings', 'stats', 'temp_tokens'];
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

  const allFiles = backupData.collections.files || [];
  const jsonStr = JSON.stringify(backupData, null, 2);
  const buffer = Buffer.from(jsonStr, 'utf-8');
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `backup_${dateStr}_${Date.now()}.json`;

  return {
    buffer,
    filename,
    sizeBytes: buffer.length,
    summary: {
      files: allFiles.filter(f => f.type !== 'batch' && f.type !== 'bundle').length,
      batches: allFiles.filter(f => f.type === 'batch').length,
      bundles: allFiles.filter(f => f.type === 'bundle').length,
      users: backupData.collections.users?.length || 0,
    }
  };
}

export async function sendDatabaseBackup(targetChatId) {
  const backup = await generateDatabaseBackupBuffer();
  const dateStr = formatISTDateTime(new Date(), false);
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

  const runBackupCheck = async () => {
    try {
      const sessions = await getCollection('sessions');
      const lastDoc = await sessions.findOne({ _id: 'worker:daily_backup_last' });
      const lastRun = lastDoc?.val ? new Date(lastDoc.val).getTime() : 0;
      const now = Date.now();

      if (now - lastRun < 24 * 60 * 60 * 1000) {
        return;
      }

      const logChannelId = await getLogChannelId();
      const adminIds = getAdminIds();
      const targetChatId = logChannelId || (adminIds.length > 0 ? adminIds[0] : null);

      if (targetChatId) {
        await sendDatabaseBackup(targetChatId);
        await sessions.updateOne(
          { _id: 'worker:daily_backup_last' },
          { $set: { val: new Date().toISOString() } },
          { upsert: true }
        );
        log('info', 'Automated daily database backup completed', { targetChatId });
      }
    } catch (err) {
      log('error', 'Daily backup worker error', { errorMessage: err.message });
    }
  };

  // Run initial check upon startup
  runBackupCheck().catch(() => {});
  // Poll hourly with unref to minimize event loop wakeups
  const timer = setInterval(() => {
    runBackupCheck().catch(() => {});
  }, 60 * 60 * 1000);
  timer.unref?.();
}
