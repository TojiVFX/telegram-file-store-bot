import express from 'express';
import telegramHandler from './routes/telegram.js';

const app = express();

app.set('trust proxy', 1);

app.use(express.json());

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

app.post('/webhook/telegram*', asyncHandler(telegramHandler));   // ← updates go here

app.get('/getMe', asyncHandler(async (req, res) => {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^bot/i, '');
  if (!token) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' });
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = await response.json();
  res.json(data);
}));

app.get('/setWebhook', asyncHandler(async (req, res) => {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^bot/i, '');
  if (!token) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' });
  }

  // Determine domain dynamically: prefer BOT_DOMAIN, fallback to host header
  let domain = (process.env.BOT_DOMAIN || '').trim();
  if (!domain) {
    const host = req.headers.host || new URL(req.url, 'https://example.com').host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    domain = `${proto}://${host}`;
  } else if (!domain.startsWith('http://') && !domain.startsWith('https://')) {
    domain = `https://${domain}`;
  }

  const webhookUrl = `${domain}/webhook/telegram`;
  const secretToken = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();

  const body = {
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query', 'chat_join_request', 'chat_member', 'my_chat_member'],
  };
  if (secretToken) {
    body.secret_token = secretToken;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  res.json({
    ok: data.ok,
    webhookUrl,
    secret_token_configured: !!secretToken,
    telegram_response: data
  });
}));

// ─── Health check ──────────────────────────────────────────────────────────
// Lightweight, unauthenticated, no DB call — safe to hit every few minutes
// from an external pinger to stop Render's free-tier spin-down (Render
// sleeps a free web service after ~15 min without inbound traffic). Also
// referenced by render.yaml's `healthCheckPath` so Render can tell whether
// a new deploy came up successfully.
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {                                  // ← root only handles GET
  res.send('Filestore Bot is running on Vercel/Render!');
});

export default app;
