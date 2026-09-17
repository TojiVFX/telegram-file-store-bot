import {
  toSmallCaps, editTelegramMessage, esc
} from '../../bot-common.js';
import { runWeeklyCleanup, deleteStoredRecord } from '../../filestore.js';
import { navButtons } from './common.js';

export const wipeCleanupActions = {
  trigger_cleanup: async ({ chatId, messageId }) => {
    const text = `⚠️ <b>CONFIRM SYSTEM WIPE & CLEANUP (Step 1/2)</b>\n\n` +
      `You are about to run a system-wide data purge.\n\n` +
      `This will permanently wipe:\n` +
      `• All expired temporary sharing tokens\n` +
      `• All expired session cache keys\n` +
      `• Old auto-delete message logs (> 7 days)\n` +
      `• Activity logs older than 30 days\n\n` +
      `<i>Active files, batches, user profiles, and valid access tokens will NOT be deleted.</i>\n\n` +
      `Are you sure you want to proceed?`;
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('🚨 Confirm & Wipe Expired Data'), callback_data: 'admin:wipe_sys_exec' }],
        [{ text: toSmallCaps('❌ Cancel'), callback_data: 'admin:dashboard' }]
      ]
    });
  },

  wipe_sys_prompt: async ({ chatId, messageId }) => {
    const text = `⚠️ <b>CONFIRM SYSTEM WIPE & CLEANUP (Step 1/2)</b>\n\n` +
      `You are about to run a system-wide data purge.\n\n` +
      `This will permanently wipe:\n` +
      `• All expired temporary sharing tokens\n` +
      `• All expired session cache keys\n` +
      `• Old auto-delete message logs (> 7 days)\n` +
      `• Activity logs older than 30 days\n\n` +
      `<i>Active files, batches, user profiles, and valid access tokens will NOT be deleted.</i>\n\n` +
      `Are you sure you want to proceed?`;
    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('🚨 Confirm & Wipe Expired Data'), callback_data: 'admin:wipe_sys_exec' }],
        [{ text: toSmallCaps('❌ Cancel'), callback_data: 'admin:dashboard' }]
      ]
    });
  },

  wipe_sys_exec: async ({ chatId, messageId }) => {
    const result = await runWeeklyCleanup();
    const cleanupText = `🧹 <b>System Cleanup Completed</b>\n\n` +
      `• Expired Temp Tokens Cleared: <b>${result.cleanedTokens}</b>\n` +
      `• Expired Sessions Cleared: <b>${result.cleanedSessions}</b>\n` +
      `• Old Auto-Delete Jobs Cleared: <b>${result.cleanedAutoDeletes}</b>\n` +
      `• 30-Day Activity Logs Cleared: <b>${result.cleanedLogs}</b>\n\n` +
      `<i>Total records purged: <b>${result.totalPurged}</b>. Active stored files remain untouched.</i>`;
    await editTelegramMessage(chatId, messageId, cleanupText, {
      inline_keyboard: navButtons('admin:dashboard')
    });
  },

  'wipe_rec_exec:': async ({ chatId, messageId, action }) => {
    const code = action.slice('wipe_rec_exec:'.length).trim();
    const delRes = await deleteStoredRecord(code);
    if (!delRes.ok) {
      await editTelegramMessage(chatId, messageId, `❌ Record <code>${esc(code)}</code> not found or could not be deleted.`, {
        inline_keyboard: navButtons('admin:file_mgmt')
      });
      return;
    }
    await editTelegramMessage(chatId, messageId, `🗑 <b>Record Wiped Successfully!</b>\n\n• Code: <code>${esc(delRes.code)}</code>\n• Type: <b>${delRes.type}</b>\n• Title: <b>${esc(delRes.title)}</b>\n\n<i>Database record and channel messages have been permanently purged.</i>`, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
  },

  wipe_rec_cancel: async ({ chatId, messageId }) => {
    await editTelegramMessage(chatId, messageId, `❌ <i>Record deletion cancelled. Stored files remain untouched.</i>`, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
  }
};
