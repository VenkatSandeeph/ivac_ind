import type { Page, Request, Response } from 'patchright';
import { info, warn, client, backendError } from './logger';
import type { AutomationConfig } from './config';
import { recordDateExperiment } from './date-experiment'; // EXPERIMENTAL: avoidEarliestDate

/**
 * Fast Flow module — books OFC appointments by leveraging the page's own
 * JavaScript functions (jQuery $.ajax, onClickSubmit, onPostChange).
 *
 * The usvisascheduling.com page is a Power Apps portal that uses jQuery
 * internally. jQuery is wrapped by the bundler and not directly accessible
 * from window.$/window.jQuery, BUT the page exposes global functions:
 *
 *   - onPostChange()      → triggers getScheduleDays when city changes
 *   - onClickSubmit()     → triggers the submit API call
 *   - jsdata              → global object holding primaryId, Num, Token, etc.
 *   - token               → global variable holding the latest API Token
 *
 * The Token chain is page-internal and CANNOT be replicated by direct XHR/fetch:
 *   1. getScheduleDays  → returns Token1 (stored in `token` and `sd`)
 *   2. Date click        → getScheduleEntries sends Token1 → returns Token2
 *   3. onClickSubmit()   → sends Token2 with jsdata.Num → server books appointment
 *
 * Direct API calls (XHR/fetch) return empty 270-byte HTML because we can't
 * generate the page-internal Token. So we NEVER make direct API calls.
 * Instead we:
 *   1. Let the page make its own API calls (triggered by Playwright clicks)
 *   2. Capture the responses via a response listener
 *   3. Set jsdata.Num directly and call onClickSubmit() for the fastest submit
 *
 * Fallback: if this flow fails, the DOM flow in index.ts takes over.
 */

// =============================================================================
// Types
// =============================================================================

type PageContext = {
  primaryId: string;
  appd: string;
  postId: string;
  applications: string[];
};

type ScheduleDay = {
  ID: string;
  Date: string;
};

type ScheduleEntry = {
  Num: string;
  Time: string;
  EntriesAvailable: number;
};

/**
 * Extract a date string from a schedule day item.
 * The API may return dates as:
 *   - Plain strings: "2026-10-27"
 *   - Objects with Date: { Date: "2026-10-27", ID: "..." }
 *   - Objects with ScheduleDate: { ScheduleDate: "2026-10-27", ID: "..." }
 *   - Objects with other field names (CalendarDate, Day, SlotDate)
 * This handles all cases and normalizes to a YYYY-MM-DD string.
 */
function extractDateField(d: any): string {
  if (typeof d === 'string') return d;
  if (!d || typeof d !== 'object') return '';
  for (const key of ['ScheduleDate', 'Date', 'CalendarDate', 'Day', 'SlotDate']) {
    if (d[key]) return String(d[key]);
  }
  return '';
}

/**
 * Extract an ID string from a schedule day item.
 * The API may use different field names for the ID.
 */
function extractIdField(d: any): string {
  if (typeof d === 'string') return d;
  if (!d || typeof d !== 'object') return '';
  for (const key of ['ID', 'Id', 'ScheduleDayId', 'DayId']) {
    if (d[key]) return String(d[key]);
  }
  return '';
}

export type DirectApiResult = {
  success: boolean;
  fallback: boolean;       // true if caller should use DOM flow
  redirectStub?: string;   // present when success=true
  reason?: string;         // present when success=false
  bookedDate?: string;
  bookedTime?: string;
};

// =============================================================================
// Captured state — populated by setupApiResponseCapture
// =============================================================================

let capturedApplications: string[] | null = null;
// Display names from the same query-family-members response — kept ONLY for
// the booked Telegram message; never used for seat counting or submission.
let capturedMemberNames: string[] = [];
let capturedScheduleDays: ScheduleDay[] | null = null;
let capturedScheduleToken: string | null = null;

let capturedScheduleEntries: ScheduleEntry[] | null = null;
let capturedEntriesToken: string | null = null;
let entriesCapturedResolve: ((value: boolean) => void) | null = null;
// Bumps on every successful entries capture — lets us tell a fresh
// post-submit-failure refresh apart from a stale capture.
let entriesCaptureGen = 0;
// In-flight schedule-ofc-appointments-for-family POSTs (ours + the page's
// own auto-resubmits after a failed submit).
let pendingOfcSubmits = 0;
// Request-side generation for getScheduleEntries — separates "response is
// still in flight" (wait longer) from "the click never fired the call"
// (bail early). Bumped in the request listener below.
let entriesRequestGen = 0;
let entriesRequestResolve: (() => void) | null = null;
// Round-trip latency of the last getScheduleDays call — a live measure of
// server load used to scale the entries wait budget.
let daysRequestAt = 0;
let lastDaysLatencyMs = 0;
// Late-entries rescue: armed when Phase 2 times out with the entries request
// still in flight. Consumed during the inter-city wait — never after the
// next city selection (the context is per-city and dies there).
let lateEntriesRescue: { date: ScheduleDay; sinceGen: number } | null = null;
// Member count from the last flow context — the rescue needs it for the
// seat-eligibility filter without re-extracting page state.
let flowMemberCount = 1;

let sessionApiCallCount = 0;
let sessionStartTime = Date.now();

/**
 * Last query-family-members result. The member query fires once per schedule
 * page load and populates the group-member checkboxes — when it is blocked
 * (Cloudflare 403/429) or returns no members, the page shows "No Class
 * Selected" and every downstream get-family-ofc-schedule-days call fails
 * with an app-level error (SGA14). index.ts reads this to classify failures.
 */
let memberQueryStatus: number | null = null;
let memberQueryAt = 0;
let memberQueryError: string | null = null;

export function getMemberQueryResult(): { status: number | null; at: number; error: string | null } {
  return { status: memberQueryStatus, at: memberQueryAt, error: memberQueryError };
}

export function resetMemberQueryResult(): void {
  memberQueryStatus = null;
  memberQueryAt = 0;
  memberQueryError = null;
}

/**
 * Best-effort display name for a query-family-members member object — the
 * wire shape isn't documented, so try the likely fields in order.
 */
function extractMemberName(m: any): string {
  if (!m || typeof m !== 'object') return '';
  const direct = m.FullName || m.ApplicantName || m.Name || m.DisplayName;
  if (direct) return String(direct).trim();
  const composed = [m.FirstName, m.MiddleName, m.LastName]
    .filter(Boolean).map((p: any) => String(p).trim()).filter(Boolean).join(' ');
  return composed;
}

/** Names from the last query-family-members response (empty when unknown). */
export function getCapturedMemberNames(): string[] {
  return capturedMemberNames;
}

/**
 * DOM fallback for member names — reads the visible labels of the
 * #gm_select group-member checkboxes on the live schedule page. Used when
 * the wire capture is empty (stale/missed response). Read-only eval; never
 * throws — returns [] on any failure.
 */
export async function scrapeMemberNames(page: Page): Promise<string[]> {
  try {
    const names = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#gm_select li'))
        .map((li) => {
          const label = li.querySelector('label');
          const text = (label ? label.textContent : li.textContent) || '';
          return text.replace(/\s+/g, ' ').trim();
        })
        .filter((t) => t.length > 0);
    });
    return Array.isArray(names) ? names : [];
  } catch {
    return [];
  }
}

/** Captured names → DOM scrape → [] — the notification never fails. */
export async function getMemberNames(page: Page): Promise<string[]> {
  if (capturedMemberNames.length > 0) return capturedMemberNames;
  return scrapeMemberNames(page);
}

// =============================================================================
// Server-time offset calibration
// =============================================================================
// The HTTP `Date` response header is UTC with 1-second resolution. We compute
// serverTimeOffsetMs = serverMs - localMs at the moment each API response
// arrives, so that server time ≈ Date.now() + serverTimeOffsetMs. This lets the
// special-window logic target the SERVER's UTC :MM:00 instead of the local
// machine's clock (which may be in a different timezone and/or skewed).
let serverTimeOffsetMs = 0;
let serverTimeCalibrated = false;

export function getServerTimeOffsetMs(): number {
  return serverTimeOffsetMs;
}

export function isServerTimeCalibrated(): boolean {
  return serverTimeCalibrated;
}

// =============================================================================
// Response capture — listens to the page's own API calls
// =============================================================================

/**
 * Installs response listeners on the page to capture the page's own API calls.
 * This is how we get schedule days, entries, and tokens without making our own
 * (broken) direct API calls.
 *
 * Also logs request/response details for debugging.
 */
export function setupApiResponseCapture(page: Page): void {
  sessionStartTime = Date.now();
  sessionApiCallCount = 0;

  // Log the page's own request headers + post data for schedule API calls.
  // This tells us exactly what the page sends (Token, jsdata fields, headers).
  let pageEntriesHeadersLogged = false;
  page.on('request', (request: Request) => {
    try {
      const url = request.url();
      if (!url.includes('/custom-actions/')) return;
      if (!url.includes('get-family-ofc-schedule-entries') &&
          !url.includes('schedule-ofc-appointments-for-family') &&
          !url.includes('get-family-ofc-schedule-days')) return;

      const routeMatch = url.match(/route=([^&]+)/);
      const shortRoute = routeMatch ? decodeURIComponent(routeMatch[1]).replace('/api/v1/schedule-group/', '') : 'unknown';
      const postData = (request.postData() || '').substring(0, 500);

      // Request-side signals: days requests timestamp the latency measure;
      // entries requests prove the click actually fired a call.
      if (url.includes('get-family-ofc-schedule-days')) {
        daysRequestAt = Date.now();
      }
      if (url.includes('get-family-ofc-schedule-entries')) {
        entriesRequestGen++;
        if (entriesRequestResolve) {
          entriesRequestResolve();
          entriesRequestResolve = null;
        }
      }

      // Log getScheduleEntries request (first one only — shows Token chain)
      if (url.includes('get-family-ofc-schedule-entries') && !pageEntriesHeadersLogged) {
        pageEntriesHeadersLogged = true;
        info(`[FAST FLOW] ===== PAGE REQUEST (getScheduleEntries) =====`);
        info(`[FAST FLOW] Route: ${shortRoute}, Method: ${request.method()}`);
        info(`[FAST FLOW] Post data: ${postData}`);
        info(`[FAST FLOW] ===== END PAGE REQUEST =====`);
      } else if (url.includes('schedule-ofc-appointments-for-family')) {
        pendingOfcSubmits++;
        // Log every submit request — critical for debugging booking failures
        info(`[FAST FLOW] ===== PAGE SUBMIT REQUEST =====`);
        info(`[FAST FLOW] Route: ${shortRoute}, Method: ${request.method()}`);
        info(`[FAST FLOW] Post data: ${postData}`);
        info(`[FAST FLOW] ===== END PAGE SUBMIT REQUEST =====`);
      }
    } catch { /* ignore */ }
  });

  // A submit that fails at transport level never reaches the response
  // listener — drain the pending counter here too.
  page.on('requestfailed', (request: Request) => {
    try {
      if (request.url().includes('schedule-ofc-appointments-for-family')) {
        pendingOfcSubmits = Math.max(0, pendingOfcSubmits - 1);
      }
    } catch { /* ignore */ }
  });

  page.on('response', async (response: Response) => {
    try {
      const url = response.url();

      // Count all API calls for rate-limit awareness
      if (url.includes('/custom-actions/')) {
        sessionApiCallCount++;
        const routeMatch = url.match(/route=([^&]+)/);
        const shortRoute = routeMatch ? decodeURIComponent(routeMatch[1]).replace('/api/v1/schedule-group/', '') : 'unknown';
        info(`[FAST FLOW] API call #${sessionApiCallCount}: ${shortRoute} → HTTP ${response.status()}`);

        // Calibrate server-time offset from the Date header (UTC, 1s resolution).
        // Runs for both OK and error responses (e.g. 403/429 still carry Date).
        try {
          const dateHeader = response.headers()['date'];
          if (dateHeader) {
            const serverMs = Date.parse(dateHeader);
            if (!Number.isNaN(serverMs)) {
              const localMs = Date.now();
              serverTimeOffsetMs = serverMs - localMs;
              if (!serverTimeCalibrated) {
                serverTimeCalibrated = true;
                const sign = serverTimeOffsetMs >= 0 ? '+' : '';
                info(`[SERVER TIME] Calibrated offset=${serverTimeOffsetMs}ms (server is ${sign}${(serverTimeOffsetMs / 1000).toFixed(2)}s vs local clock). Special windows now target server UTC time.`);
              }
            }
          }
        } catch { /* ignore header parse errors */ }

        // Log response headers for getScheduleEntries (first success only)
        if (url.includes('get-family-ofc-schedule-entries') && response.ok()) {
          try {
            const respHeaders = response.headers();
            const cfRay = respHeaders['cf-ray'] || 'none';
            const cfCache = respHeaders['cf-cache-status'] || 'none';
            const contentType = respHeaders['content-type'] || 'none';
            info(`[FAST FLOW] Response headers (getScheduleEntries): cf-ray=${cfRay}, cf-cache=${cfCache}, content-type=${contentType}`);
          } catch { /* ignore */ }
        }
      }

      // Track query-family-members results BEFORE the ok-check below — a
      // failed member query leaves the page with no group context ("No Class
      // Selected") and every downstream schedule-days call fails (SGA14).
      if (url.includes('query-family-members')) {
        memberQueryStatus = response.status();
        memberQueryAt = Date.now();
        if (!response.ok()) {
          capturedApplications = []; // stale IDs must never be replayed
          capturedMemberNames = [];
          memberQueryError = `http_${response.status()}`;
          backendError('query-family-members', memberQueryStatus, memberQueryError,
            'group members will not load; schedule calls will fail (SGA14)');
          client('🚫', `Member list request blocked (HTTP ${memberQueryStatus}) — will retry…`);
        } else {
          memberQueryError = null;
        }
      }

      if (!response.ok()) {
        // Surface every blocked schedule-group response — they used to pass
        // through silently with only the generic "API call #N" line.
        if (url.includes('/schedule-group/')) {
          const routeMatch = url.match(/route=([^&]+)/);
          const shortRoute = routeMatch ? decodeURIComponent(routeMatch[1]).replace('/api/v1/schedule-group/', '') : 'unknown';
          backendError(shortRoute, response.status(), null, 'transport block/error');
        }
        return;
      }

      // Capture applications from queryFamilyMembers
      if (url.includes('query-family-members')) {
        const data = await response.json().catch(() => null);
        if (data && Array.isArray(data.Members)) {
          capturedApplications = data.Members.map((m: any) => String(m.ApplicationID || '')).filter(Boolean);
          capturedMemberNames = data.Members.map(extractMemberName).filter((n: string) => n.length > 0);
          if (data.Members.length > 0 && capturedMemberNames.length === 0) {
            // Field-name miss — log the raw shape once so the real key can be
            // pinned without guessing again.
            info('[FAST FLOW] Member names not extracted; raw member keys: ' + Object.keys(data.Members[0] || {}).join(','));
          }
          info(`[FAST FLOW] Captured ${capturedApplications?.length || 0} application(s) from queryFamilyMembers`);
        } else if (data && data.HasError) {
          memberQueryError = String(data.Errors?.m_StringValue || 'has_error');
          backendError('query-family-members', response.status(), memberQueryError, 'app-level error in 200 response');
        }
      }

      // Capture schedule days + token from getScheduleDays
      if (url.includes('get-family-ofc-schedule-days')) {
        if (daysRequestAt) {
          lastDaysLatencyMs = Date.now() - daysRequestAt;
          daysRequestAt = 0;
        }
        let data = await response.json().catch(() => null);
        if (!data) {
          const body = await response.text().catch(() => '');
          data = extractJsonFromHtml(body);
        }
        if (data && !data.HasError) {
          const days: ScheduleDay[] = (data.ScheduleDays || []).map((d: any) => ({
            ID: extractIdField(d),
            Date: extractDateField(d)
          }));
          capturedScheduleDays = days;
          capturedScheduleToken = String(data.Token || '');
          info(`[FAST FLOW] Captured ${days.length} schedule day(s) + token (len=${capturedScheduleToken.length}) from getScheduleDays`);
          if (days.length > 0) {
            info(`[FAST FLOW] Schedule day dates: ${days.map(d => d.Date.substring(0, 10)).slice(0, 10).join(', ')}${days.length > 10 ? '...' : ''}`);
          }
        } else if (data && data.HasError) {
          const code = String(data.Errors?.m_StringValue || data.ErrorString || 'unknown')
            .replace(/<[^>]+>/g, ' ').trim() || 'unknown';
          backendError('get-family-ofc-schedule-days', response.status(), code,
            `ScheduleDays=${Array.isArray(data.ScheduleDays) ? data.ScheduleDays.length : 0}`);
        }
      }

      // Capture schedule entries + token from getScheduleEntries
      if (url.includes('get-family-ofc-schedule-entries')) {
        let data = await response.json().catch(() => null);
        if (!data) {
          const body = await response.text().catch(() => '');
          data = extractJsonFromHtml(body);
        }
        if (data && !data.HasError) {
          const entries: ScheduleEntry[] = (data.ScheduleEntries || []).map((e: any) => ({
            Num: String(e.Num ?? e.EntryNum ?? e.ID ?? ''),
            Time: String(e.Time ?? e.ScheduleTime ?? e.SlotTime ?? ''),
            EntriesAvailable: Number(e.EntriesAvailable ?? e.Available ?? e.Capacity ?? 0)
          }));
          capturedScheduleEntries = entries;
          capturedEntriesToken = String(data.Token || '');
          entriesCaptureGen++;
          info(`[FAST FLOW] Captured ${entries.length} schedule entry(ies) + token (len=${capturedEntriesToken.length}) from getScheduleEntries`);
          // Resolve any pending waiter
          if (entriesCapturedResolve) {
            entriesCapturedResolve(true);
            entriesCapturedResolve = null;
          }
        } else if (data && data.HasError) {
          const code = String(data.Errors?.m_StringValue || data.ErrorString || 'unknown')
            .replace(/<[^>]+>/g, ' ').trim() || 'unknown';
          backendError('get-family-ofc-schedule-entries', response.status(), code);
        }
      }

      // Log submit response — critical for debugging booking results
      if (url.includes('schedule-ofc-appointments-for-family') || url.includes('appointments-for-family')) {
        pendingOfcSubmits = Math.max(0, pendingOfcSubmits - 1);
        try {
          const body = await response.text().catch(() => '');
          const status = response.status();
          const contentType = response.headers()['content-type'] || '';
          info(`[FAST FLOW] Submit response: HTTP ${status}, contentType=${contentType}, bodyLen=${body.length}`);
          const parsed = extractJsonFromHtml(body);
          if (parsed) {
            info(`[FAST FLOW] Submit parsed: AllScheduled=${parsed.AllScheduled}, HasError=${parsed.HasError}, RedirectStub=${parsed.RedirectStub || 'none'}, Errors=${JSON.stringify(parsed.Errors || {}).substring(0, 300)}`);
          } else if (body.length > 0 && body.trim().length > 0) {
            // Log a preview if there's non-whitespace content we couldn't parse
            info(`[FAST FLOW] Submit response has unparseable content (first 200 chars): ${body.substring(0, 200).replace(/\s+/g, ' ')}`);
          }
        } catch { /* response body not available */ }
      }
    } catch {
      // Response body may not be available — ignore
    }
  });
}

/**
 * Resets captured schedule data — call before each city selection
 * so we don't reuse stale data from a previous city.
 */
export function resetCapturedScheduleData(): void {
  capturedScheduleDays = null;
  capturedScheduleToken = null;
  capturedScheduleEntries = null;
  capturedEntriesToken = null;
  // A pending late-entries rescue dies with the city context — the next
  // selectCity switches postId/token chain, making the capture unusable.
  lateEntriesRescue = null;
}

// =============================================================================
// Wait helpers
// =============================================================================

/**
 * Wait for captured entries from the page's own getScheduleEntries response.
 * Used after clicking a date cell — we wait for the page to make the API call.
 */
function waitForCapturedEntries(timeoutMs: number): Promise<boolean> {
  if (capturedScheduleEntries && capturedScheduleEntries.length > 0) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      entriesCapturedResolve = null;
      resolve(false);
    }, timeoutMs);
    entriesCapturedResolve = (val: boolean) => {
      clearTimeout(timer);
      resolve(val);
    };
  });
}

/**
 * Gets a snapshot of the currently captured entries + token.
 */
function getCapturedEntriesSnapshot(): { entries: ScheduleEntry[]; token: string } | null {
  const entries = capturedScheduleEntries;
  const token = capturedEntriesToken || '';
  if (!entries) return null;
  return { entries, token };
}

/**
 * Wait for a NEW entries capture that arrives AFTER `sinceGen` — used by the
 * same-date retry to grab the page's own post-submit-failure refresh
 * (verified: the site auto-refreshes getScheduleEntries ~1s after a failed
 * submit, yielding fresh slots + a fresh token).
 */
function waitForNextEntriesCapture(sinceGen: number, timeoutMs: number): Promise<boolean> {
  if (entriesCaptureGen > sinceGen) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      entriesCapturedResolve = null;
      resolve(false);
    }, timeoutMs);
    entriesCapturedResolve = () => {
      clearTimeout(timer);
      resolve(true);
    };
  });
}

/**
 * Wait until a getScheduleEntries REQUEST has been observed leaving the page
 * (not the response — the request itself). If the click never triggers the
 * PCF handler, no request fires and we bail early instead of waiting on a
 * response that can never arrive.
 */
function waitForEntriesRequest(sinceGen: number, timeoutMs: number): Promise<boolean> {
  if (entriesRequestGen > sinceGen) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      entriesRequestResolve = null;
      resolve(false);
    }, timeoutMs);
    entriesRequestResolve = () => {
      clearTimeout(timer);
      resolve(true);
    };
  });
}

/**
 * Entries wait budget scaled to the server's demonstrated latency. The days
 * call just measured current load — under drop pressure both calls run slow
 * (observed: 21s days call followed by a 17s entries response that outlived
 * the old fixed 8s wait and lost a real slot). Floor 15s, cap 30s.
 */
function entriesWaitBudgetMs(): number {
  const scaled = Math.round(lastDaysLatencyMs * 1.5);
  return Math.min(30000, Math.max(15000, scaled || 15000));
}

/**
 * Wait until no schedule-ofc-appointments-for-family POSTs are in flight.
 * After a failed submit the site fires its OWN auto-resubmit; starting our
 * retry (or the wire replay) while that is still outstanding races the page
 * and can poison the session/token context.
 */
async function waitForSubmitQuiesce(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pendingOfcSubmits === 0) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return pendingOfcSubmits === 0;
}

// =============================================================================
// Page context extraction
// =============================================================================

/**
 * Extracts primaryId, appd, and postId from the page's inline scripts.
 * Also extracts applications from the DOM or captured queryFamilyMembers response.
 *
 * The page sets these in inline <script> tags:
 *   jsdata['primaryId'] = "...";
 *   ...&appd=...  (in the AJAX URL)
 *   #post_select value = postId
 *
 * Applications come from queryFamilyMembers (captured by response listener) or
 * from DOM checkboxes in #gm_select. If neither is available, we fall back to
 * using primaryId as the sole application (matches the page's Token-based approach
 * where applications is often null/empty and the Token carries the context).
 */
async function extractPageContext(page: Page): Promise<PageContext | null> {
  try {
    const result = await page.evaluate(() => {
      let primaryId = '';
      let appd = '';

      // Extract primaryId and appd from inline scripts
      const scripts = Array.from(document.querySelectorAll('script:not([src])'));
      for (const script of scripts) {
        const text = script.textContent || '';
        if (!primaryId) {
          const pidMatch = text.match(/jsdata\[['"]primaryId['"]\]\s*=\s*['"]([a-f0-9\-]+)['"]/i);
          if (pidMatch) primaryId = pidMatch[1];
        }
        if (!appd) {
          const appdMatch = text.match(/appd=([a-f0-9\-]+)/i);
          if (appdMatch) appd = appdMatch[1];
        }
        if (primaryId && appd) break;
      }

      const postSelect = document.querySelector<HTMLSelectElement>('#post_select');
      const postId = postSelect ? postSelect.value : '';

      // Extract application IDs from DOM checkboxes in #gm_select
      // (deduped — the page's checkbox handler appends the same id on each
      // re-check, producing payloads like applications:["id","id"])
      const appCheckboxes = Array.from(document.querySelectorAll<HTMLInputElement>('#gm_select li input[type="checkbox"]'));
      const applications = Array.from(new Set(appCheckboxes.map(el => el.value).filter(Boolean)));

      // Log jsdata state for debugging
      try {
        const jsdata = (window as any).jsdata;
        if (jsdata) {
          // Don't log Token values — just presence/length
          const tokenLen = jsdata.Token ? String(jsdata.Token).length : 0;
          // This log goes to the page console, not our logger — but it's available
          // for live debugging via page.on('console')
          console.log(`[FAST FLOW DEBUG] jsdata: primaryId=${jsdata.primaryId?.substring(0, 8) || 'null'}..., applications=${JSON.stringify(jsdata.applications)}, scheduleDayId=${jsdata.scheduleDayId || 'null'}, Num=${jsdata.Num || 'null'}, Token=${tokenLen > 0 ? 'present(' + tokenLen + ' chars)' : 'null'}`);
        }
      } catch { /* ignore */ }

      return { primaryId, appd, postId, applications };
    });

    if (!result || !result.primaryId || !result.appd || !result.postId) {
      warn(`[FAST FLOW] Context extraction failed: primaryId=${result?.primaryId ? 'found' : 'NOT FOUND'}, appd=${result?.appd ? 'found' : 'NOT FOUND'}, postId=${result?.postId ? 'found' : 'NOT FOUND'}`);
      return null;
    }

    // Use DOM-extracted applications, or fall back to captured ones
    let applications = result.applications || [];
    if (applications.length === 0 && capturedApplications && capturedApplications.length > 0) {
      applications = capturedApplications;
    }

    if (applications.length === 0) {
      // primaryId is NOT an application ID — never synthesize one (a submit
      // with a fabricated applications array is a malformed booking, PSE0602
      // territory). Empty is fine: the wire payload sends applications:null
      // anyway (the Token carries context); the count is only used for the
      // seat-availability filter, which then falls back to 1.
      warn('[FAST FLOW] Member application IDs unavailable — proceeding without seat-count filter (treated as 1 member)');
    }

    info(`[FAST FLOW] Context: primaryId=${result.primaryId.substring(0, 8)}..., appd=${result.appd.substring(0, 8)}..., postId=${result.postId}, ${applications.length} application(s)`);
    return {
      primaryId: result.primaryId,
      appd: result.appd,
      postId: result.postId,
      applications
    };
  } catch (err) {
    warn('[FAST FLOW] Context extraction error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// =============================================================================
// JSON extraction from HTML-wrapped responses
// =============================================================================

/**
 * The usvisascheduling.com server wraps JSON responses inside HTML markup:
 *   <html whitespace/tags>\n{"AllScheduled":false,...}\n<more html>
 * The Content-Type is text/html, and JSON.parse() fails on the raw response.
 * This function extracts the JSON object from the mixed HTML/JSON content.
 */
export function extractJsonFromHtml(text: string): any | null {
  if (!text) return null;
  // Try direct parse first (in case it's pure JSON)
  try { return JSON.parse(text); } catch { /* not pure JSON */ }
  // Find the first '{' and try to parse from there to the matching '}'
  const start = text.indexOf('{');
  if (start < 0) return null;
  const end = text.lastIndexOf('}');
  if (end < 0 || end <= start) return null;
  const jsonCandidate = text.substring(start, end + 1);
  try { return JSON.parse(jsonCandidate); } catch { /* try another approach */ }
  // Try progressively shorter substrings (in case there's trailing HTML after JSON)
  let searchEnd = end;
  while (searchEnd > start) {
    const sub = text.substring(start, searchEnd + 1);
    try { return JSON.parse(sub); } catch { /* continue */ }
    searchEnd = text.lastIndexOf('}', searchEnd - 1);
    if (searchEnd < 0) break;
  }
  return null;
}

// =============================================================================
// Date filtering and entry sorting
// =============================================================================

/**
 * Filters schedule days to the configured date range.
 */
function filterScheduleDays(days: ScheduleDay[], config: AutomationConfig): ScheduleDay[] {
  const start = config.appointment.startDate ? new Date(config.appointment.startDate) : null;
  const end = config.appointment.endDate ? new Date(config.appointment.endDate) : null;
  if (start) start.setHours(0, 0, 0, 0);
  if (end) end.setHours(23, 59, 59, 999);

  // Log the range and raw dates for debugging
  const rawDates = days.map(d => d.Date.substring(0, 10));
  info(`[FAST FLOW] filterScheduleDays: range=${config.appointment.startDate || 'none'} to ${config.appointment.endDate || 'none'}, raw dates=[${rawDates.slice(0, 10).join(', ')}${rawDates.length > 10 ? '...' : ''}]`);

  const matching = days.filter(day => {
    const d = new Date(day.Date);
    if (isNaN(d.getTime())) {
      info(`[FAST FLOW] filterScheduleDays: skipping invalid date "${day.Date}"`);
      return false;
    }
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  });

  // Sort by date (earliest first)
  matching.sort((a, b) => new Date(a.Date).getTime() - new Date(b.Date).getTime());
  return matching;
}

/**
 * Drops dates listed in appointment.excludeDates (phantom/glitch slots the
 * user never wants attempted). Returns the SAME array reference when nothing
 * is excluded — downstream reorder-detection (`!==`) stays accurate. Each
 * dropped date gets one client log line. Never throws.
 */
export function filterExcludedDates<T>(dates: T[], getIso: (d: T) => string, config: AutomationConfig): T[] {
  const excl = config.appointment?.excludeDates;
  if (!excl || excl.length === 0 || dates.length === 0) return dates;
  const set = new Set(excl);
  let dropped = false;
  const kept = dates.filter((d) => {
    const iso = getIso(d);
    if (iso && set.has(iso)) {
      dropped = true;
      client('📅', `${iso} excluded`);
      info(`[EXCLUDE] ${iso} skipped — listed in profile excludeDates`);
      return false;
    }
    return true;
  });
  return dropped ? kept : dates;
}

/**
 * Sorts schedule entries by preferred time, then by availability.
 * preferLeast=false → most-available first (default); true → least-available first.
 */
function sortScheduleEntries(entries: ScheduleEntry[], preferredTime?: string | null, preferLeast = false): ScheduleEntry[] {
  const pref = preferredTime?.trim() || '';
  return [...entries].sort((a, b) => {
    // Preferred time gets priority
    if (pref) {
      const aPref = a.Time.includes(pref) ? 0 : 1;
      const bPref = b.Time.includes(pref) ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
    }
    // Then by availability
    return preferLeast
      ? a.EntriesAvailable - b.EntriesAvailable
      : b.EntriesAvailable - a.EntriesAvailable;
  });
}

// =============================================================================
// EXPERIMENTAL: avoidEarliestDate — 2nd-date-first ordering
// -----------------------------------------------------------------------------
// Theory: bots/humans concentrate on the earliest available date, so the
// 2nd-earliest date sees less submit contention. When ≥2 in-range dates exist
// and the 2nd is within AVOID_EARLIEST_WINDOW_DAYS working days of the
// earliest, try the 2nd FIRST while keeping the earliest as the immediate
// fallback in the same attempt (reorder, never skip — a failed 2nd date still
// falls through to the earliest before the next city).
// To remove: delete this block, the orderDatesForAttempt call sites, and the
// avoidEarliestDate plumbing (config.ts, ui/, config.example.json).
// =============================================================================

const AVOID_EARLIEST_WINDOW_DAYS = 7;

/**
 * Count Mon–Fri days strictly after `a` up to and including `b`.
 * Dates are ISO 'YYYY-MM-DD' (compared lexically before parsing).
 */
function workingDaysBetween(a: string, b: string): number {
  if (b <= a) return 0;
  const start = new Date(a + 'T00:00:00');
  const end = new Date(b + 'T00:00:00');
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
  // Simple loop — only small gaps matter (early exit past the window).
  let count = 0;
  const cursor = new Date(start);
  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    const dow = cursor.getDay(); // 0=Sun .. 6=Sat
    if (dow >= 1 && dow <= 5) count++;
    if (count > AVOID_EARLIEST_WINDOW_DAYS) break;
  }
  return count;
}

/**
 * Attempt order for candidate dates. When enabled and the 2nd date is within
 * the working-day window of the earliest, returns [2nd, 1st, 3rd, ...] —
 * the earliest remains the immediate fallback in the same attempt.
 * Otherwise returns the input unchanged.
 *
 * `meta` (optional): caller context written to logs/date-experiment.jsonl.
 * A decision event is recorded whenever meta is provided — including when
 * the flag is off (wouldReorder = baseline "would have fired" data).
 */
export function orderDatesForAttempt<T>(
  items: T[],
  dateOf: (item: T) => string,
  enabled: boolean,
  meta?: Record<string, unknown>
): T[] {
  const gap = items.length >= 2
    ? workingDaysBetween(dateOf(items[0]), dateOf(items[1]))
    : 0;
  const wouldReorder = gap > 0 && gap <= AVOID_EARLIEST_WINDOW_DAYS;
  const reordered = enabled && wouldReorder;
  if (meta) {
    recordDateExperiment({
      type: 'decision',
      ...meta,
      enabled,
      nDates: items.length,
      dates: items.slice(0, 6).map(dateOf),
      gapWorkingDays: gap,
      wouldReorder,
      reordered,
      order: reordered
        ? [dateOf(items[1]), dateOf(items[0]), ...items.slice(2, 6).map(dateOf)]
        : items.slice(0, 6).map(dateOf)
    });
  }
  if (!reordered) return items;
  info(`[EXPERIMENTAL] avoidEarliestDate: 2nd date ${dateOf(items[1])} is ${gap} working day(s) after ${dateOf(items[0])} — trying it first (earliest remains fallback)`);
  return [items[1], items[0], ...items.slice(2)];
}

// =============================================================================
// Phase 2: Date click — triggers page's getScheduleEntries
// =============================================================================

/**
 * Clicks a date cell in the calendar using Playwright's real click.
 *
 * CRITICAL: Synthetic events (dispatchEvent) do NOT trigger the PCF framework's
 * event handlers. We must use Playwright's page.click() which simulates a real
 * user click (with proper CDP-level mouse events). This was the root cause of
 * the old Tier 3 timing out — the click "succeeded" but the page never made
 * the getScheduleEntries API call.
 *
 * After the click, we wait for the page's own getScheduleEntries response
 * (captured by setupApiResponseCapture) and return the entries + token.
 */
async function clickDateAndGetEntries(
  page: Page,
  day: ScheduleDay
): Promise<{ entries: ScheduleEntry[]; token: string } | null> {
  const phaseStart = Date.now();

  // Reset captured entries before clicking so we capture the NEW response
  capturedScheduleEntries = null;
  capturedEntriesToken = null;

  const dateStr = day.Date.substring(0, 10); // YYYY-MM-DD
  info(`[FAST FLOW] Phase 2: clicking calendar date ${dateStr} via Playwright`);

  // Find the date cell and tag it with a unique attribute for Playwright to click
  const cellSelector: string | null = await page.evaluate((dateStr) => {
    const target = new Date(dateStr);
    if (isNaN(target.getTime())) return null;
    const dayNum = String(target.getDate());
    const month = target.getMonth() + 1;
    const year = target.getFullYear();
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    // Navigate calendar to the right month/year (only if they are <select> elements)
    // NOTE: must be a function declaration, not `const dispatch = () => {}`.
    // tsx/esbuild keepNames wraps named function expressions with __name(),
    // which does not exist in the browser → ReferenceError on evaluate.
    function dispatch(el: HTMLElement) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelectorAll('.ui-datepicker-year').forEach(el => {
      if (el.tagName !== 'SELECT') return;
      const select = el as HTMLSelectElement;
      for (let i = 0; i < select.options.length; i++) {
        if ((select.options[i].textContent || '').trim() === String(year)) {
          select.selectedIndex = i;
          dispatch(select);
          break;
        }
      }
    });
    document.querySelectorAll('.ui-datepicker-month').forEach(el => {
      if (el.tagName !== 'SELECT') return;
      const select = el as HTMLSelectElement;
      if (month - 1 < select.options.length) {
        select.selectedIndex = month - 1;
        dispatch(select);
      }
    });

    // Find the date cell and tag it
    const groups = Array.from(document.querySelectorAll('.ui-datepicker-group'));
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const monthEl = group.querySelector('.ui-datepicker-month');
      const yearEl = group.querySelector('.ui-datepicker-year');
      let groupMonth: number | null = null;
      let groupYear: number | null = null;
      if (monthEl) {
        groupMonth = monthEl.tagName === 'SELECT'
          ? Number((monthEl as HTMLSelectElement).value) + 1
          : monthNames.indexOf(monthEl.textContent?.trim() || '') + 1;
      }
      if (yearEl) {
        groupYear = yearEl.tagName === 'SELECT'
          ? Number((yearEl as HTMLSelectElement).value)
          : Number(yearEl.textContent?.trim());
      }
      if (groupYear !== year || groupMonth !== month) continue;
      const cells = Array.from(group.querySelectorAll('a.ui-state-default, span.ui-state-default'));
      for (let ci = 0; ci < cells.length; ci++) {
        if (cells[ci].textContent?.trim() === dayNum) {
          cells[ci].setAttribute('data-fastflow-target', 'yes');
          return `[data-fastflow-target="yes"]`;
        }
      }
    }
    return null;
  }, dateStr);

  if (!cellSelector) {
    warn(`[FAST FLOW] Phase 2: could not find date ${dateStr} in calendar`);
    return null;
  }

  // Use Playwright's real click — triggers the PCF framework's event handlers
  // which generate the Token and make the getScheduleEntries API call.
  const reqGenBefore = entriesRequestGen;
  let clickOk = false;
  try {
    await page.click(cellSelector, { timeout: 3000 });
    clickOk = true;
  } catch (err) {
    warn(`[FAST FLOW] Phase 2: Playwright click on tagged cell failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Clean up the tag
  await page.evaluate(() => {
    document.querySelectorAll('[data-fastflow-target]').forEach(el => el.removeAttribute('data-fastflow-target'));
  }).catch(() => null);

  // Fallback: if the tagged cell click failed, try using a Playwright locator
  // to find and click the date cell directly (similar to calendar.ts clickDateCell)
  if (!clickOk) {
    info('[FAST FLOW] Phase 2: trying fallback date click via Playwright locator...');
    try {
      // Build a selector for the date cell: find the <a> inside the matching datepicker group
      // The calendar shows two months side by side in .ui-datepicker-group elements
      const fallbackSelector = await page.evaluate((dateStr) => {
        const target = new Date(dateStr);
        if (isNaN(target.getTime())) return null;
        const dayNum = String(target.getDate());
        const month = target.getMonth() + 1;
        const year = target.getFullYear();
        const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

        const groups = Array.from(document.querySelectorAll('.ui-datepicker-group'));
        for (let gi = 0; gi < groups.length; gi++) {
          const group = groups[gi];
          const monthEl = group.querySelector('.ui-datepicker-month');
          const yearEl = group.querySelector('.ui-datepicker-year');
          let groupMonth: number | null = null;
          let groupYear: number | null = null;
          if (monthEl) {
            groupMonth = monthEl.tagName === 'SELECT'
              ? Number((monthEl as HTMLSelectElement).value) + 1
              : monthNames.indexOf(monthEl.textContent?.trim() || '') + 1;
          }
          if (yearEl) {
            groupYear = yearEl.tagName === 'SELECT'
              ? Number((yearEl as HTMLSelectElement).value)
              : Number(yearEl.textContent?.trim());
          }
          if (groupYear !== year || groupMonth !== month) continue;
          const cells = Array.from(group.querySelectorAll('a.ui-state-default'));
          for (let ci = 0; ci < cells.length; ci++) {
            if (cells[ci].textContent?.trim() === dayNum) {
              // Tag it with a unique attribute
              cells[ci].setAttribute('data-fastflow-fallback', 'yes');
              return `[data-fastflow-fallback="yes"]`;
            }
          }
        }
        return null;
      }, dateStr);

      if (fallbackSelector) {
        await page.click(fallbackSelector, { timeout: 3000, force: true });
        await page.evaluate(() => {
          document.querySelectorAll('[data-fastflow-fallback]').forEach(el => el.removeAttribute('data-fastflow-fallback'));
        }).catch(() => null);
        clickOk = true;
        info('[FAST FLOW] Phase 2: fallback date click succeeded');
      } else {
        warn(`[FAST FLOW] Phase 2: could not find date ${dateStr} for fallback click`);
      }
    } catch (fallbackErr) {
      warn(`[FAST FLOW] Phase 2: fallback click also failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
      await page.evaluate(() => {
        document.querySelectorAll('[data-fastflow-fallback]').forEach(el => el.removeAttribute('data-fastflow-fallback'));
      }).catch(() => null);
    }
  }

  if (!clickOk) {
    warn(`[FAST FLOW] Phase 2: all click methods failed for date ${dateStr}`);
    return null;
  }

  info(`[FAST FLOW] Phase 2: date clicked, waiting for page's getScheduleEntries...`);

  // Wait for the page's own getScheduleEntries response (captured by our listener)
  // Also set up a waitForResponse as backup
  const responsePromise = page.waitForResponse(
    (resp: any) => {
      try {
        return resp.url().includes('get-family-ofc-schedule-entries');
      } catch { return false; }
    },
    { timeout: 30000 }
  ).catch(() => null);

  // First prove the request actually fired — a dead click produces no
  // request and must not pay the full wait for a response that can't exist.
  const requestSeen = await waitForEntriesRequest(reqGenBefore, 3000);

  let captured = false;
  if (requestSeen) {
    // The call is in flight — the response is guaranteed, just possibly
    // slow. Scale the wait to the days call's measured latency instead of
    // the old fixed 8s (which lost real slots to a 17s loaded response).
    const waitMs = entriesWaitBudgetMs();
    info(`[FAST FLOW] Phase 2: entries request in flight — waiting up to ${(waitMs / 1000).toFixed(0)}s (days latency ${lastDaysLatencyMs}ms)`);
    captured = await waitForCapturedEntries(waitMs);

    // Busy-page extension: right after a failed submit the site is usually
    // mid auto-resubmit — clicks land on a busy page and the entries call
    // takes longer than 8s. Don't write the date off while submits fly.
    if (!captured && pendingOfcSubmits > 0) {
      info('[FAST FLOW] Phase 2: entries wait expired with submits in flight — page busy, extending wait');
      await waitForSubmitQuiesce(6000);
      captured = await waitForCapturedEntries(4000);
    }
  } else {
    warn('[FAST FLOW] Phase 2: no getScheduleEntries request observed after click — call never fired');
  }

  if (!captured) {
    // Backup listener — only meaningful when a request was actually seen
    // (without one, a response cannot arrive; don't pay its timeout).
    if (requestSeen) {
      const resp = await responsePromise;
      if (resp) {
        info('[FAST FLOW] Phase 2: captured entries via backup response listener');
        try {
          const body = await resp.text();
          const parsed = extractJsonFromHtml(body);
          if (parsed && parsed.ScheduleEntries) {
            const entries: ScheduleEntry[] = (parsed.ScheduleEntries || []).map((e: any) => ({
              Num: String(e.Num),
              Time: String(e.Time),
              EntriesAvailable: Number(e.EntriesAvailable || 0)
            }));
            const token = String(parsed.Token || '');
            const elapsed = Date.now() - phaseStart;
            info(`[FAST FLOW] Phase 2: got ${entries.length} entries via backup (${elapsed}ms)`);
            return { entries, token };
          }
        } catch { /* ignore */ }
      }
    }
    // Distinguish between "no response" (click failed) and "response with 0 entries" (no slots)
    const finalSnapshot = getCapturedEntriesSnapshot();
    if (finalSnapshot && finalSnapshot.entries.length === 0) {
      info(`[FAST FLOW] Phase 2: page returned 0 entries for ${dateStr} (${Date.now() - phaseStart}ms) — no slots on this date`);
      return { entries: [], token: finalSnapshot.token };
    }
    warn(`[FAST FLOW] Phase 2: timed out waiting for entries (${Date.now() - phaseStart}ms)`);
    if (requestSeen) {
      // The request left but the response hasn't landed — it may still be
      // coming (a loaded server answers late: observed 17s under drop
      // pressure). Arm the late-capture rescue: the inter-city wait listens
      // for it and submits while this city's context is still alive.
      // Boundary: cleared by resetCapturedScheduleData at next city select.
      lateEntriesRescue = { date: day, sinceGen: entriesCaptureGen };
      info('[FAST FLOW] Phase 2: response still in flight — armed late-entries rescue for the inter-city wait');
    }
    return null;
  }

  const snapshot = getCapturedEntriesSnapshot();
  if (snapshot) {
    const elapsed = Date.now() - phaseStart;
    info(`[FAST FLOW] Phase 2: captured ${snapshot.entries.length} entries (${elapsed}ms)`);
  }
  return snapshot;
}

// =============================================================================
// Phase 3: Submit — fast radio click + forced submit
// =============================================================================

/**
 * Submits the appointment as fast as possible using 3 speed optimizations:
 *
 * 1. REAL Playwright click on the radio button (not synthetic events)
 *    - Synthetic dispatchEvent() doesn't trigger the PCF framework's
 *      onSelectScheduleEntry() synchronously — it queues the event
 *    - Playwright's page.click() sends a real CDP mouse event that the
 *      framework processes immediately, setting jsdata.Num + enabling submit
 *    - Saves ~3-5 seconds vs synthetic events
 *
 * 2. FORCE-ENABLE the submit button instead of waiting for the framework
 *    - After the radio click, jsdata.Num is set synchronously by the framework
 *    - We remove the disabled attribute ourselves and click immediately
 *    - The page's onClickSubmit() only checks jsdata.Num (already set)
 *    - Saves ~1-3 seconds vs waiting for toggleSubmit() to enable the button
 *
 * 3. Set up response/nav listeners BEFORE the radio click
 *    - The submit API call happens within milliseconds of the submit click
 *    - If we set up listeners after, we might miss the response
 *
 * CONFIRMED WORKING: The DOM approach booked a real OFC appointment on
 * 2027-04-29 at 10:30 in live testing.
 *
 * The page's jsdata, onClickSubmit, and other global functions are NOT
 * accessible from page.evaluate() (PCF closure), so we must use DOM clicks.
 */
async function submitViaPageFunction(
  page: Page,
  entry: ScheduleEntry,
  _token: string,
  opts?: { responseTimeoutMs?: number }
): Promise<{ success: boolean; error?: string; code?: 'slot_gone' | 'throttled'; redirectStub?: string }> {
  const submitStart = Date.now();
  const responseTimeoutMs = opts?.responseTimeoutMs ?? 30000;

  // ── Step 1: Tag the radio button for this entry with a unique attribute ──
  // We need to find it with a CSS selector so Playwright can click it with a real click.
  info(`[FAST FLOW] Phase 3: selecting radio button for Num=${entry.Num} via Playwright click`);

  const radioSelector = await page.evaluate((num) => {
    // Find radio by value
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('#time_select input[type="radio"]'));
    for (const radio of radios) {
      if (radio.value === num || radio.getAttribute('data-num') === num) {
        radio.setAttribute('data-fastflow-radio', 'yes');
        return '[data-fastflow-radio="yes"]';
      }
    }
    // Find radio by row — match the row that contains this time slot
    const rows = Array.from(document.querySelectorAll('#time_select tbody tr'));
    for (const row of rows) {
      const radio = row.querySelector<HTMLInputElement>('input[type="radio"]');
      if (!radio) continue;
      if (radio.value === num) {
        radio.setAttribute('data-fastflow-radio', 'yes');
        return '[data-fastflow-radio="yes"]';
      }
    }
    return null;
  }, entry.Num);

  if (!radioSelector) {
    // Time table may not have rendered yet — wait and retry
    info('[FAST FLOW] Phase 3: radio not found, waiting 1s and retrying...');
    await page.waitForTimeout(1000);
    const retrySelector = await page.evaluate((num) => {
      const radios = Array.from(document.querySelectorAll<HTMLInputElement>('#time_select input[type="radio"]'));
      for (const radio of radios) {
        if (radio.value === num) {
          radio.setAttribute('data-fastflow-radio', 'yes');
          return '[data-fastflow-radio="yes"]';
        }
      }
      return null;
    }, entry.Num);

    if (!retrySelector) {
      warn(`[FAST FLOW] Phase 3: could not find radio button for Num=${entry.Num}`);
      client('❌', 'Could not select that time slot — moving on...');
      return { success: false, error: 'radio button not found' };
    }
  }

  // At this point the radio is tagged. Get the selector.
  const finalRadioSelector = '[data-fastflow-radio="yes"]';

  // ── Step 2: Set up response + navigation listeners BEFORE any clicks ──
  // The submit API call may happen within milliseconds of the submit click,
  // so we must have listeners ready beforehand.
  // First submit gets a longer timeout (30s) since the server can take 12+ seconds.
  // Retries get a shorter timeout (10s) since failures come back fast.
  const submitResponsePromise = page.waitForResponse(
    (resp: any) => {
      try {
        return resp.request().method() === 'POST'
          && resp.url().includes('appointments-for-family');
      } catch { return false; }
    },
    { timeout: responseTimeoutMs }
  ).catch(() => null);

  const navPromise = page.waitForNavigation(
    { waitUntil: 'domcontentloaded', timeout: responseTimeoutMs }
  ).catch(() => null);

  // ── Step 3: REAL Playwright click on the radio button's parent (label/td) ──
  // The PCF framework attaches its click handler to the parent label/td wrapper,
  // NOT to the raw <input type="radio"> element. Clicking the raw input directly
  // (which takes only 36ms) doesn't trigger the framework's onSelectScheduleEntry().
  // We tag the parent wrapper and click that instead.
  const radioClickStart = Date.now();
  if (!finalRadioSelector) {
    warn('[FAST FLOW] Phase 3: no radio selector available');
    client('❌', 'Could not select that time slot — moving on...');
    return { success: false, error: 'radio button not found' };
  }

  // Tag the parent label/td for clicking, and verify the radio is checked after
  const parentSelector = await page.evaluate(() => {
    const radio = document.querySelector('[data-fastflow-radio="yes"]') as HTMLInputElement | null;
    if (!radio) return null;
    // Find the parent that the PCF framework listens to — usually <label> or <td>
    let parent = radio.closest('label') || radio.closest('td') || radio.parentElement;
    if (parent) {
      parent.setAttribute('data-fastflow-radio-parent', 'yes');
      return '[data-fastflow-radio-parent="yes"]';
    }
    // No parent wrapper — fall back to the radio itself
    return '[data-fastflow-radio="yes"]';
  }).catch(() => null as string | null);

  const clickTarget = parentSelector || finalRadioSelector;
  info(`[FAST FLOW] Phase 3: clicking radio parent (${clickTarget === parentSelector ? 'label/td' : 'raw input'})`);

  try {
    await page.click(clickTarget, { timeout: 3000 });
    info(`[FAST FLOW] Phase 3: radio clicked via Playwright (${Date.now() - radioClickStart}ms)`);
  } catch (err) {
    warn(`[FAST FLOW] Phase 3: Playwright radio click failed (${Date.now() - radioClickStart}ms): ${err instanceof Error ? err.message : String(err)}`);
    // Fallback: synthetic events on the radio itself
    await page.evaluate(() => {
      const radio = document.querySelector('[data-fastflow-radio="yes"]') as HTMLInputElement | null;
      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        radio.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const lbl = radio.closest('label') || radio.parentElement;
        if (lbl && typeof lbl.click === 'function') lbl.click();
      }
    }).catch(() => null);
  }

  // Clean up the tags
  await page.evaluate(() => {
    document.querySelectorAll('[data-fastflow-radio], [data-fastflow-radio-parent]').forEach(el => {
      el.removeAttribute('data-fastflow-radio');
      el.removeAttribute('data-fastflow-radio-parent');
    });
  }).catch(() => null);

  // Verify the radio is actually checked
  const radioChecked = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('#time_select input[type="radio"]'));
    return radios.some(r => r.checked);
  }).catch(() => false);
  info(`[FAST FLOW] Phase 3: radio checked=${radioChecked}`);

  // ── Step 4: Wait briefly for submit button to enable, then force-enable if needed ──
  // The PCF framework's toggleSubmit() should enable the button after the radio click.
  // We poll every 50ms for up to 500ms. If it enables, great — the framework confirmed
  // jsdata.Num was set. If not, we force-enable and click (jsdata.Num may still be set
  // even if toggleSubmit didn't run).
  const submitWaitStart = Date.now();
  const submitEnabled = await page.waitForFunction(
    () => {
      const btn = document.querySelector('#submitbtn') as HTMLInputElement | HTMLButtonElement | null;
      return btn && !btn.disabled;
    },
    { timeout: 500, polling: 50 }
  ).catch(() => null);

  if (submitEnabled) {
    info(`[FAST FLOW] Phase 3: submit button enabled by framework (${Date.now() - submitWaitStart}ms)`);
  } else {
    info(`[FAST FLOW] Phase 3: submit not enabled after 500ms — force-enabling`);
    await page.evaluate(() => {
      const btn = document.querySelector('#submitbtn') as HTMLInputElement | HTMLButtonElement | null;
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute('disabled');
      }
    }).catch(() => null);
  }

  // Click the submit button with Playwright (real click)
  const submitClickStart = Date.now();
  info('[FAST FLOW] Phase 3: clicking submit button...');
  try {
    await page.click('#submitbtn', { timeout: 3000 });
    info(`[FAST FLOW] Phase 3: submit clicked via Playwright (${Date.now() - submitClickStart}ms)`);
  } catch (err) {
    warn(`[FAST FLOW] Phase 3: Playwright submit click failed: ${err instanceof Error ? err.message : String(err)}`);
    // Fallback: synthetic click
    await page.evaluate(() => {
      const btn = document.querySelector('#submitbtn') as HTMLElement | null;
      if (btn) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    }).catch(() => null);
  }

  info(`[FAST FLOW] Phase 3: submit clicked, radio+submit total=${Date.now() - submitStart}ms, waiting for response...`);

  // ── Step 5: Wait for response ──
  let submitResponse = await submitResponsePromise;

  // Late-response rescue: a saturated server can answer just past our cap
  // (observed: response landing ~2s after a 30s wait). If the submit is
  // still in flight, grant a short grace window instead of abandoning a
  // live request — abandoning then racing it (wire/DOM retry) is worse.
  if (!submitResponse && pendingOfcSubmits > 0) {
    info('[FAST FLOW] Phase 3: response wait expired but submit still in flight — waiting up to 10s more...');
    client('⏳', 'Server is slow — still waiting for the answer...');
    submitResponse = await page.waitForResponse(
      (resp: any) => {
        try {
          return resp.request().method() === 'POST'
            && resp.url().includes('appointments-for-family');
        } catch { return false; }
      },
      { timeout: 10000 }
    ).catch(() => null);
    if (submitResponse) {
      info(`[FAST FLOW] Phase 3: late response captured (${Date.now() - submitStart}ms) — parsing it`);
    }
  }

  if (submitResponse) {
    try {
      // Check for 524 Cloudflare timeout first
      const respStatus = submitResponse.status();
      if (respStatus === 524) {
        const elapsed = Date.now() - submitStart;
        warn(`[FAST FLOW] Phase 3: server timeout (HTTP 524) after ${elapsed}ms — server overloaded`);
        client('❌', 'Server timed out — moving on...');
        return { success: false, error: 'server_timeout_524' };
      }
      if (respStatus === 429) {
        const elapsed = Date.now() - submitStart;
        warn(`[FAST FLOW] Phase 3: rate limited (HTTP 429) after ${elapsed}ms`);
        client('❌', 'Rate limited by the server — slowing down...');
        return { success: false, error: 'rate_limited_429' };
      }

      const body = await submitResponse.text().catch(() => '');
      const parsed = extractJsonFromHtml(body);
      if (parsed) {
        const elapsed = Date.now() - submitStart;
        info(`[FAST FLOW] Phase 3: response parsed (${elapsed}ms): AllScheduled=${parsed.AllScheduled}, HasError=${parsed.HasError}, RedirectStub=${parsed.RedirectStub || 'none'}`);
        if (parsed.HasError && !parsed.AllScheduled) {
          const errMsg = parsed.Errors?.m_StringValue || 'unknown error';
          warn(`[FAST FLOW] Phase 3: submit FAILED — ${errMsg}`);
          // 'slot_gone' = the slot was taken by someone else between our
          // entries read and our submit. The date may still have inventory —
          // the caller retries on the page's post-failure entries refresh.
          // 'throttled' = app-level load shedding ("processing too many
          // requests"). The slot often survives for minutes — the caller
          // cools off and retries the same date.
          const code = /no longer available/i.test(errMsg)
            ? 'slot_gone' as const
            : /too many requests/i.test(errMsg) ? 'throttled' as const : undefined;
          // Client log = verdict only; the raw server message stays in warn().
          if (code === 'slot_gone') {
            client('❌', `Slot at ${entry.Time} was taken — checking for another...`);
          } else if (code === 'throttled') {
            client('⏱️', 'Server busy — it is processing too many requests...');
          } else {
            client('❌', `Submit failed: ${errMsg}`);
          }
          return { success: false, error: errMsg, code };
        }
        if (parsed.AllScheduled) {
          info(`[FAST FLOW] Phase 3: submit SUCCESS (AllScheduled=true) in ${elapsed}ms`);
          return { success: true, redirectStub: parsed.RedirectStub || '' };
        }
        // Neither AllScheduled nor HasError — check navigation
        info(`[FAST FLOW] Phase 3: response unclear, checking navigation...`);
      } else {
        // Empty body or non-JSON body — log it for debugging
        info(`[FAST FLOW] Phase 3: response has no JSON (bodyLen=${body.length}), checking navigation...`);
        if (body.length > 0 && body.length < 500) {
          // Log short bodies (like the 270-byte error response) for debugging
          info(`[FAST FLOW] Phase 3: short response body: ${body.substring(0, 300)}`);
        }
      }
    } catch { /* response body not available */ }
  }

  // ── Step 6: Check if navigation happened (success redirect to /en-US/schedule/) ──
  await navPromise;
  const finalUrl = page.url();
  const elapsed = Date.now() - submitStart;
  if (finalUrl.includes('/schedule') && !finalUrl.includes('/ofc-schedule')) {
    info(`[FAST FLOW] Phase 3: submit SUCCESS — navigated to ${finalUrl} (${elapsed}ms)`);
    return { success: true };
  }

  warn(`[FAST FLOW] Phase 3: submit did not navigate to consular page (url=${finalUrl}, ${elapsed}ms)`);
  client('❌', 'No answer from the server — moving on...');
  return { success: false, error: 'did not navigate to consular page' };
}

// =============================================================================
// EXPERIMENTAL: wire-replay booking (EXP_WIRE_SUBMIT)
// =============================================================================
// The desktop page's jsdata/onClickSubmit are NOT live globals (the PCF control
// re-injects its HTML via innerHTML — the script tags never execute), so we
// cannot call the page functions directly. Instead we replay the page's OWN
// wire protocol via same-origin fetch():
//
//   entries: get-family-ofc-schedule-entries        {scheduleDayId, Token:T1, Date}
//   submit:  schedule-ofc-appointments-for-family   {Num, Token:T2, identity fields}
//
// T1 is captured from the page's own getScheduleDays response (city select).
// T2 comes fresh from each entries response — we refire entries to retoken
// after a failed submit instead of abandoning the date (the old DOM path
// couldn't do this because re-clicking a selected date refires nothing).
// Zero DOM clicks → immune to stale cells, detached bindings and click races,
// and a manual user click on the page can no longer corrupt our submit state.
//
// ORDER: runs AFTER the DOM fast-flow (proven click submit) as a backup when
// the DOM path exhausts all dates. REMOVAL: set EXP_WIRE_SUBMIT = false —
// the DOM fast-flow is untouched either way.
const EXP_WIRE_SUBMIT = false;
const EXP_WIRE_MAX_SUBMITS_PER_DATE = 5;

type WireEntriesResult = {
  ok: boolean;
  blocked?: boolean;    // CF edge 403/429 — session-level problem, DOM won't help
  transport?: boolean;  // fetch aborted / non-HTTP / unparseable → DOM fallback
  entries: ScheduleEntry[];
  token: string;
};

async function wireCustomAction(
  page: Page,
  appd: string,
  route: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<{ status: number; text: string }> {
  return page.evaluate(async (a: any) => {
    const url = '/en-US/custom-actions/?route=' + encodeURIComponent(a.route) +
      '&appd=' + a.appd + '&cacheString=' + Date.now();
    // The page's jQuery sends `parameters=` + RAW JSON (not URL-encoded) —
    // match it byte-for-byte.
    const body = 'parameters=' + JSON.stringify(a.params);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), a.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body
      });
      return { status: resp.status, text: await resp.text() };
    } catch (e) {
      return { status: -1, text: String(e) };
    } finally {
      clearTimeout(timer);
    }
  }, { appd, route, params, timeoutMs });
}

/**
 * Replicates the page's exact Date conversion from getScheduleEntries():
 *   var localDate = new Date(jsdata.Date);
 *   var utcDate = new Date(Date.UTC(localDate.getFullYear(), localDate.getMonth(),
 *     localDate.getDate(), localDate.getHours(), localDate.getMinutes(), localDate.getSeconds()));
 *   jsdata.Date = utcDate.toISOString();
 * i.e. the wall-clock fields are reinterpreted as UTC and serialized.
 */
function pageStyleUtcIso(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return new Date(Date.UTC(
    d.getFullYear(), d.getMonth(), d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds()
  )).toISOString();
}

/** Direct fetch of get-family-ofc-schedule-entries — replaces the date-cell click. */
async function wireFetchEntries(
  page: Page,
  ctx: PageContext,
  day: ScheduleDay,
  daysToken: string
): Promise<WireEntriesResult> {
  // Mirrors the page's jsdata byte-for-byte: getScheduleEntries() nulls the
  // identity fields, sets isReschedule:"false" (string, not boolean), and
  // sends the ISO-converted Date.
  const resp = await wireCustomAction(page, ctx.appd,
    '/api/v1/schedule-group/get-family-ofc-schedule-entries',
    {
      primaryId: null,
      applications: null,
      scheduleDayId: day.ID,
      scheduleEntryId: '',
      postId: null,
      isReschedule: 'false',
      Token: daysToken,
      Date: pageStyleUtcIso(day.Date)
    }, 60000);

  if (resp.status === 403 || resp.status === 429) {
    warn(`[WIRE FLOW] entries HTTP ${resp.status} for ${day.Date.substring(0, 10)}`);
    return { ok: false, blocked: true, entries: [], token: '' };
  }
  if (resp.status < 0 || resp.status >= 500) {
    warn(`[WIRE FLOW] entries transport failure (status=${resp.status}) for ${day.Date.substring(0, 10)}: ${resp.text.substring(0, 120)}`);
    return { ok: false, transport: true, entries: [], token: '' };
  }
  const parsed = extractJsonFromHtml(resp.text);
  if (!parsed) {
    warn(`[WIRE FLOW] entries response unparseable for ${day.Date.substring(0, 10)} (len=${resp.text.length})`);
    return { ok: false, transport: true, entries: [], token: '' };
  }
  if (parsed.HasError) {
    info(`[WIRE FLOW] entries HasError for ${day.Date.substring(0, 10)}: ${String(parsed.Errors?.m_StringValue || '').substring(0, 120)}`);
  }
  const entries: ScheduleEntry[] = (parsed.ScheduleEntries || []).map((e: any) => ({
    Num: String(e.Num ?? e.EntryNum ?? e.ID ?? ''),
    Time: String(e.Time ?? e.ScheduleTime ?? e.SlotTime ?? ''),
    EntriesAvailable: Number(e.EntriesAvailable ?? e.Available ?? e.Capacity ?? 0)
  }));
  return { ok: true, entries, token: String(parsed.Token || '') };
}

/** Direct fetch submit — replicates the page's jsdata payload + Token2. */
async function wireSubmit(
  page: Page,
  ctx: PageContext,
  day: ScheduleDay,
  entry: ScheduleEntry,
  entriesToken: string,
  timeoutMs: number
): Promise<{ ok: boolean; redirectStub?: string; error?: string; blocked?: boolean; transport?: boolean }> {
  // Mirrors the page's real submit payload: identity fields stay null (the
  // Token carries the context), isReschedule is DELETED by the entries
  // success handler before submit, and Date is the ISO-converted value.
  const resp = await wireCustomAction(page, ctx.appd,
    '/api/v1/schedule-group/schedule-ofc-appointments-for-family',
    {
      primaryId: null,
      applications: null,
      scheduleDayId: day.ID,
      scheduleEntryId: '',
      postId: null,
      Num: entry.Num,
      Token: entriesToken,
      Date: pageStyleUtcIso(day.Date)
    }, timeoutMs);

  if (resp.status === 403 || resp.status === 429) {
    return { ok: false, blocked: true, error: `http_${resp.status}` };
  }
  if (resp.status < 0 || resp.status >= 500) {
    return { ok: false, transport: true, error: `transport_${resp.status}` };
  }
  const parsed = extractJsonFromHtml(resp.text);
  if (!parsed) {
    return { ok: false, transport: true, error: 'unparseable_response' };
  }
  if (parsed.AllScheduled) {
    return { ok: true, redirectStub: parsed.RedirectStub || '' };
  }
  const errMsg = parsed.Errors?.m_StringValue || (parsed.HasError ? 'has_error' : 'unknown');
  return { ok: false, error: String(errMsg).substring(0, 200) };
}

/**
 * Experimental wire-replay booking over the in-range schedule days.
 * Returns a DirectApiResult when it produced a definitive outcome, or null
 * when the wire path is fundamentally broken (caller should use DOM clicks).
 */
async function runWireBookingFlow(
  page: Page,
  ctx: PageContext,
  matchingDates: ScheduleDay[],
  config: AutomationConfig
): Promise<DirectApiResult | null> {
  // Prefer the freshest captured token. The days-level token captured at
  // city-select time is consumed long before wire replay runs — replaying
  // with it produced PSE0601 on every call. Each entries response carries
  // a fresh token, so the entries token is the live one by this point.
  const daysToken = capturedEntriesToken || capturedScheduleToken || '';
  if (!daysToken) {
    info('[WIRE FLOW] No captured Token — cannot replay entries calls');
    return null;
  }

  let firstEntriesCall = true;
  for (let di = 0; di < matchingDates.length; di++) {
    const date = matchingDates[di];
    const dateStr = date.Date.substring(0, 10);
    info(`[WIRE FLOW] Date ${di + 1}/${matchingDates.length}: ${dateStr} — fetching entries via wire`);

    let entriesRes = await wireFetchEntries(page, ctx, date, daysToken);
    if (entriesRes.blocked) {
      return { success: false, fallback: true, reason: 'blocked' };
    }
    if (!entriesRes.ok) {
      // Wire transport dead on the very first entries call → wire path broken,
      // hand the whole attempt to the DOM fast-flow.
      if (firstEntriesCall) return null;
      continue;
    }
    firstEntriesCall = false;

    if (entriesRes.entries.length === 0) {
      info(`[WIRE FLOW] 0 slots on ${dateStr} — next date`);
      continue;
    }

    // Earliest date stays the priority (dates are already sorted). Slot order
    // honors the user's preferLeastSlots setting — same as the DOM path.
    const sorted = sortScheduleEntries(entriesRes.entries, config.appointment.preferredTime, config.preferLeastSlots);
    const orderLabel = config.preferLeastSlots ? 'least-available first' : 'most-available first';
    info(`[WIRE FLOW] ${sorted.length} slot(s) on ${dateStr} (${orderLabel}): ${sorted.map(e => `${e.Time}(avail=${e.EntriesAvailable})`).join(', ')}`);

    // Seat-count filter — a family can't book into an entry with fewer seats
    // than members (the page's own validateSlotCount enforces this).
    // Unknown member count → 1 (filters zero-availability entries only).
    const memberCount = Math.max(1, ctx.applications.length);
    const eligible = sorted.filter(e => e.EntriesAvailable >= memberCount);
    if (eligible.length === 0) {
      info(`[WIRE FLOW] All ${sorted.length} slot(s) on ${dateStr} below member count ${memberCount} — next date`);
      continue;
    }
    client('🎯', `Slot found! Date: ${dateStr}, ${eligible.length} slot(s) — trying ${eligible[0].Time} first`);

    let entriesToken = entriesRes.token;
    let submits = 0;
    for (const entry of eligible) {
      if (submits >= EXP_WIRE_MAX_SUBMITS_PER_DATE) break;
      submits += 1;
      info(`[WIRE FLOW] Submit ${submits}/${Math.min(eligible.length, EXP_WIRE_MAX_SUBMITS_PER_DATE)}: ${dateStr} @ ${entry.Time} (Num=${entry.Num}, avail=${entry.EntriesAvailable})`);
      client('⏳', `Submitting OFC appointment for ${dateStr} at ${entry.Time}...`);

      const timeoutMs = di === 0 && submits === 1 ? 60000 : 45000;
      const sub = await wireSubmit(page, ctx, date, entry, entriesToken, timeoutMs);

      if (sub.ok) {
        info(`[WIRE FLOW] *** OFC BOOKED *** Date=${dateStr} Time=${entry.Time}`);
        if (sub.redirectStub) {
          await page.goto(`/en-US/${sub.redirectStub}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
        }
        return { success: true, fallback: false, redirectStub: sub.redirectStub, bookedDate: date.Date, bookedTime: entry.Time };
      }
      if (sub.blocked) {
        return { success: false, fallback: true, reason: 'blocked' };
      }

      // Hard errors (PSE0602/0610/0612) are checked BEFORE retokening —
      // refiring entries on a hard stop is a wasted, logged request.
      const errStr = (sub.error || '').toLowerCase();
      if (errStr.includes('pse0602') || errStr.includes('pse0612') || errStr.includes('pse0610')) {
        warn(`[WIRE FLOW] Hard submit error ${sub.error} — stopping retries for this city`);
        return { success: false, fallback: false, reason: 'hard_error' };
      }

      warn(`[WIRE FLOW] Submit failed (${sub.error || 'unknown'}) — retokening via fresh entries call`);
      if (sub.transport) {
        // Our fetch call itself failed while entries calls work — possible
        // payload shape problem. Let the DOM click path take this attempt.
        return null;
      }
      // Refire entries for a fresh T2 — also confirms the slot still exists.
      const gapMs = 800 + Math.floor(Math.random() * 700);
      await page.waitForTimeout(gapMs);
      const re = await wireFetchEntries(page, ctx, date, daysToken);
      if (re.blocked) return { success: false, fallback: true, reason: 'blocked' };
      if (re.ok) {
        entriesToken = re.token || entriesToken;
        const fresh = re.entries.find(e => e.Num === entry.Num);
        if (!fresh) {
          info(`[WIRE FLOW] Slot ${entry.Time} no longer listed — skipping`);
          continue;
        }
        if (fresh.EntriesAvailable < memberCount) {
          info(`[WIRE FLOW] Slot ${entry.Time} now below member count ${memberCount} — skipping`);
          continue;
        }
      }
    }
  }

  info(`[WIRE FLOW] All ${matchingDates.length} date(s) exhausted`);
  return { success: false, fallback: false, reason: 'all_exhausted' };
}

// =============================================================================
// Main flow — 3-phase fast booking
// =============================================================================

/**
 * Fast OFC booking flow — 3 phases:
 *
 * Phase 1: City selection (done by caller before this function)
 *   - Caller sets #post_select and calls onPostChange()
 *   - Page makes getScheduleDays API call → we capture days + Token1
 *
 * Phase 2: Date click
 *   - For each matching date, Playwright clicks the date cell
 *   - Page makes getScheduleEntries API call → we capture entries + Token2
 *
 * Phase 3: Submit
 *   - Set jsdata.Num = entry.Num directly (no radio button click)
 *   - Call onClickSubmit() (page's jQuery $.ajax submit)
 *   - Wait for response or navigation
 *
 * Fallback: if any phase fails, return { fallback: true } so the caller
 * falls through to the DOM flow in index.ts.
 */
export async function runDirectOfcFlow(page: Page, config: AutomationConfig): Promise<DirectApiResult> {
  const flowStart = Date.now();

  // Phase 1: Extract page context (primaryId, appd, postId, applications)
  const ctx = await extractPageContext(page);
  if (!ctx) {
    return { success: false, fallback: true, reason: 'no_context' };
  }
  flowMemberCount = Math.max(1, ctx.applications.length);

  // Get captured schedule days from the page's own getScheduleDays response
  if (!capturedScheduleDays || capturedScheduleDays.length === 0) {
    info('[FAST FLOW] No schedule days available');
    return { success: false, fallback: false, reason: 'no_slots' };
  }

  // EXPERIMENTAL: avoidEarliestDate — reorder [2nd, 1st, ...] when the 2nd
  // date is within the working-day window. No-op when disabled/one date.
  // datesReordered feeds outcome logging (promoted = tried-first 2nd date).
  const filteredDates = filterExcludedDates(
    filterScheduleDays(capturedScheduleDays, config),
    d => d.Date.substring(0, 10),
    config
  );
  const matchingDates = orderDatesForAttempt(
    filteredDates,
    d => d.Date.substring(0, 10),
    config.avoidEarliestDate,
    { path: 'fast', profile: config.username, postId: ctx.postId }
  );
  const datesReordered = matchingDates !== filteredDates;
  if (matchingDates.length === 0) {
    info('[FAST FLOW] No dates matching configured range');
    client('📅', 'Calendar has dates, but none in your configured range — waiting for more...');
    return { success: false, fallback: false, reason: 'no_dates_in_range' };
  }

  info(`[FAST FLOW] ${matchingDates.length} date(s) in range: ${matchingDates.map(d => d.Date.substring(0, 10)).join(', ')}`);
  client('📅', `${matchingDates.length} date(s) in your range — checking now...`);

  // If we already have captured entries (from a previous date click), skip the delay
  const hasCapturedEntries = capturedScheduleEntries && capturedScheduleEntries.length > 0;
  if (hasCapturedEntries) {
    info(`[FAST FLOW] Already have ${capturedScheduleEntries!.length} captured entries — skipping delay`);
  } else {
    // Minimal delay before first date click
    const initialDelay = 50 + Math.floor(Math.random() * 100);
    await page.waitForTimeout(initialDelay);
  }

  // Phase 2 + 3: For each date, click → capture entries → submit
  for (let di = 0; di < matchingDates.length; di++) {
    const date = matchingDates[di];
    const isLastDate = di === matchingDates.length - 1;
    const dateStr10 = date.Date.substring(0, 10);

    // Phase 2: Click date and capture entries
    client('📅', `Checking ${dateStr10} for time slots...`);
    const entriesResult = await clickDateAndGetEntries(page, date);
    if (!entriesResult || entriesResult.entries.length === 0) {
      info(`[FAST FLOW] No time slots for ${dateStr10}, moving to next date`);
      const tail = isLastDate ? 'no more dates in range' : 'checking next date...';
      client('📅', entriesResult
        ? `No time slots on ${dateStr10} — ${tail}`
        : `No response for ${dateStr10} — ${tail}`);
      // EXPERIMENTAL
      recordDateExperiment({ type: 'outcome', path: 'fast', profile: config.username, postId: ctx.postId, date: dateStr10, pos: di + 1, promoted: datesReordered && di === 0, result: entriesResult ? 'no_entries' : 'no_response' });
      continue;
    }

    // Sort entries by preferred time + availability, then drop entries with
    // fewer seats than the family needs (page's validateSlotCount logic).
    // Unknown member count → 1 (only zero-availability entries are dropped).
    const sortedEntries = sortScheduleEntries(entriesResult.entries, config.appointment.preferredTime, config.preferLeastSlots);
    const memberCount = Math.max(1, ctx.applications.length);
    const eligibleEntries = sortedEntries.filter(e => e.EntriesAvailable >= memberCount);
    info(`[FAST FLOW] ${sortedEntries.length} time slot(s) for ${date.Date.substring(0, 10)} (${eligibleEntries.length} seat-eligible): ${sortedEntries.map(e => `${e.Time}(avail=${e.EntriesAvailable})`).join(', ')}`);
    if (eligibleEntries.length === 0) {
      info(`[FAST FLOW] All slots on ${dateStr10} below member count ${memberCount} — next date`);
      client('📅', `Slots on ${dateStr10} have fewer seats than your group needs — ${isLastDate ? 'no more dates in range' : 'checking next date...'}`);
      // EXPERIMENTAL
      recordDateExperiment({ type: 'outcome', path: 'fast', profile: config.username, postId: ctx.postId, date: dateStr10, pos: di + 1, promoted: datesReordered && di === 0, result: 'no_eligible', entries: sortedEntries.length });
      continue;
    }
    {
      const best = eligibleEntries[0];
      client('🎯', `${eligibleEntries.length} slot(s) on ${dateStr10} — trying ${best.Time} (${best.EntriesAvailable} seats)`);
    }

    // Phase 3: Submit the BEST slot for this date.
    //
    // STRATEGY: Try only the best (highest-availability) slot per date.
    // After a failed submit the Token is consumed AND the page fires its
    // own entries refresh + auto-resubmit — so instead of re-submitting a
    // stale selection we take ONE extra shot at a different slot from the
    // page's fresh capture (see the slot_gone retry below), then move on.
    // Clicking a DIFFERENT date triggers a new getScheduleEntries call;
    // re-clicking the same date does not.
    //
    // If only 1 date is available and it fails, we return all_exhausted so
    // the caller re-selects the city (full refresh, new getScheduleDays).
    const entry = eligibleEntries[0]; // best seat-eligible slot
    info(`[FAST FLOW] Submitting best slot for ${dateStr10}: '${entry.Time}' (Num=${entry.Num}, avail=${entry.EntriesAvailable})`);
    client('⏳', `Submitting ${dateStr10} at ${entry.Time} — waiting for server...`);

    const confirmBooking = async (r: { redirectStub?: string }, d: ScheduleDay, e: ScheduleEntry): Promise<DirectApiResult> => {
      const elapsed = Date.now() - flowStart;
      info(`[FAST FLOW] *** OFC BOOKED in ${elapsed}ms *** Date=${d.Date.substring(0, 10)} Time=${e.Time}`);
      if (r.redirectStub) {
        const redirectUrl = `/en-US/${r.redirectStub}`;
        info(`[FAST FLOW] Navigating to ${redirectUrl}`);
        await page.goto(redirectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
      }
      return { success: true, fallback: false, redirectStub: r.redirectStub, bookedDate: d.Date, bookedTime: e.Time };
    };

    // First date gets 60s timeout (server can take 100+ seconds, but we
    // can't wait that long). Subsequent dates get 30s. Do NOT shorten —
    // a loaded server still delivers success slowly; failures already
    // arrive fast and are handled by their error response, not timeouts.
    const responseTimeoutMs = di === 0 ? 60000 : 30000;
    const result = await submitViaPageFunction(page, entry, entriesResult.token, { responseTimeoutMs });
    // EXPERIMENTAL
    recordDateExperiment({ type: 'outcome', path: 'fast', profile: config.username, postId: ctx.postId, date: dateStr10, pos: di + 1, promoted: datesReordered && di === 0, result: result.success ? 'booked' : (result.code || 'error'), time: entry.Time, entries: sortedEntries.length, eligible: eligibleEntries.length });

    if (result.success) {
      return confirmBooking(result, date, entry);
    }

    // Submit failed — move to next date (don't try more slots on this date)
    warn(`[FAST FLOW] Submit failed for '${entry.Time}' on ${dateStr10}: ${result.error || 'unknown'}`);

    // ── Same-date retry on 'slot_gone' / 'throttled' ─────────────────────
    // Verified site behavior: after a failed submit the page itself fires
    // a fresh getScheduleEntries (fresh slots + fresh token) plus its own
    // auto-resubmit of the dead slot. Wait for that resubmit to drain,
    // grab the fresh capture, and take ONE more shot at a remaining slot
    // on this date before moving on.
    //
    // 'throttled' differs: the rejection was load, not loss — the SAME
    // slot often stays listed for minutes, so it stays eligible, and we
    // cool off 20-30s first (the endpoint is shedding requests).
    if (result.code === 'slot_gone' || result.code === 'throttled') {
      const genBefore = entriesCaptureGen;
      const drained = await waitForSubmitQuiesce(8000);
      if (!drained) warn('[FAST FLOW] submits still in flight after 8s — retrying anyway');

      // The page's OWN auto-resubmit may have landed the booking while we
      // waited — if we reached the consular page, count it as success.
      const postQuiesceUrl = page.url();
      if (postQuiesceUrl.includes('/schedule') && !postQuiesceUrl.includes('/ofc-schedule')) {
        info(`[FAST FLOW] Page's own resubmit navigated to ${postQuiesceUrl} during settle — booked`);
        return confirmBooking({}, date, entry);
      }

      if (result.code === 'throttled') {
        const coolMs = 20000 + Math.floor(Math.random() * 10000);
        info(`[FAST FLOW] Server throttled submit — cooling off ${(coolMs / 1000).toFixed(0)}s before same-date retry`);
        client('⏱️', `Server busy — waiting ${(coolMs / 1000).toFixed(0)}s before retrying ${dateStr10}...`);
        await page.waitForTimeout(coolMs);
      }

      const gotFresh = await waitForNextEntriesCapture(genBefore, 5000);
      const snap = gotFresh ? getCapturedEntriesSnapshot() : null;
      const retryCands = snap
        ? sortScheduleEntries(
            snap.entries.filter(e =>
              (result.code === 'throttled' || e.Num !== entry.Num) &&
              e.EntriesAvailable >= memberCount),
            config.appointment.preferredTime, config.preferLeastSlots)
        : [];
      if (retryCands.length > 0) {
        const next = retryCands[0];
        info(`[FAST FLOW] Post-failure refresh: ${retryCands.length} slot(s) remain on ${dateStr10} — retrying '${next.Time}' (Num=${next.Num}, avail=${next.EntriesAvailable})`);
        client('🔁', `Retrying ${dateStr10} at ${next.Time}...`);
        // Brief settle so the refreshed time table finishes rendering.
        await page.waitForTimeout(600);
        const retryResult = await submitViaPageFunction(page, next, snap!.token, { responseTimeoutMs: 30000 });
        // EXPERIMENTAL
        recordDateExperiment({ type: 'outcome', path: 'fast', profile: config.username, postId: ctx.postId, date: dateStr10, pos: di + 1, promoted: datesReordered && di === 0, result: retryResult.success ? 'booked_retry' : (retryResult.code || 'retry_error'), time: next.Time });
        if (retryResult.success) {
          return confirmBooking(retryResult, date, next);
        }
        warn(`[FAST FLOW] Same-date retry failed for '${next.Time}' on ${dateStr10}: ${retryResult.error || 'unknown'}`);
      } else {
        info(`[FAST FLOW] Post-failure refresh: no seat-eligible slots remain on ${dateStr10}`);
      }
    }

    // If the error is a hard error (PSE0602, PSE0612, PSE0610), stop entirely
    const errStr = (result.error || '').toLowerCase();
    if (errStr.includes('pse0602') || errStr.includes('pse0612') || errStr.includes('pse0610')) {
      warn(`[FAST FLOW] Hard error — stopping submit attempts for this city`);
      client('⚠️', 'Server reported a permanent error — skipping this city...');
      return { success: false, fallback: false, reason: 'hard_error' };
    }

    // If server timeout (524), wait longer before next date — server is overloaded
    if (errStr.includes('524') || errStr.includes('server_timeout')) {
      warn(`[FAST FLOW] Server timeout — waiting 5s before next date (server overloaded)`);
      await page.waitForTimeout(5000);
    } else if (errStr.includes('429') || errStr.includes('rate_limited')) {
      warn(`[FAST FLOW] Rate limited — waiting 5s before next date`);
      await page.waitForTimeout(5000);
    } else if (errStr.includes('too many requests')) {
      // App-level throttle — the submit endpoint is shedding load; the next
      // date's submit would hit the same wall, so give it breathing room.
      warn(`[FAST FLOW] Submit throttled — waiting 10s before next date`);
      await page.waitForTimeout(10000);
    }

    // Verdict for the date, then a brief pause (rate-limit avoidance)
    client('❌', `Booking not confirmed for ${dateStr10} — ${isLastDate ? 'no more dates in range' : 'trying next date...'}`);
    if (!isLastDate) {
      const gapMs = 1000 + Math.floor(Math.random() * 1000);
      info(`[FAST FLOW] Moving to next date, waiting ${gapMs}ms`);
      await page.waitForTimeout(gapMs);
    }
  }

  // ===== EXPERIMENTAL WIRE-REPLAY (EXP_WIRE_SUBMIT) — BACKUP =====
  // DOM fast-flow exhausted all dates without booking. The wire replay doesn't
  // need rendered DOM (no radios, no clicks), so it can still book when the
  // click path failed on render/radio problems — and it can retoken to retry
  // slots on dates the DOM path burned. Skipped on hard_error/success above.
  if (EXP_WIRE_SUBMIT) {
    // The page may still have its own auto-resubmits in flight after the
    // failed DOM submits — replaying wire calls against a session that is
    // mid-submit poisons the token/session context. Wait for a quiet page.
    const drained = await waitForSubmitQuiesce(8000);
    if (!drained) warn('[WIRE FLOW] submits still in flight after 8s — replaying anyway');
    info('[WIRE FLOW] DOM fast-flow exhausted — trying wire replay as backup');
    const wireResult = await runWireBookingFlow(page, ctx, matchingDates, config).catch((e) => {
      warn('[WIRE FLOW] Unexpected error:', e instanceof Error ? e.message : String(e));
      return null;
    });
    if (wireResult) return wireResult;
    info('[WIRE FLOW] Wire path unavailable this attempt');
  }

  const elapsed = Date.now() - flowStart;
  info(`[FAST FLOW] All ${matchingDates.length} date(s) exhausted (${elapsed}ms) — caller should re-select city for fresh state`);
  return { success: false, fallback: false, reason: 'all_exhausted' };
}

// =============================================================================
// Late-entries rescue — context-bound grace (backup path)
// =============================================================================

/**
 * Consume a pending late-entries rescue during the inter-city wait.
 *
 * Backup path only — the main flow is never delayed by this: it listens
 * inside the wait the loop already takes before the next city selection.
 * If the in-flight getScheduleEntries response lands before the deadline,
 * submit one seat-eligible slot with the captured token while the page is
 * still in this city's context (rendered radios + token both valid).
 *
 * Consumed either way; also cleared by resetCapturedScheduleData at the
 * next city selection (per-city postId/token chain dies there).
 *
 * Returns a DirectApiResult on a booked submit, or null when nothing
 * arrived / nothing eligible / submit failed — caller proceeds normally.
 */
export async function consumeLateEntriesRescue(
  page: Page,
  config: AutomationConfig,
  timeoutMs: number
): Promise<DirectApiResult | null> {
  const pending = lateEntriesRescue;
  lateEntriesRescue = null;   // single-shot — consumed even if nothing arrives
  if (!pending) return null;

  const arrived = await waitForNextEntriesCapture(pending.sinceGen, timeoutMs);
  if (!arrived) return null;

  const dateStr10 = pending.date.Date.substring(0, 10);

  // If the page navigated to consular while we waited, the booking already
  // landed (the page's own flow) — count it, don't submit again.
  const url = page.url();
  if (url.includes('/schedule') && !url.includes('/ofc-schedule')) {
    info(`[RESCUE] Page already on consular stage (${url}) — counting as booked`);
    return { success: true, fallback: false, bookedDate: pending.date.Date };
  }
  if (!url.includes('/ofc-schedule')) {
    warn(`[RESCUE] Page left the OFC context (${url}) — discarding late capture`);
    return null;
  }

  const snapshot = getCapturedEntriesSnapshot();
  if (!snapshot || snapshot.entries.length === 0) {
    info('[RESCUE] Late entries response arrived with 0 entries — nothing to submit');
    return null;
  }
  info(`[RESCUE] Late entries response arrived: ${snapshot.entries.length} slot(s) for ${dateStr10} — submitting before next city selection`);
  client('🎯', `Late response arrived — ${snapshot.entries.length} slot(s) on ${dateStr10}, submitting...`);

  // Never race the page's own in-flight submits.
  const drained = await waitForSubmitQuiesce(6000);
  if (!drained) warn('[RESCUE] submits still in flight after 6s — submitting anyway');

  const sortedEntries = sortScheduleEntries(snapshot.entries, config.appointment.preferredTime, config.preferLeastSlots);
  const eligibleEntries = sortedEntries.filter(e => e.EntriesAvailable >= flowMemberCount);
  if (eligibleEntries.length === 0) {
    info(`[RESCUE] No seat-eligible slot in the late capture (memberCount=${flowMemberCount})`);
    return null;
  }

  const entry = eligibleEntries[0];
  client('⏳', `Submitting rescued slot ${dateStr10} at ${entry.Time}...`);
  const result = await submitViaPageFunction(page, entry, snapshot.token, { responseTimeoutMs: 30000 });
  // EXPERIMENTAL
  recordDateExperiment({ type: 'outcome', path: 'rescue', profile: config.username, date: dateStr10, result: result.success ? 'booked' : (result.code || 'error'), time: entry.Time });
  if (result.success) {
    info(`[RESCUE] *** OFC BOOKED via late-entries rescue *** Date=${dateStr10} Time=${entry.Time}`);
    if (result.redirectStub) {
      await page.goto(`/en-US/${result.redirectStub}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    }
    return { success: true, fallback: false, redirectStub: result.redirectStub, bookedDate: pending.date.Date, bookedTime: entry.Time };
  }
  warn(`[RESCUE] Rescued submit failed for '${entry.Time}' on ${dateStr10}: ${result.error || 'unknown'}`);
  return null;
}
