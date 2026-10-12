'use strict';
/**
 * NordVPN machine-wide rotation for the Electron UI — CommonJS port of
 * src/nordvpn.ts. Shares the same lock / cooldown / current-ip / recent
 * files as the ivac-core processes, so a manual Rotate IP and a running
 * profile can never rotate concurrently.
 *
 * Picks are random from nordvpn-cities.json (weighted: ~70% low-latency
 * hubs) via a per-process shuffle bag, and the shared recent file keeps
 * multiple processes from re-attempting the same cities.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const COOLDOWN_MS = 2 * 60 * 1000;
const LOCK_STALE_MS = 60 * 1000;
const RECENT_MAX = 10;
const HUB_WEIGHT = 0.7;

function files(root) {
  return {
    lock: path.join(root, '.ivac-nordvpn.lock'),
    cooldown: path.join(root, '.ivac-nordvpn-cooldown'),
    currentIp: path.join(root, '.ivac-nordvpn-current-ip'),
    recent: path.join(root, '.ivac-nordvpn-recent'),
    pool: path.join(root, 'nordvpn-cities.json')
  };
}

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

// Geolocate via ip-api.com (free tier is HTTP-only; the lookup goes through
// the VPN so it reports the exit's geo). Returns {country, city} or null.
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

// Same alias map as src/nordvpn.ts — keep in sync.
const GEO_COUNTRY_ALIASES = {
  'united states': ['united states', 'united states of america', 'usa'],
  'united kingdom': ['united kingdom', 'great britain', 'uk', 'england'],
  'czech republic': ['czech republic', 'czechia'],
  'south korea': ['south korea', 'korea', 'korea, republic of'],
  'vietnam': ['vietnam', 'viet nam'],
  'myanmar': ['myanmar', 'burma'],
  "lao people's democratic republic": ['lao peoples democratic republic', 'laos', 'lao pdr'],
  'libyan arab jamahiriya': ['libyan arab jamahiriya', 'libya'],
  'brunei darussalam': ['brunei darussalam', 'brunei'],
  'cape verde': ['cape verde', 'cabo verde'],
  'turkey': ['turkey', 'turkiye', 'türkiye'],
  'north macedonia': ['north macedonia', 'macedonia'],
  'bosnia and herzegovina': ['bosnia and herzegovina', 'bosnia'],
  'united arab emirates': ['united arab emirates', 'uae'],
  'tanzania': ['tanzania', 'united republic of tanzania'],
  'venezuela': ['venezuela', 'bolivarian republic of venezuela'],
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

// ── shared-file helpers (same semantics as src/nordvpn.ts) ──

function isRotationLocked(root) {
  try {
    const stats = fs.statSync(files(root).lock);
    return (Date.now() - stats.mtimeMs) < LOCK_STALE_MS;
  } catch (e) {
    return false;
  }
}

function acquireLock(root) {
  const lockFile = files(root).lock;
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd, String(Date.now()));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    try {
      const stats = fs.statSync(lockFile);
      if ((Date.now() - stats.mtimeMs) >= LOCK_STALE_MS) {
        fs.unlinkSync(lockFile);
        const fd = fs.openSync(lockFile, 'wx');
        fs.writeFileSync(fd, String(Date.now()));
        fs.closeSync(fd);
        return true;
      }
    } catch (e2) {}
    return false;
  }
}

function releaseLock(root) {
  try { fs.unlinkSync(files(root).lock); } catch (e) {}
}

function writeCooldown(root) {
  try { fs.writeFileSync(files(root).cooldown, String(Date.now() + COOLDOWN_MS)); } catch (e) {}
}

function currentIpMtime(root) {
  try { return fs.statSync(files(root).currentIp).mtimeMs; } catch (e) { return 0; }
}

// ── city pool + weighted random picks ──

let cityPool;      // undefined = not loaded; null = fallback
let hubBag = [];
let restBag = [];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function loadCityPool(root) {
  if (cityPool !== undefined) return cityPool;
  try {
    const raw = JSON.parse(fs.readFileSync(files(root).pool, 'utf8'));
    const valid = (e) => e && typeof e.country === 'string' && typeof e.city === 'string';
    const hubs = (Array.isArray(raw.hubs) ? raw.hubs : []).filter(valid);
    const rest = (Array.isArray(raw.rest) ? raw.rest : []).filter(valid);
    cityPool = (hubs.length + rest.length) > 0 ? { hubs, rest } : null;
  } catch (e) {
    cityPool = null;
  }
  return cityPool;
}

function readRecentCities(root) {
  try {
    const arr = JSON.parse(fs.readFileSync(files(root).recent, 'utf8'));
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map((e) => `${e.country}|${e.city}`));
  } catch (e) {
    return new Set();
  }
}

function pushRecentCity(root, t) {
  try {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(files(root).recent, 'utf8')); } catch (e) {}
    if (!Array.isArray(arr)) arr = [];
    arr.unshift({ country: t.country, city: t.city });
    fs.writeFileSync(files(root).recent, JSON.stringify(arr.slice(0, RECENT_MAX)));
  } catch (e) {}
}

function pickCityTarget(root, recent) {
  const pool = loadCityPool(root);
  if (!pool) return null;
  if (!hubBag.length) hubBag = shuffle(pool.hubs);
  if (!restBag.length) restBag = shuffle(pool.rest);
  const preferHub = Math.random() < HUB_WEIGHT;
  const bag = preferHub ? (hubBag.length ? hubBag : restBag) : (restBag.length ? restBag : hubBag);
  if (!bag.length) return null;
  let idx = bag.findIndex((t) => !recent.has(`${t.country}|${t.city}`));
  if (idx === -1) idx = 0;
  return bag.splice(idx, 1)[0];
}

/**
 * If a lock is currently held, wait up to `timeoutMs` for the other process's
 * rotation to finish. Returns { completed, ip } — completed=true means the
 * shared IP was rotated during the wait (caller should reuse it, not rotate).
 */
async function awaitSharedRotation(root, timeoutMs) {
  if (!isRotationLocked(root)) return { completed: false, ip: null };
  const waitStart = Date.now();
  const deadline = waitStart + (timeoutMs || 60000);
  while (isRotationLocked(root) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (currentIpMtime(root) > waitStart) {
    return { completed: true, ip: await getPublicIP() };
  }
  return { completed: false, ip: null };
}

/**
 * Manual rotation entry point (UI Rotate IP button). Never throws.
 * Returns { ok, ip, msg }. No cooldown gate — a manual click is user intent —
 * but the lock is honored and the cooldown IS written so cores back off
 * after the manual rotation.
 */
async function rotateNordVpn({ root, exePath, ipCheckUrl, connectTimeoutMs }) {
  const perAttemptMs = connectTimeoutMs || 30000;
  const checkUrl = ipCheckUrl || 'https://api.ipify.org';

  // Another process may already be mid-rotation — wait briefly and reuse
  // its result rather than colliding on the same tunnel.
  const shared = await awaitSharedRotation(root, 60000);
  if (shared.completed) {
    return { ok: true, ip: shared.ip, msg: 'IP already rotated by a running profile — reusing it.' };
  }
  if (isRotationLocked(root)) {
    return { ok: false, msg: 'A rotation is still in progress — try again shortly.' };
  }
  if (!acquireLock(root)) {
    return { ok: false, msg: 'Could not acquire rotation lock — another process may be rotating.' };
  }

  const heartbeat = setInterval(() => {
    try { fs.utimesSync(files(root).lock, new Date(), new Date()); } catch (e) {}
  }, 10000);

  try {
    // Pre-flight: a dead NordVPN service makes every CLI call hang.
    const preflight = await runNordVpnCommand(exePath, ['status'], 10000);
    if (!preflight.ok || preflight.output.includes('[timeout]')) {
      return { ok: false, msg: 'NordVPN service is not responding. Open the NordVPN app and sign in, then try again.' };
    }

    const oldIP = await getPublicIP(checkUrl);
    console.log('[rotate-ip] oldIP =', oldIP);

    const disc = await runNordVpnCommand(exePath, ['-d'], 15000);
    console.log('[rotate-ip] disconnect:', disc.ok, disc.output.trim().substring(0, 300));
    await new Promise((r) => setTimeout(r, 2000));

    // Measure the direct (disconnected) IP — a "new" IP must differ from
    // both old and direct or it isn't a VPN connection at all.
    let directIP = null;
    for (let i = 0; i < 6 && !directIP; i += 1) {
      directIP = await getPublicIP(checkUrl);
      if (!directIP) await new Promise((r) => setTimeout(r, 2000));
    }
    console.log('[rotate-ip] directIP =', directIP);
    const excludeIPs = [oldIP, directIP];

    const waitForNewIP = async (exclude, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const ip = await getPublicIP(checkUrl);
        if (ip && !exclude.includes(ip)) return ip;
      }
      return null;
    };

    // Up to 5 random picks from the shared pool (weighted: hubs ~70%).
    let newIP = null;
    const recent = readRecentCities(root);
    let lastTarget = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const target = pickCityTarget(root, recent);
      if (!target) break;
      lastTarget = target;
      pushRecentCity(root, target);
      recent.add(`${target.country}|${target.city}`);
      const label = `${target.country} / ${target.city}`;
      // -g accepts a city name directly; the positional -c <country> <city>
      // form is silently ignored by this GUI-wrapped CLI — do not use it.
      const result = await runNordVpnCommand(exePath, ['-c', '-g', target.city], perAttemptMs);
      console.log(`[rotate-ip] attempt ${attempt + 1}/5 "${label}": cmd ok=${result.ok}`);
      if (!result.ok) continue;
      newIP = await waitForNewIP(excludeIPs, perAttemptMs);
      console.log(`[rotate-ip] attempt ${attempt + 1} "${label}" IP poll: newIP=${newIP}`);
      if (newIP) {
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

    // Fallback: country-level connect for the last-attempted country —
    // never bare `nordvpn -c` (Quick Connect ignores the curated pool).
    if (!newIP && lastTarget) {
      const fbCountry = lastTarget.country;
      console.log(`[rotate-ip] country-group fallback: ${fbCountry}`);
      const result = await runNordVpnCommand(exePath, ['-c', '-g', fbCountry], perAttemptMs);
      if (result.ok) {
        newIP = await waitForNewIP(excludeIPs, perAttemptMs);
        if (newIP) {
          const geo = await geoLocateIp(newIP);
          if (geo && !geoCountryMatches(fbCountry, geo.country)) {
            console.log(`[rotate-ip] fallback geo mismatch: expected ${fbCountry}, got ${geo.country} — rejecting`);
            newIP = null;
          }
        }
      }
    }
    console.log('[rotate-ip] final newIP =', newIP);

    if (newIP) {
      try { fs.writeFileSync(files(root).currentIp, newIP); } catch (e) {}
      return { ok: true, ip: newIP, msg: `Rotated to ${newIP}.` };
    }
    return { ok: false, ip: null, msg: 'Rotation attempted but no new IP could be verified — see log.' };
  } catch (e) {
    return { ok: false, msg: 'Rotation failed: ' + e.message };
  } finally {
    clearInterval(heartbeat);
    // Always write cooldown so cores back off after a manual rotation, and
    // release the lock either way.
    writeCooldown(root);
    releaseLock(root);
  }
}

module.exports = { rotateNordVpn, awaitSharedRotation, isRotationLocked, getPublicIP };
