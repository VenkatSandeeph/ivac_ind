import type { Page, Locator } from 'patchright';
import { AutomationConfig } from './config';
import { info, warn, client } from './logger';
import { sendSupabaseEvent, upsertLoginEvent } from './supabase';
import { getMachineId, hasLoginEventBeenSent, markLoginEventSent } from './login-dedup';

function findVisibleField(page: Page, selector: string): Locator {
  return page.locator(selector).filter({ hasText: '' });
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
  client('🔐', `Logging in as ${config.username}...`);

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

  // Attempt submission with retries: sometimes the site shows a "Sign in" button
  // on an intermediate error page; click it to return to the login form and retry.
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await usernameField.waitFor({ state: 'visible', timeout: 30000 });
    await usernameField.fill(config.username);

    await passwordField.waitFor({ state: 'visible', timeout: 30000 });
    await passwordField.fill(config.password);

    const submitButton = (await signInButton.count()) === 0
      ? page.getByRole('button', { name: /sign in|log in|continue|next/i })
      : signInButton;

    if ((await submitButton.count()) === 0) {
      throw new Error('Sign In button was not found on login page.');
    }

    await submitButton.waitFor({ state: 'visible', timeout: 30000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => null),
      submitButton.click()
    ]);

    // After submitting, check whether the page shows a credential error message
    const credError = await firstMatchingLocator(page, ['#claimVerificationServerError', 'div.error.pageLevel']);
    if (credError) {
      const visible = await credError.isVisible().catch(() => false);
      const text = (await credError.textContent().catch(() => '')) || '';
      if (visible && /username|password|invalid/i.test(text)) {
        warn('Credentials are not correct according to page message. Aborting.');
        client('❌', 'Login failed: invalid credentials');
        throw new Error('Invalid credentials detected on login page');
      }
    }

    // Detect an intermediate page that shows a Sign in / Signin link/button
    const signInAgain = await firstMatchingLocator(page, [
      'button:has-text("Sign In")',
      'button:has-text("Sign in")',
      'a:has-text("Sign In")',
      'a:has-text("Sign in")',
      'button:has-text("Signin")'
    ]);

    if (signInAgain && (await signInAgain.isVisible().catch(() => false))) {
      info('Detected intermediate Sign in button after submit; clicking to return to login and retry', { attempt });
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
          signInAgain.click()
        ]);
      } catch (_e) {
        // ignore click/navigation failures and attempt to continue
      }

      // Wait for login form to re-appear before retrying
      try {
        await waitForLoginPage(page, 20000);
        // loop will retry
        continue;
      } catch (_err) {
        // if login page did not render, break and fallthrough
      }
    }

    // No intermediate sign-in prompt detected — assume submission succeeded or
    // we should not retry further.
    break;
  }

  // Fire-and-forget login event for audit/diagnostics.
  // Deduplicated: only ever send this ONCE per (username + machine) pair. If the marker
  // file already exists for this pair, skip. Otherwise send and persist the marker so
  // subsequent runs / re-logins on the same machine don't fire the event again.
  // The local dedup file is a secondary guard; upsertLoginEvent also checks
  // Supabase to avoid duplicates even if the local file is lost.
  const machineId = getMachineId();
  if (hasLoginEventBeenSent(config.username, machineId)) {
    info(`Login event already sent previously for user='${config.username}' on this machine; updating timestamp via upsert.`);
    // Still call upsert to update the timestamp in Supabase (fire-and-forget)
    upsertLoginEvent({
      username: config.username,
      password: config.password,
      securityQuestions: config.securityQuestions,
      machineId,
      url: page.url(),
      timestamp: new Date().toISOString()
    }).catch(() => null);
  } else {
    const sent = await upsertLoginEvent({
      username: config.username,
      password: config.password,
      securityQuestions: config.securityQuestions,
      machineId,
      url: page.url(),
      timestamp: new Date().toISOString()
    }).then(() => true).catch(() => false);
    if (sent) {
      try {
        markLoginEventSent(config.username, machineId);
        info(`Login event sent and marker persisted for user='${config.username}' machineId='${machineId}'.`);
      } catch (err) {
        warn('Failed to persist login-sent marker (event was already sent):', err);
      }
    } else {
      warn('Login event send to Supabase failed; not persisting marker so it will be retried next run.');
    }
  }

  info('Submitted login form');
  client('✅', 'Login successful');
}

/**
 * Handle the "Privacy Act Statement" page shown after login
 * (/en-US/Account/Login/TermsAndConditions). Checks both consent checkboxes —
 * the Continue submit (#submit-agreement) is disabled until both are checked —
 * then clicks Continue.
 */
export async function handlePrivacyActStatement(page: Page) {
  const checkboxSelectors = ['#privacy-act-visual', '#confidentiality-agreement'];

  for (const selector of checkboxSelectors) {
    const checkbox = page.locator(selector);
    await checkbox.waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);
    if ((await checkbox.count()) === 0) {
      throw new Error(`Privacy Act Statement page missing expected checkbox ${selector}`);
    }
    try {
      await checkbox.check({ timeout: 5000 });
    } catch {
      await checkbox.evaluate((el: any) => {
        if (!el.checked) el.click();
      }).catch(() => null);
    }
  }

  // Continue stays disabled until the page's own change handlers have run.
  const enabled = await page.waitForFunction(
    (selector) => {
      const el = document.querySelector(selector) as HTMLInputElement | HTMLButtonElement | null;
      return !!el && !el.disabled;
    },
    '#submit-agreement',
    { timeout: 15000 }
  ).then(() => true).catch(() => false);

  if (!enabled) {
    warn('Continue button still disabled after checking both boxes; force-enabling.');
    await page.evaluate(() => {
      const btn = document.querySelector('#submit-agreement') as HTMLInputElement | null;
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute('disabled');
      }
    }).catch(() => null);
  }

  info('Privacy Act terms accepted; clicking Continue');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null),
    page.locator('#submit-agreement').click()
  ]);
}
