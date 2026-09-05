import {
  getCollection, getSettings, updateSettings, toSmallCaps, editTelegramMessage, answerCallbackQuery, sendTelegramMessage, logHistory, deleteTelegramMessage, sendTelegramVideo, sendTelegramPhoto, esc
} from '../bot-common.js';
import {
  getBotUsername, getForceSubChannelsList, isBotAdmin, getDbChannelId, getAdminDashboardKeyboard, getExportHubKeyboard, getExportTimeKeyboard, getExportLinksKeyboard, getDbChannelReadinessError
} from '../bot-helpers.js';

// ─── Shared nav row ─────────────────────────────────────────────────────────────
const navButtons = (backCb) => [
  [{ text: toSmallCaps('Back'), callback_data: backCb }, { text: toSmallCaps('Home'), callback_data: 'admin:dashboard' }]
];

// ─── Screen renderers ───────────────────────────────────────────────────────────
// Each of these renders one dashboard "screen" by directly editing the message.
// Previously, refreshing a screen after a toggle (e.g. after flipping Auto
// Delete on/off) was done by building a fake Telegram update and re-running the
// *entire webhook handler* against it (routes/telegram.js's mainHandler). That
// worked, but re-ran env/webhook-secret validation and command registration on
// every toggle tap, relied on two different mock-update shapes across call
// sites, and required a circular dynamic import back into routes/telegram.js.
// Calling these functions directly removes all of that.

async function renderDashboard(chatId, messageId) {
  const text = `<b>Admin Dashboard</b>\n\nSelect a category to manage the bot:`;
  await editTelegramMessage(chatId, messageId, text, getAdminDashboardKeyboard());
}

async function renderAutoDelMgmt(chatId, messageId) {
  const s = await getSettings();
  const autoDel = s.autoDeleteEnabled === '1';
  const timerSec = parseInt(s.autoDeleteTimer, 10) || 300;
  const timerLabel = timerSec < 60 ? `${timerSec}s` : timerSec < 3600 ? `${Math.round(timerSec / 60)} mins` : `${Math.round(timerSec / 3600)} hours`;
  const protect = s.protectContent === '1';

  const text = `<b>Security & Auto Delete Settings</b>\n\nAuto Delete: <b>${autoDel ? 'ON' : 'OFF'}</b>\nTimer: <b>${autoDel ? timerLabel : 'Disabled'}</b>\nContent Protection: <b>${protect ? 'ON' : 'OFF'}</b>`;

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
  buttons.push(...navButtons('admin:dashboard'));

  await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

async function renderBannersMgmt(chatId, messageId) {
  const s = await getSettings();
  const startStatus = s.startPhoto ? 'Set' : 'None';
  const fsubStatus = s.bannerFsub ? 'Set' : 'None';
  const verifyStatus = s.bannerVerify ? 'Set' : 'None';
  const deliveryStatus = s.bannerDelivery ? 'Set' : 'None';
  const profileStatus = s.bannerProfile ? 'Set' : 'None';

  const text = `🖼 <b>Banners & Images Manager</b>\n\n` +
    `Customize images & banners for key bot screens:\n\n` +
    `• <b>Start Menu:</b> <code>${startStatus}</code>\n` +
    `• <b>Force-Sub Gate:</b> <code>${fsubStatus}</code>\n` +
    `• <b>Verification Gate:</b> <code>${verifyStatus}</code>\n` +
    `• <b>Batch Delivery:</b> <code>${deliveryStatus}</code>\n` +
    `• <b>User Profile (/me):</b> <code>${profileStatus}</code>\n\n` +
    `<i>Tap a button below to set or update any screen banner:</i>`;

  const buttons = [
    [{ text: toSmallCaps('Start Banner'), callback_data: 'admin:set_banner:startPhoto' }, { text: toSmallCaps('Force-Sub Banner'), callback_data: 'admin:set_banner:bannerFsub' }],
    [{ text: toSmallCaps('Verify Banner'), callback_data: 'admin:set_banner:bannerVerify' }, { text: toSmallCaps('Delivery Banner'), callback_data: 'admin:set_banner:bannerDelivery' }],
    [{ text: toSmallCaps('Profile Banner'), callback_data: 'admin:set_banner:bannerProfile' }],
  ];

  const removeRow = [];
  if (s.startPhoto) removeRow.push({ text: toSmallCaps('Del Start'), callback_data: 'admin:del_banner:startPhoto' });
  if (s.bannerFsub) removeRow.push({ text: toSmallCaps('Del F-Sub'), callback_data: 'admin:del_banner:bannerFsub' });
  if (s.bannerVerify) removeRow.push({ text: toSmallCaps('Del Verify'), callback_data: 'admin:del_banner:bannerVerify' });
  if (s.bannerDelivery) removeRow.push({ text: toSmallCaps('Del Delivery'), callback_data: 'admin:del_banner:bannerDelivery' });
  if (s.bannerProfile) removeRow.push({ text: toSmallCaps('Del Profile'), callback_data: 'admin:del_banner:bannerProfile' });

  if (removeRow.length > 0) {
    for (let i = 0; i < removeRow.length; i += 2) {
      buttons.push(removeRow.slice(i, i + 2));
    }
  }

  buttons.push(...navButtons('admin:dashboard'));

  await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

async function renderFsCfg(chatId, messageId, cfgType) {
  const s = await getSettings();
  let text = '';
  let buttons = [];

  if (cfgType === 'start') {
    text = `<b>Start Message</b>\n\nCustomize your main bot start message using the following buttons:\n\n` +
           `• Start Photo: <b>${s.startPhoto ? 'Configured' : 'Not set'}</b>\n` +
           `• Start Text: <b>${s.startText ? 'Custom' : 'Default'}</b>`;
    buttons = [
      [{ text: toSmallCaps('START TEXT'), callback_data: 'admin:fs_set_stext' }, { text: toSmallCaps('START PHOTO'), callback_data: 'admin:fs_set_sphoto' }],
      ...(s.startPhoto ? [[{ text: toSmallCaps('REMOVE PHOTO'), callback_data: 'admin:fs_del_sphoto' }]] : []),
      [{ text: toSmallCaps('BACK'), callback_data: 'admin:fs_settings' }]
    ];
  } else if (cfgType === 'fsub') {
    const fsub = s.forceSubscribeChannels || '';
    const globalMode = s.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(fsub, globalMode);

    text = `<b><u>Force Sub</u></b>\n\nUsers can only use your main bot after joining all force sub channels.\nmain bot now also supports join request mode.\n\nYou can add up to 6 channels`;

    buttons = [];
    for (let i = 0; i < channels.length; i++) {
      const chan = channels[i];
      let displayName = chan.title || 'Channel';
      if (displayName.startsWith('-100')) {
        displayName = 'Channel ' + displayName.replace('-100', '');
      }
      buttons.push([
        { text: toSmallCaps(displayName), callback_data: `admin:fs_fsub_toggle:${i}` },
        { text: toSmallCaps('Edit Label'), callback_data: `admin:fs_fsub_setlbl:${i}` },
        { text: toSmallCaps('Delete'), callback_data: `admin:fs_fsub_del:${i}` }
      ]);
    }

    if (channels.length < 6) {
      buttons.push([{ text: toSmallCaps('Add Channel'), callback_data: `admin:fs_fsub_add` }]);
    }

    buttons.push([{ text: toSmallCaps('Bulk Setup'), callback_data: `admin:fs_fsub_bulk` }]);

    buttons.push([
      { text: toSmallCaps('Check Status'), callback_data: `admin:fs_fsub_status` },
      { text: toSmallCaps('Custom Message'), callback_data: `admin:fs_set_fsub_msg` }
    ]);
    buttons.push([{ text: toSmallCaps('Back'), callback_data: `admin:fs_settings` }]);
  } else if (cfgType === 'tkn') {
    const enabled = s.enabled === '1';
    const refDisabled = s.referralDisabled === '1';
    const validityHours = (s.validityHours !== undefined && s.validityHours !== '') ? parseInt(s.validityHours, 10) : 24;
    const validityLabel = validityHours === 0 ? '0 Hours (Every File/Batch)' : `${validityHours} Hours`;
    const shortenerUrl = s.shortenerUrl ? esc(s.shortenerUrl) : 'Not set';
    const shortenerKey = s.shortenerKey ? esc(s.shortenerKey) : 'Not set';
    const backupUrl = s.backupShortenerUrl ? esc(s.backupShortenerUrl) : 'Not set';
    const backupKey = s.backupShortenerKey ? esc(s.backupShortenerKey) : 'Not set';

    text = `<b>Access Token & Multi-Shortener</b>\n\nConfigure shorteners for gated link verification:\n\nStatus: <b>${enabled ? 'ON' : 'OFF'}</b>\nReferrals: <b>${refDisabled ? 'DISABLED' : 'ENABLED'}</b>\nValidity: <b>${validityLabel}</b>\n\n• <b>Primary Shortener:</b>\nURL: <code>${shortenerUrl}</code>\nKey: <code>${shortenerKey}</code>\n\n• <b>Backup Shortener (Failover):</b>\nURL: <code>${backupUrl}</code>\nKey: <code>${backupKey}</code>`;
    buttons = [
      [{ text: toSmallCaps('Shortener URL'), callback_data: 'admin:fs_set_url' }, { text: toSmallCaps('API Key'), callback_data: 'admin:fs_set_key' }],
      [{ text: toSmallCaps('Backup URL'), callback_data: 'admin:fs_set_burl' }, { text: toSmallCaps('Backup Key'), callback_data: 'admin:fs_set_bkey' }],
      [{ text: toSmallCaps('Validity'), callback_data: 'admin:fs_set_ttl' }, { text: toSmallCaps('Tutorial'), callback_data: 'admin:fs_set_tut' }],
      [{ text: toSmallCaps(enabled ? 'Disable Token' : 'Enable Token'), callback_data: `admin:fs_toggle:${enabled ? 0 : 1}` }, { text: toSmallCaps(refDisabled ? 'Enable Ref' : 'Disable Ref'), callback_data: `admin:fs_toggle_ref:${refDisabled ? 0 : 1}` }],
      [{ text: toSmallCaps('Back'), callback_data: 'admin:fs_settings' }]
    ];
  }
  await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

export async function renderStorageAudit(chatId, messageId = null) {
  const { getDbChannelId, getBackupDbChannelId, isBotAdmin } = await import('../bot-helpers.js');
  const { getStorageAuditStats } = await import('../filestore.js');

  const primaryCid = await getDbChannelId();
  const backupCid = await getBackupDbChannelId();

  const primaryAdmin = primaryCid ? await isBotAdmin(primaryCid) : false;
  const backupAdmin = backupCid ? await isBotAdmin(backupCid) : false;

  const stats = await getStorageAuditStats();
  const redundancyPct = stats.total > 0 ? Math.round((stats.mirrored / stats.total) * 100) : 100;

  let text = `🛡 <b>Storage & Redundancy Audit</b>\n\n` +
    `• <b>Primary DB Channel:</b> <code>${primaryCid || 'Not Set'}</code>\n` +
    `  Status: <b>${primaryAdmin ? '✅ Admin (Active)' : '❌ Not Admin / Missing'}</b>\n\n` +
    `• <b>Backup DB Channel:</b> <code>${backupCid || 'Not Configured'}</code>\n` +
    `  Status: <b>${backupCid ? (backupAdmin ? '✅ Admin (Active)' : '❌ Bot Not Admin') : '⚠️ Inactive'}</b>\n\n` +
    `📊 <b>Redundancy Health:</b>\n` +
    `• Total Stored Records: <b>${stats.total}</b>\n` +
    `• Mirrored in Backup: <b>${stats.mirrored}</b>\n` +
    `• Unmirrored Records: <b>${stats.unmirrored}</b>\n` +
    `• Failover Coverage: <b>${redundancyPct}%</b>\n\n`;

  if (!backupCid) {
    text += `<i>💡 Tip: Set a backup channel to automatically duplicate all stored files and prevent link breakage if your primary channel is struck or banned.</i>`;
  } else if (stats.unmirrored > 0) {
    text += `<i>⚠️ There are ${stats.unmirrored} record(s) not yet mirrored to your backup channel. Tap below to mirror them retroactively.</i>`;
  } else {
    text += `<i>✅ All stored records are fully synchronized and protected against bans.</i>`;
  }

  const buttons = [];
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
  buttons.push(...navButtons('admin:file_mgmt'));

  const keyboard = { inline_keyboard: buttons };
  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, keyboard);
  } else {
    await sendTelegramMessage(chatId, text, keyboard);
  }
}

export async function handleAdminCallback(chatId, messageId, action, cq) {
  const requiresCustomToast = action.startsWith('fs_fsub_toggle:') ||
                              action.startsWith('fs_fsub_del_confirm:') ||
                              action.startsWith('fs_fsub_setmode:') ||
                              action.startsWith('fs_toggle:') ||
                              action.startsWith('fs_toggle_ref:') ||
                              action.startsWith('fs_set_ttl_val:') ||
                              action === 'fs_set_fsmode' ||
                              action === 'fs_noop' ||
                              action.startsWith('fs_set_premium:') ||
                              action === 'batch_done' ||
                              action === 'bundle_done' ||
                              action === 'run_retro_mirror' ||
                              action === 'promote_backup_exec' ||
                              action === 'scan_heal_links';

  if (!requiresCustomToast) {
    answerCallbackQuery(cq.id).catch(() => {});
  }

  const sessions = await getCollection('sessions');

  // Main admin callbacks
  if (action === 'fs_fsub_add') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'fs_fsub_msg_forward', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `Forward a message from your force sub channel, or send the channel ID directly (e.g. <code>-100123456789</code>).\n\nMake sure your bot is admin in that channel.`, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
    return;
  }

  if (action === 'fs_fsub_bulk') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'fs_fsub_bulk_import', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    const instruction = `📥 <b>Bulk Setup Force Subscribe</b>\n\nSend a list of channel IDs to configure multiple channels at once.\n\n<b>Format:</b>\n<code>channel_id:mode:button_label:title</code>\n(Each on a new line. Only <code>channel_id</code> is required.)\n\n<b>Example:</b>\n<code>-100123456789</code>\n<code>-100987654321:join_request:Join Pro:Pro Group</code>\n\nSend /cancel to abort.`;
    await editTelegramMessage(chatId, messageId, instruction, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
    return;
  }

  if (action === 'fs_fsub_status') {
    const s = await getSettings();
    const fsub = s.forceSubscribeChannels || '';
    const globalMode = s.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(fsub, globalMode);

    if (channels.length === 0) {
       await answerCallbackQuery(cq.id, 'No Force Subscribe channels configured.', true);
       return;
    }

    await editTelegramMessage(chatId, messageId, `⏳ Checking bot admin status in ${channels.length} channels...`);

    let report = `<b>Force Subscribe Status</b>\n\n`;
    let allOk = true;
    for (const chan of channels) {
      const isAdmin = await isBotAdmin(chan.id);
      if (isAdmin) {
        report += `✅ ${esc(chan.title || chan.id)}: OK\n`;
      } else {
        report += `❌ ${esc(chan.title || chan.id)}: Bot is NOT admin\n`;
        allOk = false;
      }
    }

    if (!allOk) {
      report += `\n⚠️ <i>Warning: Users may not be able to get their files if the bot cannot generate invite links or check membership in all channels.</i>`;
    }

    await editTelegramMessage(chatId, messageId, report, {
      inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'admin:fs_cfg:fsub' }]]
    });

    return;
  }

  if (action.startsWith('fs_fsub_toggle:')) {
    const index = parseInt(action.split(':')[1], 10);
    const s = await getSettings();
    const fsub = s.forceSubscribeChannels || '';
    const globalMode = s.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(fsub, globalMode);
    if (channels[index]) {
      channels[index].mode = channels[index].mode === 'join_request' ? 'normal' : 'join_request';
      await updateSettings({ forceSubscribeChannels: JSON.stringify(channels) });
      await answerCallbackQuery(cq.id, `Mode toggled to ${channels[index].mode === 'join_request' ? 'Join Request' : 'Normal'} Mode!`);
    }
    await renderFsCfg(chatId, messageId, 'fsub');
    return;
  }

  if (action.startsWith('fs_fsub_del:')) {
    const index = parseInt(action.split(':')[1], 10);
    const s = await getSettings();
    const fsub = s.forceSubscribeChannels || '';
    const globalMode = s.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(fsub, globalMode);
    if (channels[index]) {
      const chan = channels[index];
      const text = `⚠️ <b>Are you sure you want to remove this channel?</b>\n\nChannel: <b>${esc(chan.title || chan.id)}</b>`;
      await editTelegramMessage(chatId, messageId, text, {
        inline_keyboard: [
          [
            { text: toSmallCaps('Yes'), callback_data: `admin:fs_fsub_del_confirm:${index}` },
            { text: toSmallCaps('No'), callback_data: 'admin:fs_cfg:fsub' }
          ]
        ]
      });
      return;
    }
    await answerCallbackQuery(cq.id, "Channel not found.", true);
    return;
  }

  if (action.startsWith('fs_fsub_del_confirm:')) {
    const index = parseInt(action.split(':')[1], 10);
    const s = await getSettings();
    const fsub = s.forceSubscribeChannels || '';
    const globalMode = s.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(fsub, globalMode);
    if (channels[index]) {
      const removed = channels.splice(index, 1)[0];
      const newValue = channels.length > 0 ? JSON.stringify(channels) : '';
      await updateSettings({ forceSubscribeChannels: newValue });
      await answerCallbackQuery(cq.id, `Removed ${removed.title}!`);
    }
    await renderFsCfg(chatId, messageId, 'fsub');
    return;
  }

  if (action.startsWith('fs_fsub_setlbl:')) {
    const index = parseInt(action.split(':')[1], 10);
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: `fs_fsub_lbl_${index}`, expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `📝 <b>Set Custom Button Label</b>\n\nSend the custom label for this channel's invite button (e.g., "Join Main Group").\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
    return;
  }

  if (action.startsWith('fs_fsub_setmode:')) {
    const selectedMode = action.split(':')[1];
    const pendingRaw = await sessions.findOne({ _id: `admin:fsub_pending_add:${chatId}` });
    if (!pendingRaw || pendingRaw.expiresAt < new Date()) {
      await answerCallbackQuery(cq.id, "Session expired.", true);
      return;
    }
    const chan = pendingRaw.val;
    const s = await getSettings();
    const fsub = s.forceSubscribeChannels || '';
    const globalMode = s.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(fsub, globalMode);

    const filteredChannels = channels.filter(c => String(c.id) !== String(chan.id));
    filteredChannels.push({ id: String(chan.id), title: chan.title, mode: selectedMode });

    await updateSettings({ forceSubscribeChannels: JSON.stringify(filteredChannels) });
    await sessions.deleteOne({ _id: `admin:fsub_pending_add:${chatId}` });

    await editTelegramMessage(chatId, messageId, `✨ <i>Successfully Added ${esc(chan.title)} As Your Force Sub Channel</i>`, {
      inline_keyboard: [[{ text: '< BACK', callback_data: 'admin:fs_cfg:fsub' }]]
    });
    await answerCallbackQuery(cq.id);
    return;
  }

  if (action === 'dashboard') {
    await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
    await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });
    await sessions.deleteOne({ _id: `admin:broadcast_draft:${chatId}` });
    const { setBulkStoreActive, clearStoreSession } = await import('../filestore.js');
    await setBulkStoreActive(chatId, false);
    await clearStoreSession(chatId);
    await renderDashboard(chatId, messageId);
    return;
  } else if (action === 'stats') {
    const { getUserStats } = await import('../bot-users.js');
    const s = await getUserStats();

    const users = await getCollection('users');
    const referralAggregation = await users.aggregate([
      { $group: { _id: null, total: { $sum: '$referralCount' } } }
    ]).toArray();
    const totalRefs = referralAggregation.length ? referralAggregation[0].total : 0;

    const text = `<b>Bot Statistics</b>\n\n` +
                 `Total Users: <b>${s.totalUsers}</b>\n` +
                 `Total Links: <b>${s.filestoreLinks}</b>\n` +
                 `Total Referrals: <b>${totalRefs}</b>`;
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: navButtons('admin:dashboard')
    });
  } else if (action === 'broadcast_prompt') {
    const { getUserStats } = await import('../bot-users.js');
    const s = await getUserStats();
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: 'broadcast', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `<b>Broadcast Message</b>\n\nTotal Registered Users: <b>${s.totalUsers}</b>\n\nPlease send or forward any message you want to broadcast to all users.\n\nSupports: text, photos, videos, documents, audio, animations, stickers, forwarded channel posts, inline buttons, and web link previews.\n\nSend /cancel to abort.`, {
      inline_keyboard: [
        [{ text: toSmallCaps('Back to Dashboard'), callback_data: 'admin:broadcast_cancel_prompt' }]
      ]
    });
    await logHistory('broadcast_prompt', 'tg');
  } else if (action === 'broadcast_cancel_prompt' || action === 'broadcast_cancel_draft') {
    await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
    await sessions.deleteOne({ _id: `admin:broadcast_draft:${chatId}` });
    await renderDashboard(chatId, messageId);
    return;
  } else if (action === 'broadcast_cancel') {
    const { cancelBroadcast } = await import('../bot-users.js');
    cancelBroadcast();
    await answerCallbackQuery(cq.id, 'Broadcast cancellation requested.', true);
    return;
  } else if (action === 'broadcast_test') {
    const draftDoc = await sessions.findOne({ _id: `admin:broadcast_draft:${chatId}` });
    if (!draftDoc) {
      await answerCallbackQuery(cq.id, 'Draft expired or not found.', true);
      return;
    }

    if (draftDoc.fromChatId && draftDoc.messageId) {
      const { copyMessage } = await import('../bot-helpers.js');
      const copyRes = await copyMessage(chatId, draftDoc.fromChatId, draftDoc.messageId, false, draftDoc.replyMarkup);
      if (copyRes?.ok) {
        await answerCallbackQuery(cq.id, 'Preview message sent below!');
      } else {
        await answerCallbackQuery(cq.id, `Preview failed: ${copyRes?.reason || 'unknown'}`, true);
      }
    } else if (draftDoc.text || draftDoc.captionOrText) {
      await sendTelegramMessage(chatId, draftDoc.text || draftDoc.captionOrText, draftDoc.replyMarkup, false, 2, false);
      await answerCallbackQuery(cq.id, 'Preview message sent below!');
    }
    return;
  } else if (action === 'broadcast_confirm') {
    const draftDoc = await sessions.findOne({ _id: `admin:broadcast_draft:${chatId}` });
    if (!draftDoc) {
      await answerCallbackQuery(cq.id, 'Draft expired or not found.', true);
      return;
    }

    const { fromChatId, messageId: srcMsgId, replyMarkup, captionOrText, text: legacyText } = draftDoc;
    await sessions.deleteOne({ _id: `admin:broadcast_draft:${chatId}` });

    const { broadcastWithProgress, getUserStats } = await import('../bot-users.js');
    const s = await getUserStats();
    await editTelegramMessage(chatId, messageId, `<b>Starting Broadcast...</b>\n\nTotal Users: <b>${s.totalUsers}</b>\n\n<i>Initializing queue...</i>`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel Broadcast'), callback_data: 'admin:broadcast_cancel' }]]
    });
    broadcastWithProgress({
      text: captionOrText || legacyText,
      fromChatId,
      messageId: srcMsgId,
      replyMarkup,
      adminChatId: chatId,
      statusMsgId: messageId
    }).then(r => {
      logHistory(`broadcast_tg: ${r.sent}/${r.total} users`, 'tg').catch(() => {});
    }).catch(err => {
      log('error', 'broadcastWithProgress error', { errorMessage: err.message });
    });
    return;
  } else if (action === 'user_mgmt') {
    const text = `<b>User Management</b>\n\nManage users and access control:`;
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Ban User'), callback_data: 'admin:ban_prompt' }, { text: toSmallCaps('Unban User'), callback_data: 'admin:unban_prompt' }],
        [{ text: toSmallCaps('Banned List'), callback_data: 'admin:ban_list' }, { text: toSmallCaps('Grant Premium'), callback_data: 'admin:fs_premium_prompt' }],
        ...navButtons('admin:dashboard')
      ]
    });
  } else if (action === 'ban_prompt') {
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: 'ban', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `<b>Ban User</b>\n\nPlease send the <b>User ID</b> you want to ban.\n\nSend /cancel to abort.`, {
      inline_keyboard: navButtons('admin:user_mgmt')
    });
  } else if (action === 'unban_prompt') {
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: 'unban', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `<b>Unban User</b>\n\nPlease send the <b>User ID</b> you want to unban.\n\nSend /cancel to abort.`, {
      inline_keyboard: navButtons('admin:user_mgmt')
    });
  } else if (action === 'ban_list') {
    const { getBannedList } = await import('../bot-users.js');
    const list = await getBannedList();
    const text = list.length ? `<b>Banned Users:</b>\n\n${list.map(id => `<code>${id}</code>`).join('\n')}` : `No banned users.`;
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: navButtons('admin:user_mgmt')
    });
  } else if (action === 'file_mgmt') {
    const text = `<b>File Management</b>\n\nCreate permanent or temporary sharing links, edit media metadata (2GB), bulk store files, export link lists, or backup database:`;
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Create Batch'), callback_data: 'admin:batch_start' }, { text: toSmallCaps('Quality Bundle'), callback_data: 'admin:bundle_start' }],
        [{ text: toSmallCaps('Store Single'), callback_data: 'admin:store_start' }, { text: toSmallCaps('Bulk Store Mode'), callback_data: 'admin:bulk_store_start' }],
        [{ text: toSmallCaps('Media Editor (2GB)'), callback_data: 'admin:editor_start' }, { text: toSmallCaps('Export Links Hub'), callback_data: 'admin:export_hub' }],
        [{ text: toSmallCaps('Create Temp Token'), callback_data: 'admin:temp_token_start' }, { text: toSmallCaps('Active Temp Tokens'), callback_data: 'admin:temp_tokens_list' }],
        [{ text: toSmallCaps('Top 10 Files'), callback_data: 'admin:top_files' }, { text: toSmallCaps("Today's Links"), callback_data: 'admin:today_links' }],
        [{ text: toSmallCaps('Database Backup'), callback_data: 'admin:backup_db' }, { text: toSmallCaps('Storage & Backup Audit'), callback_data: 'admin:storage_audit' }],
        ...navButtons('admin:dashboard')
      ]
    });
  } else if (action === 'editor_start') {
    const { startEditorSession } = await import('../commands/editor.js');
    await startEditorSession(chatId);
    return;
  } else if (action === 'storage_audit') {
    await renderStorageAudit(chatId, messageId);
    return;
  } else if (action === 'set_backup_channel_prompt') {
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
    return;
  } else if (action === 'run_retro_mirror') {
    const { getDbChannelId, getBackupDbChannelId } = await import('../bot-helpers.js');
    const { runRetroactiveMirror } = await import('../filestore.js');
    const primaryCid = await getDbChannelId();
    const backupCid = await getBackupDbChannelId();

    if (!primaryCid || !backupCid) {
      await answerCallbackQuery(cq.id, 'Both primary and backup channels must be configured!', true);
      return;
    }

    await editTelegramMessage(chatId, messageId, `⏳ <b>Mirroring unmirrored records to backup channel...</b>\n\nPlease wait a moment while files are copied.`);
    const mirrorResult = await runRetroactiveMirror(primaryCid, backupCid, 100);
    await answerCallbackQuery(cq.id, `Mirrored: ${mirrorResult.mirroredSuccess}, Failed: ${mirrorResult.mirroredFailed}`, true);
    await renderStorageAudit(chatId, messageId);
    return;
  } else if (action === 'promote_backup_confirm') {
    const text = `⚠️ <b>EMERGENCY FAILOVER / PROMOTE BACKUP</b>\n\n` +
      `This action will promote your current <b>Backup DB Channel</b> to become the <b>Primary DB Channel</b>.\n\n` +
      `Use this if your primary channel was copyright-struck, deleted, or permanently banned.\n\n` +
      `Are you sure you want to proceed?`;
    const buttons = [
      [{ text: toSmallCaps('Confirm: Promote Backup to Primary'), callback_data: 'admin:promote_backup_exec' }],
      [{ text: toSmallCaps('Cancel'), callback_data: 'admin:storage_audit' }]
    ];
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
    return;
  } else if (action === 'promote_backup_exec') {
    const { getBackupDbChannelId } = await import('../bot-helpers.js');
    const backupCid = await getBackupDbChannelId();
    if (!backupCid) {
      await answerCallbackQuery(cq.id, 'No backup channel configured!', true);
      return;
    }
    await updateSettings({
      dbChannelId: backupCid,
      backupDbChannelId: ''
    });
    await answerCallbackQuery(cq.id, 'Backup channel successfully promoted to Primary!', true);
    await renderStorageAudit(chatId, messageId);
    return;
  } else if (action === 'scan_heal_links') {
    const { getDbChannelId, getBackupDbChannelId } = await import('../bot-helpers.js');
    const { scanAndRepairBrokenLinks } = await import('../filestore.js');
    const primaryCid = await getDbChannelId();
    const backupCid = await getBackupDbChannelId();

    if (!primaryCid) {
      await answerCallbackQuery(cq.id, 'Primary DB Channel not configured!', true);
      return;
    }

    await editTelegramMessage(chatId, messageId, `🩺 <b>Scanning stored links...</b>\n\nTesting messages and auto-repairing from backup if needed.\nPlease wait a moment.`);

    const report = await scanAndRepairBrokenLinks(primaryCid, backupCid, 50);
    await answerCallbackQuery(cq.id, `Healthy: ${report.healthy}, Healed: ${report.healed}, Dead: ${report.unrecoverable}`, true);
    await renderStorageAudit(chatId, messageId);
    return;
  } else if (action === 'backup_db') {
    const { sendTelegramFileBuffer } = await import('../bot-common.js');
    const filesColl = await getCollection('files');
    const allFiles = await filesColl.find({}).toArray();

    const jsonStr = JSON.stringify(allFiles, null, 2);
    const buffer = Buffer.from(jsonStr, 'utf-8');
    const filename = `filestore_backup_${new Date().toISOString().slice(0, 10)}.json`;
    const caption = `💾 <b>Database Backup</b>\n\nTotal Stored Records: <b>${allFiles.length}</b>\nSize: <b>${(buffer.length / 1024).toFixed(2)} KB</b>`;

    await sendTelegramFileBuffer(chatId, buffer, filename, caption);
    await answerCallbackQuery(cq.id, 'Database backup sent to chat!');
    return;
  } else if (action === 'top_files') {
    const { getTopFiles, getDailyFileStats } = await import('../filestore.js');
    const [topList, daily] = await Promise.all([getTopFiles(10), getDailyFileStats()]);
    const botUsername = await getBotUsername();

    let header = `<b>Traffic Dashboard</b>\n\n` +
      `<b>Today</b>\n` +
      `• Links Created: <b>${daily.createdToday}</b>\n` +
      `• Downloads: <b>${daily.downloadsToday}</b>\n\n` +
      `<b>All Time</b>\n` +
      `• Total Links: <b>${daily.totalLinks}</b>\n` +
      `• Total Downloads: <b>${daily.allTimeDownloads}</b>\n`;

    if (!topList.length) {
      await editTelegramMessage(chatId, messageId, header + `\n<i>No downloads recorded yet.</i>`, {
        inline_keyboard: [
          [{ text: toSmallCaps("Today's Links"), callback_data: 'admin:today_links' }],
          ...navButtons('admin:file_mgmt')
        ]
      });
      return;
    }

    let report = header + `\n<b>Top 10 Most Downloaded</b>\n\n`;
    for (let i = 0; i < topList.length; i++) {
      const item = topList[i];
      const link = `https://t.me/${botUsername}?start=${item._id}`;
      report += `<b>${i + 1}.</b> <code>${item._id}</code> (${item.type || 'file'})\n` +
                `   • Downloads: <b>${item.accessCount || 0}</b>\n` +
                `   • Link: ${link}\n\n`;
    }

    await editTelegramMessage(chatId, messageId, report, {
      inline_keyboard: [
        [{ text: toSmallCaps("Today's Links"), callback_data: 'admin:today_links' }],
        ...navButtons('admin:file_mgmt')
      ]
    });
    return;
  } else if (action === 'today_links') {
    const { getTodayFiles } = await import('../filestore.js');
    const todayFiles = await getTodayFiles();
    const botUsername = await getBotUsername();

    if (!todayFiles.length) {
      await editTelegramMessage(chatId, messageId, `<b>Links Created Today</b>\n\n<i>No links have been created today yet.</i>`, {
        inline_keyboard: navButtons('admin:top_files')
      });
      return;
    }

    let report = `<b>Links Created Today (${todayFiles.length})</b>\n\n`;
    for (let i = 0; i < todayFiles.length; i++) {
      const item = todayFiles[i];
      const link = `https://t.me/${botUsername}?start=${item._id}`;
      report += `<b>${i + 1}.</b> <code>${item._id}</code> (${item.type || 'file'})\n` +
                `   • Downloads: <b>${item.accessCount || 0}</b>\n` +
                `   • Link: ${link}\n\n`;
    }

    await editTelegramMessage(chatId, messageId, report, {
      inline_keyboard: [
        [{ text: toSmallCaps('Copy All Links (Text)'), callback_data: 'admin:today_copy_text' }, { text: toSmallCaps('Export Today (.txt)'), callback_data: 'admin:export_today_txt' }],
        ...navButtons('admin:top_files')
      ]
    });
    return;
  } else if (action === 'bulk_store_start') {
    const dbError = await getDbChannelReadinessError();
    if (dbError) {
      await editTelegramMessage(chatId, messageId, dbError, { inline_keyboard: navButtons('admin:file_mgmt') });
      return;
    }

    const { setBulkStoreActive, clearStoreSession } = await import('../filestore.js');
    await clearStoreSession(chatId);
    await setBulkStoreActive(chatId, true);

    const text = `📦 <b>Bulk Store Mode Active</b>\n\n` +
      `Forward or send files (documents, videos, audio, photos) one by one.\n` +
      `Each file will be stored automatically and you will get <b>all links in one copyable list</b> and as a <b>.txt document</b> when finished.\n\n` +
      `When done, tap <b>Done & Get All Links</b> or send /done.\nSend /cancel to abort.`;

    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Done & Get All Links (0)'), callback_data: 'admin:bulk_store_done' }],
        [{ text: toSmallCaps('Cancel'), callback_data: 'admin:bulk_store_cancel' }]
      ]
    });
    return;
  } else if (action === 'bulk_store_done') {
    const { getStoreSession, setBulkStoreActive, clearStoreSession, generateRawLinksText, generateLinksExportText } = await import('../filestore.js');
    const codes = await getStoreSession(chatId);
    if (!codes.length) {
      await answerCallbackQuery(cq.id, 'No files stored in this session yet.', true);
      return;
    }

    await setBulkStoreActive(chatId, false);
    await clearStoreSession(chatId);
    await answerCallbackQuery(cq.id);

    const botUsername = await getBotUsername();
    const filesColl = await getCollection('files');
    const storedRecords = await filesColl.find({ _id: { $in: codes } }).toArray();

    const rawBlock = generateRawLinksText(codes, botUsername);
    const txtContent = generateLinksExportText(storedRecords.length ? storedRecords : codes.map(c => ({ _id: c })), botUsername, 'Bulk Stored Files');
    const buffer = Buffer.from(txtContent, 'utf-8');
    const filename = `bulk_store_${codes.length}_links_${new Date().toISOString().slice(0, 10)}.txt`;

    await editTelegramMessage(chatId, messageId, `📋 <b>Bulk Store Complete! (${codes.length} Files Stored)</b>\n\nTap the box below to copy all links at once:\n<pre>${rawBlock}</pre>`, {
      inline_keyboard: [
        [{ text: toSmallCaps('Store More Files'), callback_data: 'admin:bulk_store_start' }],
        ...navButtons('admin:file_mgmt')
      ]
    });

    const { sendTelegramFileBuffer } = await import('../bot-common.js');
    await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>Exported ${codes.length} Links (.txt)</b>`);
    return;
  } else if (action === 'bulk_store_cancel') {
    const { setBulkStoreActive, clearStoreSession } = await import('../filestore.js');
    await setBulkStoreActive(chatId, false);
    await clearStoreSession(chatId);
    await answerCallbackQuery(cq.id, 'Bulk Store cancelled.');
    await editTelegramMessage(chatId, messageId, `<b>Bulk Store cancelled.</b>`, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
    return;
  } else if (action === 'export_all_txt') {
    const { generateLinksExportText } = await import('../filestore.js');
    const { sendTelegramFileBuffer } = await import('../bot-common.js');
    const filesColl = await getCollection('files');
    const allFiles = await filesColl.find({}).sort({ createdAt: -1 }).toArray();

    if (!allFiles.length) {
      await answerCallbackQuery(cq.id, 'No stored links found in database.', true);
      return;
    }

    const botUsername = await getBotUsername();
    const txtContent = generateLinksExportText(allFiles, botUsername, 'All Stored Links');
    const buffer = Buffer.from(txtContent, 'utf-8');
    const filename = `filestore_all_links_${new Date().toISOString().slice(0, 10)}.txt`;
    const caption = `📄 <b>All Stored Links Export</b>\n\nTotal Records: <b>${allFiles.length}</b>\nSize: <b>${(buffer.length / 1024).toFixed(2)} KB</b>`;

    await sendTelegramFileBuffer(chatId, buffer, filename, caption);
    await answerCallbackQuery(cq.id, 'Links exported as .txt file!');
    return;
  } else if (action === 'export_today_txt') {
    const { getTodayFiles, generateLinksExportText } = await import('../filestore.js');
    const { sendTelegramFileBuffer } = await import('../bot-common.js');
    const todayFiles = await getTodayFiles();

    if (!todayFiles.length) {
      await answerCallbackQuery(cq.id, 'No links created today.', true);
      return;
    }

    const botUsername = await getBotUsername();
    const txtContent = generateLinksExportText(todayFiles, botUsername, "Today's Links");
    const buffer = Buffer.from(txtContent, 'utf-8');
    const filename = `filestore_today_links_${new Date().toISOString().slice(0, 10)}.txt`;
    const caption = `📄 <b>Today's Links Export</b>\n\nTotal Links Created Today: <b>${todayFiles.length}</b>\nSize: <b>${(buffer.length / 1024).toFixed(2)} KB</b>`;

    await sendTelegramFileBuffer(chatId, buffer, filename, caption);
    await answerCallbackQuery(cq.id, "Today's links exported as .txt file!");
    return;
  } else if (action === 'today_copy_text') {
    const { getTodayFiles, generateRawLinksText } = await import('../filestore.js');
    const todayFiles = await getTodayFiles();

    if (!todayFiles.length) {
      await answerCallbackQuery(cq.id, 'No links created today.', true);
      return;
    }

    const botUsername = await getBotUsername();
    const rawBlock = generateRawLinksText(todayFiles, botUsername);
    await sendTelegramMessage(chatId, `📋 <b>Today's Links (${todayFiles.length})</b>\n\nTap the monospace box below to copy all links at once:\n<pre>${rawBlock}</pre>`, {
      inline_keyboard: [
        [{ text: toSmallCaps('Export Today (.txt)'), callback_data: 'admin:export_today_txt' }],
        [{ text: toSmallCaps('Back to Traffic Dashboard'), callback_data: 'admin:top_files' }]
      ]
    });
    await answerCallbackQuery(cq.id, 'Copyable list sent below!');
    return;
  } else if (action === 'export_hub') {
    const text = `📄 <b>Export Links Hub</b>\n\nSelect what type of links you want to export:\n\n• <b>Single Files:</b> Individual uploaded file & media links\n• <b>Batches:</b> Multi-file collection links\n• <b>All Links:</b> Every file and batch combined`;
    await editTelegramMessage(chatId, messageId, text, getExportHubKeyboard());
    return;
  } else if (action.startsWith('export_type:')) {
    const type = action.split(':')[1] || 'all';
    const typeTitle = type === 'batch' ? '📦 <b>Export Batch Links</b>' : type === 'media' ? '📁 <b>Export Single Files</b>' : '📄 <b>Export All Links (Combined)</b>';
    const text = `${typeTitle}\n\nSelect a time duration or category to export as a <b>.txt</b> document and get a 1-tap copyable text block:`;
    await editTelegramMessage(chatId, messageId, text, getExportTimeKeyboard(type));
    return;
  } else if (action.startsWith('exp_time:')) {
    const parts = action.split(':');
    const seconds = parseInt(parts[1], 10) || 1800;
    const filterType = parts[2] || 'all';

    const { getFilesWithinDuration, generateLinksExportText, generateRawLinksText, formatDurationLabel } = await import('../filestore.js');
    const { sendTelegramFileBuffer } = await import('../bot-common.js');

    const records = await getFilesWithinDuration(seconds, filterType);
    const durationLabel = formatDurationLabel(seconds);
    const typeLabel = filterType === 'batch' ? 'Batches' : filterType === 'media' ? 'Single Files' : 'Links';

    if (!records.length) {
      await answerCallbackQuery(cq.id, `No ${typeLabel.toLowerCase()} found in the last ${durationLabel}.`, true);
      return;
    }

    const botUsername = await getBotUsername();
    const title = `${typeLabel} in Last ${durationLabel}`;
    const txtContent = generateLinksExportText(records, botUsername, title);
    const buffer = Buffer.from(txtContent, 'utf-8');
    const filename = `filestore_${filterType}_${Math.round(seconds / 60)}m_${new Date().toISOString().slice(0, 10)}.txt`;

    if (records.length <= 30) {
      const rawBlock = generateRawLinksText(records, botUsername);
      await sendTelegramMessage(chatId, `📋 <b>${title} (${records.length})</b>\n\nTap box to copy all links at once:\n<pre>${rawBlock}</pre>`);
    }

    await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>${title}</b>\n\nTotal Records: <b>${records.length}</b>\nSize: <b>${(buffer.length / 1024).toFixed(2)} KB</b>`);
    await answerCallbackQuery(cq.id, `Exported ${records.length} ${typeLabel.toLowerCase()}!`);
    return;
  } else if (action.startsWith('exp_today:')) {
    const filterType = action.split(':')[1] || 'all';
    const isBatchOnly = filterType === 'batch';
    const isFileOnly = filterType === 'media';

    const { getTodayFiles, generateLinksExportText, generateRawLinksText } = await import('../filestore.js');
    const { sendTelegramFileBuffer } = await import('../bot-common.js');
    const todayFiles = await getTodayFiles();
    const filtered = isBatchOnly ? todayFiles.filter(f => f.type === 'batch') : isFileOnly ? todayFiles.filter(f => f.type !== 'batch') : todayFiles;
    const typeLabel = isBatchOnly ? 'Batches' : isFileOnly ? 'Single Files' : 'Links';

    if (!filtered.length) {
      await answerCallbackQuery(cq.id, `No ${typeLabel.toLowerCase()} created today.`, true);
      return;
    }

    const botUsername = await getBotUsername();
    const title = `Today's ${typeLabel}`;
    const txtContent = generateLinksExportText(filtered, botUsername, title);
    const buffer = Buffer.from(txtContent, 'utf-8');
    const filename = `filestore_today_${filterType}_${new Date().toISOString().slice(0, 10)}.txt`;

    if (filtered.length <= 30) {
      const rawBlock = generateRawLinksText(filtered, botUsername);
      await sendTelegramMessage(chatId, `📋 <b>${title} (${filtered.length})</b>\n\nTap box to copy all links:\n<pre>${rawBlock}</pre>`);
    }

    await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>${title} Export</b> (${filtered.length} records)`);
    await answerCallbackQuery(cq.id, `Exported ${filtered.length} ${typeLabel.toLowerCase()}!`);
    return;
  } else if (action.startsWith('exp_all:')) {
    const filterType = action.split(':')[1] || 'all';
    const isBatchOnly = filterType === 'batch';
    const isFileOnly = filterType === 'media';

    const { generateLinksExportText, generateRawLinksText } = await import('../filestore.js');
    const { sendTelegramFileBuffer } = await import('../bot-common.js');
    const filesColl = await getCollection('files');
    const query = {};
    if (filterType !== 'all') query.type = filterType;
    const allFiles = await filesColl.find(query).sort({ createdAt: -1 }).toArray();
    const typeLabel = isBatchOnly ? 'Batches' : isFileOnly ? 'Single Files' : 'Links';

    if (!allFiles.length) {
      await answerCallbackQuery(cq.id, `No ${typeLabel.toLowerCase()} found in database.`, true);
      return;
    }

    const botUsername = await getBotUsername();
    const title = `All Stored ${typeLabel}`;
    const txtContent = generateLinksExportText(allFiles, botUsername, title);
    const buffer = Buffer.from(txtContent, 'utf-8');
    const filename = `filestore_all_${filterType}_${new Date().toISOString().slice(0, 10)}.txt`;

    if (allFiles.length <= 30) {
      const rawBlock = generateRawLinksText(allFiles, botUsername);
      await sendTelegramMessage(chatId, `📋 <b>${title} (${allFiles.length})</b>\n\nTap box to copy all links:\n<pre>${rawBlock}</pre>`);
    }

    await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>${title} Export</b> (${allFiles.length} records)`);
    await answerCallbackQuery(cq.id, `Exported ${allFiles.length} ${typeLabel.toLowerCase()}!`);
    return;
  } else if (action.startsWith('exp_custom_prompt:')) {
    const filterType = action.split(':')[1] || 'all';
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: `export_custom_duration:${filterType}`, expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    const typeLabel = filterType === 'batch' ? 'Batches' : filterType === 'media' ? 'Single Files' : 'Links';
    const text = `⏱ <b>Export ${typeLabel} by Custom Time</b>\n\nEnter the duration in minutes or hours to export.\n\n` +
      `<b>Format Examples:</b>\n` +
      `• <code>10m</code> or <code>10</code> : last 10 minutes\n` +
      `• <code>45m</code> : last 45 minutes\n` +
      `• <code>2h</code> : last 2 hours\n\n` +
      `Send /cancel to abort.`;

    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: `admin:export_type:${filterType}` }]]
    });
    return;
  } else if (action === 'temp_token_start') {
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: 'temp_token_input', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `⏳ <b>Create Temporary Access Token</b>\n\nPlease send the <b>File Code</b> or <b>Batch Code</b> (e.g., <code>file_...</code> or <code>batch_...</code>) you want to generate a time-limited sharing link for.\n\nSend /cancel to abort.`, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
  } else if (action.startsWith('temp_token_for:')) {
    const targetCode = action.split(':')[1];
    const durKb = {
      inline_keyboard: [
        [
          { text: toSmallCaps('15 Mins'), callback_data: `admin:gen_temp:${targetCode}:900` },
          { text: toSmallCaps('1 Hour'), callback_data: `admin:gen_temp:${targetCode}:3600` },
          { text: toSmallCaps('6 Hours'), callback_data: `admin:gen_temp:${targetCode}:21600` }
        ],
        [
          { text: toSmallCaps('12 Hours'), callback_data: `admin:gen_temp:${targetCode}:43200` },
          { text: toSmallCaps('24 Hours'), callback_data: `admin:gen_temp:${targetCode}:86400` },
          { text: toSmallCaps('3 Days'), callback_data: `admin:gen_temp:${targetCode}:259200` }
        ],
        [
          { text: toSmallCaps('7 Days'), callback_data: `admin:gen_temp:${targetCode}:604800` }
        ],
        ...navButtons('admin:file_mgmt')
      ]
    };
    await editTelegramMessage(chatId, messageId, `⏱ <b>Select Expiration Duration</b> for <code>${esc(targetCode)}</code>:`, durKb);
  } else if (action.startsWith('gen_temp:')) {
    const parts = action.split(':');
    const targetCode = parts[1];
    const durationSec = parseInt(parts[2], 10) || 3600;
    const { generateTempToken } = await import('../filestore.js');

    const genRes = await generateTempToken(targetCode, durationSec, {
      createdBy: chatId,
      creatorName: from?.first_name || 'Admin',
    });

    if (!genRes.ok) {
      await editTelegramMessage(chatId, messageId, `❌ <b>Failed to generate temporary link.</b>\n\nTarget code <code>${esc(targetCode)}</code> could not be found in storage.`, {
        inline_keyboard: navButtons('admin:file_mgmt')
      });
      return;
    }

    const botUsername = await getBotUsername();
    const shareLink = `https://t.me/${botUsername}?start=${genRes.token}`;
    const text = `⏳ <b>Temporary Access Token Generated!</b>\n\n` +
      `📁 Target: <code>${esc(genRes.tokenDoc.targetCode)}</code> (${genRes.tokenDoc.targetType})\n` +
      `⏱ Validity: <b>${genRes.durationLabel}</b>\n` +
      `📅 Expires at: <code>${new Date(genRes.expiresAt).toUTCString()}</code>\n\n` +
      `🔗 <b>Temporary Share Link:</b>\n<code>${shareLink}</code>\n\n` +
      `<i>Anyone using this link will receive the file(s) before the link expires.</i>`;

    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Revoke Token'), callback_data: `admin:revoke_temp:${genRes.token}` }],
        [{ text: toSmallCaps('📋 All Active Tokens'), callback_data: 'admin:temp_tokens_list' }],
        ...navButtons('admin:file_mgmt')
      ]
    });
  } else if (action === 'temp_tokens_list') {
    const { listActiveTempTokens, formatDuration } = await import('../filestore.js');
    const list = await listActiveTempTokens(null, 20);

    if (!list || list.length === 0) {
      await editTelegramMessage(chatId, messageId, `ℹ️ <b>No active temporary access tokens found.</b>\n\nGenerate temporary tokens from File Management or using <code>/temptoken &lt;code&gt; [duration]</code>.`, {
        inline_keyboard: navButtons('admin:file_mgmt')
      });
      return;
    }

    const botUsername = await getBotUsername();
    let text = `📋 <b>Active Temporary Access Tokens</b> (${list.length})\n\n`;
    const buttons = [];

    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const remainingSec = Math.max(0, Math.round((new Date(t.expiresAt).getTime() - Date.now()) / 1000));
      const remStr = formatDuration(remainingSec);
      const link = `https://t.me/${botUsername}?start=${t._id}`;

      text += `<b>${i + 1}.</b> <code>${t._id}</code> → <code>${t.targetCode}</code>\n` +
              `   ⏱ Left: <b>${remStr}</b> | Uses: <b>${t.useCount || 0}</b>\n` +
              `   🔗 ${link}\n\n`;

      buttons.push([
        { text: toSmallCaps(`Revoke #${i + 1} (${t._id.slice(-6)})`), callback_data: `admin:revoke_temp:${t._id}` }
      ]);
    }

    buttons.push(...navButtons('admin:file_mgmt'));

    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
  } else if (action.startsWith('revoke_temp:')) {
    const tokenId = action.split(':')[1];
    const { revokeTempToken } = await import('../filestore.js');
    const revokeRes = await revokeTempToken(tokenId, chatId, true);

    if (!revokeRes.ok) {
      await editTelegramMessage(chatId, messageId, `❌ Failed to revoke token <code>${esc(tokenId)}</code>.`, {
        inline_keyboard: navButtons('admin:file_mgmt')
      });
      return;
    }

    await editTelegramMessage(chatId, messageId, `✅ Temporary token <code>${esc(tokenId)}</code> has been revoked and can no longer be accessed.`, {
      inline_keyboard: [
        [{ text: toSmallCaps('📋 Active Tokens'), callback_data: 'admin:temp_tokens_list' }],
        ...navButtons('admin:file_mgmt')
      ]
    });
  } else if (action === 'trigger_cleanup') {
    const { runWeeklyCleanup } = await import('../filestore.js');
    const result = await runWeeklyCleanup();
    await editTelegramMessage(chatId, messageId, `<b>Weekly Cleanup Completed</b>\n\nDeleted records created between Sunday and Monday: <b>${result.deletedRecords}</b>`, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
  } else if (action === 'auto_del_mgmt') {
    await renderAutoDelMgmt(chatId, messageId);
  } else if (action === 'select_autodel_timer') {
    const text = `⏱ <b>Select Auto Delete Duration</b>\n\nChoose how long before files are automatically deleted:`;
    const buttons = [
      [{ text: toSmallCaps('1 Min'), callback_data: 'admin:set_timer_enable:60' }, { text: toSmallCaps('5 Mins'), callback_data: 'admin:set_timer_enable:300' }, { text: toSmallCaps('10 Mins'), callback_data: 'admin:set_timer_enable:600' }],
      [{ text: toSmallCaps('30 Mins'), callback_data: 'admin:set_timer_enable:1800' }, { text: toSmallCaps('1 Hour'), callback_data: 'admin:set_timer_enable:3600' }, { text: toSmallCaps('24 Hours'), callback_data: 'admin:set_timer_enable:86400' }],
      [{ text: toSmallCaps('Cancel'), callback_data: 'admin:auto_del_mgmt' }]
    ];
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
  } else if (action.startsWith('set_timer_enable:')) {
    const sec = action.split(':')[1];
    await updateSettings({ autoDeleteTimer: sec, autoDeleteEnabled: '1' });
    await answerCallbackQuery(cq.id, `Auto Delete Enabled (${sec < 60 ? sec + 's' : sec < 3600 ? Math.round(sec / 60) + ' mins' : Math.round(sec / 3600) + ' hours'})`);
    await renderAutoDelMgmt(chatId, messageId);
  } else if (action.startsWith('toggle_autodel:')) {
    const val = action.split(':')[1];
    await updateSettings({ autoDeleteEnabled: val });
    await answerCallbackQuery(cq.id, `Auto Delete ${val === '1' ? 'Enabled' : 'Disabled'}`);
    await renderAutoDelMgmt(chatId, messageId);
  } else if (action.startsWith('set_timer:')) {
    const sec = action.split(':')[1];
    await updateSettings({ autoDeleteTimer: sec, autoDeleteEnabled: '1' });
    await answerCallbackQuery(cq.id, `Timer updated!`);
    await renderAutoDelMgmt(chatId, messageId);
  } else if (action.startsWith('toggle_protect:')) {
    const val = action.split(':')[1];
    await updateSettings({ protectContent: val });
    await answerCallbackQuery(cq.id, `Content Protection ${val === '1' ? 'Enabled' : 'Disabled'}`);
    await renderAutoDelMgmt(chatId, messageId);
  } else if (action === 'batch_start') {
    const dbError = await getDbChannelReadinessError();
    if (dbError) {
      await editTelegramMessage(chatId, messageId, dbError, { inline_keyboard: navButtons('admin:file_mgmt') });
      return;
    }

    const { setBatchSession } = await import('../filestore.js');
    await setBatchSession(chatId, { step: 'first', collectedIds: [] });
    await editTelegramMessage(chatId, messageId, `<b>Batch Mode</b>\n\nForward the first message or start sending files.\n\nSend /cancel to abort.`, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
  } else if (action === 'store_start') {
    const dbError = await getDbChannelReadinessError();
    if (dbError) {
      await editTelegramMessage(chatId, messageId, dbError, { inline_keyboard: navButtons('admin:file_mgmt') });
      return;
    }

    const { setAdminWaitingForFile } = await import('../filestore.js');
    await setAdminWaitingForFile(chatId);
    await editTelegramMessage(chatId, messageId, `<b>Store Single File</b>\n\nPlease send the file (document, video, audio, or photo) you want to store.\n\nSend /cancel to abort.`, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
  } else if (action === 'batch_done') {
    const { getBatchSession, storeBatch, clearBatchSession, generateBatchCode } = await import('../filestore.js');
    const batchSession = await getBatchSession(chatId);
    if (!batchSession || !batchSession.collectedIds?.length) {
      await answerCallbackQuery(cq.id, 'No files collected.');
      return;
    }
    await answerCallbackQuery(cq.id);

    const dbChannelId = await getDbChannelId();
    const batchCode   = generateBatchCode();

    const totalCollected = batchSession.collectedIds.length;
    const finalIds = batchSession.collectedIds.slice(0, 500);
    const backupDbChannelId = await getBackupDbChannelId();
    const finalBackupIds = Array.isArray(batchSession.backupCollectedIds) ? batchSession.backupCollectedIds.slice(0, 500) : [];
    await storeBatch(batchCode, dbChannelId, finalIds, {}, { backupDbChannelId, backupDbMessageIds: finalBackupIds });
    await clearBatchSession(chatId);
    const botUsername = await getBotUsername();
    const shareLink   = `https://t.me/${botUsername}?start=${batchCode}`;

    let msgText = `<b>Batch Created!</b>\n\nFiles collected: <b>${totalCollected}</b>\nBatch code: <code>${batchCode}</code>\n\n<b>Share this link:</b>\n<code>${shareLink}</code>\n<i>(Tap link to copy)</i>`;
    if (totalCollected > 500) {
      const dropped = totalCollected - 500;
      msgText += `\n\n<b>Warning:</b> Batches are limited to 500 files. <b>${dropped}</b> files were truncated (dropped) from the end of the batch.`;
    }

    await editTelegramMessage(chatId, messageId, msgText, {
      inline_keyboard: [
        [{ text: toSmallCaps('Generate Temp Link'), callback_data: `admin:temp_token_for:${batchCode}` }],
        [{ text: toSmallCaps('Create Another Batch'), callback_data: 'admin:batch_start' }, { text: toSmallCaps("Today's Links"), callback_data: 'admin:today_links' }],
        ...navButtons('admin:dashboard')
      ]
    });
    return;
  } else if (action === 'bundle_start') {
    const dbError = await getDbChannelReadinessError();
    if (dbError) {
      await editTelegramMessage(chatId, messageId, dbError, { inline_keyboard: navButtons('admin:file_mgmt') });
      return;
    }

    const { setBundleSession } = await import('../filestore.js');
    await setBundleSession(chatId, { step: 'first', qualities: [], title: '', sessionMsgId: messageId });
    await editTelegramMessage(chatId, messageId, `🎛 <b>Create Multi-Quality Bundle</b>\n\nSend the <b>first message link</b> (or forward the first video):\nExample: <code>https://t.me/c/1234567890/101</code>\n\n<i>💡 You can also send both links together:</i>\n<code>https://t.me/c/.../101 https://t.me/c/.../104</code>\n\nSend /done when finished, or /cancel to abort.`, {
      inline_keyboard: [
        [{ text: toSmallCaps('Finish Bundle'), callback_data: 'admin:bundle_done' }],
        [{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]
      ]
    });
    return;
  } else if (action === 'bundle_done') {
    const { getBundleSession, storeBundle, generateBundleCode, clearBundleSession, sortQualities } = await import('../filestore.js');
    const bSession = await getBundleSession(chatId);
    if (!bSession || !bSession.qualities?.length) {
      await answerCallbackQuery(cq.id, 'No files added to bundle yet.', true);
      return;
    }

    const dbChannelId = await getDbChannelId();
    const backupDbChannelId = await getBackupDbChannelId();
    const bundleCode = generateBundleCode();
    const title = bSession.title || bSession.qualities[0].fileName || 'Multi-Quality Release';
    const sortedQualities = sortQualities(bSession.qualities);

    await storeBundle(bundleCode, title, dbChannelId, sortedQualities, { userId: chatId }, { backupDbChannelId });
    await clearBundleSession(chatId);

    const bot = await getBotUsername();
    const shareLink = `https://t.me/${bot}?start=${bundleCode}`;
    const qList = sortedQualities.map(q => `• <b>${q.quality}</b> (${q.fileSizeLabel})`).join('\n');

    const text = `🎛 <b>Multi-Quality Bundle Created!</b>\n\n` +
      `<b>Title:</b> ${esc(title)}\n` +
      `<b>Resolutions Included (${sortedQualities.length}):</b>\n${qList}\n\n` +
      `<b>Share Link:</b>\n<code>${shareLink}</code>\n<i>(Tap link to copy)</i>`;

    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Generate Temp Link'), callback_data: `admin:temp_token_for:${bundleCode}` }],
        [{ text: toSmallCaps('Create Another Bundle'), callback_data: 'admin:bundle_start' }, { text: toSmallCaps("Today's Links"), callback_data: 'admin:today_links' }],
        ...navButtons('admin:dashboard')
      ]
    });
    return;
  } else if (action === 'cancel_session') {
    const { clearBatchSession, clearBundleSession, checkAndClearAdminWaiting } = await import('../filestore.js');
    await clearBatchSession(chatId);
    await clearBundleSession(chatId);
    await checkAndClearAdminWaiting(chatId);
    await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
    await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });
    await sessions.deleteOne({ _id: `admin:waiting_premium_user:${chatId}` });

    await editTelegramMessage(chatId, messageId, `<b>Session cancelled.</b>`, {
      inline_keyboard: navButtons('admin:dashboard')
    });
  } else if (action === 'fs_settings') {
    const s = await getSettings();
    const envDb = (process.env.TELEGRAM_DB_CHANNEL_ID || '').trim();
    const dbChannel = envDb || s.dbChannelId || 'Not set';
    const text = `<b>Bot Settings</b>\n\nConfigure your bot settings using the categories below.\n\n• <b>DB Channel:</b> <code>${esc(dbChannel)}</code> <i>(${envDb ? 'Environment' : 'Database'})</i>`;
    const buttons = [
      [{ text: toSmallCaps('Start Message'), callback_data: 'admin:fs_cfg:start' }, { text: toSmallCaps('Force Sub'), callback_data: 'admin:fs_cfg:fsub' }],
      [{ text: toSmallCaps('Access Token'), callback_data: 'admin:fs_cfg:tkn' }, { text: toSmallCaps('Banners & Images'), callback_data: 'admin:banners_mgmt' }],
      ...navButtons('admin:dashboard')
    ];
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
  } else if (action === 'banners_mgmt') {
    await renderBannersMgmt(chatId, messageId);
    return;
  } else if (action.startsWith('set_banner:')) {
    const bannerKey = action.split(':')[1];
    const bannerLabels = {
      startPhoto: 'Start Menu Banner',
      bannerFsub: 'Force-Sub Gate Banner',
      bannerVerify: 'Token Verification Banner',
      bannerDelivery: 'Batch Delivery Banner',
      bannerProfile: 'User Profile (/me) Banner',
    };
    const label = bannerLabels[bannerKey] || 'Banner';

    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: bannerKey, expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );

    await editTelegramMessage(chatId, messageId,
      `🖼 <b>Set ${esc(label)}</b>\n\n` +
      `Please send or forward the <b>photo</b> or <b>image link (URL)</b> you want to display for this screen.\n\n` +
      `Send /cancel to abort.`,
      { inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]] }
    );
  } else if (action.startsWith('del_banner:')) {
    const bannerKey = action.split(':')[1];
    await updateSettings({ [bannerKey]: null });
    await answerCallbackQuery(cq.id, 'Banner removed.');
    await renderBannersMgmt(chatId, messageId);
    return;
  } else if (action.startsWith('fs_cfg:')) {
    const cfgType = action.split(':')[1];
    await renderFsCfg(chatId, messageId, cfgType);
  } else if (action.startsWith('fs_toggle:')) {
    const val = action.split(':')[1];
    await updateSettings({ enabled: val });
    await logHistory(`verification_${val === '1' ? 'enabled' : 'disabled'}`, 'tg');
    await answerCallbackQuery(cq.id, `Token verification ${val === '1' ? 'enabled' : 'disabled'}.`);
    await renderFsCfg(chatId, messageId, 'tkn');
  } else if (action.startsWith('fs_toggle_ref:')) {
    const val = action.split(':')[1];
    await updateSettings({ referralDisabled: val });
    await logHistory(`referrals_${val === '1' ? 'disabled' : 'enabled'}`, 'tg');
    await answerCallbackQuery(cq.id, `Referrals system ${val === '1' ? 'disabled' : 'enabled'}.`);
    await renderFsCfg(chatId, messageId, 'tkn');
  } else if (action === 'fs_set_db') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'dbChannelId', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🗄 <b>Set Database Channel ID</b>\n\nPlease send the Channel ID for your storage.\nExample: <code>-100123456789</code>\n\nMake sure the bot is an <b>administrator</b> in this channel with 'Post Messages' permission.`, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
  } else if (action === 'fs_set_url') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'shortenerUrl', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🔗 <b>Set Shortener URL</b>\n\nSend the base API URL for your shortener.\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
  } else if (action === 'fs_set_key') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'shortenerKey', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🔑 <b>Set Shortener API Key</b>\n\nSend your API key for the shortener.\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  } else if (action === 'fs_set_burl') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'backupShortenerUrl', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🔗 <b>Set Backup Shortener URL</b>\n\nSend the base API URL for your backup shortener (e.g. <code>https://shrinkme.io/api</code>).\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  } else if (action === 'fs_set_bkey') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'backupShortenerKey', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🔑 <b>Set Backup Shortener API Key</b>\n\nSend your API key for the backup shortener.\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  } else if (action === 'fs_set_ttl') {
    const s = await getSettings();
    const currentTtl = (s.validityHours !== undefined && s.validityHours !== '') ? parseInt(s.validityHours, 10) : 24;
    const ttlButtons = [
      [{ text: `${currentTtl === 0 ? '✅ ' : ''}0 Hrs (Verify Every File/Batch)`, callback_data: 'admin:fs_set_ttl_val:0' }]
    ];
    for (let i = 1; i <= 24; i += 4) {
      const row = [];
      for (let j = i; j < i + 4 && j <= 24; j++) {
        const isCurrent = j === currentTtl;
        row.push({
          text: `${isCurrent ? '✅ ' : ''}${j} ${j === 1 ? 'Hr' : 'Hrs'}`,
          callback_data: `admin:fs_set_ttl_val:${j}`
        });
      }
      ttlButtons.push(row);
    }
    ttlButtons.push([{ text: toSmallCaps('Back'), callback_data: 'admin:fs_cfg:tkn' }]);

    await editTelegramMessage(chatId, messageId, `⏱ <b>Set Token Validity</b>\n\nSelect the number of hours (0-24) an access token should remain valid before user needs to verify again:\n(Select 0 to require verification on every file/batch)`, {
      inline_keyboard: ttlButtons
    });
  } else if (action.startsWith('fs_set_ttl_val:')) {
    const hours = parseInt(action.split(':')[1], 10);
    if (!isNaN(hours) && hours >= 0 && hours <= 24) {
      await updateSettings({ validityHours: String(hours) });
      const label = hours === 0 ? 'Every File/Batch (0h)' : `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
      await answerCallbackQuery(cq.id, `Validity updated to ${label}!`);
    } else {
      await answerCallbackQuery(cq.id, `Invalid hours selection.`, true);
    }
    await renderFsCfg(chatId, messageId, 'tkn');
    return;
  } else if (action === 'fs_set_stext') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'startText', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `📝 <b>Set Main Bot Start Text</b>\n\nYou can use HTML tags and placeholders:\n• <code>{mention}</code> : mention user\n• <code>{first_name}</code> : user first name\n• <code>{last_name}</code> : user last name\n\nPlease send the text now.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  } else if (action === 'fs_set_sphoto') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'startPhoto', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🖼 <b>Set Main Bot Start Photo</b>\n\nPlease send or forward the photo you want to use.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  } else if (action === 'fs_del_sphoto') {
    await updateSettings({ startPhoto: null });
    await answerCallbackQuery(cq.id, 'Start photo removed.');
    await renderFsCfg(chatId, messageId, 'start');
    return;
  } else if (action === 'fs_set_tut') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'tutorialFileId', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🎬 <b>Set Tutorial Video</b>\n\nSend or forward the <b>video file</b> you want to use as a tutorial.\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
  } else if (action === 'fs_noop') {
    await answerCallbackQuery(cq.id);
    return;
  } else if (action === 'fs_set_fsub') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'forceSubscribeChannels', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId,
      `📢 <b>Set Force Subscribe Channels</b>\n\nSend a comma-separated list of channel IDs.\nExample: <code>-100123456789,-100987654321</code>\n\nSend /cancel to abort.`,
      { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]] });
  } else if (action === 'fs_set_fsub_msg') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'forceSubscribeMsg', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId,
      `📝 <b>Set Force Subscribe Message</b>\n\nSend the HTML message shown to users who haven't joined.\n\nSend /cancel to abort.`,
      { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]] });
  } else if (action === 'fs_set_fsmode') {
    const s = await getSettings();
    const newMode = s.forceSubscribeMode === 'join_request' ? 'normal' : 'join_request';
    await updateSettings({ forceSubscribeMode: newMode });
    await answerCallbackQuery(cq.id, `Mode set to ${newMode}.`);
    await renderFsCfg(chatId, messageId, 'fsub');
    return;
  } else if (action === 'fs_premium_prompt') {
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
  } else if (action.startsWith('fs_set_premium:')) {
    const days = parseInt(action.split(':')[1], 10);
    const targetDoc = await sessions.findOne({ _id: `admin:premium_target:${chatId}` });
    const targetUserId = targetDoc && targetDoc.expiresAt > new Date() ? targetDoc.val : null;
    if (!targetUserId) {
      await answerCallbackQuery(cq.id, 'Session expired.');
      return;
    }

    const ttlSeconds = days * 24 * 3600;
    const premiumUntil = new Date(Date.now() + ttlSeconds * 1000);
    const users = await getCollection('users');
    await users.updateOne(
      { _id: String(targetUserId) },
      { $set: { premiumUntil } },
      { upsert: true }
    );

    await sessions.deleteOne({ _id: `admin:premium_target:${chatId}` });
    await sessions.deleteOne({ _id: `admin:premium_msg_id:${chatId}` });
    await editTelegramMessage(chatId, messageId, `<b>Premium Access Granted!</b>\n\nUser: <code>${targetUserId}</code>\nDuration: <b>${days} days</b>`, {
      inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'admin:user_mgmt' }]]
    });
    await sendTelegramMessage(targetUserId, `<b>Congratulations!</b>\n\nYou have been granted <b>Premium Access</b> for <b>${days} days</b>.`);
  }

  if (requiresCustomToast) {
    await answerCallbackQuery(cq.id).catch(() => {});
  }
  return;
}
