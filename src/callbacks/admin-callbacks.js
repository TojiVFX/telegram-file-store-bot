import {
  getCollection, getSettings, updateSettings, toSmallCaps, editTelegramMessage, answerCallbackQuery, sendTelegramMessage, logHistory, deleteTelegramMessage, sendTelegramVideo, sendTelegramPhoto, esc
} from '../bot-common.js';
import {
  getBotUsername, getForceSubChannelsList, isBotAdmin, getDbChannelId, getAdminDashboardKeyboard, getDbChannelReadinessError
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

async function renderFsCfg(chatId, messageId, cfgType) {
  const s = await getSettings();
  let text = '';
  let buttons = [];

  if (cfgType === 'start') {
    text = `<b>Start Message</b>\n\nCustomize your main bot start message using the following buttons:`;
    buttons = [
      [{ text: toSmallCaps('START TEXT'), callback_data: 'admin:fs_set_stext' }, { text: toSmallCaps('START PHOTO'), callback_data: 'admin:fs_set_sphoto' }],
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

export async function handleAdminCallback(chatId, messageId, action, cq, res) {
  const requiresCustomToast = action.startsWith('fs_fsub_toggle:') ||
                              action.startsWith('fs_fsub_del_confirm:') ||
                              action.startsWith('fs_fsub_setmode:') ||
                              action.startsWith('fs_toggle:') ||
                              action.startsWith('fs_toggle_ref:') ||
                              action.startsWith('fs_set_ttl_val:') ||
                              action === 'fs_set_fsmode' ||
                              action === 'fs_noop' ||
                              action.startsWith('fs_set_premium:') ||
                              action === 'batch_done';

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
    return res.status(200).send('OK');
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
    return res.status(200).send('OK');
  }

  if (action === 'fs_fsub_status') {
    const s = await getSettings();
    const fsub = s.forceSubscribeChannels || '';
    const globalMode = s.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(fsub, globalMode);

    if (channels.length === 0) {
       await answerCallbackQuery(cq.id, 'No Force Subscribe channels configured.', true);
       return res.status(200).send('OK');
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

    return res.status(200).send('OK');
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
    return res.status(200).send('OK');
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
      return res.status(200).send('OK');
    }
    await answerCallbackQuery(cq.id, "Channel not found.", true);
    return res.status(200).send('OK');
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
    return res.status(200).send('OK');
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
    return res.status(200).send('OK');
  }

  if (action.startsWith('fs_fsub_setmode:')) {
    const selectedMode = action.split(':')[1];
    const pendingRaw = await sessions.findOne({ _id: `admin:fsub_pending_add:${chatId}` });
    if (!pendingRaw || pendingRaw.expiresAt < new Date()) {
      await answerCallbackQuery(cq.id, "Session expired.", true);
      return res.status(200).send('OK');
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
    return res.status(200).send('OK');
  }

  if (action === 'dashboard') {
    await renderDashboard(chatId, messageId);
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
    await editTelegramMessage(chatId, messageId, `<b>Broadcast Message</b>\n\nTotal Registered Users: <b>${s.totalUsers}</b>\n\nPlease send the message you want to broadcast to all users.\n\nHTML is supported.\n\nSend /cancel to abort.`, {
      inline_keyboard: navButtons('admin:dashboard')
    });
    await logHistory('broadcast_prompt', 'tg');
  } else if (action === 'broadcast_cancel') {
    const { cancelBroadcast } = await import('../bot-users.js');
    cancelBroadcast();
    await answerCallbackQuery(cq.id, 'Broadcast cancellation requested.', true);
    return res.status(200).send('OK');
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
    const text = `<b>File Management</b>\n\nCreate permanent or temporary sharing links, store files, view leaderboard, or backup database:`;
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Create Batch'), callback_data: 'admin:batch_start' }, { text: toSmallCaps('Store Single'), callback_data: 'admin:store_start' }],
        [{ text: toSmallCaps('Create Temp Token'), callback_data: 'admin:temp_token_start' }, { text: toSmallCaps('Active Temp Tokens'), callback_data: 'admin:temp_tokens_list' }],
        [{ text: toSmallCaps('Top 10 Files'), callback_data: 'admin:top_files' }, { text: toSmallCaps('Database Backup'), callback_data: 'admin:backup_db' }],
        ...navButtons('admin:dashboard')
      ]
    });
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
    return res.status(200).send('OK');
  } else if (action === 'top_files') {
    const { getTopFiles } = await import('../filestore.js');
    const topList = await getTopFiles(10);
    const botUsername = await getBotUsername();

    if (!topList.length) {
      await editTelegramMessage(chatId, messageId, `<b>Traffic Leaderboard</b>\n\nNo file downloads recorded yet.`, {
        inline_keyboard: navButtons('admin:file_mgmt')
      });
      return res.status(200).send('OK');
    }

    let report = `<b>Top 10 Downloaded Files & Batches</b>\n\n`;
    for (let i = 0; i < topList.length; i++) {
      const item = topList[i];
      const link = `https://t.me/${botUsername}?start=${item._id}`;
      report += `<b>${i + 1}.</b> <code>${item._id}</code> (${item.type || 'file'})\n` +
                `   • Downloads: <b>${item.accessCount || 0}</b>\n` +
                `   • Link: ${link}\n\n`;
    }

    await editTelegramMessage(chatId, messageId, report, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
    return res.status(200).send('OK');
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
      return res.status(200).send('OK');
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
      return res.status(200).send('OK');
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
      return res.status(200).send('OK');
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
      return res.status(200).send('OK');
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
      return res.status(200).send('OK');
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
      return res.status(200).send('OK');
    }
    await answerCallbackQuery(cq.id);

    const dbChannelId = await getDbChannelId();
    const batchCode   = generateBatchCode();

    const totalCollected = batchSession.collectedIds.length;
    const finalIds = batchSession.collectedIds.slice(0, 500);
    await storeBatch(batchCode, dbChannelId, finalIds);
    await clearBatchSession(chatId);
    const botUsername = await getBotUsername();
    const shareLink   = `https://t.me/${botUsername}?start=${batchCode}`;

    let msgText = `<b>Batch Created!</b>\n\nFiles collected: <b>${totalCollected}</b>\nBatch code: <code>${batchCode}</code>\n\n<b>Share this link:</b>\n${shareLink}`;
    if (totalCollected > 500) {
      const dropped = totalCollected - 500;
      msgText += `\n\n<b>Warning:</b> Batches are limited to 500 files. <b>${dropped}</b> files were truncated (dropped) from the end of the batch.`;
    }

    await editTelegramMessage(chatId, messageId, msgText, {
      inline_keyboard: [
        [{ text: toSmallCaps('⏳ Generate Temp Link'), callback_data: `admin:temp_token_for:${batchCode}` }],
        ...navButtons('admin:dashboard')
      ]
    });
    return res.status(200).send('OK');
  } else if (action === 'cancel_session') {
    const { clearBatchSession, checkAndClearAdminWaiting } = await import('../filestore.js');
    await clearBatchSession(chatId);
    await checkAndClearAdminWaiting(chatId);
    await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
    await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });
    await sessions.deleteOne({ _id: `admin:waiting_premium_user:${chatId}` });

    await editTelegramMessage(chatId, messageId, `<b>Session cancelled.</b>`, {
      inline_keyboard: navButtons('admin:dashboard')
    });
  } else if (action === 'fs_settings') {
    const s = await getSettings();
    const dbChannel = s.dbChannelId || 'Not set';
    const text = `<b>Filestore Settings</b>\n\nConfigure your main bot settings using given categories below.\n\nDB Channel: <code>${esc(dbChannel)}</code>`;
    const buttons = [
      [{ text: toSmallCaps('START MSG'), callback_data: 'admin:fs_cfg:start' }, { text: toSmallCaps('FORCE SUB'), callback_data: 'admin:fs_cfg:fsub' }],
      [{ text: toSmallCaps('ACCESS TOKEN'), callback_data: 'admin:fs_cfg:tkn' }, { text: toSmallCaps('DB CHANNEL'), callback_data: 'admin:fs_set_db' }],
      ...navButtons('admin:dashboard')
    ];
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
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
    return res.status(200).send('OK');
  } else if (action === 'fs_set_stext') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'startText', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `📝 <b>Set Main Bot Start Text</b>\n\nYou can use HTML tags and placeholders:\n• <code>{mention}</code> : mention user\n• <code>{first_name}</code> : user first name\n• <code>{last_name}</code> : user last name\n\nPlease send the text now.`, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
  } else if (action === 'fs_set_sphoto') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'startPhoto', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🖼 <b>Set Main Bot Start Photo</b>\n\nPlease send or forward the photo you want to use.`, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
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
    return res.status(200).send('OK');
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
    return res.status(200).send('OK');
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
    if (!targetUserId) return answerCallbackQuery(cq.id, 'Session expired.');

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
  return res.status(200).send('OK');
}
