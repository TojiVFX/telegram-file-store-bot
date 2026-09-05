import { MongoClient } from 'mongodb';
import { AsyncLocalStorage } from 'node:async_hooks';

export const botContext = new AsyncLocalStorage();

// ─── In-Memory MongoDB Fallback Store ─────────────────────────────────────────
class InMemoryCollection {
  constructor(name) {
    this.name = name;
    this.docs = new Map();
  }

  _matches(doc, filter) {
    if (!filter || Object.keys(filter).length === 0) return true;
    for (const [key, val] of Object.entries(filter)) {
      if (key === '$or' && Array.isArray(val)) {
        if (!val.some(subFilter => this._matches(doc, subFilter))) return false;
        continue;
      }
      if (key === '$expr' && val && typeof val === 'object') {
        if (val.$lt && Array.isArray(val.$lt)) {
          const [fieldRef, targetRef] = val.$lt;
          const field = typeof fieldRef === 'string' && fieldRef.startsWith('$') ? fieldRef.slice(1) : fieldRef;
          const target = typeof targetRef === 'string' && targetRef.startsWith('$') ? targetRef.slice(1) : targetRef;
          const v1 = doc[field];
          const v2 = (typeof target === 'string' && target in doc) ? doc[target] : target;
          if (!(v1 < v2)) return false;
        }
        continue;
      }
      if (val && typeof val === 'object' && !(val instanceof Date)) {
        if (val.$exists !== undefined) {
          const exists = doc[key] !== undefined;
          if (exists !== val.$exists) return false;
        }
        if (Array.isArray(val.$in)) {
          if (!val.$in.includes(doc[key])) return false;
        }
        if (val.$ne !== undefined) {
          if (doc[key] === val.$ne) return false;
        }
        if (val.$gt !== undefined) {
          const docVal = doc[key] instanceof Date ? doc[key] : (key === 'expiresAt' || key === 'createdAt' ? new Date(doc[key]) : doc[key]);
          const filterVal = val.$gt instanceof Date ? val.$gt : (key === 'expiresAt' || key === 'createdAt' ? new Date(val.$gt) : val.$gt);
          if (!docVal || docVal <= filterVal) return false;
        }
        if (val.$gte !== undefined) {
          const docVal = doc[key] instanceof Date ? doc[key] : (key === 'expiresAt' || key === 'createdAt' ? new Date(doc[key]) : doc[key]);
          const filterVal = val.$gte instanceof Date ? val.$gte : (key === 'expiresAt' || key === 'createdAt' ? new Date(val.$gte) : val.$gte);
          if (!docVal || docVal < filterVal) return false;
        }
        if (val.$lt !== undefined) {
          const docVal = doc[key] instanceof Date ? doc[key] : (key === 'expiresAt' || key === 'createdAt' ? new Date(doc[key]) : doc[key]);
          const filterVal = val.$lt instanceof Date ? val.$lt : (key === 'expiresAt' || key === 'createdAt' ? new Date(val.$lt) : val.$lt);
          if (!docVal || docVal >= filterVal) return false;
        }
        if (val.$lte !== undefined) {
          const docVal = doc[key] instanceof Date ? doc[key] : (key === 'expiresAt' || key === 'createdAt' ? new Date(doc[key]) : doc[key]);
          const filterVal = val.$lte instanceof Date ? val.$lte : (key === 'expiresAt' || key === 'createdAt' ? new Date(val.$lte) : val.$lte);
          if (!docVal || docVal > filterVal) return false;
        }
        if (val.$regex) {
          const regex = new RegExp(val.$regex);
          if (!regex.test(String(doc[key] || ''))) return false;
        }
      } else {
        if (doc[key] !== val) return false;
      }
    }
    return true;
  }

  async createIndex() {
    return 'ok';
  }

  async findOne(filter) {
    for (const doc of this.docs.values()) {
      if (this._matches(doc, filter)) {
        return JSON.parse(JSON.stringify(doc));
      }
    }
    return null;
  }

  find(filter = {}) {
    let matched = [];
    for (const doc of this.docs.values()) {
      if (this._matches(doc, filter)) {
        matched.push(JSON.parse(JSON.stringify(doc)));
      }
    }
    const createCursor = (docs) => {
      let current = [...docs];
      return {
        sort: (sortSpec) => {
          const [field, order] = Object.entries(sortSpec || {})[0] || [];
          if (field) {
            current.sort((a, b) => {
              const valA = a[field] instanceof Date ? a[field].getTime() : a[field];
              const valB = b[field] instanceof Date ? b[field].getTime() : b[field];
              if (valA < valB) return order === 1 ? -1 : 1;
              if (valA > valB) return order === 1 ? 1 : -1;
              return 0;
            });
          }
          return createCursor(current);
        },
        skip: (n) => createCursor(current.slice(n)),
        limit: (n) => createCursor(current.slice(0, n)),
        toArray: async () => current,
      };
    };
    return createCursor(matched);
  }

  async updateOne(filter, update, options = {}) {
    let target = null;
    for (const doc of this.docs.values()) {
      if (this._matches(doc, filter)) {
        target = doc;
        break;
      }
    }

    if (!target) {
      if (options.upsert) {
        target = { _id: filter._id || String(Date.now() + Math.random()) };
        if (update.$setOnInsert) {
          Object.assign(target, update.$setOnInsert);
        }
        this.docs.set(target._id, target);
      } else {
        return { matchedCount: 0, modifiedCount: 0 };
      }
    }

    if (update.$set) {
      Object.assign(target, update.$set);
    }
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        target[k] = (target[k] || 0) + v;
      }
    }
    if (update.$push) {
      for (const [k, v] of Object.entries(update.$push)) {
        if (!Array.isArray(target[k])) target[k] = [];
        target[k].push(v);
      }
    }

    return { matchedCount: 1, modifiedCount: 1, upsertedId: target._id };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    let target = null;
    for (const doc of this.docs.values()) {
      if (this._matches(doc, filter)) {
        target = doc;
        break;
      }
    }

    if (!target) {
      return null;
    }

    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        target[k] = (target[k] || 0) + v;
      }
    }
    if (update.$set) {
      Object.assign(target, update.$set);
    }

    return JSON.parse(JSON.stringify(target));
  }

  async deleteOne(filter) {
    for (const [id, doc] of this.docs.entries()) {
      if (this._matches(doc, filter)) {
        this.docs.delete(id);
        return { deletedCount: 1 };
      }
    }
    return { deletedCount: 0 };
  }

  async deleteMany(filter) {
    let count = 0;
    for (const [id, doc] of this.docs.entries()) {
      if (this._matches(doc, filter)) {
        this.docs.delete(id);
        count++;
      }
    }
    return { deletedCount: count };
  }

  async insertOne(doc) {
    const id = doc._id || String(Date.now() + Math.random());
    if (this.docs.has(id)) {
      const err = new Error(`E11000 duplicate key error collection: ${this.name} index: _id_ dup key: { _id: "${id}" }`);
      err.code = 11000;
      throw err;
    }
    const newDoc = { ...doc, _id: id };
    this.docs.set(id, newDoc);
    return { insertedId: id };
  }

  async countDocuments(filter = {}) {
    let count = 0;
    for (const doc of this.docs.values()) {
      if (this._matches(doc, filter)) count++;
    }
    return count;
  }

  aggregate(pipeline = []) {
    let list = Array.from(this.docs.values());
    for (const stage of pipeline) {
      if (stage.$group) {
        const total = list.reduce((sum, item) => sum + (item.referralCount || 0), 0);
        return {
          toArray: async () => [{ _id: null, total }],
        };
      }
    }
    return {
      toArray: async () => list,
    };
  }
}

const inMemoryDb = {
  _collections: new Map(),
  collection(name) {
    if (!this._collections.has(name)) {
      this._collections.set(name, new InMemoryCollection(name));
    }
    return this._collections.get(name);
  },
  async command(cmd) {
    if (cmd && cmd.dbStats) {
      return { storageSize: 1024 * 1024, dataSize: 512 * 1024 };
    }
    return { ok: 1 };
  },
};

// ─── MongoDB Connection ───────────────────────────────────────────────────────
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();

let client = null;
let db = null;
let dbPromise = null;
let isUsingMockDb = false;

export async function getDb() {
  if (db) return db;
  if (dbPromise) return dbPromise;

  if (!MONGODB_URI) {
    console.warn('[AI Studio] MONGODB_URI not set — using in-memory mock database store (data resets on container restart)');
    db = inMemoryDb;
    isUsingMockDb = true;
    return db;
  }

  dbPromise = (async () => {
    try {
      client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      const database = client.db();

      // Ensure indexes are created asynchronously (fire-and-forget/non-blocking)
      database.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
        .catch(err => console.error('Error creating sessions expiresAt index:', err.message));
      database.collection('users').createIndex({ username: 1 }, { unique: false, sparse: true })
        .catch(err => console.error('Error creating users username index:', err.message));
      database.collection('temp_tokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
        .catch(err => console.error('Error creating temp_tokens expiresAt index:', err.message));
      database.collection('temp_tokens').createIndex({ createdBy: 1 })
        .catch(err => console.error('Error creating temp_tokens createdBy index:', err.message));
      database.collection('activity_logs').createIndex({ timestamp: -1 })
        .catch(err => console.error('Error creating activity_logs timestamp index:', err.message));
      // Auto-purge ephemeral activity logs after 30 days to keep MongoDB Atlas free tier healthy
      database.collection('activity_logs').createIndex({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 3600 })
        .catch(err => console.error('Error creating activity_logs TTL index:', err.message));
      database.collection('activity_logs').createIndex({ eventType: 1, timestamp: -1 })
        .catch(err => console.error('Error creating activity_logs eventType index:', err.message));
      database.collection('activity_logs').createIndex({ userId: 1, timestamp: -1 })
        .catch(err => console.error('Error creating activity_logs userId index:', err.message));
      database.collection('auto_deletes').createIndex({ deleteAt: 1 })
        .catch(err => console.error('Error creating auto_deletes deleteAt index:', err.message));

      db = database;
      return db;
    } catch (err) {
      console.warn('[AI Studio] MongoDB connection failed (' + err.message + ') — falling back to in-memory store');
      db = inMemoryDb;
      isUsingMockDb = true;
      return db;
    }
  })();

  try {
    return await dbPromise;
  } catch (err) {
    dbPromise = null;
    db = inMemoryDb;
    isUsingMockDb = true;
    return db;
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

  // 1. Atomically increment non-expired rate limit document
  const activeResult = await coll.findOneAndUpdate(
    { _id: key, expiresAt: { $gt: now } },
    { $inc: { count: 1 } },
    { returnDocument: 'after' }
  );

  // Support both newer MongoDB driver versions (direct document return) and older versions ({ value })
  const activeDoc = activeResult && (activeResult.value !== undefined ? activeResult.value : activeResult);
  if (activeDoc) {
    return activeDoc.count > limit;
  }

  // 2. If window expired, attempt atomic reset replacing only the expired document
  const expiresAt = new Date(Date.now() + window * 1000);
  const resetResult = await coll.findOneAndUpdate(
    { _id: key, expiresAt: { $lte: now } },
    { $set: { count: 1, expiresAt } },
    { returnDocument: 'after' }
  );

  const resetDoc = resetResult && (resetResult.value !== undefined ? resetResult.value : resetResult);
  if (resetDoc) {
    return resetDoc.count > limit;
  }

  // 3. Document does not exist yet; insert initial window
  try {
    await coll.insertOne({ _id: key, count: 1, expiresAt });
    return false;
  } catch (err) {
    // If a concurrent request inserted or reset in the meantime (E11000 duplicate key),
    // atomically increment the now-active window
    if (err?.code === 11000 || String(err?.message || '').includes('E11000')) {
      const retryResult = await coll.findOneAndUpdate(
        { _id: key, expiresAt: { $gt: now } },
        { $inc: { count: 1 } },
        { returnDocument: 'after' }
      );
      const retryDoc = retryResult && (retryResult.value !== undefined ? retryResult.value : retryResult);
      if (retryDoc) {
        return retryDoc.count > limit;
      }
    }
    return false;
  }
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

// ─── SSRF URL Validator ───────────────────────────────────────────────────────
export function isSafePublicUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return false;
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
      return false;
    }
    if (hostname.startsWith('169.254.')) {
      return false;
    }
    if (
      /^10\.\d+\.\d+\.\d+$/.test(hostname) ||
      /^192\.168\.\d+\.\d+$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(hostname)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
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

  let raw = String(text).trim();

  // Smart symbol translation for standalone emoji buttons before stripping
  const symbolMap = {
    '❌': 'Cancel',
    '✖': 'Cancel',
    '🗑️': 'Delete',
    '🗑': 'Delete',
    '✏️': 'Edit',
    '✏': 'Edit',
    '⚙️': 'Settings',
    '⚙': 'Settings',
    '⬅️': 'Back',
    '⬅': 'Back',
    '◀': 'Back',
    '▶': 'Next',
    '➡️': 'Next',
    '➡': 'Next',
    '➕': 'Add',
    '+': 'Add',
    '🔍': 'Check',
    '🔎': 'Check',
    '📥': 'Bulk Setup',
    '✅': 'Done',
    'ℹ️': 'Info',
    'ℹ': 'Info',
  };

  if (symbolMap[raw]) {
    raw = symbolMap[raw];
  }

  // Strip emojis, Variation Selectors, and common decorative/ASCII symbols (+ < > • |)
  let clean = raw
    .replace(/[\p{Extended_Pictographic}\uFE00-\uFE0F]/gu, '')
    .replace(/[+<>•✖◀▶⬅➡➡️\|]/g, '')
    .trim()
    .replace(/\s+/g, ' ');

  // If the text became empty (fallback), default to 'Select'
  if (!clean) {
    clean = 'Select';
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
export async function sendTelegramMessage(chatId, text, replyMarkup = null, protectContent = false, maxRetries = 2, disableWebPagePreview = true) {
  const token = getToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const styledText = toSmallCapsSafe(text);
    const body = {
      chat_id: chatId, text: styledText, parse_mode: 'HTML',
      disable_web_page_preview: disableWebPagePreview, protect_content: protectContent,
    };
    if (replyMarkup) body.reply_markup = formatReplyMarkup(replyMarkup);
    const res  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.status === 429 && maxRetries > 0) {
      const waitSec = data?.parameters?.retry_after || 1;
      await new Promise(r => setTimeout(r, (waitSec + 0.5) * 1000));
      return sendTelegramMessage(chatId, text, replyMarkup, protectContent, maxRetries - 1, disableWebPagePreview);
    }
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

export async function sendTelegramFileBuffer(chatId, buffer, filename, caption = '', replyMarkup = null, protectContent = false) {
  const token = getToken();
  if (!token) return { ok: false, reason: 'missing_token' };
  try {
    const formData = new FormData();
    formData.append('chat_id', chatId);
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    formData.append('document', blob, filename);
    if (caption) formData.append('caption', toSmallCapsSafe(caption));
    formData.append('parse_mode', 'HTML');
    if (protectContent) formData.append('protect_content', 'true');
    if (replyMarkup) formData.append('reply_markup', JSON.stringify(formatReplyMarkup(replyMarkup)));

    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body: formData,
    });
    return await res.json();
  } catch (err) {
    return { ok: false, reason: err.message };
  }
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

export async function editTelegramCaption(chatId, messageId, caption, replyMarkup = null) {
  const token = getToken();
  if (!token) return { ok: false };
  try {
    const styledCaption = toSmallCapsSafe(caption);
    const body = {
      chat_id: chatId,
      message_id: messageId,
      caption: styledCaption,
      parse_mode: 'HTML',
    };
    if (replyMarkup) body.reply_markup = formatReplyMarkup(replyMarkup);
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageCaption`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { ok: res.ok, messageId: data.result?.message_id, detail: data };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
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
    const data = await res.json();

    if (res.ok) return { ok: true, messageId: data.result?.message_id || messageId };

    const desc = (data.description || '').toLowerCase();

    // Already identical text/markup
    if (desc.includes('message is not modified')) {
      return { ok: true, messageId };
    }

    // Photo / media message: Telegram cannot edit text of a photo message with editMessageText
    if (desc.includes('there is no text in the message to edit')) {
      // 1. If styledText fits in caption (<= 1024 chars), edit the photo caption
      if (styledText.length <= 1024) {
        const captionRes = await editTelegramCaption(chatId, messageId, text, replyMarkup);
        if (captionRes.ok) return { ok: true, messageId };
      }

      // 2. If caption edit fails or text exceeds 1024 chars: delete the photo message and send clean text message
      await deleteTelegramMessage(chatId, messageId).catch(() => {});
      const sendRes = await sendTelegramMessage(chatId, text, replyMarkup, false, 2, disablePreview);
      return { ok: sendRes.ok, messageId: sendRes.messageId };
    }

    // If message cannot be edited or was deleted, fallback to sending a new message
    if (desc.includes('message to edit not found') || desc.includes("message can't be edited")) {
      const sendRes = await sendTelegramMessage(chatId, text, replyMarkup, false, 2, disablePreview);
      return { ok: sendRes.ok, messageId: sendRes.messageId };
    }

    return { ok: false, detail: data };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
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
