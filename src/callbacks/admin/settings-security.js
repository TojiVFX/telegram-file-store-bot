import {
  getSettings, updateSettings, toSmallCaps, editTelegramMessage,
  sendTelegramMessage, logHistory, esc, getCollection, formatISTDateTime
} from '../../bot-common.js';
import { getStandbyChannelId } from '../../phoenix-protocol.js';
import { sendDatabaseBackup } from '../../backup.js';
import { grantPremium, revokePremium } from '../../bot-users.js';
import { navButtons } from './common.js';

export async function renderSecHub(chatId, messageId = null) {
  const s = await getSettings();
  const autoDel = s.autoDeleteEnabled === '1';
  const protect = s.protectContent === '1';
  const stealth = s.stealthStorage === '1';
  const ghost = s.ghostFleetEnabled === '1';
  const standbyCid = await getStandbyChannelId();

  const text = `🛡️ <b>Security, Stealth & Fleet Infrastructure</b>\n\n` +
    `Manage anti-ban protections, cloaking, and multi-bot delivery mesh:\n\n` +
    `• Auto-Delete: <b>${autoDel ? '🟢 Active' : '⚪ Disabled'}</b>\n` +
    `• Content Protection: <b>${protect ? '🟢 Active' : '⚪ Disabled'}</b>\n` +
    `• Stealth Storage (Cloaker): <b>${stealth ? '🟢 Active' : '⚪ Disabled'}</b>\n` +
    `• Ghost Fleet (Workers): <b>${ghost ? '🟢 Active' : '⚪ Disabled'}</b>\n` +
    `• Phoenix Protocol Standby: <b>${standbyCid ? '🔥 Armed' : '⚪ Disarmed'}</b>\n` +
    `• Anti-Scraper Armor: <b>🟢 Active (Auto-Triggered)</b>`;

  const buttons = [
    [{ text: toSmallCaps('⏳ Auto-Delete & Protection'), callback_data: 'admin:auto_del_mgmt' }],
    [{ text: toSmallCaps('👻 Ghost Fleet & Worker Mesh'), callback_data: 'admin:ghost_fleet' }],
    [{ text: toSmallCaps('🔥 Phoenix Storage Failover'), callback_data: 'admin:storage_audit' }],
    ...navButtons('admin:dashboard')
  ];

  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
  } else {
    await sendTelegramMessage(chatId, text, { inline_keyboard: buttons });
  }
}

export async function renderAutoDelMgmt(chatId, messageId) {
  const s = await getSettings();
  const autoDel = s.autoDeleteEnabled === '1';
  const timerSec = parseInt(s.autoDeleteTimer, 10) || 300;
  const timerLabel = timerSec < 60 ? `${timerSec}s` : timerSec < 3600 ? `${Math.round(timerSec / 60)} mins` : `${Math.round(timerSec / 3600)} hours`;
  const protect = s.protectContent === '1';
  const stealth = s.stealthStorage === '1';

  const text = `<b>Security, Stealth & Auto Delete Settings</b>\n\n` +
    `• Auto Delete: <b>${autoDel ? 'ON' : 'OFF'}</b>\n` +
    `• Timer: <b>${autoDel ? timerLabel : 'Disabled'}</b>\n` +
    `• Content Protection: <b>${protect ? 'ON' : 'OFF'}</b>\n` +
    `• Stealth Storage (Cloaker): <b>${stealth ? 'ON (Cloaked)' : 'OFF (Raw Titles)'}</b>\n\n` +
    `<i>Stealth Storage cloaks channel post captions with opaque hash tokens (#REF_xxx) to prevent copyright scrapers and keyword indexing in your storage channels.</i>`;

  const buttons = [];
  if (!autoDel) {
    buttons.push([{ text: toSmallCaps('Enable Auto Delete'), callback_data: 'admin:select_autodel_timer' }]);
  } else {
    buttons.push([{ text: toSmallCaps('Disable Auto Delete'), callback_data: 'admin:toggle_autodel:0' }]);
    buttons.push([
      { text: toSmallCaps('1 Min'), callback_data: 'admin:set_timer:60' },
      { text: toSmallCaps('5 Mins'), callback_data: 'admin:set_timer:300' },
      { text: toSmallCaps('10 Mins'), callback_data: 'admin:set_timer:600' }
    ]);
    buttons.push([
      { text: toSmallCaps('30 Mins'), callback_data: 'admin:set_timer:1800' },
      { text: toSmallCaps('1 Hour'), callback_data: 'admin:set_timer:3600' },
      { text: toSmallCaps('24 Hours'), callback_data: 'admin:set_timer:86400' }
    ]);
  }

  buttons.push([{ text: toSmallCaps(protect ? 'Disable Content Protection' : 'Enable Content Protection'), callback_data: `admin:toggle_protect:${protect ? 0 : 1}` }]);
  buttons.push([{ text: toSmallCaps(stealth ? 'Disable Stealth Storage' : 'Enable Stealth Storage'), callback_data: `admin:toggle_stealth:${stealth ? 0 : 1}` }]);
  buttons.push(...navButtons('admin:sec_hub'));

  await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

export async function renderSponsorMgmt(chatId, messageId) {
  const s = await getSettings();
  const enabled = s.sponsorBtnEnabled === '1';
  const textVal = s.sponsorBtnText ? esc(s.sponsorBtnText) : 'Not set';
  const urlVal = s.sponsorBtnUrl ? esc(s.sponsorBtnUrl) : 'Not set';

  const text = `📢 <b>Post-Delivery Sponsor / Ad Button</b>\n\n` +
    `Attach an advertising or sponsor button to all delivered files and auto-delete notices.\n\n` +
    `• Status: <b>${enabled ? 'ENABLED' : 'DISABLED'}</b>\n` +
    `• Button Text: <b>${textVal}</b>\n` +
    `• Target URL: <code>${urlVal}</code>`;

  const buttons = [
    [{ text: toSmallCaps(enabled ? 'Disable Button' : 'Enable Button'), callback_data: `admin:sponsor_toggle:${enabled ? 0 : 1}` }],
    [{ text: toSmallCaps('Set Button Text'), callback_data: 'admin:sponsor_set_text' }, { text: toSmallCaps('Set Button URL'), callback_data: 'admin:sponsor_set_url' }],
    [{ text: toSmallCaps('Back'), callback_data: 'admin:fs_settings' }]
  ];

  await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

export const settingsSecurityActions = {
  sec_hub: async ({ chatId, messageId }) => {
    await renderSecHub(chatId, messageId);
  },

  auto_del_mgmt: async ({ chatId, messageId }) => {
    await renderAutoDelMgmt(chatId, messageId);
  },

  select_autodel_timer: async ({ chatId, messageId }) => {
    const text = `⏱ <b>Select Auto Delete Duration</b>\n\nChoose how long before files are automatically deleted:`;
    const buttons = [
      [{ text: toSmallCaps('1 Min'), callback_data: 'admin:set_timer_enable:60' }, { text: toSmallCaps('5 Mins'), callback_data: 'admin:set_timer_enable:300' }, { text: toSmallCaps('10 Mins'), callback_data: 'admin:set_timer_enable:600' }],
      [{ text: toSmallCaps('30 Mins'), callback_data: 'admin:set_timer_enable:1800' }, { text: toSmallCaps('1 Hour'), callback_data: 'admin:set_timer_enable:3600' }, { text: toSmallCaps('24 Hours'), callback_data: 'admin:set_timer_enable:86400' }],
      [{ text: toSmallCaps('Cancel'), callback_data: 'admin:auto_del_mgmt' }]
    ];
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
  },

  'set_timer_enable:': async ({ chatId, messageId, action, cq, safeAnswer }) => {
    const sec = action.split(':')[1];
    await updateSettings({ autoDeleteTimer: sec, autoDeleteEnabled: '1' });
    await safeAnswer(cq.id, `Auto Delete Enabled (${sec < 60 ? sec + 's' : sec < 3600 ? Math.round(sec / 60) + ' mins' : Math.round(sec / 3600) + ' hours'})`);
    await renderAutoDelMgmt(chatId, messageId);
  },

  'toggle_autodel:': async ({ chatId, messageId, action, cq, safeAnswer }) => {
    const val = action.split(':')[1];
    await updateSettings({ autoDeleteEnabled: val });
    await safeAnswer(cq.id, `Auto Delete ${val === '1' ? 'Enabled' : 'Disabled'}`);
    await renderAutoDelMgmt(chatId, messageId);
  },

  'set_timer:': async ({ chatId, messageId, action, cq, safeAnswer }) => {
    const sec = action.split(':')[1];
    await updateSettings({ autoDeleteTimer: sec, autoDeleteEnabled: '1' });
    await safeAnswer(cq.id, `Timer updated!`);
    await renderAutoDelMgmt(chatId, messageId);
  },

  'toggle_protect:': async ({ chatId, messageId, action, cq, safeAnswer }) => {
    const val = action.split(':')[1];
    await updateSettings({ protectContent: val });
    await safeAnswer(cq.id, `Content Protection ${val === '1' ? 'Enabled' : 'Disabled'}`);
    await renderAutoDelMgmt(chatId, messageId);
  },

  'toggle_stealth:': async ({ chatId, messageId, action, cq, safeAnswer }) => {
    const val = action.split(':')[1];
    await updateSettings({ stealthStorage: val });
    await safeAnswer(cq.id, `Stealth Storage ${val === '1' ? 'Enabled' : 'Disabled'}`);
    await renderAutoDelMgmt(chatId, messageId);
  },

  fs_settings: async ({ chatId, messageId }) => {
    const s = await getSettings();
    const envDb = (process.env.TELEGRAM_DB_CHANNEL_ID || '').trim();
    const dbChannel = envDb || s.dbChannelId || 'Not set';
    const envLog = (process.env.LOG_CHANNEL_ID || '').trim();
    const logChannel = envLog || s.logChannelId || 'Not set';
    const sponsorStatus = s.sponsorBtnEnabled === '1' ? 'ENABLED' : 'DISABLED';

    const text = `⚙️ <b>Bot Configuration & Settings</b>\n\nConfigure bot branding, messages, telemetry, and data backups:\n\n` +
      `• <b>DB Channel:</b> <code>${esc(dbChannel)}</code> <i>(${envDb ? 'Environment' : 'Database'})</i>\n` +
      `• <b>Log Channel:</b> <code>${esc(logChannel)}</code> <i>(${envLog ? 'Environment' : 'Database'})</i>\n` +
      `• <b>Sponsor Button:</b> <b>${sponsorStatus}</b>`;
    const buttons = [
      [{ text: toSmallCaps('💬 Start Message'), callback_data: 'admin:fs_cfg:start' }, { text: toSmallCaps('🖼️ Banners & Images'), callback_data: 'admin:banners_mgmt' }],
      [{ text: toSmallCaps('📢 Sponsor Button'), callback_data: 'admin:sponsor_mgmt' }, { text: toSmallCaps('📜 Log Channel'), callback_data: 'admin:fs_set_log_channel' }],
      [{ text: toSmallCaps('💾 Download DB Backup (.json)'), callback_data: 'admin:manual_backup' }],
      ...navButtons('admin:dashboard')
    ];
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
  },

  sponsor_mgmt: async ({ chatId, messageId }) => {
    await renderSponsorMgmt(chatId, messageId);
  },

  'sponsor_toggle:': async ({ chatId, messageId, action, cq, safeAnswer }) => {
    const val = action.split(':')[1];
    await updateSettings({ sponsorBtnEnabled: val });
    await logHistory(`sponsor_btn_${val === '1' ? 'enabled' : 'disabled'}`, 'tg');
    await safeAnswer(cq.id, `Sponsor button ${val === '1' ? 'enabled' : 'disabled'}.`);
    await renderSponsorMgmt(chatId, messageId);
  },

  sponsor_set_text: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'sponsorBtnText', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `📢 <b>Set Sponsor Button Text</b>\n\nEnter the label to appear on the button (e.g. <code>Join Main Channel</code> or <code>Sponsor Website</code>).\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  },

  sponsor_set_url: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'sponsorBtnUrl', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🔗 <b>Set Sponsor Button URL</b>\n\nEnter the link destination (e.g. <code>https://t.me/your_channel</code> or <code>https://example.com</code>).\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  },

  fs_set_log_channel: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'logChannelId', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `📡 <b>Set Real-Time Log Channel</b>\n\nEnter the Channel ID (e.g. <code>-100123456789</code>) or <code>@channel_username</code> where live audit alerts should be sent.\n\nMake sure the bot is an <b>administrator</b> in this channel with post permissions.\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  },

  manual_backup: async ({ chatId, cq, safeAnswer }) => {
    await safeAnswer(cq.id, 'Generating database backup...');
    await sendDatabaseBackup(chatId);
  },

  fs_premium_prompt: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_premium_user:${chatId}` },
      { $set: { val: '1', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await sessions.updateOne(
      { _id: `admin:premium_msg_id:${chatId}` },
      { $set: { val: String(messageId), expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `<b>Grant Premium Access</b>\n\nPlease send the <b>User ID</b> or <b>@username</b>.\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  },

  'fs_set_premium:': async ({ chatId, messageId, action, cq, safeAnswer, sessions }) => {
    const rawVal = action.split(':')[1];
    const targetDoc = await sessions.findOne({ _id: `admin:premium_target:${chatId}` });
    let targetUserId = targetDoc && targetDoc.expiresAt > new Date() ? targetDoc.val : null;
    if (typeof targetUserId === 'object' && targetUserId !== null) {
      targetUserId = targetUserId._id || targetUserId.id || null;
    }
    if (targetUserId) {
      targetUserId = String(targetUserId).trim();
    }
    if (!targetUserId || targetUserId === '[object Object]') {
      await safeAnswer(cq.id, 'Session expired or invalid user target.');
      return;
    }

    await sessions.deleteOne({ _id: `admin:premium_target:${chatId}` });
    await sessions.deleteOne({ _id: `admin:premium_msg_id:${chatId}` });

    if (rawVal === 'revoke') {
      const revRes = await revokePremium(targetUserId);
      if (revRes.ok) {
        const uLabel = revRes.username ? `<code>${targetUserId}</code> (@${esc(revRes.username)})` : `<code>${targetUserId}</code>`;
        await editTelegramMessage(chatId, messageId, `✅ <b>VIP Access Revoked!</b>\n\nUser: ${uLabel}`, {
          inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'admin:user_mgmt' }]]
        });
      } else {
        await editTelegramMessage(chatId, messageId, `❌ <b>Failed to revoke VIP:</b> ${revRes.error}`, {
          inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'admin:user_mgmt' }]]
        });
      }
      return;
    }

    const grantRes = await grantPremium(targetUserId, rawVal);
    if (!grantRes.ok) {
      await editTelegramMessage(chatId, messageId, `❌ <b>Failed to grant VIP:</b> ${grantRes.error}`, {
        inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'admin:user_mgmt' }]]
      });
      return;
    }

    const durLabel = rawVal === 'lifetime' ? 'Lifetime ♾️' : `${rawVal} Days`;
    const expStr = grantRes.isLifetime ? 'Lifetime (Never Expires)' : (grantRes.premiumUntil ? formatISTDateTime(grantRes.premiumUntil) : 'Active');
    const uLabel = grantRes.username ? `<code>${targetUserId}</code> (@${esc(grantRes.username)})` : `<code>${targetUserId}</code>`;
    await editTelegramMessage(chatId, messageId, `⭐ <b>VIP Access Granted!</b>\n\n• User: ${uLabel}\n• Duration: <b>${durLabel}</b>\n• Expiry: <code>${expStr}</code>`, {
      inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'admin:user_mgmt' }]]
    });
  }
};
