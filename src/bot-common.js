import { MongoClient } from 'mongodb';
import { AsyncLocalStorage } from 'node:async_hooks';

export const botContext = new AsyncLocalStorage();

// ─── MongoDB Connection ───────────────────────────────────────────────────────
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();

if (!MONGODB_URI) {
  console.error('CRITICAL: MONGODB_URI environment variable is missing!');
}

let client = null;
let db = null;
let dbPromise = null;

export async function getDb() {
  if (db) return db;
  if (dbPromise) return dbPromise;

  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is missing');
  }

  dbPromise = (async () => {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    const database = client.db();

    // Ensure indexes are created asynchronously (fire-and-forget/non-blocking)
    database.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
      .catch(err => console.error('Error creating sessions expiresAt index:', err.message));
    database.collection('users').createIndex({ username: 1 }, { unique: false, sparse: true })
      .catch(err => console.error('Error creating users username index:', err.message));

    db = database;
    return db;
  })();

  try {
    return await dbPromise;
  } catch (err) {
    dbPromise = null;
    if (err.message && err.message.includes('SSL alert number 80')) {
      throw new Error('\n\n🚨 MONGODB CONNECTION ERROR: IP NOT WHITELISTED 🚨\n' +
                      'Cloudflare Workers have dynamic IP addresses worldwide. You must allow ALL IPs to access your database.\n' +
                      '1. Go to your MongoDB Atlas dashboard.\n' +
                      '2. On the left menu, click "Network Access" under "Security".\n' +
                      '3. Click "Add IP Address".\n' +
                      '4. Click "Allow Access From Anywhere" (which adds 0.0.0.0/0).\n' +
                      '5. Click Confirm.\n' +
                      'Wait a few minutes for changes to deploy, then try again.\n\n' +
                      'Original Error: ' + err.message);
    }
    throw err;
  }
}

export async function getCollection(name) {
  const database = await getDb();
  return database.collection(name);
}

// ─── Settings Helpers ─────────────────────────────────────────────────────────
let cachedSettings = null;
let cachedSettingsTime = 0;
const SETTINGS_CACHE_TTL = 10 * 1000; // 10 seconds TTL

export async function getSettings() {
  const now = Date.now();
  if (cachedSettings && (now - cachedSettingsTime) < SETTINGS_CACHE_TTL) {
    return cachedSettings;
  }
  const coll = await getCollection('settings');
  const s = await coll.findOne({ _id: 'global' });
  cachedSettings = s || {};
  cachedSettingsTime = now;
  return cachedSettings;
}

export async function updateSettings(fields) {
  const coll = await getCollection('settings');
  await coll.updateOne({ _id: 'global' }, { $set: fields }, { upsert: true });
  // Invalidate cache immediately on update
  cachedSettings = null;
  cachedSettingsTime = 0;
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────
export async function isRateLimited(id, limit = 5, window = 10) {
  const coll = await getCollection('sessions');
  const key = `rate_limit:${id}`;
  const now = new Date();

  // Atomically find non-expired rate limit document and increment count.
  const result = await coll.findOneAndUpdate(
    { _id: key, expiresAt: { $gt: now } },
    { $inc: { count: 1 } },
    { returnDocument: 'after' }
  );

  // Support both newer MongoDB driver versions (direct document return) and older versions ({ value })
  const doc = result && (result.value !== undefined ? result.value : result);
  if (doc) {
    return doc.count > limit;
  }

  // If not found or expired, upsert and initialize/reset count and expiresAt.
  await coll.updateOne(
    { _id: key },
    { $set: { count: 1, expiresAt: new Date(Date.now() + window * 1000) } },
    { upsert: true }
  );
  return false;
}

// ─── Logger ───────────────────────────────────────────────────────────────────
export function log(level, message, meta = {}) {
  const entry = { timestamp: new Date().toISOString(), level, message, ...meta };
  level === 'error'
    ? console.error(JSON.stringify(entry))
    : console.log(JSON.stringify(entry));
}

// ─── HTML escape ──────────────────────────────────────────────────────────────
export function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Small Caps Unicode map ───────────────────────────────────────────────────
export function toSmallCaps(text) {
  if (!text) return '';
  const map = {
    A:'ᴀ',B:'ʙ',C:'ᴄ',D:'ᴅ',E:'ᴇ',F:'ꜰ',G:'ɢ',H:'ʜ',I:'ɪ',J:'ᴊ',
    K:'ᴋ',L:'ʟ',M:'ᴍ',N:'ɴ',O:'ᴏ',P:'ᴘ',Q:'ǫ',R:'ʀ',S:'ꜱ',T:'ᴛ',
    U:'ᴜ',V:'ᴠ',W:'ᴡ',X:'x',Y:'ʏ',Z:'ᴢ',
    a:'ᴀ',b:'ʙ',c:'ᴄ',d:'ᴅ',e:'ᴇ',f:'ꜰ',g:'ɢ',h:'ʜ',i:'ɪ',j:'ᴊ',
    k:'ᴋ',l:'ʟ',m:'ᴍ',n:'ɴ',o:'ᴏ',p:'ᴘ',q:'ǫ',r:'ʀ',s:'ꜱ',t:'ᴛ',
    u:'ᴜ',v:'ᴠ',w:'ᴡ',x:'x',y:'ʏ',z:'ᴢ',
  };
  return text.split('').map(c => map[c] || c).join('');
}

// ─── Button Formatting Helper (No Emojis, Small Caps, Subscript Digits) ──────
export function formatButtonText(text) {
  if (!text) return '';

  // Strip emojis, Variation Selectors, and common decorative/ASCII symbols (+ < > •)
  let clean = text
    .replace(/[\p{Extended_Pictographic}\uFE00-\uFE0F]/gu, '')
    .replace(/[+<>•✖◀▶⬅➡➡️]/g, '')
    .trim()
    .replace(/\s+/g, ' ');

  // If the text became empty (e.g. it was just an emoji like ❌), fallback to 'x'
  if (!clean) {
    clean = 'x';
  }

  const map = {
    A:'ᴀ',B:'ʙ',C:'ᴄ',D:'ᴅ',E:'ᴇ',F:'ꜰ',G:'ɢ',H:'ʜ',I:'ɪ',J:'ᴊ',
    K:'ᴋ',L:'ʟ',M:'ᴍ',N:'ɴ',O:'ᴏ',P:'ᴘ',Q:'ǫ',R:'ʀ',S:'ꜱ',T:'ᴛ',
    U:'ᴜ',V:'ᴠ',W:'ᴡ',X:'x',Y:'ʏ',Z:'ᴢ',
    a:'ᴀ',b:'ʙ',c:'ᴄ',d:'ᴅ',e:'ᴇ',f:'ꜰ',g:'ɢ',h:'ʜ',i:'ɪ',j:'ᴊ',
    k:'ᴋ',l:'ʟ',m:'ᴍ',n:'ɴ',o:'ᴏ',p:'ᴘ',q:'ǫ',r:'ʀ',s:'ꜱ',t:'ᴛ',
    u:'ᴜ',v:'ᴠ',w:'ᴡ',x:'x',y:'ʏ',z:'ᴢ',
    '0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉'
  };
  return clean.split('').map(c => map[c] || c).join('');
}

// ─── Format all buttons in inline keyboards or custom keyboards ──────────────
export function formatReplyMarkup(replyMarkup) {
  if (!replyMarkup) return replyMarkup;

  // Deep clone the object to avoid mutating the original passed in
  const formatted = JSON.parse(JSON.stringify(replyMarkup));

  if (formatted.inline_keyboard && Array.isArray(formatted.inline_keyboard)) {
    formatted.inline_keyboard = formatted.inline_keyboard.map(row => {
      if (Array.isArray(row)) {
        return row.map(btn => {
          if (btn && typeof btn === 'object' && 'text' in btn) {
            btn.text = formatButtonText(btn.text);
          }
          return btn;
        });
      }
      return row;
    });
  }

  if (formatted.keyboard && Array.isArray(formatted.keyboard)) {
    formatted.keyboard = formatted.keyboard.map(row => {
      if (Array.isArray(row)) {
        return row.map(btn => {
          if (btn && typeof btn === 'object' && 'text' in btn) {
            btn.text = formatButtonText(btn.text);
          } else if (typeof btn === 'string') {
            return formatButtonText(btn);
          }
          return btn;
        });
      }
      return row;
    });
  }

  return formatted;
}

// ─── Small Caps Safe for HTML/Commands/Placeholders ───────────────────────────
export function toSmallCapsSafe(text) {
  if (!text) return '';
  const tagRegex = /(<\/?[a-zA-Z][^>]*>)/g;
  const parts = text.split(tagRegex);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return part; // HTML tag — leave untouched
    }
    const urlRegex = /(https?:\/\/\S+)/g;
    const urlParts = part.split(urlRegex);
    return urlParts.map((urlPart, uIdx) => {
      if (uIdx % 2 === 1) {
        return urlPart; // full URL — leave untouched
      }
      const cmdRegex = /(\/[a-zA-Z_0-9@]+)/g;
      const subParts = urlPart.split(cmdRegex);
      return subParts.map((sub, sIdx) => {
        if (sIdx % 2 === 1) {
          return sub; // /command — leave untouched
        }
        const plRegex = /(\{[a-zA-Z_]+\})/g;
        const plParts = sub.split(plRegex);
        return plParts.map((plPart, pIdx) => {
          if (pIdx % 2 === 1) {
            return plPart; // {placeholder} — leave untouched
          }
          return toSmallCaps(plPart);
        }).join('');
      }).join('');
    }).join('');
  }).join('');
}

// ─── Token helpers ────────────────────────────────────────────────────────────
export function getMainToken() {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^bot/i, '');
}

export function getToken() {
  const ctx = botContext.getStore();
  if (ctx?.token) return ctx.token.replace(/^bot/i, '');
  return getMainToken();
}

// ─── Webhook secret helper ───────────────────────────────────────────────
export function getWebhookSecret() {
  return (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
}

// ─── Validity-hours parsing ───────────────────────────────────────────────────
// Used for the "token verification renewal" setting. `0` is a legitimate,
// intentional admin choice (token expires immediately -> user must re-verify
// on every request) and must NOT be treated the same as "unset". Only
// missing/blank/invalid input should fall back to the default.
//
// Previously this used `parseInt(raw) || 24` / `(validityHours || 24)`, and
// since `0` is falsy in JS, an admin-set "0 hours" silently became 24 hours
// everywhere it was used — which is what caused the verification bug.
export function parseValidityHours(raw, fallback = 24) {
  if (raw === undefined) return fallback;
  if (raw === null) return fallback;
  if (String(raw).trim() === '') return fallback;

  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return fallback;

  return n;
}

// ─── Telegram API helpers ─────────────────────────────────────────────────────
export async function sendTelegramMessage(chatId, text, replyMarkup = null, protectContent = false) {
  const token = getToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const styledText = toSmallCapsSafe(text);
    const body = {
      chat_id: chatId, text: styledText, parse_mode: 'HTML',
      disable_web_page_preview: true, protect_content: protectContent,
    };
    if (replyMarkup) body.reply_markup = formatReplyMarkup(replyMarkup);
    const res  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { ok: res.ok, messageId: data.result?.message_id, detail: data };
  } catch (err) {
    return { ok: false, reason: 'network_error', detail: err.message };
  }
}

export async function sendTelegramDocument(chatId, documentId, caption = '', replyMarkup = null, protectContent = false) {
  const token = getToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const styledCaption = toSmallCapsSafe(caption);
    const body = { chat_id: chatId, document: documentId, caption: styledCaption, parse_mode: 'HTML', protect_content: protectContent };
    if (replyMarkup) body.reply_markup = formatReplyMarkup(replyMarkup);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) { return { ok: false, reason: err.message }; }
}

export async function sendTelegramVideo(chatId, videoId, caption = '', replyMarkup = null, protectContent = false) {
  const token = getToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const styledCaption = toSmallCapsSafe(caption);
    const body = { chat_id: chatId, video: videoId, caption: styledCaption, parse_mode: 'HTML', protect_content: protectContent };
    if (replyMarkup) body.reply_markup = formatReplyMarkup(replyMarkup);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) { return { ok: false, reason: err.message }; }
}

export async function sendTelegramAudio(chatId, audioId, caption = '', replyMarkup = null, protectContent = false) {
  const token = getToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const styledCaption = toSmallCapsSafe(caption);
    const body = { chat_id: chatId, audio: audioId, caption: styledCaption, parse_mode: 'HTML', protect_content: protectContent };
    if (replyMarkup) body.reply_markup = formatReplyMarkup(replyMarkup);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendAudio`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) { return { ok: false, reason: err.message }; }
}

export async function sendTelegramPhoto(chatId, photoUrl, caption, replyMarkup = null, protectContent = false) {
  const token = getToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const styledCaption = toSmallCapsSafe(caption);
    const body = { chat_id: chatId, photo: photoUrl, caption: styledCaption, parse_mode: 'HTML', protect_content: protectContent };
    if (replyMarkup) body.reply_markup = formatReplyMarkup(replyMarkup);
    const res  = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { ok: res.ok, messageId: data.result?.message_id };
  } catch (err) { return { ok: false, reason: err.message }; }
}

export async function editTelegramMessage(chatId, messageId, text, replyMarkup = null, disablePreview = true) {
  const token = getToken();
  if (!token) return { ok: false };
  try {
    const styledText = toSmallCapsSafe(text);
    const body = {
      chat_id: chatId, message_id: messageId, text: styledText,
      parse_mode: 'HTML', disable_web_page_preview: disablePreview,
    };
    if (replyMarkup) body.reply_markup = formatReplyMarkup(replyMarkup);
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { ok: res.ok };
  } catch { return { ok: false }; }
}

export async function deleteTelegramMessage(chatId, messageId) {
  const token = getToken();
  if (!token || !chatId || !messageId) return { ok: false };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    return { ok: res.ok };
  } catch { return { ok: false }; }
}

export async function answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
  const token = getToken();
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: showAlert }),
    });
  } catch {}
}

export async function sendChatAction(chatId, action = 'typing') {
  const token = getToken();
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch {}
}

export async function getChatMember(chatId, userId) {
  const token = getToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/getChatMember`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, user_id: userId }),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error_code: 500, description: err.message };
  }
}

export async function getChat(chatId) {
  const token = getToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error_code: 500, description: err.message };
  }
}

export async function createChatInviteLink(chatId, createsJoinRequest = false) {
  const token = getToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/createChatInviteLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        creates_join_request: createsJoinRequest
      }),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error_code: 500, description: err.message };
  }
}

export async function logHistory(event, method) {
  const coll = await getCollection('history');
  await coll.insertOne({
    event,
    method,
    time: new Date()
  });

  // Prune old logs in the background without blocking the request handler.
  (async () => {
    try {
      const count = await coll.countDocuments();
      if (count > 50) {
        const oldest = await coll.find().sort({ time: 1 }).limit(count - 50).toArray();
        if (oldest.length) {
          const ids = oldest.map(d => d._id);
          await coll.deleteMany({ _id: { $in: ids } });
        }
      }
    } catch (err) {
      console.error('Error pruning history logs:', err.message);
    }
  })();
}

export function isMainBot() {
  return getToken() === getMainToken();
}

export function getCurrentBotId() {
  const token = getToken();
  return token ? token.split(':')[0] : null;
}
