import {
  getSettings, updateSettings, toSmallCaps, editTelegramMessage,
  sendTelegramMessage, esc
} from '../../bot-common.js';
import {
  getAllWorkerBots, refreshWorkerBots, removeWorkerBot,
  benchmarkRelayTunnel, setWorkerRole
} from '../../ghost-fleet.js';
import { navButtons } from './common.js';

/**
 * Main Ghost Fleet Dashboard: High-level overview and navigation hubs.
 */
export async function renderGhostFleetMgmt(chatId, messageId = null) {
  const s = await getSettings();
  const enabled = s.ghostFleetEnabled === '1';
  const workers = await getAllWorkerBots();
  const activeWorkers = workers.filter(w => w.enabled && w.role !== 'standby');
  const standbyWorkers = workers.filter(w => w.enabled && w.role === 'standby');
  const relayId = s.relayChatId ? `<code>${s.relayChatId}</code> (Active 🛡️)` : '<i>Not configured (workers use direct copy)</i>';

  let text = `👻 <b>The Ghost Fleet (Decoupled Delivery Mesh)</b>\n\n` +
    `• Mode: <b>${enabled ? '🟢 Active (Ghost Fleet Enabled)' : '⚪ Inactive (Main Bot Direct)'}</b>\n` +
    `• Air-Gap Relay Tunnel: ${relayId}\n` +
    `• 🟢 <b>Active Delivery Nodes:</b> <b>${activeWorkers.length}</b>\n` +
    `• 🛡️ <b>Standby Reserve Nodes:</b> <b>${standbyWorkers.length}</b>\n\n` +
    `<i>Main bot mints 1-time secure dispatch links. Worker bots blast media through the air-gapped relay tunnel without ever entering your sacred DB Channel!</i>`;

  const buttons = [
    [
      { text: toSmallCaps(`🟢 Active Nodes (${activeWorkers.length})`), callback_data: 'admin:workers_active' },
      { text: toSmallCaps(`🛡️ Standby Nodes (${standbyWorkers.length})`), callback_data: 'admin:workers_standby' }
    ],
    [
      { text: toSmallCaps('➕ Add Active Node'), callback_data: 'admin:add_worker_prompt' },
      { text: toSmallCaps('🛡️ Add Standby Node'), callback_data: 'admin:add_standby_prompt' }
    ],
    [
      { text: toSmallCaps(s.relayChatId ? '📡 Change Relay' : '📡 Set Relay Tunnel'), callback_data: 'admin:set_relay_prompt' },
      ...(s.relayChatId ? [
        { text: toSmallCaps('🧪 Test Tunnel'), callback_data: 'admin:test_relay' },
        { text: toSmallCaps('❌ Clear'), callback_data: 'admin:clear_relay' }
      ] : [])
    ],
    [
      { text: toSmallCaps(enabled ? 'Disable Ghost Fleet' : 'Enable Ghost Fleet'), callback_data: `admin:toggle_ghost_fleet:${enabled ? 0 : 1}` },
      { text: toSmallCaps('🔄 Check Health'), callback_data: 'admin:refresh_workers' }
    ],
    ...navButtons('admin:sec_hub')
  ];

  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
  } else {
    await sendTelegramMessage(chatId, text, { inline_keyboard: buttons });
  }
}

/**
 * Dedicated Active Delivery Nodes Panel.
 */
export async function renderActiveWorkers(chatId, messageId = null) {
  const workers = await getAllWorkerBots();
  const activeWorkers = workers.filter(w => w.enabled && w.role !== 'standby');

  let text = `🟢 <b>Active Delivery Nodes</b> (${activeWorkers.length})\n\n` +
    `<i>These bots actively receive incoming user dispatch links via round-robin rotation. Up to 30 requests/second capacity per active node.</i>\n\n`;

  const buttons = [];

  if (activeWorkers.length === 0) {
    text += `⚠️ <i>No active delivery nodes connected. Tap 'Add Active Node' below or promote a node from Standby Reserve!</i>\n\n`;
  } else {
    for (let i = 0; i < activeWorkers.length; i++) {
      const w = activeWorkers[i];
      let statusIcon = '🟢';
      let statusText = 'Online';
      if (w.circuitState === 'BANNED' || w.isAlive === false) {
        statusIcon = '🔴';
        statusText = w.bannedReason || w.error || 'Banned / Offline';
      } else if (w.circuitState === 'COOLDOWN' && w.cooldownUntil && w.cooldownUntil > Date.now()) {
        statusIcon = '⏱️';
        statusText = `Cooldown (${Math.ceil((w.cooldownUntil - Date.now()) / 1000)}s)`;
      }

      const name = w.username ? `@${esc(w.username)}` : `ID: ${w.botId}`;
      text += `<b>${i + 1}.</b> ${statusIcon} <b>${name}</b> [<code>${w.botId}</code>]\n` +
        `   • Status: <i>${statusText}</i> [${(w.source || 'db').toUpperCase()}]\n\n`;

      if (w.source === 'db') {
        buttons.push([
          { text: toSmallCaps(`🟡 Standby: @${w.username || w.botId}`), callback_data: `admin:set_worker_role:${w.botId}:standby:active` },
          { text: toSmallCaps(`🗑️ Remove`), callback_data: `admin:remove_worker:${w.botId}:active` }
        ]);
      }
    }
  }

  buttons.push([
    { text: toSmallCaps('➕ Add Active Node(s)'), callback_data: 'admin:add_worker_prompt' },
    { text: toSmallCaps('🔄 Refresh Health'), callback_data: 'admin:refresh_workers:active' }
  ]);
  buttons.push([
    { text: toSmallCaps('🛡️ View Standby Reserve'), callback_data: 'admin:workers_standby' },
    { text: toSmallCaps('« Ghost Fleet Dashboard'), callback_data: 'admin:ghost_fleet' }
  ]);

  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
  } else {
    await sendTelegramMessage(chatId, text, { inline_keyboard: buttons });
  }
}

/**
 * Dedicated Standby Reserve Nodes Panel.
 */
export async function renderStandbyWorkers(chatId, messageId = null) {
  const workers = await getAllWorkerBots();
  const standbyWorkers = workers.filter(w => w.enabled && w.role === 'standby');

  let text = `🛡️ <b>Standby Reserve Nodes</b> (${standbyWorkers.length})\n\n` +
    `<i>These bots are kept safely in cold reserve. If any active delivery bot is rate-limited or banned, the Autonomous Circuit Breaker instantly hot-swaps the next standby bot into active rotation with zero downtime!</i>\n\n`;

  const buttons = [];

  if (standbyWorkers.length === 0) {
    text += `⚠️ <i>No standby reserve nodes configured. Add reserve bots so your system can automatically recover from rate limits or bans!</i>\n\n`;
  } else {
    for (let i = 0; i < standbyWorkers.length; i++) {
      const w = standbyWorkers[i];
      let statusIcon = '🟡';
      let statusText = 'Reserve Ready';
      if (w.circuitState === 'BANNED' || w.isAlive === false) {
        statusIcon = '🔴';
        statusText = 'Banned / Inactive';
      }

      const name = w.username ? `@${esc(w.username)}` : `ID: ${w.botId}`;
      text += `<b>${i + 1}.</b> ${statusIcon} <b>${name}</b> [<code>${w.botId}</code>]\n` +
        `   • Status: <i>${statusText}</i> [${(w.source || 'db').toUpperCase()}]\n\n`;

      if (w.source === 'db') {
        buttons.push([
          { text: toSmallCaps(`🚀 Promote: @${w.username || w.botId}`), callback_data: `admin:set_worker_role:${w.botId}:active:standby` },
          { text: toSmallCaps(`🗑️ Remove`), callback_data: `admin:remove_worker:${w.botId}:standby` }
        ]);
      }
    }
  }

  buttons.push([
    { text: toSmallCaps('🛡️ Add Standby Node(s)'), callback_data: 'admin:add_standby_prompt' },
    { text: toSmallCaps('🔄 Refresh Health'), callback_data: 'admin:refresh_workers:standby' }
  ]);
  buttons.push([
    { text: toSmallCaps('🟢 View Active Nodes'), callback_data: 'admin:workers_active' },
    { text: toSmallCaps('« Ghost Fleet Dashboard'), callback_data: 'admin:ghost_fleet' }
  ]);

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
  workers_active: async ({ chatId, messageId }) => {
    await renderActiveWorkers(chatId, messageId);
  },
  workers_standby: async ({ chatId, messageId }) => {
    await renderStandbyWorkers(chatId, messageId);
  },
  'toggle_ghost_fleet:': async ({ chatId, messageId, action, safeAnswer, cq }) => {
    const val = action.split(':')[1];
    await updateSettings({ ghostFleetEnabled: val });
    await safeAnswer(cq.id, `Ghost Fleet ${val === '1' ? 'Enabled' : 'Disabled'}`);
    await renderGhostFleetMgmt(chatId, messageId);
  },
  refresh_workers: async ({ chatId, messageId, action, safeAnswer, cq }) => {
    const parts = (action || '').split(':');
    const view = parts[1];
    await refreshWorkerBots();
    await safeAnswer(cq.id, 'Fleet health re-checked!');
    if (view === 'active') {
      await renderActiveWorkers(chatId, messageId);
    } else if (view === 'standby') {
      await renderStandbyWorkers(chatId, messageId);
    } else {
      await renderGhostFleetMgmt(chatId, messageId);
    }
  },
  'set_worker_role:': async ({ chatId, messageId, action, safeAnswer, cq }) => {
    const parts = action.split(':');
    const botId = parts[1];
    const targetRole = parts[2] || 'active';
    const fromView = parts[3] || 'active';
    await setWorkerRole(botId, targetRole);
    await safeAnswer(cq.id, `Node moved to ${targetRole === 'active' ? 'Active Rotation 🟢' : 'Standby Reserve 🛡️'}!`);
    if (fromView === 'standby') {
      await renderStandbyWorkers(chatId, messageId);
    } else {
      await renderActiveWorkers(chatId, messageId);
    }
  },
  'remove_worker:': async ({ chatId, messageId, action, safeAnswer, cq }) => {
    const parts = action.split(':');
    const botId = parts[1];
    const fromView = parts[2] || 'active';
    const removed = await removeWorkerBot(botId);
    if (removed) {
      await safeAnswer(cq.id, `Worker node removed.`);
    } else {
      await safeAnswer(cq.id, `Could not remove worker (it may be configured in .env).`, true);
    }
    if (fromView === 'standby') {
      await renderStandbyWorkers(chatId, messageId);
    } else if (fromView === 'active') {
      await renderActiveWorkers(chatId, messageId);
    } else {
      await renderGhostFleetMgmt(chatId, messageId);
    }
  },
  add_worker_prompt: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: 'add_worker', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    const promptText = `🟢 <b>Add Active Ghost Fleet Delivery Node(s)</b>\n\n` +
      `Paste 1 token, or multiple tokens at once (separated by newlines or commas):\n\n` +
      `<b>Format:</b>\n<code>123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ\n987654321:XYZabcDeFGHIJKLMnoPQrstuvWX</code>\n\n` +
      `<i>These bots will immediately connect to your delivery rotation and handle user requests.</i>\n\n` +
      `Send /cancel to abort.`;
    await editTelegramMessage(chatId, messageId, promptText, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:workers_active' }]]
    });
  },
  add_standby_prompt: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: 'add_standby_worker', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    const promptText = `🛡️ <b>Add Standby Reserve Node(s)</b>\n\n` +
      `Paste 1 token, or multiple tokens at once (separated by newlines or commas):\n\n` +
      `<b>Format:</b>\n<code>123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ\n987654321:XYZabcDeFGHIJKLMnoPQrstuvWX</code>\n\n` +
      `<i>These bots will remain safely in reserve. If any active delivery node fails or gets rate-limited, the Circuit Breaker will automatically hot-swap them into rotation!</i>\n\n` +
      `Send /cancel to abort.`;
    await editTelegramMessage(chatId, messageId, promptText, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:workers_standby' }]]
    });
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
      `2. <b>Worker Bots</b> (as Admin with Post Messages permissions)\n\n` +
      `Forward any message from that group/channel here, or type the ID directly (e.g. <code>-100123456789</code>).\n\n` +
      `<i>Your Main DB Storage Channel remains 100% sacred and isolated — worker bots never enter it!</i>\n\n` +
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
