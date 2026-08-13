import fs from 'fs';
import path from 'path';
import type { Page, BrowserContext } from 'playwright';

const artifactsBase = path.resolve(process.cwd(), 'artifacts');

function ensureArtifactDir(subdir: string) {
  const fullPath = path.join(artifactsBase, subdir);
  fs.mkdirSync(fullPath, { recursive: true });
  return fullPath;
}

export async function saveScreenshot(page: Page, name: string) {
  const dir = ensureArtifactDir('screenshots');
  const fileName = `${name}-${Date.now()}.png`;
  const filePath = path.join(dir, fileName);
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => null);
  return filePath;
}

export async function saveTrace(context: BrowserContext, name: string) {
  const dir = ensureArtifactDir('traces');
  const fileName = `${name}-${Date.now()}.zip`;
  const filePath = path.join(dir, fileName);
  await context.tracing.stop({ path: filePath }).catch(() => null);
  return filePath;
}

export async function savePageState(page: Page, name: string) {
  const dir = ensureArtifactDir('logs');
  const fileName = `${name}-${Date.now()}.txt`;
  const filePath = path.join(dir, fileName);
  try {
    const body = await page.locator('body').innerText();
    const title = await page.title();
    const url = page.url();
    const content = [`URL: ${url}`, `TITLE: ${title}`, 'BODY:', body].join('\n\n');
    fs.writeFileSync(filePath, content, 'utf8');
  } catch {
    fs.writeFileSync(filePath, `Failed to capture page state at ${new Date().toISOString()}`, 'utf8');
  }
  return filePath;
}
