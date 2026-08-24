Architecture for IVAC Visa Scheduling Automation

Overview
- Purpose: robust Playwright automation to book OFC appointments on usvisascheduling.com
- Goal: be resilient to Cloudflare, login expirations, site 403/503, and transient errors by using a UI-first resume strategy.

Core components
- `resumeFromCurrentPage(page, config)` — central state machine that inspects page and resumes from these states: internal, schedule, verification, login, security questions, home, irrelevant.
- `navigateToOfcSchedule(page, scheduleUrl)` — navigates from home to OFC schedule page. Throws if Cloudflare verification remains or schedule link not found.
- `selectCity`, `selectFirstAvailableTime`, `submitAppointment` — OFC page interaction helpers with jitter/delays and UI-driven selection.
- `chooseDateInRange` — selects dates only inside the configured `startDate`/`endDate` range, using visible available calendar cells.
- `selectCalendarMonthYear` — attempts to set calendar month/year controls when available, otherwise relies on current calendar view.
- `waitForScheduleResponse` — monitors network responses for schedule API availability (handles 200/403/429/timeouts).

Recovery strategy
- For schedule API 403 or network errors, the automation will:
  1. Attempt to click `a[title="Visa Application Home"]` if present.
  2. If link is absent, navigate to the home URL computed from the schedule URL (e.g., `https://www.usvisascheduling.com/en-US/`).
  3. Call `resumeFromCurrentPage(page, config)` to allow the state machine to drive login, Cloudflare waits, or navigate to OFC schedule as appropriate.
- This ensures that if the site has logged out (showing login), the automation will perform login and then continue.

Design notes for stability
- Prefer UI-driven actions (clicks, dispatch events) rather than assuming API state.
- Use `resumeFromCurrentPage` after any unexpected navigation or error to reduce local context assumptions.
- Take periodic screenshots and page-state dumps on errors for diagnostics (`diagnostics.saveScreenshot`, `savePageState`).

Operational guidance
- Run with `DEBUG` or `--debug-network` enabled to capture request/response logs.
- Use small jitter (`randomDelay`) on UI interactions to avoid deterministic patterns.
- Configure `maxDateAttempts` and `getCityRefreshDelayMs` to tune retry aggressiveness.
- If Cloudflare Turnstile appears, enable `autoSolveCloudflare` to let the script attempt a humanized click via `ghost-cursor`.
- The script also detects inline checkbox challenges and fallback page-level verification text, not just iframe-based Turnstile frames.
- `submitAppointment` waits for the submit button to become enabled before clicking, avoiding fixed delays and improving responsiveness.

Files to update when behavior changes
- `ARCHITECTURE.md` — this file
- `src/index.ts` — orchestrator
- `src/ofc-schedule.ts` — OFC interactions
- `src/cloudflare.ts` — verification waits

Contact
- For further improvements, create an issue describing the observed site flow and attach captured screenshots and network logs from `recordings/`.
