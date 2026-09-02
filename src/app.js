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

app.get('/', (req, res) => {
  const hasToken = !!(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const hasSecret = !!(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  const hasMongo = !!(process.env.MONGODB_URI || '').trim();
  const hasAdmin = !!(process.env.ADMIN_CHAT_ID || '').trim();
  const hasChannel = !!(process.env.TELEGRAM_DB_CHANNEL_ID || '').trim();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Telegram File Store Bot</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --primary: #38bdf8;
      --success: #4ade80;
      --warn: #fbbf24;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container {
      width: 100%;
      max-width: 680px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .badge-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(74, 222, 128, 0.1);
      color: var(--success);
      border: 1px solid rgba(74, 222, 128, 0.2);
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 600;
    }
    .badge-dot {
      width: 8px;
      height: 8px;
      background: var(--success);
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }
    h1 { font-size: 24px; font-weight: 700; }
    p { color: var(--muted); font-size: 14px; line-height: 1.6; }
    .section-title {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      margin: 20px 0 12px;
      font-weight: 600;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .item {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
    }
    .item-name { font-family: monospace; color: var(--text); }
    .tag-ok { color: var(--success); font-weight: 600; }
    .tag-warn { color: var(--warn); font-weight: 600; }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      background: #334155;
      color: var(--text);
      text-decoration: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.2s;
    }
    .btn:hover { background: #475569; }
    .btn-primary { background: #0284c7; }
    .btn-primary:hover { background: #0369a1; }
    .footer {
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      font-size: 12px;
      color: var(--muted);
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>Telegram File Store Bot</h1>
        <p>Standalone multi-bot Telegram storage & forwarding webhook engine</p>
      </div>
      <div style="margin-left: auto;">
        <span class="badge-status"><span class="badge-dot"></span> Online</span>
      </div>
    </div>

    <div class="section-title">Environment Variables Status</div>
    <div class="grid">
      <div class="item">
        <span class="item-name">TELEGRAM_BOT_TOKEN</span>
        <span class="${hasToken ? 'tag-ok' : 'tag-warn'}">${hasToken ? 'Configured' : 'Missing'}</span>
      </div>
      <div class="item">
        <span class="item-name">TELEGRAM_WEBHOOK_SECRET</span>
        <span class="${hasSecret ? 'tag-ok' : 'tag-warn'}">${hasSecret ? 'Configured' : 'Missing'}</span>
      </div>
      <div class="item">
        <span class="item-name">MONGODB_URI</span>
        <span class="${hasMongo ? 'tag-ok' : 'tag-warn'}">${hasMongo ? 'Connected' : 'In-Memory Fallback'}</span>
      </div>
      <div class="item">
        <span class="item-name">ADMIN_CHAT_ID</span>
        <span class="${hasAdmin ? 'tag-ok' : 'tag-warn'}">${hasAdmin ? 'Configured' : 'Missing'}</span>
      </div>
      <div class="item">
        <span class="item-name">TELEGRAM_DB_CHANNEL_ID</span>
        <span class="${hasChannel ? 'tag-ok' : 'tag-warn'}">${hasChannel ? 'Configured' : 'Optional (Settings UI)'}</span>
      </div>
    </div>

    <div class="section-title">Features & Capabilities</div>
    <div class="grid">
      <div class="item">
        <div>
          <strong style="color: var(--primary);">⏳ Time-Limited Access Tokens</strong>
          <p style="margin-top: 4px; font-size: 12px; color: var(--muted);">Generate expiring share links (/temptoken &lt;code&gt; [duration]) with custom TTL (e.g. 15m, 1h, 24h, 7d).</p>
        </div>
        <span class="tag-ok">Active</span>
      </div>
      <div class="item">
        <div>
          <strong style="color: var(--primary);">📁 Batch & Single File Store</strong>
          <p style="margin-top: 4px; font-size: 12px; color: var(--muted);">Forward channel message ranges or individual media with automatic TTL auto-delete.</p>
        </div>
        <span class="tag-ok">Active</span>
      </div>
    </div>

    <div class="section-title">Quick Endpoints & Commands</div>
    <div class="actions">
      <a class="btn btn-primary" href="/health" target="_blank">Health Check (/health)</a>
      <a class="btn" href="/getMe" target="_blank">Bot Info (/getMe)</a>
      <a class="btn" href="/setWebhook" target="_blank">Register Webhook (/setWebhook)</a>
    </div>

    <div class="footer">
      <span>Port: 3000 (0.0.0.0)</span>
      <span>Uptime: ${Math.floor(process.uptime())}s</span>
    </div>
  </div>
</body>
</html>`;
  res.send(html);
});

export default app;
