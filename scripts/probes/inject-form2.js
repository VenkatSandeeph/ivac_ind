const { chromium } = require('patchright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9227');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('usvisascheduling')) || ctx.pages()[0];
  await page.goto('https://www.usvisascheduling.com/en-US/schedule/?reschedule=true', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('goto:', e.message));
  await page.waitForTimeout(7000);
  const cdp = await ctx.newCDPSession(page);
  console.log('now on:', page.url().slice(0, 80));

  const inj = await cdp.send('Runtime.evaluate', {
    expression: `(function(){
      if (document.getElementById('page_form')) return 'already-present';
      if (typeof onPageLoad !== 'function') return 'onPageLoad missing on ' + location.href;
      var mc = document.getElementById('main_container') || document.body;
      var d = document.createElement('div');
      d.id = 'page_form';
      d.innerHTML =
        '<div class="row" id="group_header_row"><div class="col-sm-12"><ul id="gm_select" class="list-group mb-2"></ul></div></div>' +
        '<div class="row mb-2"><div class="col-sm-4"><label>Post</label><select id="post_select" class="form-control"></select></div></div>' +
        '<div class="row" id="calendar_header_row"><div class="col-sm-12"><span id="datepicker-message" class="font-weight-bold"></span><input type="hidden" id="datepicker-input"></div></div>' +
        '<div class="row"><div class="col-sm-6"><div id="datepicker"></div></div><div class="col-sm-6"><div id="time_select"></div></div></div>' +
        '<div class="row mt-3"><div class="col-sm-12"><button id="submitbtn" type="button" class="btn btn-primary" onclick="onClickSubmit()">Submit</button></div></div>';
      mc.appendChild(d);
      onPageLoad();
      return 'injected + onPageLoad() called';
    })()`, returnByValue: true });
  console.log('inject:', inj.result.value);

  await new Promise(r => setTimeout(r, 12000));
  const st = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
      form: !!document.getElementById('page_form'),
      postOptions: document.getElementById('post_select') ? document.getElementById('post_select').options.length : 0,
      postVals: document.getElementById('post_select') ? Array.from(document.getElementById('post_select').options).map(o=>o.text).slice(0,8) : [],
      members: document.getElementById('gm_select') ? document.getElementById('gm_select').children.length : 0,
      dpMsg: document.getElementById('datepicker-message') ? document.getElementById('datepicker-message').innerText.slice(0,60) : '(none)',
      dpCells: document.querySelectorAll('#datepicker td').length,
      greenDays: document.querySelectorAll('#datepicker .greenday').length,
      postId: typeof jsdata!=='undefined' ? jsdata.postId : null,
      apps: typeof applications!=='undefined' ? applications.length : null,
      errorRow: document.getElementById('error_row') ? document.getElementById('error_row').innerText.trim().slice(0,120) : '(none)'
    })`, returnByValue: true });
  console.log(JSON.parse(st.result.value));
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
