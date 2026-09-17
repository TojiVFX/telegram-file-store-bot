import {
  getSettings, updateSettings, toSmallCaps, editTelegramMessage,
  sendTelegramMessage, esc
} from '../../bot-common.js';
import { getAllWorkerBots, refreshWorkerBots, removeWorkerBot, benchmarkRelayTunnel } from '../../ghost-fleet.js';
import { navButtons } from './common.js';

export async function renderGhostFleetMgmt(chatId, messageId = null) {
  const s = await getSettings();
  const enabled = s.ghostFleetEnabled === '1';
  const workers = await getAllWorkerBots();
  const relayId = s.relayChatId ? `<code>${s.relayChatId}</code> (Active 🛡️)` : '<i>Not configured (workers use direct copy or fallback)</i>';

  let text = `👻 <b>The Ghost Fleet (Decoupled Worker Bots)</b>\n\n` +
    `• Mode: <b>${enabled ? '🟢 Active (Decoupled Delivery)' : '⚪ Inactive (Direct Delivery)'}</b>\n` +
    `• Air-Gap Relay Tunnel: ${relayId}\n` +
    `• Active Delivery Nodes: <b>${workers.filter(w => w.enabled && w.role !== 'standby').length}</b>\n` +
    `• Standby Reserve Nodes: <b>${workers.filter(w => w.enabled && w.role === 'standby').length}</b>\n\n` +
    `<i>When active, the main bot never delivers media directly. With the Air-Gap Relay Tunnel configured, worker bots deliver media without ever being added to your DB Channel!</i>\n\n`;

  const workerButtons = [];
  if (workers.length === 0) {
    text += `⚠️ <i>No worker bots connected yet. Tap 'Add Worker' below or configure <code>WORKER_BOT_TOKENS=token1,token2</code> in your .env.</i>\n`;
  } else {
    text += `<b>Delivery Nodes & Circuit Breaker:</b>\n`;
    for (const w of workers) {
      let statusIcon = '🟢';
      let statusText = 'Online';
      if (w.circuitState === 'BANNED' || w.isAlive === false) {
        statusIcon = '🔴';
        statusText = w.bannedReason || w.error || 'Banned / Inactive';
      } else if (w.circuitState === 'COOLDOWN' && w.cooldownUntil && w.cooldownUntil > Date.now()) {
        statusIcon = '⏱️';
        statusText = `Cooldown (${Math.ceil((w.cooldownUntil - Date.now()) / 1000)}s)`;
      } else if (w.role === 'standby') {
        statusIcon = '🟡';
        statusText = 'Standby Reserve';
      }

      const roleBadge = w.role === 'standby' ? ' [STANDBY]' : '';
      const name = w.username ? `@${esc(w.username)}` : `ID: ${w.botId}`;
      text += `• ${statusIcon} <b>${name}</b>${roleBadge} [${(w.source || 'db').toUpperCase()}] — <i>${statusText}</i>\n`;
      if (w.source === 'db') {
        workerButtons.push([{
          text: toSmallCaps(`🗑 Remove ${w.username ? '@' + w.username : w.botId}`),
          callback_data: `admin:remove_worker:${w.botId}`
        }]);
      }
    }
  }

  const buttons = [];
  buttons.push([
    { text: toSmallCaps(enabled ? 'Disable Ghost Fleet' : 'Enable Ghost Fleet'), callback_data: `admin:toggle_ghost_fleet:${enabled ? 0 : 1}` },
    { text: toSmallCaps('🔄 Check Health'), callback_data: 'admin:refresh_workers' }
  ]);
  buttons.push([
    { text: toSmallCaps('➕ Add Active Worker'), callback_data: 'admin:add_worker_prompt' },
    { text: toSmallCaps('🛡️ Add Standby Worker'), callback_data: 'admin:add_standby_prompt' }
  ]);
  const relayRow = [
    { text: toSmallCaps(s.relayChatId ? '📡 Change Relay' : '📡 Set Relay Tunnel'), callback_data: 'admin:set_relay_prompt' }
  ];
  if (s.relayChatId) {
    relayRow.push({ text: toSmallCaps('🧪 Test Tunnel'), callback_data: 'admin:test_relay' });
    relayRow.push({ text: toSmallCaps('❌ Clear'), callback_data: 'admin:clear_relay' });
  }
  buttons.push(relayRow);
  if (workerButtons.length > 0) {
    buttons.push(...workerButtons);
  }
  buttons.push(...navButtons('admin:sec_hub'));

  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
  } else {
    await sendTelegramMessage(chatId, text, { inline_keyboard: buttons });
  }
}

export const ghostFleetActions = {
  ghost_fleet: async ({ chatId, messageId }) => {
    await renderGhostFleetMgmt(chatId, messageId);
  },
  'toggle_ghost_fleet:': async ({ chatId, messageId, action, safeAnswer, cq }) => {
    const val = action.split(':')[1];
    await updateSettings({ ghostFleetEnabled: val });
    await safeAnswer(cq.id, `Ghost Fleet ${val === '1' ? 'Enabled' : 'Disabled'}`);
    await renderGhostFleetMgmt(chatId, messageId);
  },
  refresh_workers: async ({ chatId, messageId, safeAnswer, cq }) => {
    await refreshWorkerBots();
    await safeAnswer(cq.id, 'Worker bots health re-checked!');
    await renderGhostFleetMgmt(chatId, messageId);
  },
  add_worker_prompt: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: 'add_worker', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    const promptText = `🤖 <b>Add Ghost Fleet Worker Bot</b>\n\n` +
      `Create a new bot with @BotFather and paste its API token here.\n\n` +
      `<b>Format:</b>\n<code>123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ</code>\n\n` +
      `<i>Worker bots will automatically connect to your webhook mesh and handle media deliveries.</i>\n\n` +
      `Send /cancel to abort.`;
    await editTelegramMessage(chatId, messageId, promptText, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:ghost_fleet' }]]
    });
  },
  add_standby_prompt: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: 'add_standby_worker', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    const promptText = `🛡️ <b>Add Standby Reserve Worker Bot</b>\n\n` +
      `Create a reserve worker bot with @BotFather and paste its API token here.\n\n` +
      `<b>Format:</b>\n<code>123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ</code>\n\n` +
      `<i>This bot will remain in reserve. If an active worker bot is banned or rate-limited, this standby bot will be automatically hot-swapped into rotation!</i>\n\n` +
      `Send /cancel to abort.`;
    await editTelegramMessage(chatId, messageId, promptText, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:ghost_fleet' }]]
    });
  },
  'remove_worker:': async ({ chatId, messageId, action, safeAnswer, cq }) => {
    const botId = action.split(':')[1];
    const removed = await removeWorkerBot(botId);
    if (removed) {
      await safeAnswer(cq.id, `Worker bot removed.`);
    } else {
      await safeAnswer(cq.id, `Could not remove worker (it might be configured in .env).`, true);
    }
    await renderGhostFleetMgmt(chatId, messageId);
  },
  set_relay_prompt: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'relay_chat_id', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    const promptText = `📡 <b>Configure Air-Gapped Relay Tunnel</b>\n\n` +
      `Create a private group or channel (e.g. "Transit Tunnel") and add:\n` +
      `1. <b>Main Bot</b> (as Admin with Post & Delete Messages permissions)\n` +
      `2. <b>Worker Bot(s)</b> (as Admin with Post Messages permissions)\n\n` +
      `Forward any message from that group/channel here, or type the ID directly (e.g. <code>-100123456789</code>).\n\n` +
      `<i>Your Main DB Storage Channel remains 100% sacred and isolated — no worker bots will ever touch it!</i>\n\n` +
      `Send /cancel to abort.`;
    await editTelegramMessage(chatId, messageId, promptText, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:ghost_fleet' }]]
    });
  },
  clear_relay: async ({ chatId, messageId, safeAnswer, cq }) => {
    await updateSettings({ relayChatId: '' });
    await safeAnswer(cq.id, 'Air-Gap Relay Tunnel removed.');
    await renderGhostFleetMgmt(chatId, messageId);
  },
  test_relay: async ({ chatId, messageId, safeAnswer, cq }) => {
    await safeAnswer(cq.id, '🧪 Running Relay Tunnel Benchmark...');
    const res = await benchmarkRelayTunnel();
    if (res.ok) {
      const report = `🧪 <b>Relay Tunnel Benchmark Result</b>\n\n` +
        `• <b>Tunnel Status:</b> 🟢 <b>Operational</b>\n` +
        `• <b>Total Transit Latency:</b> <b>${res.totalLatencyMs}ms</b> ⚡\n` +
        `• <b>Main Bot Post:</b> <b>${res.mainPostLatencyMs}ms</b>\n` +
        `• <b>Worker Bot Transit:</b> <b>${res.workerTransitLatencyMs}ms</b>\n` +
        `• <b>Tested Worker:</b> @${esc(res.workerUsername)}\n` +
        `• <b>Relay Chat ID:</b> <code>${res.relayChatId}</code>\n\n` +
        `✅ <i>Permissions verified: Main Bot posted probe, Worker Bot accessed it, and test message was cleanly purged!</i>`;
      const buttons = [
        [{ text: toSmallCaps('🔄 Run Again'), callback_data: 'admin:test_relay' }],
        [{ text: toSmallCaps('« Back to Ghost Fleet'), callback_data: 'admin:ghost_fleet' }]
      ];
      await editTelegramMessage(chatId, messageId, report, { inline_keyboard: buttons });
    } else {
      const report = `❌ <b>Relay Tunnel Test Failed</b>\n\n` +
        `• <b>Failed Step:</b> <code>${res.step || 'Configuration'}</code>\n` +
        `• <b>Error:</b> <code>${esc(res.error || 'Unknown error')}</code>\n\n` +
        `<b>Troubleshooting:</b>\n` +
        `1. Ensure both Main Bot and Worker Bot(s) are in the Relay chat.\n` +
        `2. Ensure Main Bot has <b>Post Messages</b> and <b>Delete Messages</b> permissions.\n` +
        `3. Ensure Worker Bot has <b>Post Messages</b> permission.`;
      const buttons = [
        [{ text: toSmallCaps('🔄 Retry Test'), callback_data: 'admin:test_relay' }],
        [{ text: toSmallCaps('« Back to Ghost Fleet'), callback_data: 'admin:ghost_fleet' }]
      ];
      await editTelegramMessage(chatId, messageId, report, { inline_keyboard: buttons });
    }
  }
};
