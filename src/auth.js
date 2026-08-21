import { timingSafeEqual } from 'crypto';

// ── NEW: Telegram webhook authenticity check ──────────────────────────────────
// Telegram lets you register a `secret_token` when calling setWebhook. Telegram
// then sends that value back on every webhook POST in the
// `X-Telegram-Bot-Api-Secret-Token` header. Without this check, anyone who
// discovers /webhook/telegram can POST a forged update body (e.g. claiming to be
// your ADMIN_CHAT_ID) and the bot will treat it as a real, authenticated
// Telegram request — including admin commands like /broadcast or /ban.
//
// A single check covers all webhooks terminating on this server.
export function verifyTelegramWebhook(req) {
  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (!secret) return false; // fail closed if not configured

  const provided = req.headers['x-telegram-bot-api-secret-token'];
  if (!provided || typeof provided !== 'string') return false;

  const secretBuf   = Buffer.from(secret);
  const providedBuf = Buffer.from(provided);
  if (secretBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(secretBuf, providedBuf);
}
