import { Page, Locator } from 'playwright';
import { AutomationConfig } from './config';
import { info, warn } from './logger';

function findVisibleField(page: Page, selector: string): Locator {
  return page.locator(selector).filter({ hasText: '' });
}

async function humanDelay(page: Page, baseMs = 750) {
  const delay = baseMs + Math.floor(Math.random() * 250);
  await page.waitForTimeout(delay);
}

async function fillFieldWithHumanDelay(page: Page, field: Locator, value: string) {
  await humanDelay(page);
  await field.fill(value);
  await humanDelay(page, 250);
}

async function findInputField(page: Page, labelText: string): Promise<Locator> {
  const label = page.getByLabel(new RegExp(labelText, 'i'));
  if (await label.count()) {
    const id = await label.getAttribute('for');
    if (id) {
      const field = page.locator(`#${id}`);
      if (await field.count()) {
        return field.first();
      }
    }
    const target = label.locator('xpath=following::input[1] | following::textarea[1]');
    if (await target.count()) {
      return target.first();
    }
  }

  const fallback = page.locator('input[type="text"], input[type="email"], input[type="password"], textarea');
  return fallback.first();
}

async function findLocatorInFrames(page: Page, selector: string): Promise<Locator | null> {
  for (const frame of page.frames()) {
    const frameLocator = frame.locator(selector);
    if (await frameLocator.count()) {
      return frameLocator.first();
    }
  }
  return null;
}

async function firstMatchingLocator(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if ((await locator.count()) > 0) {
      return locator.first();
    }
    const frameLocator = await findLocatorInFrames(page, selector);
    if (frameLocator) {
      return frameLocator;
    }
  }
  return null;
}

async function locateLoginField(
  page: Page,
  selector: string,
  fallbackLabel: string,
  fallbackSelector: string,
  fallbackMatchers: string[] = []
): Promise<Locator> {
  const locator = page.locator(selector);
  if ((await locator.count()) > 0) {
    return locator.first();
  }

  const frameLocator = await findLocatorInFrames(page, selector);
  if (frameLocator) {
    return frameLocator;
  }

  const fallback = await findInputField(page, fallbackLabel);
  if ((await fallback.count()) > 0) {
    return fallback;
  }

  const defaultLocator = page.locator(fallbackSelector);
  if ((await defaultLocator.count()) > 0) {
    return defaultLocator.first();
  }

  if (fallbackMatchers.length > 0) {
    const matchLocator = await firstMatchingLocator(page, fallbackMatchers);
    if (matchLocator) {
      return matchLocator;
    }
  }

  return locator;
}

async function isLoginFormPresent(page: Page): Promise<boolean> {
  const selectors = [
    '#signInName',
    'input[title*="username" i]',
    'input[placeholder*="username" i]',
    'input[id*="user" i]',
    'input[type="email"]',
    'input[type="password"]'
  ];

  for (const selector of selectors) {
    if ((await page.locator(selector).count()) > 0) {
      return true;
    }
    const frameMatch = await findLocatorInFrames(page, selector);
    if (frameMatch) {
      return true;
    }
  }

  return false;
}

async function waitForLoginPage(page: Page, timeout = 30000) {
  const start = Date.now();
  const selectors = [
    '#signInName',
    '#password',
    '#continue',
    'input[title*="username" i]',
    'input[placeholder*="username" i]',
    'input[id*="user" i]',
    'input[type="email"]',
    'input[title*="password" i]',
    'input[placeholder*="password" i]',
    'input[id*="pass" i]',
    'input[type="password"]',
    'button#continue',
    'button:has-text("Sign In")',
    'button:has-text("Continue")'
  ];

  while (Date.now() - start < timeout) {
    for (const selector of selectors) {
      if ((await page.locator(selector).count()) > 0) {
        return;
      }
      const frameMatch = await findLocatorInFrames(page, selector);
      if (frameMatch) {
        return;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Login page did not render expected input fields within timeout.');
}

export async function login(page: Page, config: AutomationConfig) {
  const alreadyOnLogin = await isLoginFormPresent(page);
  if (!alreadyOnLogin) {
    info('Navigating to authentication URL');
    await page.goto(config.authUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } else {
    info('Login form already present, skipping authUrl navigation');
  }
  await waitForLoginPage(page, 30000);

  const usernameField = await locateLoginField(
    page,
    '#signInName',
    'username|email|sign in',
    'input[type="text"], input[type="email"]',
    [
      'input[title*="username" i]',
      'input[placeholder*="username" i]',
      'input[id*="user" i]',
      'input[type="email"]'
    ]
  );
  const passwordField = await locateLoginField(
    page,
    '#password',
    'password',
    'input[type="password"]',
    [
      'input[title*="password" i]',
      'input[placeholder*="password" i]',
      'input[id*="pass" i]',
      'input[type="password"]'
    ]
  );
  const signInButton = page.locator('#continue');

  if ((await usernameField.count()) === 0) {
    throw new Error('Username field was not found on login page.');
  }
  if ((await passwordField.count()) === 0) {
    throw new Error('Password field was not found on login page.');
  }

  await usernameField.waitFor({ state: 'visible', timeout: 30000 });
  await fillFieldWithHumanDelay(page, usernameField, config.username);

  await passwordField.waitFor({ state: 'visible', timeout: 30000 });
  await fillFieldWithHumanDelay(page, passwordField, config.password);

  if ((await signInButton.count()) === 0) {
    const fallbackButton = page.getByRole('button', { name: /sign in|log in|continue|next/i });
    if ((await fallbackButton.count()) === 0) {
      throw new Error('Sign In button was not found on login page.');
    }
    await fallbackButton.waitFor({ state: 'visible', timeout: 30000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => null),
      fallbackButton.click()
    ]);
  } else {
    await signInButton.waitFor({ state: 'visible', timeout: 30000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => null),
      signInButton.click()
    ]);
  }

  // After submitting, check whether the page shows a credential error message
  const credError = await firstMatchingLocator(page, ['#claimVerificationServerError', 'div.error.pageLevel']);
  if (credError) {
    const visible = await credError.isVisible().catch(() => false);
    const text = (await credError.textContent().catch(() => '')) || '';
    if (visible && /username|password|invalid/i.test(text)) {
      warn('Credentials are not correct according to page message. Aborting.');
      throw new Error('Invalid credentials detected on login page');
    }
  }

  info('Submitted login form');
}
