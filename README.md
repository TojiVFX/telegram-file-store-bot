# 🚀 Advanced Standalone Telegram Filestore Bot

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-v18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/MongoDB-Atlas_/_Local-47A248?style=for-the-badge&logo=mongodb&logoColor=white" alt="MongoDB" />
  <img src="https://img.shields.io/badge/Express-4.21.2-000000?style=for-the-badge&logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/Telegram_Bot_API-v7.0+-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram" />
  <img src="https://img.shields.io/badge/Security-Fail--Closed_&_CSPRNG-red?style=for-the-badge&logo=shield&logoColor=white" alt="Security" />
</p>

An enterprise-grade, high-performance, standalone **Telegram Filestore & Media Distribution Bot** built with Node.js (ESM), Express, and MongoDB. 

Engineered for ultra-low latency, multi-bot concurrency, rock-solid security, and automated link monetization.

---

## 📑 Table of Contents
- [✨ Key Features](#-key-features)
- [🏗 Architecture & Performance](#-architecture--performance)
- [🔒 Security & Abuse Protection](#-security--abuse-protection)
- [📦 Storage & Delivery Modes](#-storage--delivery-modes)
  - [1. Single File Storage](#1-single-file-storage)
  - [2. Batch Storage (Collector & Range)](#2-batch-storage-collector--range)
  - [3. Multi-Quality Release Bundles](#3-multi-quality-release-bundles)
  - [4. Time-Limited Temporary Access Tokens](#4-time-limited-temporary-access-tokens)
- [💰 Monetization, Shorteners & Premium](#-monetization-shorteners--premium)
- [📢 Force-Subscribe & Growth System](#-force-subscribe--growth-system)
- [🛠 Interactive Admin Dashboard](#-interactive-admin-dashboard)
- [📖 Help System & Interactive Guides](#-help-system--interactive-guides)
- [⚙️ Environment Variables](#️-environment-variables)
- [🚀 Quick Start & Deployment](#-quick-start--deployment)
  - [Option A: Deploy to Render](#option-a-deploy-to-render-recommended)
  - [Option B: Manual / VPS / Local Deployment](#option-b-manual--vps--local-deployment)
- [🤖 Webhook Configuration](#-webhook-configuration)
- [📚 Complete Command Reference](#-complete-command-reference)
  - [Admin Commands](#admin-commands)
  - [User Commands](#user-commands)
- [📄 License](#-license)

---

## ✨ Key Features

- ⚡ **Ultra-Low Latency (<15ms Ack)**: Immediate fail-closed webhook acknowledgment with asynchronous processing pipeline.
- 🗄 **Dual-Channel Redundancy**: Primary DB Channel with automatic failover to Backup Storage Channel for zero file loss.
- 🤖 **Multi-Bot Network**: Run multiple Telegram bots simultaneously sharing the same database and files.
- 📖 **Unified Interactive Help System**: Synchronized user and administrator help guides accessible via `/help`, `/adminhelp`, the About menu, and dashboard navigation with strict admin-only button gating.
- 🎛 **Multi-Quality Release Bundles**: Automatically detect and group 360p, 480p, 720p, 1080p, and 4K releases under a single link with cleaned media titles.
- ⏳ **Expiring Temporary Tokens**: Generate secure time-limited access links with custom expiration (e.g. `30m`, `24h`) and optional single-use access limits (`maxUses`).
- ⏱ **Auto-Delete Engine**: Automated message self-destruction timers with countdown notices and persistent recovery across server restarts.
- 🛡 **Content Protection**: Global `protect_content` toggle preventing users from forwarding, copying, or saving restricted files.
- 🔗 **Shortener Link Monetization**: Require users to complete shortener links to unlock file access for custom durations (e.g. 24h), with fail-closed security.
- 🌟 **VIP / Premium Membership**: Bypass shorteners and force-subscription for VIP users; automated expiry tracking.
- 👥 **Viral Referral Program**: Rewarding users with Premium access when friends join through their unique referral link.
- 📢 **Force-Subscribe System**: Multi-channel support with both **Normal Membership** and **Join Request Mode**.
- 📊 **Rich Analytics & Traffic Dashboards**: Download activity charts, top 10 files, daily link audits, and real-time system health checks.
- 📝 **Bulk Store & Link Exports**: Forward multiple files and export links as 1-tap copyable blocks and `.txt` documents.

---

## 🏗 Architecture & Performance

```
                           [ Telegram Cloud ]
                                   │
                     Inbound Webhook Update (HTTPS)
                                   ▼
                    ┌──────────────────────────────┐
                    │      src/auth.js             │
                    │ Timing-safe Fail-Closed Auth │
                    └──────────────┬───────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              ▼                                         ▼
   [ Instant HTTP 200 OK ]                 [ Async Update Queue ]
      Latency: < 15ms                                   │
                                                        ▼
                                           ┌──────────────────────────┐
                                           │  Atomic Rate Limiter     │
                                           │  & Ban Validation        │
                                           └────────────┬─────────────┘
                                                        │
                      ┌─────────────────────────────────┴─────────────────────────────────┐
                      ▼                                 ▼                                 ▼
             [ User Commands ]                 [ Start Payloads ]                [ Admin Actions ]
           /me, /help, /temptoken            file_, batch_, bundle_,            /setting, /batch,
                                              tmp_, verify_, ref_               /broadcast, /store
```

- **ESM Native**: 100% pure ES Modules with modern Node.js standards.
- **Zero-Config In-Memory Fallback**: When `MONGODB_URI` is not supplied, an intelligent in-memory mock collection is activated automatically, allowing local development and testing without installing a database.
- **Detached Non-Blocking Writes**: User profile synchronization and activity logging run asynchronously in the background, never slowing down the user experience.

---

## 🔒 Security & Abuse Protection

1. **Fail-Closed Webhook Verification**:
   - Strictly verifies `X-Telegram-Bot-Api-Secret-Token` using constant-time `crypto.timingSafeEqual` comparison.
   - If `TELEGRAM_WEBHOOK_SECRET` is unset or invalid, requests are immediately rejected (`401 Unauthorized`).
2. **Atomic Rate Limiter**:
   - Prevents abuse and flooding using atomic MongoDB `$inc` operations across time windows.
   - Immune to TOCTOU race conditions during window resets.
3. **Atomic Temporary Token Consumption**:
   - Single-use and limited-use temporary access tokens (`maxUses`) are claimed atomically. Concurrent requests cannot bypass use limits.
4. **CSPRNG Cryptographic IDs**:
   - Replaced pseudo-random generation with Node.js native `crypto.randomInt` and `crypto.randomBytes`. Link IDs (`file_`, `batch_`, `bundle_`, `temp_`) cannot be guessed or enumerated.
5. **Hardened HTTP Surface**:
   - Injects `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`.
   - Express server fingerprinting disabled (`x-powered-by: false`).
   - Administrative endpoints (`/setWebhook`, `/getMe`) protected with admin credentials.

---

## 📦 Storage & Delivery Modes

### 1. Single File Storage
- Forward or send any media file (Document, Video, Audio, Photo) directly to the bot.
- Generates a permanent link: `https://t.me/<bot_username>?start=file_<code_id>`
- Automatically copies the file into your private database channel and records metadata (size, title, mime-type).

### 2. Batch Storage (Collector & Range)
- **Range Mode**: Provide the first and last message links from your DB channel (e.g. `https://t.me/c/123/101 https://t.me/c/123/110`) to bundle up to 500 files at once.
- **Collector Mode**: Send `/batch`, then forward files one by one. Tap **Done** when finished.
- **Animated Progress Bar**: Users downloading batches receive live delivery updates with visual progress bars (`█▒▒▒`) and percentage indicators.

### 3. Multi-Quality Release Bundles
- Create a multi-resolution bundle with `/bundle` or `/quality <Title>`.
- Automatically strips filename noise (release groups, CRC tags, encoder details like `HEVC`, `x265`, `10bit`).
- Detects resolutions (`480p`, `720p`, `1080p`, `4K`) and presents users with an interactive quality picker or 1-tap **Download All Qualities**.

### 4. Time-Limited Temporary Access Tokens
- Create links that automatically expire after a set time or download limit.
- **Command**: `/temptoken <file_code_or_batch_code> [duration] [max_uses]`
- **Examples**:
  - `/temptoken file_abc123 1h` — Valid for 1 hour.
  - `/temptoken file_abc123 24h 1` — Valid for 24 hours or strictly 1 download only.
  - `/temptoken batch_xyz789 30m` — Valid for 30 minutes.
- Manage and invalidate tokens with `/mytokens` and `/revoketoken <token_code>`.

---

## 💰 Monetization, Shorteners & Premium

- **URL Shortener Integration**:
  - Gate file delivery behind any shortener service (e.g. Shrinkme.io, Droplink, etc.) supporting standard API formats.
  - Configurable **Verification Validity**:
    - `24` hours: user verifies once a day.
    - `0` hours: user must re-verify on every request.
  - **Fail-Closed Protection**: If the shortener API is down or unconfigured, access halts and alerts the admin rather than leaking files for free.
  - Supports tutorial video and custom verification banners.
- **VIP / Premium System**:
  - Exempts VIP users from shortener links, force-sub channels, and rate limits.
  - Admins can grant or revoke premium status with custom duration directly in the bot.

---

## 📢 Force-Subscribe & Growth System

- **Multi-Channel Support**: Require users to join one or multiple channels/groups before accessing files.
- **Modes**:
  - **Normal Mode**: Checks real-time chat membership (supports owners, admins, members, and restricted users with `is_member: true`).
  - **Join Request Mode**: Integrates with Telegram join requests; automatically recognizes pending requests so users can access files immediately after applying.
- **Viral Referral System**:
  - Every user gets a personal referral link via `/me` (`https://t.me/<bot>?start=ref_<chatId>`).
  - Automatic referral completion when referred users join the required force-sub channels.
  - Configurable rewards (e.g., 3 referrals = 24 hours of Premium).

---

## 🛠 Interactive Admin Dashboard

Access the complete visual dashboard by sending `/setting` or tapping **Admin Dashboard** in `/start`:

- ⚙️ **Bot Configuration**: Set default bot token, manage additional bots, configure channel IDs.
- 🗄 **Storage Management**: Switch primary/backup channels, audit links, run link health scans (`/scanbroken`).
- 🔐 **Verification & Shortener**: Set primary & backup shorteners, API keys, token validity, and tutorial files.
- 📢 **Force-Subscribe**: Add/remove channels, switch between Normal and Join Request modes.
- ⏱ **Auto-Delete Settings**: Configure countdown timers and toggle auto-deletion.
- 🎨 **Visual Customization**: Set custom start messages, delivery banners, f-sub banners, and verification graphics.
- 👥 **User & Ban Management**: View active users, ban/unban IDs, search profiles.
- 📢 **Broadcast Engine**: Send broadcast messages with live progress tracking, test preview, and pin options.
- 📖 **Admin Guide Shortcut**: Instant access to the complete administrator command reference directly from the dashboard.

---

## 📖 Help System & Interactive Guides

The bot incorporates a unified, synchronized **Interactive Help & Guide Engine** serving both end users and administrators with single-source-of-truth instructions and inline navigation:

### 1. User Help & Guide (`/help` or About Menu `Help` button)
Accessible to all users via the `/help` command or by tapping the **Help** button inside the **About** menu:
- **File Downloads**: Clear instructions on retrieving files, batches, and multi-quality releases, plus tips to forward auto-deleting files to *Saved Messages*.
- **Expiring Temporary Links**: Syntax, time format guidelines (`15m`, `1h`, `24h`, `3d`, `7d`), and examples for `/temptoken <code_id> [duration] [max_uses]`.
- **Token Management**: Instructions for inspecting active links with `/mytokens` and revoking tokens with `/revoketoken`.
- **Viral Referral Program**: How to access `/me`, share personal invite links, and track referral counts to unlock VIP/Premium status.
- **VIP / Premium Privileges**: Details on shortener bypass, force-sub exemption, and zero rate limits.
- **Latency & Ping**: Instant speed and system check with `/ping`.
- **Admin-Only Protection**: The **Admin Guide** and **Admin Dashboard** buttons, as well as admin shortcut instructions, are strictly hidden from regular users and only rendered when an authorized administrator accesses the help guide.

### 2. Admin Command Reference & Guide (`/adminhelp` or Dashboard `Admin Guide`)
Exclusively accessible to verified bot administrators via `/adminhelp` or the **Admin Guide** button inside the dashboard:
- **Categorized Reference**: Logically organizes all 25+ administrative commands into clear functional sections:
  - *Dashboard & Diagnostics* (`/setting`, `/status`, `/ping`, `/checkchannels`)
  - *File & Media Storing* (`/store`, `/batch`, `/bundle`, `/bulkstore`, `/cancel`)
  - *Traffic, Analytics & Exports* (`/exportlinks`, `/todaylinks`, `/topfiles`, `/userstats`, `/toprefs`)
  - *Storage Auditing & Disaster Recovery* (`/auditlinks`, `/scanbroken`, `/rebuildchannel`, `/backup`)
  - *User Moderation & Broadcasts* (`/user`, `/ban`, `/unban`, `/banlist`, `/broadcast`)
  - *Record Management* (`/editfile`, `/delete`)
- **Seamless Inline Navigation**: Switch between **Admin Dashboard**, **File Management Hub**, **Storage Audit**, and **User Guide** in one tap.

---

## ⚙️ Environment Variables

Configure these variables in your hosting environment (Render, Railway, VPS, or `.env` file):

| Variable | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | **Yes** | Main Telegram Bot token from [@BotFather](https://t.me/BotFather) | `7123456789:AAH...` |
| `TELEGRAM_WEBHOOK_SECRET`| **Yes** | Strong secret string proving incoming updates are from Telegram | `c8f1e948...` |
| `BOT_DOMAIN` | **Yes** | Public domain of your deployed server (HTTPS required) | `https://my-filestore.onrender.com` |
| `MONGODB_URI` | **Yes** | MongoDB connection string (Atlas or self-hosted) | `mongodb+srv://...` |
| `ADMIN_CHAT_ID` | **Yes** | Numeric Telegram User ID of the super admin | `987654321` |
| `TELEGRAM_DB_CHANNEL_ID` | No | Private storage channel ID (can also be set via `/setting`) | `-1001234567890` |
| `PORT` | No | Server port (default: `3000` or assigned by host) | `3000` |

> [!TIP]
> Generate a strong 32-byte webhook secret with:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

---

## 🚀 Quick Start & Deployment

### Option A: Deploy to Render (Recommended)

1. Fork or push this repository to your GitHub account.
2. Log in to [Render](https://render.com) and click **New +** → **Blueprint**.
3. Select your repository. Render will automatically detect [`render.yaml`](file:///d:/telegram-file-store-bot/render.yaml).
4. Fill in the required environment variables in the Render Dashboard.
5. Click **Apply**. Once deployed, Render will set up the health check (`/health`) and start the service.
6. Open `https://<YOUR_BOT_DOMAIN>/setWebhook` in your browser to register your webhook with Telegram.

---

### Option B: Manual / VPS / Local Deployment

```bash
# 1. Clone repository
git clone https://github.com/your-username/telegram-file-store-bot.git
cd telegram-file-store-bot

# 2. Install production dependencies
npm install

# 3. Create .env file
cp .env.example .env
# Edit .env with your credentials

# 4. Verify syntax
npm run lint

# 5. Start the bot
npm start
```

For 24/7 background operation on a Linux VPS, use **PM2**:
```bash
npm install -g pm2
pm2 start src/server.js --name "filestore-bot"
pm2 save
pm2 startup
```

---

## 🤖 Webhook Configuration

### Automated Webhook Setup
Once your server is running, visit:
```
https://<YOUR_BOT_DOMAIN>/setWebhook
```
This automatically registers the webhook with Telegram and enables all required update types (`message`, `callback_query`, `chat_join_request`, `chat_member`, `my_chat_member`).

### Manual Webhook Setup
Alternatively, make a GET request to Telegram's API:
```bash
curl -F "url=https://<YOUR_BOT_DOMAIN>/webhook/telegram" \
     -F "secret_token=<YOUR_TELEGRAM_WEBHOOK_SECRET>" \
     -F 'allowed_updates=["message","callback_query","chat_join_request","chat_member","my_chat_member"]' \
     "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook"
```

---

## 📚 Complete Command Reference

### Admin Commands

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/setting` | None | Open the interactive graphical Admin Dashboard |
| `/adminhelp` | None | Display complete administrator command reference & guide with navigation buttons |
| `/store` | None | Enter interactive single-file storage mode (send or forward file) |
| `/batch` | None | Start a batch file session (Collector or Channel Message Range mode) |
| `/bundle` *(or `/quality`)* | `[title]` | Create a multi-quality video release bundle (auto-detects 480p, 720p, 1080p, 4K) |
| `/bulkstore` | None | Rapid bulk storage mode with 1-tap link list & `.txt` document export |
| `/exportlinks` | `[duration] [type]` | Export links created within a timeframe (e.g. `15m`, `1h`, `today`, `all`) as `.txt` |
| `/todaylinks` | None | View and copy all file links generated today with live download counts |
| `/topfiles` | None | View top 10 most downloaded files/batches and traffic analytics dashboard |
| `/userstats` | None | View user metrics, ban count, active users, and 7-day download activity chart |
| `/toprefs` | None | View viral referral leaderboard (Top 10 referrers across the bot) |
| `/status` | None | Comprehensive system health monitor (DB latency, Webhook status, RAM, Uptime) |
| `/ping` | None | Test Telegram API latency, database connection, and memory usage |
| `/broadcast` | `<message>` | Mass broadcast with draft preview, test send to self, and pin options |
| `/user` | `<id\|@username>` | Inspect user profile, registration date, VIP status, and referral metrics |
| `/ban` | `<id\|@username> [duration] [reason]` | Ban a user temporarily (e.g. `24h`) or permanently with optional reason |
| `/unban` | `<id\|@username>` | Unban a user by chat ID or username |
| `/banlist` | None | List all currently banned user IDs with 1-click unban buttons |
| `/editfile` *(or `/rename`)* | `<code> <new_title>` | Rename the title of any stored file, batch, or bundle |
| `/delete` | `<code>` | Permanently remove record from database and storage channels |
| `/checkchannels` | None | Diagnostic health check on Primary DB, Backup DB & Force-Sub channels |
| `/auditlinks` | None | Interactive storage redundancy audit and link health dashboard |
| `/scanbroken` | `[limit]` | Scan stored files and auto-heal missing links from the backup DB channel |
| `/rebuildchannel` | `<channel_id>` | 1-click cloud CDN recovery: re-upload all files to a fresh channel without downtime |
| `/backup` *(or `/exportdb`)* | None | Export entire database records as a JSON document |
| `/cancel` | None | Cancel any active batch, bundle, bulk-store, or waiting prompt session |

### User Commands

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/start` | `[payload]` | Access main menu or retrieve files, batches, and bundles via deep-link |
| `/help` | None | Open interactive user guide covering downloads, expiring links, referrals & VIP |
| `/me` | None | View account profile, VIP membership status, referral count, and referral link |
| `/temptoken` *(or `/sharetemp`)* | `<code_id> [duration] [max]` | Generate a temporary, self-expiring link with time and optional download limit |
| `/mytokens` *(or `/temptokens`)* | None | View and manage all your active temporary access tokens |
| `/revoketoken` | `<token_code>` | Immediately invalidate and deactivate a temporary access token |
| `/ping` | None | Test bot responsiveness, connection speed, server uptime, and system status |

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
Feel free to modify, deploy, and distribute for personal or commercial projects.
