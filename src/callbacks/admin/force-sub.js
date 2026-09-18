import {
  getSettings, updateSettings, toSmallCaps, editTelegramMessage,
  esc, logHistory
} from '../../bot-common.js';
import { getForceSubChannelsList, testAllForceSubChannels, getChannelHealth } from '../../force-subscribe.js';
import { isBotAdmin } from '../../channel-helpers.js';
import { getVerificationStats } from '../../filestore.js';

export async function renderFsCfg(chatId, messageId, cfgType) {
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

    text = `<b><u>Force Subscribe & Auto-Failover</u></b>\n\n` +
      `Configure mandatory channels and reserve backup channels.\n` +
      `🛡️ <b>Auto-Failover:</b> If a primary channel is banned or inaccessible, the bot automatically switches to your backup channel without locking users out!\n\n` +
      `• Primary (Required): <b>${channels.filter(c => c.role !== 'backup').length}</b>\n` +
      `• Reserve Backups: <b>${channels.filter(c => c.role === 'backup').length}</b>\n\n` +
      `<i>Tap a channel's Role button to switch between Primary and Backup.</i>`;

    buttons = [];
    for (let i = 0; i < channels.length; i++) {
      const chan = channels[i];
      const health = getChannelHealth(chan.id);
      let displayName = chan.title || 'Channel';
      if (displayName.startsWith('-100')) {
        displayName = 'Channel ' + displayName.replace('-100', '');
      }
      const roleBadge = chan.role === 'backup' ? '🛡️ [BACKUP]' : '🟢 [PRIMARY]';
      const healthBadge = health.isHealthy ? '' : ' ⚠️ (Degraded)';
      const modeLabel = chan.mode === 'join_request' ? 'Join Req' : 'Normal';

      buttons.push([
        { text: toSmallCaps(`${roleBadge} ${displayName}${healthBadge}`), callback_data: `admin:fs_fsub_toggle:${i}` }
      ]);
      buttons.push([
        { text: toSmallCaps(`Role: ${chan.role === 'backup' ? 'Backup' : 'Primary'}`), callback_data: `admin:fs_fsub_role:${i}` },
        { text: toSmallCaps(`Mode: ${modeLabel}`), callback_data: `admin:fs_fsub_toggle:${i}` },
        { text: toSmallCaps('Edit Label'), callback_data: `admin:fs_fsub_setlbl:${i}` },
        { text: toSmallCaps('Delete'), callback_data: `admin:fs_fsub_del:${i}` }
      ]);
    }

    if (channels.length < 6) {
      buttons.push([{ text: toSmallCaps('Add Channel'), callback_data: `admin:fs_fsub_add` }]);
    }

    buttons.push([{ text: toSmallCaps('Bulk Setup'), callback_data: `admin:fs_fsub_bulk` }]);

    buttons.push([
      { text: toSmallCaps('🧪 Test All Channels'), callback_data: `admin:fs_fsub_test_all` },
      { text: toSmallCaps('Custom Message'), callback_data: `admin:fs_set_fsub_msg` }
    ]);
    buttons.push([{ text: toSmallCaps('Back'), callback_data: 'admin:user_mgmt' }]);
  } else if (cfgType === 'tkn') {
    const enabled = s.enabled === '1';
    const refDisabled = s.referralDisabled === '1';
    const validityHours = (s.validityHours !== undefined && s.validityHours !== '') ? parseInt(s.validityHours, 10) : 24;
    const validityLabel = validityHours === 0 ? '0 Hours (Every File/Batch)' : `${validityHours} Hours`;
    const shortenerUrl = s.shortenerUrl ? esc(s.shortenerUrl) : 'Not set';
    const shortenerKey = s.shortenerKey ? esc(s.shortenerKey) : 'Not set';
    const backupUrl = s.backupShortenerUrl ? esc(s.backupShortenerUrl) : 'Not set';
    const backupKey = s.backupShortenerKey ? esc(s.backupShortenerKey) : 'Not set';
    const shortenerMode = s.shortenerMode || 'failover';
    const shortenerRatio = s.shortenerRatio !== undefined && s.shortenerRatio !== '' ? parseInt(s.shortenerRatio, 10) : 50;

    const vStats = await getVerificationStats();

    text = `<b>Access Token & Multi-Shortener</b>\n\n` +
      `Configure shorteners for gated link verification:\n\n` +
      `Status: <b>${enabled ? 'ON' : 'OFF'}</b>\n` +
      `Referrals: <b>${refDisabled ? 'DISABLED' : 'ENABLED'}</b>\n` +
      `Validity: <b>${validityLabel}</b>\n\n` +
      `⚖️ <b>Traffic Mode:</b> <b>${shortenerMode === 'split' ? `Traffic Split (${shortenerRatio}% Primary / ${100 - shortenerRatio}% Backup)` : 'Failover (Primary first, then Backup)'}</b>\n\n` +
      `• <b>Primary Shortener:</b>\nURL: <code>${shortenerUrl}</code>\nKey: <code>${shortenerKey}</code>\n\n` +
      `• <b>Backup Shortener:</b>\nURL: <code>${backupUrl}</code>\nKey: <code>${backupKey}</code>\n\n` +
      `📊 <b>Verification Analytics:</b>\n` +
      `• Links Minted: <b>${vStats.minted}</b>\n` +
      `• Verified: <b>${vStats.verified}</b>\n` +
      `• Conversion Rate: <b>${vStats.conversionRate}%</b>\n` +
      `• Drop-off: <b>${vStats.dropOff} (${vStats.dropOffRate}%)</b>`;

    buttons = [
      [{ text: toSmallCaps('Shortener URL'), callback_data: 'admin:fs_set_url' }, { text: toSmallCaps('API Key'), callback_data: 'admin:fs_set_key' }],
      [{ text: toSmallCaps('Backup URL'), callback_data: 'admin:fs_set_burl' }, { text: toSmallCaps('Backup Key'), callback_data: 'admin:fs_set_bkey' }],
      [
        { text: toSmallCaps(shortenerMode === 'split' ? 'Mode: Split' : 'Mode: Failover'), callback_data: 'admin:fs_toggle_smode' },
        { text: toSmallCaps(`Split Ratio (${shortenerRatio}%)`), callback_data: 'admin:fs_set_sratio' }
      ],
      [{ text: toSmallCaps('Validity'), callback_data: 'admin:fs_set_ttl' }, { text: toSmallCaps('Tutorial'), callback_data: 'admin:fs_set_tut' }],
      [{ text: toSmallCaps(enabled ? 'Disable Token' : 'Enable Token'), callback_data: `admin:fs_toggle:${enabled ? 0 : 1}` }, { text: toSmallCaps(refDisabled ? 'Enable Ref' : 'Disable Ref'), callback_data: `admin:fs_toggle_ref:${refDisabled ? 0 : 1}` }],
      [{ text: toSmallCaps('Back'), callback_data: 'admin:user_mgmt' }]
    ];
  }
  await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
}

export const forceSubActions = {
  fs_fsub_add: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'fs_fsub_msg_forward', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `Forward a message from your force sub channel, or send the channel ID directly (e.g. <code>-100123456789</code>).\n\nMake sure your bot is admin in that channel.`, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
  },
  fs_fsub_bulk: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'fs_fsub_bulk_import', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    const instruction = `📥 <b>Bulk Setup Force Subscribe</b>\n\nSend a list of channel IDs to configure multiple channels at once.\n\n<b>Format:</b>\n<code>channel_id:mode:button_label:title</code>\n(Each on a new line. Only <code>channel_id</code> is required.)\n\n<b>Example:</b>\n<code>-100123456789</code>\n<code>-100987654321:join_request:Join Pro:Pro Group</code>\n\nSend /cancel to abort.`;
    await editTelegramMessage(chatId, messageId, instruction, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
  },
  fs_fsub_status: async ({ chatId, messageId, safeAnswer, cq }) => {
    const s = await getSettings();
    const fsub = s.forceSubscribeChannels || '';
    const globalMode = s.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(fsub, globalMode);

    if (channels.length === 0) {
       await safeAnswer(cq.id, 'No Force Subscribe channels configured.', true);
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
      inline_keyboard: [[{ text: toSmallCaps('Back'), callback_data: 'admin:fs_cfg:fsub' }]]
    });
  },
  'fs_fsub_toggle:': async ({ chatId, messageId, action, safeAnswer, cq }) => {
    const index = parseInt(action.split(':')[1], 10);
    const s = await getSettings();
    const fsub = s.forceSubscribeChannels || '';
    const globalMode = s.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(fsub, globalMode);
    if (channels[index]) {
      channels[index].mode = channels[index].mode === 'join_request' ? 'normal' : 'join_request';
      await updateSettings({ forceSubscribeChannels: JSON.stringify(channels) });
      await safeAnswer(cq.id, `Mode toggled to ${channels[index].mode === 'join_request' ? 'Join Request' : 'Normal'} Mode!`);
    }
    await renderFsCfg(chatId, messageId, 'fsub');
  },
  'fs_fsub_role:': async ({ chatId, messageId, action, safeAnswer, cq }) => {
    const index = parseInt(action.split(':')[1], 10);
    const s = await getSettings();
    const fsub = s.forceSubscribeChannels || '';
    const globalMode = s.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(fsub, globalMode);
    if (channels[index]) {
      channels[index].role = channels[index].role === 'backup' ? 'primary' : 'backup';
      await updateSettings({ forceSubscribeChannels: JSON.stringify(channels) });
      await safeAnswer(cq.id, `Role changed to ${channels[index].role.toUpperCase()}!`);
    }
    await renderFsCfg(chatId, messageId, 'fsub');
  },
  fs_fsub_test_all: async ({ chatId, messageId }) => {
    await editTelegramMessage(chatId, messageId, `⏳ <b>Testing all channels & invite link creation...</b>\n\nPlease wait a moment.`);
    const report = await testAllForceSubChannels();
    let text = `🧪 <b>Force-Sub Channel Diagnostics & Failover Status</b>\n\n`;
    if (!report.channels.length) {
      text += `<i>No force subscribe channels configured.</i>`;
    } else {
      for (const c of report.channels) {
        const icon = c.isHealthy ? '🟢' : '🔴';
        const role = c.role === 'backup' ? '[BACKUP]' : '[PRIMARY]';
        text += `• ${icon} <b>${esc(c.title)}</b> ${role}\n` +
          `  ID: <code>${c.id}</code>\n` +
          `  Mode: <code>${c.mode}</code>\n` +
          `  Status: <b>${c.isHealthy ? 'Healthy (Invite Link Active)' : `Degraded (${esc(c.error)})`}</b>\n\n`;
      }
      if (report.allHealthy) {
        text += `✅ <b>All channels are fully operational with active bot admin rights!</b>`;
      } else {
        text += `⚠️ <b>One or more channels are degraded!</b> Auto-failover will route users to backup channels or bypass broken channels to keep your bot accessible.`;
      }
    }
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('🔄 Re-Test Channels'), callback_data: 'admin:fs_fsub_test_all' }],
        [{ text: toSmallCaps('Back to Force Sub'), callback_data: 'admin:fs_cfg:fsub' }]
      ]
    });
  },
  'fs_fsub_del:': async ({ chatId, messageId, action, safeAnswer, cq }) => {
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
    await safeAnswer(cq.id, "Channel not found.", true);
  },
  'fs_fsub_del_confirm:': async ({ chatId, messageId, action, safeAnswer, cq }) => {
    const index = parseInt(action.split(':')[1], 10);
    const s = await getSettings();
    const fsub = s.forceSubscribeChannels || '';
    const globalMode = s.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(fsub, globalMode);
    if (channels[index]) {
      const removed = channels.splice(index, 1)[0];
      const newValue = channels.length > 0 ? JSON.stringify(channels) : '';
      await updateSettings({ forceSubscribeChannels: newValue });
      await safeAnswer(cq.id, `Removed ${removed.title}!`);
    }
    await renderFsCfg(chatId, messageId, 'fsub');
  },
  'fs_fsub_setlbl:': async ({ chatId, messageId, action, sessions }) => {
    const index = parseInt(action.split(':')[1], 10);
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: `fs_fsub_lbl_${index}`, expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `📝 <b>Set Custom Button Label</b>\n\nSend the custom label for this channel's invite button (e.g., "Join Main Group").\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
  },
  'fs_fsub_setmode:': async ({ chatId, messageId, action, safeAnswer, cq, sessions }) => {
    const selectedMode = action.split(':')[1];
    const pendingRaw = await sessions.findOne({ _id: `admin:fsub_pending_add:${chatId}` });
    if (!pendingRaw || pendingRaw.expiresAt < new Date()) {
      await safeAnswer(cq.id, 'Session expired. Please add the channel again.', true);
      await renderFsCfg(chatId, messageId, 'fsub');
      return;
    }

    const { cid, title } = pendingRaw.val;
    const s = await getSettings();
    const fsub = s.forceSubscribeChannels || '';
    const globalMode = s.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(fsub, globalMode);

    channels.push({
      id: cid,
      title: title || cid,
      mode: selectedMode || 'normal'
    });

    await updateSettings({ forceSubscribeChannels: JSON.stringify(channels) });
    await sessions.deleteOne({ _id: `admin:fsub_pending_add:${chatId}` });

    await safeAnswer(cq.id, `Added ${title || cid}!`);
    await renderFsCfg(chatId, messageId, 'fsub');
  },
  'fs_cfg:': async ({ chatId, messageId, action }) => {
    const cfgType = action.split(':')[1];
    await renderFsCfg(chatId, messageId, cfgType);
  },
  'fs_toggle:': async ({ chatId, messageId, action, safeAnswer, cq }) => {
    const val = action.split(':')[1];
    await updateSettings({ enabled: val });
    await logHistory(`verification_${val === '1' ? 'enabled' : 'disabled'}`, 'tg');
    await safeAnswer(cq.id, `Token verification ${val === '1' ? 'enabled' : 'disabled'}.`);
    await renderFsCfg(chatId, messageId, 'tkn');
  },
  'fs_toggle_ref:': async ({ chatId, messageId, action, safeAnswer, cq }) => {
    const val = action.split(':')[1];
    await updateSettings({ referralDisabled: val });
    await logHistory(`referrals_${val === '1' ? 'disabled' : 'enabled'}`, 'tg');
    await safeAnswer(cq.id, `Referrals system ${val === '1' ? 'disabled' : 'enabled'}.`);
    await renderFsCfg(chatId, messageId, 'tkn');
  },
  fs_toggle_smode: async ({ chatId, messageId, safeAnswer, cq }) => {
    const s = await getSettings();
    const currentMode = s?.shortenerMode || 'failover';
    const newMode = currentMode === 'split' ? 'failover' : 'split';
    await updateSettings({ shortenerMode: newMode });
    await safeAnswer(cq.id, `Traffic mode set to ${newMode.toUpperCase()}`);
    await renderFsCfg(chatId, messageId, 'tkn');
  },
  fs_set_sratio: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'shortenerRatio', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `⚖️ <b>Set Traffic Split Ratio</b>\n\nEnter the percentage of traffic to route to your <b>Primary Shortener</b> (1 to 99).\n\nFor example, send <code>50</code> for a 50/50 split, or <code>70</code> for 70% Primary / 30% Backup.\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  },
  fs_set_db: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'dbChannelId', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🗄 <b>Set Database Channel ID</b>\n\nPlease send the Channel ID for your storage.\nExample: <code>-100123456789</code>\n\nMake sure the bot is an <b>administrator</b> in this channel with 'Post Messages' permission.`, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
  },
  fs_set_url: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'shortenerUrl', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🔗 <b>Set Shortener URL</b>\n\nSend the base API URL for your shortener.\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
  },
  fs_set_key: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'shortenerKey', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🔑 <b>Set Shortener API Key</b>\n\nSend your API key for the shortener.\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  },
  fs_set_burl: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'backupShortenerUrl', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🔗 <b>Set Backup Shortener URL</b>\n\nSend the base API URL for your backup shortener (e.g. <code>https://shrinkme.io/api</code>).\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  },
  fs_set_bkey: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'backupShortenerKey', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🔑 <b>Set Backup Shortener API Key</b>\n\nSend your API key for the backup shortener.\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  },
  fs_set_ttl: async ({ chatId, messageId }) => {
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
  },
  'fs_set_ttl_val:': async ({ chatId, messageId, action, safeAnswer, cq }) => {
    const hours = parseInt(action.split(':')[1], 10);
    if (!isNaN(hours) && hours >= 0 && hours <= 24) {
      await updateSettings({ validityHours: String(hours) });
      const label = hours === 0 ? 'Every File/Batch (0h)' : `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
      await safeAnswer(cq.id, `Validity updated to ${label}!`);
    } else {
      await safeAnswer(cq.id, `Invalid hours selection.`, true);
    }
    await renderFsCfg(chatId, messageId, 'tkn');
  },
  fs_set_stext: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'startText', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `📝 <b>Set Main Bot Start Text</b>\n\nYou can use HTML tags and placeholders:\n• <code>{mention}</code> : Clickable user mention link\n• <code>{first_name}</code> : User first name\n• <code>{last_name}</code> : User last name\n• <code>{full_name}</code> : User full name\n• <code>{username}</code> : @username handle\n• <code>{id}</code> : User Telegram ID\n\nPlease send the text now.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  },
  fs_set_sphoto: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'startPhoto', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🖼 <b>Set Main Bot Start Photo</b>\n\nPlease send or forward the photo you want to use.`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]]
    });
  },
  fs_del_sphoto: async ({ chatId, messageId, safeAnswer, cq }) => {
    await updateSettings({ startPhoto: null });
    await safeAnswer(cq.id, 'Start photo removed.');
    await renderFsCfg(chatId, messageId, 'start');
  },
  fs_set_tut: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'tutorialFileId', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `🎬 <b>Set Tutorial Video</b>\n\nSend or forward the <b>video file</b> you want to use as a tutorial.\n\nSend /cancel to abort.`, {
      inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]]
    });
  },
  fs_noop: async ({ safeAnswer, cq }) => {
    await safeAnswer(cq.id);
  },
  fs_set_fsub: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'forceSubscribeChannels', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId,
      `📢 <b>Set Force Subscribe Channels</b>\n\nSend a comma-separated list of channel IDs.\nExample: <code>-100123456789,-100987654321</code>\n\nSend /cancel to abort.`,
      { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]] });
  },
  fs_set_fsub_msg: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_setting:${chatId}` },
      { $set: { val: 'forceSubscribeMsg', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId,
      `📝 <b>Set Force Subscribe Message</b>\n\nSend the HTML message shown to users who haven't joined.\n\nSend /cancel to abort.`,
      { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'admin:cancel_session' }]] });
  },
  fs_set_fsmode: async ({ chatId, messageId, safeAnswer, cq }) => {
    const s = await getSettings();
    const newMode = s.forceSubscribeMode === 'join_request' ? 'normal' : 'join_request';
    await updateSettings({ forceSubscribeMode: newMode });
    await safeAnswer(cq.id, `Mode set to ${newMode}.`);
    await renderFsCfg(chatId, messageId, 'fsub');
  }
};
