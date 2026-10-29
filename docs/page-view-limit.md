# Page-View Limit & Form Suppression — decoded and handled (Oct 2026)

Two DIFFERENT suppression mechanisms strip the booking form on `usvisascheduling.com`
schedule pages. They look identical to a user (no city select, no calendar, warning
banner) but work differently and need different counters.

## Mechanism 1 — view-limit, client-side removal

The page's own `onPageLoad()` calls `schedulePageViews()`:

```js
GET /en-US/custom-actions/?route=/api/v1/page-views/schedule/single-family-schedule-page-views
    &cacheString=<ts>&parameters={"PrimaryId":"<guid>"}
→ response: { showWarning: bool, canViewPage: bool }

if (response.showWarning == true) → "approaching maximum" banner
if (response.canViewPage == false) →
    $('#error_row').html('You have exceeded the limit for viewing this page.');
    $('#page_form').remove();          // city select + calendar gone
```

Key facts (verified live on `?reschedule=true` OFC and consular pages):

- This ONE GET both **increments the server-side view counter** AND returns the
  flag that drives client-side removal. The counter's only consumer is this
  response.
- Same route name + same code path on `/en-US/ofc-schedule/` and
  `/en-US/schedule/?reschedule=true` (consular reschedule).
- Fix is a *forge*, not a block: fulfill the route locally with
  `{"showWarning":false,"canViewPage":true}` + status 200.
  - Server never sees the request → counter never increments.
  - `canViewPage:true` → `remove()` never runs → **form stays even on accounts
    already over the limit** (verified live: over-limit account re-rendered the
    full form on the very next load).
  - A bare `204` also kept the form, but only accidentally — `response.showWarning`
    throws inside their success callback before `remove()` runs. The forged 200
    is the deterministic version.
- Remaining unknown: whether `schedule-*-appointments-for-family` re-checks the
  view count at submit time. Not provable without a live submit.

## Mechanism 2 — server-side skeleton (scheduling lock)

Server emits `#main_container` with only `#error_row` (e.g. "You have only ONE
rescheduling attempt remaining…") — `#page_form`, `#post_select`, `#datepicker`,
`#time_select`, `#submitbtn` are **never in the markup**. Page JS still runs;
posts/members queries still fire and return 200.

- `jsdata`, `applications` globals ARE still emitted.
- The API layer is NOT locked — that's why consular wire mode works.
- Page-views forge CANNOT fix this — there is no form markup to keep.

### Form re-injection (verified working live)

The page's own JS can rebuild a working form — all wiring functions exist in the
emitted scripts; only the markup is missing. Inject `#page_form` then call the
page's own `onPageLoad()`:

```js
d.id = 'page_form';
d.innerHTML =
  '<div class="row" id="group_header_row"><div class="col-sm-12"><ul id="gm_select" class="list-group mb-2"></ul></div></div>' +
  '<div class="row mb-2"><div class="col-sm-4"><label>Post</label><select id="post_select" class="form-control"></select></div></div>' +
  '<div class="row" id="calendar_header_row"><div class="col-sm-12"><span id="datepicker-message"></span><input type="hidden" id="datepicker-input"></div></div>' +
  '<div class="row"><div class="col-sm-6"><div id="datepicker"></div></div><div class="col-sm-6"><div id="time_select"></div></div></div>' +
  '<div class="row mt-3"><div class="col-sm-12"><button id="submitbtn" type="button" class="btn btn-primary" onclick="onClickSubmit()">Submit</button></div></div>';
main_container.appendChild(d);
onPageLoad();   // must run in MAIN world (CDP Runtime.evaluate)
```

After `onPageLoad()`: `queryConsularPosts()` fills `#post_select` →
`.change(onPostChange)` bound → `onVisaClassSelectChange()` → members fill
`#gm_select` + `applications[]` → `onPostChange` → days → jQuery UI calendar →
entry radios → `onClickSubmit()` posts the real submit route
(`schedule-consular-appointments-for-family` or the `reschedule-` variant).

Verified live (consular reschedule skeleton): after injection → 5 post options
populated, member list filled, 2-month calendar rendered, "No Slots Available"
(real data). Once `#page_form` exists, wire mode detects "form restored" and
hands back to the DOM sweep.

Element contract used by the page JS:
- `#post_select` — select; options appended by `queryConsularPosts()` response
- `#gm_select` — ul; members injected as `<li>` by `onVisaClassSelectChange()`
- `#datepicker`, `#datepicker-message`, `#datepicker-input` — jQuery UI target
- `#time_select` — entries table target (radios `onclick="onSelectScheduleEntry"`)
- `#submitbtn` — click → `onClickSubmit()` (inline onclick works; function is global)
- jsdata keys set by handlers: `postId`, `applications`, `scheduleDayId`,
  `scheduleEntryId`/`Num`, `Date`, `Token`, `isReschedule` (reschedule pages)

Caveats:
- Injection is per-page-load — must re-run after every skeleton render (the
  holder below sweeps for it).
- `#submitbtn` stays disabled until `validateData()` passes (entry selected) —
  page's own logic, correct.
- A second `onPageLoad()` run is safe (rebinds + refires queries only).

## Where it's implemented

| Layer | File | What |
|---|---|---|
| Desktop | `src/browser.ts` `blockPageViewTelemetry()` | `context.route('**/api/v1/page-views/**')` → forged `200 {showWarning:false,canViewPage:true}` |
| Mobile | `MainActivity.kt` `shouldInterceptRequest` | same forged 200 for `/api/v1/page-views/` |
| Mobile | `JsSnippets.kt` `Js.INIT` | fetch seam → forged 200; XHR `send` swallow kept (request never exists — strongest guarantee) |
| Form injection (live patch) | `hold-pageviews-block.js` (repo root, not shipped) | detached holder: arms the forged route on a RUNNING Chrome via CDP + sweeps every 8s — injects the form + calls `onPageLoad()` on any schedule page missing `#page_form` |

### Live-patch holder usage

```powershell
# arm it on a running profile's Chrome (CDP_PORT = profile's debug port)
$env:CDP_PORT=9227 ; node hold-pageviews-block.js
# or detached (survives the session):
Start-Process node -ArgumentList 'hold-pageviews-block.js' `
  -WorkingDirectory '<repo>' -WindowStyle Hidden `
  -RedirectStandardOutput 'pv-holder.log' -RedirectStandardError 'pv-holder.err'
```

Reconnects automatically on browser disconnect. Dies on reboot — the durable
fix is shipping `browser.ts` in the next client build.

## Live-debug recipe (used for all of the above)

Attach a second Playwright client to a running profile's Chrome — read-only
unless you deliberately act:

```js
const { chromium } = require('patchright');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('usvisascheduling'));
const cdp = await ctx.newCDPSession(page);
// main-world globals + DOM (page.evaluate is isolated world — use CDP eval)
await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
// watch the site's own API traffic
await cdp.send('Network.enable');
cdp.on('Network.requestWillBeSent' / 'responseReceived', ...)
// arm a route on the EXISTING context (works on a running session)
await ctx.route('**/api/v1/page-views/**', r => r.fulfill({status:200, ...}));
```

Find live Chromes: `curl http://127.0.0.1:<port>/json/list` — profile
`chromeRemoteDebugPort` comes from `config.local.json`.
