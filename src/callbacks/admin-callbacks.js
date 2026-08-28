import crypto from 'crypto';
import {
  getCollection, getSettings, updateSettings, toSmallCaps, editTelegramMessage, answerCallbackQuery, sendTelegramMessage, logHistory, deleteTelegramMessage, sendTelegramVideo, sendTelegramPhoto, esc
} from '../bot-common.js';
import {
  getBotUsername, getForceSubChannelsList, isBotAdmin, getDbChannelId
} from '../bot-helpers.js';

export async function handleAdminCallback(chatId, messageId, action, cq, req, res) {
  const requiresCustomToast = action.startsWith('fs_fsub_toggle:') ||
                              action.startsWith('fs_fsub_del_confirm:') ||
                              action.startsWith('fs_fsub_setmode:') ||
                              action.startsWith('fs_toggle:') ||
                              action.startsWith('fs_toggle_ref:') ||
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
    const mockUpdate = { callback_query: { ...cq, data: 'admin:fs_cfg:fsub' } };
    const { default: mainHandler } = await import('../routes/telegram.js');
    return mainHandler({ ...req, body: mockUpdate }, res);
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
    const mockUpdate = { callback_query: { ...cq, data: 'admin:fs_cfg:fsub' } };
    const { default: mainHandler } = await import('../routes/telegram.js');
    return mainHandler({ ...req, body: mockUpdate }, res);
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

  const navButtons = (backCb) => [
    [{ text: toSmallCaps('Back'), callback_data: backCb }, { text: toSmallCaps('Home'), callback_data: 'admin:dashboard' }]
  ];

  if (action === 'dashboard') {
    const text = `<b>Admin Dashboard</b>\n\nSelect a category to manage the bot:`;
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Statistics'), callback_data: 'admin:stats' }, { text: toSmallCaps('Broadcast'), callback_data: 'admin:broadcast_prompt' }],
        [{ text: toSmallCaps('User Control'), callback_data: 'admin:user_mgmt' }, { text: toSmallCaps('File Control'), callback_data: 'admin:file_mgmt' }],
        [{ text: toSmallCaps('Security & Auto Delete'), callback_data: 'admin:auto_del_mgmt' }, { text: toSmallCaps('Settings'), callback_data: 'admin:fs_settings' }],
        [{ text: toSmallCaps('Back to Main Menu'), callback_data: 'user:back_start' }],
      ]
    });
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
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: 'broadcast', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `<b>Broadcast Message</b>\n\nPlease send the message you want to broadcast to all users.\n\nHTML is supported.\n\nSend /cancel to abort.`, {
      inline_keyboard: navButtons('admin:dashboard')
    });
    await logHistory('broadcast_prompt', 'tg');
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
    const text = `<b>File Management</b>\n\nCreate sharing links or manage stored files:`;
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Create Batch'), callback_data: 'admin:batch_start' }, { text: toSmallCaps('Store Single'), callback_data: 'admin:store_start' }],
        [{ text: toSmallCaps('Run Weekly Cleanup (Sun-Mon)'), callback_data: 'admin:trigger_cleanup' }],
        ...navButtons('admin:dashboard')
      ]
    });
  } else if (action === 'trigger_cleanup') {
    const { runWeeklyCleanup } = await import('../filestore.js');
    const result = await runWeeklyCleanup();
    await editTelegramMessage(chatId, messageId, `<b>Weekly Cleanup Completed</b>\n\nDeleted records created between Sunday and Monday: <b>${result.deletedRecords}</b>`, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
  } else if (action === 'auto_del_mgmt') {
    const s = await getSettings();
    const autoDel = s.autoDeleteEnabled === '1';
    const timerSec = parseInt(s.autoDeleteTimer, 10) || 300;
    const timerLabel = timerSec < 60 ? `${timerSec}s` : timerSec < 3600 ? `${Math.round(timerSec / 60)} mins` : `${Math.round(timerSec / 3600)} hours`;
    const protect = s.protectContent === '1';

    const text = `<b>Security & Auto Delete Settings</b>\n\nAuto Delete: <b>${autoDel ? 'ON' : 'OFF'}</b>\nTimer: <b>${timerLabel}</b>\nContent Protection: <b>${protect ? 'ON' : 'OFF'}</b>`;

    const buttons = [
      [{ text: toSmallCaps(autoDel ? 'Disable Auto Delete' : 'Enable Auto Delete'), callback_data: `admin:toggle_autodel:${autoDel ? 0 : 1}` }],
      [{ text: toSmallCaps('1 Min'), callback_data: 'admin:set_timer:60' }, { text: toSmallCaps('5 Mins'), callback_data: 'admin:set_timer:300' }, { text: toSmallCaps('10 Mins'), callback_data: 'admin:set_timer:600' }],
      [{ text: toSmallCaps('30 Mins'), callback_data: 'admin:set_timer:1800' }, { text: toSmallCaps('1 Hour'), callback_data: 'admin:set_timer:3600' }, { text: toSmallCaps('24 Hours'), callback_data: 'admin:set_timer:86400' }],
      [{ text: toSmallCaps(protect ? 'Disable Content Protection' : 'Enable Content Protection'), callback_data: `admin:toggle_protect:${protect ? 0 : 1}` }],
      ...navButtons('admin:dashboard')
    ];
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
  } else if (action.startsWith('toggle_autodel:')) {
    const val = action.split(':')[1];
    await updateSettings({ autoDeleteEnabled: val });
    await answerCallbackQuery(cq.id, `Auto Delete ${val === '1' ? 'Enabled' : 'Disabled'}`);
    const mockUpdate = { callback_query: { ...cq, data: 'admin:auto_del_mgmt' } };
    const { default: mainHandler } = await import('../routes/telegram.js');
    return mainHandler({ ...req, body: mockUpdate }, res);
  } else if (action.startsWith('set_timer:')) {
    const sec = action.split(':')[1];
    await updateSettings({ autoDeleteTimer: sec });
    await answerCallbackQuery(cq.id, `Timer set!`);
    const mockUpdate = { callback_query: { ...cq, data: 'admin:auto_del_mgmt' } };
    const { default: mainHandler } = await import('../routes/telegram.js');
    return mainHandler({ ...req, body: mockUpdate }, res);
  } else if (action.startsWith('toggle_protect:')) {
    const val = action.split(':')[1];
    await updateSettings({ protectContent: val });
    await answerCallbackQuery(cq.id, `Content Protection ${val === '1' ? 'Enabled' : 'Disabled'}`);
    const mockUpdate = { callback_query: { ...cq, data: 'admin:auto_del_mgmt' } };
    const { default: mainHandler } = await import('../routes/telegram.js');
    return mainHandler({ ...req, body: mockUpdate }, res);
  } else if (action === 'batch_start') {
    const { setBatchSession } = await import('../filestore.js');
    await setBatchSession(chatId, { step: 'first', collectedIds: [] });
    await editTelegramMessage(chatId, messageId, `<b>Batch Mode</b>\n\nForward the first message or start sending files.\n\nSend /cancel to abort.`, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
  } else if (action === 'store_start') {
    const { setAdminWaitingForFile } = await import('../filestore.js');
    await setAdminWaitingForFile(chatId);
    await editTelegramMessage(chatId, messageId, `<b>Store Single File</b>\n\nPlease send the file (document, video, audio, or photo) you want to store.\n\nSend /cancel to abort.`, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
  } else if (action === 'batch_done') {
    const { getBatchSession, storeBatch, clearBatchSession } = await import('../filestore.js');
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
      inline_keyboard: navButtons('admin:dashboard')
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
    const parts = action.split(':');
    const cfgType = parts[1];
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
          { text: `• ${displayName}`, callback_data: `admin:fs_fsub_toggle:${i}` },
          { text: `✏️ Label`, callback_data: `admin:fs_fsub_setlbl:${i}` },
          { text: `❌`, callback_data: `admin:fs_fsub_del:${i}` }
        ]);
      }

      if (channels.length < 6) {
        buttons.push([{ text: `+ Add Channel`, callback_data: `admin:fs_fsub_add` }]);
      }

      buttons.push([{ text: `📥 Bulk Setup`, callback_data: `admin:fs_fsub_bulk` }]);

      buttons.push([
        { text: `🔍 Check Status`, callback_data: `admin:fs_fsub_status` },
        { text: `Message`, callback_data: `admin:fs_set_fsub_msg` }
      ]);
      buttons.push([{ text: `< back`, callback_data: `admin:fs_settings` }]);
    } else if (cfgType === 'tkn') {
      const enabled = s.enabled === '1';
      const refDisabled = s.referralDisabled === '1';
      text = `<b>Access Token (Shortener)</b>\n\nUsers need to pass a shortened link to gain special access to messages from all shareable links. This access will be valid for the next custom validity period.\n\nStatus: <b>${enabled ? 'ON' : 'OFF'}</b>\nReferrals: <b>${refDisabled ? 'DISABLED' : 'ENABLED'}</b>`;
      buttons = [
        [{ text: toSmallCaps('Shortener URL'), callback_data: 'admin:fs_set_url' }, { text: toSmallCaps('API Key'), callback_data: 'admin:fs_set_key' }],
        [{ text: toSmallCaps('Validity'), callback_data: 'admin:fs_set_ttl' }, { text: toSmallCaps('Tutorial'), callback_data: 'admin:fs_set_tut' }],
        [{ text: toSmallCaps(enabled ? 'Disable Token' : 'Enable Token'), callback_data: `admin:fs_toggle:${enabled ? 0 : 1}` }, { text: toSmallCaps(refDisabled ? 'Enable Ref' : 'Disable Ref'), callback_data: `admin:fs_toggle_ref:${refDisabled ? 0 : 1}` }],
        [{ text: toSmallCaps('BACK'), callback_data: 'admin:fs_settings' }]
      ];
    }
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
  } else if (action.startsWith('fs_toggle:')) {
    const val = action.split(':')[1];
    await updateSettings({ enabled: val });
    await logHistory(`verification_${val === '1' ? 'enabled' : 'disabled'}`, 'tg');
    await answerCallbackQuery(cq.id, `Token verification ${val === '1' ? 'enabled' : 'disabled'}.`);
    const mockUpdate = { callback_query: { ...cq, data: 'admin:fs_cfg:tkn' } };
    const { default: mainHandler } = await import('../routes/telegram.js');
    return mainHandler({ ...req, body: mockUpdate }, res);
  } else if (action.startsWith('fs_toggle_ref:')) {
    const val = action.split(':')[1];
    await updateSettings({ referralDisabled: val });
    await logHistory(`referrals_${val === '1' ? 'disabled' : 'enabled'}`, 'tg');
    await answerCallbackQuery(cq.id, `Referrals system ${val === '1' ? 'disabled' : 'enabled'}.`);
    const mockUpdate = { callback_query: { ...cq, data: 'admin:fs_cfg:tkn' } };
    const { default: mainHandler } = await import('../routes/telegram.js');
    return mainHandler({ ...req, body: mockUpdate }, res);
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
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
  } else if (action === 'fs_set_ttl') {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'validityHours', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `⏱ <b>Set Token Validity</b>\n\nSend the number of hours a token should remain valid.\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
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
    const mockUpdate = { callback_query: { ...cq, data: 'admin:fs_cfg:fsub' } };
    const { default: mainHandler } = await import('../routes/telegram.js');
    return mainHandler({ ...req, body: mockUpdate }, res);
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

function generateBatchCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `batch_${result}`;
}
