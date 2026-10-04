import fs from 'fs';
import path from 'path';

export type SecurityQuestionConfig = {
  question: string;
  answer: string;
};

export type NordVpnConfig = {
  exePath: string;            // e.g. 'C:\\Program Files\\NordVPN\\nordvpn.exe'
  connectTimeoutMs: number;   // default 30000
  ipCheckUrl: string;         // default 'https://api.ipify.org'
};

export type AppointmentConfig = {
  city: string | string[];
  month: string | number;
  year: number;
  startDate: string;
  endDate: string;
  preferredTime?: string | null;
};

export type AutomationConfig = {
  authUrl: string;
  scheduleUrl: string;
  username: string;
  password: string;
  securityQuestions: SecurityQuestionConfig[];
  appointment: AppointmentConfig;
  chromeExecutable: string;
  chromeUserDataDir: string;
  chromeRemoteDebugPort: number;
  maxSlotAttempts: number;
  slotRetryDelayMs: number;
  cityRetrySeconds: number;
  cloudflareWaitMs: number;
  debugNetwork: boolean;
  autoSolveCloudflare: boolean;
  headless: boolean;
  alertOnMajorEvents: boolean;
  screenshotAfterSelection: boolean;
  dryRun: boolean;
  uiApiMismatchRetries: number;
  uiApiMismatchRetryDelayMs: number;
  maxDateAttempts: number;
  preferLeastSlots: boolean;
  autoRotateIp: boolean;
  specialWindowOnly: boolean;
  nordvpn: NordVpnConfig;
};

export type ProfileConfig = {
  id: string;
  instanceIndex: number;
  username: string;
  password: string;
  securityQuestions: SecurityQuestionConfig[];
  appointment: AppointmentConfig;
  authUrl?: string;
  scheduleUrl?: string;
  chromeExecutable?: string;
  chromeUserDataDir?: string;
  chromeRemoteDebugPort?: number;
  // Optional per-profile overrides (rare, but supported)
  maxSlotAttempts?: number;
  slotRetryDelayMs?: number;
  cityRetrySeconds?: number;
  cloudflareWaitMs?: number;
  debugNetwork?: boolean;
  autoSolveCloudflare?: boolean;
  headless?: boolean;
  alertOnMajorEvents?: boolean;
  screenshotAfterSelection?: boolean;
  dryRun?: boolean;
  uiApiMismatchRetries?: number;
  uiApiMismatchRetryDelayMs?: number;
  maxDateAttempts?: number;
  preferLeastSlots?: boolean;
  autoRotateIp?: boolean;
  specialWindowOnly?: boolean;
  nordvpn?: Partial<NordVpnConfig>;
};

export type SettingsConfig = {
  authUrl: string;
  scheduleUrl: string;
  chromeExecutable: string;
  chromeUserDataDir: string;
  chromeRemoteDebugPort: number;
  maxSlotAttempts: number;
  slotRetryDelayMs: number;
  cityRetrySeconds: number;
  cloudflareWaitMs: number;
  debugNetwork: boolean;
  autoSolveCloudflare: boolean;
  headless: boolean;
  alertOnMajorEvents: boolean;
  screenshotAfterSelection: boolean;
  dryRun: boolean;
  uiApiMismatchRetries: number;
  uiApiMismatchRetryDelayMs: number;
  maxDateAttempts: number;
  preferLeastSlots: boolean;
  autoRotateIp: boolean;
  specialWindowOnly: boolean;
  nordvpn: NordVpnConfig;
};

export type MultiProfileConfig = {
  schemaVersion: number;
  settings: Partial<SettingsConfig>;
  profiles: ProfileConfig[];
};

export type LegacyConfig = AutomationConfig;

function parseCityList(value: unknown): string | string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.includes(',')) {
      const cities = trimmed
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return cities.length === 1 ? cities[0] : cities;
    }
    return trimmed;
  }

  return '';
}

function parseNumber(value: unknown, fallback: number) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function parseMonth(value: unknown): string | number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    return trimmed;
  }
  return '';
}

function parseBoolean(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (['true', '1', 'yes'].includes(lower)) return true;
    if (['false', '0', 'no'].includes(lower)) return false;
  }
  return fallback;
}

function looksLikePlaceholder(value: string) {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === '' ||
    normalized.includes('your_username') ||
    normalized.includes('your_password') ||
    normalized.includes('<tenant>') ||
    normalized.includes('...')
  );
}

function isLikelyAuthFlowUrl(value: string) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return (
      host.includes('usvisascheduling.com') ||
      host.includes('b2clogin.com') ||
      path.includes('/oauth2/') ||
      path.includes('/authorize')
    );
  } catch {
    return false;
  }
}

const configFile = path.resolve(process.cwd(), 'config.local.json');

function loadRawConfig(): unknown {
  if (!fs.existsSync(configFile)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configFile, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function isMultiProfileConfig(obj: any): obj is MultiProfileConfig {
  return obj && Array.isArray(obj.profiles);
}

export function getActiveProfileId(): string | null {
  const envId = process.env.IVAC_PROFILE_ID;
  if (envId && envId.trim()) return envId.trim();
  return null;
}

function resolveProfile(raw: unknown, profileId: string | null): { settings: Partial<SettingsConfig>; profile: ProfileConfig | null } {
  if (!raw || typeof raw !== 'object') {
    throw new Error('config.local.json is missing or could not be parsed.');
  }

  const obj = raw as any;

  if (isMultiProfileConfig(obj)) {
    const settings = (obj.settings || {}) as Partial<SettingsConfig>;
    const profiles = obj.profiles || [];

    if (profiles.length === 0) {
      throw new Error('No profiles defined in config.local.json.');
    }

    let profile: ProfileConfig | undefined;
    if (profileId) {
      profile = profiles.find((p) => p.id === profileId || p.username === profileId || String(p.instanceIndex) === profileId);
    }

    if (!profile) {
      // Fall back to first profile; warn in log if an id was requested but not found
      if (profileId) {
        console.warn(`[config] Profile '${profileId}' not found, falling back to first profile.`);
      }
      profile = profiles[0];
    }

    return { settings, profile };
  }

  // Legacy flat config: the whole object is the single profile, with global settings
  const legacy = obj as Partial<AutomationConfig>;
  const profile: ProfileConfig = {
    id: 'default',
    instanceIndex: 1,
    username: legacy.username || '',
    password: legacy.password || '',
    securityQuestions: Array.isArray(legacy.securityQuestions) ? legacy.securityQuestions : [],
    appointment: legacy.appointment || {
      city: '',
      month: '',
      year: 0,
      startDate: '',
      endDate: '',
      preferredTime: null
    },
    chromeExecutable: legacy.chromeExecutable,
    chromeUserDataDir: legacy.chromeUserDataDir,
    chromeRemoteDebugPort: legacy.chromeRemoteDebugPort
  };

  const settings: Partial<SettingsConfig> = {
    ...legacy,
    username: undefined,
    password: undefined,
    securityQuestions: undefined,
    appointment: undefined
  } as Partial<SettingsConfig>;

  return { settings, profile };
}

function mergeWithDefaults(settings: Partial<SettingsConfig>, profile: ProfileConfig): AutomationConfig {
  const env = process.env;

  const appointment: AppointmentConfig = {
    city: parseCityList(profile.appointment?.city ?? env.APPOINTMENT_CITY ?? 'Unknown City'),
    month: parseMonth(profile.appointment?.month ?? env.APPOINTMENT_MONTH ?? ''),
    year: parseNumber(profile.appointment?.year ?? env.APPOINTMENT_YEAR, 0),
    startDate:
      profile.appointment?.startDate || env.APPOINTMENT_START_DATE || '',
    endDate:
      profile.appointment?.endDate || env.APPOINTMENT_END_DATE || '',
    preferredTime:
      profile.appointment?.preferredTime ?? env.APPOINTMENT_PREFERRED_TIME ?? null
  };

  const securityQuestions = Array.isArray(profile.securityQuestions)
    ? profile.securityQuestions
    : [];

  const config: AutomationConfig = {
    authUrl: profile.authUrl ?? settings.authUrl ?? env.AUTH_URL ?? '',
    scheduleUrl:
      profile.scheduleUrl ?? settings.scheduleUrl ?? env.SCHEDULE_URL ?? 'https://www.usvisascheduling.com/en-US/ofc-schedule/',
    username: profile.username ?? env.USERNAME ?? '',
    password: profile.password ?? env.PASSWORD ?? '',
    securityQuestions,
    appointment,
    chromeExecutable:
      profile.chromeExecutable ?? settings.chromeExecutable ?? env.CHROME_EXECUTABLE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    chromeUserDataDir:
      profile.chromeUserDataDir ?? settings.chromeUserDataDir ?? env.CHROME_USER_DATA_DIR ?? path.resolve(process.cwd(), 'chrome-debug-1'),
    chromeRemoteDebugPort:
      parseNumber(profile.chromeRemoteDebugPort ?? settings.chromeRemoteDebugPort ?? env.CHROME_REMOTE_DEBUG_PORT, 9222),
    maxSlotAttempts:
      parseNumber(profile.maxSlotAttempts ?? settings.maxSlotAttempts ?? env.MAX_SLOT_ATTEMPTS, 10),
    slotRetryDelayMs:
      parseNumber(profile.slotRetryDelayMs ?? settings.slotRetryDelayMs ?? env.SLOT_RETRY_DELAY_MS, 10000),
    cityRetrySeconds:
      parseNumber(profile.cityRetrySeconds ?? settings.cityRetrySeconds ?? env.CITY_RETRY_SECONDS, 10),
    cloudflareWaitMs:
      parseNumber(profile.cloudflareWaitMs ?? settings.cloudflareWaitMs ?? env.CLOUDFLARE_WAIT_MS, 180000),
    debugNetwork:
      parseBoolean(profile.debugNetwork ?? settings.debugNetwork ?? env.DEBUG_NETWORK, false),
    autoSolveCloudflare:
      parseBoolean(profile.autoSolveCloudflare ?? settings.autoSolveCloudflare ?? env.AUTO_SOLVE_CLOUDFLARE, false),
    headless:
      parseBoolean(profile.headless ?? settings.headless ?? env.HEADLESS, false),
    alertOnMajorEvents:
      parseBoolean(profile.alertOnMajorEvents ?? settings.alertOnMajorEvents ?? env.ALERT_ON_MAJOR_EVENTS, true),
    screenshotAfterSelection:
      parseBoolean(profile.screenshotAfterSelection ?? settings.screenshotAfterSelection ?? env.SCREENSHOT_AFTER_SELECTION, true),
    dryRun:
      parseBoolean(profile.dryRun ?? settings.dryRun ?? env.DRY_RUN, true),
    uiApiMismatchRetries:
      parseNumber(profile.uiApiMismatchRetries ?? settings.uiApiMismatchRetries ?? env.UI_API_MISMATCH_RETRIES, 2),
    uiApiMismatchRetryDelayMs:
      parseNumber(profile.uiApiMismatchRetryDelayMs ?? settings.uiApiMismatchRetryDelayMs ?? env.UI_API_MISMATCH_RETRY_DELAY_MS, 1000),
    maxDateAttempts:
      parseNumber(profile.maxDateAttempts ?? settings.maxDateAttempts ?? env.MAX_DATE_ATTEMPTS, 3),
    preferLeastSlots:
      parseBoolean(profile.preferLeastSlots ?? settings.preferLeastSlots ?? env.PREFER_LEAST_SLOTS, false),
    autoRotateIp:
      parseBoolean(profile.autoRotateIp ?? settings.autoRotateIp ?? env.AUTO_ROTATE_IP, true),
    specialWindowOnly:
      parseBoolean(profile.specialWindowOnly ?? settings.specialWindowOnly ?? env.SPECIAL_WINDOW_ONLY, false),
    nordvpn: mergeNordVpnConfig(profile.nordvpn, settings.nordvpn, env)
  };

  return config;
}

function mergeNordVpnConfig(
  profileNordVpn: Partial<NordVpnConfig> | undefined,
  settingsNordVpn: NordVpnConfig | undefined,
  env: NodeJS.ProcessEnv
): NordVpnConfig {
  return {
    exePath:
      profileNordVpn?.exePath ??
      settingsNordVpn?.exePath ??
      env.NORDVPN_EXE_PATH ??
      'C:\\Program Files\\NordVPN\\nordvpn.exe',
    connectTimeoutMs:
      parseNumber(
        profileNordVpn?.connectTimeoutMs ?? settingsNordVpn?.connectTimeoutMs ?? env.NORDVPN_CONNECT_TIMEOUT_MS,
        30000
      ),
    ipCheckUrl:
      profileNordVpn?.ipCheckUrl ??
      settingsNordVpn?.ipCheckUrl ??
      'https://api.ipify.org'
  };
}

export function loadConfig(): AutomationConfig {
  const raw = loadRawConfig();
  if (!raw) {
    throw new Error('config.local.json not found. Create it from the launcher UI or manually before running the core.');
  }

  const profileId = getActiveProfileId();
  const { settings, profile } = resolveProfile(raw, profileId);

  if (!profile) {
    throw new Error('No profile resolved from config.local.json.');
  }

  const config = mergeWithDefaults(settings, profile);

  if (!config.authUrl) {
    throw new Error('Missing authUrl. Set AUTH_URL or config.local.json settings/profiles.authUrl.');
  }

  if (looksLikePlaceholder(config.authUrl) || !isLikelyAuthFlowUrl(config.authUrl)) {
    throw new Error('authUrl must be a real usvisascheduling or B2C login URL, not an example placeholder.');
  }

  if (!config.username || !config.password) {
    throw new Error('Missing credentials. Set USERNAME/PASSWORD or add a profile in config.local.json.');
  }

  if (looksLikePlaceholder(config.username) || looksLikePlaceholder(config.password)) {
    throw new Error('username/password in config.local.json still use placeholder values. Replace them with real credentials.');
  }

  const appointmentCity = config.appointment.city;
  if (Array.isArray(appointmentCity)) {
    if (appointmentCity.length === 0) {
      throw new Error('Missing appointment.city. Set APPOINTMENT_CITY or config.local.json.');
    }
  } else if (!appointmentCity) {
    throw new Error('Missing appointment.city. Set APPOINTMENT_CITY or config.local.json.');
  }

  if (!config.appointment.startDate || !config.appointment.endDate) {
    throw new Error('Missing appointment date range. Set APPOINTMENT_START_DATE and APPOINTMENT_END_DATE.');
  }

  if (new Date(config.appointment.startDate) > new Date(config.appointment.endDate)) {
    throw new Error('Appointment startDate must be earlier than or equal to endDate.');
  }

  const monthValue = config.appointment.month;
  const validShortMonths = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  if (typeof monthValue === 'number') {
    if (monthValue < 1 || monthValue > 12) {
      throw new Error('Appointment month must be between 1 and 12.');
    }
  } else if (typeof monthValue === 'string') {
    if (!validShortMonths.includes(monthValue.toLowerCase())) {
      throw new Error('Appointment month must be a number or short month name like Jan, Feb, Mar.');
    }
  } else {
    throw new Error('Appointment month must be a number or string short month name.');
  }

  if (config.appointment.year < 2000) {
    throw new Error('Appointment year must be a valid four-digit year.');
  }

  return config;
}
