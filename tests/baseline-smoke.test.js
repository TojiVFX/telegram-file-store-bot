import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Core domain imports
import { verifyTelegramWebhook } from '../src/auth.js';
import {
  parseValidityHours,
  esc,
  toSmallCaps,
  toSmallCapsSafe,
  formatButtonText,
  formatReplyMarkup,
  isSafePublicUrl,
  formatISTDateTime,
  formatISTTime,
  getISTDateString,
} from '../src/bot-common.js';
import {
  generateFileCode,
  generateBatchCode,
  generateTempTokenCode,
  generateBundleCode,
  formatDuration,
  parseDurationString,
} from '../src/filestore.js';
import {
  sanitizeMediaTitle,
  generateCloakedCaption,
  generateSaltedFileFingerprint,
  injectBinaryNoise,
} from '../src/stealth-engine.js';
import {
  recordUserVelocity,
  isScraperSuspected,
  clearUserVelocity,
} from '../src/anti-scraper.js';

describe('Baseline Pure-Function Smoke Tests', () => {

  describe('Webhook Verification (auth.js)', () => {
    const originalSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

    it('returns true when secret token header matches exactly', () => {
      process.env.TELEGRAM_WEBHOOK_SECRET = 'super-secret-token-123';
      const req = {
        headers: {
          'x-telegram-bot-api-secret-token': 'super-secret-token-123',
        },
      };
      assert.equal(verifyTelegramWebhook(req), true);
    });

    it('returns false when secret token header does not match', () => {
      process.env.TELEGRAM_WEBHOOK_SECRET = 'super-secret-token-123';
      const req = {
        headers: {
          'x-telegram-bot-api-secret-token': 'wrong-token-abc',
        },
      };
      assert.equal(verifyTelegramWebhook(req), false);
    });

    it('returns false when secret lengths differ', () => {
      process.env.TELEGRAM_WEBHOOK_SECRET = 'super-secret';
      const req = {
        headers: {
          'x-telegram-bot-api-secret-token': 'short',
        },
      };
      assert.equal(verifyTelegramWebhook(req), false);
    });

    it('returns false when header is missing or empty', () => {
      process.env.TELEGRAM_WEBHOOK_SECRET = 'super-secret';
      assert.equal(verifyTelegramWebhook({ headers: {} }), false);
      assert.equal(verifyTelegramWebhook({}), false);
      assert.equal(verifyTelegramWebhook(null), false);
    });

    it('returns false when TELEGRAM_WEBHOOK_SECRET is not configured', () => {
      delete process.env.TELEGRAM_WEBHOOK_SECRET;
      const req = {
        headers: {
          'x-telegram-bot-api-secret-token': 'some-token',
        },
      };
      assert.equal(verifyTelegramWebhook(req), false);
      // Restore
      if (originalSecret) process.env.TELEGRAM_WEBHOOK_SECRET = originalSecret;
    });
  });

  describe('Validity Hours Parsing (bot-common.js)', () => {
    it('preserves 0 as a valid hour setting (re-verify every request)', () => {
      assert.equal(parseValidityHours(0), 0);
      assert.equal(parseValidityHours('0'), 0);
    });

    it('parses valid positive numbers and numeric strings', () => {
      assert.equal(parseValidityHours(12), 12);
      assert.equal(parseValidityHours('48'), 48);
      assert.equal(parseValidityHours('168', 24), 168);
    });

    it('falls back to default for undefined, null, or whitespace', () => {
      assert.equal(parseValidityHours(undefined), 24);
      assert.equal(parseValidityHours(null), 24);
      assert.equal(parseValidityHours(''), 24);
      assert.equal(parseValidityHours('   ', 12), 12);
    });

    it('falls back to default for negative numbers or non-numeric strings', () => {
      assert.equal(parseValidityHours(-5), 24);
      assert.equal(parseValidityHours('-10', 48), 48);
      assert.equal(parseValidityHours('abc'), 24);
      assert.equal(parseValidityHours(NaN), 24);
    });
  });

  describe('HTML Escaping & Typography (bot-common.js)', () => {
    it('escapes HTML special characters correctly', () => {
      assert.equal(esc('<b>"Hello" & \'World\'</b>'), '&lt;b&gt;&quot;Hello&quot; &amp; &#039;World&#039;&lt;/b&gt;');
      assert.equal(esc(null), '');
      assert.equal(esc(undefined), '');
      assert.equal(esc(123), '123');
    });

    it('converts plain alphabetic text to small caps', () => {
      const converted = toSmallCaps('Storage Audit');
      assert.equal(converted, 'ꜱᴛᴏʀᴀɢᴇ ᴀᴜᴅɪᴛ');
      assert.equal(toSmallCaps(''), '');
    });

    it('safely applies small caps without corrupting HTML tags, URLs, usernames, or commands', () => {
      const input = 'Click <a href="https://t.me/mybot?start=file_123">here</a> or ask @SupportBot or use /help &amp; info';
      const output = toSmallCapsSafe(input);
      // Protected tokens remain untouched
      assert.ok(output.includes('<a href="https://t.me/mybot?start=file_123">here</a>'));
      assert.ok(output.includes('@SupportBot'));
      assert.ok(output.includes('/help'));
      assert.ok(output.includes('&amp;'));
      // Surrounding words should be transformed to small caps
      assert.ok(output.includes('ᴄʟɪᴄᴋ'));
      assert.ok(output.includes('ᴏʀ ᴀꜱᴋ'));
      assert.ok(output.includes('ᴏʀ ᴜꜱᴇ'));
      assert.ok(output.includes('ɪɴꜰᴏ'));
    });
  });

  describe('Button Formatting & Reply Markup (bot-common.js)', () => {
    it('translates standalone emoji buttons into semantic small-caps labels', () => {
      assert.equal(formatButtonText('❌'), 'ᴄᴀɴᴄᴇʟ');
      assert.equal(formatButtonText('🗑️'), 'ᴅᴇʟᴇᴛᴇ');
      assert.equal(formatButtonText('⚙️'), 'ꜱᴇᴛᴛɪɴɢꜱ');
      assert.equal(formatButtonText('⬅️'), 'ʙᴀᴄᴋ');
      assert.equal(formatButtonText('✅'), 'ᴅᴏɴᴇ');
    });

    it('strips decorative emojis and formats labels to small caps', () => {
      const res = formatButtonText('📁 Download Media');
      assert.equal(res, 'ᴅᴏᴡɴʟᴏᴀᴅ ᴍᴇᴅɪᴀ');
    });

    it('formats full inline keyboard markup without mutating the original', () => {
      const original = {
        inline_keyboard: [
          [{ text: '❌ Cancel', callback_data: 'admin:cancel' }],
          [{ text: '🔍 Check Status', callback_data: 'admin:status' }],
        ],
      };
      const formatted = formatReplyMarkup(original);
      assert.notEqual(formatted, original);
      assert.equal(formatted.inline_keyboard[0][0].text, 'ᴄᴀɴᴄᴇʟ');
      assert.equal(formatted.inline_keyboard[1][0].text, 'ᴄʜᴇᴄᴋ ꜱᴛᴀᴛᴜꜱ');
      // Original text should be intact
      assert.equal(original.inline_keyboard[0][0].text, '❌ Cancel');
    });
  });

  describe('SSRF URL Validation (bot-common.js)', () => {
    it('allows valid public HTTP and HTTPS URLs', () => {
      assert.equal(isSafePublicUrl('https://api.telegram.org'), true);
      assert.equal(isSafePublicUrl('http://example.com/api/v1'), true);
      assert.equal(isSafePublicUrl('https://shareus.io/api?key=123'), true);
    });

    it('blocks localhost and loopback addresses', () => {
      assert.equal(isSafePublicUrl('http://localhost:3000'), false);
      assert.equal(isSafePublicUrl('http://127.0.0.1:8080'), false);
      assert.equal(isSafePublicUrl('http://0.0.0.0:3000'), false);
    });

    it('blocks private IPv4 address ranges and link-local addresses', () => {
      assert.equal(isSafePublicUrl('http://10.0.0.1'), false);
      assert.equal(isSafePublicUrl('http://192.168.1.1/admin'), false);
      assert.equal(isSafePublicUrl('http://172.16.0.1'), false);
      assert.equal(isSafePublicUrl('http://172.31.255.255'), false);
      assert.equal(isSafePublicUrl('http://169.254.169.254/latest/meta-data'), false);
    });

    it('blocks non-HTTP protocols and invalid inputs', () => {
      assert.equal(isSafePublicUrl('file:///etc/passwd'), false);
      assert.equal(isSafePublicUrl('ftp://ftp.example.com'), false);
      assert.equal(isSafePublicUrl('not-a-url'), false);
      assert.equal(isSafePublicUrl(null), false);
      assert.equal(isSafePublicUrl(''), false);
    });
  });

  describe('IST Date & Time Formatting (bot-common.js)', () => {
    const fixedUtcDate = new Date('2026-09-17T12:00:00.000Z'); // 17:30 IST

    it('formats IST date string as YYYY-MM-DD', () => {
      const dateStr = getISTDateString(fixedUtcDate);
      assert.equal(dateStr, '2026-09-17');
    });

    it('formats IST time correctly with UTC+5:30 offset', () => {
      const timeStr = formatISTTime(fixedUtcDate, false);
      assert.ok(timeStr.includes('05:30 PM') || timeStr.includes('5:30 PM'));
      assert.ok(timeStr.endsWith('IST'));
    });

    it('formats IST datetime with medium date and time', () => {
      const dtStr = formatISTDateTime(fixedUtcDate);
      assert.ok(dtStr.includes('Sep 17, 2026'));
      assert.ok(dtStr.endsWith('IST'));
    });
  });

  describe('Random Code Generators (filestore.js)', () => {
    it('generates unique file codes with file_ prefix', () => {
      const code1 = generateFileCode();
      const code2 = generateFileCode();
      assert.ok(code1.startsWith('file_'));
      assert.ok(code2.startsWith('file_'));
      assert.notEqual(code1, code2);
      assert.equal(code1.length, 17); // 'file_' (5) + 12 chars
    });

    it('generates batch codes with batch_ prefix', () => {
      const code = generateBatchCode();
      assert.ok(code.startsWith('batch_'));
      assert.equal(code.length, 18); // 'batch_' (6) + 12 chars
    });

    it('generates temp token codes with temp_ prefix', () => {
      const code = generateTempTokenCode();
      assert.ok(code.startsWith('temp_'));
      assert.equal(code.length, 19); // 'temp_' (5) + 14 chars
    });

    it('generates bundle codes with bundle_ prefix', () => {
      const code = generateBundleCode();
      assert.ok(code.startsWith('bundle_'));
      assert.equal(code.length, 19); // 'bundle_' (7) + 12 chars
    });
  });

  describe('Duration Parsing & Formatting (filestore.js)', () => {
    it('formats seconds into human readable duration strings', () => {
      assert.equal(formatDuration(30), '30s');
      assert.equal(formatDuration(60), '1 min');
      assert.equal(formatDuration(300), '5 mins');
      assert.equal(formatDuration(3600), '1 hour');
      assert.equal(formatDuration(7200), '2 hours');
      assert.equal(formatDuration(86400), '1 day');
      assert.equal(formatDuration(259200), '3 days');
      assert.equal(formatDuration(0), '0s');
      assert.equal(formatDuration(-10), '0s');
    });

    it('parses duration shorthand strings into seconds', () => {
      assert.equal(parseDurationString('30s'), 30);
      assert.equal(parseDurationString('15m'), 900);
      assert.equal(parseDurationString('1h'), 3600);
      assert.equal(parseDurationString('12h'), 43200);
      assert.equal(parseDurationString('1d'), 86400);
      assert.equal(parseDurationString('7d'), 604800);
      assert.equal(parseDurationString('2 weeks'), 1209600);
      assert.equal(parseDurationString('invalid'), null);
      assert.equal(parseDurationString(''), null);
      assert.equal(parseDurationString(null), null);
    });
  });

  describe('Stealth Engine Utilities (stealth-engine.js)', () => {
    it('sanitizes media titles by stripping release groups, resolutions, and encoder tags', () => {
      const raw = 'Avatar.The.Way.of.Water.2022.1080p.WEBRip.x264.AAC5.1-[YTS.MX].mp4';
      const clean = sanitizeMediaTitle(raw);
      assert.equal(clean.includes('1080p'), false);
      assert.equal(clean.includes('WEBRip'), false);
      assert.equal(clean.includes('x264'), false);
      assert.equal(clean.includes('YTS'), false);
      assert.ok(clean.includes('Avatar'));
      assert.ok(clean.includes('Way of Water'));
    });

    it('generates cloaked caption reference tag', () => {
      const caption = generateCloakedCaption('file_abc123xyz');
      assert.ok(caption.includes('#REF_'));
      assert.ok(caption.includes('Cloud Storage Object'));
    });

    it('generates deterministic salted file fingerprints for identical input', () => {
      const fp1 = generateSaltedFileFingerprint('unique-tg-id-12345');
      const fp2 = generateSaltedFileFingerprint('unique-tg-id-12345');
      const fpDiff = generateSaltedFileFingerprint('different-id-67890');
      assert.equal(fp1, fp2);
      assert.notEqual(fp1, fpDiff);
      assert.equal(generateSaltedFileFingerprint(null), null);
    });

    it('injects 32 bytes of binary noise trailer into a buffer', () => {
      const original = Buffer.from('binary-media-payload-data');
      const padded = injectBinaryNoise(original);
      assert.equal(padded.length, original.length + 32);
      assert.equal(padded.subarray(0, original.length).toString(), 'binary-media-payload-data');
    });
  });

  describe('Anti-Scraper Velocity Tracking (anti-scraper.js)', () => {
    const testUserId = 'test_scraper_user_99';

    it('records velocity and triggers scraper suspicion after exceeding threshold', () => {
      clearUserVelocity(testUserId);
      // isScraperSuspected increments request count on call
      // Request 1:
      assert.equal(isScraperSuspected(testUserId), false);
      // Requests 2, 3, 4:
      assert.equal(recordUserVelocity(testUserId), 2);
      assert.equal(recordUserVelocity(testUserId), 3);
      assert.equal(recordUserVelocity(testUserId), 4);

      // Request 5 (threshold is 4 requests in 30s): exceeds threshold
      assert.equal(isScraperSuspected(testUserId), true);

      // Clear resets suspicion
      clearUserVelocity(testUserId);
      // Fresh call is only request 1 again
      assert.equal(isScraperSuspected(testUserId), false);
    });
  });
});
