import {
  toSmallCaps, editTelegramMessage, sendTelegramMessage, esc, updateSettings, formatISTDateTime
} from '../../bot-common.js';
import { getDbChannelId, getBackupDbChannelId, getChannelDisplayDetails } from '../../channel-helpers.js';
import { getStorageAuditStats, runRetroactiveMirror, scanAndRepairBrokenLinks, getLatestDbAuditReport, runAutomatedDbAudit } from '../../filestore.js';
import { getStandbyChannelId } from '../../phoenix-protocol.js';
import { navButtons } from './common.js';

export async function renderStorageAudit(chatId, messageId = null) {
  const primaryCid = await getDbChannelId();
  const backupCid = await getBackupDbChannelId();
  const standbyCid = await getStandbyChannelId();

  const primaryInfo = primaryCid ? await getChannelDisplayDetails(primaryCid) : null;
  const backupInfo = backupCid ? await getChannelDisplayDetails(backupCid) : null;
  const standbyInfo = standbyCid ? await getChannelDisplayDetails(standbyCid) : null;

  const stats = await getStorageAuditStats();
  const latestAudit = await getLatestDbAuditReport();
  const redundancyPct = stats.total > 0 ? Math.round((stats.mirrored / stats.total) * 100) : 100;
  const cdnPct = stats.total > 0 ? Math.round(((stats.cachedFileIds || 0) / stats.total) * 100) : 100;

  let primaryBlock = '';
  if (primaryInfo) {
    const pTitle = esc(primaryInfo.title);
    const pTitleDisplay = primaryInfo.link ? `<a href="${primaryInfo.link}">${pTitle}</a>` : `<b>${pTitle}</b>`;
    primaryBlock = `• <b>Primary DB Channel:</b> ${pTitleDisplay}\n` +
      `  ID: <code>${primaryInfo.id}</code>\n` +
      `  Status: <b>${primaryInfo.isAdmin ? '✅ Admin (Active)' : '❌ Not Admin / Inaccessible'}</b>\n\n`;
  } else {
    primaryBlock = `• <b>Primary DB Channel:</b> <code>Not Set</code>\n` +
      `  Status: <b>❌ Not Configured</b>\n\n`;
  }

  let backupBlock = '';
  if (backupInfo) {
    const bTitle = esc(backupInfo.title);
    const bTitleDisplay = backupInfo.link ? `<a href="${backupInfo.link}">${bTitle}</a>` : `<b>${bTitle}</b>`;
    backupBlock = `• <b>Backup DB Channel:</b> ${bTitleDisplay}\n` +
      `  ID: <code>${backupInfo.id}</code>\n` +
      `  Status: <b>${backupInfo.isAdmin ? '✅ Admin (Active)' : '❌ Bot Not Admin / Inaccessible'}</b>\n\n`;
  } else {
    backupBlock = `• <b>Backup DB Channel:</b> <code>Not Configured</code>\n` +
      `  Status: <b>⚠️ Inactive</b>\n\n`;
  }

  let standbyBlock = '';
  if (standbyInfo) {
    const sTitle = esc(standbyInfo.title);
    const sTitleDisplay = standbyInfo.link ? `<a href="${standbyInfo.link}">${sTitle}</a>` : `<b>${sTitle}</b>`;
    standbyBlock = `• <b>Standby Channel (Phoenix Protocol):</b> ${sTitleDisplay}\n` +
      `  ID: <code>${standbyInfo.id}</code>\n` +
      `  Status: <b>${standbyInfo.isAdmin ? '🔥 Armed (Autonomous Self-Healing Active)' : '❌ Bot Not Admin / Inaccessible'}</b>\n\n`;
  } else {
    standbyBlock = `• <b>Standby Channel (Phoenix Protocol):</b> <code>Not Configured</code>\n` +
      `  Status: <b>⚪ Disarmed (Set Standby for Auto Self-Healing)</b>\n\n`;
  }

  let text = `🛡 <b>Storage & Redundancy Audit</b>\n\n` +
    primaryBlock +
    backupBlock +
    standbyBlock +
    `📊 <b>Redundancy Health:</b>\n` +
    `• Total Stored Records: <b>${stats.total}</b>\n` +
    `• Mirrored in Backup: <b>${stats.mirrored}</b>\n` +
    `• Unmirrored Records: <b>${stats.unmirrored}</b>\n` +
    `• Cloud CDN Redundancy: <b>${stats.cachedFileIds || 0}/${stats.total} (${cdnPct}%)</b>\n` +
    `• Channel Failover Coverage: <b>${redundancyPct}%</b>\n\n` +
    `🩺 <b>Automated Link Integrity & Self-Healing:</b>\n` +
    `• Last Auditor Scan: <b>${latestAudit ? formatISTDateTime(latestAudit.scannedAt) : 'Never run'}</b>\n` +
    `• Records Inspected: <b>${latestAudit?.totalScanned || 0}</b>\n` +
    `• Healthy: <b>${latestAudit?.healthy || 0}</b> | Auto-Healed: <b>${latestAudit?.healed || 0}</b>\n` +
    `• Dead / Missing: <b>${latestAudit?.unrecoverable || 0}</b>\n\n`;

  if (!backupCid) {
    text += `<i>💡 Tip: Set a backup channel to automatically duplicate all stored files and prevent link breakage if your primary channel is struck or banned.</i>`;
  } else if (stats.unmirrored > 0) {
    text += `<i>⚠️ There are ${stats.unmirrored} record(s) not yet mirrored to your backup channel. Tap below to mirror them retroactively.</i>`;
  } else {
    text += `<i>✅ All stored records are fully synchronized and protected against bans.</i>`;
  }

  const buttons = [];
  const quickLinks = [];
  if (primaryInfo?.link) {
    quickLinks.push({ text: toSmallCaps('Primary Channel'), url: primaryInfo.link });
  }
  if (backupInfo?.link) {
    quickLinks.push({ text: toSmallCaps('Backup Channel'), url: backupInfo.link });
  }
  if (standbyInfo?.link) {
    quickLinks.push({ text: toSmallCaps('Standby Channel'), url: standbyInfo.link });
  }
  if (quickLinks.length > 0) {
    buttons.push(quickLinks);
  }

  buttons.push([
    { text: toSmallCaps(standbyCid ? '🔥 Change Phoenix Standby' : '🔥 Set Phoenix Standby'), callback_data: 'admin:set_standby_prompt' }
  ]);

  buttons.push([
    { text: toSmallCaps('🩺 Run Deep DB Audit Now'), callback_data: 'admin:run_deep_audit' }
  ]);

  if (!backupCid) {
    buttons.push([{ text: toSmallCaps('Set Backup Channel'), callback_data: 'admin:set_backup_channel_prompt' }]);
    buttons.push([{ text: toSmallCaps('Scan & Heal Links'), callback_data: 'admin:scan_heal_links' }]);
  } else {
    buttons.push([
      { text: toSmallCaps('Change Backup Channel'), callback_data: 'admin:set_backup_channel_prompt' },
      { text: toSmallCaps('Scan & Heal Links'), callback_data: 'admin:scan_heal_links' }
    ]);
    if (stats.unmirrored > 0) {
      buttons.push([
        { text: toSmallCaps(`Sync Unmirrored (${stats.unmirrored})`), callback_data: 'admin:run_retro_mirror' }
      ]);
    }
    buttons.push([
      { text: toSmallCaps('Promote Backup to Primary'), callback_data: 'admin:promote_backup_confirm' }
    ]);
  }
  buttons.push([
    { text: toSmallCaps('Rebuild Channel Storage'), callback_data: 'admin:rebuild_channel_prompt' }
  ]);
  buttons.push(...navButtons('admin:file_mgmt'));

  const keyboard = { inline_keyboard: buttons };
  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, keyboard);
  } else {
    await sendTelegramMessage(chatId, text, keyboard);
  }
}

export const storageAuditActions = {
  storage_audit: async ({ chatId, messageId }) => {
    await renderStorageAudit(chatId, messageId);
  },
  set_backup_channel_prompt: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'backup_db_channel', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    const promptText = `🛡 <b>Configure Backup DB Channel</b>\n\n` +
      `Forward any post from your secondary/backup database channel, or type the channel ID directly (e.g. <code>-100123456789</code>).\n\n` +
      `⚠️ <i>Make sure this bot is already added as an Admin in that channel with 'Post Messages' permissions.</i>\n\n` +
      `Send /cancel to abort.`;
    await editTelegramMessage(chatId, messageId, promptText, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:storage_audit' }]]
    });
  },
  set_standby_prompt: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'standby_channel_id', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    const promptText = `🔥 <b>Configure Standby Channel (The Phoenix Protocol)</b>\n\n` +
      `Forward any post from your standby/reserve storage channel, or type the channel ID directly (e.g. <code>-100123456789</code>).\n\n` +
      `🛡️ <i>If your primary database channel ever suffers a copyright strike or ban, the Phoenix Protocol will autonomously promote this standby channel and rebuild all files without downtime!</i>\n\n` +
      `⚠️ <i>Ensure this bot is added as an Admin in that channel with 'Post Messages' permission.</i>\n\n` +
      `Send /cancel to abort.`;
    await editTelegramMessage(chatId, messageId, promptText, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:storage_audit' }]]
    });
  },
  rebuild_channel_prompt: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'rebuild_channel_id', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    const promptText = `🔄 <b>One-Click Channel Rebuilder</b>\n\n` +
      `This tool scans all files stored in your bot and re-posts them into a fresh channel using Telegram's cached File IDs. All existing sharing links remain valid without downtime!\n\n` +
      `<b>Steps:</b>\n` +
      `1. Create a new Telegram channel and add this bot as an <b>Admin</b> (with Post Messages permission).\n` +
      `2. Forward any message from that channel here, or enter the channel ID directly (e.g. <code>-1001234567890</code>).\n\n` +
      `<i>Alternatively, you can run <code>/rebuildchannel &lt;channel_id&gt;</code> directly.</i>\n\n` +
      `Send /cancel to abort.`;
    await editTelegramMessage(chatId, messageId, promptText, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:storage_audit' }]]
    });
  },
  run_retro_mirror: async ({ chatId, messageId, safeAnswer, cq }) => {
    const primaryCid = await getDbChannelId();
    const backupCid = await getBackupDbChannelId();

    if (!primaryCid || !backupCid) {
      await safeAnswer(cq.id, 'Both primary and backup channels must be configured!', true);
      return;
    }

    await editTelegramMessage(chatId, messageId, `⏳ <b>Mirroring unmirrored records to backup channel...</b>\n\nPlease wait a moment while files are copied.`);
    const mirrorResult = await runRetroactiveMirror(primaryCid, backupCid, 100);
    await safeAnswer(cq.id, `Mirrored: ${mirrorResult.mirroredSuccess}, Failed: ${mirrorResult.mirroredFailed}`, true);
    await renderStorageAudit(chatId, messageId);
  },
  promote_backup_confirm: async ({ chatId, messageId }) => {
    const text = `⚠️ <b>EMERGENCY FAILOVER / PROMOTE BACKUP</b>\n\n` +
      `This action will promote your current <b>Backup DB Channel</b> to become the <b>Primary DB Channel</b>.\n\n` +
      `Use this if your primary channel was copyright-struck, deleted, or permanently banned.\n\n` +
      `Are you sure you want to proceed?`;
    const buttons = [
      [{ text: toSmallCaps('Confirm: Promote Backup to Primary'), callback_data: 'admin:promote_backup_exec' }],
      [{ text: toSmallCaps('Cancel'), callback_data: 'admin:storage_audit' }]
    ];
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
  },
  promote_backup_exec: async ({ chatId, messageId, safeAnswer, cq }) => {
    const backupCid = await getBackupDbChannelId();
    if (!backupCid) {
      await safeAnswer(cq.id, 'No backup channel configured!', true);
      return;
    }
    await updateSettings({
      dbChannelId: backupCid,
      backupDbChannelId: ''
    });
    await safeAnswer(cq.id, 'Backup channel successfully promoted to Primary!', true);
    await renderStorageAudit(chatId, messageId);
  },
  scan_heal_links: async ({ chatId, messageId, safeAnswer, cq }) => {
    const primaryCid = await getDbChannelId();
    const backupCid = await getBackupDbChannelId();

    if (!primaryCid) {
      await safeAnswer(cq.id, 'Primary DB Channel not configured!', true);
      return;
    }

    await editTelegramMessage(chatId, messageId, `🩺 <b>Scanning stored links...</b>\n\nTesting messages and auto-repairing from backup if needed.\nPlease wait a moment.`);

    const report = await scanAndRepairBrokenLinks(primaryCid, backupCid, 50);
    await safeAnswer(cq.id, `Healthy: ${report.healthy}, Healed: ${report.healed}, Dead: ${report.unrecoverable}`, true);
    await renderStorageAudit(chatId, messageId);
  },
  run_deep_audit: async ({ chatId, messageId, safeAnswer, cq }) => {
    const primaryCid = await getDbChannelId();
    if (!primaryCid) {
      await safeAnswer(cq.id, 'Primary DB Channel not configured!', true);
      return;
    }
    await editTelegramMessage(chatId, messageId, `🩺 <b>Running Deep Database & Link Integrity Audit...</b>\n\nTesting stored records against primary channel and self-healing from backup...`);
    const res = await runAutomatedDbAudit({ batchSize: 100, fullScan: true, notifyAdmin: false });
    if (!res.ok) {
      await safeAnswer(cq.id, `Audit failed: ${res.error}`, true);
    } else {
      await safeAnswer(cq.id, `Audit Complete! Inspected: ${res.totalScanned}, Healthy: ${res.healthy}, Healed: ${res.healed}, Dead: ${res.unrecoverable}`, true);
    }
    await renderStorageAudit(chatId, messageId);
  }
};
