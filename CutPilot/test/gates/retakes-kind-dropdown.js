/*
 * retakes-kind-dropdown.js — "Who is talking?" is the panel's own dropdown,
 * the kind Premiere's panel can always open.
 *
 * The panel moved its Accuracy and Language pickers off the browser's native
 * <select> because "a native <select> popup can refuse to open" inside
 * Premiere's panel. "Who is talking?" was still a native <select> — and it is
 * the switch that turns on the podcast protection ("Two or more people") and
 * the solo restart catching ("Just me"). If it cannot open, the owner is stuck
 * on Auto.
 *
 * Checked in the REAL panel:
 *   1. the takes card shows the panel's own dropdown for "Who is talking?",
 *      starting on Auto, and the native <select> is not shown;
 *   2. opening it and picking "Two or more people" / "Just me" is what the
 *      retake finder and Smart Cleanup then use;
 *   3. the value kept in the hidden <select> and the label shown stay in step
 *      both ways.
 *
 * Exit 0 = pass, 1 = fail, 2 = skipped (no puppeteer / Chromium).
 */
'use strict';
const H = require('./retakes-lib/harness');
const C = H.checker();

async function run() {
  console.log('"Who is talking?" opens in Premiere\'s panel');
  const browser = await H.launch();
  try {
    const { page, calls } = await H.openPanel(browser, { host: () => ({}), settings: {} });
    const r = await page.evaluate(async () => {
      const sel = document.getElementById('tk-kind');
      const host = document.getElementById('tk-kind-dd');
      const btn = host && host.querySelector('.cp-dd-btn');
      const out = { hasDD: !!btn, label0: btn ? btn.textContent : '', selShown: !!sel && getComputedStyle(sel).display !== 'none' };
      if (!btn) return out;
      const pick = async (text) => {
        btn.click();
        await new Promise(res => setTimeout(res, 30));
        const list = host.querySelector('.cp-dd-list');
        const open = !!list && !list.classList.contains('hidden');
        const item = Array.from(host.querySelectorAll('.cp-dd-item')).find(b => b.textContent.indexOf(text) === 0);
        if (item) item.click();
        await new Promise(res => setTimeout(res, 30));
        return { open, found: !!item, value: sel.value, people: window.CP_DEBUG_EXT.retakes.takesPeople([]), label: btn.textContent,
                 closed: list.classList.contains('hidden') };
      };
      out.many = await pick('Two or more people');
      out.one = await pick('Just me');
      sel.value = 'auto'; sel.dispatchEvent(new Event('change'));
      out.labelBack = btn.textContent;
      return out;
    });
    C.check('the takes card shows the panel\'s own dropdown for "Who is talking?", starting on Auto',
      r.hasDD && /^Auto/.test(r.label0), JSON.stringify(r));
    C.check('…and the native <select> is not shown', r.hasDD && !r.selShown, JSON.stringify(r));
    C.check('opening it and picking "Two or more people" → the retake finder treats it as a conversation',
      !!r.many && r.many.open && r.many.found && r.many.value === 'many' && r.many.people === 'many' && /^Two or more people/.test(r.many.label) && r.many.closed,
      JSON.stringify(r.many));
    C.check('…picking "Just me" → a lone speaker', !!r.one && r.one.value === 'one' && r.one.people === 'one' && /^Just me/.test(r.one.label), JSON.stringify(r.one));
    C.check('a value set on the hidden <select> shows in the dropdown\'s label', /^Auto/.test(r.labelBack || ''), r.labelBack);
    const errs = calls.filter(c => c.fn === '__pageerror');
    C.check('no page errors', errs.length === 0, JSON.stringify(errs));
    await page.close();
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
