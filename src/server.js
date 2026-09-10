import app from './app.js';
import { validateEnv } from './env-validator.js';
import { registerWebhook, startAutoDeleteWorker, startDailyBackupWorker } from './bot-helpers.js';

const envCheck = validateEnv();
if (!envCheck.ok) {
  console.warn('[Filestore Bot] Running in unconfigured/preview mode. Please configure environment variables in your deployment environment (Koyeb/Render/VPS).');
}

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[Filestore Bot] Server is listening on http://0.0.0.0:${PORT}`);

  // Start the persistent auto-delete worker
  startAutoDeleteWorker();

  // Start automated daily database backup worker
  startDailyBackupWorker();

  // Auto-register Telegram webhook if BOT_DOMAIN and TELEGRAM_BOT_TOKEN are configured
  const domain = (process.env.BOT_DOMAIN || '').trim();
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^bot/i, '');
  if (domain && token) {
    const formattedDomain = domain.startsWith('http://') || domain.startsWith('https://') ? domain : `https://${domain}`;
    const webhookUrl = `${formattedDomain}/webhook/telegram`;
    try {
      const res = await registerWebhook(token, webhookUrl);
      const data = await res.json();
      if (data.ok) {
        console.log(`[Filestore Bot] Auto-registered webhook: ${webhookUrl}`);
      } else {
        console.warn(`[Filestore Bot] Webhook registration response: ${data.description || JSON.stringify(data)}`);
      }
    } catch (err) {
      console.error('[Filestore Bot] Webhook registration error:', err.message);
    }
  }

  // Cloud Free-Tier Keep-Alive Pinger (prevents inactivity spin-down on Koyeb / Render)
  if (domain && process.env.KEEP_ALIVE !== 'false' && process.env.RENDER_KEEP_ALIVE !== 'false') {
    const formattedDomain = domain.startsWith('http://') || domain.startsWith('https://') ? domain : `https://${domain}`;
    const healthUrl = `${formattedDomain}/health`;
    const PING_INTERVAL = 10 * 60 * 1000; // 10 minutes
    setInterval(async () => {
      try {
        await fetch(healthUrl);
      } catch {}
    }, PING_INTERVAL);
    console.log('[Filestore Bot] Keep-Alive self-pinger active (10m interval).');
  }
});

// Graceful shutdown handling for container/cloud deployments
const shutdown = (signal) => {
  console.log(`[Filestore Bot] Received ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    console.log('[Filestore Bot] HTTP server closed.');
    try {
      const { closeDb } = await import('./bot-common.js');
      await closeDb();
    } catch {}
    process.exit(0);
  });
  // Force shutdown after 10s if connections linger
  setTimeout(() => {
    console.error('[Filestore Bot] Forced shutdown after timeout.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

