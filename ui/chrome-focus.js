// chrome-focus.js — bring a profile's Chrome window to the foreground.
//
// Self-contained module: the only input is the profile's CDP debug port.
// Uses HTTP /json/list to pick a tab, then patchright's CDP websocket to
// restore the window if minimized (Browser.setWindowBounds 'normal') and
// focus it (Page.bringToFront). Connects and disconnects per call — safe
// to invoke while an automation core is attached to the same CDP port.

const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('patchright');

const VISA_URL_RE = /usvisascheduling|b2clogin/i;
const CONNECT_TIMEOUT_MS = 5000;

function listTargets(port, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Prefer the visa/booking tab; fall back to the first page target.
function pickTarget(targets) {
  const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.type === 'page');
  return pages.find((t) => VISA_URL_RE.test(t.url || '')) || pages[0] || null;
}

// CDP's Page.bringToFront only ACTIVATES the tab — raising the window on
// Windows requires SetForegroundWindow, which Windows denies to background
// processes (Chrome qualifies). A detached child spawned by Electron
// inherits our foreground rights (the user clicked our UI), so this small
// PowerShell helper can legally raise the window. Fire-and-forget: we
// never wait on it, so the API response is not delayed. The profile's
// --user-data-dir uniquely identifies its chrome.exe among all profiles.
function raiseWindowToFront(userDataDir) {
  if (!userDataDir || process.platform !== 'win32') return;
  const dir = String(userDataDir).replace(/'/g, "''");
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class IVacWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);
}
"@
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*${dir}*' } |
  ForEach-Object {
    $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) {
      [IVacWin]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null
      [IVacWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    }
  }
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
  child.on('error', () => {});
}

async function focusChromeWindow(port, userDataDir) {
  const target = pickTarget(await listTargets(port));
  if (!target) return { ok: false, msg: 'No open tab found on port ' + port };

  let browser = null;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: CONNECT_TIMEOUT_MS });
    const pages = browser.contexts().flatMap((c) => c.pages());
    const page = pages.find((p) => VISA_URL_RE.test(p.url() || '')) || pages[0];

    // Un-minimize explicitly — Page.bringToFront alone does not reliably
    // restore a minimized window on Windows.
    const browserSession = await browser.newBrowserCDPSession();
    const { windowId } = await browserSession.send('Browser.getWindowForTarget', { targetId: target.id });
    await browserSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });

    if (page) {
      const pageSession = await page.context().newCDPSession(page);
      await pageSession.send('Page.bringToFront');
    }
    // Foreground raise must come from a process with foreground rights —
    // see raiseWindowToFront above. Fire-and-forget, no await.
    raiseWindowToFront(userDataDir);
    return { ok: true, msg: 'Window focused' };
  } catch (e) {
    return { ok: false, msg: 'Failed to focus window: ' + (e && e.message ? e.message : String(e)) };
  } finally {
    if (browser) await browser.close().catch(() => null); // disconnects the CDP session, Chrome stays open
  }
}

module.exports = { focusChromeWindow, raiseWindowToFront, listTargets, pickTarget };
