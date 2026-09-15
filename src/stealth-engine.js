import crypto from 'crypto';
import { getSettings, getWebhookSecret } from './bot-common.js';

// Common release groups and encoder tags to cleanse
const RELEASE_GROUP_REGEX = /\b(rarbg|yts|yify|galaxyrg|flux|psa|pahe|ettv|sparks|dimension|d3g|teth|strife|ntb|as88|cmrg|evo|fgt|nogrp|shitbox|tgx)\b/gi;
const NOISE_TAGS_REGEX = /\b(1080p|720p|480p|2160p|4k|uhd|web-dl|webrip|bluray|brrip|hdtv|hdrip|x264|x265|hevc|aac|ac3|dts|ddp5\.1|atmos|10bit|remux)\b/gi;
const BRACKETED_NOISE_REGEX = /\[[^\]]*\]|\([^\)]*(?:1080|720|480|4k|hevc|x264|x265)[^\)]*\)/gi;

/**
 * Checks whether Stealth Storage Mode is enabled in settings.
 */
export async function isStealthStorageEnabled() {
  const s = await getSettings();
  return s?.stealthStorage === '1';
}

/**
 * Sanitizes a raw filename or title by stripping release groups, tracker tags, and encoder noise.
 */
export function sanitizeMediaTitle(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') return 'Media File';

  let cleaned = rawTitle
    .replace(BRACKETED_NOISE_REGEX, ' ')
    .replace(RELEASE_GROUP_REGEX, ' ')
    .replace(NOISE_TAGS_REGEX, ' ')
    .replace(/[._]/g, ' ')
    .replace(/[-+]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return cleaned || rawTitle.trim();
}

/**
 * Generates an opaque, cloaked reference tag for DB storage channel posts.
 * When Stealth Mode is enabled, the DB channel post contains only this tag,
 * preventing Telegram search indexing or automated DMCA keyword scanners from flagging the channel.
 */
export function generateCloakedCaption(targetCode) {
  const secret = getWebhookSecret() || 'default_stealth_secret';
  const shortHash = crypto.createHmac('sha256', secret).update(String(targetCode)).digest('hex').slice(0, 12);
  return `📦 <code>#REF_${shortHash.toUpperCase()}</code>\n<i>Cloud Storage Object</i>`;
}

/**
 * Generates a cryptographically salted HMAC fingerprint of a Telegram file_unique_id.
 * This prevents cross-referencing internal files with external Telegram databases.
 */
export function generateSaltedFileFingerprint(fileUniqueId) {
  if (!fileUniqueId) return null;
  const secret = getWebhookSecret() || 'default_fingerprint_salt';
  return crypto.createHmac('sha256', secret).update(String(fileUniqueId)).digest('hex');
}

/**
 * Injects an invisible 32-byte cryptographic noise trailer into a binary buffer.
 * Alters the file's SHA-256 and MD5 cryptographic hashes without corrupting video/audio playback.
 */
export function injectBinaryNoise(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return buffer;
  const noiseBytes = crypto.randomBytes(32);
  return Buffer.concat([buffer, noiseBytes]);
}
