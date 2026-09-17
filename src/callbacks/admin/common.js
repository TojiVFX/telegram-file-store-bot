import { toSmallCaps, editTelegramMessage } from '../../bot-common.js';
import { getAdminDashboardKeyboard } from '../../ui-builders.js';

export const navButtons = (backCb) => [
  [{ text: toSmallCaps('Back'), callback_data: backCb }, { text: toSmallCaps('Home'), callback_data: 'admin:dashboard' }]
];

export async function renderDashboard(chatId, messageId) {
  const text = `<b>Admin Dashboard</b>\n\nSelect a category to manage the bot:`;
  await editTelegramMessage(chatId, messageId, text, getAdminDashboardKeyboard());
}

