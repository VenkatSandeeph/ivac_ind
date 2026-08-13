import { Page } from 'playwright';
import { info, warn } from './logger';
import { isLoginPage } from './utils';

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
  for (const selector of challengeSelectors) {
    const locator = page.locator(selector);
    if ((await locator.count()) > 0) {
      return true;
    }
  }

  const title = await page.title().catch(() => '');
  if (/waiting room/i.test(title)) {
    return true;
  }

  const body = await page.locator('body').innerText().catch(() => '');
  return /verify you are human|performing security verification|checking your browser|attention required|captcha|waiting room/i.test(body);
}

async function clickElement(page: Page, locator: any): Promise<boolean> {
  try {
    const { createCursor } = await import('ghost-cursor');
    const cursor = createCursor(page);
    await cursor.click(locator as any);
    return true;
  } catch (err) {
    warn('ghost-cursor synth click failed, falling back to direct click:', err);
  }

  try {
    await locator.click({ force: true });
    return true;
  } catch (err) {
    warn('Direct click on locator failed:', err);
    return false;
  }
}

export async function clickCloudflareCheckbox(page: Page): Promise<boolean> {
  const selectors = [
    'label:has-text("Verify you are human")',
    'input[type="checkbox"][aria-label*="verify you are human"]',
    'label:has(input[type="checkbox"])',
    'iframe[src*="cloudflare.com"]',
    'iframe[src*="turnstile"]',
    'iframe[src*="recaptcha"]'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;

    if (selector.startsWith('iframe')) {
      const handle = await locator.elementHandle().catch(() => null);
      if (!handle) continue;
      const frame = await handle.contentFrame();
      if (!frame) continue;

      const checkbox = frame.locator('input[type="checkbox"], [role="checkbox"], #ct-checkbox').first();
      if ((await checkbox.count()) === 0) continue;
      await checkbox.waitFor({ timeout: 5000 }).catch(() => null);
      return await clickElement(page, checkbox);
    }

    return await clickElement(page, locator);
  }

  warn('Cloudflare checkbox selector was not found on the page.');
  return false;
}

export async function waitForHumanVerificationIfNeeded(page: Page, timeoutMs: number, autoSolve = false) {
  const present = await isHumanVerificationPresent(page);
  if (!present) {
    return false;
  }

  if (autoSolve) {
    const solved = await clickCloudflareCheckbox(page).catch(() => false);
    if (solved) {
      info('Attempted auto-click of Cloudflare checkbox using ghost-cursor.');
    }
  }

  warn('Human verification detected. Manual intervention may still be required.');
  info('Please complete the verification in the browser window. Waiting until the application page is available.');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (!(await isHumanVerificationPresent(page))) {
      info('Human verification appears to be completed.');
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
