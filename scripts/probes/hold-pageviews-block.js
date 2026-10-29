// Persistent helper for a running profile session (CDP_PORT).
// 1) Route-fulfills /api/v1/page-views/* with {canViewPage:true} — the view
//    counter never increments and the page never removes #page_form.
// 2) On schedule pages where the server emitted a skeleton (no #page_form),
//    injects the form markup and calls the page's own onPageLoad() so the
//    calendar + city select work again (API layer is not locked).
const { chromium } = require('patchright');
const PORT = process.env.CDP_PORT || '9227';
const BODY = '{"showWarning":false,"canViewPage":true}';
const tag = () => `[${new Date().toISOString().slice(11,19)}]`;
const FORM_HTML =
  '<div class="row" id="group_header_row"><div class="col-sm-12"><ul id="gm_select" class="list-group mb-2"></ul></div></div>' +
  '<div class="row mb-2"><div class="col-sm-4"><label>Post</label><select id="post_select" class="form-control"></select></div></div>' +
  '<div class="row" id="calendar_header_row"><div class="col-sm-12"><span id="datepicker-message" class="font-weight-bold"></span><input type="hidden" id="datepicker-input"></div></div>' +
  '<div class="row"><div class="col-sm-6"><div id="datepicker"></div></div><div class="col-sm-6"><div id="time_select"></div></div></div>' +
  '<div class="row mt-3"><div class="col-sm-12"><button id="submitbtn" type="button" class="btn btn-primary" onclick="onClickSubmit()">Submit</button></div></div>';

const INJECT_JS = `(function(){
  if (document.getElementById('page_form')) return 'present';
  if (typeof onPageLoad !== 'function') return 'no-onPageLoad';
  var mc = document.getElementById('main_container');
  if (!mc || !mc.innerText) return 'no-main';
  var d = document.createElement('div');
  d.id = 'page_form';
  d.innerHTML = ${JSON.stringify(FORM_HTML)};
  mc.appendChild(d);
  onPageLoad();
  return 'injected';
})()`;

async function sweep(ctx) {
  for (const page of ctx.pages()) {
    try {
      const u = page.url();
      if (!u.includes('/schedule') && !u.includes('ofc-schedule')) continue;
      const cdp = await ctx.newCDPSession(page);
      const r = await cdp.send('Runtime.evaluate', { expression: INJECT_JS, returnByValue: true });
      if (r.result.value === 'injected') console.log(tag(), 'form injected on', u.slice(0, 80));
    } catch {}
  }
}

async function attach() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no context');
  await ctx.route('**/api/v1/page-views/**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: BODY });
  });
  console.log(tag(), 'route armed on', PORT);
  const timer = setInterval(() => sweep(ctx).catch(() => {}), 8000);
  await sweep(ctx);
  browser.on('disconnected', () => { clearInterval(timer); console.log(tag(), 'disconnected — retrying'); retrySoon(); });
}
let retryTimer = null;
function retrySoon() { if (!retryTimer) retryTimer = setTimeout(main, 5000); }
async function main() { retryTimer = null; try { await attach(); } catch (e) { console.log(tag(), 'attach failed:', e.message); retrySoon(); } }
main();
