import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { info, warn } from './logger';
import type { AutomationConfig } from './config';
import { waitForPortOpen } from './utils';

export type BrowserLaunch = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

export type BrowserConnection = BrowserLaunch & {
  existing: boolean;
};

async function launchCamoufox(config: AutomationConfig): Promise<BrowserLaunch> {
  info('Launching Camoufox stealth browser in headed mode');
  const camoufoxModule = (await import('camoufox-js')) as any;
  const browser = await camoufoxModule.Camoufox({
    headless: false,
    user_data_dir: config.chromeUserDataDir,
    args: ['--start-maximized'],
  });

  info('Camoufox launch returned browser object', {
    type: typeof browser,
    hasNewContext: typeof browser?.newContext,
    hasNewPage: typeof browser?.newPage,
    hasContexts: typeof browser?.contexts,
  });

  let context: BrowserContext;
  if (typeof browser?.newContext === 'function') {
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
      screen: { width: 1920, height: 1080 },
    });
  } else if (typeof browser?.contexts === 'function') {
    const contexts = await browser.contexts();
    context = contexts[0] || (await (browser as any).newContext({ ignoreHTTPSErrors: true }));
  } else {
    throw new Error('Camoufox browser object does not support newContext or contexts.');
  }
  const page = await context.newPage();

  info('Camoufox launched successfully');
  return { browser, context, page };
}

export async function launchBrowser(config: AutomationConfig): Promise<BrowserLaunch> {
  if (config.useCamoufox) {
    return await launchCamoufox(config);
  }

  info('Launching Chrome with remote debugging');

  const browser = await chromium.launch({
    executablePath: config.chromeExecutable,
    headless: config.headless === true,
    args: [
      `--remote-debugging-port=${config.chromeRemoteDebugPort}`,
      `--user-data-dir=${config.chromeUserDataDir}`
    ]
  });

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  info('Chrome launched successfully');
  return { browser, context, page };
}

export async function connectToBrowser(config: AutomationConfig): Promise<BrowserConnection | null> {
  if (config.useCamoufox) {
    warn('Camoufox mode enabled; skipping existing Chrome CDP reconnection.');
    return null;
  }
  const endpoint = `http://127.0.0.1:${config.chromeRemoteDebugPort}`;
  info('Attempting to connect to existing Chrome CDP endpoint:', endpoint);

  const portReady = await waitForPortOpen(config.chromeRemoteDebugPort, 5000);
  if (!portReady) {
    warn('Chrome CDP endpoint is not reachable on port', config.chromeRemoteDebugPort);
    return null;
  }

  try {
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0] || (await browser.newContext({ ignoreHTTPSErrors: true }));
    const existingPages = context.pages();

    const blankPage = existingPages.find((p) => {
      const url = p.url();
      return (
        !url ||
        url === 'about:blank' ||
        url.startsWith('chrome://') ||
        url.startsWith('edge://') ||
        url.startsWith('about:blank?')
      );
    });

    const activePage = existingPages.find((p) => {
      const url = p.url();
      return url && url !== 'about:blank' && !url.startsWith('chrome://') && !url.startsWith('edge://');
    });

    const page = blankPage || activePage || existingPages[0] || (await context.newPage());

    const selectedUrl = page.url();
    if (blankPage && page === blankPage) {
      info('Connected to existing Chrome CDP session using a blank tab.');
    } else {
      info('Connected to existing Chrome CDP session using existing tab:', selectedUrl);
    }

    return { browser, context, page, existing: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn('Failed to connect to existing CDP session:', message);
    return null;
  }
}
