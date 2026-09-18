import {
  getSettings, esc, toSmallCaps, isSafePublicUrl, isMainBot
} from './bot-common.js';
import { getMainBotUsername, getBotId } from './channel-helpers.js';

export const GROUP_TYPES = new Set(['group', 'supergroup']);

export function getAdminDashboardKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: toSmallCaps('📁 Files & Storage'), callback_data: 'admin:file_mgmt' },
        { text: toSmallCaps('👥 Users & Access'), callback_data: 'admin:user_mgmt' }
      ],
      [
        { text: toSmallCaps('🛡️ Security & Fleet'), callback_data: 'admin:sec_hub' },
        { text: toSmallCaps('⚙️ Bot Settings'), callback_data: 'admin:fs_settings' }
      ],
      [
        { text: toSmallCaps('📊 Statistics'), callback_data: 'admin:stats' },
        { text: toSmallCaps('📢 Broadcast'), callback_data: 'admin:broadcast_prompt' }
      ],
      [
        { text: toSmallCaps('📖 Admin Guide'), callback_data: 'admin:admin_help' },
        { text: toSmallCaps('🏠 Main Menu'), callback_data: 'user:back_start' }
      ]
    ]
  };
}

export function getExportHubKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: toSmallCaps('Single Files'), callback_data: 'admin:export_type:media' },
        { text: toSmallCaps('Batches'), callback_data: 'admin:export_type:batch' }
      ],
      [
        { text: toSmallCaps('All Links (Combined)'), callback_data: 'admin:export_type:all' }
      ],
      [
        { text: toSmallCaps('Back to File Management'), callback_data: 'admin:file_mgmt' }
      ]
    ]
  };
}

export function getExportTimeKeyboard(filterType = 'all') {
  const typeLabel = filterType === 'batch' ? 'Batches' : filterType === 'media' ? 'Files' : 'Links';
  return {
    inline_keyboard: [
      [
        { text: toSmallCaps('Last 15 Mins'), callback_data: `admin:exp_time:900:${filterType}` },
        { text: toSmallCaps('Last 30 Mins'), callback_data: `admin:exp_time:1800:${filterType}` }
      ],
      [
        { text: toSmallCaps('Last 1 Hour'), callback_data: `admin:exp_time:3600:${filterType}` },
        { text: toSmallCaps('Last 6 Hours'), callback_data: `admin:exp_time:21600:${filterType}` }
      ],
      [
        { text: toSmallCaps(`Today's ${typeLabel}`), callback_data: `admin:exp_today:${filterType}` },
        { text: toSmallCaps(`All Time ${typeLabel}`), callback_data: `admin:exp_all:${filterType}` }
      ],
      [
        { text: toSmallCaps('Custom Duration'), callback_data: `admin:exp_custom_prompt:${filterType}` }
      ],
      [
        { text: toSmallCaps('Back to Export Hub'), callback_data: 'admin:export_hub' }
      ]
    ]
  };
}

export function getExportLinksKeyboard() {
  return getExportHubKeyboard();
}

export async function buildStartMenuButtons(admin) {
  if (!isMainBot()) {
    const mainBotUsername = await getMainBotUsername();
    const botId = await getBotId();
    if (admin) {
      return [
        [{ text: toSmallCaps('⚙️ Manage in Main Bot'), url: `https://t.me/${mainBotUsername}?start=clone_view_${botId}` }],
        [{ text: toSmallCaps('🔄 Check Health'), callback_data: 'user:clone_health' }]
      ];
    }
    return [
      [{ text: toSmallCaps('🚀 Open Main Bot'), url: `https://t.me/${mainBotUsername}` }]
    ];
  }

  const buttons = [
    [{ text: '⭐ My Plan', callback_data: 'user:my_plan' }, { text: 'My Profile', callback_data: 'user:me' }, { text: 'About', callback_data: 'user:about' }]
  ];
  if (admin) {
    buttons.unshift([{ text: 'Admin Dashboard', callback_data: 'admin:dashboard' }]);
  }
  return buttons.map(row => row.map(btn => ({ ...btn, text: toSmallCaps(btn.text) })));
}

// ─── Start Message Formatter ──────────────────────────────────────────────────
export const DEFAULT_START_TEXT = `👋 <b>Hey {mention}! Welcome to Filestore Bot!</b>\n\n` +
  `I am an advanced <b>Telegram Filestore & Media Distribution Bot</b>.\n\n` +
  `⚡ <b>What can I do?</b>\n` +
  `• Permanent secure cloud storage for files & media\n` +
  `• Multi-quality video release bundles (480p, 720p, 1080p, 4K)\n` +
  `• Time-limited expiring access links with <code>/temptoken</code>\n` +
  `• Viral referral program to earn free VIP/Premium status\n\n` +
  `Tap <b>My Profile</b> to check your account & referral link, or <b>About</b> for help and details!`;

export function formatStartMessage(customTemplate, userObj = {}, chatId = '') {
  const firstName = userObj?.first_name || 'User';
  const lastName = userObj?.last_name || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const username = userObj?.username ? `@${userObj.username}` : '';
  const mention = `<a href="tg://user?id=${chatId}">${esc(firstName)}</a>`;

  const template = (customTemplate && customTemplate.trim()) ? customTemplate : DEFAULT_START_TEXT;

  return template
    .replace(/{mention}/g, mention)
    .replace(/{first_name}/g, esc(firstName))
    .replace(/{last_name}/g, esc(lastName))
    .replace(/{full_name}/g, esc(fullName))
    .replace(/{username}/g, username || mention)
    .replace(/{id}/g, String(chatId));
}

// ─── Help Messages (Single Source of Truth) ───────────────────────────────────
export function getUserHelpMessage(isAdminUser = false) {
  const adminSection = isAdminUser
    ? `\n\n🛠 <b>Administrator Shortcuts:</b>\n` +
      `• <code>/adminhelp</code> — Complete admin command reference & guide\n` +
      `• <code>/setting</code> — Open interactive visual Admin Dashboard`
    : '';

  const text = `📖 <b>Bot Help & User Guide</b>\n\n` +
    `Welcome to the <b>Filestore Bot</b>! Here is everything you need to know about using this bot:\n\n` +
    `<blockquote expandable>` +
    `📥 <b>Getting & Downloading Files</b>\n` +
    `• Click any shared file, batch, or bundle link.\n` +
    `• Complete channel subscription or verification if prompted.\n` +
    `💡 <i>Tip: If auto-delete is active, forward files to your <b>Saved Messages</b> to keep them permanently!</i>\n\n` +
    `⏳ <b>Temporary Expiring Links</b>\n` +
    `Share files or batches that expire automatically after a set duration or download count:\n` +
    `• <code>/temptoken &lt;code&gt; [duration] [max_downloads]</code>\n` +
    `  <i>Examples:</i>\n` +
    `  └ <code>/temptoken file_abc123 1h</code> (valid for 1 hour)\n` +
    `  └ <code>/temptoken file_abc123 24h 1</code> (valid for 24h or 1 download only)\n` +
    `  └ <code>/temptoken batch_xyz789 30m</code> (valid for 30 minutes)\n` +
    `• <code>/mytokens</code> — View and inspect all your active temporary links\n` +
    `• <code>/revoketoken &lt;token_code&gt;</code> — Invalidate a temporary link immediately\n\n` +
    `👤 <b>Profile & Viral Referrals</b>\n` +
    `• <code>/me</code> — View your ID, status, and personal referral link\n` +
    `• <b>Earn Free Premium:</b> Share your referral link with friends. When they join, you earn VIP/Premium perks!\n\n` +
    `⭐ <b>Premium Membership Perks</b>\n` +
    `• Instant file downloads without URL shortener verification\n` +
    `• Bypass force-subscribe channel requirements\n` +
    `• Zero cooldowns or speed restrictions\n\n` +
    `🏓 <b>Bot Speed & Latency</b>\n` +
    `• <code>/ping</code> — Check bot responsiveness, server uptime, and connection latency` +
    `</blockquote>` +
    adminSection +
    `\n\nNeed more assistance? Contact our support via the About menu.`;

  const buttons = [
    [{ text: toSmallCaps('My Active Tokens'), callback_data: 'user:my_tokens' }, { text: toSmallCaps('My Profile'), callback_data: 'user:me' }]
  ];
  if (isAdminUser) {
    buttons.push([
      { text: toSmallCaps('Admin Guide'), callback_data: 'admin:admin_help' },
      { text: toSmallCaps('Admin Dashboard'), callback_data: 'admin:dashboard' }
    ]);
  }
  buttons.push([{ text: toSmallCaps('Back to Menu'), callback_data: 'user:back_start' }]);

  return { text, replyMarkup: { inline_keyboard: buttons } };
}

export function getAdminHelpMessage() {
  const text = `🛠 <b>Administrator Command Reference & Guide</b>\n\n` +
    `Manage files, storage channels, analytics, and bot settings using the commands below:\n\n` +
    `<blockquote expandable>` +
    `⚙️ <b>Dashboard & Diagnostics</b>\n` +
    `• <code>/setting</code> — Open interactive graphical Admin Dashboard\n` +
    `• <code>/status</code> — Live health monitor (DB latency, Webhooks, RAM, Uptime)\n` +
    `• <code>/ping</code> — Test Telegram API latency and server connection\n` +
    `• <code>/checkchannels</code> — Diagnostic health check on Primary DB, Backup DB & F-Sub channels\n\n` +
    `📦 <b>File & Media Storing</b>\n` +
    `• <code>/store</code> — Interactive single-file storage mode (send or forward file)\n` +
    `• <code>/batch</code> — Create batch link from message range or interactive forwarding (up to 500 files)\n` +
    `• <code>/bundle [title]</code> or <code>/quality [title]</code> — Create multi-quality release bundle (auto-detects 480p, 720p, 1080p, 4K)\n` +
    `• <code>/bulkstore</code> — Rapidly forward files to store in bulk; generates copyable list and .txt export\n` +
    `• <code>/cancel</code> — Abort any active batch, bundle, bulk store, or waiting session\n\n` +
    `📊 <b>Traffic, Analytics & Exports</b>\n` +
    `• <code>/exportlinks [duration] [type]</code> — Export links created within duration (e.g. <code>15m</code>, <code>1h</code>, <code>today</code>, <code>all</code>) as a <code>.txt</code> file\n` +
    `• <code>/todaylinks</code> — View and copy all links created today with download counts\n` +
    `• <code>/topfiles</code> — Top 10 most downloaded files/batches & traffic dashboard\n` +
    `• <code>/userstats</code> — User statistics, ban count, active users, and 7-day download chart\n` +
    `• <code>/toprefs</code> — Viral referral leaderboard (Top 10 referrers)\n\n` +
    `🛡 <b>Storage Auditing & Disaster Recovery</b>\n` +
    `• <code>/auditlinks</code> — Interactive storage redundancy & backup channel audit\n` +
    `• <code>/audit [batch] [--full]</code> — Run continuous/deep automated DB & link health audit with self-healing\n` +
    `• <code>/scanbroken [limit]</code> — Scan stored files and auto-heal missing links from backup DB channel\n` +
    `• <code>/rebuildchannel &lt;channel_id&gt;</code> — 1-click cloud CDN recovery: re-posts all database files into a new channel without breaking user links\n` +
    `• <code>/backup</code> (or <code>/exportdb</code>) — Download complete database backup as a JSON document\n\n` +
    `👥 <b>User Moderation & VIP Management</b>\n` +
    `• <code>/addvip &lt;id|@username&gt; &lt;days|lifetime&gt;</code> — Grant VIP fast-pass membership (zero ads, no force-sub)\n` +
    `• <code>/delvip &lt;id|@username&gt;</code> — Revoke VIP membership from user\n` +
    `• <code>/user &lt;id|@username&gt;</code> — Inspect user profile, join date, VIP status, and referrals\n` +
    `• <code>/ban &lt;id|@username&gt; [duration] [reason]</code> — Ban user (e.g. <code>/ban @user 24h spam</code>)\n` +
    `• <code>/unban &lt;id|@username&gt;</code> — Unban a user\n` +
    `• <code>/banlist</code> — View all banned users with 1-click unban buttons\n` +
    `• <code>/broadcast &lt;message&gt;</code> — Mass broadcast with draft preview, test send, and pin options\n\n` +
    `✏️ <b>Record Management</b>\n` +
    `• <code>/editfile &lt;code&gt; &lt;new_title&gt;</code> (or <code>/rename</code>) — Update title of stored file, batch, or bundle\n` +
    `• <code>/delete &lt;code&gt;</code> — Permanently remove record from DB & storage channels (2-step confirmed)\n` +
    `• <code>/wipe</code> (or <code>/cleandb</code>) — Data wipe & system cleanup hub with 2-step verification` +
    `</blockquote>`;

  const buttons = [
    [{ text: toSmallCaps('Open Dashboard'), callback_data: 'admin:dashboard' }, { text: toSmallCaps('File Management'), callback_data: 'admin:file_mgmt' }],
    [{ text: toSmallCaps('Storage & Backup Audit'), callback_data: 'admin:storage_audit' }, { text: toSmallCaps('Export Links Hub'), callback_data: 'admin:export_hub' }],
    [{ text: toSmallCaps('User Guide (/help)'), callback_data: 'user:help' }, { text: toSmallCaps('Main Menu'), callback_data: 'user:back_start' }]
  ];

  return { text, replyMarkup: { inline_keyboard: buttons } };
}

export function isCommand(text)                 { return /^\/[a-z_]+(@\S+)?(\s|$)/i.test(text); }
export function mentionsBot(text, botUsername)  { return botUsername && text.toLowerCase().includes(`@${botUsername}`); }

export async function getSponsorButton() {
  try {
    const s = await getSettings();
    if (s?.sponsorBtnEnabled !== '1') return null;
    const text = (s?.sponsorBtnText || '').trim();
    const url = (s?.sponsorBtnUrl || '').trim();
    if (!text || !url) return null;
    if (isSafePublicUrl(url) || url.startsWith('tg://') || url.startsWith('https://t.me/')) {
      return { text: toSmallCaps(text), url };
    }
    return null;
  } catch {
    return null;
  }
}
