import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commandRegistry } from '../src/commands/user.js';
import { actionMap } from '../src/callbacks/admin-callbacks.js';

describe('Issue 4: Command Registry & Admin Action Dispatch Table Integrity', () => {
  it('commandRegistry is an array of properly structured command definitions', () => {
    assert.ok(Array.isArray(commandRegistry), 'commandRegistry must be an array');
    assert.ok(commandRegistry.length >= 30, `Expected at least 30 commands, got ${commandRegistry.length}`);

    for (const cmd of commandRegistry) {
      assert.ok(typeof cmd.name === 'string' && cmd.name.length > 0, `Command must have a string name: ${JSON.stringify(cmd)}`);
      assert.ok(cmd.pattern instanceof RegExp, `Command ${cmd.name} must have a RegExp pattern`);
      assert.ok(typeof cmd.handler === 'function', `Command ${cmd.name} must have a handler function`);

      if (cmd.adminOnly !== undefined) {
        assert.equal(typeof cmd.adminOnly, 'boolean', `cmd.adminOnly must be boolean for ${cmd.name}`);
      }
      if (cmd.canGenerateOnly !== undefined) {
        assert.equal(typeof cmd.canGenerateOnly, 'boolean', `cmd.canGenerateOnly must be boolean for ${cmd.name}`);
      }
    }
  });

  it('all required bot commands exist in the registry', () => {
    const expectedCommands = [
      'start', 'bundle', 'batch', 'store', 'cancel', 'userstats', 'backup',
      'topfiles', 'todaylinks', 'bulkstore', 'exportlinks', 'broadcast',
      'ban', 'unban', 'banlist', 'user', 'toprefs', 'delete', 'wipe',
      'editfile', 'checkchannels', 'rebuildchannel', 'me', 'setting',
      'adminhelp', 'status', 'auditlinks', 'scanbroken', 'ping',
      'temptoken', 'mytokens', 'revoketoken', 'help'
    ];

    const registeredNames = commandRegistry.map(c => c.name);
    for (const name of expectedCommands) {
      assert.ok(registeredNames.includes(name), `Missing required command: ${name}`);
    }
  });

  it('command patterns match expected input and preserve priority order', () => {
    // /start matches start
    const startCmd = commandRegistry.find(c => c.name === 'start');
    assert.ok(startCmd.pattern.test('/start'));
    assert.ok(startCmd.pattern.test('/start file_123'));

    // /bundle matches bundle or quality
    const bundleCmd = commandRegistry.find(c => c.name === 'bundle');
    assert.ok(bundleCmd.pattern.test('/bundle'));
    assert.ok(bundleCmd.pattern.test('/quality'));

    // /ban vs /banlist: /banlist appears before or correctly distinguished
    const banListIndex = commandRegistry.findIndex(c => c.name === 'banlist');
    const banIndex = commandRegistry.findIndex(c => c.name === 'ban');
    // In our registry, banlist is evaluated or ban regex uses /^\/ban(\s+|$)/
    assert.ok(banIndex !== -1 && banListIndex !== -1);
    // ban pattern /^\/ban(\s+|$)/ does not falsely match /banlist
    assert.equal(commandRegistry[banIndex].pattern.test('/banlist'), false, '/ban pattern should not match /banlist');
    assert.ok(commandRegistry[banListIndex].pattern.test('/banlist'));

    // /cancel pattern does not match /checkchannels
    const cancelCmd = commandRegistry.find(c => c.name === 'cancel');
    assert.equal(cancelCmd.pattern.test('/checkchannels'), false);

    // /backup matches /backup and /exportdb
    const backupCmd = commandRegistry.find(c => c.name === 'backup');
    assert.ok(backupCmd.pattern.test('/backup'));
    assert.ok(backupCmd.pattern.test('/exportdb'));

    // Role restrictions: adminOnly commands
    const adminCommands = ['cancel', 'userstats', 'backup', 'topfiles', 'todaylinks', 'bulkstore', 'exportlinks', 'broadcast', 'ban', 'unban', 'banlist', 'user', 'delete', 'wipe', 'editfile', 'checkchannels', 'rebuildchannel', 'setting', 'adminhelp', 'status', 'auditlinks', 'scanbroken'];
    for (const name of adminCommands) {
      const cmd = commandRegistry.find(c => c.name === name);
      assert.equal(cmd.adminOnly, true, `Command ${name} must have adminOnly: true`);
    }

    // Role restrictions: canGenerateOnly commands
    const canGenCommands = ['bundle', 'batch', 'store'];
    for (const name of canGenCommands) {
      const cmd = commandRegistry.find(c => c.name === name);
      assert.equal(cmd.canGenerateOnly, true, `Command ${name} must have canGenerateOnly: true`);
    }
  });

  it('admin actionMap contains exact and prefix action handlers across all domains', () => {
    assert.ok(actionMap && typeof actionMap === 'object', 'actionMap must be an object');
    const keys = Object.keys(actionMap);
    assert.ok(keys.length >= 40, `Expected at least 40 admin actions, got ${keys.length}`);

    // Check representatives from different domains
    // Settings & Security
    assert.equal(typeof actionMap['sec_hub'], 'function');
    assert.equal(typeof actionMap['fs_settings'], 'function');
    assert.equal(typeof actionMap['toggle_protect:'], 'function');

    // Ghost Fleet
    assert.equal(typeof actionMap['ghost_fleet'], 'function');
    assert.equal(typeof actionMap['toggle_ghost_fleet:'], 'function');

    // Banners
    assert.equal(typeof actionMap['banners_mgmt'], 'function');
    assert.equal(typeof actionMap['del_banner:'], 'function');

    // Storage & Audit
    assert.equal(typeof actionMap['storage_audit'], 'function');
    assert.equal(typeof actionMap['run_retro_mirror'], 'function');

    // Force Sub
    assert.equal(typeof actionMap['fs_fsub_status'], 'function');
    assert.equal(typeof actionMap['fs_toggle:'], 'function');

    // Broadcast
    assert.equal(typeof actionMap['broadcast_prompt'], 'function');
    assert.equal(typeof actionMap['broadcast_cancel'], 'function');

    // Wipe & Cleanup
    assert.equal(typeof actionMap['trigger_cleanup'], 'function');

    // Parameterized prefix actions (keys ending in ':')
    const prefixKeys = keys.filter(k => k.endsWith(':'));
    assert.ok(prefixKeys.length >= 5, `Expected multiple parameterized prefix handlers, got: ${prefixKeys.join(', ')}`);
    assert.ok(prefixKeys.includes('set_timer:'));
    assert.ok(prefixKeys.includes('revoke_temp:'));
  });
});
