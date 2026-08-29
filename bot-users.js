import {
  getCollection, getSettings, log, sendTelegramMessage
} from './bot-common.js';

export async function upsertUser(message) {
  try {
    const chatId  = String(message.chat.id);
    const from    = message.from || {};
    const today   = new Date().toISOString().slice(0, 10);
    const users   = await getCollection('users');

    const updated = {
      userId:    String(from.id || chatId),
      username:  from.username ? from.username.toLowerCase() : null,
      firstName: from.first_name || null,
      lastName:  from.last_name || null,
      lastSeen:  new Date().toISOString(),
    };

    await users.updateOne(
      { _id: chatId },
      {
        $set: updated,
        $setOnInsert: {
          joinedAt:      new Date().toISOString(),
          banned:        false,
          referralCount: 0,
          referrerId:    null,
          premiumUntil:  null,
        }
      },
      { upsert: true }
    );
  } catch (err) {
    log('error', 'upsertUser failed', { errorMessage: err.message });
  }
}

export async function banUser(targetId) {
  try {
    const users = await getCollection('users');
    await users.updateOne(
      { _id: String(targetId) },
      { $set: { banned: true } },
      { upsert: true }
    );
    log('warn', 'User banned', { targetId });
  } catch (err) {
    log('error', 'banUser failed', { errorMessage: err.message });
  }
}

export async function unbanUser(targetId) {
  try {
    const users = await getCollection('users');
    await users.updateOne(
      { _id: String(targetId) },
      { $set: { banned: false } }
    );
    log('info', 'User unbanned', { targetId });
  } catch (err) {
    log('error', 'unbanUser failed', { errorMessage: err.message });
  }
}

export async function isBanned(chatId) {
  try {
    const users = await getCollection('users');
    const user = await users.findOne({ _id: String(chatId) });
    return !!(user && user.banned);
  } catch (err) {
    log('error', 'isBanned check failed', { errorMessage: err.message });
    return false;
  }
}

export async function getBannedList() {
  try {
    const users = await getCollection('users');
    const list = await users.find({ banned: true }).toArray();
    return list.map(u => u._id);
  } catch (err) {
    log('error', 'getBannedList failed', { errorMessage: err.message });
    return [];
  }
}

export async function broadcastToAll(text) {
  try {
    const users = await getCollection('users');
    const list = await users.find({ banned: { $ne: true } }).toArray();
    const ids = list.map(u => u._id);
    if (!ids.length) return { sent: 0, failed: 0, total: 0 };

    let sent   = 0;
    let failed = 0;
    const CHUNK = 25;

    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk   = ids.slice(i, i + CHUNK);
      const results = await Promise.allSettled(
        chunk.map(id => sendTelegramMessage(id, text)),
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value?.ok) sent++;
        else failed++;
      }

      if (i + CHUNK < ids.length) await new Promise(r => setTimeout(r, 1000));
    }

    log('info', 'Broadcast complete', { sent, failed, total: ids.length });
    return { sent, failed, total: ids.length };
  } catch (err) {
    log('error', 'broadcastToAll failed', { errorMessage: err.message });
    return { sent: 0, failed: 0, total: 0 };
  }
}

export async function getUserStats() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const users = await getCollection('users');
    const files = await getCollection('files');
    const channels = await getCollection('channels');

    const [totalUsers, bannedCount, todayActive, filestoreLinks, filestoreChannels] =
      await Promise.all([
        users.countDocuments(),
        users.countDocuments({ banned: true }),
        users.countDocuments({ lastSeen: { $regex: '^' + today } }),
        files.countDocuments(),
        channels.countDocuments(),
      ]);

    return {
      totalUsers:         totalUsers        || 0,
      bannedCount:        bannedCount       || 0,
      todayActive:        todayActive       || 0,
      filestoreLinks:     filestoreLinks    || 0,
      filestoreChannels:  filestoreChannels || 0,
    };
  } catch (err) {
    log('error', 'getUserStats failed', { errorMessage: err.message });
    return {
      totalUsers: 0, bannedCount: 0, todayActive: 0,
      filestoreLinks: 0, filestoreChannels: 0,
    };
  }
}

export function getAdminId() {
  const raw = (process.env.ADMIN_CHAT_ID || '').trim();
  return raw ? Number(raw) : null;
}

export async function isAdmin(chatId) {
  const adminId = getAdminId();
  if (adminId !== null && Number(chatId) === adminId) return true;
  return false;
}

export async function addReferral(referrerId, newUserId) {
  try {
    const users = await getCollection('users');

    const userDoc = await users.findOne({ _id: String(newUserId) });
    if (userDoc && userDoc.referrerId) return false;

    await users.updateOne(
      { _id: String(newUserId) },
      { $set: { referrerId: String(referrerId) } }
    );

    await users.updateOne(
      { _id: String(referrerId) },
      { $inc: { referralCount: 1 } },
      { upsert: true }
    );

    const referrerDoc = await users.findOne({ _id: String(referrerId) });
    const newCount = referrerDoc ? referrerDoc.referralCount : 0;

    if (newCount > 0 && newCount % 3 === 0) {
      const REWARD_SECONDS = 24 * 3600;
      const currentPremiumUntil = referrerDoc.premiumUntil ? new Date(referrerDoc.premiumUntil) : null;
      let newPremiumUntil;

      if (currentPremiumUntil && currentPremiumUntil > new Date()) {
        newPremiumUntil = new Date(currentPremiumUntil.getTime() + REWARD_SECONDS * 1000);
      } else {
        newPremiumUntil = new Date(Date.now() + REWARD_SECONDS * 1000);
      }

      await users.updateOne(
        { _id: String(referrerId) },
        { $set: { premiumUntil: newPremiumUntil } }
      );

      await sendTelegramMessage(
        referrerId,
        `🎁 <b>Referral Reward!</b>\n\nYou've referred <b>${newCount}</b> users and earned <b>24 hours</b> of Premium access.`,
      );
    }

    return true;
  } catch (err) {
    log('error', 'addReferral failed', { errorMessage: err.message });
    return false;
  }
}

export async function getReferralStats(userId) {
  try {
    const users = await getCollection('users');
    const user = await users.findOne({ _id: String(userId) });
    return user ? (user.referralCount || 0) : 0;
  } catch {
    return 0;
  }
}

export async function hasPremium(userId) {
  try {
    const users = await getCollection('users');
    const user = await users.findOne({ _id: String(userId) });
    return !!(user && user.premiumUntil && new Date(user.premiumUntil) > new Date());
  } catch (err) {
    log('error', 'hasPremium check failed', { userId, errorMessage: err.message });
    return false;
  }
}
