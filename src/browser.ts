import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import type { Browser, BrowserContext, Page } from 'patchright';
import { info, warn } from './logger';
import type { AutomationConfig } from './config';
import { waitForPortOpen } from './utils';

function loadPatchrightRuntime() {
  const runtimeRequire = eval('require') as NodeRequire;
  const isPkgRuntime = typeof (process as any).pkg !== 'undefined';

  if (isPkgRuntime) {
    const externalPath = path.resolve(process.cwd(), 'node_modules', 'patchright');
    return runtimeRequire(externalPath);
  }

  return runtimeRequire('patchright');
}

const { chromium } = loadPatchrightRuntime();

export type BrowserLaunch = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

export type BrowserConnection = BrowserLaunch & {
  existing: boolean;
};

/**
 * Client-side request blocking — the DevTools "Network request blocking" recipe.
 * The schedule page fires GET /api/v1/page-views/schedule/single-family-
 * schedule-page-views on every load: it BOTH increments the server-side view
 * counter AND returns {showWarning, canViewPage} — canViewPage:false makes the
 * page's own JS run $('#page_form').remove() (strips city select + calendar).
 * Fulfilling locally with canViewPage:true means the request never reaches the
 * server (counter never grows) and the form is never removed — including on
 * accounts the server already counts as over-limit, since this response is the
 * counter's only consumer. Installed on the context so it covers the
 * automation page and any tabs it opens later.
 */
async function blockPageViewTelemetry(context: BrowserContext): Promise<void> {
  try {
    await context.route('**/api/v1/page-views/**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"showWarning":false,"canViewPage":true}'
    }));
    info('Telemetry block armed: /api/v1/page-views/ → forged canViewPage:true');
  } catch (err) {
    warn('Failed to install page-views route block:', err instanceof Error ? err.message : String(err));
  }
}

export async function launchBrowser(config: AutomationConfig, proxyUrl?: string): Promise<BrowserLaunch> {
  info('Launching Chrome with remote debugging');

  const launchArgs = [`--remote-debugging-port=${config.chromeRemoteDebugPort}`];
  if (proxyUrl) launchArgs.push(`--proxy-server=${proxyUrl}`);

  const context = await chromium.launchPersistentContext(config.chromeUserDataDir, {
    executablePath: config.chromeExecutable,
    headless: config.headless === true,
    ignoreHTTPSErrors: true,
    args: launchArgs
  });

  await blockPageViewTelemetry(context);

  const page = context.pages()[0] || await context.newPage();
  const browser = context.browser();
  if (!browser) {
    throw new Error('Failed to resolve browser instance from persistent context.');
  }

  info('Chrome launched successfully');
  return { browser, context, page };
}

export async function connectToBrowser(config: AutomationConfig, proxyUrl?: string): Promise<BrowserConnection | null> {
  // Attempt to connect to an existing Chrome CDP endpoint, launching
  // a local Chrome instance if necessary.
  const endpoint = `http://127.0.0.1:${config.chromeRemoteDebugPort}`;
  info('Attempting to connect to existing Chrome CDP endpoint:', endpoint);

  let portReady = await waitForPortOpen(config.chromeRemoteDebugPort, 10000);
  if (!portReady) {
    warn('Chrome CDP endpoint is not reachable on port', config.chromeRemoteDebugPort);
    // Attempt to launch Chrome with the configured executable and user-data-dir.
    try {
      const localChromeDebug = config.chromeUserDataDir;

      if (!fs.existsSync(localChromeDebug)) {
        fs.mkdirSync(localChromeDebug, { recursive: true });
      }

      const chromeExe = config.chromeExecutable || 'chrome';
      const args = [
        `--remote-debugging-port=${config.chromeRemoteDebugPort}`,
        `--user-data-dir=${localChromeDebug}`,
        '--no-first-run',
        '--no-default-browser-check'
      ];
      if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);

      info(`Launching Chrome: ${chromeExe} ${args.join(' ')}`);
      const child = spawn(chromeExe, args, { detached: true, stdio: 'ignore' });
      child.unref();

      // Wait a bit for Chrome to start and open the port.
      portReady = await waitForPortOpen(config.chromeRemoteDebugPort, 15000);
      if (!portReady) {
        warn('Chrome did not open CDP port after launch.');
        return null;
      }
    } catch (err) {
      warn('Failed to launch Chrome automatically:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  try {
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0] || (await browser.newContext({ ignoreHTTPSErrors: true }));
    await blockPageViewTelemetry(context);
    const existingPages = context.pages();

    const relevantPage = existingPages.find((p: any) => {
      const url = p.url();
      return /https?:\/\/(.*\.)?(usvisascheduling\.com|b2clogin\.com)/i.test(url);
    });

    const blankPage = existingPages.find((p: any) => {
      const url = p.url();
      return (
        !url ||
        url === 'about:blank' ||
        url.startsWith('chrome://') ||
        url.startsWith('edge://') ||
        url.startsWith('about:blank?')
      );
    });

    const page = relevantPage || blankPage || (await context.newPage());

    const selectedUrl = page.url();
    if (relevantPage && page === relevantPage) {
      info('Connected to existing Chrome CDP session using relevant site tab:', selectedUrl);
    } else if (blankPage && page === blankPage) {
      info('Connected to existing Chrome CDP session using a blank tab.');
    } else {
      info('Connected to existing Chrome CDP session using a new tab:', selectedUrl);
    }

    return { browser, context, page, existing: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn('Failed to connect to existing CDP session:', message);
    return null;
  }
}

export async function ensureChromeRunning(config: AutomationConfig, proxyUrl?: string): Promise<boolean> {
  const port = config.chromeRemoteDebugPort;
  if (await waitForPortOpen(port, 1000)) return true;

  const candidates = [
    config.chromeExecutable,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'chrome'
  ].filter(Boolean) as string[];

  const localChromeDebug = config.chromeUserDataDir;
  if (!fs.existsSync(localChromeDebug)) {
    fs.mkdirSync(localChromeDebug, { recursive: true });
  }

  for (const exe of candidates) {
    try {
      info(`Attempting to launch Chrome executable: ${exe}`);
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${localChromeDebug}`,
        '--no-first-run',
        '--no-default-browser-check'
      ];
      if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);
      const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
      child.unref();

      const opened = await waitForPortOpen(port, 10000);
      if (opened) {
        info('Chrome CDP port opened after launching', exe);
        return true;
      }
    } catch (err) {
      warn('Failed launching Chrome with', exe, String(err));
    }
  }

  return false;
}
