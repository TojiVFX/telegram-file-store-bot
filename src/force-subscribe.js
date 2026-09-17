import {
  getCollection, getSettings, log, esc,
  getChatMember, getChat, createChatInviteLink,
  botContext, toSmallCaps, getMainToken
} from './bot-common.js';

export function getForceSubChannelsList(forceSubscribeChannelsRaw, globalMode = 'normal') {
  if (!forceSubscribeChannelsRaw) {
    return [];
  }

  if (Array.isArray(forceSubscribeChannelsRaw)) {
    return forceSubscribeChannelsRaw.filter(
      c => c && c.id && String(c.id).trim() !== '[object Object]' && String(c.id).trim() !== ''
    );
  }
  if (typeof forceSubscribeChannelsRaw === 'object') {
    return [];
  }

  const str = String(forceSubscribeChannelsRaw).trim();
  if (!str || str === '[object Object]') {
    return [];
  }
  let channels = [];
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
      mode: globalMode
    }));
  }

  return channels.filter(c => c && c.id && String(c.id).trim() !== '[object Object]' && String(c.id).trim() !== '');
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
    const channels = getForceSubChannelsList(s?.forceSubscribeChannels, globalMode);
    if (!channels.length) return { ok: true };

    const now = Date.now();
    const results = await Promise.all(channels.map(async (chan) => {
      const cid = chan.id;
      const mode = chan.mode || globalMode || 'normal';
      const cacheKey = `${cid}:${userId}`;

      // Check 60-second in-memory positive cache
      const cached = fsubMemberCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return null;
      }

      try {
        const res = await getChatMember(cid, userId);

        if (!res.ok) {
          log('error', 'checkSubscription: getChatMember failed', { cid, userId, res });
        }
        const status = res.ok ? res.result?.status : null;
        const isMember = ['creator', 'administrator', 'member'].includes(status) ||
          (status === 'restricted' && Boolean(res.result?.is_member));

        if (isMember) {
          fsubMemberCache.set(cacheKey, { isMember: true, expiresAt: now + FSUB_CACHE_TTL_MS });
          return null;
        }

        if (!isMember) {
          if (mode === 'join_request') {
            const pendingKey = `fsub:pending:${cid}:${userId}`;
            const pendingDoc = await sessions.findOne({ _id: pendingKey });
            const pending = pendingDoc && pendingDoc.expiresAt > new Date() ? pendingDoc.val : null;
            if (pending === '1') return null;
          }

          const chatRes = await getChat(cid);
          const title = chan.title || (chatRes.ok ? chatRes.result.title : cid);

          let inviteLink = null;
          const cacheKey = `fsub:link:main:${cid}:${mode}`;
          const cacheDoc = await sessions.findOne({ _id: cacheKey });
          inviteLink = cacheDoc && cacheDoc.expiresAt > new Date() ? cacheDoc.val : null;

          if (!inviteLink) {
            const createsJoinRequest = (mode === 'join_request');
            const linkRes = await createChatInviteLink(cid, createsJoinRequest);
            if (linkRes.ok && linkRes.result?.invite_link) {
              inviteLink = linkRes.result.invite_link;
              await sessions.updateOne(
                { _id: cacheKey },
                { $set: { val: inviteLink, expiresAt: new Date(Date.now() + 24 * 3600 * 1000) } },
                { upsert: true }
              );
            } else {
              inviteLink = chatRes.ok ? chatRes.result.invite_link : null;
            }
          }

          return {
            id: cid,
            title: title,
            buttonLabel: chan.buttonLabel || chan.label || null,
            inviteLink: inviteLink
          };
        }
        return null;
      } catch (err) {
        log('error', 'checkSubscription error', { cid, userId, errorMessage: err.message });
        return null;
      }
    }));

    const notJoined = results.filter(Boolean);
    if (notJoined.length > 0) {
      return { ok: false, notJoined };
    }
    return { ok: true };
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
