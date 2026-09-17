import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getCollection, getSettings, updateSettings } from '../src/bot-common.js';
import { banUser, unbanUser, isBanned, cancelBroadcast, broadcastWithProgress } from '../src/bot-users.js';
import { sendCaptchaChallenge, verifyCaptchaAnswer } from '../src/anti-scraper.js';
import { getAllWorkerBots, getNextWorkerBot, refreshWorkerBots } from '../src/ghost-fleet.js';

describe('Issue 3: Multi-Instance Safe State & Distributed Broadcast Cancellation', () => {

  test('Broadcast cancellation is backed by MongoDB broadcast_jobs and stops delivery', async () => {
    const users = await getCollection('users');
    const jobs = await getCollection('broadcast_jobs');

    // Create 45 mock test users (more than 2 chunks of 20)
    for (let i = 1; i <= 45; i++) {
      await users.updateOne(
        { _id: `test_user_broadcast_${i}` },
        { $set: { _id: `test_user_broadcast_${i}`, banned: false, isBlocked: false } },
        { upsert: true }
      );
    }

    const testBroadcastId = `test_bcast_${Date.now()}`;

    // Launch broadcast in background
    const broadcastPromise = broadcastWithProgress({
      text: 'Test Multi-Instance Broadcast',
      broadcastId: testBroadcastId
    });

    // Give event loop time to write initial job document
    await new Promise(r => setTimeout(r, 50));

    // Verify broadcast job was created in MongoDB with status 'running'
    const initialJob = await jobs.findOne({ _id: testBroadcastId });
    assert.ok(initialJob, 'Job document should be created in broadcast_jobs');
    assert.strictEqual(initialJob.status, 'running');
    assert.strictEqual(initialJob.cancelled, false);

    // Cancel the broadcast via MongoDB update simulation (cancelBroadcast)
    await cancelBroadcast(testBroadcastId);

    // Await completion
    const result = await broadcastPromise;

    // Check that broadcast reported cancellation
    assert.strictEqual(result.cancelled, true, 'Result should show cancelled: true');
    assert.ok(result.sent < 45, `Should not deliver all 45 messages (delivered: ${result.sent})`);

    // Verify MongoDB job document was updated to cancelled
    const finalJob = await jobs.findOne({ _id: testBroadcastId });
    assert.ok(finalJob);
    assert.strictEqual(finalJob.status, 'cancelled');
    assert.strictEqual(finalJob.cancelled, true);

    // Cleanup mock users & jobs
    for (let i = 1; i <= 45; i++) {
      await users.deleteOne({ _id: `test_user_broadcast_${i}` });
    }
    await jobs.deleteOne({ _id: testBroadcastId });
  });

  test('Global cancelBroadcast() cancels all active running jobs', async () => {
    const jobs = await getCollection('broadcast_jobs');
    const mockJob1 = `job_run_1_${Date.now()}`;
    const mockJob2 = `job_run_2_${Date.now()}`;

    await jobs.updateOne({ _id: mockJob1 }, { $set: { status: 'running', cancelled: false } }, { upsert: true });
    await jobs.updateOne({ _id: mockJob2 }, { $set: { status: 'running', cancelled: false } }, { upsert: true });

    // Call global cancellation (no broadcastId)
    await cancelBroadcast();

    const doc1 = await jobs.findOne({ _id: mockJob1 });
    const doc2 = await jobs.findOne({ _id: mockJob2 });

    assert.strictEqual(doc1.cancelled, true);
    assert.strictEqual(doc1.status, 'cancelled');
    assert.strictEqual(doc2.cancelled, true);
    assert.strictEqual(doc2.status, 'cancelled');

    await jobs.deleteOne({ _id: mockJob1 });
    await jobs.deleteOne({ _id: mockJob2 });
  });

  test('Settings write immediately propagates to getSettings()', async () => {
    const testVal = `instance_test_${Date.now()}`;
    await updateSettings({ testSettingKey: testVal });

    const s = await getSettings();
    assert.strictEqual(s.testSettingKey, testVal);
  });

  test('Ban and Unban write to MongoDB and update isBanned()', async () => {
    const testUserId = `test_user_ban_${Date.now()}`;

    // Initially not banned
    const beforeBan = await isBanned(testUserId);
    assert.strictEqual(beforeBan, false);

    // Ban user
    await banUser(testUserId, 3600, 'Test violation');
    const afterBan = await isBanned(testUserId);
    assert.strictEqual(afterBan, true);

    // Unban user
    await unbanUser(testUserId);
    const afterUnban = await isBanned(testUserId);
    assert.strictEqual(afterUnban, false);

    // Cleanup
    const users = await getCollection('users');
    await users.deleteOne({ _id: testUserId });
  });

  test('Anti-scraper captcha is persisted in MongoDB sessions and verifies across instances', async () => {
    const testChatId = `chat_test_anti_${Date.now()}`;
    const payload = 'file_test123';

    // Generate challenge (persists in MongoDB sessions)
    await sendCaptchaChallenge(testChatId, payload);

    // Inspect session in MongoDB
    const sessions = await getCollection('sessions');
    const sessionDocs = await sessions.find({ _id: { $regex: `^captcha:${testChatId}:` } }).toArray();
    assert.ok(sessionDocs.length > 0, 'Captcha session document must exist in MongoDB');

    const captchaDoc = sessionDocs[0];
    const { token, targetIndex } = captchaDoc;

    // Verify wrong answer fails
    const wrongIdx = (targetIndex + 1) % 4;
    const failRes = await verifyCaptchaAnswer(testChatId, token, wrongIdx);
    assert.strictEqual(failRes.ok, false);
    assert.strictEqual(failRes.reason, 'wrong_choice');

    // Verify correct answer succeeds and deletes session
    const okRes = await verifyCaptchaAnswer(testChatId, token, targetIndex);
    assert.strictEqual(okRes.ok, true);
    assert.strictEqual(okRes.originalPayload, payload);

    const docAfter = await sessions.findOne({ _id: captchaDoc._id });
    assert.strictEqual(docAfter, null, 'Session should be cleaned up after successful verification');
  });
});
