import net from 'net';
import type { Page } from 'patchright';

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export async function pageHasSelector(page: Page, selector: string): Promise<boolean> {
  return (await page.locator(selector).count()) > 0;
}

export async function isLoginPage(page: Page): Promise<boolean> {
  // Visibility required — a hidden <input id="...user..."> (ASP.NET hidden
  // fields are everywhere on this site) must not classify a page as 'login'.
  const selectors = [
    '#signInName',
    'input[title*="username" i]',
    'input[placeholder*="username" i]',
    'input[id*="user" i]'
  ];
  for (const selector of selectors) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

export async function waitForPortOpen(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const isOpen = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (isOpen) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

export async function waitForPortClosed(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const isOpen = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (!isOpen) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

/** Current time as "yyyy-mm-dd HH:mm:ss IST" (Asia/Kolkata) — Telegram captions. */
export function istTimestamp(): string {
  return new Date().toLocaleString('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).replace(',', '') + ' IST';
}

/**
 * Parse the consular page's ofcAppointments[].appointmentDateStr
 * ("11/25/2026 10:00:00 AM") into yyyy-mm-dd. Returns null on failure.
 */
export function parseOfcDateStr(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!month || !day || !year) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
