/* main.js -- Electron main process for IVAC Launcher (multi-profile) */
const { app, BrowserWindow, dialog, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const net = require('net');
const os = require('os');

// ---- paths (work in both dev and packaged mode) ----
const IS_PACKAGED = app.isPackaged;
const PROJECT_ROOT = IS_PACKAGED
  ? path.dirname(app.getPath('exe'))
  : path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.local.json');
const LICENSE_FILE_PATH = path.join(PROJECT_ROOT, '.license');
const PORT = 3456;

// NordVPN initial check — only on first profile start
let nordvpnChecked = false;

// ---- Supabase license config ----
const LICENSE_SUPABASE_URL = 'https://ptgvkfawdwgwlrpuowjk.supabase.co';
const LICENSE_SUPABASE_KEY = 'sb_publishable_BpwV8vJS8RkVAlgayjlK1g_JSED4oLE';
const LICENSE_TABLE = 'Licenses';

// ---- state ----
const runningProfiles = new Map();
let mainWindow = null;
let licenseValidated = false;
let licenseClientName = '';
const STOP_SIGNAL_FILE_BASE = path.join(PROJECT_ROOT, '.ivac-stop');
// Live flag file for the Special Window toggle (dev-only feature). Running
// cores read this each loop iteration — "on"/"off" — so the checkbox pauses
// and resumes profiles without a restart.
const SPECIAL_WINDOW_FLAG_FILE = path.join(PROJECT_ROOT, '.ivac-special-window');
const MAX_LOG_SIZE = 500_000;

// Ordered country → city rotation sequence for the manual Rotate IP button
// (mirrors src/nordvpn.ts). Exhausts every city of a country before moving to
// the next country, then wraps to the first US city. In-memory only.
const ROTATION_COUNTRIES = [
  {
    country: 'United States',
    cities: [
      'Montgomery', 'Anchorage', 'Phoenix', 'Little Rock', 'Los Angeles',
      'San Francisco', 'Denver', 'New Haven', 'Wilmington', 'Miami',
      'Atlanta', 'Honolulu', 'Boise', 'Chicago', 'Indianapolis',
      'Des Moines', 'Wichita', 'Louisville', 'New Orleans', 'Lewiston',
      'Baltimore', 'Boston', 'Detroit', 'Minneapolis', 'Jackson',
      'Kansas City', 'Saint Louis', 'Billings', 'Omaha', 'Las Vegas',
      'Nashua', 'Trenton', 'Albuquerque', 'Buffalo', 'New York',
      'Charlotte', 'Fargo', 'Columbus', 'Oklahoma City', 'Portland',
      'Pittsburgh', 'Providence', 'Charleston', 'Sioux Falls', 'Nashville',
      'Dallas', 'Houston', 'McAllen', 'Salt Lake City', 'Burlington',
      'Ashburn', 'Seattle', 'Huntington', 'Milwaukee', 'Cheyenne'
    ]
  },
  { country: 'United Kingdom', cities: ['Edinburgh', 'Glasgow', 'London', 'Manchester'] },
  { country: 'France', cities: ['Bordeaux', 'Marseille', 'Paris', 'Strasbourg'] },
  { country: 'Denmark', cities: ['Copenhagen'] },
  { country: 'Czech Republic', cities: ['Prague'] },
  { country: 'Papua New Guinea', cities: ['Port Moresby'] },
  { country: 'Costa Rica', cities: ['San Jose'] }
];

const CITY_ROTATION_SEQUENCE = ROTATION_COUNTRIES.flatMap(({ country, cities }) =>
  cities.map((city) => ({ country, city }))
);

let rotationIndex = 0;

function runNordVpnCommand(exePath, args, timeoutMs) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const done = (result) => { if (settled) return; settled = true; resolve(result); };
    const child = spawn(exePath, args, { cwd: path.dirname(exePath), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} done({ ok: false, output: output + ' [timeout]' }); }, timeoutMs);
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); done({ ok: code === 0, output }); });
    child.on('error', (err) => { clearTimeout(timer); done({ ok: false, output: err.message }); });
  });
}

function getPublicIP(ipCheckUrl) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.get(ipCheckUrl || 'https://api.ipify.org', (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body.trim() || null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}

function getStopSignalFile(profileId) {
  return STOP_SIGNAL_FILE_BASE + '-' + (profileId || 'default');
}

// Geolocate a public IP via ip-api.com (free tier is HTTP-only; the lookup
// goes through the VPN so it reports the exit's geo). Returns {country, city}
// or null when the lookup fails.
function geoLocateIp(ip) {
  return new Promise((resolve) => {
    const req = http.get(`http://ip-api.com/json/${ip}?fields=status,country,city`, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j && j.status === 'success' ? { country: String(j.country || ''), city: String(j.city || '') } : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

const GEO_COUNTRY_ALIASES = {
  'united states': ['united states', 'united states of america', 'usa'],
  'united kingdom': ['united kingdom', 'great britain', 'uk', 'england'],
  'czech republic': ['czech republic', 'czechia'],
  'papua new guinea': ['papua new guinea'],
  'costa rica': ['costa rica'],
  'france': ['france'],
  'denmark': ['denmark']
};

function geoCountryMatches(expected, geoCountry) {
  const g = String(geoCountry || '').trim().toLowerCase();
  const e = String(expected || '').trim().toLowerCase();
  if (!g || !e) return false;
  return g === e || (GEO_COUNTRY_ALIASES[e] || []).indexOf(g) !== -1;
}

// ---- single instance lock ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ---- helpers ----

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    console.log('[main] readConfig profiles count:', raw?.profiles?.length, 'path:', CONFIG_PATH);
    return raw;
  } catch (e) {
    console.error('[main] readConfig failed:', e.message, 'path:', CONFIG_PATH);
    return null;
  }
}

function writeConfig(obj) {
  console.log('[main] writeConfig profiles count:', obj?.profiles?.length, 'path:', CONFIG_PATH);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

function ensureConfig() {
  if (fs.existsSync(CONFIG_PATH)) return;
  writeConfig(getDefaultConfig());
}

function getDefaultConfig() {
  return {
    schemaVersion: 1,
    settings: {
      authUrl: 'https://www.usvisascheduling.com',
      scheduleUrl: 'https://www.usvisascheduling.com/en-US/ofc-schedule/',
      chromeExecutable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      chromeUserDataDir: path.join(PROJECT_ROOT, 'chrome-debug-1'),
      chromeRemoteDebugPort: 9222,
      maxSlotAttempts: 10,
      slotRetryDelayMs: 10000,
      cityRetrySeconds: 12,
      cloudflareWaitMs: 180000,
      debugNetwork: false,
      autoSolveCloudflare: true,
      headless: false,
      alertOnMajorEvents: true,
      screenshotAfterSelection: true,
      dryRun: false,
      uiApiMismatchRetries: 2,
      uiApiMismatchRetryDelayMs: 1000,
      maxDateAttempts: 3,
      preferLeastSlots: false,
      autoRotateIp: true,
      nordvpn: {
        exePath: 'C:\\Program Files\\NordVPN\\nordvpn.exe',
        connectTimeoutMs: 30000,
        ipCheckUrl: 'https://api.ipify.org'
      }
    },
    profiles: []
  };
}

function migrateLegacyConfig(raw) {
  if (!raw || Array.isArray(raw.profiles)) return raw;

  const settings = { ...raw };
  delete settings.username;
  delete settings.password;
  delete settings.securityQuestions;
  delete settings.appointment;

  const profile = {
    id: 'p1',
    instanceIndex: 1,
    username: raw.username || '',
    password: raw.password || '',
    securityQuestions: raw.securityQuestions || [],
    appointment: raw.appointment || {
      city: '',
      month: '',
      year: 0,
      startDate: '',
      endDate: '',
      preferredTime: null
    },
    chromeUserDataDir: path.join(PROJECT_ROOT, 'chrome-debug-1'),
    chromeRemoteDebugPort: 9222
  };

  return {
    schemaVersion: 1,
    settings,
    profiles: [profile]
  };
}

function nextInstanceIndex(cfg) {
  const indices = (cfg.profiles || []).map((p) => Number(p.instanceIndex) || 0);
  let n = 1;
  while (indices.includes(n)) n += 1;
  return n;
}

function getProfileDir(instanceIndex) {
  return path.join(PROJECT_ROOT, 'chrome-debug-' + instanceIndex);
}

function appendLog(profileId, text) {
  const rec = runningProfiles.get(profileId);
  if (!rec) return;
  rec.log += text;
  if (rec.log.length > MAX_LOG_SIZE) {
    rec.log = rec.log.slice(rec.log.length - MAX_LOG_SIZE);
  }
  if (text.includes('[BROWSER_CLOSED]')) rec.browserClosed = true;

  // Parse log text to update status dynamically
  const str = typeof text === 'string' ? text : String(text);

  // Explicit state marker emitted by the core ([UI_STATUS] <label>) — always
  // wins over the keyword guessing below.
  const uiMatch = str.match(/\[UI_STATUS\]\s*([^\r\n]+)/);
  if (uiMatch) {
    rec.status = uiMatch[1].trim().slice(0, 60);
    return;
  }

  if (str.includes('Backend error') || str.includes('APP_ERROR')) {
    rec.status = 'Backend error';
  } else if (str.includes('Rotating IP') || str.includes('IP rotation')) {
    rec.status = 'Rotating IP';
  } else if (str.includes('403') || str.includes('429') || str.includes('blocked')) {
    rec.status = 'Blocked';
  } else if (str.includes('login') || str.includes('Login') || str.includes('login page')) {
    rec.status = 'Login page';
  } else if (str.includes('Cloudflare') || str.includes('cloudflare') || str.includes('verification') || str.includes('Human verification')) {
    rec.status = 'Cloudflare';
  } else if (str.includes('Consular') || str.includes('consular')) {
    rec.status = 'Consular';
  } else if (str.includes('schedule') || str.includes('Schedule') || str.includes('OFC')) {
    rec.status = 'Schedule page';
  } else if (str.includes('Home') || str.includes('home page') || str.includes('Dashboard')) {
    rec.status = 'Home page';
  } else if (str.includes('city_selection') || str.includes('City selected') || str.includes('selectCity')) {
    rec.status = 'City selection';
  } else if (str.includes('date_selected') || str.includes('Date selected') || str.includes('clickDateCell')) {
    rec.status = 'Date selected';
  } else if (str.includes('time_selected') || str.includes('Time selected') || str.includes('selectTimeCandidate')) {
    rec.status = 'Time selected';
  } else if (str.includes('submit') || str.includes('Submit') || str.includes('booked') || str.includes('Booked')) {
    rec.status = 'Submitting';
  } else if (str.includes('[STOPPED]') || str.includes('Script stopped')) {
    rec.status = 'Stopped';
  } else if (str.includes('Starting') || str.includes('starting')) {
    rec.status = 'Starting';
  }
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error',   () => { sock.destroy(); resolve(false); });
    sock.connect(port, '127.0.0.1');
  });
}

function findFreePort(start, end) {
  return new Promise(async (resolve) => {
    for (let p = start; p <= end; p += 1) {
      if (!(await isPortOpen(p))) return resolve(p);
    }
    resolve(0);
  });
}

// ---- license helpers ----

function getSystemName() {
  return os.hostname() + '\\' + os.userInfo().username;
}

function readStoredLicenseKey() {
  try {
    if (!fs.existsSync(LICENSE_FILE_PATH)) return null;
    const raw = fs.readFileSync(LICENSE_FILE_PATH, 'utf8').trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed.key || parsed.license_key || null;
    } catch {
      return raw;
    }
  } catch {
    return null;
  }
}

function storeLicenseKey(key) {
  fs.writeFileSync(LICENSE_FILE_PATH, JSON.stringify({ key }, null, 2), 'utf8');
}

function clearStoredLicenseKey() {
  try { if (fs.existsSync(LICENSE_FILE_PATH)) fs.unlinkSync(LICENSE_FILE_PATH); } catch {}
}

async function validateLicenseKey(licenseKey) {
  if (!licenseKey || !licenseKey.trim()) {
    return { valid: false, status: 'invalid_key', message: 'No license key provided.' };
  }

  const key = licenseKey.trim();

  try {
    let createClient;
    try {
      const mod = require('@supabase/supabase-js');
      createClient = mod.createClient;
    } catch {
      return await validateLicenseViaRest(key);
    }

    const client = createClient(LICENSE_SUPABASE_URL, LICENSE_SUPABASE_KEY);

    const { data, error } = await client
      .from(LICENSE_TABLE)
      .select('*')
      .eq('license_key', key)
      .limit(1);

    if (error) {
      return { valid: false, status: 'network_error', message: 'License server error: ' + (error.message || 'Unknown') };
    }

    if (!data || data.length === 0) {
      return { valid: false, status: 'invalid_key', message: 'Invalid license key.' };
    }

    const record = data[0];

    if (record.terminated) {
      return { valid: false, status: 'terminated', message: 'This license has been terminated by the administrator.', record };
    }

    if (!record.active) {
      return { valid: false, status: 'deactivated', message: 'This license has been deactivated. Contact your administrator.', record };
    }

    if (record.expires_at) {
      const expiresAt = new Date(record.expires_at);
      if (expiresAt.getTime() < Date.now()) {
        return { valid: false, status: 'expired', message: 'This license expired on ' + expiresAt.toLocaleDateString() + '.', record };
      }
    }

    const systemName = getSystemName();
    await client
      .from(LICENSE_TABLE)
      .update({ system_name: systemName, last_validated_at: new Date().toISOString() })
      .eq('license_key', key)
      .then(() => null)
      .catch(() => null);

    return { valid: true, status: 'valid', message: 'License valid. Welcome, ' + record.client_name + '.', record: { ...record, system_name: systemName } };
  } catch (err) {
    try {
      return await validateLicenseViaRest(key);
    } catch (restErr) {
      return { valid: false, status: 'network_error', message: 'Cannot reach license server: ' + (err.message || String(err)) };
    }
  }
}

async function validateLicenseViaRest(key) {
  const https = require('https');
  const url = LICENSE_SUPABASE_URL + '/rest/v1/' + LICENSE_TABLE +
    '?license_key=eq.' + encodeURIComponent(key) + '&select=*&limit=1';

  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'apikey': LICENSE_SUPABASE_KEY,
        'Authorization': 'Bearer ' + LICENSE_SUPABASE_KEY,
        'Content-Type': 'application/json'
      },
      rejectUnauthorized: false
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);

          if (!Array.isArray(data) || data.length === 0) {
            resolve({ valid: false, status: 'invalid_key', message: 'Invalid license key.' });
            return;
          }

          const record = data[0];

          if (record.terminated) {
            resolve({ valid: false, status: 'terminated', message: 'This license has been terminated by the administrator.', record });
            return;
          }

          if (!record.active) {
            resolve({ valid: false, status: 'deactivated', message: 'This license has been deactivated. Contact your administrator.', record });
            return;
          }

          if (record.expires_at) {
            const expiresAt = new Date(record.expires_at);
            if (expiresAt.getTime() < Date.now()) {
              resolve({ valid: false, status: 'expired', message: 'This license expired on ' + expiresAt.toLocaleDateString() + '.', record });
              return;
            }
          }

          const systemName = getSystemName();
          const patchUrl = LICENSE_SUPABASE_URL + '/rest/v1/' + LICENSE_TABLE +
            '?license_key=eq.' + encodeURIComponent(key);
          const patchBody = JSON.stringify({ system_name: systemName, last_validated_at: new Date().toISOString() });
          const patchReq = https.request(patchUrl, {
            method: 'PATCH',
            headers: {
              'apikey': LICENSE_SUPABASE_KEY,
              'Authorization': 'Bearer ' + LICENSE_SUPABASE_KEY,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(patchBody)
            },
            rejectUnauthorized: false
          }, () => {});
          patchReq.write(patchBody);
          patchReq.end();
          patchReq.on('error', () => {});

          resolve({ valid: true, status: 'valid', message: 'License valid. Welcome, ' + record.client_name + '.', record: { ...record, system_name: systemName } });
        } catch (parseErr) {
          resolve({ valid: false, status: 'network_error', message: 'Invalid response from license server.' });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ valid: false, status: 'network_error', message: 'Cannot reach license server: ' + err.message });
    });

    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ valid: false, status: 'network_error', message: 'License server timeout.' });
    });
  });
}

async function selfDestruct() {
  clearStoredLicenseKey();

  if (IS_PACKAGED) {
    const appDir = path.dirname(app.getPath('exe'));
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'License Terminated',
      message: 'This license has been terminated by the administrator.\n\nThe application will now be removed.',
      buttons: ['OK']
    });

    const batContent = '@echo off\r\ntimeout /t 3 /nobreak >nul\r\nrd /s /q "' + appDir + '"\r\n';
    const batPath = path.join(os.tmpdir(), 'ivac-cleanup-' + Date.now() + '.bat');
    try {
      fs.writeFileSync(batPath, batContent, 'utf8');
      spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch {}

    app.quit();
  } else {
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'License Terminated',
      message: 'This license has been terminated by the administrator.\n\n(Dev mode: files not deleted)',
      buttons: ['OK']
    });
    app.quit();
  }
}

// ---- profile process manager ----

function getProfileFromConfig(cfg, profileId) {
  return (cfg.profiles || []).find((p) => p.id === profileId || p.username === profileId);
}

async function startProfile(profileId) {
  if (!licenseValidated) return { ok: false, msg: 'License not validated' };

  let rec = runningProfiles.get(profileId);
  if (rec && rec.process && !rec.process.killed) {
    return { ok: false, msg: 'Already running' };
  }

  const cfg = migrateLegacyConfig(readConfig());
  if (!cfg || !Array.isArray(cfg.profiles)) return { ok: false, msg: 'Config not found or invalid' };
  const profile = getProfileFromConfig(cfg, profileId);
  if (!profile) return { ok: false, msg: 'Profile not found' };

  // Initial NordVPN check — only on first profile start
  if (!nordvpnChecked) {
    const nordvpnExe = (cfg.settings && cfg.settings.nordvpn && cfg.settings.nordvpn.exePath) || 'C:\\Program Files\\NordVPN\\nordvpn.exe';
    if (!fs.existsSync(nordvpnExe)) {
      return { ok: false, msg: 'NordVPN not found at: ' + nordvpnExe + '. Update nordvpn.exePath in config.local.json.' };
    }
    nordvpnChecked = true;
  }

  const chromeDir = profile.chromeUserDataDir || getProfileDir(profile.instanceIndex);
  if (!fs.existsSync(chromeDir)) fs.mkdirSync(chromeDir, { recursive: true });

  try { fs.unlinkSync(getStopSignalFile(profileId)); } catch {}

  let cmd, args, useShell;
  if (IS_PACKAGED) {
    cmd = path.join(PROJECT_ROOT, 'ivac-core.exe');
    args = [];
    useShell = false;
  } else {
    const tsxBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx.cmd');
    const scriptPath = path.join(PROJECT_ROOT, 'src', 'index.ts');
    if (fs.existsSync(tsxBin)) {
      cmd = tsxBin;
      args = [scriptPath];
    } else {
      cmd = 'npx';
      args = ['tsx', scriptPath];
    }
    useShell = true;
  }

  // Verify the executable exists before spawning
  if (IS_PACKAGED && !fs.existsSync(cmd)) {
    console.error('[main] ivac-core.exe not found at:', cmd);
    console.error('[main] PROJECT_ROOT:', PROJECT_ROOT);
    console.error('[main] app.getPath("exe"):', app.getPath('exe'));
    return { ok: false, msg: 'ivac-core.exe not found at ' + cmd };
  }

  appendLog(profileId, '[UI] Starting automation for profile ' + profile.username + '\n');
  appendLog(profileId, '[UI] Command: ' + cmd + ' ' + args.join(' ') + '\n');
  appendLog(profileId, '[UI] Chrome dir: ' + chromeDir + '\n');
  appendLog(profileId, '[UI] Chrome port: ' + (profile.chromeRemoteDebugPort || 9222) + '\n');
  console.log('[main] Starting profile', profile.username, 'cmd:', cmd, 'args:', args);

  const env = {
    ...process.env,
    IVAC_PROFILE_ID: String(profile.id),
    CHROME_USER_DATA_DIR: chromeDir,
    CHROME_REMOTE_DEBUG_PORT: String(profile.chromeRemoteDebugPort || 9222)
  };

  const child = spawn(cmd, args, {
    cwd: PROJECT_ROOT,
    env,
    shell: useShell,
    windowsHide: true
  });

  rec = {
    process: child,
    log: (rec && rec.log) || '',
    status: 'starting',
    checkpoints: {},
    browserClosed: false,
    chromePid: null
  };
  runningProfiles.set(profileId, rec);

  child.stdout.on('data', (d) => appendLog(profileId, d.toString()));
  child.stderr.on('data', (d) => appendLog(profileId, d.toString()));

  child.on('error', (err) => {
    appendLog(profileId, '[UI] Failed to start: ' + err.message + '\n');
    console.error('[main] spawn error for', profile.username, ':', err.message);
    runningProfiles.delete(profileId);
  });

  child.on('close', (code) => {
    appendLog(profileId, '[UI] Script exited with code ' + code + '\n');
    console.log('[main] child process for', profile.username, 'exited with code', code);
    runningProfiles.delete(profileId);
  });

  return { ok: true, msg: 'Started', profileId };
}

function stopProfile(profileId) {
  const rec = runningProfiles.get(profileId);
  if (!rec || !rec.process) return { ok: false, msg: 'Not running' };

  appendLog(profileId, '[UI] Stopping automation script (Chrome will stay open)...\n');
  try { fs.writeFileSync(getStopSignalFile(profileId), String(Date.now())); } catch {}

  const pid = rec.process.pid;
  setTimeout(() => {
    const still = runningProfiles.get(profileId);
    if (still && still.process && still.process.pid === pid) {
      appendLog(profileId, '[UI] Forcing stop (fallback)...\n');
      try {
        if (process.platform === 'win32') {
          exec('taskkill /pid ' + pid + ' /F', { windowsHide: true });
        } else {
          still.process.kill('SIGKILL');
        }
      } catch {}
    }
  }, 5000);

  return { ok: true, msg: 'Stop signal sent' };
}

async function connectChrome(profileId) {
  const cfg = migrateLegacyConfig(readConfig());
  if (!cfg || !Array.isArray(cfg.profiles)) return { ok: false, msg: 'Config not found or invalid' };
  const profile = getProfileFromConfig(cfg, profileId);
  if (!profile) return { ok: false, msg: 'Profile not found' };

  const port = profile.chromeRemoteDebugPort || 9222;
  if (await isPortOpen(port)) {
    return { ok: true, msg: 'Connected (port ' + port + ')', profileId };
  }

  const candidates = [
    (profile.chromeExecutable || cfg.settings?.chromeExecutable),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'chrome'
  ].filter(Boolean);

  const userDataDir = profile.chromeUserDataDir || getProfileDir(profile.instanceIndex);
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  for (const exe of candidates) {
    try {
      appendLog(profileId, '[UI] Launching Chrome: ' + exe + '\n');
      const child = spawn(exe, [
        '--remote-debugging-port=' + port,
        '--user-data-dir=' + userDataDir,
        '--no-first-run',
        '--no-default-browser-check'
      ], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();

      for (let i = 0; i < 20; i += 1) {
        await new Promise(r => setTimeout(r, 500));
        if (await isPortOpen(port)) {
          appendLog(profileId, '[UI] Chrome CDP ready on port ' + port + '\n');
          const rec = runningProfiles.get(profileId);
          if (rec) rec.chromePid = child.pid;
          return { ok: true, msg: 'Connected (port ' + port + ')', profileId };
        }
      }
    } catch (e) {
      appendLog(profileId, '[UI] Failed: ' + e.message + '\n');
    }
  }
  return { ok: false, msg: 'Failed to connect' };
}

function stopAllProfiles() {
  for (const [id] of runningProfiles) stopProfile(id);
}

// ---- HTTP API server ----

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'text/plain',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

const apiServer = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // Static files
  if (url === '/' || url === '/index.html') return serveStatic(res, path.join(__dirname, 'index.html'));
  if (url === '/renderer.js') return serveStatic(res, path.join(__dirname, 'renderer.js'));
  if (url === '/styles.css')  return serveStatic(res, path.join(__dirname, 'styles.css'));

  // ---- License API ----

  if (url === '/api/license-status') {
    const storedKey = readStoredLicenseKey();
    return jsonResponse(res, {
      hasStoredKey: !!storedKey,
      validated: licenseValidated,
      clientName: licenseClientName
    });
  }

  if (url === '/api/validate-license' && req.method === 'POST') {
    const body = await parseBody(req);
    const key = body.key || '';
    const result = await validateLicenseKey(key);

    if (result.status === 'terminated') {
      jsonResponse(res, result);
      setTimeout(() => selfDestruct(), 500);
      return;
    }

    if (result.valid) {
      storeLicenseKey(key);
      licenseValidated = true;
      licenseClientName = result.record?.client_name || '';
    } else {
      clearStoredLicenseKey();
      licenseValidated = false;
      licenseClientName = '';
    }

    return jsonResponse(res, result);
  }

  if (url === '/api/license-logout' && req.method === 'POST') {
    clearStoredLicenseKey();
    licenseValidated = false;
    licenseClientName = '';
    stopAllProfiles();
    return jsonResponse(res, { ok: true, msg: 'License cleared' });
  }

  if (url === '/api/open-external' && req.method === 'POST') {
    const body = await parseBody(req);
    if (body.url) {
      shell.openExternal(body.url).catch(() => {});
      return jsonResponse(res, { ok: true });
    }
    return jsonResponse(res, { ok: false, msg: 'No URL' }, 400);
  }

  // ---- All endpoints below require valid license ----

  if (!licenseValidated) {
    return jsonResponse(res, { ok: false, msg: 'License not validated' }, 403);
  }

  // Config
  if (url === '/api/config' && req.method === 'GET') {
    let cfg = readConfig();
    if (!cfg) {
      ensureConfig();
      cfg = readConfig();
    }
    cfg = migrateLegacyConfig(cfg);
    return jsonResponse(res, { ok: true, config: cfg, configPath: CONFIG_PATH });
  }

  if (url === '/api/config' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body || !body.config) return jsonResponse(res, { ok: false, msg: 'Missing config' }, 400);
    body.config.schemaVersion = 1;
    try {
      writeConfig(body.config);
      return jsonResponse(res, { ok: true });
    } catch (e) {
      return jsonResponse(res, { ok: false, msg: 'Write failed: ' + e.message }, 500);
    }
  }

  // Global settings toggle(s) — merges a partial settings patch into cfg.settings.
  // Used by the header "Less Slots" checkbox; takes effect on next profile start
  // (each spawned core reads config.local.json at startup).
  if (url === '/api/settings' && req.method === 'POST') {
    const body = await parseBody(req);
    let cfg = readConfig();
    if (!cfg) {
      ensureConfig();
      cfg = readConfig();
    }
    cfg = migrateLegacyConfig(cfg);
    cfg.settings = cfg.settings || {};
    if (typeof body.preferLeastSlots === 'boolean') {
      cfg.settings.preferLeastSlots = body.preferLeastSlots;
    }
    if (typeof body.autoRotateIp === 'boolean') {
      cfg.settings.autoRotateIp = body.autoRotateIp;
    }
    if (typeof body.specialWindowOnly === 'boolean') {
      cfg.settings.specialWindowOnly = body.specialWindowOnly;
      // Live flag file — running cores check it each loop iteration.
      try {
        fs.writeFileSync(SPECIAL_WINDOW_FLAG_FILE, body.specialWindowOnly ? 'on' : 'off');
      } catch (e) {
        console.log('[main] failed to write special-window flag:', e.message);
      }
    }
    try {
      writeConfig(cfg);
      return jsonResponse(res, { ok: true, settings: cfg.settings });
    } catch (e) {
      return jsonResponse(res, { ok: false, msg: 'Write failed: ' + e.message }, 500);
    }
  }

  // Profile list / actions
  if (url === '/api/profiles' && req.method === 'GET') {
    let cfg = readConfig();
    if (!cfg) {
      ensureConfig();
      cfg = readConfig();
    }
    cfg = migrateLegacyConfig(cfg);
    const profileCount = (cfg.profiles || []).length;
    console.log('[main] /api/profiles GET returning', profileCount, 'profiles from', CONFIG_PATH);
    const enriched = (cfg.profiles || []).map((p) => ({
      ...p,
      running: runningProfiles.has(p.id),
      status: runningProfiles.get(p.id)?.status || 'Stopped',
      checkpoints: runningProfiles.get(p.id)?.checkpoints || {}
    }));
    return jsonResponse(res, {
      ok: true,
      profiles: enriched,
      settings: cfg.settings,
      meta: { configPath: CONFIG_PATH, profileCount }
    });
  }

  if (url === '/api/profiles' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body || !body.action) return jsonResponse(res, { ok: false, msg: 'Missing action' }, 400);

    let cfg = readConfig();
    if (!cfg) {
      ensureConfig();
      cfg = readConfig();
    }
    cfg = migrateLegacyConfig(cfg);

    if (body.action === 'add') {
      const newProfile = body.profile || {};
      if (!newProfile.username || !newProfile.password) {
        return jsonResponse(res, { ok: false, msg: 'Username and password are required' }, 400);
      }
      if (cfg.profiles.some((p) => p.username === newProfile.username)) {
        return jsonResponse(res, { ok: false, msg: 'Profile with this username already exists' }, 400);
      }
      const portExists = cfg.profiles.some((p) => p.chromeRemoteDebugPort === newProfile.chromeRemoteDebugPort);
      if (portExists) {
        return jsonResponse(res, { ok: false, msg: 'Remote debug port already in use by another profile' }, 400);
      }
      newProfile.id = 'p' + Date.now();
      newProfile.instanceIndex = nextInstanceIndex(cfg);
      newProfile.chromeUserDataDir = newProfile.chromeUserDataDir || getProfileDir(newProfile.instanceIndex);
      newProfile.chromeRemoteDebugPort = newProfile.chromeRemoteDebugPort || (9221 + newProfile.instanceIndex);
      cfg.profiles.push(newProfile);
      console.log('[main] adding profile', newProfile.username, 'new count:', cfg.profiles.length);
      writeConfig(cfg);
      console.log('[main] saved config for', newProfile.username, 'profiles now:', cfg.profiles.length);
      return jsonResponse(res, { ok: true, profile: newProfile });
    }

    if (body.action === 'update') {
      const idx = cfg.profiles.findIndex((p) => p.id === body.profile.id);
      if (idx === -1) return jsonResponse(res, { ok: false, msg: 'Profile not found' }, 404);
      if (!body.profile.username || !body.profile.password) {
        return jsonResponse(res, { ok: false, msg: 'Username and password are required' }, 400);
      }
      const dupUser = cfg.profiles.findIndex((p) => p.id !== body.profile.id && p.username === body.profile.username);
      if (dupUser !== -1) {
        return jsonResponse(res, { ok: false, msg: 'Another profile already uses this username' }, 400);
      }
      const dupPort = cfg.profiles.findIndex((p) => p.id !== body.profile.id && p.chromeRemoteDebugPort === body.profile.chromeRemoteDebugPort);
      if (dupPort !== -1) {
        return jsonResponse(res, { ok: false, msg: 'Another profile already uses this remote debug port' }, 400);
      }
      cfg.profiles[idx] = body.profile;
      console.log('[main] updating profile', body.profile.username, 'count:', cfg.profiles.length);
      writeConfig(cfg);
      return jsonResponse(res, { ok: true });
    }

    if (body.action === 'delete') {
      const idx = cfg.profiles.findIndex((p) => p.id === body.id);
      if (idx === -1) return jsonResponse(res, { ok: false, msg: 'Profile not found' }, 404);
      if (runningProfiles.has(body.id)) {
        return jsonResponse(res, { ok: false, msg: 'Stop the profile before deleting it' }, 400);
      }
      const deleted = cfg.profiles.splice(idx, 1)[0];
      if (body.deleteChromeDir && deleted.chromeUserDataDir && fs.existsSync(deleted.chromeUserDataDir)) {
        try { fs.rmSync(deleted.chromeUserDataDir, { recursive: true, force: true }); } catch {}
      }
      writeConfig(cfg);
      return jsonResponse(res, { ok: true });
    }

    return jsonResponse(res, { ok: false, msg: 'Unknown action' }, 400);
  }

  // Per-profile actions
  const profileMatch = url.match(/^\/api\/profiles\/([^/]+)\/(start|stop|connect-chrome|logs)$/);
  if (profileMatch && req.method === 'POST') {
    const profileId = profileMatch[1];
    const action = profileMatch[2];

    if (action === 'start') return jsonResponse(res, await startProfile(profileId));
    if (action === 'stop') return jsonResponse(res, stopProfile(profileId));
    if (action === 'connect-chrome') return jsonResponse(res, await connectChrome(profileId));
    if (action === 'logs') {
      const rec = runningProfiles.get(profileId);
      return jsonResponse(res, { ok: true, logs: rec ? rec.log : '', status: rec ? rec.status : 'Stopped' });
    }
  }

  if (url === '/api/profiles/clear-logs' && req.method === 'POST') {
    const body = await parseBody(req);
    const rec = runningProfiles.get(body.id);
    if (rec) rec.log = '';
    return jsonResponse(res, { ok: true });
  }

  // Rotate NordVPN IP (machine-wide, runs directly from main.js)
  if (url === '/api/rotate-ip' && req.method === 'POST') {
    try {
      const cfg = migrateLegacyConfig(readConfig());
      const nordvpnCfg = (cfg && cfg.settings && cfg.settings.nordvpn) || {
        exePath: 'C:\\Program Files\\NordVPN\\nordvpn.exe',
        connectTimeoutMs: 30000,
        ipCheckUrl: 'https://api.ipify.org'
      };

      // nordvpn.exe is the GUI binary — it accepts CLI args but produces NO
      // stdout, so "Connected" can never appear in output. The only reliable
      // proof of connection is the public IP actually changing. Poll the IP
      // check until it differs from BOTH the pre-rotation IP and the
      // disconnected/direct IP (otherwise "still on direct IP" looks like a
      // successful rotation).
      const waitForNewIP = async (ipCheckUrl, exclude, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 2000));
          const ip = await getPublicIP(ipCheckUrl);
          if (ip && !exclude.includes(ip)) return ip;
        }
        return null;
      };

      // Pre-flight: if the NordVPN service isn't answering (app not running /
      // service stopped), every CLI call hangs to timeout — bail out fast
      // instead of churning through 5 connect attempts.
      const preflight = await runNordVpnCommand(nordvpnCfg.exePath, ['status'], 10000);
      console.log('[rotate-ip] preflight status: ok=' + preflight.ok, preflight.output.trim().substring(0, 300));
      if (!preflight.ok || preflight.output.includes('[timeout]')) {
        return jsonResponse(res, { ok: false, msg: 'NordVPN service is not responding. Open the NordVPN app and sign in, then try again.' });
      }

      // Get current IP before rotation
      const oldIP = await getPublicIP(nordvpnCfg.ipCheckUrl);
      console.log('[rotate-ip] oldIP =', oldIP);

      // Disconnect
      const disc = await runNordVpnCommand(nordvpnCfg.exePath, ['-d'], 15000);
      console.log('[rotate-ip] disconnect:', disc.ok, disc.output.trim().substring(0, 300));

      await new Promise(r => setTimeout(r, 2000));

      // Measure the direct (disconnected) IP. Retry for ~12s — right after
      // disconnect the route can still be settling, and a null here means the
      // real IP can't be excluded during the connect poll (it would be
      // mistaken for a "new" VPN IP). If it stays null, direct traffic is
      // unreachable (kill switch) so any IP seen later must be a VPN IP.
      let directIP = null;
      for (let i = 0; i < 6 && !directIP; i += 1) {
        directIP = await getPublicIP(nordvpnCfg.ipCheckUrl);
        if (!directIP) await new Promise(r => setTimeout(r, 2000));
      }
      console.log('[rotate-ip] directIP =', directIP);
      const excludeIPs = [oldIP, directIP];

      // Try up to 5 cities walking the ordered sequence
      let newIP = null;
      const maxAttempts = 5;
      const perAttemptMs = nordvpnCfg.connectTimeoutMs || 30000;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const seqPos = rotationIndex % CITY_ROTATION_SEQUENCE.length;
        const target = CITY_ROTATION_SEQUENCE[seqPos];
        rotationIndex += 1;
        // -g accepts a city name directly (verified: `-g "Montgomery"` →
        // US/Montgomery). The positional `-c <country> <city>` form is
        // silently ignored by this CLI build — do not use it.
        const args = ['-c', '-g', target.city];
        const label = `${target.country} / ${target.city}`;
        const result = await runNordVpnCommand(nordvpnCfg.exePath, args, perAttemptMs);
        console.log(`[rotate-ip] attempt ${attempt + 1}/${maxAttempts} "${label}" (seq ${seqPos + 1}/${CITY_ROTATION_SEQUENCE.length}): cmd ok=${result.ok}`);
        if (result.ok) {
          newIP = await waitForNewIP(nordvpnCfg.ipCheckUrl, excludeIPs, perAttemptMs);
          console.log(`[rotate-ip] attempt ${attempt + 1} "${label}" IP poll: newIP=${newIP}`);
          if (newIP) {
            // Geo-verify — a silently-ignored city arg quick-connects to the
            // fastest server (wrong country). Reject on country mismatch.
            const geo = await geoLocateIp(newIP);
            console.log(`[rotate-ip] geo check: ${newIP} ->`, geo);
            if (geo && !geoCountryMatches(target.country, geo.country)) {
              console.log(`[rotate-ip] geo mismatch: expected ${target.country}, got ${geo.country} — rejecting`);
              excludeIPs.push(newIP);
              newIP = null;
              continue;
            }
            break;
          }
        }
      }

      // Fallback: country-level connect for the last-attempted sequence
      // country — NEVER bare `nordvpn -c` (Quick Connect lands on the fastest
      // server, breaking the ordered sequence).
      if (!newIP) {
        const lastIdx = (rotationIndex - 1 + CITY_ROTATION_SEQUENCE.length) % CITY_ROTATION_SEQUENCE.length;
        const fbCountry = CITY_ROTATION_SEQUENCE[lastIdx].country;
        console.log(`[rotate-ip] country-group fallback: ${fbCountry}`);
        const result = await runNordVpnCommand(nordvpnCfg.exePath, ['-c', '-g', fbCountry], perAttemptMs);
        console.log('[rotate-ip] country fallback:', result.ok, result.output.trim().substring(0, 300));
        if (result.ok) {
          newIP = await waitForNewIP(nordvpnCfg.ipCheckUrl, excludeIPs, perAttemptMs);
          if (newIP) {
            const geo = await geoLocateIp(newIP);
            console.log(`[rotate-ip] fallback geo check: ${newIP} ->`, geo);
            if (geo && !geoCountryMatches(fbCountry, geo.country)) {
              console.log(`[rotate-ip] fallback geo mismatch: expected ${fbCountry}, got ${geo.country} — rejecting`);
              newIP = null;
            }
          }
        }
      }
      console.log('[rotate-ip] final newIP =', newIP);

      // Write current IP file for UI display
      if (newIP) {
        try { fs.writeFileSync(path.join(PROJECT_ROOT, '.ivac-nordvpn-current-ip'), newIP); } catch (e) {}
      }

      return jsonResponse(res, { ok: true, ip: newIP });
    } catch (e) {
      return jsonResponse(res, { ok: false, msg: 'Rotation failed: ' + e.message });
    }
  }

  // Get current NordVPN IP
  if (url === '/api/current-ip' && req.method === 'GET') {
    const ipFile = path.join(PROJECT_ROOT, '.ivac-nordvpn-current-ip');
    try {
      if (fs.existsSync(ipFile)) {
        const ip = fs.readFileSync(ipFile, 'utf8').trim();
        return jsonResponse(res, { ok: true, ip });
      }
    } catch (e) { /* ignore */ }
    return jsonResponse(res, { ok: false, ip: null });
  }

  // ---- Slot Observations (calendar visibility log) ----
  // Returns the most recent N records from logs/slot-observations.jsonl
  // Query params: ?limit=50  (default 50, max 500)
  if (url === '/api/slot-observations' && req.method === 'GET') {
    try {
      const queryLimit = parseInt(new URL(req.url, 'http://localhost').searchParams.get('limit') || '50', 10);
      const limit = Math.min(Math.max(queryLimit || 50, 1), 500);
      const logFile = path.join(PROJECT_ROOT, 'logs', 'slot-observations.jsonl');

      if (!fs.existsSync(logFile)) {
        return jsonResponse(res, { ok: true, observations: [], count: 0, msg: 'No observations file yet.' });
      }

      // Read the file and parse lines. For large files, read the last chunk only.
      const stat = fs.statSync(logFile);
      const maxReadBytes = 512 * 1024; // read at most 512KB from the end
      let rawText;
      if (stat.size > maxReadBytes) {
        const fd = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(maxReadBytes);
        fs.readSync(fd, buf, 0, maxReadBytes, stat.size - maxReadBytes);
        fs.closeSync(fd);
        rawText = buf.toString('utf8');
        // Drop the first partial line (it may be cut mid-line)
        const firstNewline = rawText.indexOf('\n');
        if (firstNewline >= 0) rawText = rawText.slice(firstNewline + 1);
      } else {
        rawText = fs.readFileSync(logFile, 'utf8');
      }

      const lines = rawText.split('\n').filter((l) => l.trim());
      // Take the last `limit` lines, newest last — reverse for newest-first
      const recent = lines.slice(-limit).reverse();
      const observations = [];
      for (const line of recent) {
        try {
          observations.push(JSON.parse(line));
        } catch {
          // skip malformed lines
        }
      }
      return jsonResponse(res, { ok: true, observations, count: observations.length });
    } catch (err) {
      return jsonResponse(res, { ok: false, msg: 'Failed to read observations: ' + (err.message || err) }, 500);
    }
  }

  res.writeHead(404); res.end('Not found');
});

// ---- Electron window ----

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'IVAC Automation Launcher',
    autoHideMenuBar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false
    }
  });

  mainWindow.loadURL('http://127.0.0.1:' + PORT);
  // Open DevTools for debugging
  // DevTools disabled in client build
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---- Electron lifecycle ----

app.whenReady().then(async () => {
  ensureConfig();
  const storedKey = readStoredLicenseKey();
  if (storedKey) {
    const result = await validateLicenseKey(storedKey);
    if (result.status === 'terminated') {
      await selfDestruct();
      return;
    }
    if (result.valid) {
      licenseValidated = true;
      licenseClientName = result.record?.client_name || '';
    } else {
      clearStoredLicenseKey();
    }
  }

  apiServer.listen(PORT, '127.0.0.1', () => {
    console.log('IVAC API running on port ' + PORT);
    createWindow();
  });
});

app.on('window-all-closed', () => {
  stopAllProfiles();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

} // end of single-instance else block
