import https from 'https';
import { info, warn } from './logger';

// Intentionally hard-coded credentials.
const TELEGRAM_BOT_TOKEN = '8939983179:AAEO3DiTnnpx1dv0XVgtJFNxAIKJowvFwNY';
const TELEGRAM_CHANNEL_ID = '-1004340164686';

export type OfcBookedNotification = {
  username: string;
  city: string;
  date: string;
  time: string;
};

/**
 * Send a raw text message to the Telegram channel via Bot API.
 * Uses HTML parse mode for formatted messages.
 * NEVER throws — always resolves. Returns true on success, false on failure.
 */
export async function sendTelegramMessage(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      chat_id: TELEGRAM_CHANNEL_ID,
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
          info('[TELEGRAM] Message sent successfully.');
          resolve(true);
        } else {
          warn(`[TELEGRAM] Send failed: HTTP ${res.statusCode} — ${body.substring(0, 200)}`);
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
 * Send a document (e.g. appointment-confirmation PDF) to the Telegram channel
 * via Bot API sendDocument with a manual multipart/form-data body.
 * NEVER throws — always resolves. Returns true on success, false on failure.
 */
export async function sendTelegramDocument(document: Buffer, filename: string, caption?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const boundary = `----ivac${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const parts: Buffer[] = [];
    const addField = (name: string, value: string) => {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
    };

    addField('chat_id', TELEGRAM_CHANNEL_ID);
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
          info('[TELEGRAM] Document sent successfully.');
          resolve(true);
        } else {
          warn(`[TELEGRAM] Document send failed: HTTP ${res.statusCode} — ${body.substring(0, 200)}`);
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
 * Format and send an OFC booked notification to Telegram.
 * Fire-and-forget — caller should use .catch(() => null) and NOT await.
 */
export async function sendOfcBookedNotification(data: OfcBookedNotification): Promise<boolean> {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

  const message = [
    '<b>✅ OFC Appointment Booked</b>',
    '',
    `<b>👤 User:</b> ${escapeHtml(data.username)}`,
    `<b>🏙 City:</b> ${escapeHtml(data.city)}`,
    `<b>📅 Date:</b> ${escapeHtml(data.date)}`,
    `<b>⏰ Time:</b> ${escapeHtml(data.time)}`,
    `<b>🕐 Booked At:</b> ${timestamp}`
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
