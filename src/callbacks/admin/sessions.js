import {
  getCollection, getSettings, toSmallCaps, editTelegramMessage,
  sendTelegramMessage, esc, sendTelegramFileBuffer
} from '../../bot-common.js';
import {
  getDbChannelId, getBackupDbChannelId, getDbChannelReadinessError, getBotUsername
} from '../../channel-helpers.js';
import { getUserStats, getBannedUsers, unbanUser } from '../../bot-users.js';
import {
  setBulkStoreActive, clearStoreSession, getStoreSession, generateRawLinksText,
  generateLinksExportText, setBatchSession, setAdminWaitingForFile, getBatchSession,
  storeBatch, clearBatchSession, generateBatchCode, setBundleSession, getBundleSession,
  storeBundle, generateBundleCode, clearBundleSession, sortQualities, checkAndClearAdminWaiting
} from '../../filestore.js';
import { getAdminHelpMessage } from '../../ui-builders.js';
import { getForceSubChannelsList } from '../../force-subscribe.js';
import { renderDashboard, navButtons } from './common.js';

export const sessionActions = {
  dashboard: async ({ chatId, messageId, sessions }) => {
    await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
    await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });
    await sessions.deleteOne({ _id: `admin:broadcast_draft:${chatId}` });
    await setBulkStoreActive(chatId, false);
    await clearStoreSession(chatId);
    await renderDashboard(chatId, messageId);
  },

  stats: async ({ chatId, messageId }) => {
    const s = await getUserStats();

    const users = await getCollection('users');
    const referralAggregation = await users.aggregate([
      { $group: { _id: null, total: { $sum: '$referralCount' } } }
    ]).toArray();
    const totalRefs = referralAggregation.length ? referralAggregation[0].total : 0;
    const activeUsers = Math.max(0, (s.totalUsers || 0) - (s.blockedCount || 0) - (s.bannedCount || 0));

    const text = `<b>Bot Statistics</b>\n\n` +
                 `• Total Users: <b>${s.totalUsers}</b>\n` +
                 `• Active Audience: <b>${activeUsers}</b>\n` +
                 `• Blocked / Dead: <b>${s.blockedCount || 0}</b>\n` +
                 `• Banned Users: <b>${s.bannedCount || 0}</b>\n` +
                 `• Total Links: <b>${s.filestoreLinks}</b>\n` +
                 `• Total Referrals: <b>${totalRefs}</b>`;
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: navButtons('admin:dashboard')
    });
  },

  user_mgmt: async ({ chatId, messageId }) => {
    const s = await getSettings();
    const tokenActive = s.enabled === '1';
    const fsub = s.forceSubscribeChannels || '';
    const globalMode = s.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(fsub, globalMode);

    const text = `👥 <b>Users & Access Control Hub</b>\n\n` +
      `Manage user moderation, VIP privileges, token gating, and force-subscribe channels:\n\n` +
      `• Access Token Shortener: <b>${tokenActive ? '🟢 Active' : '⚪ Disabled'}</b>\n` +
      `• Force Sub Channels: <b>${channels.length} configured</b>`;

    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('🚫 Ban User'), callback_data: 'admin:ban_prompt' }, { text: toSmallCaps('✅ Unban User'), callback_data: 'admin:unban_prompt' }],
        [{ text: toSmallCaps('📋 Banned List'), callback_data: 'admin:ban_list' }, { text: toSmallCaps('⭐ Grant Premium'), callback_data: 'admin:fs_premium_prompt' }],
        [{ text: toSmallCaps('🔐 Shortener / Token'), callback_data: 'admin:fs_cfg:tkn' }, { text: toSmallCaps('📢 Force Subscribe'), callback_data: 'admin:fs_cfg:fsub' }],
        ...navButtons('admin:dashboard')
      ]
    });
  },

  ban_prompt: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: 'ban', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `<b>Ban User</b>\n\nPlease send the <b>User ID or @username</b> you want to ban.\n\nOptional format: <code>&lt;id|@username&gt; [duration] [reason]</code> (e.g. <code>@spammer 24h spamming</code>)\n\nSend /cancel to abort.`, {
      inline_keyboard: navButtons('admin:user_mgmt')
    });
  },

  unban_prompt: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: 'unban', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `<b>Unban User</b>\n\nPlease send the <b>User ID or @username</b> you want to unban.\n\nSend /cancel to abort.`, {
      inline_keyboard: navButtons('admin:user_mgmt')
    });
  },

  ban_list: async ({ chatId, messageId }) => {
    const list = await getBannedUsers();
    const maxShow = 20;
    const displayList = list.slice(0, maxShow);
    const now = Date.now();

    let text = list.length ? `🚫 <b>Banned Users (${list.length}):</b>\n\n` : `No banned users.`;
    const unbanButtons = [];
    if (list.length > 0) {
      for (const u of displayList) {
        let expiryStr = 'Permanent';
        if (u.bannedUntil) {
          const remSec = Math.max(0, Math.round((new Date(u.bannedUntil).getTime() - now) / 1000));
          expiryStr = remSec < 60 ? `${remSec}s left` : remSec < 3600 ? `${Math.round(remSec / 60)}m left` : `${Math.round(remSec / 3600)}h left`;
        }
        text += `• <code>${u._id}</code> ${u.username ? `(@${esc(u.username)})` : ''}\n`;
        text += `  └ <i>${expiryStr}</i>${u.banReason ? ` • Reason: <code>${esc(u.banReason)}</code>` : ''}\n`;

        unbanButtons.push([{
          text: `🔓 Unban ${u.username ? '@' + u.username : u._id}`,
          callback_data: `admin:unban:${u._id}`
        }]);
      }
      if (list.length > maxShow) {
        text += `\n<i>...and ${list.length - maxShow} more banned users.</i>`;
      }
    }
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [...unbanButtons, ...navButtons('admin:user_mgmt')]
    });
  },

  'unban:': async ({ chatId, messageId, action, cq, safeAnswer }) => {
    const targetId = action.replace('unban:', '');
    await unbanUser(targetId);
    await safeAnswer(cq.id, `✅ User ${targetId} unbanned!`, true);

    const list = await getBannedUsers();
    const maxShow = 20;
    const displayList = list.slice(0, maxShow);
    const now = Date.now();

    let text = list.length ? `🚫 <b>Banned Users (${list.length}):</b>\n\n` : `No banned users.`;
    const unbanButtons = [];
    if (list.length > 0) {
      for (const u of displayList) {
        let expiryStr = 'Permanent';
        if (u.bannedUntil) {
          const remSec = Math.max(0, Math.round((new Date(u.bannedUntil).getTime() - now) / 1000));
          expiryStr = remSec < 60 ? `${remSec}s left` : remSec < 3600 ? `${Math.round(remSec / 60)}m left` : `${Math.round(remSec / 3600)}h left`;
        }
        text += `• <code>${u._id}</code> ${u.username ? `(@${esc(u.username)})` : ''}\n`;
        text += `  └ <i>${expiryStr}</i>${u.banReason ? ` • Reason: <code>${esc(u.banReason)}</code>` : ''}\n`;

        unbanButtons.push([{
          text: `🔓 Unban ${u.username ? '@' + u.username : u._id}`,
          callback_data: `admin:unban:${u._id}`
        }]);
      }
      if (list.length > maxShow) {
        text += `\n<i>...and ${list.length - maxShow} more banned users.</i>`;
      }
    }
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [...unbanButtons, ...navButtons('admin:user_mgmt')]
    });
  },

  file_mgmt: async ({ chatId, messageId }) => {
    const text = `📁 <b>Files & Storage Hub</b>\n\nCreate permanent or temporary sharing links, store files, analyze performance, or audit redundancy:`;
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('📦 Create Batch'), callback_data: 'admin:batch_start' }, { text: toSmallCaps('🎬 Quality Bundle'), callback_data: 'admin:bundle_start' }],
        [{ text: toSmallCaps('📥 Store Single'), callback_data: 'admin:store_start' }, { text: toSmallCaps('⚡ Bulk Store Mode'), callback_data: 'admin:bulk_store_start' }],
        [{ text: toSmallCaps('⏳ Temporary Tokens'), callback_data: 'admin:temp_token_start' }, { text: toSmallCaps('📋 Active Temp Tokens'), callback_data: 'admin:temp_tokens_list' }],
        [{ text: toSmallCaps('📊 Top 10 Files'), callback_data: 'admin:top_files' }, { text: toSmallCaps("📈 Today's Links"), callback_data: 'admin:today_links' }],
        [{ text: toSmallCaps('📤 Export Links Hub'), callback_data: 'admin:export_hub' }, { text: toSmallCaps('🛡️ Storage Audit'), callback_data: 'admin:storage_audit' }],
        [{ text: toSmallCaps('🧹 System Wipe / Cleanup'), callback_data: 'admin:wipe_sys_prompt' }],
        ...navButtons('admin:dashboard')
      ]
    });
  },

  bulk_store_start: async ({ chatId, messageId }) => {
    const dbError = await getDbChannelReadinessError();
    if (dbError) {
      await editTelegramMessage(chatId, messageId, dbError, { inline_keyboard: navButtons('admin:file_mgmt') });
      return;
    }

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
  },

  bulk_store_done: async ({ chatId, messageId, cq, safeAnswer }) => {
    const codes = await getStoreSession(chatId);
    if (!codes.length) {
      await safeAnswer(cq.id, 'No files stored in this session yet.', true);
      return;
    }

    await setBulkStoreActive(chatId, false);
    await clearStoreSession(chatId);
    await safeAnswer(cq.id);

    const botUsername = await getBotUsername();
    const filesColl = await getCollection('files');
    const storedRecords = await filesColl.find({ _id: { $in: codes } }).toArray();

    const rawBlock = generateRawLinksText(codes, botUsername);
    const txtContent = generateLinksExportText(storedRecords.length ? storedRecords : codes.map(c => ({ _id: c })), botUsername, 'Bulk Stored Files');
    const buffer = Buffer.from(txtContent, 'utf-8');
    const filename = `bulk_store_${codes.length}_links_${getISTDateString()}.txt`;

    await editTelegramMessage(chatId, messageId, `📋 <b>Bulk Store Complete! (${codes.length} Files Stored)</b>\n\nTap box to expand and copy all links:\n<blockquote expandable><pre>${rawBlock}</pre></blockquote>`, {
      inline_keyboard: [
        [{ text: toSmallCaps('Store More Files'), callback_data: 'admin:bulk_store_start' }],
        ...navButtons('admin:file_mgmt')
      ]
    });

    await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>Exported ${codes.length} Links (.txt)</b>`);
  },

  bulk_store_cancel: async ({ chatId, messageId, cq, safeAnswer }) => {
    await setBulkStoreActive(chatId, false);
    await clearStoreSession(chatId);
    await safeAnswer(cq.id, 'Bulk Store cancelled.');
    await editTelegramMessage(chatId, messageId, `<b>Bulk Store cancelled.</b>`, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
  },

  batch_start: async ({ chatId, messageId }) => {
    const dbError = await getDbChannelReadinessError();
    if (dbError) {
      await editTelegramMessage(chatId, messageId, dbError, { inline_keyboard: navButtons('admin:file_mgmt') });
      return;
    }

    await setBatchSession(chatId, { step: 'first', collectedIds: [] });
    await editTelegramMessage(chatId, messageId, `<b>Batch Mode</b>\n\nForward the first message or start sending files.\n\nSend /cancel to abort.`, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
  },

  store_start: async ({ chatId, messageId }) => {
    const dbError = await getDbChannelReadinessError();
    if (dbError) {
      await editTelegramMessage(chatId, messageId, dbError, { inline_keyboard: navButtons('admin:file_mgmt') });
      return;
    }

    await setAdminWaitingForFile(chatId);
    await editTelegramMessage(chatId, messageId, `<b>Store Single File</b>\n\nPlease send the file (document, video, audio, or photo) you want to store.\n\nSend /cancel to abort.`, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
  },

  batch_done: async ({ chatId, messageId, cq, safeAnswer, from }) => {
    const batchSession = await getBatchSession(chatId);
    if (!batchSession || !batchSession.collectedIds?.length) {
      await safeAnswer(cq.id, 'No files collected.');
      return;
    }
    await safeAnswer(cq.id);
    const totalCollected = batchSession.collectedIds.length;
    await editTelegramMessage(chatId, messageId, `⏳ <b>Finalizing Batch...</b>\n\nSaving <b>${totalCollected}</b> file(s) to storage...`).catch(() => {});

    const dbChannelId = await getDbChannelId();
    const batchCode   = generateBatchCode();

    const finalIds = batchSession.collectedIds.slice(0, 500);
    const backupDbChannelId = await getBackupDbChannelId();
    const finalBackupIds = Array.isArray(batchSession.backupCollectedIds) ? batchSession.backupCollectedIds.slice(0, 500) : [];
    await storeBatch(batchCode, dbChannelId, finalIds, { userId: chatId, username: from?.username, firstName: from?.first_name }, { backupDbChannelId, backupDbMessageIds: finalBackupIds });
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
  },

  bundle_start: async ({ chatId, messageId }) => {
    const dbError = await getDbChannelReadinessError();
    if (dbError) {
      await editTelegramMessage(chatId, messageId, dbError, { inline_keyboard: navButtons('admin:file_mgmt') });
      return;
    }

    await setBundleSession(chatId, { step: 'first', qualities: [], title: '', sessionMsgId: messageId });
    await editTelegramMessage(chatId, messageId, `🎛 <b>Create Multi-Quality Bundle</b>\n\nSend the <b>first message link</b> (or forward the first video):\nExample: <code>https://t.me/c/1234567890/101</code>\n\n<i>💡 You can also send both links together:</i>\n<code>https://t.me/c/.../101 https://t.me/c/.../104</code>\n\nSend /done when finished, or /cancel to abort.`, {
      inline_keyboard: [
        [{ text: toSmallCaps('Finish Bundle'), callback_data: 'admin:bundle_done' }],
        [{ text: toSmallCaps('Cancel'), callback_data: 'admin:cancel_session' }]
      ]
    });
  },

  bundle_done: async ({ chatId, messageId, cq, safeAnswer, from }) => {
    const bSession = await getBundleSession(chatId);
    if (!bSession || !bSession.qualities?.length) {
      await safeAnswer(cq.id, 'No files added to bundle yet.', true);
      return;
    }

    const dbChannelId = await getDbChannelId();
    const backupDbChannelId = await getBackupDbChannelId();
    const bundleCode = generateBundleCode();
    const title = bSession.title || bSession.qualities[0].fileName || 'Multi-Quality Release';
    const sortedQualities = sortQualities(bSession.qualities);

    await storeBundle(bundleCode, title, dbChannelId, sortedQualities, { userId: chatId, username: from?.username, firstName: from?.first_name }, { backupDbChannelId });
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
    await safeAnswer(cq.id);
  },

  cancel_session: async ({ chatId, messageId, sessions }) => {
    await clearBatchSession(chatId);
    await clearBundleSession(chatId);
    await checkAndClearAdminWaiting(chatId);
    await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
    await sessions.deleteOne({ _id: `admin:waiting_setting:${chatId}` });
    await sessions.deleteOne({ _id: `admin:waiting_premium_user:${chatId}` });

    await editTelegramMessage(chatId, messageId, `<b>Session cancelled.</b>`, {
      inline_keyboard: navButtons('admin:dashboard')
    });
  },

  admin_help: async ({ chatId, messageId }) => {
    const { text, replyMarkup } = getAdminHelpMessage();
    await editTelegramMessage(chatId, messageId, text, replyMarkup);
  }
};
