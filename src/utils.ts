import net from 'net';
import type { Page } from 'patchright';

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export async function pageHasSelector(page: Page, selector: string): Promise<boolean> {
  return (await page.locator(selector).count()) > 0;
}

export async function isLoginPage(page: Page): Promise<boolean> {
  return (
    (await pageHasSelector(page, '#signInName')) ||
    (await pageHasSelector(page, 'input[title*="username" i]')) ||
    (await pageHasSelector(page, 'input[placeholder*="username" i]')) ||
    (await pageHasSelector(page, 'input[id*="user" i]'))
  );
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

/** Format a Date as yyyy-mm-dd (local calendar date, not UTC-shifted). */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Add `n` Mon–Fri business days to a yyyy-mm-dd date. Returns yyyy-mm-dd. */
export function addBusinessDays(isoDate: string, n: number): string {
  const d = new Date(isoDate + 'T00:00:00');
  if (isNaN(d.getTime())) return isoDate;
  let remaining = n;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow >= 1 && dow <= 5) remaining--;
  }
  return toISODate(d);
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
