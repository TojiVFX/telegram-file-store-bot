# Standalone Filestore Bot Setup Guide

This guide will walk you through setting up your standalone Telegram Filestore Bot, which can handle multiple bots simultaneously sharing the same database and files.

## 1. Prerequisites
- A **Main Telegram Bot Token** from [@BotFather](https://t.me/BotFather).
- **Optional Additional Bot Tokens** if you want to run multiple bots.
- A **MongoDB Atlas** database connection URI.
- A **Private Telegram Channel** to act as your file database.

---

## 2. Environment Variables (`.env`)

Configure these in your hosting provider (e.g., Cloudflare Workers, Render Dashboard) or a local `.env` file:

| Variable | Description | Example |
| :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | Your main bot's API token from BotFather | `123456:ABC-DEF...` |
| `BOT_DOMAIN` | The base URL of your deployed server (for automatic webhook registration) | `https://your-app-name.workers.dev` |
| `MONGODB_URI` | MongoDB Connection URI | `mongodb+srv://user:pass@cluster...` |
| `ADMIN_CHAT_ID` | Your Telegram User ID (numeric) | `987654321` |
| `TELEGRAM_DB_CHANNEL_ID` | Your private storage channel ID | `-1001234567890` |
| `TELEGRAM_WEBHOOK_SECRET` | A secure random string — proves inbound requests really came from Telegram | `your_secure_webhook_secret_string` |

All of the above except `TELEGRAM_DB_CHANNEL_ID` are required — the server refuses to start if any are missing.

Generate strong random secrets with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 3. Setting the Webhook manually (If not using BOT_DOMAIN)

If you do not specify `BOT_DOMAIN`, you will need to set the webhook for your main bot manually.

### Recommended Method (Automated):
Simply open the following URL in your browser after deploying:
`https://<YOUR_DOMAIN>/setWebhook`

This automatically registers the webhook with the correct `allowed_updates` (such as `chat_join_request` for join approval mode, `chat_member`, and `my_chat_member`).

### Manual Method:
Alternatively, you can open this URL template in your browser. Note that you **must** include the `allowed_updates` array so Telegram sends join request updates:

**URL Template:**
`https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<YOUR_DOMAIN>/webhook/telegram&secret_token=<YOUR_TELEGRAM_WEBHOOK_SECRET>&allowed_updates=["message","callback_query","chat_join_request","chat_member","my_chat_member"]`

**Success Response:**
```json
{
  "ok": true,
  "result": true,
  "description": "Webhook was set"
}
```

---

## 4. Channel Configuration
1. Open your Private Telegram Channel.
2. Add your bot as an Administrator.
3. (Optional) Forward a message from this channel to @userinfobot to verify your `TELEGRAM_DB_CHANNEL_ID` matches.

---

## 5. Setting Force Subscribe
You can restrict access to users who are members of specific force subscribe channels. Setting this up is simple:

1. Open your bot's Admin Dashboard inside Telegram by using the `/setting` command.
2. Go to **Settings** / **FORCE SUB** / **+ Add Channel**.
3. You can either:
   - **Forward a message** directly from the channel (supports modern Telegram client structures).
   - **Type the channel ID** directly in the chat (e.g., `-100123456789`).
4. Choose the mode (Normal or Join Request).
5. Ensure the bot is added as an administrator in the channel (no special posting permissions are needed; only membership checking is required).

---

## 6. Bot Commands (Admin)
- `/setting`: Open interactive Admin Dashboard directly inside Telegram.
- `/batch`: Initiate batch creation (Range or Collector mode).
- `/store`: Store a single file and get a link.
- `/cancel`: Cancel any active batch/store session.
- `/userstats`: View bot usage and file statistics.
- `/broadcast`: Send a message to all bot users.

## 7. Bot Commands (User)
- `/start`: Main menu / Access file or batch via payload.
- `/me`: View profile and referral statistics.
- `/ping`: Check latency.
- `/help`: Get a help guide.
