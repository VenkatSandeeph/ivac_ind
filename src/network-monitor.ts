import { Page, Request, Response } from 'playwright';
import { debug, warn } from './logger';

const importantStatuses = new Set([403, 429, 500, 502, 503, 504]);

export function monitorNetwork(page: Page, debugEnabled: boolean) {
  page.on('request', (request: Request) => {
    const url = request.url();
    if (request.resourceType() === 'xhr' || request.resourceType() === 'fetch') {
      if (debugEnabled) {
        debug('Network request', request.method(), url);
      }
    }
  });

  page.on('response', (response: Response) => {
    const status = response.status();
    const url = response.url();

    if (importantStatuses.has(status)) {
      warn('Important response', response.request().method(), url, 'status=', status);
    }

    if (url.startsWith('https://') && status >= 400) {
      warn('HTTPS error response', response.request().method(), url, 'status=', status);
    }

    if (debugEnabled) {
      debug('Network response', response.request().method(), url, 'status=', status);
    }
  });
}
