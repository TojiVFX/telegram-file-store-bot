import { timingSafeEqual } from 'crypto';

export function verifyTelegramWebhook(req) {
  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (!secret) return false;

  const headers = req?.headers || {};
  const provided = headers['x-telegram-bot-api-secret-token'];
  if (!provided || typeof provided !== 'string') return false;

  const secretBuf   = Buffer.from(secret);
  const providedBuf = Buffer.from(provided);
  if (secretBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(secretBuf, providedBuf);
}

// ─── Admin ID & Authorization Helpers ─────────────────────────────────────────
let cachedAdminIds = null;
let cachedAdminSet = null;
let cachedPrimaryAdminId = undefined;

export function getAdminIds() {
  if (cachedAdminIds !== null) return cachedAdminIds;
  const raw = (process.env.ADMIN_CHAT_ID || '').trim();
  if (!raw) {
    cachedAdminIds = [];
    return cachedAdminIds;
  }
  cachedAdminIds = raw
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
  return cachedAdminIds;
}

export function getAdminSet() {
  if (!cachedAdminSet) {
    cachedAdminSet = new Set(getAdminIds());
  }
  return cachedAdminSet;
}

export function getAdminId() {
  if (cachedPrimaryAdminId !== undefined) return cachedPrimaryAdminId;
  const ids = getAdminIds();
  cachedPrimaryAdminId = ids.length > 0 ? Number(ids[0]) : null;
  return cachedPrimaryAdminId;
}

export async function isAdmin(chatId) {
  if (chatId === null || chatId === undefined) return false;
  return getAdminSet().has(String(chatId).trim());
}

export function resetAdminCache() {
  cachedAdminIds = null;
  cachedAdminSet = null;
  cachedPrimaryAdminId = undefined;
}
