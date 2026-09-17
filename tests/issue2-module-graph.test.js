import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

describe('Issue 2: Static Module Graph & Circular Dependency Integrity', () => {

  test('All Layer 1-5 modules can be imported statically without errors', async () => {
    // Layer 1: Primitives
    const auth = await import('../src/auth.js');
    assert.ok(typeof auth.verifyTelegramWebhook === 'function');
    assert.ok(typeof auth.isAdmin === 'function');
    assert.ok(typeof auth.getAdminIds === 'function');

    const botCommon = await import('../src/bot-common.js');
    assert.ok(typeof botCommon.copyMessage === 'function');
    assert.ok(typeof botCommon.forwardMessage === 'function');

    // Layer 2: Domain Services
    const channelHelpers = await import('../src/channel-helpers.js');
    assert.ok(typeof channelHelpers.registerChannelFailoverHandler === 'function');
    assert.ok(typeof channelHelpers.checkChannelMessageExists === 'function');

    const delivery = await import('../src/delivery.js');
    assert.ok(typeof delivery.copyIntoDbChannel === 'function');
    assert.ok(typeof delivery.copyFromDbChannel === 'function');

    const ghostFleet = await import('../src/ghost-fleet.js');
    assert.ok(typeof ghostFleet.getAllWorkerBots === 'function');

    const diagnostics = await import('../src/diagnostics.js');
    assert.ok(typeof diagnostics.renderSystemStatus === 'function');

    const backup = await import('../src/backup.js');
    assert.ok(typeof backup.sendDatabaseBackup === 'function');

    // Layer 3: Storage & Protocol Aggregates
    const filestore = await import('../src/filestore.js');
    assert.ok(typeof filestore.storeFile === 'function');
    assert.ok(typeof filestore.rebuildChannelStorage === 'function');

    const botUsers = await import('../src/bot-users.js');
    assert.ok(typeof botUsers.isAdmin === 'function');
    assert.ok(typeof botUsers.upsertUser === 'function');

    const phoenix = await import('../src/phoenix-protocol.js');
    assert.ok(typeof phoenix.activatePhoenixProtocol === 'function');

    // Layer 4: Controllers & Handlers
    const startCmd = await import('../src/commands/start.js');
    assert.ok(typeof startCmd.handleStartPayload === 'function');

    const adminCmd = await import('../src/commands/admin.js');
    assert.ok(typeof adminCmd.processAdminMessage === 'function');

    const userCmd = await import('../src/commands/user.js');
    assert.ok(typeof userCmd.processMessageUpdate === 'function');

    const userCallbacks = await import('../src/callbacks/user-callbacks.js');
    assert.ok(typeof userCallbacks.handleUserCallback === 'function');

    const adminCallbacks = await import('../src/callbacks/admin-callbacks.js');
    assert.ok(typeof adminCallbacks.handleAdminCallback === 'function');

    // Layer 5: App & Routing
    const app = await import('../src/app.js');
    assert.ok(app.default);
  });

  test('Zero dynamic import() calls remain in src/', () => {
    function getJsFiles(dir) {
      const files = [];
      const items = readdirSync(dir);
      for (const item of items) {
        const fullPath = join(dir, item);
        const st = statSync(fullPath);
        if (st.isDirectory()) {
          files.push(...getJsFiles(fullPath));
        } else if (item.endsWith('.js')) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const srcDir = resolve('src');
    const allFiles = getJsFiles(srcDir);
    const filesWithDynamicImport = [];

    // Regex matching dynamic import(...) but not import statements
    const dynamicImportRegex = /\bimport\s*\(/g;

    for (const file of allFiles) {
      const content = readFileSync(file, 'utf-8');
      if (dynamicImportRegex.test(content)) {
        filesWithDynamicImport.push(file);
      }
    }

    assert.deepEqual(
      filesWithDynamicImport,
      [],
      `Found dynamic import() in: ${filesWithDynamicImport.join(', ')}`
    );
  });

  test('Phoenix Protocol registers its failover handler with channel-helpers', async () => {
    const { triggerChannelFailover, registerChannelFailoverHandler } = await import('../src/channel-helpers.js');
    const { activatePhoenixProtocol } = await import('../src/phoenix-protocol.js');

    assert.ok(typeof triggerChannelFailover === 'function');
    assert.ok(typeof registerChannelFailoverHandler === 'function');
    assert.ok(typeof activatePhoenixProtocol === 'function');
  });

  test('Auth functions extracted to auth.js are accessible through auth.js and bot-users.js facade', async () => {
    const auth = await import('../src/auth.js');
    const botUsers = await import('../src/bot-users.js');

    assert.strictEqual(typeof auth.getAdminIds, 'function');
    assert.strictEqual(typeof auth.isAdmin, 'function');
    assert.strictEqual(typeof botUsers.getAdminIds, 'function');
    assert.strictEqual(typeof botUsers.isAdmin, 'function');

    // Should point to identical function references via facade
    assert.strictEqual(auth.getAdminIds, botUsers.getAdminIds);
    assert.strictEqual(auth.isAdmin, botUsers.isAdmin);
  });
});
