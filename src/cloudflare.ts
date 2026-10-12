import type { Page } from 'patchright';
import { info, warn } from './logger';
import { isLoginPage } from './utils';

// ---------------------------------------------------------------------------
//  Bezier curve human-like mouse movement
// ---------------------------------------------------------------------------

function bezierCurve(
  sx: number, sy: number, ex: number, ey: number, steps: number
) {
  const dist = Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2);
  const curve = Math.min(dist * 0.3, 80);
  const cp1x = sx + (ex - sx) * 0.25 + (Math.random() - 0.5) * curve;
  const cp1y = sy + (ey - sy) * 0.25 + (Math.random() - 0.5) * curve;
  const cp2x = sx + (ex - sx) * 0.75 + (Math.random() - 0.5) * curve;
  const cp2y = sy + (ey - sy) * 0.75 + (Math.random() - 0.5) * curve;

  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    points.push({
      x: u ** 3 * sx + 3 * u ** 2 * t * cp1x + 3 * u * t ** 2 * cp2x + t ** 3 * ex,
      y: u ** 3 * sy + 3 * u ** 2 * t * cp1y + 3 * u * t ** 2 * cp2y + t ** 3 * ey,
    });
  }
  return points;
}

function rnd(min: number, max: number) {
  return min + Math.random() * (max - min);
}

async function humanMove(page: Page, tx: number, ty: number) {
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  const sx = rnd(50, vp.width * 0.5);
  const sy = rnd(50, vp.height * 0.4);
  const steps = 25 + Math.floor(Math.random() * 20);
  const path = bezierCurve(sx, sy, tx, ty, steps);

  for (const p of path) {
    await page.mouse.move(
      Math.max(0, Math.min(p.x, vp.width)),
      Math.max(0, Math.min(p.y, vp.height))
    );
    await page.waitForTimeout(rnd(3, 10));
  }

  await page.waitForTimeout(rnd(100, 250));
  await page.mouse.click(tx, ty);
}

// ---------------------------------------------------------------------------
//  Challenge detection
// ---------------------------------------------------------------------------

const challengeSelectors = [
  'iframe[src*="cloudflare.com"]',
  'iframe[src*="hcaptcha.com"]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="browser-verification"]',
  'label:has-text("Verify you are human")',
  'input[type="checkbox"][aria-label*="verify you are human"]',
  'label:has(input[type="checkbox"])',
  'text=/performing security verification/i',
  'text=/this website uses a security service/i',
  'text=/verify you are human/i',
  'text=/checking your browser/i',
  'text=/attention required/i',
  'text=/captcha/i',
  'text=/waiting room/i'
];

export async function isHumanVerificationPresent(page: Page) {
  const title = await page.title().catch(() => '');
  if (/just a moment|waiting room/i.test(title)) {
    return true;
  }

  for (const selector of challengeSelectors) {
    const locator = page.locator(selector);
    if ((await locator.count()) > 0) {
      return true;
    }
  }

  // Use textContent (via page.evaluate) instead of innerText for reliability.
  // innerText only returns visible text and can return '' on partially-rendered
  // Cloudflare pages, causing detection to fail.
  const body = await page.evaluate(() => document.body?.textContent ?? '').catch(() => '');
  return /verify you are human|performing security verification|checking your browser|attention required|captcha|waiting room/i.test(body);
}

// ---------------------------------------------------------------------------
//  Multi-strategy Turnstile finder + human-like click
// ---------------------------------------------------------------------------

async function findAndClickTurnstile(page: Page): Promise<boolean> {
  // Strategy 1: #cf-turnstile container
  const container = page.locator('#cf-turnstile, .cf-turnstile');
  if (await container.isVisible().catch(() => false)) {
    await container.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const box = await container.boundingBox();
    if (box && box.width > 0 && box.height > 0) {
      info(`Turnstile container found at (${box.x.toFixed(0)},${box.y.toFixed(0)})`);
      await humanMove(page, box.x + 28 + rnd(-2, 2), box.y + box.height / 2 + rnd(-2, 2));
      return true;
    }
  }

  // Strategy 2: Cloudflare challenges iframe checkbox
  const cfFrame = page.frames().find(f => f.url().includes('challenges.cloudflare.com'));
  if (cfFrame) {
    info('Found Cloudflare challenges frame');
    try {
      const cb = cfFrame.locator('input[type="checkbox"]');
      await cb.waitFor({ state: 'visible', timeout: 5000 });
      const cbBox = await cb.boundingBox();
      if (cbBox && cbBox.width > 0) {
        await humanMove(page, cbBox.x + cbBox.width / 2 + rnd(-2, 2), cbBox.y + cbBox.height / 2 + rnd(-2, 2));
        return true;
      }
    } catch {
      info('Checkbox not directly accessible in frame, trying iframe bounding box');
    }
  }

  // Strategy 3: Hidden widget anchor input or iframe element
  const widgetBox = await page.evaluate(() => {
    const input = document.querySelector('input[id^="cf-chl-widget-"]');
    const wrapper = input?.parentElement;
    if (wrapper) {
      const rect = wrapper.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const iframe of iframes) {
      if (iframe.src?.includes('challenges.cloudflare.com')) {
        const rect = iframe.getBoundingClientRect();
        if (rect.width > 0) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    return null;
  });

  if (widgetBox) {
    info(`Turnstile widget found at (${widgetBox.x.toFixed(0)},${widgetBox.y.toFixed(0)})`);
    await humanMove(page, widgetBox.x + 28 + rnd(-2, 2), widgetBox.y + widgetBox.height / 2 + rnd(-2, 2));
    return true;
  }

  // Strategy 4: Fallback label/checkbox selectors
  const fallbackSelectors = [
    'label:has-text("Verify you are human")',
    'input[type="checkbox"][aria-label*="verify you are human"]',
    'label:has(input[type="checkbox"])',
  ];
  for (const sel of fallbackSelectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      const box = await loc.boundingBox();
      if (box && box.width > 0) {
        info(`Fallback element found: ${sel}`);
        await humanMove(page, box.x + box.width / 2 + rnd(-2, 2), box.y + box.height / 2 + rnd(-2, 2));
        return true;
      }
    }
  }

  warn('No Turnstile / verification element found on page');
  return false;
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

export async function clickCloudflareCheckbox(page: Page): Promise<boolean> {
  return findAndClickTurnstile(page);
}

export async function waitForHumanVerificationIfNeeded(page: Page, timeoutMs: number, autoSolve = false, isAborted?: () => boolean) {
  const present = await isHumanVerificationPresent(page);
  if (!present) {
    return false;
  }

  info('Human verification detected.');

  if (autoSolve) {
    // Phase 1: Wait up to 15s for auto-resolve (patchright + real Chrome often passes without a click)
    info('Waiting for challenge to auto-resolve...');
    for (let i = 0; i < 15; i++) {
      if (isAborted && isAborted()) {
        info('Abort signal detected during Cloudflare auto-solve (phase 1).');
        return false;
      }
      await page.waitForTimeout(1000);
      if (!(await isHumanVerificationPresent(page))) {
        info('Challenge auto-resolved.');
        return true;
      }
    }

    // Phase 2: Human-like Bezier click on the Turnstile checkbox
    info('Challenge did not auto-resolve. Attempting human-like click...');
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (isAborted && isAborted()) {
        info('Abort signal detected during Cloudflare auto-solve (phase 2).');
        return false;
      }
      info(`Turnstile click attempt ${attempt}/3`);
      const clicked = await findAndClickTurnstile(page).catch(() => false);
      if (clicked) {
        try {
          await page.waitForFunction(
            () => !document.title.includes('Just a moment'),
            { timeout: 15000 }
          );
          info('Challenge cleared after human-like click.');
          return true;
        } catch {
          info('Challenge did not clear yet, retrying...');
        }
      }
      await page.waitForTimeout(3000);
    }

    info('Auto-solve attempts exhausted. Falling back to manual wait.');
  }

  // Fallback: wait for manual resolution
  warn('Waiting for manual verification in browser window.');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAborted && isAborted()) {
      info('Abort signal detected during manual verification wait.');
      return false;
    }
    await page.waitForTimeout(2000);
    if (!(await isHumanVerificationPresent(page))) {
      info('Human verification completed.');
      return true;
    }
  }

  throw new Error('Human verification did not complete within timeout.');
}

export async function isLoginFailedPage(page: Page) {
  const url = page.url();
  if (/ExternalAuthenticationFailed/i.test(url)) {
    return true;
  }

  const failureLocator = page.locator('.alert.alert-danger, .xrm-editable-html .xrm-attribute-value');
  if ((await failureLocator.count()) > 0) {
    const text = await failureLocator.innerText().catch(() => '');
    if (/sign in failed|login failed|authentication failed/i.test(text)) {
      return true;
    }
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  return /sign in failed|login failed|authentication failed|external authentication failed/i.test(bodyText);
}

// ---------------------------------------------------------------------------
//  Hard block detection — Access limitation & Cloudflare IP block
// ---------------------------------------------------------------------------

/**
 * Detects hard block pages that require IP rotation to recover:
 *
 * 1. "Access limitation" — usvisascheduling.com shows this when access is
 *    rate-limited/restricted. The page text contains "Access limitation".
 *
 * 2. "Sorry, you have been blocked" — Cloudflare IP block page (CF 1020).
 *    Text contains "Sorry, you have been blocked" and/or
 *    "You are unable to access usvisascheduling.com".
 *
 * 3. "Attention Required! | Cloudflare" — Cloudflare browser integrity check
 *    or IP block (CF 1010). Title contains "Attention Required". This is a
 *    hard block, NOT a solvable Turnstile challenge — it requires IP rotation.
 *
 * 4. "Error 1015" — Cloudflare rate-limiting page. Title or body contains
 *    "Error 1015" or "You are being rate limited". Requires IP rotation.
 *
 * All four require rotating the NordVPN IP and refreshing the page to recover.
 * Unlike a Turnstile challenge (which can be auto-solved), these blocks
 * cannot be cleared without a new IP.
 *
 * Detection uses multiple strategies for reliability:
 *   - Cloudflare-specific CSS selectors (#cf-error-details, #cf-wrapper, etc.)
 *   - page.title() (fast)
 *   - document.body.textContent via page.evaluate (more reliable than innerText,
 *     which only returns visible text and can return '' on partially-rendered pages)
 */
export async function isHardBlocked(
  page: Page
): Promise<{ blocked: boolean; reason: 'access_limitation' | 'cloudflare_blocked' | 'rate_limited' | null }> {
  // Strategy 1: Cloudflare-specific selectors (most reliable for CF block pages)
  // The CF block pages have: #cf-error-details, #cf-wrapper, .cf-alert-error,
  // h1[data-translate="block_headline"], .cf-subheadline
  try {
    const cfBlockSelectors = [
      '#cf-error-details',
      '#cf-wrapper',
      'h1[data-translate="block_headline"]',
      '.cf-subheadline:has-text("usvisascheduling.com")',
    ];
    for (const sel of cfBlockSelectors) {
      if ((await page.locator(sel).count()) > 0) {
        return { blocked: true, reason: 'cloudflare_blocked' };
      }
    }
  } catch { /* ignore selector errors */ }

  // Strategy 2: page title (fast)
  const title = await page.title().catch(() => '');
  if (/sorry, you have been blocked/i.test(title)) {
    return { blocked: true, reason: 'cloudflare_blocked' };
  }
  if (/attention required/i.test(title)) {
    return { blocked: true, reason: 'cloudflare_blocked' };
  }
  if (/access limitation/i.test(title)) {
    return { blocked: true, reason: 'access_limitation' };
  }
  // Error 1015 / "rate limited" is a TRANSIENT edge throttle — it decays with
  // backoff and does not warrant an IP rotation like a real block does.
  if (/error 1015|rate limited/i.test(title)) {
    return { blocked: true, reason: 'rate_limited' };
  }

  // Strategy 3: body.textContent via page.evaluate
  // textContent returns ALL text regardless of CSS visibility (unlike innerText),
  // so it works even on partially-rendered or CSS-hidden block pages.
  const bodyText = await page.evaluate(() => document.body?.textContent ?? '').catch(() => '');
  if (bodyText) {
    if (/access limitation/i.test(bodyText)) {
      return { blocked: true, reason: 'access_limitation' };
    }
    if (/error 1015|you are being rate limited/i.test(bodyText)) {
      return { blocked: true, reason: 'rate_limited' };
    }
    if (/sorry, you have been blocked|you are unable to access usvisascheduling\.com|attention required/i.test(bodyText)) {
      return { blocked: true, reason: 'cloudflare_blocked' };
    }
  }

  return { blocked: false, reason: null };
}

export async function waitForLoginOrVerification(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isLoginPage(page)) {
      return 'login';
    }
    if (await isHumanVerificationPresent(page)) {
      return 'verification';
    }
    await page.waitForTimeout(1000);
  }
  return null;
}
