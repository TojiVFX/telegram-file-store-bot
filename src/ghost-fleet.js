import crypto from 'crypto';
import {
  getCollection, getSettings, updateSettings, log, getMainToken, botContext, toSmallCaps, esc
} from './bot-common.js';

// Cache of verified worker bots: Map<botId, { token, username, firstName, isAlive, lastChecked }>
const workerBotsCache = new Map();
let lastWorkerIndex = 0;

/**
 * Parses worker bot tokens from environment variable (WORKER_BOT_TOKENS=token1,token2).
 */
export function getEnvWorkerTokens() {
  const raw = (process.env.WORKER_BOT_TOKENS || '').trim();
  if (!raw) return [];
  return raw.split(/[\s,;]+/).map(t => t.trim().replace(/^bot/i, '')).filter(Boolean);
}

/**
 * Retrieves all configured worker bots from both .env and MongoDB collection `worker_bots`.
 */
export async function getAllWorkerBots() {
  const envTokens = getEnvWorkerTokens();
  const coll = await getCollection('worker_bots');
  const dbBots = await coll.find({}).toArray();

  const botsMap = new Map();

  // Add env-configured tokens
  for (const token of envTokens) {
    const botId = token.split(':')[0];
    if (botId) {
      botsMap.set(botId, {
        botId,
        token,
        source: 'env',
        enabled: true,
        createdAt: new Date()
      });
    }
  }

  // Merge DB-configured tokens (DB settings take precedence for enabled state)
  for (const b of dbBots) {
    if (b.botId && b.token) {
      botsMap.set(b.botId, {
        botId: b.botId,
        token: b.token,
        username: b.username || null,
        firstName: b.firstName || null,
        source: b.source || 'db',
        enabled: b.enabled !== false,
        createdAt: b.createdAt || new Date()
      });
    }
  }

  return Array.from(botsMap.values());
}

/**
 * Checks connectivity and verifies identity for a worker bot token via Telegram getMe.
 */
export async function verifyWorkerBot(token) {
  const cleanToken = token.trim().replace(/^bot/i, '');
  try {
    const res = await fetch(`https://api.telegram.org/bot${cleanToken}/getMe`);
    const data = await res.json();
    if (data.ok && data.result) {
      return {
        ok: true,
        botId: String(data.result.id),
        username: data.result.username,
        firstName: data.result.first_name,
        canJoinGroups: data.result.can_join_groups
      };
    }
    return { ok: false, reason: data.description || 'Verification failed' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Synchronizes and tests all configured worker bots.
 * Marks dead or banned worker bots in cache.
 */
export async function refreshWorkerBots() {
  const all = await getAllWorkerBots();
  for (const w of all) {
    if (!w.enabled) continue;
    const v = await verifyWorkerBot(w.token);
    if (v.ok) {
      workerBotsCache.set(w.botId, {
        botId: w.botId,
        token: w.token,
        username: v.username,
        firstName: v.firstName,
        isAlive: true,
        lastChecked: Date.now()
      });
      // Update DB with username/name if available
      const coll = await getCollection('worker_bots');
      await coll.updateOne(
        { botId: w.botId },
        { $set: { token: w.token, username: v.username, firstName: v.firstName, isAlive: true, lastChecked: new Date() } },
        { upsert: true }
      );
    } else {
      workerBotsCache.set(w.botId, {
        botId: w.botId,
        token: w.token,
        username: w.username || 'Unknown',
        firstName: w.firstName || 'Worker',
        isAlive: false,
        lastChecked: Date.now(),
        error: v.reason
      });
      log('warn', `Worker bot ${w.botId} failed health check`, { reason: v.reason });
    }
  }
}

/**
 * Selects the next healthy worker bot from the pool using Round-Robin.
 */
export async function getNextWorkerBot() {
  if (workerBotsCache.size === 0) {
    await refreshWorkerBots();
  }

  const healthyWorkers = Array.from(workerBotsCache.values()).filter(w => w.isAlive && w.token);
  if (healthyWorkers.length === 0) {
    return null;
  }

  lastWorkerIndex = (lastWorkerIndex + 1) % healthyWorkers.length;
  return healthyWorkers[lastWorkerIndex];
}

/**
 * Checks whether Ghost Fleet mode is active and healthy.
 */
export async function isGhostFleetEnabled() {
  const s = await getSettings();
  if (s?.ghostFleetEnabled !== '1') return false;

  const healthy = Array.from(workerBotsCache.values()).filter(w => w.isAlive);
  if (healthy.length > 0) return true;

  // Try refreshing once
  await refreshWorkerBots();
  return Array.from(workerBotsCache.values()).some(w => w.isAlive);
}

/**
 * Creates a single-use dispatch token for delivering a file via a Worker Bot.
 * Stored in MongoDB `sessions` with a 10-minute TTL.
 */
export async function createDispatchToken(targetCode, userId, metadata = {}) {
  const rawToken = crypto.randomBytes(16).toString('hex');
  const tokenKey = `dispatch:${rawToken}`;
  const sessions = await getCollection('sessions');

  const dispatchDoc = {
    _id: tokenKey,
    token: rawToken,
    targetCode,
    userId: String(userId),
    metadata,
    useCount: 0,
    maxUses: 1,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 600 * 1000) // 10 minutes
  };

  await sessions.updateOne(
    { _id: tokenKey },
    { $set: dispatchDoc },
    { upsert: true }
  );

  return rawToken;
}

/**
 * Atomically consumes a dispatch token when a user lands on a Worker Bot.
 */
export async function consumeDispatchToken(rawToken, userId) {
  const clean = (rawToken || '').replace(/^dispatch_/i, '').trim();
  const tokenKey = `dispatch:${clean}`;
  const sessions = await getCollection('sessions');

  // Atomically increment useCount if within limits
  const res = await sessions.findOneAndUpdate(
    {
      _id: tokenKey,
      expiresAt: { $gt: new Date() },
      $expr: { $lt: ['$useCount', '$maxUses'] }
    },
    {
      $inc: { useCount: 1 },
      $set: { consumedAt: new Date(), consumedBy: String(userId) }
    },
    { returnDocument: 'after' }
  );

  const doc = res?.value || res;
  if (!doc) {
    // Check why it failed
    const existing = await sessions.findOne({ _id: tokenKey });
    if (!existing) return { ok: false, reason: 'not_found' };
    if (existing.expiresAt <= new Date()) return { ok: false, reason: 'expired' };
    if (existing.useCount >= existing.maxUses) return { ok: false, reason: 'already_used' };
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true, doc };
}

/**
 * Adds a new worker bot by token into MongoDB.
 */
export async function addWorkerBot(token) {
  const verifyRes = await verifyWorkerBot(token);
  if (!verifyRes.ok) {
    return { ok: false, reason: verifyRes.reason };
  }

  const coll = await getCollection('worker_bots');
  await coll.updateOne(
    { botId: verifyRes.botId },
    {
      $set: {
        botId: verifyRes.botId,
        token: token.trim().replace(/^bot/i, ''),
        username: verifyRes.username,
        firstName: verifyRes.firstName,
        source: 'db',
        enabled: true,
        isAlive: true,
        updatedAt: new Date()
      },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );

  workerBotsCache.set(verifyRes.botId, {
    botId: verifyRes.botId,
    token: token.trim().replace(/^bot/i, ''),
    username: verifyRes.username,
    firstName: verifyRes.firstName,
    isAlive: true,
    lastChecked: Date.now()
  });

  return { ok: true, worker: verifyRes };
}

/**
 * Removes a worker bot from MongoDB.
 */
export async function removeWorkerBot(botId) {
  const coll = await getCollection('worker_bots');
  await coll.deleteOne({ botId: String(botId) });
  workerBotsCache.delete(String(botId));
  return { ok: true };
}

/**
 * Registers webhooks for all active worker bots on server launch.
 */
export async function registerAllWorkerWebhooks(domain, secretToken) {
  if (!domain) return;
  const formattedDomain = domain.startsWith('http://') || domain.startsWith('https://') ? domain : `https://${domain}`;
  const allWorkers = await getAllWorkerBots();

  for (const w of allWorkers) {
    if (!w.enabled) continue;
    const webhookUrl = `${formattedDomain}/webhook/worker/${w.botId}`;
    try {
      const body = {
        url: webhookUrl,
        allowed_updates: ['message', 'callback_query']
      };
      if (secretToken) body.secret_token = secretToken;

      const res = await fetch(`https://api.telegram.org/bot${w.token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.ok) {
        log('info', `Worker bot @${w.username || w.botId} registered webhook`, { webhookUrl });
      } else {
        log('warn', `Worker bot @${w.username || w.botId} webhook failed`, { error: data.description });
      }
    } catch (err) {
      log('error', `Error registering webhook for worker ${w.botId}`, { error: err.message });
    }
  }
}

/**
 * Retrieves configured Relay Tunnel Chat ID (a private transit group/channel)
 * where Main Bot and Worker Bots meet for air-gapped deliveries.
 */
export async function getRelayChatId() {
  const s = await getSettings();
  return s?.relayChatId || process.env.RELAY_CHAT_ID || null;
}

/**
 * Executes an Air-Gapped media delivery through the Relay Tunnel:
 * 1. Main Bot (with DB channel permissions) copies media into Relay Tunnel.
 * 2. Worker Bot (with worker token) copies media from Relay Tunnel to User.
 * 3. Immediate cleanup: deletes transit message from Relay Tunnel.
 *
 * Result: User receives media from @WorkerBot, while the Main DB Channel
 * never contains any worker bots!
 */
export async function deliverViaRelayTunnel(toChatId, dbChannelId, dbMessageId, protectContent = false) {
  const relayChatId = await getRelayChatId();
  if (!relayChatId) return { ok: false, reason: 'relay_not_configured' };

  const { copyMessage } = await import('./bot-helpers.js');
  const { deleteTelegramMessage } = await import('./bot-common.js');

  // Step 1: Main Bot copies media from protected DB Channel to the Relay Tunnel
  const transitRes = await botContext.run({ token: getMainToken() }, () =>
    copyMessage(relayChatId, dbChannelId, dbMessageId, false)
  );

  if (!transitRes?.ok || !transitRes?.messageId) {
    log('error', 'Relay transit copy failed', { relayChatId, dbChannelId, dbMessageId, reason: transitRes?.reason });
    return { ok: false, reason: transitRes?.reason || 'transit_copy_failed' };
  }

  const transitMsgId = transitRes.messageId;

  try {
    // Step 2: Worker Bot copies media from Relay Tunnel directly to User
    const workerRes = await copyMessage(toChatId, relayChatId, transitMsgId, protectContent);

    // Step 3: Delete the intermediate transit message from the Relay Tunnel immediately
    deleteTelegramMessage(relayChatId, transitMsgId).catch(() => {});

    return workerRes;
  } catch (err) {
    // Ensure cleanup even on error
    deleteTelegramMessage(relayChatId, transitMsgId).catch(() => {});
    return { ok: false, reason: err.message };
  }
}

/**
 * Sequences a batch of messages through the Relay Tunnel:
 * For each message in the batch:
 *   Main Bot copies to Relay -> Worker Bot copies to User -> Transit message deleted.
 */
export async function deliverBatchViaRelayTunnel(toChatId, dbChannelId, msgIds, backupDbChannelId, backupMsgIds, protectContent = false, onProgress = null) {
  const relayChatId = await getRelayChatId();
  if (!relayChatId) return { ok: false, reason: 'relay_not_configured', sentMessageIds: [] };

  const { copyMessage } = await import('./bot-helpers.js');
  const { deleteTelegramMessage } = await import('./bot-common.js');

  const sentMessageIds = [];
  const totalCount = msgIds.length;
  let failedCount = 0;

  for (let i = 0; i < msgIds.length; i++) {
    const srcMsgId = msgIds[i];
    let transitRes = await botContext.run({ token: getMainToken() }, () =>
      copyMessage(relayChatId, dbChannelId, srcMsgId, false)
    );

    // If primary DB message failed and backup is configured, try backup
    if ((!transitRes?.ok || !transitRes?.messageId) && backupDbChannelId && Array.isArray(backupMsgIds) && backupMsgIds[i]) {
      transitRes = await botContext.run({ token: getMainToken() }, () =>
        copyMessage(relayChatId, backupDbChannelId, backupMsgIds[i], false)
      );
    }

    if (transitRes?.ok && transitRes?.messageId) {
      const transitMsgId = transitRes.messageId;
      try {
        const workerRes = await copyMessage(toChatId, relayChatId, transitMsgId, protectContent);
        deleteTelegramMessage(relayChatId, transitMsgId).catch(() => {});
        if (workerRes?.ok && workerRes?.messageId) {
          sentMessageIds.push(workerRes.messageId);
        } else {
          failedCount++;
        }
      } catch {
        deleteTelegramMessage(relayChatId, transitMsgId).catch(() => {});
        failedCount++;
      }
    } else {
      failedCount++;
    }

    if (typeof onProgress === 'function') {
      await onProgress(sentMessageIds.length + failedCount, totalCount).catch(() => {});
    }

    if (totalCount > 3) {
      await new Promise(r => setTimeout(r, 60));
    }
  }

  return { ok: sentMessageIds.length > 0, sentMessageIds, failedCount };
}
