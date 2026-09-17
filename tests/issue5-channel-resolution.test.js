import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChannelIdFromMessageOrText as directHelper } from '../src/channel-helpers.js';
import { resolveChannelIdFromMessageOrText as facadeHelper } from '../src/bot-helpers.js';

describe('Issue 5: Channel-ID-Resolution De-duplication', () => {
  it('helper is exported directly from channel-helpers.js and via bot-helpers.js facade', () => {
    assert.equal(typeof directHelper, 'function');
    assert.equal(typeof facadeHelper, 'function');
    assert.equal(directHelper, facadeHelper);
  });

  it('resolves channel ID and title from forward_from_chat', async () => {
    const message = {
      forward_from_chat: {
        id: -100123456789,
        type: 'channel',
        title: 'My Announcement Channel'
      }
    };

    const res = await directHelper(message, '', { requireAdmin: false, errorContext: 'channel' });
    assert.equal(res.ok, true);
    assert.equal(res.targetCid, -100123456789);
    assert.equal(res.targetTitle, 'My Announcement Channel');
  });

  it('resolves channel ID and title from forward_origin (Telegram Modern Schema)', async () => {
    const message = {
      forward_origin: {
        type: 'channel',
        chat: {
          id: -100987654321,
          title: 'Origin Forward Channel'
        }
      }
    };

    const res = await directHelper(message, '', { requireAdmin: false, errorContext: 'backup channel' });
    assert.equal(res.ok, true);
    assert.equal(res.targetCid, -100987654321);
    assert.equal(res.targetTitle, 'Origin Forward Channel');
  });

  it('resolves channel ID from directly typed -100... string', async () => {
    const rawText = ' -1001122334455  ';
    const res = await directHelper({}, rawText, { requireAdmin: false, errorContext: 'standby channel' });
    assert.equal(res.ok, true);
    assert.equal(res.targetCid, '-1001122334455');
    assert.equal(res.targetTitle, '-1001122334455');
  });

  it('rejects invalid text or missing forward with contextual error message', async () => {
    const res = await directHelper({}, 'invalid_text_123', { requireAdmin: false, errorContext: 'backup channel' });
    assert.equal(res.ok, false);
    assert.ok(res.error.includes('Please forward a message directly from the backup channel'));
    assert.ok(res.error.includes('-100123456789'));
  });

  it('honors custom formatError override', async () => {
    const customFormatErr = '❌ Custom format error text with /cancel instruction';
    const res = await directHelper({}, 'bad_id', {
      requireAdmin: false,
      formatError: customFormatErr
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, customFormatErr);
  });

  it('rejects non-channel forwards unless allowGroup is true', async () => {
    const groupMessage = {
      forward_from_chat: {
        id: -100555555555,
        type: 'supergroup',
        title: 'Relay Supergroup'
      }
    };

    // By default (allowGroup = false), non-channel forward is rejected
    const rejectedRes = await directHelper(groupMessage, '', { requireAdmin: false, errorContext: 'DB channel' });
    assert.equal(rejectedRes.ok, false);

    // With allowGroup = true, group forward is accepted
    const acceptedRes = await directHelper(groupMessage, '', {
      requireAdmin: false,
      allowGroup: true,
      errorContext: 'relay group/channel'
    });
    assert.equal(acceptedRes.ok, true);
    assert.equal(acceptedRes.targetCid, -100555555555);
    assert.equal(acceptedRes.targetTitle, 'Relay Supergroup');
  });

  it('verifies admin rights when requireAdmin is true and formats notAdminError', async () => {
    // In test environment without mock Telegram API, isBotAdmin returns false
    const res = await directHelper({}, '-100999999999', {
      requireAdmin: true,
      errorContext: 'DB channel'
    });

    assert.equal(res.ok, false);
    assert.equal(res.targetCid, '-100999999999');
    assert.ok(res.error.includes('Bot is not an admin in this DB channel!'));
    assert.ok(res.error.includes('Post Messages permissions'));
  });

  it('honors custom notAdminError override', async () => {
    const customAdminErr = '❌ Main Bot is not an admin in this Relay chat!';
    const res = await directHelper({}, '-100999999999', {
      requireAdmin: true,
      notAdminError: customAdminErr
    });

    assert.equal(res.ok, false);
    assert.equal(res.error, customAdminErr);
  });
});
