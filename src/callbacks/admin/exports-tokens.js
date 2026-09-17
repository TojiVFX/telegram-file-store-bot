import {
  getCollection, toSmallCaps, editTelegramMessage, sendTelegramMessage,
  sendTelegramFileBuffer, esc, formatISTDateTime, getISTDateString
} from '../../bot-common.js';
import {
  getBotUsername, getExportHubKeyboard, getExportTimeKeyboard
} from '../../bot-helpers.js';
import {
  getTopFiles, getDailyFileStats, getTodayFiles, generateLinksExportText,
  generateRawLinksText, getFilesWithinDuration, formatDurationLabel,
  generateTempToken, listActiveTempTokens, formatDuration, revokeTempToken
} from '../../filestore.js';
import { navButtons } from './common.js';

export const exportsTokensActions = {
  backup_db: async ({ chatId, cq, safeAnswer }) => {
    const filesColl = await getCollection('files');
    const allFiles = await filesColl.find({}).toArray();

    const jsonStr = JSON.stringify(allFiles, null, 2);
    const buffer = Buffer.from(jsonStr, 'utf-8');
    const filename = `filestore_backup_${getISTDateString()}.json`;
    const caption = `💾 <b>Database Backup</b>\n\nTotal Stored Records: <b>${allFiles.length}</b>\nSize: <b>${(buffer.length / 1024).toFixed(2)} KB</b>`;

    await sendTelegramFileBuffer(chatId, buffer, filename, caption);
    await safeAnswer(cq.id, 'Database backup sent to chat!');
  },

  top_files: async ({ chatId, messageId }) => {
    const [topList, daily] = await Promise.all([getTopFiles(10), getDailyFileStats()]);
    const botUsername = await getBotUsername();

    let header = `<b>Traffic Dashboard</b>\n\n` +
      `<b>Today</b>\n` +
      `• Links Created: <b>${daily.createdToday}</b>\n` +
      `• Downloads: <b>${daily.downloadsToday}</b>\n\n` +
      `<b>All Time</b>\n` +
      `• Total Links: <b>${daily.totalLinks}</b>\n` +
      `• Total Downloads: <b>${daily.allTimeDownloads}</b>\n`;

    if (!topList.length) {
      await editTelegramMessage(chatId, messageId, header + `\n<i>No downloads recorded yet.</i>`, {
        inline_keyboard: [
          [{ text: toSmallCaps("Today's Links"), callback_data: 'admin:today_links' }],
          ...navButtons('admin:file_mgmt')
        ]
      });
      return;
    }

    let report = header + `\n<b>Top 10 Most Downloaded</b>\n\n`;
    for (let i = 0; i < topList.length; i++) {
      const item = topList[i];
      const link = `https://t.me/${botUsername}?start=${item._id}`;
      report += `<b>${i + 1}.</b> <code>${item._id}</code> (${item.type || 'file'})\n` +
                `   • Downloads: <b>${item.accessCount || 0}</b>\n` +
                `   • Link: ${link}\n\n`;
    }

    await editTelegramMessage(chatId, messageId, report, {
      inline_keyboard: [
        [{ text: toSmallCaps("Today's Links"), callback_data: 'admin:today_links' }],
        ...navButtons('admin:file_mgmt')
      ]
    });
  },

  today_links: async ({ chatId, messageId }) => {
    const todayFiles = await getTodayFiles();
    const botUsername = await getBotUsername();

    if (!todayFiles.length) {
      await editTelegramMessage(chatId, messageId, `<b>Links Created Today</b>\n\n<i>No links have been created today yet.</i>`, {
        inline_keyboard: navButtons('admin:top_files')
      });
      return;
    }

    const displayLimit = 20;
    const slice = todayFiles.slice(0, displayLimit);
    let report = `<b>Links Created Today (${todayFiles.length})</b>\n\n`;
    for (let i = 0; i < slice.length; i++) {
      const item = slice[i];
      const link = `https://t.me/${botUsername}?start=${item._id}`;
      report += `<b>${i + 1}.</b> <code>${item._id}</code> (${item.type || 'file'})\n` +
                `   • Downloads: <b>${item.accessCount || 0}</b>\n` +
                `   • Link: ${link}\n\n`;
    }
    if (todayFiles.length > displayLimit) {
      report += `<i>Showing first ${displayLimit} of ${todayFiles.length} links. Export all as .txt or copy text below:</i>`;
    }

    await editTelegramMessage(chatId, messageId, report, {
      inline_keyboard: [
        [{ text: toSmallCaps('Copy All Links (Text)'), callback_data: 'admin:today_copy_text' }, { text: toSmallCaps('Export Today (.txt)'), callback_data: 'admin:export_today_txt' }],
        ...navButtons('admin:top_files')
      ]
    });
  },

  export_all_txt: async ({ chatId, cq, safeAnswer }) => {
    const filesColl = await getCollection('files');
    const allFiles = await filesColl.find({}).sort({ createdAt: -1 }).toArray();

    if (!allFiles.length) {
      await safeAnswer(cq.id, 'No stored links found in database.', true);
      return;
    }

    const botUsername = await getBotUsername();
    const txtContent = generateLinksExportText(allFiles, botUsername, 'All Stored Links');
    const buffer = Buffer.from(txtContent, 'utf-8');
    const filename = `filestore_all_links_${getISTDateString()}.txt`;
    const caption = `📄 <b>All Stored Links Export</b>\n\nTotal Records: <b>${allFiles.length}</b>\nSize: <b>${(buffer.length / 1024).toFixed(2)} KB</b>`;

    await sendTelegramFileBuffer(chatId, buffer, filename, caption);
    await safeAnswer(cq.id, 'Links exported as .txt file!');
  },

  export_today_txt: async ({ chatId, cq, safeAnswer }) => {
    const todayFiles = await getTodayFiles();

    if (!todayFiles.length) {
      await safeAnswer(cq.id, 'No links created today.', true);
      return;
    }

    const botUsername = await getBotUsername();
    const txtContent = generateLinksExportText(todayFiles, botUsername, "Today's Links");
    const buffer = Buffer.from(txtContent, 'utf-8');
    const filename = `filestore_today_links_${getISTDateString()}.txt`;
    const caption = `📄 <b>Today's Links Export</b>\n\nTotal Links Created Today: <b>${todayFiles.length}</b>\nSize: <b>${(buffer.length / 1024).toFixed(2)} KB</b>`;

    await sendTelegramFileBuffer(chatId, buffer, filename, caption);
    await safeAnswer(cq.id, "Today's links exported as .txt file!");
  },

  today_copy_text: async ({ chatId, cq, safeAnswer }) => {
    const todayFiles = await getTodayFiles();

    if (!todayFiles.length) {
      await safeAnswer(cq.id, 'No links created today.', true);
      return;
    }

    const botUsername = await getBotUsername();
    const rawBlock = generateRawLinksText(todayFiles, botUsername);
    await sendTelegramMessage(chatId, `📋 <b>Today's Links (${todayFiles.length})</b>\n\nTap box to expand and copy all links:\n<blockquote expandable><pre>${rawBlock}</pre></blockquote>`, {
      inline_keyboard: [
        [{ text: toSmallCaps('Export Today (.txt)'), callback_data: 'admin:export_today_txt' }],
        [{ text: toSmallCaps('Back to Traffic Dashboard'), callback_data: 'admin:top_files' }]
      ]
    });
    await safeAnswer(cq.id, 'Copyable list sent below!');
  },

  export_hub: async ({ chatId, messageId }) => {
    const text = `📄 <b>Export Links Hub</b>\n\nSelect what type of links you want to export:\n\n• <b>Single Files:</b> Individual uploaded file & media links\n• <b>Batches:</b> Multi-file collection links\n• <b>All Links:</b> Every file and batch combined`;
    await editTelegramMessage(chatId, messageId, text, getExportHubKeyboard());
  },

  'export_type:': async ({ chatId, messageId, action }) => {
    const type = action.split(':')[1] || 'all';
    const typeTitle = type === 'batch' ? '📦 <b>Export Batch Links</b>' : type === 'media' ? '📁 <b>Export Single Files</b>' : '📄 <b>Export All Links (Combined)</b>';
    const text = `${typeTitle}\n\nSelect a time duration or category to export as a <b>.txt</b> document and get a 1-tap copyable text block:`;
    await editTelegramMessage(chatId, messageId, text, getExportTimeKeyboard(type));
  },

  'exp_time:': async ({ chatId, action, cq, safeAnswer }) => {
    const parts = action.split(':');
    const seconds = parseInt(parts[1], 10) || 1800;
    const filterType = parts[2] || 'all';

    const records = await getFilesWithinDuration(seconds, filterType);
    const durationLabel = formatDurationLabel(seconds);
    const typeLabel = filterType === 'batch' ? 'Batches' : filterType === 'media' ? 'Single Files' : 'Links';

    if (!records.length) {
      await safeAnswer(cq.id, `No ${typeLabel.toLowerCase()} found in the last ${durationLabel}.`, true);
      return;
    }

    const botUsername = await getBotUsername();
    const title = `${typeLabel} in Last ${durationLabel}`;
    const txtContent = generateLinksExportText(records, botUsername, title);
    const buffer = Buffer.from(txtContent, 'utf-8');
    const filename = `filestore_${filterType}_${Math.round(seconds / 60)}m_${getISTDateString()}.txt`;

    if (records.length <= 30) {
      const rawBlock = generateRawLinksText(records, botUsername);
      await sendTelegramMessage(chatId, `📋 <b>${title} (${records.length})</b>\n\nTap box to expand and copy all links:\n<blockquote expandable><pre>${rawBlock}</pre></blockquote>`);
    }

    await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>${title}</b>\n\nTotal Records: <b>${records.length}</b>\nSize: <b>${(buffer.length / 1024).toFixed(2)} KB</b>`);
    await safeAnswer(cq.id, `Exported ${records.length} ${typeLabel.toLowerCase()}!`);
  },

  'exp_today:': async ({ chatId, action, cq, safeAnswer }) => {
    const filterType = action.split(':')[1] || 'all';
    const isBatchOnly = filterType === 'batch';
    const isFileOnly = filterType === 'media';

    const todayFiles = await getTodayFiles();
    const filtered = isBatchOnly ? todayFiles.filter(f => f.type === 'batch') : isFileOnly ? todayFiles.filter(f => f.type !== 'batch') : todayFiles;
    const typeLabel = isBatchOnly ? 'Batches' : isFileOnly ? 'Single Files' : 'Links';

    if (!filtered.length) {
      await safeAnswer(cq.id, `No ${typeLabel.toLowerCase()} created today.`, true);
      return;
    }

    const botUsername = await getBotUsername();
    const title = `Today's ${typeLabel}`;
    const txtContent = generateLinksExportText(filtered, botUsername, title);
    const buffer = Buffer.from(txtContent, 'utf-8');
    const filename = `filestore_today_${filterType}_${getISTDateString()}.txt`;

    if (filtered.length <= 30) {
      const rawBlock = generateRawLinksText(filtered, botUsername);
      await sendTelegramMessage(chatId, `📋 <b>${title} (${filtered.length})</b>\n\nTap box to expand and copy all links:\n<blockquote expandable><pre>${rawBlock}</pre></blockquote>`);
    }

    await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>${title} Export</b> (${filtered.length} records)`);
    await safeAnswer(cq.id, `Exported ${filtered.length} ${typeLabel.toLowerCase()}!`);
  },

  'exp_all:': async ({ chatId, action, cq, safeAnswer }) => {
    const filterType = action.split(':')[1] || 'all';
    const isBatchOnly = filterType === 'batch';
    const isFileOnly = filterType === 'media';

    const filesColl = await getCollection('files');
    const query = {};
    if (filterType !== 'all') query.type = filterType;
    const allFiles = await filesColl.find(query).sort({ createdAt: -1 }).toArray();
    const typeLabel = isBatchOnly ? 'Batches' : isFileOnly ? 'Single Files' : 'Links';

    if (!allFiles.length) {
      await safeAnswer(cq.id, `No ${typeLabel.toLowerCase()} found in database.`, true);
      return;
    }

    const botUsername = await getBotUsername();
    const title = `All Stored ${typeLabel}`;
    const txtContent = generateLinksExportText(allFiles, botUsername, title);
    const buffer = Buffer.from(txtContent, 'utf-8');
    const filename = `filestore_all_${filterType}_${getISTDateString()}.txt`;

    if (allFiles.length <= 30) {
      const rawBlock = generateRawLinksText(allFiles, botUsername);
      await sendTelegramMessage(chatId, `📋 <b>${title} (${allFiles.length})</b>\n\nTap box to expand and copy all links:\n<blockquote expandable><pre>${rawBlock}</pre></blockquote>`);
    }

    await sendTelegramFileBuffer(chatId, buffer, filename, `📄 <b>${title} Export</b> (${allFiles.length} records)`);
    await safeAnswer(cq.id, `Exported ${allFiles.length} ${typeLabel.toLowerCase()}!`);
  },

  'exp_custom_prompt:': async ({ chatId, messageId, action, sessions }) => {
    const filterType = action.split(':')[1] || 'all';
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: `export_custom_duration:${filterType}`, expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    const typeLabel = filterType === 'batch' ? 'Batches' : filterType === 'media' ? 'Single Files' : 'Links';
    const text = `⏱ <b>Export ${typeLabel} by Custom Time</b>\n\nEnter the duration in minutes or hours to export.\n\n` +
      `<b>Format Examples:</b>\n` +
      `• <code>10m</code> or <code>10</code> : last 10 minutes\n` +
      `• <code>45m</code> : last 45 minutes\n` +
      `• <code>2h</code> : last 2 hours\n\n` +
      `Send /cancel to abort.`;

    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [[{ text: toSmallCaps('Cancel'), callback_data: `admin:export_type:${filterType}` }]]
    });
  },

  temp_token_start: async ({ chatId, messageId, sessions }) => {
    await sessions.updateOne(
      { _id: `admin:waiting_action:${chatId}` },
      { $set: { val: 'temp_token_input', expiresAt: new Date(Date.now() + 300 * 1000) } },
      { upsert: true }
    );
    await editTelegramMessage(chatId, messageId, `⏳ <b>Create Temporary Access Token</b>\n\nPlease send the <b>File Code</b> or <b>Batch Code</b> (e.g., <code>file_...</code> or <code>batch_...</code>) you want to generate a time-limited sharing link for.\n\nSend /cancel to abort.`, {
      inline_keyboard: navButtons('admin:file_mgmt')
    });
  },

  'temp_token_for:': async ({ chatId, messageId, action }) => {
    const targetCode = action.split(':')[1];
    const durKb = {
      inline_keyboard: [
        [
          { text: toSmallCaps('15 Mins'), callback_data: `admin:gen_temp:${targetCode}:900` },
          { text: toSmallCaps('1 Hour'), callback_data: `admin:gen_temp:${targetCode}:3600` },
          { text: toSmallCaps('6 Hours'), callback_data: `admin:gen_temp:${targetCode}:21600` }
        ],
        [
          { text: toSmallCaps('12 Hours'), callback_data: `admin:gen_temp:${targetCode}:43200` },
          { text: toSmallCaps('24 Hours'), callback_data: `admin:gen_temp:${targetCode}:86400` },
          { text: toSmallCaps('3 Days'), callback_data: `admin:gen_temp:${targetCode}:259200` }
        ],
        [
          { text: toSmallCaps('7 Days'), callback_data: `admin:gen_temp:${targetCode}:604800` }
        ],
        ...navButtons('admin:file_mgmt')
      ]
    };
    await editTelegramMessage(chatId, messageId, `⏱ <b>Select Expiration Duration</b> for <code>${esc(targetCode)}</code>:`, durKb);
  },

  'gen_temp:': async ({ chatId, messageId, action, from }) => {
    const parts = action.split(':');
    const targetCode = parts[1];
    const durationSec = parseInt(parts[2], 10) || 3600;

    const genRes = await generateTempToken(targetCode, durationSec, {
      createdBy: chatId,
      creatorName: from?.first_name || 'Admin',
    });

    if (!genRes.ok) {
      await editTelegramMessage(chatId, messageId, `❌ <b>Failed to generate temporary link.</b>\n\nTarget code <code>${esc(targetCode)}</code> could not be found in storage.`, {
        inline_keyboard: navButtons('admin:file_mgmt')
      });
      return;
    }

    const botUsername = await getBotUsername();
    const shareLink = `https://t.me/${botUsername}?start=${genRes.token}`;
    const text = `⏳ <b>Temporary Access Token Generated!</b>\n\n` +
      `📁 Target: <code>${esc(genRes.tokenDoc.targetCode)}</code> (${genRes.tokenDoc.targetType})\n` +
      `⏱ Validity: <b>${genRes.durationLabel}</b>\n` +
      `📅 Expires at: <code>${formatISTDateTime(genRes.expiresAt)}</code>\n\n` +
      `🔗 <b>Temporary Share Link:</b>\n<code>${shareLink}</code>\n\n` +
      `<i>Anyone using this link will receive the file(s) before the link expires.</i>`;

    await editTelegramMessage(chatId, messageId, text, {
      inline_keyboard: [
        [{ text: toSmallCaps('Revoke Token'), callback_data: `admin:revoke_temp:${genRes.token}` }],
        [{ text: toSmallCaps('📋 All Active Tokens'), callback_data: 'admin:temp_tokens_list' }],
        ...navButtons('admin:file_mgmt')
      ]
    });
  },

  temp_tokens_list: async ({ chatId, messageId }) => {
    const list = await listActiveTempTokens(null, 20);

    if (!list || list.length === 0) {
      await editTelegramMessage(chatId, messageId, `ℹ️ <b>No active temporary access tokens found.</b>\n\nGenerate temporary tokens from File Management or using <code>/temptoken &lt;code&gt; [duration]</code>.`, {
        inline_keyboard: navButtons('admin:file_mgmt')
      });
      return;
    }

    const botUsername = await getBotUsername();
    let text = `📋 <b>Active Temporary Access Tokens</b> (${list.length})\n\n`;
    const buttons = [];

    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const remainingSec = Math.max(0, Math.round((new Date(t.expiresAt).getTime() - Date.now()) / 1000));
      const remStr = formatDuration(remainingSec);
      const link = `https://t.me/${botUsername}?start=${t._id}`;

      text += `<b>${i + 1}.</b> <code>${t._id}</code> → <code>${t.targetCode}</code>\n` +
              `   ⏱ Left: <b>${remStr}</b> | Uses: <b>${t.useCount || 0}</b>\n` +
              `   🔗 ${link}\n\n`;

      buttons.push([
        { text: toSmallCaps(`Revoke #${i + 1} (${t._id.slice(-6)})`), callback_data: `admin:revoke_temp:${t._id}` }
      ]);
    }

    buttons.push(...navButtons('admin:file_mgmt'));

    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: buttons });
  },

  'revoke_temp:': async ({ chatId, messageId, action }) => {
    const tokenId = action.split(':')[1];
    const revokeRes = await revokeTempToken(tokenId, chatId, true);

    if (!revokeRes.ok) {
      await editTelegramMessage(chatId, messageId, `❌ Failed to revoke token <code>${esc(tokenId)}</code>.`, {
        inline_keyboard: navButtons('admin:file_mgmt')
      });
      return;
    }

    await editTelegramMessage(chatId, messageId, `✅ Temporary token <code>${esc(tokenId)}</code> has been revoked and can no longer be accessed.`, {
      inline_keyboard: [
        [{ text: toSmallCaps('📋 Active Tokens'), callback_data: 'admin:temp_tokens_list' }],
        ...navButtons('admin:file_mgmt')
      ]
    });
  }
};
