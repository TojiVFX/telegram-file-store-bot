import {
  toSmallCaps, editTelegramMessage, sendTelegramMessage, logHistory, log, copyMessage
} from '../../bot-common.js';
import { getUserStats, cancelBroadcast, broadcastWithProgress } from '../../bot-users.js';
import { renderDashboard } from './common.js';

export const broadcastActions = {
  broadcast_prompt: async ({ chatId, messageId, sessions }) => {
    const s = await getUserStats();
    const activeUsers = Math.max(0, (s.totalUsers || 0) - (s.blockedCount || 0) - (s.bannedCount || 0));
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: 'broadcast', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `<b>Broadcast Message</b>\n\nTotal Registered Users: <b>${s.totalUsers}</b> (Active Audience: <b>${activeUsers}</b>)\n\nPlease send or forward any message you want to broadcast to all users.\n\nSupports: text, photos, videos, documents, audio, animations, stickers, forwarded channel posts, inline buttons, and web link previews.\n\nSend /cancel to abort.`, {
      inline_keyboard: [
        [{ text: toSmallCaps('Back to Dashboard'), callback_data: 'admin:broadcast_cancel_prompt' }]
      ]
    });
    await logHistory('broadcast_prompt', 'tg');
  },

  broadcast_cancel_prompt: async ({ chatId, messageId, sessions }) => {
    await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
    await sessions.deleteOne({ _id: `admin:broadcast_draft:${chatId}` });
    await renderDashboard(chatId, messageId);
  },

  broadcast_cancel_draft: async ({ chatId, messageId, sessions }) => {
    await sessions.deleteOne({ _id: `admin:waiting_action:${chatId}` });
    await sessions.deleteOne({ _id: `admin:broadcast_draft:${chatId}` });
    await renderDashboard(chatId, messageId);
  },

  broadcast_cancel: async ({ cq, safeAnswer, action }) => {
    const parts = (action || '').split(':');
    const targetJobId = parts.length > 1 ? parts.slice(1).join(':') : null;
    await cancelBroadcast(targetJobId || null);
    await safeAnswer(cq.id, 'Broadcast cancellation requested.', true);
  },
  'broadcast_cancel:': async ({ cq, safeAnswer, action }) => {
    const parts = (action || '').split(':');
    const targetJobId = parts.length > 1 ? parts.slice(1).join(':') : null;
    await cancelBroadcast(targetJobId || null);
    await safeAnswer(cq.id, 'Broadcast cancellation requested.', true);
  },

  broadcast_test: async ({ chatId, cq, safeAnswer, sessions }) => {
    const draftDoc = await sessions.findOne({ _id: `admin:broadcast_draft:${chatId}` });
    if (!draftDoc) {
      await safeAnswer(cq.id, 'Draft expired or not found.', true);
      return;
    }

    if (draftDoc.fromChatId && draftDoc.messageId) {
      const copyRes = await copyMessage(chatId, draftDoc.fromChatId, draftDoc.messageId, false, draftDoc.replyMarkup);
      if (copyRes?.ok) {
        await safeAnswer(cq.id, 'Preview message sent below!');
      } else {
        await safeAnswer(cq.id, `Preview failed: ${copyRes?.reason || 'unknown'}`, true);
      }
    } else if (draftDoc.text || draftDoc.captionOrText) {
      await sendTelegramMessage(chatId, draftDoc.text || draftDoc.captionOrText, draftDoc.replyMarkup, false, 2, false);
      await safeAnswer(cq.id, 'Preview message sent below!');
    }
  },

  broadcast_confirm: async ({ chatId, messageId, cq, safeAnswer, sessions }) => {
    const draftDoc = await sessions.findOne({ _id: `admin:broadcast_draft:${chatId}` });
    if (!draftDoc) {
      await safeAnswer(cq.id, 'Draft expired or not found.', true);
      return;
    }

    const s = await getUserStats();
    const mediaType = draftDoc.mediaType || 'Text';

    const confirmCard = `⚠️ <b>FINAL CONFIRMATION: MASS BROADCAST (Step 2/2)</b>\n\n` +
      `You are about to broadcast this message to all <b>${s.totalUsers}</b> registered users!\n\n` +
      `• <b>Audience:</b> <b>${s.totalUsers} Active Users</b>\n` +
      `• <b>Delivery Mode:</b> <b>Normal Delivery</b>\n` +
      `• <b>Message Type:</b> <b>${mediaType}</b>\n\n` +
      `🚨 <b>CRITICAL WARNING:</b>\n` +
      `<i>Once initiated, this broadcast will be pushed immediately into the delivery queue and cannot be stopped once started. Make sure your message content, formatting, and buttons are 100% correct!</i>\n\n` +
      `Are you absolutely sure you want to proceed?`;

    await editTelegramMessage(chatId, messageId, confirmCard, {
      inline_keyboard: [
        [{ text: toSmallCaps('🚨 YES, BROADCAST TO ALL NOW'), callback_data: 'admin:broadcast_final_exec' }],
        [{ text: toSmallCaps('◀️ Back to Preview'), callback_data: 'admin:broadcast_back_to_draft' }],
        [{ text: toSmallCaps('❌ Cancel Broadcast'), callback_data: 'admin:broadcast_cancel_draft' }]
      ]
    });
  },

  broadcast_confirm_pin: async ({ chatId, messageId, cq, safeAnswer, sessions }) => {
    const draftDoc = await sessions.findOne({ _id: `admin:broadcast_draft:${chatId}` });
    if (!draftDoc) {
      await safeAnswer(cq.id, 'Draft expired or not found.', true);
      return;
    }

    const s = await getUserStats();
    const mediaType = draftDoc.mediaType || 'Text';

    const confirmCard = `⚠️ <b>FINAL CONFIRMATION: MASS BROADCAST (Step 2/2)</b>\n\n` +
      `You are about to broadcast this message to all <b>${s.totalUsers}</b> registered users!\n\n` +
      `• <b>Audience:</b> <b>${s.totalUsers} Active Users</b>\n` +
      `• <b>Delivery Mode:</b> <b>📌 Send & Pin to All Users</b>\n` +
      `• <b>Message Type:</b> <b>${mediaType}</b>\n\n` +
      `🚨 <b>CRITICAL WARNING:</b>\n` +
      `<i>Once initiated, this broadcast will be pushed immediately into the delivery queue and cannot be stopped once started. Make sure your message content, formatting, and buttons are 100% correct!</i>\n\n` +
      `Are you absolutely sure you want to proceed?`;

    await editTelegramMessage(chatId, messageId, confirmCard, {
      inline_keyboard: [
        [{ text: toSmallCaps('🚨 YES, SEND & PIN TO ALL'), callback_data: 'admin:broadcast_final_pin' }],
        [{ text: toSmallCaps('◀️ Back to Preview'), callback_data: 'admin:broadcast_back_to_draft' }],
        [{ text: toSmallCaps('❌ Cancel Broadcast'), callback_data: 'admin:broadcast_cancel_draft' }]
      ]
    });
  },

  broadcast_back_to_draft: async ({ chatId, messageId, cq, safeAnswer, sessions }) => {
    const draftDoc = await sessions.findOne({ _id: `admin:broadcast_draft:${chatId}` });
    if (!draftDoc) {
      await safeAnswer(cq.id, 'Draft expired or not found.', true);
      return;
    }
    const s = await getUserStats();
    const mediaType = draftDoc.mediaType || 'Text';
    const isForward = !draftDoc.isForward;
    const hasButtons = !draftDoc.hasButtons;
    const captionOrText = draftDoc.captionOrText || draftDoc.text || '';

    const previewCard = `📢 <b>Broadcast Preview</b>\n\n` +
      `• <b>Target Audience:</b> <b>${s.totalUsers}</b> registered users\n` +
      `• <b>Type:</b> <b>${mediaType}${isForward ? ' (Forwarded)' : ''}</b>\n` +
      `• <b>Inline Buttons:</b> <b>${hasButtons ? 'Yes (Preserved)' : 'None'}</b>\n` +
      `• <b>Open Graph:</b> <b>Allowed</b>\n\n` +
      (captionOrText ? `<b>Content:</b>\n────────────────────\n${captionOrText.slice(0, 300)}${captionOrText.length > 300 ? '...' : ''}\n────────────────────\n\n` : '') +
      `You can send a test preview to your private chat first to check formatting before delivering to all users.`;

    await editTelegramMessage(chatId, messageId, previewCard, {
      inline_keyboard: [
        [{ text: toSmallCaps('Send Test Preview to Me'), callback_data: 'admin:broadcast_test' }],
        [
          { text: toSmallCaps('Confirm & Send to All'), callback_data: 'admin:broadcast_confirm' },
          { text: toSmallCaps('📌 Send & Pin to All'), callback_data: 'admin:broadcast_confirm_pin' }
        ],
        [{ text: toSmallCaps('Cancel'), callback_data: 'admin:broadcast_cancel_draft' }]
      ]
    });
  },

  broadcast_final_exec: async ({ chatId, messageId, cq, safeAnswer, sessions }) => {
    const draftDoc = await sessions.findOne({ _id: `admin:broadcast_draft:${chatId}` });
    if (!draftDoc) {
      await safeAnswer(cq.id, 'Draft expired or not found.', true);
      return;
    }

    const { fromChatId, messageId: srcMsgId, replyMarkup, captionOrText, text: legacyText } = draftDoc;
    await sessions.deleteOne({ _id: `admin:broadcast_draft:${chatId}` });

    const s = await getUserStats();
    await editTelegramMessage(chatId, messageId, `<b>Starting Broadcast...</b>\n\nTotal Users: <b>${s.totalUsers}</b>\n<i>Initializing queue...</i>`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel Broadcast'), callback_data: 'admin:broadcast_cancel' }]]
    });
    broadcastWithProgress({
      text: captionOrText || legacyText,
      fromChatId,
      messageId: srcMsgId,
      replyMarkup,
      adminChatId: chatId,
      statusMsgId: messageId,
      pin: false
    }).then(r => {
      logHistory(`broadcast_tg: ${r.sent}/${r.total} users`, 'tg').catch(() => {});
    }).catch(err => {
      log('error', 'broadcastWithProgress error', { errorMessage: err.message });
    });
  },

  broadcast_final_pin: async ({ chatId, messageId, cq, safeAnswer, sessions }) => {
    const draftDoc = await sessions.findOne({ _id: `admin:broadcast_draft:${chatId}` });
    if (!draftDoc) {
      await safeAnswer(cq.id, 'Draft expired or not found.', true);
      return;
    }

    const { fromChatId, messageId: srcMsgId, replyMarkup, captionOrText, text: legacyText } = draftDoc;
    await sessions.deleteOne({ _id: `admin:broadcast_draft:${chatId}` });

    const s = await getUserStats();
    await editTelegramMessage(chatId, messageId, `<b>Starting Broadcast...</b>\n\nTotal Users: <b>${s.totalUsers}</b>\n📌 <i>Messages will be pinned for each user.</i>\n<i>Initializing queue...</i>`, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel Broadcast'), callback_data: 'admin:broadcast_cancel' }]]
    });
    broadcastWithProgress({
      text: captionOrText || legacyText,
      fromChatId,
      messageId: srcMsgId,
      replyMarkup,
      adminChatId: chatId,
      statusMsgId: messageId,
      pin: true
    }).then(r => {
      logHistory(`broadcast_tg: ${r.sent}/${r.total} users (pinned)`, 'tg').catch(() => {});
    }).catch(err => {
      log('error', 'broadcastWithProgress error', { errorMessage: err.message });
    });
  }
};
