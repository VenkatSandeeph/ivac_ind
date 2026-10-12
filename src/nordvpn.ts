import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { spawn } from 'child_process';
import { info, warn, client } from './logger';

export type NordVpnConfig = {
  exePath: string;
  connectTimeoutMs: number;   // default 30000
  ipCheckUrl: string;         // default 'https://api.ipify.org'
};

// ── File-based lock + cooldown (shared across all ivac-core processes) ──
const LOCK_FILE = path.resolve(process.cwd(), '.ivac-nordvpn.lock');
const COOLDOWN_FILE = path.resolve(process.cwd(), '.ivac-nordvpn-cooldown');
const CURRENT_IP_FILE = path.resolve(process.cwd(), '.ivac-nordvpn-current-ip');
const RECENT_FILE = path.resolve(process.cwd(), '.ivac-nordvpn-recent');
const CITY_POOL_FILE = path.resolve(process.cwd(), 'nordvpn-cities.json');
const COOLDOWN_MS = 2 * 60 * 1000;   // 2 minutes
const LOCK_STALE_MS = 60 * 1000;     // 60 seconds — break stale locks (heartbeats keep live locks fresh)
const RECENT_MAX = 10;               // shared cross-process "recently attempted" cities
const HUB_WEIGHT = 0.7;              // ~70% of picks come from the low-latency hub pool

/**
 * NordVPN CLI-based IP rotation (machine-wide).
 *
 * All running ivac-core profiles share ONE NordVPN IP. Rotation disconnects
 * and reconnects NordVPN via the CLI, giving a new IP. A file lock prevents
 * concurrent rotations across processes, and a 2-min cooldown prevents
 * cascading rotations from stale block signals.
 *
 * NEVER throws — always resolves with { rotated: boolean }.
 */

/** Run a NordVPN CLI command and return its stdout+stderr output. */
function runNordVpnCommand(exePath: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const done = (result: { ok: boolean; output: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const child = spawn(exePath, args, {
        cwd: path.dirname(exePath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        done({ ok: false, output: output + ' [timeout]' });
      }, timeoutMs);

      child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });

      child.on('close', (code) => {
        clearTimeout(timer);
        done({ ok: code === 0, output });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        done({ ok: false, output: err.message });
      });
    } catch (err) {
      done({ ok: false, output: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Quick check that the NordVPN service is answering CLI commands. */
export async function isNordVpnResponsive(exePath: string): Promise<boolean> {
  const result = await runNordVpnCommand(exePath, ['status'], 10000);
  return result.ok && !result.output.includes('[timeout]');
}

/** Disconnect NordVPN. */
export async function disconnectNordVpn(exePath: string): Promise<boolean> {
  info('[NORDVPN] Disconnecting...');
  const result = await runNordVpnCommand(exePath, ['-d'], 15000);
  info(`[NORDVPN] Disconnect result: ok=${result.ok} output="${result.output.trim().substring(0, 200)}"`);
  return result.ok;
}

/**
 * Poll the public IP until it differs from every value in `exclude`
 * (the pre-rotation IP AND the disconnected/direct IP) or timeout.
 *
 * NOTE: On this NordVPN build (8.x), nordvpn.exe is the GUI binary — it
 * accepts CLI args but produces NO stdout, and `nordvpn status` output is
 * empty. Exit code is the only command-level signal; the public IP change
 * is the only reliable proof that a connection actually came up.
 */
async function waitForNewPublicIP(
  ipCheckUrl: string,
  exclude: Array<string | null>,
  timeoutMs: number,
  isAborted?: () => boolean
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAborted && isAborted()) return null;
    await new Promise((r) => setTimeout(r, 2000));
    const ip = await getCurrentPublicIP(ipCheckUrl).catch(() => null);
    if (ip && !exclude.includes(ip)) return ip;
  }
  return null;
}

/**
 * Geolocate a public IP via ip-api.com (free tier is HTTP-only).
 * The lookup goes through the VPN tunnel, so it reports the VPN exit's geo.
 * Returns { country, city } or null when the lookup fails.
 */
function geolocateIp(ip: string): Promise<{ country: string; city: string } | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://ip-api.com/json/${ip}?fields=status,country,city`, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString(); });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j && j.status === 'success'
            ? { country: String(j.country || ''), city: String(j.city || '') }
            : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

// Geo providers disagree on names (e.g. "Czechia" vs "Czech Republic",
// "Laos" vs "Lao People's Democratic Republic") — normalize the ones in
// the rotation pool whose ip-api name can diverge.
const COUNTRY_ALIASES: Record<string, string[]> = {
  'united states': ['united states', 'united states of america', 'usa'],
  'united kingdom': ['united kingdom', 'great britain', 'uk', 'england'],
  'czech republic': ['czech republic', 'czechia'],
  'south korea': ['south korea', 'korea', 'korea, republic of'],
  'vietnam': ['vietnam', 'viet nam'],
  'myanmar': ['myanmar', 'burma'],
  'lao people\'s democratic republic': ['lao peoples democratic republic', 'laos', 'lao pdr'],
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

function countryMatches(expected: string, geoCountry: string): boolean {
  const g = geoCountry.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  if (!g || !e) return false;
  return g === e || (COUNTRY_ALIASES[e] || []).includes(g);
}

/**
 * Connect NordVPN (country+city target, or country group fallback) and verify
 * by polling the public IP, then GEOLOCATING the new exit — nordvpn.exe
 * produces no stdout, so an ignored/misparsed target arg silently
 * quick-connects to the fastest server (wrong country). A geo country
 * mismatch rejects the connection (returns null → caller tries next city).
 *
 * City connect uses the -g group form: nordvpn -c -g "<city>" — city names are
 * valid groups on this build (verified: `-g "Montgomery"` → US/Montgomery).
 * The documented positional `-c <country> <city>` form is silently IGNORED by
 * this GUI-wrapped CLI (quick-connects to fastest/India) — do not use it.
 */
export async function connectNordVpn(
  exePath: string,
  ipCheckUrl: string,
  timeoutMs: number,
  isAborted?: () => boolean,
  target?: { country: string; city?: string },
  excludeIPs: Array<string | null> = []
): Promise<string | null> {
  const label = target
    ? (target.city ? `${target.country} / ${target.city}` : target.country)
    : 'Quick Connect';
  info(`[NORDVPN] Connecting to ${label}...`);
  // -g accepts a country OR a city name (display form, spaces OK).
  const args = target ? ['-c', '-g', target.city || target.country] : ['-c'];
  const result = await runNordVpnCommand(exePath, args, timeoutMs);
  info(`[NORDVPN] Connect command: ok=${result.ok} output="${result.output.trim().substring(0, 200)}"`);
  if (!result.ok) {
    warn('[NORDVPN] Connect command failed or timed out.');
    return null;
  }
  // Command exits immediately — connection establishes asynchronously.
  const newIp = await waitForNewPublicIP(ipCheckUrl, excludeIPs, timeoutMs, isAborted);
  if (!newIp) return null;

  if (target?.country) {
    const geo = await geolocateIp(newIp);
    if (geo) {
      info(`[NORDVPN] Geo check: ${newIp} → ${geo.city || '?'}, ${geo.country || '?'}`);
      if (!countryMatches(target.country, geo.country)) {
        warn(`[NORDVPN] Geo mismatch — target was ${target.country}, exit is ${geo.country}. Rejecting connection.`);
        excludeIPs.push(newIp);   // don't accept this IP on a later poll either
        return null;
      }
      if (target.city && geo.city &&
        geo.city.trim().toLowerCase() !== target.city.trim().toLowerCase()) {
        warn(`[NORDVPN] Geo city "${geo.city}" differs from target "${target.city}" — accepting (same country; geo city naming is approximate).`);
      }
    } else {
      warn('[NORDVPN] Geo lookup failed — accepting new IP without country verification.');
    }
  }
  return newIp;
}

/** Fetch the current public IP via an IP-check endpoint. */
export async function getCurrentPublicIP(ipCheckUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(ipCheckUrl, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString(); });
      res.on('end', () => resolve(body.trim() || null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}

/** Check if the cooldown is still active (another rotation happened recently). */
export function isCooldownActive(): boolean {
  try {
    if (!fs.existsSync(COOLDOWN_FILE)) return false;
    const ts = parseInt(fs.readFileSync(COOLDOWN_FILE, 'utf8').trim(), 10);
    if (!Number.isFinite(ts)) return false;
    return Date.now() < ts;
  } catch {
    return false;
  }
}

/** Check if another process holds the rotation lock. */
export function isRotationLocked(): boolean {
  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    const stats = fs.statSync(LOCK_FILE);
    return (Date.now() - stats.mtimeMs) < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * True when .ivac-nordvpn-current-ip was rewritten after `ts` — i.e. another
 * ivac-core process completed a rotation during our strike ladder. Callers
 * use this to skip their own rotation: the shared IP already changed.
 */
export function ipRotatedSince(ts: number): boolean {
  try {
    if (!fs.existsSync(CURRENT_IP_FILE)) return false;
    return fs.statSync(CURRENT_IP_FILE).mtimeMs > ts;
  } catch {
    return false;
  }
}

/** Try to acquire the rotation lock using exclusive-create. Returns true if acquired. */
function acquireLock(): boolean {
  try {
    // Exclusive create — fails if file already exists
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(fd, String(Date.now()));
    fs.closeSync(fd);
    return true;
  } catch (err: any) {
    // Lock exists — check if stale, break it, and retry once
    try {
      const stats = fs.statSync(LOCK_FILE);
      if ((Date.now() - stats.mtimeMs) >= LOCK_STALE_MS) {
        info('[NORDVPN] Breaking stale lock file.');
        fs.unlinkSync(LOCK_FILE);
        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeFileSync(fd, String(Date.now()));
        fs.closeSync(fd);
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }
}

/** Release the rotation lock. */
function releaseLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

/** Write the cooldown timestamp (now + 2 min). */
function writeCooldown(): void {
  try {
    fs.writeFileSync(COOLDOWN_FILE, String(Date.now() + COOLDOWN_MS));
  } catch { /* ignore */ }
}

// Fallback pool — used only when nordvpn-cities.json is missing/unreadable
// (e.g. packaged build without the file). Treats the old sequence as one
// flat hub pool.
const FALLBACK_CITIES: Array<{ country: string; city: string }> = [
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
].map((city) => ({ country: 'United States', city }));

type CityTarget = { country: string; city: string };
type CityPool = { hubs: CityTarget[]; rest: CityTarget[] };

// undefined = not loaded yet; null = file missing/broken (fallback active).
let cityPool: CityPool | null | undefined;
// Per-process shuffle bags — each entry is consumed once, then the bag is
// reshuffled. Random-looking order, guaranteed coverage, no back-to-back
// repeats within a process.
let hubBag: CityTarget[] = [];
let restBag: CityTarget[] = [];

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function loadCityPool(): CityPool {
  if (cityPool !== undefined) return cityPool || { hubs: FALLBACK_CITIES, rest: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(CITY_POOL_FILE, 'utf8'));
    const valid = (e: any): e is CityTarget =>
      !!e && typeof e.country === 'string' && typeof e.city === 'string';
    const hubs = (Array.isArray(raw.hubs) ? raw.hubs : []).filter(valid);
    const rest = (Array.isArray(raw.rest) ? raw.rest : []).filter(valid);
    cityPool = (hubs.length + rest.length) > 0 ? { hubs, rest } : null;
    if (cityPool) {
      info(`[NORDVPN] City pool loaded from nordvpn-cities.json: ${hubs.length} hubs, ${rest.length} other.`);
    }
  } catch (err) {
    cityPool = null;
    warn(`[NORDVPN] nordvpn-cities.json unreadable (${err instanceof Error ? err.message : String(err)}) — using built-in fallback pool.`);
  }
  return cityPool || { hubs: FALLBACK_CITIES, rest: [] };
}

/** Read the shared recently-attempted cities (last RECENT_MAX, all profiles). */
function readRecentCities(): Set<string> {
  try {
    const arr = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map((e: any) => `${e.country}|${e.city}`));
  } catch {
    return new Set();
  }
}

/** Record an attempted city so other profiles don't re-pick it right away. */
function pushRecentCity(t: CityTarget): void {
  try {
    let arr: CityTarget[] = [];
    try { arr = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8')); } catch { /* fresh */ }
    if (!Array.isArray(arr)) arr = [];
    arr.unshift({ country: t.country, city: t.city });
    fs.writeFileSync(RECENT_FILE, JSON.stringify(arr.slice(0, RECENT_MAX)));
  } catch { /* best-effort */ }
}

/**
 * Pick the next rotation target: ~70% from the hub pool, ~30% from rest,
 * each via a per-process shuffle bag (no repeats until the bag drains).
 * Cities in the shared recent list are skipped while alternatives exist.
 */
function pickCityTarget(recent: Set<string>): CityTarget {
  const pool = loadCityPool();
  if (!hubBag.length) hubBag = shuffle(pool.hubs);
  if (!restBag.length) restBag = shuffle(pool.rest);
  const preferHub = Math.random() < HUB_WEIGHT;
  const bag = preferHub
    ? (hubBag.length ? hubBag : restBag)
    : (restBag.length ? restBag : hubBag);
  let idx = bag.findIndex((t) => !recent.has(`${t.country}|${t.city}`));
  if (idx === -1) idx = 0;   // whole bag recently used — take the top anyway
  return bag.splice(idx, 1)[0];
}

/**
 * Main rotation function -- called by cores on block triggers.
 *
 * Flow:
 * 1. Check cooldown -- skip if active
 * 2. Lock held? Wait up to 45s for the other rotation; reuse its new IP if one lands
 * 3. Acquire lock, heartbeat it every 10s while rotating
 * 4. Get current IP, disconnect NordVPN, measure direct IP
 * 5. Try up to 5 random picks from nordvpn-cities.json (nordvpn -c -g <city>)
 * 6. If all city attempts fail, fall back to the last attempted country group
 * 7. Get new IP
 * 8. Write current IP file
 * 9. Write cooldown
 * 10. Release lock
 *
 * NEVER throws. Always writes cooldown (even on failure) to prevent rapid retry loops.
 */
export async function rotateNordVpn(config: NordVpnConfig, isAborted?: () => boolean, force: boolean = false, reason?: string): Promise<{ ip: string | null; rotated: boolean }> {
  // 1. Cooldown check (skip when force is true, e.g. two-strike 403/429)
  if (!force && isCooldownActive()) {
    info(`[NORDVPN] Cooldown active — skipping rotation${reason ? ` (requested: ${reason})` : ''}.`);
    return { ip: null, rotated: false };
  }

  // 2. Lock check — another process may already be rotating the shared IP.
  // Wait a bounded time for it instead of skipping blind: when it finishes,
  // .ivac-nordvpn-current-ip updates and the new IP works for us too.
  if (isRotationLocked()) {
    info(`[NORDVPN] Rotation in progress elsewhere — waiting up to 45s for it to finish${reason ? ` (requested: ${reason})` : ''}.`);
    const waitStart = Date.now();
    const deadline = waitStart + 45000;
    while (isRotationLocked() && Date.now() < deadline && !(isAborted && isAborted())) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (ipRotatedSince(waitStart)) {
      info('[NORDVPN] Shared IP was rotated by another process — reusing it, no rotation needed.');
      return { ip: null, rotated: false };
    }
    if (isRotationLocked()) {
      info('[NORDVPN] Lock still held after waiting — skipping this rotation.');
      return { ip: null, rotated: false };
    }
    // Lock released with no completed rotation (failed or aborted attempt)
    // — proceed and try our own below.
    info('[NORDVPN] Lock released without a completed rotation — proceeding.');
  }

  if (!acquireLock()) {
    info(`[NORDVPN] Could not acquire lock — another process may be rotating${reason ? ` (requested: ${reason})` : ''}.`);
    return { ip: null, rotated: false };
  }

  // Heartbeat: a real rotation takes 2-4 min (5 city attempts × ~68s), far
  // past the 60s stale window — touch the lock every 10s so a live rotation
  // is never mistaken for a dead one and broken into.
  const heartbeat = setInterval(() => {
    try { fs.utimesSync(LOCK_FILE, new Date(), new Date()); } catch { /* ignore */ }
  }, 10000);

  try {
    // Log the root cause in BOTH client and dev logs — rotation reason is the
    // key diagnostic for "why did my IP just change".
    if (reason) {
      client('🔄', `Rotating IP — ${reason}`);
      info(`[NORDVPN] Rotation reason: ${reason}`);
    }
    // 3. Pre-flight: if the NordVPN service isn't answering CLI commands
    // (app not running / service stopped / wedged mid-operation), every
    // -d/-c/status call hangs to timeout — that's ~4 minutes of churn per
    // rotation and the reason rotation appears to run "continuously".
    if (!(await isNordVpnResponsive(config.exePath))) {
      warn('[NORDVPN] CLI not responding (service down or app not running) — skipping rotation.');
      return { ip: null, rotated: false };
    }

    // 4. Get current IP
    const oldIP = await getCurrentPublicIP(config.ipCheckUrl).catch(() => null);
    info(`[NORDVPN] Current IP before rotation: ${oldIP || 'unknown'}`);

    // 4. Disconnect
    await disconnectNordVpn(config.exePath);
    await new Promise((r) => setTimeout(r, 2000));

    if (isAborted && isAborted()) {
      info('[NORDVPN] Abort signal detected after disconnect; releasing lock.');
      return { ip: null, rotated: false };
    }

    // Measure the disconnected (direct) IP. After a failed connect the machine
    // sits on this IP, so a successful rotation must differ from BOTH this
    // and the pre-rotation oldIP — otherwise we'd mistake "still on direct"
    // for a successful VPN connection. Retry for ~12s: a null here (transient
    // ipify failure while the route settles) means the real IP can't be
    // excluded during the connect poll and would look like a "new" IP. If it
    // stays null, direct traffic is unreachable (kill switch) and any IP seen
    // later must be a VPN IP.
    let directIP: string | null = null;
    for (let i = 0; i < 6 && !directIP; i += 1) {
      directIP = await getCurrentPublicIP(config.ipCheckUrl).catch(() => null);
      if (!directIP) await new Promise((r) => setTimeout(r, 2000));
    }
    const excludeIPs: Array<string | null> = [oldIP, directIP];

    // 5. Try up to 5 random picks from the city pool (weighted: hubs ~70%),
    // skipping cities other profiles just attempted.
    let connected = false;
    let newIP: string | null = null;
    const maxCityAttempts = 5;
    const recent = readRecentCities();
    let lastTarget: CityTarget | null = null;

    for (let attempt = 0; attempt < maxCityAttempts; attempt += 1) {
      if (isAborted && isAborted()) {
        info('[NORDVPN] Abort signal detected during rotation; releasing lock.');
        return { ip: null, rotated: false };
      }

      const target = pickCityTarget(recent);
      lastTarget = target;
      pushRecentCity(target);
      recent.add(`${target.country}|${target.city}`);

      info(`[NORDVPN] Rotation attempt ${attempt + 1}/${maxCityAttempts}: ${target.country} / ${target.city}`);
      newIP = await connectNordVpn(config.exePath, config.ipCheckUrl, config.connectTimeoutMs, isAborted, target, excludeIPs);

      if (newIP) {
        connected = true;
        info(`[NORDVPN] Connected to ${target.country} / ${target.city}. New IP: ${newIP}`);
        break;
      }
      warn(`[NORDVPN] Connect to ${target.country} / ${target.city} produced no new IP. Trying another city...`);
    }

    // 6. Fallback: country-level connect for the last-attempted country —
    // NEVER bare `nordvpn -c` (Quick Connect lands on the fastest server,
    // typically India, with no country control).
    if (!connected && lastTarget) {
      const fallbackCountry = lastTarget.country;
      info(`[NORDVPN] City connects failed — country-group fallback: ${fallbackCountry}`);
      newIP = await connectNordVpn(config.exePath, config.ipCheckUrl, config.connectTimeoutMs, isAborted, { country: fallbackCountry }, excludeIPs);
      connected = !!newIP;
    }

    if (isAborted && isAborted()) {
      info('[NORDVPN] Abort signal detected after connect; releasing lock.');
      return { ip: null, rotated: false };
    }

    // 8. Write current IP file
    if (newIP) {
      try { fs.writeFileSync(CURRENT_IP_FILE, newIP); } catch { /* ignore */ }
      info(`[NORDVPN] Rotation complete. New IP: ${newIP} (connected=${connected})`);
    } else {
      warn('[NORDVPN] Rotation completed but could not verify new IP.');
    }

    return { ip: newIP, rotated: connected };
  } catch (err) {
    warn('[NORDVPN] Rotation failed:', err instanceof Error ? err.message : String(err));
    return { ip: null, rotated: false };
  } finally {
    clearInterval(heartbeat);
    // 9. Always write cooldown (prevents rapid retry loops even on failure)
    writeCooldown();
    // 10. Release lock
    releaseLock();
  }
}
