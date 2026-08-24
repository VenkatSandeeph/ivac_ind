const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

let mainWindow = null;
let automationProcess = null;
let chromeCheckInterval = null;
let lastChromeStatus = null;

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const exePath = path.join(distDir, 'ivac.exe');
const scriptPath = path.join(distDir, 'index.js');
const configPath = path.join(distDir, 'config.local.json');

function resolveNodeExecutable() {
  const candidates = [
    process.env.NODE_EXECUTABLE,
    'C:\\Program Files\\nodejs\\node.exe',
    'node'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'node' || fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Node.js executable was not found. Install Node.js or set NODE_EXECUTABLE.');
}

function looksLikePlaceholder(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return (
    normalized === '' ||
    normalized.includes('your_username') ||
    normalized.includes('your_password') ||
    normalized.includes('<tenant>') ||
    normalized.includes('...')
  );
}

function isLikelyAuthFlowUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    return host.includes('usvisascheduling.com') || host.includes('b2clogin.com') || pathname.includes('/oauth2/') || pathname.includes('/authorize');
  } catch {
    return false;
  }
}

function validateConfigContent(content) {
  const issues = [];
  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      issues: [`Invalid JSON: ${error.message}`]
    };
  }

  const authUrl = String(parsed.authUrl || '');
  const username = String(parsed.username || '');
  const password = String(parsed.password || '');
  const appointment = parsed.appointment || {};
  const securityQuestions = Array.isArray(parsed.securityQuestions) ? parsed.securityQuestions : [];

  if (!authUrl) {
    issues.push('Missing authUrl.');
  } else if (looksLikePlaceholder(authUrl) || !isLikelyAuthFlowUrl(authUrl)) {
    issues.push('authUrl must be a real usvisascheduling or B2C login URL.');
  }

  if (!username || !password) {
    issues.push('Missing username or password.');
  } else {
    if (looksLikePlaceholder(username)) issues.push('username still uses placeholder value.');
    if (looksLikePlaceholder(password)) issues.push('password still uses placeholder value.');
  }

  if (!Array.isArray(securityQuestions) || securityQuestions.length === 0) {
    issues.push('At least one security question/answer is required.');
  } else {
    for (const [index, item] of securityQuestions.entries()) {
      if (!item || !String(item.question || '').trim() || !String(item.answer || '').trim()) {
        issues.push(`securityQuestions[${index}] must include both question and answer.`);
      }
    }
  }

  const city = appointment.city;
  if (!city || (Array.isArray(city) && city.length === 0)) {
    issues.push('appointment.city is required.');
  }
  if (!appointment.startDate || !appointment.endDate) {
    issues.push('appointment.startDate and appointment.endDate are required.');
  }
  if (!appointment.month) {
    issues.push('appointment.month is required.');
  }
  if (!appointment.year) {
    issues.push('appointment.year is required.');
  }

  if (!parsed.chromeExecutable || !String(parsed.chromeExecutable).trim()) {
    issues.push('chromeExecutable is required.');
  }

  return {
    ok: issues.length === 0,
    issues,
    parsed
  };
}

function checkChromeConnection(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/json/version',
        timeout: 2500
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += String(chunk);
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({ connected: false, message: `Chrome debug endpoint returned HTTP ${res.statusCode}.` });
            return;
          }

          try {
            const parsed = JSON.parse(body);
            resolve({
              connected: true,
              message: `Connected to Chrome on port ${port}.`,
              browser: parsed.Browser || null,
              webSocketDebuggerUrl: parsed.webSocketDebuggerUrl || null
            });
          } catch {
            resolve({ connected: false, message: 'Chrome debug endpoint returned invalid JSON.' });
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });

    req.on('error', (error) => {
      resolve({ connected: false, message: `Unable to connect to Chrome on port ${port}: ${error.message}` });
    });
  });
}

// (checkChromeAndNotify is implemented later and will be used when automation is running)

function sendLog(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('automation:log', message);
}

function ensureDistConfig() {
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  if (!fs.existsSync(configPath)) {
    const localPath = path.join(projectRoot, 'config.local.json');
    const examplePath = path.join(projectRoot, 'config.example.json');
    if (fs.existsSync(localPath)) {
      fs.copyFileSync(localPath, configPath);
    } else if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, configPath);
    } else {
      fs.writeFileSync(configPath, '{}', 'utf8');
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'IVAC Launcher',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}


async function checkChromeAndNotify() {
  try {
    ensureDistConfig();
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8') || '{}');
    const port = Number(cfg.chromeRemoteDebugPort || 9222);
    const status = await checkChromeConnection(port);
    if (mainWindow && !mainWindow.isDestroyed()) {
      const short = { connected: !!status.connected, message: String(status.message || '') };
      if (JSON.stringify(short) !== JSON.stringify(lastChromeStatus)) {
        mainWindow.webContents.send('chrome:status', status);
        lastChromeStatus = short;
      }
    }
  } catch (err) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const status = { connected: false, message: String(err) };
      const short = { connected: false, message: String(err) };
      if (JSON.stringify(short) !== JSON.stringify(lastChromeStatus)) {
        mainWindow.webContents.send('chrome:status', status);
        lastChromeStatus = short;
      }
    }
  }
}

function startAutomation() {
  if (automationProcess) {
    throw new Error('Automation is already running.');
  }

  if (!fs.existsSync(scriptPath)) {
    throw new Error('dist/index.js not found. Build it first with npm run build.');
  }

  ensureDistConfig();

  const nodeExecutable = resolveNodeExecutable();

  automationProcess = spawn(nodeExecutable, [scriptPath], {
    cwd: distDir,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  sendLog(`[launcher] Started ${nodeExecutable} ${scriptPath}`);

  automationProcess.stdout.on('data', (chunk) => {
    sendLog(String(chunk));
  });

  automationProcess.stderr.on('data', (chunk) => {
    sendLog(`[stderr] ${String(chunk)}`);
  });

  automationProcess.on('close', (code) => {
    sendLog(`[launcher] Process exited with code ${code}`);
    automationProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('automation:status', { running: false });
    }
  });

  automationProcess.on('error', (err) => {
    sendLog(`[launcher] Failed to start process: ${err.message}`);
    automationProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('automation:status', { running: false });
    }
  });

  // No automatic Chrome polling here; UI-triggered `chrome:connect` will run checks on demand.
  // Start periodic Chrome checks while automation is running so the UI stays up-to-date
  if (chromeCheckInterval) {
    clearInterval(chromeCheckInterval);
    chromeCheckInterval = null;
  }
  chromeCheckInterval = setInterval(() => {
    checkChromeAndNotify().catch(() => null);
  }, 30000);

  return { running: true };
}

function stopAutomation() {
  if (!automationProcess) {
    return { running: false };
  }

  const pid = automationProcess.pid;
  const killed = automationProcess.kill();
  sendLog(`[launcher] Stop requested for PID ${pid}; kill=${killed}`);
  if (chromeCheckInterval) {
    clearInterval(chromeCheckInterval);
    chromeCheckInterval = null;
  }
  return { running: !!automationProcess };
}

ipcMain.handle('automation:start', async () => {
  const result = startAutomation();
  return result;
});

ipcMain.handle('automation:stop', async () => {
  return stopAutomation();
});

ipcMain.handle('automation:status', async () => {
  return { running: !!automationProcess };
});

ipcMain.handle('config:read', async () => {
  ensureDistConfig();
  return fs.readFileSync(configPath, 'utf8');
});

ipcMain.handle('config:save', async (_event, content) => {
  ensureDistConfig();
  JSON.parse(content);
  fs.writeFileSync(configPath, content, 'utf8');
  return { ok: true };
});

ipcMain.handle('config:validate', async (_event, content) => {
  ensureDistConfig();
  return validateConfigContent(content);
});

ipcMain.handle('chrome:connect', async (_event, content) => {
  const validation = validateConfigContent(content);
  if (!validation.parsed) {
    return {
      connected: false,
      message: validation.issues.join(' ')
    };
  }

  const port = Number(validation.parsed.chromeRemoteDebugPort || 9222);
  const status = await checkChromeConnection(port);
  if (status.connected) return status;

  // If not connected, attempt to launch Chrome from the UI using the configured executable
  try {
    const localChromeDebug = path.join(distDir, 'chrome-debug');
    if (!fs.existsSync(localChromeDebug)) {
      if (fs.existsSync(validation.parsed.chromeUserDataDir)) {
        try {
          fs.cpSync(validation.parsed.chromeUserDataDir, localChromeDebug, { recursive: true });
        } catch (err) {
          try { fs.mkdirSync(localChromeDebug, { recursive: true }); } catch (e) {}
        }
      } else {
        fs.mkdirSync(localChromeDebug, { recursive: true });
      }
    }

    const chromeExe = validation.parsed.chromeExecutable || 'chrome';
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${localChromeDebug}`,
      '--no-first-run',
      '--no-default-browser-check'
    ];
    sendLog(`[launcher] Launching Chrome from UI: ${chromeExe} ${args.join(' ')}`);
    const child = spawn(chromeExe, args, { detached: true, stdio: 'ignore' });
    try { child.unref(); } catch (e) {}

    // wait for endpoint to come up (max 10s)
    const start = Date.now();
    while (Date.now() - start < 10000) {
      // eslint-disable-next-line no-await-in-loop
      const now = await checkChromeConnection(port);
      if (now.connected) return now;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1000));
    }

    return { connected: false, message: 'Chrome did not open CDP port after launch.' };
  } catch (err) {
    return { connected: false, message: `Failed to launch Chrome: ${String(err)}` };
  }
});

ipcMain.handle('config:path', async () => {
  return configPath;
});

ipcMain.handle('config:openFolder', async () => {
  await dialog.showOpenDialog({
    properties: ['openFile'],
    defaultPath: configPath,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();

  // Do an initial Chrome status check to update the UI
  checkChromeAndNotify().catch(() => null);

  // No background Chrome checks until automation is started.

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (automationProcess) {
    automationProcess.kill();
  }
  if (chromeCheckInterval) {
    clearInterval(chromeCheckInterval);
    chromeCheckInterval = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
