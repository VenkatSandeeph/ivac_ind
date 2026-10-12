import fs from 'fs';
import path from 'path';
import type { Page } from 'patchright';
import { info, warn } from './logger';
import type { AutomationConfig } from './config';
import { sendTelegramDocument, sendTelegramMessage } from './telegram';

// After a successful consular submit the site navigates here:
// https://www.usvisascheduling.com/en-US/appointment-confirmation/
export const CONFIRMATION_URL_FRAGMENT = '/en-US/appointment-confirmation';

export function isOnConfirmationPage(page: Page): boolean {
  return page.url().includes(CONFIRMATION_URL_FRAGMENT);
}

/**
 * Poll until the page lands on the appointment-confirmation URL.
 * The post-submit redirect can be a client-side location change that happens
 * after domcontentloaded, so a plain navigation wait can miss it.
 */
export async function waitForConfirmationPage(page: Page, timeoutMs = 45000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isOnConfirmationPage(page)) return true;
    await page.waitForTimeout(500).catch(() => null);
  }
  return isOnConfirmationPage(page);
}

type ConfirmationDetails = {
  applicantName: string | null;
  ofcLocation: string | null;
  ofcDate: string | null;
  consularLocation: string | null;
  consularDate: string | null;
};

/**
 * Best-effort scrape of the confirmation page body text for the Telegram
 * caption. All fields are optional — missing values are simply omitted.
 */
async function extractConfirmationDetails(page: Page): Promise<ConfirmationDetails> {
  const empty: ConfirmationDetails = {
    applicantName: null,
    ofcLocation: null,
    ofcDate: null,
    consularLocation: null,
    consularDate: null
  };
  try {
    const body = await page.locator('body').innerText().catch(() => '');
    if (!body) return empty;

    const nameMatch = body.match(/Applicant Name:\s*\t?\s*(.+)/);
    const section = (start: string, end: string) => {
      const si = body.indexOf(start);
      const ei = body.indexOf(end);
      return si >= 0 ? body.substring(si, ei > si ? ei : undefined) : '';
    };
    const field = (text: string, label: string) => {
      const m = text.match(new RegExp(`${label}\\s*\\t?\\s*(.+)`));
      return m ? m[1].trim() : null;
    };

    const ofcSection = section('OFC APPOINTMENT DETAILS', 'CONSULAR APPOINTMENT DETAILS');
    const consularSection = section('CONSULAR APPOINTMENT DETAILS', 'DOCUMENT DELIVERY');

    return {
      applicantName: nameMatch ? nameMatch[1].trim() : null,
      ofcLocation: field(ofcSection, 'Embassy/Consulate/OFC:'),
      ofcDate: field(ofcSection, 'OFC Appointment Date: \\(DD-MON-YYYY\\)'),
      consularLocation: field(consularSection, 'Embassy/Consulate/OFC:'),
      consularDate: field(consularSection, 'Consular Appointment Date: \\(DD-MON-YYYY\\)')
    };
  } catch {
    return empty;
  }
}

/**
 * Render the confirmation page to PDF via CDP Page.printToPDF — the same
 * output the page's own Print button produces (it calls window.print()).
 * Returns null on any failure.
 */
async function captureConfirmationPdf(page: Page): Promise<Buffer | null> {
  try {
    const session = await page.context().newCDPSession(page);
    const result = await session.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true
    }) as { data?: string };
    if (!result?.data) return null;
    return Buffer.from(result.data, 'base64');
  } catch (err) {
    warn('Confirmation: Page.printToPDF failed:', err);
    return null;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>');
}

/**
 * After consular submit succeeds the site lands on appointment-confirmation.
 * Wait for it, render it to PDF (the page's Print button is window.print() —
 * CDP printToPDF produces the same output), keep a local copy under
 * artifacts/confirmations/, and send the PDF to the Telegram channel.
 *
 * Bounded (~75s worst case) and NEVER throws — a failure here must not
 * affect the booking outcome, which is already recorded.
 */
export async function sendConfirmationPdfToTelegram(page: Page, config: AutomationConfig): Promise<void> {
  try {
    const landed = await waitForConfirmationPage(page, 45000);
    if (!landed) {
      warn(`Confirmation: page did not reach ${CONFIRMATION_URL_FRAGMENT} (url=${page.url()}); skipping PDF capture.`);
      return;
    }
    info(`Confirmation: on appointment-confirmation page (${page.url()}); capturing PDF...`);

    // Wait for the confirmation details to render, then a short settle for the
    // client-side barcode images (blob: URLs drawn by page JS).
    await page.waitForFunction(
      () => document.body && document.body.innerText.includes('PRIMARY APPLICANT DETAILS'),
      { timeout: 15000 }
    ).catch(() => null);
    await page.waitForTimeout(1500).catch(() => null);

    const details = await extractConfirmationDetails(page);
    const pdf = await captureConfirmationPdf(page);
    if (!pdf || pdf.length === 0) {
      warn('Confirmation: PDF capture produced no data.');
    }

    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    const captionLines = [
      '<b>✅ Consular Appointment Booked — Confirmation</b>',
      '',
      `<b>👤 User:</b> ${escapeHtml(config.username)}`
    ];
    if (details.applicantName) captionLines.push(`<b>🪪 Applicant:</b> ${escapeHtml(details.applicantName)}`);
    if (details.consularLocation || details.consularDate) {
      captionLines.push(`<b>🏛 Consular:</b> ${escapeHtml([details.consularLocation, details.consularDate].filter(Boolean).join(' — '))}`);
    }
    if (details.ofcLocation || details.ofcDate) {
      captionLines.push(`<b>🏙 OFC:</b> ${escapeHtml([details.ofcLocation, details.ofcDate].filter(Boolean).join(' — '))}`);
    }
    captionLines.push(`<b>🕐 Booked At:</b> ${timestamp}`);
    const caption = captionLines.join('\n');

    if (pdf) {
      const safeUser = config.username.replace(/[^a-z0-9_-]/gi, '_');
      const filename = `confirmation-${safeUser}-${Date.now()}.pdf`;

      // Local copy under artifacts/confirmations/ (same base as screenshots).
      try {
        const dir = path.resolve(process.cwd(), 'artifacts', 'confirmations');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, filename), pdf);
        info(`Confirmation: PDF saved locally (${pdf.length} bytes): ${path.join('artifacts', 'confirmations', filename)}`);
      } catch (err) {
        warn('Confirmation: failed to save local PDF copy:', err);
      }

      const sent = await sendTelegramDocument(pdf, filename, caption);
      if (sent) {
        info('Confirmation: PDF sent to Telegram.');
        return;
      }
      warn('Confirmation: Telegram document send failed; sending text-only fallback.');
      await sendTelegramMessage(caption + '\n\n(PDF capture succeeded but upload failed — see artifacts/confirmations/)');
      return;
    }

    await sendTelegramMessage(caption + '\n\n(PDF capture failed — check the confirmation page manually)');
  } catch (err) {
    warn('Confirmation: PDF/Telegram step failed:', err);
  }
}
