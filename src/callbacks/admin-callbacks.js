import { getCollection, answerCallbackQuery } from '../bot-common.js';
import { bannerActions, renderBannersMgmt } from './admin/banners.js';
import { ghostFleetActions, renderGhostFleetMgmt } from './admin/ghost-fleet.js';
import { storageAuditActions, renderStorageAudit } from './admin/storage-audit.js';
import { forceSubActions, renderFsCfg } from './admin/force-sub.js';
import { broadcastActions } from './admin/broadcast.js';
import { wipeCleanupActions } from './admin/wipe-cleanup.js';
import { settingsSecurityActions, renderSecHub, renderAutoDelMgmt, renderSponsorMgmt } from './admin/settings-security.js';
import { exportsTokensActions } from './admin/exports-tokens.js';
import { sessionActions } from './admin/sessions.js';
import { renderDashboard, navButtons } from './admin/common.js';

export {
  renderDashboard,
  renderSecHub,
  renderAutoDelMgmt,
  renderGhostFleetMgmt,
  renderBannersMgmt,
  renderSponsorMgmt,
  renderFsCfg,
  renderStorageAudit,
  navButtons,
  actionMap
};

const actionMap = {
  ...bannerActions,
  ...ghostFleetActions,
  ...storageAuditActions,
  ...forceSubActions,
  ...broadcastActions,
  ...wipeCleanupActions,
  ...settingsSecurityActions,
  ...exportsTokensActions,
  ...sessionActions,
};

export async function handleAdminCallback(chatId, messageId, action, cq) {
  const { from } = cq || {};

  let answered = false;
  const safeAnswer = async (...args) => {
    if (answered || !cq?.id) return;
    answered = true;
    if (args[0] === cq.id) {
      return answerCallbackQuery(...args);
    }
    return answerCallbackQuery(cq.id, ...args);
  };

  try {
    const sessions = await getCollection('sessions');
    const ctx = { chatId, messageId, action, cq, safeAnswer, sessions, from };

    // 1. Direct exact match
    if (typeof actionMap[action] === 'function') {
      await actionMap[action](ctx);
      return;
    }

    // 2. Prefix match for parameterized actions (e.g. 'unban:', 'set_timer:')
    for (const [key, handler] of Object.entries(actionMap)) {
      if (key.endsWith(':') && action.startsWith(key)) {
        await handler(ctx);
        return;
      }
    }
  } finally {
    if (!answered && cq?.id) {
      answerCallbackQuery(cq.id).catch(() => {});
    }
  }
}
