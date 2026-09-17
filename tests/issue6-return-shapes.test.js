import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sendTelegramMessage,
  sendTelegramDocument,
  sendTelegramFileBuffer,
  sendTelegramVideo,
  sendTelegramAudio,
  sendTelegramPhoto
} from '../src/bot-common.js';

describe('Issue 6: Normalized Telegram API Helper Return Shapes', () => {
  const helpers = [
    { name: 'sendTelegramMessage', fn: () => sendTelegramMessage(12345, 'Hello') },
    { name: 'sendTelegramDocument', fn: () => sendTelegramDocument(12345, 'doc_123') },
    { name: 'sendTelegramFileBuffer', fn: () => sendTelegramFileBuffer(12345, Buffer.from('test'), 'test.txt') },
    { name: 'sendTelegramVideo', fn: () => sendTelegramVideo(12345, 'vid_123') },
    { name: 'sendTelegramAudio', fn: () => sendTelegramAudio(12345, 'aud_123') },
    { name: 'sendTelegramPhoto', fn: () => sendTelegramPhoto(12345, 'photo_url', 'caption') }
  ];

  it('all sendTelegram* helpers return uniform { ok, messageId, detail } shape on missing token', async () => {
    // Without token configured, all helpers must return { ok: false, messageId: null, ... }
    for (const { name, fn } of helpers) {
      const res = await fn();
      assert.ok(res && typeof res === 'object', `${name} must return an object`);
      assert.equal(typeof res.ok, 'boolean', `${name}.ok must be boolean`);
      assert.equal(res.ok, false, `${name}.ok must be false when token is missing`);
      assert.equal(res.messageId, null, `${name}.messageId must be null when token is missing`);
      assert.ok('detail' in res, `${name} must contain detail field`);
    }
  });

  it('all sendTelegram* helpers return uniform { ok: true, messageId, detail } on successful API response', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

    try {
      const mockMessageId = 445566;
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            message_id: mockMessageId,
            chat: { id: 12345 }
          }
        })
      });

      for (const { name, fn } of helpers) {
        const res = await fn();
        assert.ok(res && typeof res === 'object', `${name} must return an object`);
        assert.equal(res.ok, true, `${name}.ok must be true`);
        assert.equal(res.messageId, mockMessageId, `${name}.messageId must equal result.message_id`);
        assert.ok(res.detail && typeof res.detail === 'object', `${name}.detail must contain raw Telegram payload`);
        assert.equal(res.detail.result.message_id, mockMessageId);
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken !== undefined) {
        process.env.TELEGRAM_BOT_TOKEN = originalToken;
      } else {
        delete process.env.TELEGRAM_BOT_TOKEN;
      }
    }
  });

  it('all sendTelegram* helpers return uniform { ok: false, messageId: null, detail } on API failure response', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

    try {
      globalThis.fetch = async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          error_code: 400,
          description: 'Bad Request: chat not found'
        })
      });

      for (const { name, fn } of helpers) {
        const res = await fn();
        assert.ok(res && typeof res === 'object', `${name} must return an object`);
        assert.equal(res.ok, false, `${name}.ok must be false on API error`);
        assert.equal(res.messageId, null, `${name}.messageId must be null on API error`);
        assert.ok(res.detail && typeof res.detail === 'object', `${name}.detail must contain raw Telegram payload`);
        assert.equal(res.detail.error_code, 400);
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken !== undefined) {
        process.env.TELEGRAM_BOT_TOKEN = originalToken;
      } else {
        delete process.env.TELEGRAM_BOT_TOKEN;
      }
    }
  });

  it('zero occurrences of .result?.message_id or .result.message_id exist outside bot-common.js', () => {
    const srcDir = path.resolve('src');
    const violations = [];

    function scanDir(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          if (entry.name === 'bot-common.js') continue; // bot-common.js is the source of truth that defines the wrapper
          const content = fs.readFileSync(fullPath, 'utf8');
          if (content.includes('result?.message_id') || content.includes('result.message_id')) {
            violations.push(fullPath);
          }
        }
      }
    }

    scanDir(srcDir);
    assert.deepEqual(violations, [], `Expected zero violations outside bot-common.js, found in: ${violations.join(', ')}`);
  });
});
