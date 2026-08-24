import fs from 'fs';
import path from 'path';

export type SecurityQuestionConfig = {
  question: string;
  answer: string;
};

export type AppointmentConfig = {
  city: string | string[];
  month: string | number;
  year: number;
  startDate: string;
  endDate: string;
  preferredTime?: string | null;
};

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
  cityRetrySeconds?: number;
  cloudflareWaitMs: number;
  debugNetwork: boolean;
  autoSolveCloudflare: boolean;
  headless: boolean;
  alertOnMajorEvents: boolean;
  screenshotAfterSelection: boolean;
};

const configFile = path.resolve(process.cwd(), 'config.local.json');

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

function loadLocalConfig(): Partial<AutomationConfig> {
  if (!fs.existsSync(configFile)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configFile, 'utf8');
    return JSON.parse(content) as Partial<AutomationConfig>;
  } catch {
    return {};
  }
}

export function loadConfig(): AutomationConfig {
  const local = loadLocalConfig();

  const env = process.env;

  const appointment: AppointmentConfig = {
    city: parseCityList(local.appointment?.city ?? env.APPOINTMENT_CITY ?? 'Unknown City'),
    month: parseMonth(local.appointment?.month ?? env.APPOINTMENT_MONTH),
    year: parseNumber(local.appointment?.year ?? env.APPOINTMENT_YEAR, 0),
    startDate:
      local.appointment?.startDate || env.APPOINTMENT_START_DATE || '',
    endDate:
      local.appointment?.endDate || env.APPOINTMENT_END_DATE || '',
    preferredTime:
      local.appointment?.preferredTime ?? env.APPOINTMENT_PREFERRED_TIME ?? null
  };

  let parsedSecurityQuestions: SecurityQuestionConfig[] = [];
  if (Array.isArray(local.securityQuestions)) {
    parsedSecurityQuestions = local.securityQuestions;
  } else if (env.SECURITY_QUESTIONS) {
    try {
      const candidate = JSON.parse(env.SECURITY_QUESTIONS);
      if (Array.isArray(candidate)) {
        parsedSecurityQuestions = candidate;
      }
    } catch {
      parsedSecurityQuestions = [];
    }
  }

  const config: AutomationConfig = {
    authUrl: local.authUrl || env.AUTH_URL || '',
    scheduleUrl:
      local.scheduleUrl || env.SCHEDULE_URL || 'https://www.usvisascheduling.com/en-US/ofc-schedule/',
    username: local.username || env.USERNAME || '',
    password: local.password || env.PASSWORD || '',
    securityQuestions: parsedSecurityQuestions,
    appointment,
    chromeExecutable:
      local.chromeExecutable || env.CHROME_EXECUTABLE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    chromeUserDataDir:
      local.chromeUserDataDir || env.CHROME_USER_DATA_DIR || 'C:\\temp\\chrome-debug',
    chromeRemoteDebugPort:
      parseNumber(local.chromeRemoteDebugPort ?? env.CHROME_REMOTE_DEBUG_PORT, 9222),
    maxSlotAttempts:
      parseNumber(local.maxSlotAttempts ?? env.MAX_SLOT_ATTEMPTS, 10),
    slotRetryDelayMs:
      parseNumber(local.slotRetryDelayMs ?? env.SLOT_RETRY_DELAY_MS, 10000),
    cityRetrySeconds:
      parseNumber((local as any).cityRetrySeconds ?? env.CITY_RETRY_SECONDS, 10),
    cloudflareWaitMs:
      parseNumber(local.cloudflareWaitMs ?? env.CLOUDFLARE_WAIT_MS, 180000),
    debugNetwork:
      parseBoolean(local.debugNetwork ?? env.DEBUG_NETWORK, false),
    // `useCamoufox` removed.
    autoSolveCloudflare:
      parseBoolean(local.autoSolveCloudflare ?? env.AUTO_SOLVE_CLOUDFLARE, false),
    headless:
      parseBoolean(local.headless ?? env.HEADLESS, false),
    alertOnMajorEvents:
      parseBoolean((local as any).alertOnMajorEvents ?? env.ALERT_ON_MAJOR_EVENTS, true),
    screenshotAfterSelection:
      parseBoolean((local as any).screenshotAfterSelection ?? env.SCREENSHOT_AFTER_SELECTION, true)
  };

  if (!config.authUrl) {
    throw new Error('Missing authUrl. Set AUTH_URL or config.local.json authUrl.');
  }

  if (looksLikePlaceholder(config.authUrl) || !isLikelyAuthFlowUrl(config.authUrl)) {
    throw new Error('authUrl must be a real usvisascheduling or B2C login URL, not an example placeholder.');
  }

  if (!config.username || !config.password) {
    throw new Error('Missing credentials. Set USERNAME/PASSWORD or config.local.json.');
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
