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
