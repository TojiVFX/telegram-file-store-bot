const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'MONGODB_URI',
  'ADMIN_CHAT_ID',
  'TELEGRAM_WEBHOOK_SECRET',
];

export function validateEnv() {
  const missing = REQUIRED_ENV.filter((key) => !(process.env[key] || '').trim());
  if (missing.length) {
    const msg = `Missing required environment variable(s): ${missing.join(', ')}`;
    console.error(`\n❌ ${msg}\n   See README.md → "Environment Variables" for what each one should contain.\n`);
    return { ok: false, message: msg };
  }

  const adminIds = (process.env.ADMIN_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!adminIds.length || !adminIds.every(id => /^-?\d+$/.test(id))) {
    const msg = `ADMIN_CHAT_ID must contain one or more numeric Telegram chat IDs (e.g. "12345678" or "12345678,87654321")`;
    console.error(`\n❌ ${msg}\n`);
    return { ok: false, message: msg };
  }

  return { ok: true };
}
