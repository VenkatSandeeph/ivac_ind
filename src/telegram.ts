import https from 'https';
import { info, warn } from './logger';
import { istTimestamp } from './utils';

// Intentionally hard-coded credentials.
const TELEGRAM_BOT_TOKEN = '8939983179:AAEO3DiTnnpx1dv0XVgtJFNxAIKJowvFwNY';
const TELEGRAM_CHANNEL_ID = '-1004340164686';

// Per-license client destination (DM chat_id or group id) — set once after
// license validation from Licenses.tg_chat_id. When null every send is the
// original single-channel path; when set, each message fans out to BOTH the
// operator channel and the client chat (independent sends — a client-side
// failure can never eat the operator copy).
let clientChatId: string | null = null;
export function setTelegramClientChat(id: string | null | undefined): void {
  clientChatId = (id || '').trim() || null;
}

/** Destination list: operator channel first, client chat second, deduped. */
function telegramDestinations(): string[] {
  const dests = [TELEGRAM_CHANNEL_ID];
  if (clientChatId && clientChatId !== TELEGRAM_CHANNEL_ID) dests.push(clientChatId);
  return dests;
}

export type OfcBookedNotification = {
  username: string;
  city: string;
  date: string;
  time: string;
  poc?: string;
  familyMembers?: string[];
};

/**
 * Post a text message to ONE chat via Bot API (HTML parse mode).
 * NEVER throws — always resolves. Returns true on success, false on failure.
 */
function postTelegramMessage(chatId: string, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          info(`[TELEGRAM] Message sent successfully (chat ${chatId}).`);
          resolve(true);
        } else {
          warn(`[TELEGRAM] Send failed (chat ${chatId}): HTTP ${res.statusCode} — ${body.substring(0, 200)}`);
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      warn('[TELEGRAM] Request error:', err.message);
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      warn('[TELEGRAM] Request timed out.');
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Send a raw text message to the operator channel AND (when set) the
 * license's client chat. Sends run in parallel and independently; the return
 * value is the operator channel's result so client-side failures (e.g. the
 * client never /start'ed the bot → 403) can never mask a successful send.
 * NEVER throws — always resolves.
 */
export async function sendTelegramMessage(text: string): Promise<boolean> {
  const results = await Promise.all(telegramDestinations().map((d) => postTelegramMessage(d, text)));
  return results[0];
}

/**
 * Post a document (e.g. appointment-confirmation PDF) to ONE chat via Bot API
 * sendDocument with a manual multipart/form-data body.
 * NEVER throws — always resolves. Returns true on success, false on failure.
 */
function postTelegramDocument(chatId: string, document: Buffer, filename: string, caption?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const boundary = `----ivac${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const parts: Buffer[] = [];
    const addField = (name: string, value: string) => {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
    };

    addField('chat_id', chatId);
    if (caption) {
      addField('caption', caption);
      addField('parse_mode', 'HTML');
    }
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
      'utf8'
    ));
    parts.push(document);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
    const payload = Buffer.concat(parts);

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length
      },
      timeout: 30000
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          info(`[TELEGRAM] Document sent successfully (chat ${chatId}).`);
          resolve(true);
        } else {
          warn(`[TELEGRAM] Document send failed (chat ${chatId}): HTTP ${res.statusCode} — ${body.substring(0, 200)}`);
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      warn('[TELEGRAM] Document request error:', err.message);
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      warn('[TELEGRAM] Document request timed out.');
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Send a document to the operator channel AND (when set) the license's client
 * chat — same fan-out semantics as sendTelegramMessage. NEVER throws.
 */
export async function sendTelegramDocument(document: Buffer, filename: string, caption?: string): Promise<boolean> {
  const results = await Promise.all(telegramDestinations().map((d) => postTelegramDocument(d, document, filename, caption)));
  return results[0];
}

/**
 * Format and send an OFC booked notification to Telegram.
 * Fire-and-forget — caller should use .catch(() => null) and NOT await.
 */
export async function sendOfcBookedNotification(data: OfcBookedNotification): Promise<boolean> {
  const timestamp = istTimestamp();

  const members = (data.familyMembers || []).filter((n) => n && n.trim().length > 0);
  const memberLines = members.length > 0
    ? ['<b>👥 Family Members:</b>', ...members.map((n, i) => `${i + 1}. ${escapeHtml(n)}`)]
    : [];

  const message = [
    '<b>✅ OFC Appointment Booked</b>',
    '',
    `<b>👤 Client User:</b> ${escapeHtml(data.username)}`,
    ...memberLines,
    `<b>🏙 City:</b> ${escapeHtml(data.city)}`,
    `<b>📅 Date:</b> ${escapeHtml(data.date)}`,
    `<b>⏰ Time:</b> ${escapeHtml(data.time)}`,
    `<b>🕐 Booked At:</b> ${timestamp}`,
    '',
    `<b>SPOC:</b> ${escapeHtml(data.poc || 'unknown')}`
  ].join('\n');

  return sendTelegramMessage(message);
}

/** Escape HTML special characters for Telegram HTML parse mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>');
}
