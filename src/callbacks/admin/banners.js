import {
  getSettings, updateSettings, toSmallCaps, editTelegramMessage, esc
} from '../../bot-common.js';
import { navButtons } from './common.js';

export async function renderBannersMgmt(chatId, messageId) {
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

export const bannerActions = {
  banners_mgmt: async ({ chatId, messageId }) => {
    await renderBannersMgmt(chatId, messageId);
  },
  'set_banner:': async ({ chatId, messageId, action, sessions }) => {
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
  },
  'del_banner:': async ({ chatId, messageId, action, safeAnswer, cq }) => {
    const bannerKey = action.split(':')[1];
    await updateSettings({ [bannerKey]: null });
    await safeAnswer(cq.id, 'Banner removed.');
    await renderBannersMgmt(chatId, messageId);
  }
};
