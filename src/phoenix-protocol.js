import { getSettings, updateSettings, log, esc, sendTelegramMessage } from './bot-common.js';
import { getAdminIds } from './auth.js';
import { logActivity } from './bot-logs.js';
import { rebuildChannelStorage } from './filestore.js';
import { registerChannelFailoverHandler } from './channel-helpers.js';

let isPhoenixRunning = false;

// Register failover handler with channel-helpers
registerChannelFailoverHandler(activatePhoenixProtocol);

/**
 * Retrieves the configured standby database channel ID.
 */
export async function getStandbyChannelId() {
  const s = await getSettings();
  return s?.standbyChannelId || process.env.STANDBY_DB_CHANNEL_ID || null;
}

/**
 * Saves a new standby database channel ID in settings.
 */
export async function setStandbyChannelId(channelId) {
  const cleanId = String(channelId).trim();
  return updateSettings({ standbyChannelId: cleanId });
}

/**
 * Checks if the Phoenix Protocol migration is actively executing.
 */
export function isPhoenixProtocolRunning() {
  return isPhoenixRunning;
}

/**
 * Autonomous self-healing failover protocol:
 * Re-points primary storage pointer to Standby Channel and rebuilds
 * all stored files via cached Telegram CDN File IDs without downtime.
 */
export async function activatePhoenixProtocol(triggerReason = 'Storage Channel Inaccessible') {
  if (isPhoenixRunning) {
    log('warn', 'Phoenix Protocol is already executing in background.');
    return { ok: false, reason: 'already_running' };
  }

  const s = await getSettings();
  const primaryCid = s?.dbChannelId || process.env.DB_CHANNEL_ID || null;
  const standbyCid = await getStandbyChannelId();

  const adminIds = getAdminIds();

  if (!standbyCid || String(standbyCid) === String(primaryCid)) {
    log('warn', 'Phoenix Protocol trigger aborted: No valid standby channel configured.', { primaryCid, standbyCid });
    for (const aid of adminIds) {
      await sendTelegramMessage(
        aid,
        `⚠️ <b>The Phoenix Protocol Alert</b>\n\n` +
        `Primary Storage Channel (<code>${primaryCid || 'Not Set'}</code>) failed: <i>${esc(triggerReason)}</i>.\n\n` +
        `❌ Cannot initiate autonomous self-healing because no <b>Standby Channel</b> is configured.\n` +
        `Configure a standby channel via <b>/setting > Storage Audit</b> to enable autonomous self-healing.`
      ).catch(() => {});
    }
    return { ok: false, reason: 'no_standby_channel' };
  }

  isPhoenixRunning = true;
  log('info', '🔥 The Phoenix Protocol triggered!', { primaryCid, standbyCid, triggerReason });

  // Phase 1: Notify Admins of autonomous activation
  const startNotice = `🔥 <b>THE PHOENIX PROTOCOL INITIATED!</b>\n\n` +
    `• <b>Compromised Channel:</b> <code>${primaryCid}</code>\n` +
    `• <b>Trigger Reason:</b> <code>${esc(triggerReason)}</code>\n` +
    `• <b>Standby Channel:</b> <code>${standbyCid}</code>\n\n` +
    `⚡ <b>Autonomous Actions in Progress:</b>\n` +
    `1. Promoting Standby Channel (<code>${standbyCid}</code>) to active primary storage.\n` +
    `2. Background re-mirroring of all records via Telegram Cloud CDN file IDs.\n` +
    `3. End users will experience 0 link downtime.`;

  for (const aid of adminIds) {
    await sendTelegramMessage(aid, startNotice).catch(() => {});
  }

  // Phase 2: Promote Standby Channel immediately to active Primary Channel in settings
  await updateSettings({
    dbChannelId: String(standbyCid),
    standbyChannelId: '',
    previousFailedChannelId: String(primaryCid)
  });

  // Phase 3: Execute background re-mirroring
  (async () => {
    try {
      const res = await rebuildChannelStorage(standbyCid, (prog) => {
        log('info', `Phoenix Rebuild Progress: ${prog.processed}/${prog.total}`);
      });

      const finishNotice = `🕊️ <b>The Phoenix Protocol Rebuild Complete!</b>\n\n` +
        `• <b>Restored Records:</b> <b>${res.restored}</b>\n` +
        `• <b>Failed Records:</b> <b>${res.failed}</b>\n` +
        `• <b>Total Eligible:</b> <b>${res.total}</b>\n` +
        `• <b>New Active Channel:</b> <code>${standbyCid}</code>\n\n` +
        `🎉 <i>Storage self-healing complete! All existing links remain 100% active.</i>`;

      for (const aid of adminIds) {
        await sendTelegramMessage(aid, finishNotice).catch(() => {});
      }

      logActivity({
        eventType: 'phoenix_protocol_complete',
        targetCode: String(standbyCid),
        targetType: 'channel',
        details: `Phoenix Protocol rebuilt ${res.restored}/${res.total} files into ${standbyCid}`,
      }).catch(() => {});
    } catch (err) {
      log('error', 'Phoenix Protocol rebuild failed', { error: err.message });
      for (const aid of adminIds) {
        await sendTelegramMessage(aid, `❌ <b>Phoenix Protocol Background Rebuild Failed:</b>\n<code>${esc(err.message)}</code>`).catch(() => {});
      }
    } finally {
      isPhoenixRunning = false;
    }
  })();

  return { ok: true, standbyChannelId: standbyCid };
}
