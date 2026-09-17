import crypto from 'crypto';
import { getCollection, sendTelegramMessage, deleteTelegramMessage, toSmallCaps } from './bot-common.js';

// ─── Multi-Instance State Decision: velocityMap & Captcha Verification ───────
// Decision: velocityMap is acceptable as local-only per-instance sliding window.
// Purpose: Ephemeral velocity tracking (max 4 requests per 30 seconds) to detect
// burst scrapers and issue interactive captcha challenges.
// Correctness: The captcha challenge itself (sendCaptchaChallenge / verifyCaptchaAnswer)
// is stored in MongoDB `sessions` (`captcha:${chatId}:${token}`) with a 3-minute TTL,
// ensuring verification is 100% correct across horizontally-scaled instances.
const velocityMap = new Map();
const VELOCITY_WINDOW_MS = 30 * 1000; // 30 seconds
const VELOCITY_THRESHOLD = 4; // Max 4 requests in 30 seconds

// Available challenge icons
const EMOJI_POOL = [
  { name: 'Movie', icon: '🎬' },
  { name: 'Popcorn', icon: '🍿' },
  { name: 'Camera', icon: '🎥' },
  { name: 'Ticket', icon: '🎟️' },
  { name: 'Star', icon: '⭐' },
  { name: 'Rocket', icon: '🚀' },
  { name: 'Headphones', icon: '🎧' },
  { name: 'Gamepad', icon: '🎮' },
];

export function recordUserVelocity(userId) {
  const now = Date.now();
  const idStr = String(userId);
  let timestamps = velocityMap.get(idStr) || [];
  timestamps = timestamps.filter(t => now - t < VELOCITY_WINDOW_MS);
  timestamps.push(now);
  velocityMap.set(idStr, timestamps);
  return timestamps.length;
}

export function isScraperSuspected(userId) {
  const count = recordUserVelocity(userId);
  return count > VELOCITY_THRESHOLD;
}

export function clearUserVelocity(userId) {
  velocityMap.delete(String(userId));
}

// Prune velocity entries periodically to avoid memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [id, times] of velocityMap.entries()) {
    const valid = times.filter(t => now - t < VELOCITY_WINDOW_MS);
    if (valid.length === 0) velocityMap.delete(id);
    else velocityMap.set(id, valid);
  }
}, 60 * 1000).unref?.();

/**
 * Generates and presents a 1-tap inline emoji verification challenge
 */
export async function sendCaptchaChallenge(chatId, originalPayload) {
  const token = crypto.randomBytes(8).toString('hex');

  // Pick 4 distinct random icons
  const shuffled = [...EMOJI_POOL].sort(() => 0.5 - Math.random());
  const choices = shuffled.slice(0, 4);
  const targetIndex = Math.floor(Math.random() * choices.length);
  const target = choices[targetIndex];

  // Store in sessions with 3-minute TTL
  const sessions = await getCollection('sessions');
  const captchaKey = `captcha:${chatId}:${token}`;
  await sessions.updateOne(
    { _id: captchaKey },
    {
      $set: {
        token,
        chatId: String(chatId),
        targetIndex,
        originalPayload,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 180 * 1000)
      }
    },
    { upsert: true }
  );

  const text = `🛡️ <b>Security Check (Anti-Scraper)</b>\n\n` +
    `High download activity detected from your session.\n` +
    `Please tap the <b>${target.icon} ${target.name}</b> icon below to continue:`;

  const buttons = [
    choices.map((c, idx) => ({
      text: c.icon,
      callback_data: `user:captcha:${token}:${idx}`
    }))
  ];

  return sendTelegramMessage(chatId, text, { inline_keyboard: buttons });
}

/**
 * Validates the user's captcha button click
 */
export async function verifyCaptchaAnswer(chatId, token, chosenIndex) {
  const sessions = await getCollection('sessions');
  const captchaKey = `captcha:${chatId}:${token}`;
  const doc = await sessions.findOne({ _id: captchaKey });

  if (!doc || doc.expiresAt < new Date()) {
    return { ok: false, reason: 'expired' };
  }

  const isCorrect = Number(chosenIndex) === Number(doc.targetIndex);
  if (isCorrect) {
    await sessions.deleteOne({ _id: captchaKey });
    clearUserVelocity(chatId);
    return { ok: true, originalPayload: doc.originalPayload };
  } else {
    return { ok: false, reason: 'wrong_choice', originalPayload: doc.originalPayload };
  }
}
