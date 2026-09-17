import test from 'node:test';
import assert from 'node:assert/strict';

import * as botHelpers from '../src/bot-helpers.js';
import * as channelHelpers from '../src/channel-helpers.js';
import * as forceSubscribe from '../src/force-subscribe.js';
import * as uiBuilders from '../src/ui-builders.js';
import * as delivery from '../src/delivery.js';
import * as diagnostics from '../src/diagnostics.js';
import * as backup from '../src/backup.js';

import * as adminCallbacks from '../src/callbacks/admin-callbacks.js';
import * as bannersModule from '../src/callbacks/admin/banners.js';
import * as ghostFleetModule from '../src/callbacks/admin/ghost-fleet.js';
import * as storageAuditModule from '../src/callbacks/admin/storage-audit.js';
import * as forceSubModule from '../src/callbacks/admin/force-sub.js';
import * as broadcastModule from '../src/callbacks/admin/broadcast.js';
import * as wipeCleanupModule from '../src/callbacks/admin/wipe-cleanup.js';
import * as settingsSecModule from '../src/callbacks/admin/settings-security.js';
import * as exportsTokensModule from '../src/callbacks/admin/exports-tokens.js';
import * as sessionsModule from '../src/callbacks/admin/sessions.js';
import * as commonModule from '../src/callbacks/admin/common.js';

test('Issue 1: bot-helpers.js facade and split module integrity', async (t) => {
  await t.test('channel-helpers functions are exported directly and via facade', () => {
    const channelFns = ['getDbChannelId', 'getBackupDbChannelId', 'isBotAdmin', 'getChannelDisplayDetails', 'getDbChannelReadinessError', 'getBotUsername'];
    for (const fn of channelFns) {
      assert.equal(typeof channelHelpers[fn], 'function', `channelHelpers.${fn} must be a function`);
      assert.equal(botHelpers[fn], channelHelpers[fn], `botHelpers.${fn} must re-export from channelHelpers`);
    }
  });

  await t.test('force-subscribe functions are exported directly and via facade', () => {
    const fsubFns = ['getForceSubChannelsList', 'checkSubscription', 'buildForceSubscribeGate', 'invalidateFsubCache', 'pruneFsubCache'];
    for (const fn of fsubFns) {
      assert.equal(typeof forceSubscribe[fn], 'function', `forceSubscribe.${fn} must be a function`);
      assert.equal(botHelpers[fn], forceSubscribe[fn], `botHelpers.${fn} must re-export from forceSubscribe`);
    }
  });

  await t.test('ui-builders functions are exported directly and via facade', () => {
    const uiFns = [
      'getAdminDashboardKeyboard', 'getExportHubKeyboard', 'getExportTimeKeyboard',
      'getExportLinksKeyboard', 'getUserHelpMessage', 'getAdminHelpMessage', 'getSponsorButton',
      'buildStartMenuButtons', 'formatStartMessage'
    ];
    for (const fn of uiFns) {
      assert.equal(typeof uiBuilders[fn], 'function', `uiBuilders.${fn} must be a function`);
      assert.equal(botHelpers[fn], uiBuilders[fn], `botHelpers.${fn} must re-export from uiBuilders`);
    }
  });

  await t.test('delivery functions are exported directly and via facade', () => {
    const deliveryFns = [
      'copyMessage', 'forwardMessage', 'copyIntoDbChannel', 'copyFromDbChannel',
      'showLoadingAnimation', 'deliverBatch', 'scheduleAutoDelete', 'processDueAutoDeletes', 'startAutoDeleteWorker'
    ];
    for (const fn of deliveryFns) {
      assert.equal(typeof delivery[fn], 'function', `delivery.${fn} must be a function`);
      assert.equal(botHelpers[fn], delivery[fn], `botHelpers.${fn} must re-export from delivery`);
    }
  });

  await t.test('diagnostics functions are exported directly and via facade', () => {
    const diagFns = [
      'registerWebhook', 'getWebhookInfo', 'pingDatabase', 'checkShortenerHealth',
      'formatUptime', 'setMyCommands', 'renderPingReport', 'renderSystemStatus'
    ];
    for (const fn of diagFns) {
      assert.equal(typeof diagnostics[fn], 'function', `diagnostics.${fn} must be a function`);
      assert.equal(botHelpers[fn], diagnostics[fn], `botHelpers.${fn} must re-export from diagnostics`);
    }
  });

  await t.test('backup functions are exported directly and via facade', () => {
    const backupFns = ['generateDatabaseBackupBuffer', 'sendDatabaseBackup', 'startDailyBackupWorker'];
    for (const fn of backupFns) {
      assert.equal(typeof backup[fn], 'function', `backup.${fn} must be a function`);
      assert.equal(botHelpers[fn], backup[fn], `botHelpers.${fn} must re-export from backup`);
    }
  });
});

test('Issue 1: admin-callbacks.js facade and admin domain modules integrity', async (t) => {
  await t.test('admin-callbacks exports handleAdminCallback and all screen renderers', () => {
    const expectedExports = [
      'handleAdminCallback', 'renderDashboard', 'renderSecHub', 'renderAutoDelMgmt',
      'renderGhostFleetMgmt', 'renderBannersMgmt', 'renderSponsorMgmt', 'renderFsCfg',
      'renderStorageAudit', 'navButtons'
    ];
    for (const exp of expectedExports) {
      assert.equal(typeof adminCallbacks[exp], 'function', `adminCallbacks.${exp} must be an exported function`);
    }
  });

  await t.test('admin submodules export their action tables with functions', () => {
    const modules = [
      { name: 'banners', table: bannersModule.bannerActions },
      { name: 'ghostFleet', table: ghostFleetModule.ghostFleetActions },
      { name: 'storageAudit', table: storageAuditModule.storageAuditActions },
      { name: 'forceSub', table: forceSubModule.forceSubActions },
      { name: 'broadcast', table: broadcastModule.broadcastActions },
      { name: 'wipeCleanup', table: wipeCleanupModule.wipeCleanupActions },
      { name: 'settingsSec', table: settingsSecModule.settingsSecurityActions },
      { name: 'exportsTokens', table: exportsTokensModule.exportsTokensActions },
      { name: 'sessions', table: sessionsModule.sessionActions }
    ];

    let totalActions = 0;
    for (const mod of modules) {
      assert.ok(mod.table && typeof mod.table === 'object', `${mod.name} must export an actions object`);
      for (const [actionKey, handler] of Object.entries(mod.table)) {
        assert.equal(typeof handler, 'function', `${mod.name} action [${actionKey}] must be a function`);
        totalActions++;
      }
    }
    assert.ok(totalActions >= 70, `Expected at least 70 action handlers across admin modules, found ${totalActions}`);
  });

  await t.test('navButtons utility formats back and home buttons', () => {
    const nav = commonModule.navButtons('admin:custom_back');
    assert.equal(Array.isArray(nav), true);
    assert.equal(nav[0][0].callback_data, 'admin:custom_back');
    assert.equal(nav[0][1].callback_data, 'admin:dashboard');
  });
});
