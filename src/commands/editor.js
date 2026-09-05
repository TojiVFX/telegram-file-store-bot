import path from 'node:path';
import fs from 'node:fs';
import {
  getCollection, sendTelegramMessage, editTelegramMessage, deleteTelegramMessage, toSmallCaps, esc, log
} from '../bot-common.js';
import { formatBytes, cleanMediaFileName } from '../filestore.js';
import { getEditorCredentials } from '../env-validator.js';
import {
  getTelegramClient, createTempWorkspace, cleanTempWorkspace,
  inspectMediaStreams, remuxMedia, downloadMediaFile, uploadMediaFile
} from '../media-engine.js';

const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Builds the interactive Media Editor control keyboard.
 */
function buildEditorCardKeyboard(session) {
  const cfg = session.config || {};
  const thumbLabel = cfg.thumbnailMode === 'custom'
    ? '🖼️ Thumb: Custom'
    : (cfg.thumbnailMode === 'keep' ? '🔄 Thumb: Keep' : '🗑️ Thumb: Remove');

  return {
    inline_keyboard: [
      [
        { text: toSmallCaps('✏️ Rename File'), callback_data: 'editor:set_filename' },
        { text: toSmallCaps('🏷️ Title Tag'), callback_data: 'editor:set_title' },
      ],
      [
        { text: toSmallCaps(thumbLabel), callback_data: 'editor:cycle_thumb' },
        { text: toSmallCaps('🖼️ Custom Thumb'), callback_data: 'editor:prompt_thumb' },
      ],
      [
        { text: toSmallCaps('🎧 Audio Tracks'), callback_data: 'editor:set_audio' },
        { text: toSmallCaps('💬 Subtitle Tracks'), callback_data: 'editor:set_subs' },
      ],
      [
        { text: toSmallCaps('🧹 1-Tap Auto-Clean'), callback_data: 'editor:auto_clean' },
      ],
      [
        { text: toSmallCaps('⚡ Process & Send File'), callback_data: 'editor:process' },
      ],
      [
        { text: toSmallCaps('❌ Cancel'), callback_data: 'editor:cancel' },
      ],
    ],
  };
}

/**
 * Formats the interactive Media Editor status card.
 */
function buildEditorCardText(session) {
  const file = session.fileInfo || {};
  const cfg = session.config || {};

  const sizeLabel = formatBytes(file.fileSize || 0);
  const thumbStatus = cfg.thumbnailMode === 'custom'
    ? 'Custom Attached'
    : (cfg.thumbnailMode === 'keep' ? 'Preserve Original' : '<b>Strip / Remove Cover Art</b> (No banner)');

  let audioStr = 'Default / Original';
  if (Array.isArray(cfg.audioTracks) && cfg.audioTracks.length > 0) {
    audioStr = cfg.audioTracks.map(t => `${t.title || `Track ${t.audioIndex + 1}`}`).join(', ');
  }

  let subsStr = 'Default / Original';
  if (Array.isArray(cfg.subtitleTracks) && cfg.subtitleTracks.length > 0) {
    subsStr = cfg.subtitleTracks.map(s => `${s.title || `Sub ${s.subIndex + 1}`}`).join(', ');
  }

  return `🎬 <b>Media Editor Studio (Up to 2GB)</b>\n\n` +
    `📁 <b>Original:</b> <code>${esc(file.rawName || 'Unknown')}</code>\n` +
    `💾 <b>Size:</b> <code>${sizeLabel}</code>\n\n` +
    `<b>Configured Settings:</b>\n` +
    `• <b>Output File:</b> <code>${esc(cfg.fileName || file.rawName || 'output.mkv')}</code>\n` +
    `• <b>Player Title:</b> <code>${esc(cfg.title || 'None (Wiped)')}</code>\n` +
    `• <b>Thumbnail:</b> ${thumbStatus}\n` +
    `• <b>Audio Tracks:</b> <code>${esc(audioStr)}</code>\n` +
    `• <b>Subtitles:</b> <code>${esc(subsStr)}</code>\n` +
    `• <b>Tags:</b> Promo links & comment headers will be wiped\n\n` +
    `<i>Tap the buttons below to customize, or tap <b>Process & Send</b> to remux and receive directly in chat:</i>`;
}

/**
 * Starts or prompts the Media Editor session.
 */
export async function startEditorSession(chatId) {
  const creds = getEditorCredentials();
  if (!creds.ok) {
    return sendTelegramMessage(
      chatId,
      `⚠️ <b>Media Editor Studio Setup Required</b>\n\n` +
      `To process large files up to 2GB directly in Telegram, the bot requires your Telegram API credentials:\n\n` +
      `1. Open <a href="https://my.telegram.org">my.telegram.org</a> and log in.\n` +
      `2. Go to <b>API development tools</b>.\n` +
      `3. Copy <b>api_id</b> and <b>api_hash</b>.\n` +
      `4. Add them to your environment variables:\n` +
      `   • <code>TELEGRAM_API_ID</code>\n` +
      `   • <code>TELEGRAM_API_HASH</code>\n\n` +
      `Once set in your hosting environment, run /editor again!`
    );
  }

  const sessions = await getCollection('sessions');
  const key = `editor:session:${chatId}`;
  await sessions.updateOne(
    { _id: key },
    {
      $set: {
        step: 'waiting_file',
        config: {
          thumbnailMode: 'remove', // default is to strip promotional thumbnail
          audioTracks: [],
          subtitleTracks: [],
        },
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      }
    },
    { upsert: true }
  );

  return sendTelegramMessage(
    chatId,
    `🎬 <b>Media Editor Studio</b>\n\n` +
    `Send or forward any video or document file (up to <b>2GB</b>).\n\n` +
    `I will let you customize the filename, player title, audio/subtitle labels, and strip or replace the thumbnail before sending it back cleanly to you.\n\n` +
    `<i>Send /cancel to exit.</i>`
  );
}

/**
 * Handles incoming file forwarded or sent to the editor.
 */
export async function handleEditorIncomingFile(chatId, message) {
  const sessions = await getCollection('sessions');
  const key = `editor:session:${chatId}`;
  const session = await sessions.findOne({ _id: key });
  if (!session || session.expiresAt <= new Date()) return false;

  const doc = message.document;
  const vid = message.video;
  const audio = message.audio;
  const media = doc || vid || audio;

  if (!media) return false;

  const rawName = doc?.file_name || vid?.file_name || audio?.file_name || (vid ? 'video.mp4' : 'file.bin');
  const fileSize = media.file_size || 0;
  const cleanName = cleanMediaFileName(rawName);

  const ext = path.extname(rawName) || (vid ? '.mp4' : '.mkv');
  const defaultCleanFileName = `${cleanName}${ext}`;

  session.fileInfo = {
    messageId: message.message_id,
    rawName,
    fileSize,
    mimeType: media.mime_type,
    duration: vid?.duration || audio?.duration || 0,
  };

  session.config = {
    fileName: defaultCleanFileName,
    title: cleanName,
    thumbnailMode: 'remove', // Default: strip cover art
    customThumbPath: null,
    audioTracks: [],
    subtitleTracks: [],
  };

  session.step = 'configured';

  const cardText = buildEditorCardText(session);
  const cardKb = buildEditorCardKeyboard(session);

  const res = await sendTelegramMessage(chatId, cardText, cardKb);
  if (res?.ok && res?.messageId) {
    session.sessionMsgId = res.messageId;
  }

  session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await sessions.updateOne({ _id: key }, { $set: session }, { upsert: true });
  return true;
}

/**
 * Handles text replies when the editor is waiting for text input (e.g. filename, title, track names).
 */
export async function handleEditorTextReply(chatId, text) {
  const sessions = await getCollection('sessions');
  const key = `editor:session:${chatId}`;
  const session = await sessions.findOne({ _id: key });
  if (!session || session.expiresAt <= new Date()) return false;

  const step = session.step;

  if (step === 'waiting_filename') {
    let clean = text.trim();
    if (!path.extname(clean)) {
      const origExt = path.extname(session.fileInfo?.rawName || '') || '.mkv';
      clean += origExt;
    }
    session.config.fileName = clean;
    session.step = 'configured';
    session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await sessions.updateOne({ _id: key }, { $set: session });

    if (session.sessionMsgId) {
      await editTelegramMessage(chatId, session.sessionMsgId, buildEditorCardText(session), buildEditorCardKeyboard(session)).catch(() => {});
    }
    await sendTelegramMessage(chatId, `✅ Filename set to: <code>${esc(clean)}</code>`);
    return true;
  }

  if (step === 'waiting_title') {
    const cleanTitle = text.trim();
    session.config.title = cleanTitle;
    session.step = 'configured';
    session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await sessions.updateOne({ _id: key }, { $set: session });

    if (session.sessionMsgId) {
      await editTelegramMessage(chatId, session.sessionMsgId, buildEditorCardText(session), buildEditorCardKeyboard(session)).catch(() => {});
    }
    await sendTelegramMessage(chatId, `✅ Media Title set to: <code>${esc(cleanTitle)}</code>`);
    return true;
  }

  if (step === 'waiting_audio') {
    // Format: "1: Hindi | 2: English" or single "Hindi"
    const raw = text.trim();
    const tracks = [];
    if (raw.includes(':') || raw.includes(',')) {
      const parts = raw.split(/[,|\n]+/);
      for (const p of parts) {
        const sub = p.trim().split(':');
        if (sub.length === 2) {
          const idx = parseInt(sub[0], 10) - 1;
          const trackTitle = sub[1].trim();
          if (!isNaN(idx) && idx >= 0) tracks.push({ audioIndex: idx, title: trackTitle });
        }
      }
    } else {
      tracks.push({ audioIndex: 0, title: raw });
    }

    session.config.audioTracks = tracks;
    session.step = 'configured';
    session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await sessions.updateOne({ _id: key }, { $set: session });

    if (session.sessionMsgId) {
      await editTelegramMessage(chatId, session.sessionMsgId, buildEditorCardText(session), buildEditorCardKeyboard(session)).catch(() => {});
    }
    await sendTelegramMessage(chatId, `✅ Audio tracks updated.`);
    return true;
  }

  if (step === 'waiting_subs') {
    // Format: "1: English | 2: Hindi" or single "English"
    const raw = text.trim();
    const subs = [];
    if (raw.includes(':') || raw.includes(',')) {
      const parts = raw.split(/[,|\n]+/);
      for (const p of parts) {
        const sub = p.trim().split(':');
        if (sub.length === 2) {
          const idx = parseInt(sub[0], 10) - 1;
          const subTitle = sub[1].trim();
          if (!isNaN(idx) && idx >= 0) subs.push({ subIndex: idx, title: subTitle });
        }
      }
    } else {
      subs.push({ subIndex: 0, title: raw });
    }

    session.config.subtitleTracks = subs;
    session.step = 'configured';
    session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await sessions.updateOne({ _id: key }, { $set: session });

    if (session.sessionMsgId) {
      await editTelegramMessage(chatId, session.sessionMsgId, buildEditorCardText(session), buildEditorCardKeyboard(session)).catch(() => {});
    }
    await sendTelegramMessage(chatId, `✅ Subtitle tracks updated.`);
    return true;
  }

  return false;
}

/**
 * Handles incoming photo when the editor is waiting for a custom thumbnail.
 */
export async function handleEditorPhotoReply(chatId, message) {
  const sessions = await getCollection('sessions');
  const key = `editor:session:${chatId}`;
  const session = await sessions.findOne({ _id: key });
  if (!session || session.expiresAt <= new Date()) return false;

  if (session.step !== 'waiting_thumb') return false;

  const photo = message.photo?.[message.photo.length - 1];
  if (!photo) return false;

  session.config.thumbnailMode = 'custom';
  session.config.customThumbFileId = photo.file_id;
  session.config.customThumbMsgId = message.message_id;
  session.step = 'configured';

  session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await sessions.updateOne({ _id: key }, { $set: session });

  if (session.sessionMsgId) {
    await editTelegramMessage(chatId, session.sessionMsgId, buildEditorCardText(session), buildEditorCardKeyboard(session)).catch(() => {});
  }
  await sendTelegramMessage(chatId, `✅ Custom cover thumbnail attached!`);
  return true;
}

/**
 * Handles button callbacks from the Media Editor control card.
 */
export async function handleEditorCallback(chatId, messageId, action, cq) {
  const sessions = await getCollection('sessions');
  const key = `editor:session:${chatId}`;
  const session = await sessions.findOne({ _id: key });

  if (!session) {
    return editTelegramMessage(chatId, messageId, `⚠️ Session expired. Please send /editor to start a new session.`);
  }

  session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  if (action === 'cancel') {
    await sessions.deleteOne({ _id: key });
    return editTelegramMessage(chatId, messageId, `❌ <b>Media Editor cancelled.</b>`);
  }

  if (action === 'cycle_thumb') {
    const curr = session.config.thumbnailMode || 'remove';
    const modes = ['remove', 'keep', 'custom'];
    const nextIdx = (modes.indexOf(curr) + 1) % modes.length;
    session.config.thumbnailMode = modes[nextIdx];
    await sessions.updateOne({ _id: key }, { $set: { config: session.config } });
    return editTelegramMessage(chatId, messageId, buildEditorCardText(session), buildEditorCardKeyboard(session));
  }

  if (action === 'prompt_thumb') {
    session.step = 'waiting_thumb';
    await sessions.updateOne({ _id: key }, { $set: { step: 'waiting_thumb' } });
    return sendTelegramMessage(chatId, `🖼️ <b>Send a photo</b> to attach as your custom video thumbnail:`);
  }

  if (action === 'set_filename') {
    session.step = 'waiting_filename';
    await sessions.updateOne({ _id: key }, { $set: { step: 'waiting_filename' } });
    return sendTelegramMessage(chatId, `✏️ Reply with the <b>new filename</b> (e.g. <code>MyMovie (2024).mkv</code>):`);
  }

  if (action === 'set_title') {
    session.step = 'waiting_title';
    await sessions.updateOne({ _id: key }, { $set: { step: 'waiting_title' } });
    return sendTelegramMessage(chatId, `🏷️ Reply with the <b>internal player title</b> (e.g. <code>Inception (2010)</code>):`);
  }

  if (action === 'set_audio') {
    session.step = 'waiting_audio';
    await sessions.updateOne({ _id: key }, { $set: { step: 'waiting_audio' } });
    return sendTelegramMessage(chatId, `🎧 Reply with audio track labels:\n\nExample: <code>1: Hindi | 2: English</code> or <code>Hindi</code>`);
  }

  if (action === 'set_subs') {
    session.step = 'waiting_subs';
    await sessions.updateOne({ _id: key }, { $set: { step: 'waiting_subs' } });
    return sendTelegramMessage(chatId, `💬 Reply with subtitle labels:\n\nExample: <code>1: English | 2: Spanish</code> or <code>English</code>`);
  }

  if (action === 'auto_clean') {
    const raw = session.fileInfo?.rawName || '';
    const clean = cleanMediaFileName(raw);
    const ext = path.extname(raw) || '.mkv';
    session.config.fileName = `${clean}${ext}`;
    session.config.title = clean;
    session.config.thumbnailMode = 'remove';
    await sessions.updateOne({ _id: key }, { $set: { config: session.config } });
    return editTelegramMessage(chatId, messageId, buildEditorCardText(session), buildEditorCardKeyboard(session));
  }

  if (action === 'process') {
    return processAndDeliverMedia(chatId, messageId, session);
  }
}

/**
 * Downloads, remuxes with FFmpeg, and uploads the clean file directly back to the chat.
 */
async function processAndDeliverMedia(chatId, controlMsgId, session) {
  const sessions = await getCollection('sessions');
  const key = `editor:session:${chatId}`;
  const file = session.fileInfo;
  const cfg = session.config;

  let workspacePath = null;

  try {
    // 1. Progress Status Card
    await editTelegramMessage(chatId, controlMsgId, `⏳ <b>Connecting to 2GB MTProto transfer engine...</b>`);

    const client = await getTelegramClient();
    workspacePath = await createTempWorkspace(chatId);

    const ext = path.extname(cfg.fileName || file.rawName || '') || '.mkv';
    const inputPath = path.join(workspacePath, `source_${Date.now()}${ext}`);
    const outputPath = path.join(workspacePath, cfg.fileName || `clean_${Date.now()}${ext}`);

    // 2. Download File
    await editTelegramMessage(chatId, controlMsgId, `⬇️ <b>Downloading media in chunks...</b>\n\n[▒▒▒▒▒▒▒▒▒▒] 0%`);

    let lastDownloadPct = 0;
    const { getMessages } = await import('telegram/client/messages.js');
    const msgList = await client.getMessages(chatId, { ids: file.messageId });
    const targetTgMsg = msgList?.[0];

    if (!targetTgMsg) {
      throw new Error('Could not locate original file message in Telegram chat.');
    }

    await downloadMediaFile(client, targetTgMsg, inputPath, async (downloaded, total, pct) => {
      if (pct >= lastDownloadPct + 20 || pct === 100) {
        lastDownloadPct = pct;
        const filled = Math.round(pct / 10);
        const bar = '█'.repeat(filled) + '▒'.repeat(10 - filled);
        await editTelegramMessage(
          chatId,
          controlMsgId,
          `⬇️ <b>Downloading media...</b>\n\n${bar} ${pct}%\n<code>${formatBytes(downloaded)} / ${formatBytes(total)}</code>`
        ).catch(() => {});
      }
    });

    // 3. Custom Thumbnail download if requested
    let localThumbPath = null;
    if (cfg.thumbnailMode === 'custom' && cfg.customThumbMsgId) {
      const thumbMsgs = await client.getMessages(chatId, { ids: cfg.customThumbMsgId });
      if (thumbMsgs?.[0]) {
        localThumbPath = path.join(workspacePath, 'custom_thumb.jpg');
        await client.downloadMedia(thumbMsgs[0], { outputFile: localThumbPath }).catch(() => {});
      }
    }

    // 4. FFmpeg Remuxing
    await editTelegramMessage(chatId, controlMsgId, `⚙️ <b>Remuxing streams & stripping tags with FFmpeg...</b>\n\n<i>Zero quality loss stream copy in progress...</i>`);

    await remuxMedia({
      inputPath,
      outputPath,
      title: cfg.title,
      audioTracks: cfg.audioTracks,
      subtitleTracks: cfg.subtitleTracks,
      thumbnailMode: cfg.thumbnailMode,
      customThumbPath: localThumbPath,
    });

    // 5. Uploading File
    await editTelegramMessage(chatId, controlMsgId, `⬆️ <b>Uploading processed file to chat...</b>\n\n[▒▒▒▒▒▒▒▒▒▒] 0%`);

    let lastUploadPct = 0;
    await uploadMediaFile(
      client,
      chatId,
      outputPath,
      {
        fileName: cfg.fileName,
        thumbPath: cfg.thumbnailMode === 'custom' ? localThumbPath : undefined,
        forceDocument: ext !== '.mp4',
        caption: `🎬 <b>${esc(cfg.title || cfg.fileName)}</b>\n\n` +
                 `📁 <code>${esc(cfg.fileName)}</code>\n` +
                 `💾 ${formatBytes(fs.statSync(outputPath).size)}\n\n` +
                 `<i>✨ Processed with Media Editor Studio</i>`,
      },
      async (uploaded, total, pct) => {
        if (pct >= lastUploadPct + 20 || pct === 100) {
          lastUploadPct = pct;
          const filled = Math.round(pct / 10);
          const bar = '█'.repeat(filled) + '▒'.repeat(10 - filled);
          await editTelegramMessage(
            chatId,
            controlMsgId,
            `⬆️ <b>Uploading to chat...</b>\n\n${bar} ${pct}%\n<code>${formatBytes(uploaded)} / ${formatBytes(total)}</code>`
          ).catch(() => {});
        }
      }
    );

    // 6. Finish & Cleanup
    await deleteTelegramMessage(chatId, controlMsgId).catch(() => {});
    await sendTelegramMessage(
      chatId,
      `✅ <b>File Delivered Successfully!</b>\n\n` +
      `• File Name: <code>${esc(cfg.fileName)}</code>\n` +
      `• Thumbnail: <b>${cfg.thumbnailMode === 'custom' ? 'Custom Attached' : (cfg.thumbnailMode === 'keep' ? 'Preserved' : 'Stripped / Removed')}</b>\n` +
      `• Database: <i>Not stored (Direct Transfer)</i>\n` +
      `• Server Storage: <i>Temporary files purged</i>`
    );

    await sessions.deleteOne({ _id: key });
  } catch (err) {
    log('error', 'processAndDeliverMedia failed', { errorMessage: err.message, stack: err.stack });
    await editTelegramMessage(
      chatId,
      controlMsgId,
      `❌ <b>Processing Failed</b>\n\nReason: <code>${esc(err.message)}</code>\n\nPlease check your input and try again.`
    );
  } finally {
    if (workspacePath) {
      await cleanTempWorkspace(workspacePath);
    }
  }
}
