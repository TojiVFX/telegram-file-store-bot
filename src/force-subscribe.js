import {
  getCollection, getSettings, log, esc,
  getChatMember, getChat, createChatInviteLink,
  botContext, toSmallCaps, getMainToken, sendTelegramMessage
} from './bot-common.js';
import { getAdminId } from './auth.js';

export function getForceSubChannelsList(forceSubscribeChannelsRaw, globalMode = 'normal') {
  if (!forceSubscribeChannelsRaw) {
    return [];
  }

  let channels = [];
  if (Array.isArray(forceSubscribeChannelsRaw)) {
    channels = forceSubscribeChannelsRaw;
  } else if (typeof forceSubscribeChannelsRaw === 'object' && forceSubscribeChannelsRaw !== null) {
    return [];
  } else {
    const str = String(forceSubscribeChannelsRaw).trim();
    if (!str || str === '[object Object]') {
      return [];
    }
    if (str.startsWith('[')) {
      try {
        channels = JSON.parse(str);
      } catch (_) {
        // fallback
      }
    }
    if (!Array.isArray(channels) || !channels.length) {
      channels = str.split(',').map(id => id.trim()).filter(Boolean).map(id => ({
        id,
        title: id,
        mode: globalMode,
        role: 'primary'
      }));
    }
  }

  return channels
    .filter(c => c && c.id && String(c.id).trim() !== '[object Object]' && String(c.id).trim() !== '')
    .map(c => ({
      ...c,
      id: String(c.id).trim(),
      title: c.title || String(c.id).trim(),
      role: c.role === 'backup' ? 'backup' : 'primary',
      mode: c.mode || globalMode || 'normal'
    }));
}

// Circuit Breaker & Health Cache for Force-Sub Channels
const fsubChannelHealthCache = new Map();
const alertDebounceCache = new Map();
const HEALTH_COOLDOWN_MS = 5 * 60 * 1000;
const ALERT_THROTTLE_MS = 30 * 60 * 1000;

export function getChannelHealth(channelId) {
  const c = fsubChannelHealthCache.get(String(channelId));
  if (c && c.until > Date.now()) {
    return { isHealthy: false, error: c.error };
  }
  return { isHealthy: true, error: null };
}

export function markChannelHealthy(channelId) {
  fsubChannelHealthCache.delete(String(channelId));
}

export function markChannelDegraded(channelId, error) {
  fsubChannelHealthCache.set(String(channelId), {
    error: error || 'Inaccessible',
    until: Date.now() + HEALTH_COOLDOWN_MS
  });
}

async function notifyAdminChannelDegraded(channelId, channelTitle, errorMsg) {
  const now = Date.now();
  const lastAlert = alertDebounceCache.get(String(channelId)) || 0;
  if (now - lastAlert < ALERT_THROTTLE_MS) return;
  alertDebounceCache.set(String(channelId), now);

  const adminId = getAdminId();
  if (!adminId) return;

  const text = `🚨 <b>Force-Sub Failover Alert!</b>\n\n` +
    `Channel <b>${esc(channelTitle || channelId)}</b> (<code>${channelId}</code>) is unreachable or the bot was removed as Admin!\n\n` +
    `<b>Error:</b> <code>${esc(errorMsg || 'Unknown error')}</code>\n\n` +
    `🛡️ <i>Auto-Failover engaged: Users will be routed to a backup channel if configured, or this channel will be gracefully bypassed so users are NOT locked out.</i>\n\n` +
    `<i>Check admin rights or update the channel in /setting -> Force Sub.</i>`;

  await sendTelegramMessage(adminId, text).catch(() => {});
}

// ─── Multi-Instance State Decision: fsubMemberCache ──────────────────────────
// Decision: Acceptable as local-only per-instance ephemeral Map.
// Purpose: 60-second positive cache of Telegram channel membership status to avoid
// slamming Telegram's getChatMember API rate limits during rapid navigation.
// Rationale: If a user hits another instance within 60s, it simply calls Telegram's
// getChatMember API directly. Membership is verified against Telegram anyway.
const fsubMemberCache = new Map();
const FSUB_CACHE_TTL_MS = 60 * 1000;

export function invalidateFsubCache(userId = null) {
  if (!userId) {
    fsubMemberCache.clear();
    return;
  }
  const uStr = String(userId);
  for (const key of fsubMemberCache.keys()) {
    if (key.endsWith(`:${uStr}`)) {
      fsubMemberCache.delete(key);
    }
  }
}

export function pruneFsubCache() {
  const now = Date.now();
  for (const [key, val] of fsubMemberCache.entries()) {
    if (val.expiresAt <= now) {
      fsubMemberCache.delete(key);
    }
  }
}
setInterval(pruneFsubCache, 2 * 60 * 1000).unref?.();

export async function checkSubscription(chatId, userId) {
  return botContext.run({ token: getMainToken() }, async () => {
    let s = await getSettings();
    const sessions = await getCollection('sessions');

    const globalMode = s?.forceSubscribeMode || 'normal';
    const allChannels = getForceSubChannelsList(s?.forceSubscribeChannels, globalMode);
    if (!allChannels.length) return { ok: true };

    const primaryChannels = allChannels.filter(c => c.role !== 'backup');
    const backupPool = allChannels.filter(c => c.role === 'backup');

    if (!primaryChannels.length) {
      primaryChannels.push(...backupPool);
      backupPool.length = 0;
    }

    const now = Date.now();
    let backupIndex = 0;

    async function verifyUserInChannel(chan) {
      const cid = chan.id;
      const mode = chan.mode || globalMode || 'normal';
      const cacheKey = `${cid}:${userId}`;

      const cached = fsubMemberCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return { status: 'joined' };
      }

      const health = getChannelHealth(cid);
      if (!health.isHealthy) {
        return { status: 'degraded', error: health.error };
      }

      try {
        const res = await getChatMember(cid, userId);

        if (!res.ok) {
          const desc = res.description || '';
          const isDead = desc.includes('chat not found') ||
            desc.includes('bot was kicked') ||
            desc.includes('bot is not a member') ||
            desc.includes('chat was deactivated') ||
            res.error_code === 403;

          if (isDead) {
            markChannelDegraded(cid, desc);
            notifyAdminChannelDegraded(cid, chan.title, desc).catch(() => {});
            return { status: 'degraded', error: desc };
          }
        }

        const status = res.ok ? res.result?.status : null;
        const isMember = ['creator', 'administrator', 'member'].includes(status) ||
          (status === 'restricted' && Boolean(res.result?.is_member));

        if (isMember) {
          fsubMemberCache.set(cacheKey, { isMember: true, expiresAt: now + FSUB_CACHE_TTL_MS });
          return { status: 'joined' };
        }

        if (mode === 'join_request') {
          const pendingKey = `fsub:pending:${cid}:${userId}`;
          const pendingDoc = await sessions.findOne({ _id: pendingKey });
          const pending = pendingDoc && pendingDoc.expiresAt > new Date() ? pendingDoc.val : null;
          if (pending === '1') return { status: 'joined' };
        }

        const chatRes = await getChat(cid);
        if (!chatRes.ok) {
          const desc = chatRes.description || 'Failed to fetch chat';
          markChannelDegraded(cid, desc);
          notifyAdminChannelDegraded(cid, chan.title, desc).catch(() => {});
          return { status: 'degraded', error: desc };
        }

        const title = chan.title || (chatRes.ok ? chatRes.result?.title : cid);

        let inviteLink = null;
        const linkCacheKey = `fsub:link:main:${cid}:${mode}`;
        const cacheDoc = await sessions.findOne({ _id: linkCacheKey });
        inviteLink = cacheDoc && cacheDoc.expiresAt > new Date() ? cacheDoc.val : null;

        if (!inviteLink) {
          const createsJoinRequest = (mode === 'join_request');
          const linkRes = await createChatInviteLink(cid, createsJoinRequest);
          if (linkRes.ok && linkRes.result?.invite_link) {
            inviteLink = linkRes.result.invite_link;
            await sessions.updateOne(
              { _id: linkCacheKey },
              { $set: { val: inviteLink, expiresAt: new Date(Date.now() + 24 * 3600 * 1000) } },
              { upsert: true }
            );
          } else {
            inviteLink = chatRes.ok ? chatRes.result?.invite_link : null;
          }
        }

        if (!inviteLink) {
          markChannelDegraded(cid, 'Cannot generate invite link');
          return { status: 'degraded', error: 'No invite link' };
        }

        return {
          status: 'not_joined',
          data: {
            id: cid,
            title,
            buttonLabel: chan.buttonLabel || chan.label || null,
            inviteLink
          }
        };
      } catch (err) {
        log('error', 'checkSubscription error', { cid, userId, errorMessage: err.message });
        return { status: 'degraded', error: err.message };
      }
    }

    const notJoined = [];

    for (const primaryChan of primaryChannels) {
      let result = await verifyUserInChannel(primaryChan);

      if (result.status === 'degraded') {
        let resolvedWithBackup = false;
        while (backupIndex < backupPool.length) {
          const backupChan = backupPool[backupIndex++];
          const backupRes = await verifyUserInChannel(backupChan);
          if (backupRes.status === 'joined') {
            resolvedWithBackup = true;
            break;
          } else if (backupRes.status === 'not_joined') {
            notJoined.push(backupRes.data);
            resolvedWithBackup = true;
            break;
          }
        }

        if (!resolvedWithBackup) {
          log('warn', 'Force-Sub channel degraded with no backup; gracefully bypassed', {
            channelId: primaryChan.id,
            title: primaryChan.title
          });
        }
      } else if (result.status === 'not_joined') {
        notJoined.push(result.data);
      }
    }

    if (notJoined.length > 0) {
      return { ok: false, notJoined };
    }
    return { ok: true };
  });
}

export async function testAllForceSubChannels() {
  return botContext.run({ token: getMainToken() }, async () => {
    const s = await getSettings();
    const globalMode = s?.forceSubscribeMode || 'normal';
    const channels = getForceSubChannelsList(s?.forceSubscribeChannels, globalMode);
    if (!channels.length) return { ok: true, channels: [], allHealthy: true };

    const results = [];
    let allHealthy = true;

    for (const chan of channels) {
      const cid = chan.id;
      const mode = chan.mode || globalMode || 'normal';
      let title = chan.title || cid;
      let isHealthy = false;
      let error = null;
      let inviteLink = null;

      try {
        const chatRes = await getChat(cid);
        if (chatRes.ok) {
          title = chatRes.result?.title || title;
          const linkRes = await createChatInviteLink(cid, mode === 'join_request');
          if (linkRes.ok && linkRes.result?.invite_link) {
            inviteLink = linkRes.result.invite_link;
            isHealthy = true;
            markChannelHealthy(cid);
          } else {
            error = linkRes.description || 'Cannot create invite link (check Admin rights)';
            markChannelDegraded(cid, error);
            allHealthy = false;
          }
        } else {
          error = chatRes.description || 'Cannot access chat (bot not admin or chat not found)';
          markChannelDegraded(cid, error);
          allHealthy = false;
        }
      } catch (err) {
        error = err.message;
        markChannelDegraded(cid, error);
        allHealthy = false;
      }

      results.push({
        id: cid,
        title,
        mode,
        role: chan.role || 'primary',
        isHealthy,
        error,
        inviteLink
      });
    }

    return { ok: true, channels: results, allHealthy };
  });
}

export async function buildForceSubscribeGate(chatId, payload = '') {
  const sub = await checkSubscription(chatId, chatId);
  if (sub.ok) return null;

  const s = await getSettings();
  const text = s?.forceSubscribeMsg || '❌ <b>Access Denied!</b>\n\nYou must join our channels to use this bot.';

  const buttons = sub.notJoined.map(c => {
    const btnText = c.buttonLabel ? esc(c.buttonLabel) : `Join ${esc(c.title)}`;
    return [{
      text: toSmallCaps(btnText),
      url: c.inviteLink || `https://t.me/${String(c.id).replace('-100', '')}`
    }];
  });

  buttons.push([{ text: toSmallCaps('Try Again'), callback_data: `sub_check:${payload || ''}` }]);

  return { text, replyMarkup: { inline_keyboard: buttons }, photo: s?.bannerFsub || null };
}
