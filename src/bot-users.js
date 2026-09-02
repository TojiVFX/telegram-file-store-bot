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

let broadcastCancelled = false;

export function cancelBroadcast() {
  broadcastCancelled = true;
}

export async function broadcastWithProgress({ text, adminChatId, statusMsgId = null }) {
  broadcastCancelled = false;
  try {
    const users = await getCollection('users');
    const list = await users.find({ banned: { $ne: true } }).toArray();
    const ids = list.map(u => u._id);
    const total = ids.length;

    if (!total) {
      if (adminChatId && statusMsgId) {
        const { editTelegramMessage, toSmallCaps } = await import('./bot-common.js');
        await editTelegramMessage(adminChatId, statusMsgId, `<b>Broadcast</b>\n\nNo active users found to broadcast to.`, {
          inline_keyboard: [[{ text: toSmallCaps('Back to Dashboard'), callback_data: 'admin:dashboard' }]]
        });
      }
      return { sent: 0, failed: 0, total: 0 };
    }

    let sent = 0;
    let failed = 0;
    let blockedCount = 0;
    const CHUNK = 20;

    const { editTelegramMessage, toSmallCaps } = await import('./bot-common.js');

    for (let i = 0; i < ids.length; i += CHUNK) {
      if (broadcastCancelled) {
        log('info', 'Broadcast cancelled by admin', { sent, failed, total });
        break;
      }

      const chunk = ids.slice(i, i + CHUNK);
      const results = await Promise.allSettled(
        chunk.map(id => sendTelegramMessage(id, text))
      );

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        const targetUserId = chunk[j];

        if (r.status === 'fulfilled' && r.value?.ok) {
          sent++;
        } else {
          failed++;
          const errDetail = r.status === 'fulfilled' ? r.value?.detail : null;
          if (errDetail?.error_code === 403 || (errDetail?.description || '').toLowerCase().includes('bot was blocked')) {
            blockedCount++;
            // Flag user as blocked
            users.updateOne({ _id: String(targetUserId) }, { $set: { isBlocked: true, lastBlockedAt: new Date() } }).catch(() => {});
          }
        }
      }

      // Live progress update to admin chat
      if (adminChatId && statusMsgId) {
        const progressCount = Math.min(total, sent + failed);
        const percent = Math.min(100, Math.round((progressCount / total) * 100));
        const barWidth = 10;
        const filled = Math.round((percent / 100) * barWidth);
        const bar = '█'.repeat(filled) + '▒'.repeat(barWidth - filled);

        const statusText = `<b>Broadcasting Message...</b>\n\n` +
          `${bar} ${percent}%\n\n` +
          `• Total Users: <b>${total}</b>\n` +
          `• Delivered: <b>${sent}</b>\n` +
          `• Blocked / Failed: <b>${failed}</b>\n\n` +
          `<i>Paced at 20 msgs/sec...</i>`;

        await editTelegramMessage(adminChatId, statusMsgId, statusText, {
          inline_keyboard: [[{ text: toSmallCaps('Cancel Broadcast'), callback_data: 'admin:broadcast_cancel' }]]
        }).catch(() => {});
      }

      if (i + CHUNK < ids.length && !broadcastCancelled) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    const finalStatus = broadcastCancelled ? 'Cancelled by Admin' : 'Complete';
    if (adminChatId && statusMsgId) {
      const completionText = `<b>Broadcast ${finalStatus}</b>\n\n` +
        `• Total Users: <b>${total}</b>\n` +
        `• Delivered: <b>${sent}</b>\n` +
        `• Blocked / Failed: <b>${failed}</b>`;

      await editTelegramMessage(adminChatId, statusMsgId, completionText, {
        inline_keyboard: [[{ text: toSmallCaps('Back to Dashboard'), callback_data: 'admin:dashboard' }]]
      }).catch(() => {});
    }

    log('info', `Broadcast ${finalStatus}`, { sent, failed, blockedCount, total });
    return { sent, failed, total, cancelled: broadcastCancelled };
  } catch (err) {
    log('error', 'broadcastWithProgress failed', { errorMessage: err.message });
    return { sent: 0, failed: 0, total: 0 };
  }
}

export async function broadcastToAll(text) {
  return broadcastWithProgress({ text });
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

export async function savePendingReferral(referrerId, newUserId) {
  try {
    const sessions = await getCollection('sessions');
    await sessions.updateOne(
      { _id: `ref:pending:${newUserId}` },
      { $set: { referrerId: String(referrerId), createdAt: new Date(), expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    log('error', 'savePendingReferral failed', { errorMessage: err.message });
    return false;
  }
}

export async function completePendingReferral(newUserId) {
  try {
    const sessions = await getCollection('sessions');
    const pendingDoc = await sessions.findOne({ _id: `ref:pending:${newUserId}` });
    if (!pendingDoc || !pendingDoc.referrerId) return false;

    const referrerId = pendingDoc.referrerId;
    await sessions.deleteOne({ _id: `ref:pending:${newUserId}` });

    const added = await addReferral(referrerId, newUserId);
    return added;
  } catch (err) {
    log('error', 'completePendingReferral failed', { errorMessage: err.message });
    return false;
  }
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

    // Send successful referral notification to the referrer
    await sendTelegramMessage(
      referrerId,
      `🎉 <b>New Referral!</b>\n\nA user joined and completed channel verification using your invite link.\n\nTotal Referrals: <b>${newCount}</b>`
    ).catch(() => {});

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
      ).catch(() => {});
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
