import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { getMainToken, log } from './bot-common.js';
import { getEditorCredentials } from './env-validator.js';

let tgClientInstance = null;
let tgClientPromise = null;

/**
 * Initializes or returns the shared MTProto GramJS client authenticated with the bot token.
 */
export async function getTelegramClient() {
  if (tgClientInstance && tgClientInstance.connected) {
    return tgClientInstance;
  }
  if (tgClientPromise) {
    return tgClientPromise;
  }

  const creds = getEditorCredentials();
  if (!creds.ok) {
    throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH are not configured in environment.');
  }

  const token = getMainToken();
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured in environment.');
  }

  tgClientPromise = (async () => {
    try {
      const client = new TelegramClient(
        new StringSession(''),
        creds.apiId,
        creds.apiHash,
        {
          connectionRetries: 5,
          useWSS: false,
        }
      );

      await client.start({ botAuthToken: token });
      tgClientInstance = client;
      log('info', 'MTProto GramJS client successfully connected for large file transfers.');
      return tgClientInstance;
    } catch (err) {
      tgClientPromise = null;
      tgClientInstance = null;
      log('error', 'Failed to connect MTProto GramJS client', { errorMessage: err.message });
      throw err;
    }
  })();

  return await tgClientPromise;
}

/**
 * Creates a unique scratch directory inside ./temp for safe processing.
 */
export async function createTempWorkspace(sessionKey) {
  const baseDir = path.resolve(process.cwd(), 'temp');
  await fs.promises.mkdir(baseDir, { recursive: true });
  const workspacePath = path.join(baseDir, `editor_${sessionKey}_${Date.now()}`);
  await fs.promises.mkdir(workspacePath, { recursive: true });
  return workspacePath;
}

/**
 * Removes a temporary workspace safely.
 */
export async function cleanTempWorkspace(workspacePath) {
  if (!workspacePath) return;
  try {
    await fs.promises.rm(workspacePath, { recursive: true, force: true });
  } catch (err) {
    log('warn', 'Failed to clean temp workspace', { workspacePath, errorMessage: err.message });
  }
}

/**
 * Inspects streams (audio, subtitles) of a media file via FFmpeg.
 */
export async function inspectMediaStreams(inputPath) {
  return new Promise((resolve) => {
    const ff = spawn(ffmpegPath, ['-hide_banner', '-i', inputPath]);
    let stderrData = '';

    ff.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    ff.on('close', () => {
      const audioStreams = [];
      const subtitleStreams = [];

      // Parse streams from FFmpeg stderr output
      // Example: Stream #0:1(hin): Audio: aac (LC), 48000 Hz, stereo, fltp (default)
      // Example: Stream #0:3(eng): Subtitle: subrip (default)
      const streamRegex = /Stream #0:(\d+)(?:\(([a-zA-Z0-9_-]+)\))?:\s*(Audio|Subtitle):/gi;
      let match;
      let aIdx = 0;
      let sIdx = 0;

      while ((match = streamRegex.exec(stderrData)) !== null) {
        const streamGlobalIdx = parseInt(match[1], 10);
        const lang = match[2] || 'und';
        const type = match[3].toLowerCase();

        // Look ahead in the nearby snippet for any Title metadata
        const snippet = stderrData.slice(match.index, match.index + 250);
        const titleMatch = snippet.match(/title\s*:\s*([^\r\n]+)/i);
        const title = titleMatch ? titleMatch[1].trim() : '';

        if (type === 'audio') {
          audioStreams.push({
            audioIndex: aIdx++,
            globalIndex: streamGlobalIdx,
            language: lang,
            title: title || `Track ${aIdx}`,
          });
        } else if (type === 'subtitle') {
          subtitleStreams.push({
            subIndex: sIdx++,
            globalIndex: streamGlobalIdx,
            language: lang,
            title: title || `Subtitle ${sIdx}`,
          });
        }
      }

      resolve({
        audio: audioStreams,
        subtitles: subtitleStreams,
      });
    });

    ff.on('error', (err) => {
      log('warn', 'inspectMediaStreams execution error', { errorMessage: err.message });
      resolve({ audio: [], subtitles: [] });
    });
  });
}

/**
 * Remuxes media fast with FFmpeg without re-encoding (-c copy).
 * Handles thumbnail removal, custom thumbnail attachment, promo tag stripping, and track relabeling.
 */
export async function remuxMedia({
  inputPath,
  outputPath,
  title = null,
  audioTracks = [],
  subtitleTracks = [],
  thumbnailMode = 'remove', // 'remove' | 'custom' | 'keep'
  customThumbPath = null,
}) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', inputPath];

    if (thumbnailMode === 'custom' && customThumbPath && fs.existsSync(customThumbPath)) {
      args.push('-i', customThumbPath);
      args.push('-map', '0', '-map', '1', '-c', 'copy', '-disposition:v:1', 'attached_pic');
    } else if (thumbnailMode === 'remove') {
      // Strip any attached picture / embedded thumbnail stream
      args.push('-map', '0', '-map', '-0:v:m:attached_pic', '-c', 'copy');
    } else {
      args.push('-map', '0', '-c', 'copy');
    }

    // Wipe global and stream promo metadata
    args.push('-map_metadata', '-1');

    // Apply custom Title metadata if provided
    if (title) {
      args.push('-metadata', `title=${title}`);
    }

    // Apply Audio track names / language metadata
    if (Array.isArray(audioTracks)) {
      for (const t of audioTracks) {
        if (t.audioIndex !== undefined) {
          if (t.title) args.push(`-metadata:s:a:${t.audioIndex}`, `title=${t.title}`);
          if (t.language) args.push(`-metadata:s:a:${t.audioIndex}`, `language=${t.language}`);
        }
      }
    }

    // Apply Subtitle track names / language metadata
    if (Array.isArray(subtitleTracks)) {
      for (const s of subtitleTracks) {
        if (s.subIndex !== undefined) {
          if (s.title) args.push(`-metadata:s:s:${s.subIndex}`, `title=${s.title}`);
          if (s.language) args.push(`-metadata:s:s:${s.subIndex}`, `language=${s.language}`);
        }
      }
    }

    args.push(outputPath);

    log('info', 'Running FFmpeg remuxer', { thumbnailMode, title, audioCount: audioTracks.length, subCount: subtitleTracks.length });
    const ff = spawn(ffmpegPath, args);

    let stderr = '';
    ff.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ff.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        log('error', 'FFmpeg remuxer failed', { code, stderrTail: stderr.slice(-400) });
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-200)}`));
      }
    });

    ff.on('error', (err) => {
      log('error', 'FFmpeg process failed to spawn', { errorMessage: err.message });
      reject(err);
    });
  });
}

/**
 * Downloads a Telegram message media file using GramJS chunked stream.
 */
export async function downloadMediaFile(client, message, destPath, onProgress = null) {
  let lastPct = -1;
  await client.downloadMedia(message, {
    outputFile: destPath,
    progressCallback: (downloaded, total) => {
      if (total && typeof onProgress === 'function') {
        const pct = Math.min(100, Math.round((Number(downloaded) / Number(total)) * 100));
        if (pct !== lastPct && pct % 10 === 0) {
          lastPct = pct;
          onProgress(downloaded, total, pct).catch?.(() => {});
        }
      }
    },
  });
  return destPath;
}

/**
 * Uploads a large file up to 2GB back to Telegram using GramJS chunked stream.
 */
export async function uploadMediaFile(client, targetChatId, filePath, options = {}, onProgress = null) {
  let lastPct = -1;
  const fileName = options.fileName || path.basename(filePath);

  const res = await client.sendFile(targetChatId, {
    file: filePath,
    caption: options.caption || '',
    forceDocument: Boolean(options.forceDocument),
    thumb: options.thumbPath || undefined,
    attributes: [
      // Preserve original file name in attributes
      ...(options.attributes || []),
    ],
    progressCallback: (uploaded, total) => {
      if (total && typeof onProgress === 'function') {
        const pct = Math.min(100, Math.round((Number(uploaded) / Number(total)) * 100));
        if (pct !== lastPct && pct % 10 === 0) {
          lastPct = pct;
          onProgress(uploaded, total, pct).catch?.(() => {});
        }
      }
    },
  });

  return res;
}
