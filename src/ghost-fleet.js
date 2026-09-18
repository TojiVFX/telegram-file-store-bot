/**
 * src/ghost-fleet.js — Ghost Fleet worker bots management, circuit breaker, and dispatch.
 *
 * ─── Multi-Instance State Strategy ───────────────────────────────────────────
 * 1. worker_bots MongoDB collection: Source of truth for registered worker bots.
 * 2. workerBotsCache / lastWorkersRefresh:
 *    - Purpose: In-memory cache of verified workers to avoid continuous `getMe` HTTP calls
 *      on every media delivery.
 *    - Multi-instance behavior: TTL is 30 seconds (`WORKER_CACHE_TTL_MS = 30_000`). Instances
 *      automatically sync worker changes from MongoDB every 30s.
 * 3. lastWorkerIndex: Local round-robin index. Acceptable per-instance to distribute load.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import crypto from 'crypto';
import {
  getCollection, getSettings, updateSettings, log, getMainToken, botContext, toSmallCaps, esc,
  sendTelegramMessage, deleteTelegramMessage, copyMessage, getCurrentBotId, copyTelegramMessages,
  deleteTelegramMessages
} from './bot-common.js';
import { getAdminIds } from './auth.js';

// Cache of verified worker bots: Map<botId, { token, username, firstName, isAlive, lastChecked }>
const workerBotsCache = new Map();
let lastWorkerIndex = 0;
const WORKER_CACHE_TTL_MS = 30_000; // 30 seconds
let lastWorkersRefresh = 0;

/**
 * Parses worker bot tokens from environment variable (WORKER_BOT_TOKENS=token1,token2).
 */
export function getEnvWorkerTokens() {
  const raw = (process.env.WORKER_BOT_TOKENS || '').trim();
  if (!raw) return [];
  return raw.split(/[\s,;]+/).map(t => t.trim().replace(/^bot/i, '')).filter(Boolean);
}

/**
 * Parses standby reserve worker tokens from environment variable (STANDBY_WORKER_TOKENS=token1,token2).
 */
export function getEnvStandbyTokens() {
  const raw = (process.env.STANDBY_WORKER_TOKENS || '').trim();
  if (!raw) return [];
  return raw.split(/[\s,;]+/).map(t => t.trim().replace(/^bot/i, '')).filter(Boolean);
}

/**
 * Retrieves all configured worker bots from both .env and MongoDB collection `worker_bots`.
 */
export async function getAllWorkerBots() {
  const envTokens = getEnvWorkerTokens();
  const envStandbyTokens = getEnvStandbyTokens();
  const coll = await getCollection('worker_bots');
  const dbBots = await coll.find({}).toArray();

  const botsMap = new Map();

  // Add env-configured active tokens
  for (const token of envTokens) {
    const botId = token.split(':')[0];
    if (botId) {
      botsMap.set(botId, {
        botId,
        token,
        source: 'env',
        role: 'active',
        circuitState: 'HEALTHY',
        enabled: true,
        createdAt: new Date()
      });
    }
  }

  // Add env-configured standby tokens
  for (const token of envStandbyTokens) {
    const botId = token.split(':')[0];
    if (botId) {
      botsMap.set(botId, {
        botId,
        token,
        source: 'env',
        role: 'standby',
        circuitState: 'HEALTHY',
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
        role: b.role || 'active',
        circuitState: b.circuitState || 'HEALTHY',
        cooldownUntil: b.cooldownUntil || null,
        failureCount: b.failureCount || 0,
        enabled: b.enabled !== false,
        isAlive: b.isAlive !== false,
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
  lastWorkersRefresh = Date.now();
  const all = await getAllWorkerBots();
  for (const w of all) {
    if (!w.enabled) continue;
    const v = await verifyWorkerBot(w.token);
    const existing = workerBotsCache.get(w.botId);
    if (v.ok) {
      workerBotsCache.set(w.botId, {
        botId: w.botId,
        token: w.token,
        username: v.username,
        firstName: v.firstName,
        role: existing?.role || w.role || 'active',
        circuitState: existing?.circuitState || w.circuitState || 'HEALTHY',
        cooldownUntil: existing?.cooldownUntil || w.cooldownUntil || null,
        failureCount: existing?.failureCount || w.failureCount || 0,
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
      const isBanned = String(v.reason || '').toLowerCase().includes('deactivated') ||
                       String(v.reason || '').toLowerCase().includes('terminated') ||
                       String(v.reason || '').toLowerCase().includes('revoked') ||
                       String(v.reason || '').toLowerCase().includes('unauthorized');
      workerBotsCache.set(w.botId, {
        botId: w.botId,
        token: w.token,
        username: w.username || 'Unknown',
        firstName: w.firstName || 'Worker',
        role: existing?.role || w.role || 'active',
        circuitState: isBanned ? 'BANNED' : (existing?.circuitState || w.circuitState || 'HEALTHY'),
        isAlive: false,
        lastChecked: Date.now(),
        error: v.reason
      });
      log('warn', `Worker bot ${w.botId} failed health check`, { reason: v.reason, isBanned });
    }
  }
}

/**
 * Reports a failure on a worker bot to trigger Circuit Breaker protection.
 */
export function reportWorkerFailure(botId, statusCode, reason = '', retryAfterSec = 60) {
  const id = String(botId);
  const w = workerBotsCache.get(id);
  const isBan = (statusCode === 403 || statusCode === 401) &&
    (String(reason).toLowerCase().includes('deactivated') ||
     String(reason).toLowerCase().includes('terminated') ||
     String(reason).toLowerCase().includes('revoked') ||
     String(reason).toLowerCase().includes('unauthorized'));

  if (w) {
    w.failureCount = (w.failureCount || 0) + 1;
    if (isBan) {
      w.circuitState = 'BANNED';
      w.isAlive = false;
      w.bannedReason = reason;
      log('warn', `Worker bot ${id} marked BANNED by circuit breaker: ${reason}`);
      getCollection('worker_bots').then(coll =>
        coll.updateOne({ botId: id }, { $set: { circuitState: 'BANNED', isAlive: false, bannedReason: reason, bannedAt: new Date() } })
      ).catch(() => {});
      // Autonomous hot-swap standby worker
      hotSwapStandbyWorker().catch(() => {});
    } else if (statusCode === 429) {
      const waitTime = Number(retryAfterSec) || 60;
      w.circuitState = 'COOLDOWN';
      w.cooldownUntil = Date.now() + waitTime * 1000;
      log('warn', `Worker bot ${id} entered COOLDOWN for ${waitTime}s`);
      if (w.failureCount >= 3) {
        hotSwapStandbyWorker().catch(() => {});
      }
    }
  }
}

/**
 * Reports a successful operation to reset failure counts.
 */
export function reportWorkerSuccess(botId) {
  const id = String(botId);
  const w = workerBotsCache.get(id);
  if (w) {
    w.failureCount = 0;
    if (w.circuitState === 'COOLDOWN' && (!w.cooldownUntil || w.cooldownUntil <= Date.now())) {
      w.circuitState = 'HEALTHY';
    }
  }
}

/**
 * Hot-swaps an idle Standby Worker into active delivery rotation.
 */
export async function hotSwapStandbyWorker() {
  const all = await getAllWorkerBots();
  const standby = all.find(w => w.role === 'standby' && w.enabled && w.circuitState !== 'BANNED');
  if (!standby) {
    log('warn', 'hotSwapStandbyWorker: No standby worker bots available in reserve pool.');
    return { ok: false, reason: 'no_standby_available' };
  }

  const verify = await verifyWorkerBot(standby.token);
  if (!verify.ok) {
    log('error', `Standby worker ${standby.botId} failed verification: ${verify.reason}`);
    return { ok: false, reason: verify.reason };
  }

  const coll = await getCollection('worker_bots');
  await coll.updateOne(
    { botId: standby.botId },
    {
      $set: {
        role: 'active',
        circuitState: 'HEALTHY',
        isAlive: true,
        promotedAt: new Date(),
        username: verify.username,
        firstName: verify.firstName
      }
    },
    { upsert: true }
  );

  workerBotsCache.set(standby.botId, {
    botId: standby.botId,
    token: standby.token,
    username: verify.username,
    firstName: verify.firstName,
    role: 'active',
    circuitState: 'HEALTHY',
    isAlive: true,
    lastChecked: Date.now()
  });

  // Register webhook for newly promoted worker if webhook domain configured
  const s = await getSettings();
  if (s?.webhookDomain) {
    const formattedDomain = s.webhookDomain.startsWith('http') ? s.webhookDomain : `https://${s.webhookDomain}`;
    const webhookUrl = `${formattedDomain}/webhook/worker/${standby.botId}`;
    try {
      await fetch(`https://api.telegram.org/bot${standby.token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query'] })
      });
    } catch {}
  }

  // Notify admin
  try {
    const adminIds = getAdminIds();
    const alertText = `🔄 <b>Ghost Fleet Worker Hot-Swap Activated!</b>\n\n` +
      `Standby Worker <b>@${esc(verify.username || standby.botId)}</b> has been automatically promoted to active delivery rotation!\n\n` +
      `• Worker ID: <code>${standby.botId}</code>\n` +
      `• Circuit Status: <b>HEALTHY</b>\n` +
      `• Delivery capability: <b>Online</b>`;
    for (const aid of adminIds) {
      await sendTelegramMessage(aid, alertText).catch(() => {});
    }
  } catch {}

  log('info', `Standby worker ${standby.botId} hot-swapped into active rotation`);
  return { ok: true, worker: { ...standby, username: verify.username } };
}

/**
 * Selects the next healthy worker bot from the active pool using Round-Robin.
 */
export async function getNextWorkerBot() {
  const now = Date.now();
  if (workerBotsCache.size === 0 || (now - lastWorkersRefresh) > WORKER_CACHE_TTL_MS) {
    await refreshWorkerBots();
  }
  let healthyWorkers = Array.from(workerBotsCache.values()).filter(w =>
    w.isAlive &&
    w.token &&
    w.role !== 'standby' &&
    w.circuitState !== 'BANNED' &&
    (!w.cooldownUntil || w.cooldownUntil <= now)
  );

  if (healthyWorkers.length === 0) {
    const swapRes = await hotSwapStandbyWorker();
    if (swapRes.ok) {
      healthyWorkers = Array.from(workerBotsCache.values()).filter(w =>
        w.isAlive &&
        w.token &&
        w.role !== 'standby' &&
        w.circuitState !== 'BANNED' &&
        (!w.cooldownUntil || w.cooldownUntil <= now)
      );
    }
  }

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

// In-flight batch pre-staging promises: Map<dispatchToken, Promise<{ ok, stagedIds }>>
const inFlightStagings = new Map();

/**
 * Registers an in-flight background staging promise so worker bots can await it.
 */
export function registerInFlightStaging(dispatchToken, promise) {
  if (!dispatchToken || !promise) return;
  inFlightStagings.set(dispatchToken, promise);
  promise.finally(() => {
    // Keep in cache for 30s to satisfy rapid consecutive worker requests, then delete
    setTimeout(() => inFlightStagings.delete(dispatchToken), 30_000);
  });
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
    stagingStatus: targetCode?.startsWith('batch_') ? 'in_progress' : 'none',
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
 * Awaits any in-flight pre-staging to eliminate duplicate tunnel staging.
 */
export async function consumeDispatchToken(rawToken, userId) {
  const clean = (rawToken || '').replace(/^dispatch_/i, '').trim();
  const tokenKey = `dispatch:${clean}`;
  const sessions = await getCollection('sessions');

  // 1. If in-flight pre-staging is currently executing in this process, await it!
  if (inFlightStagings.has(clean)) {
    try {
      await inFlightStagings.get(clean);
    } catch {}
  }

  // 2. Atomically increment useCount if within limits
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

  let doc = res?.value || res;

  // 3. Fallback poll (up to 12 seconds) if staging was marked in_progress but stagedTransitMsgIds not yet present in doc
  if (doc && (!Array.isArray(doc.stagedTransitMsgIds) || doc.stagedTransitMsgIds.length === 0) && doc.stagingStatus === 'in_progress') {
    const startWait = Date.now();
    while (Date.now() - startWait < 12000) {
      await new Promise(r => setTimeout(r, 200));
      const fresh = await sessions.findOne({ _id: tokenKey });
      if (fresh?.stagedTransitMsgIds && Array.isArray(fresh.stagedTransitMsgIds) && fresh.stagedTransitMsgIds.length > 0) {
        doc.stagedTransitMsgIds = fresh.stagedTransitMsgIds;
        doc.stagingStatus = fresh.stagingStatus;
        break;
      }
      if (fresh?.stagingStatus === 'failed') break;
    }
  }

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
    role: 'active',
    circuitState: 'HEALTHY',
    isAlive: true,
    lastChecked: Date.now()
  });

  return { ok: true, worker: verifyRes };
}

/**
 * Adds a new standby reserve worker bot into MongoDB.
 */
export async function addStandbyWorkerBot(token) {
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
        role: 'standby',
        circuitState: 'HEALTHY',
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
    role: 'standby',
    circuitState: 'HEALTHY',
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

// ─── Relay Transit Tracking & Auto-Cleaner ──────────────────────────────────
const inFlightTransits = new Map();

export async function trackRelayTransit(relayChatId, messageId, ttlSeconds = 600) {
  const key = `${relayChatId}:${messageId}`;
  const ttlMs = ttlSeconds * 1000;
  inFlightTransits.set(key, {
    relayChatId: String(relayChatId),
    messageId: Number(messageId),
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs
  });

  try {
    const coll = await getCollection('relay_transits');
    await coll.insertOne({
      _id: key,
      relayChatId: String(relayChatId),
      messageId: Number(messageId),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + ttlMs)
    }).catch(() => {});
  } catch {}
}

export async function untrackRelayTransit(relayChatId, messageId) {
  const key = `${relayChatId}:${messageId}`;
  inFlightTransits.delete(key);
  try {
    const coll = await getCollection('relay_transits');
    await coll.deleteOne({ _id: key }).catch(() => {});
  } catch {}
}

export async function sweepRelayOrphans() {
  const now = Date.now();

  // 1. In-memory map sweep
  for (const [key, item] of inFlightTransits.entries()) {
    if (item.expiresAt <= now) {
      inFlightTransits.delete(key);
      await deleteTelegramMessage(item.relayChatId, item.messageId).catch(() => {});
    }
  }

  // 2. Database collection sweep (catches orphans across restarts)
  try {
    const coll = await getCollection('relay_transits');
    const expiredDocs = await coll.find({ expiresAt: { $lte: new Date(now) } }).toArray();
    for (const doc of expiredDocs) {
      await coll.deleteOne({ _id: doc._id }).catch(() => {});
      await deleteTelegramMessage(doc.relayChatId, doc.messageId).catch(() => {});
    }
  } catch {}
}
setInterval(sweepRelayOrphans, 2 * 60 * 1000).unref?.();

/**
 * Autonomous Ghost Fleet Heartbeat:
 * Proactively verifies all active worker bots every 15 minutes.
 * If any worker bot has been banned or revoked by Telegram, it autonomously
 * drops the dead node and hot-swaps an idle Standby Worker into active rotation,
 * preventing users from encountering broken dispatch links.
 */
export async function runGhostFleetHeartbeat() {
  try {
    const active = await isGhostFleetEnabled();
    if (!active) return;

    const all = await getAllWorkerBots();
    const activeWorkers = all.filter(w => w.role !== 'standby' && w.enabled && w.circuitState !== 'BANNED');

    for (const w of activeWorkers) {
      const v = await verifyWorkerBot(w.token);
      if (!v.ok) {
        const isBanned = String(v.reason || '').toLowerCase().includes('deactivated') ||
                         String(v.reason || '').toLowerCase().includes('terminated') ||
                         String(v.reason || '').toLowerCase().includes('revoked') ||
                         String(v.reason || '').toLowerCase().includes('unauthorized');

        log('warn', `Ghost Fleet Heartbeat: Active Worker Bot ${w.botId} (@${w.username || 'unknown'}) failed probe`, { reason: v.reason, isBanned });

        workerBotsCache.set(w.botId, {
          ...w,
          circuitState: isBanned ? 'BANNED' : 'OFFLINE',
          isAlive: false,
          lastChecked: Date.now(),
          error: v.reason
        });

        const coll = await getCollection('worker_bots');
        await coll.updateOne(
          { botId: w.botId },
          { $set: { circuitState: isBanned ? 'BANNED' : 'OFFLINE', isAlive: false, lastChecked: new Date(), error: v.reason } }
        ).catch(() => {});

        // Proactively hot-swap standby reserve worker to take over
        const swapRes = await hotSwapStandbyWorker();

        // Alert administrators immediately
        try {
          const adminIds = getAdminIds();
          const alertMsg = `🛡️ <b>Ghost Fleet Autonomous Heartbeat Alert</b>\n\n` +
            `Active Worker Bot <b>@${esc(w.username || w.botId)}</b> failed Telegram API health probe: <i>${esc(v.reason)}</i>.\n\n` +
            (swapRes?.ok
              ? `✅ <b>Hot-Swap Successful:</b> Standby Worker <b>@${esc(swapRes.worker?.username || swapRes.worker?.botId)}</b> has been automatically promoted to active delivery rotation!`
              : `⚠️ <b>No Standby Available:</b> Please add a new worker bot in <b>/setting > Ghost Fleet</b>.`);

          for (const aid of adminIds) {
            await sendTelegramMessage(aid, alertMsg).catch(() => {});
          }
        } catch {}
      }
    }
  } catch (err) {
    log('warn', 'runGhostFleetHeartbeat error', { error: err.message });
  }
}

setInterval(runGhostFleetHeartbeat, 15 * 60 * 1000).unref?.();

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

  // Step 1: Main Bot copies media from protected DB Channel to the Relay Tunnel
  const transitRes = await botContext.run({ token: getMainToken() }, () =>
    copyMessage(relayChatId, dbChannelId, dbMessageId, false)
  );

  if (!transitRes?.ok || !transitRes?.messageId) {
    log('error', 'Relay transit copy failed', { relayChatId, dbChannelId, dbMessageId, reason: transitRes?.reason });
    return { ok: false, reason: transitRes?.reason || 'transit_copy_failed' };
  }

  const transitMsgId = transitRes.messageId;
  await trackRelayTransit(relayChatId, transitMsgId);

  try {
    // Step 2: Worker Bot copies media from Relay Tunnel directly to User
    const workerRes = await copyMessage(toChatId, relayChatId, transitMsgId, protectContent);

    // Step 3: Delete the intermediate transit message from the Relay Tunnel immediately
    await untrackRelayTransit(relayChatId, transitMsgId);
    deleteTelegramMessage(relayChatId, transitMsgId).catch(() => {});

    const curBotId = getCurrentBotId();
    if (workerRes?.ok) {
      if (curBotId) reportWorkerSuccess(curBotId);
    } else {
      if (curBotId) {
        const desc = workerRes?.reason || '';
        const status = workerRes?.telegramError?.error_code || 400;
        reportWorkerFailure(curBotId, status, desc, workerRes?.telegramError?.parameters?.retry_after);
      }
    }

    return workerRes;
  } catch (err) {
    // Ensure cleanup even on error
    await untrackRelayTransit(relayChatId, transitMsgId);
    deleteTelegramMessage(relayChatId, transitMsgId).catch(() => {});
    return { ok: false, reason: err.message };
  }
}

/**
 * Pre-stages a batch of messages into the Relay Tunnel when a dispatch token is minted on the Main Bot.
 * This ensures the files are already sitting in the Relay Tunnel when the user opens the Worker Bot.
 * Staged messages have a 10-minute TTL (matching dispatch token lifetime).
 */
export async function preStageBatchForDispatch(dispatchToken, batch) {
  try {
    const relayChatId = await getRelayChatId();
    if (!relayChatId || !batch) return { ok: false, reason: 'not_applicable' };

    const dbChannelId = batch.dbChannelId || await getDbChannelId();
    const { backupDbChannelId, backupDbMessageIds } = batch;
    const rawMsgIds = Array.isArray(batch.dbMessageIds)
      ? batch.dbMessageIds
      : (batch.dbFirstMsgId && batch.dbLastMsgId
          ? Array.from({ length: batch.dbLastMsgId - batch.dbFirstMsgId + 1 }, (_, i) => batch.dbFirstMsgId + i)
          : []);

    if (!rawMsgIds.length) return { ok: false, reason: 'no_messages' };

    // Deduplicate and strictly sort ascending for Telegram copyMessages API compliance
    const msgIds = [...new Set(rawMsgIds.filter(id => id != null && !isNaN(id)).map(Number))].sort((a, b) => a - b);
    const stagedIds = [];
    const CHUNK_SIZE = 100;

    for (let i = 0; i < msgIds.length; i += CHUNK_SIZE) {
      const chunk = msgIds.slice(i, i + CHUNK_SIZE);

      let stageRes = await botContext.run({ token: getMainToken() }, () =>
        copyTelegramMessages(relayChatId, dbChannelId, chunk, false)
      );

      if (stageRes?.ok && Array.isArray(stageRes.messageIds) && stageRes.messageIds.length > 0) {
        for (const mid of stageRes.messageIds) {
          stagedIds.push(mid);
          await trackRelayTransit(relayChatId, mid, 600); // 10 minutes TTL
        }
      } else {
        // Fallback: item-by-item staging with backup DB failover and pacing
        log('warn', 'preStageBatchForDispatch: bulk stage failed, using paced item staging', {
          relayChatId, dbChannelId, count: chunk.length, reason: stageRes?.reason
        });
        for (let j = 0; j < chunk.length; j++) {
          const globalIdx = i + j;
          const srcMsgId = chunk[j];
          let transitRes = await botContext.run({ token: getMainToken() }, () =>
            copyMessage(relayChatId, dbChannelId, srcMsgId, false)
          );

          if ((!transitRes?.ok || !transitRes?.messageId) && backupDbChannelId && Array.isArray(backupDbMessageIds) && backupDbMessageIds[globalIdx]) {
            transitRes = await botContext.run({ token: getMainToken() }, () =>
              copyMessage(relayChatId, backupDbChannelId, backupDbMessageIds[globalIdx], false)
            );
          }

          if (transitRes?.ok && transitRes?.messageId) {
            stagedIds.push(transitRes.messageId);
            await trackRelayTransit(relayChatId, transitRes.messageId, 600);
          }
          if (chunk.length > 1) {
            await new Promise(r => setTimeout(r, 350));
          }
        }
      }
    }

    if (stagedIds.length > 0) {
      const sessions = await getCollection('sessions');
      await sessions.updateOne(
        { _id: `dispatch:${dispatchToken}` },
        {
          $set: {
            stagedTransitMsgIds: stagedIds,
            stagedRelayChatId: String(relayChatId),
            stagingStatus: 'completed',
            stagedAt: new Date()
          }
        }
      );
      log('info', 'Pre-staged batch into relay tunnel for dispatch', { dispatchToken, stagedCount: stagedIds.length });
      return { ok: true, stagedCount: stagedIds.length, stagedIds };
    }

    const sessions = await getCollection('sessions');
    await sessions.updateOne(
      { _id: `dispatch:${dispatchToken}` },
      { $set: { stagingStatus: 'failed' } }
    ).catch(() => {});
    return { ok: false, reason: 'staging_failed' };
  } catch (err) {
    const sessions = await getCollection('sessions').catch(() => null);
    if (sessions) {
      sessions.updateOne(
        { _id: `dispatch:${dispatchToken}` },
        { $set: { stagingStatus: 'failed' } }
      ).catch(() => {});
    }
    log('warn', 'preStageBatchForDispatch failed', { dispatchToken, error: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Delivers a batch of messages through the Air-Gapped Relay Tunnel.
 * Supports pre-staged messages (instant blast) or on-the-fly bulk staging + blast.
 */
export async function deliverBatchViaRelayTunnel(toChatId, dbChannelId, msgIds, backupDbChannelId, backupMsgIds, protectContent = false, onProgress = null, preStagedTransitIds = null) {
  const relayChatId = await getRelayChatId();
  if (!relayChatId) return { ok: false, reason: 'relay_not_configured', sentMessageIds: [], healedIndices: [] };

  const effectiveDbChannelId = dbChannelId || await getDbChannelId();
  const sentMessageIds = [];
  const totalCount = msgIds.length;
  const healedIndices = [];
  let failedCount = 0;

  // ─── Fast Blast: Messages already pre-staged in Relay Tunnel! ─────────────
  if (Array.isArray(preStagedTransitIds) && preStagedTransitIds.length > 0) {
    const transitMsgIds = [...new Set(preStagedTransitIds.filter(id => id != null && !isNaN(id)).map(Number))].sort((a, b) => a - b);
    log('info', 'Blasting pre-staged batch from relay tunnel to user at once', { count: transitMsgIds.length });

    const CHUNK_SIZE = 100;
    for (let i = 0; i < transitMsgIds.length; i += CHUNK_SIZE) {
      const chunk = transitMsgIds.slice(i, i + CHUNK_SIZE);
      let blastRes = await copyTelegramMessages(toChatId, relayChatId, chunk, protectContent);
      if (blastRes?.ok && Array.isArray(blastRes.messageIds) && blastRes.messageIds.length > 0) {
        sentMessageIds.push(...blastRes.messageIds);
      } else {
        // Fallback: copy individually if bulk copy encounters an error
        for (const transitId of chunk) {
          const res = await copyMessage(toChatId, relayChatId, transitId, protectContent);
          if (res?.ok && res?.messageId) {
            sentMessageIds.push(res.messageId);
          }
          if (chunk.length > 1) {
            await new Promise(r => setTimeout(r, 350));
          }
        }
      }
    }

    // Clean up transit messages from Relay Tunnel immediately
    for (const transitId of transitMsgIds) {
      untrackRelayTransit(relayChatId, transitId).catch(() => {});
    }
    botContext.run({ token: getMainToken() }, () =>
      deleteTelegramMessages(relayChatId, transitMsgIds)
    ).catch(() => {});

    if (sentMessageIds.length >= totalCount) {
      if (typeof onProgress === 'function') {
        await onProgress(totalCount, totalCount).catch(() => {});
      }
      return { ok: true, sentMessageIds, failedCount: 0, healedIndices };
    }
    log('warn', 'Pre-staged blast delivered partial files; continuing to on-the-fly staging', {
      delivered: sentMessageIds.length,
      total: totalCount
    });
  }

  // ─── Fallback: On-the-fly Bulk Transit Staging & Instant Blast ───────────
  // When files are not pre-staged or pre-staged blast had missing items, bulk-stage
  // remaining files into Relay Tunnel and blast to user in chunks of 100.
  const remainingMsgIds = msgIds.slice(sentMessageIds.length);
  const sortedMsgIds = [...new Set(remainingMsgIds.filter(id => id != null && !isNaN(id)).map(Number))].sort((a, b) => a - b);
  const CHUNK_SIZE = 100;

  for (let i = 0; i < sortedMsgIds.length; i += CHUNK_SIZE) {
    const chunk = sortedMsgIds.slice(i, i + CHUNK_SIZE);
    let chunkDelivered = false;

    // Step 1: Main Bot bulk-copies the chunk into Relay Tunnel (1 fast API call)
    let stageRes = await botContext.run({ token: getMainToken() }, () =>
      copyTelegramMessages(relayChatId, effectiveDbChannelId, chunk, false)
    );

    if (stageRes?.ok && Array.isArray(stageRes.messageIds) && stageRes.messageIds.length > 0) {
      const transitMsgIds = stageRes.messageIds;

      // Step 2: Worker Bot immediately bulk-blasts the files from Relay Tunnel to User (1 fast API call)
      let blastRes = await copyTelegramMessages(toChatId, relayChatId, transitMsgIds, protectContent);
      if (blastRes?.ok && Array.isArray(blastRes.messageIds) && blastRes.messageIds.length === transitMsgIds.length) {
        sentMessageIds.push(...blastRes.messageIds);
        chunkDelivered = true;
      } else {
        // Partial or failed blast: copy individually with safe pacing
        for (const tId of transitMsgIds) {
          const res = await copyMessage(toChatId, relayChatId, tId, protectContent);
          if (res?.ok && res?.messageId) {
            sentMessageIds.push(res.messageId);
          }
          if (transitMsgIds.length > 1) {
            await new Promise(r => setTimeout(r, 350));
          }
        }
        if (blastRes?.messageIds?.length > 0) {
          chunkDelivered = true;
        }
      }

      // Step 3: Purge transit messages from Relay Tunnel immediately in 1 call
      botContext.run({ token: getMainToken() }, () =>
        deleteTelegramMessages(relayChatId, transitMsgIds)
      ).catch(() => {});
    }

    // Step 4: Direct Bulk Failover if Relay Tunnel was unviable (avoids 48 slow calls & 429)
    if (!chunkDelivered) {
      log('warn', 'Relay tunnel transit unviable for chunk; executing direct bulk delivery fallback', {
        relayChatId, effectiveDbChannelId, count: chunk.length, stageReason: stageRes?.reason
      });

      let directRes = await botContext.run({ token: getMainToken() }, () =>
        copyTelegramMessages(toChatId, effectiveDbChannelId, chunk, protectContent)
      );

      if (directRes?.ok && Array.isArray(directRes.messageIds) && directRes.messageIds.length === chunk.length) {
        sentMessageIds.push(...directRes.messageIds);
      } else {
        // Item-by-item recovery with backup DB failover
        for (let j = 0; j < chunk.length; j++) {
          const srcMsgId = chunk[j];
          const globalIdx = msgIds.indexOf(srcMsgId);
          let res = await botContext.run({ token: getMainToken() }, () =>
            copyMessage(toChatId, effectiveDbChannelId, srcMsgId, protectContent)
          );

          if ((!res?.ok || !res?.messageId) && backupDbChannelId && Array.isArray(backupMsgIds) && globalIdx >= 0 && backupMsgIds[globalIdx]) {
            const bRes = await botContext.run({ token: getMainToken() }, () =>
              copyMessage(toChatId, backupDbChannelId, backupMsgIds[globalIdx], protectContent)
            );
            if (bRes?.ok && bRes?.messageId) {
              res = bRes;
              healedIndices.push({ index: globalIdx, backupMsgId: backupMsgIds[globalIdx], backupChannelId: backupDbChannelId });
            }
          }

          if (res?.ok && res?.messageId) {
            sentMessageIds.push(res.messageId);
          } else {
            failedCount++;
          }
          if (chunk.length > 1) {
            await new Promise(r => setTimeout(r, 350));
          }
        }
      }
    }

    if (typeof onProgress === 'function') {
      await onProgress(sentMessageIds.length + failedCount, totalCount).catch(() => {});
    }
  }

  return { ok: sentMessageIds.length > 0, sentMessageIds, failedCount, healedIndices };
}

/**
 * Live diagnostic benchmark tool:
 * Probes the Air-Gapped Relay Tunnel end-to-end:
 * 1. Main Bot sends a probe message to Relay Tunnel.
 * 2. Worker Bot reads/copies the probe message.
 * 3. Cleans up all probe messages immediately.
 * Returns exact transit latency (ms) and permissions verification.
 */
export async function benchmarkRelayTunnel() {
  const relayChatId = await getRelayChatId();
  if (!relayChatId) {
    return { ok: false, error: 'Relay Tunnel is not configured. Please set a Relay Chat ID first.' };
  }

  const workers = await getAllWorkerBots();
  const activeWorker = workers.find(w => w.enabled && w.isAlive !== false);
  if (!activeWorker) {
    return { ok: false, error: 'No active worker bots found to test relay transit.' };
  }

  const startTotal = Date.now();
  let probeMsgId = null;

  try {
    // Step 1: Main Bot sends probe message to Relay Tunnel
    const t0 = Date.now();
    const probeRes = await botContext.run({ token: getMainToken() }, () =>
      sendTelegramMessage(relayChatId, `🧪 <b>Relay Tunnel Probe</b>\n<code>${Date.now()}</code>`, null, false, 1, true, false)
    );
    const step1Time = Date.now() - t0;

    if (!probeRes?.ok || !probeRes?.messageId) {
      const desc = probeRes?.detail?.description || probeRes?.reason || 'Failed to post to relay chat';
      return {
        ok: false,
        step: 'Main Bot Post',
        error: `Main Bot could not send message to Relay chat: ${desc}. Make sure Main Bot is admin with Post Messages permission.`
      };
    }
    probeMsgId = probeRes.messageId;

    // Step 2: Test Worker Bot accessing the probe in the Relay chat
    const t1 = Date.now();
    let workerCopyRes = null;
    await botContext.run({ token: activeWorker.token }, async () => {
      workerCopyRes = await copyMessage(relayChatId, relayChatId, probeMsgId, false, null, 1);
    });
    const step2Time = Date.now() - t1;

    if (workerCopyRes?.ok && workerCopyRes?.messageId) {
      await deleteTelegramMessage(relayChatId, workerCopyRes.messageId).catch(() => {});
    }

    // Step 3: Delete initial probe message
    await deleteTelegramMessage(relayChatId, probeMsgId).catch(() => {});
    probeMsgId = null;

    const totalTime = Date.now() - startTotal;

    if (!workerCopyRes?.ok) {
      const desc = workerCopyRes?.reason || 'Worker Bot cannot read or copy from relay';
      return {
        ok: false,
        step: 'Worker Bot Access',
        error: `Worker Bot (@${activeWorker.username || activeWorker.botId}) could not read from Relay chat: ${desc}. Make sure Worker Bot is a member/admin in the Relay chat.`
      };
    }

    return {
      ok: true,
      relayChatId,
      workerUsername: activeWorker.username || activeWorker.botId,
      totalLatencyMs: totalTime,
      mainPostLatencyMs: step1Time,
      workerTransitLatencyMs: step2Time
    };
  } catch (err) {
    if (probeMsgId) {
      await deleteTelegramMessage(relayChatId, probeMsgId).catch(() => {});
    }
    return { ok: false, error: err.message };
  }
}

