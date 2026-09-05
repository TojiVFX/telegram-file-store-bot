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
  return { ok: true };
}

export function getEditorCredentials() {
  const apiId = (process.env.TELEGRAM_API_ID || '').trim();
  const apiHash = (process.env.TELEGRAM_API_HASH || '').trim();
  if (apiId && apiHash && !isNaN(Number(apiId))) {
    return { ok: true, apiId: Number(apiId), apiHash };
  }
  return { ok: false };
}
