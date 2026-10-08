/*
 * captions-options-reachable — every caption setting the owner had is on
 * screen, does something when he taps it, and is still there after Premiere
 * reopens.
 *
 * The owner: "a lot of customization options are gone from the caption tab."
 * Nothing had been deleted — it had been hidden, greyed or reset:
 *   A. picking ✏️ Editable while the ✨ Effects tab was open left 5 controls
 *      (font, size, colours, position all gone, and no tab bar to get back);
 *   B. the Caption type switch sat ~2,175 px down, below the ~40 settings
 *      ✏️ Editable hides, with nothing near the top saying so;
 *   C. a reload changed the picked style's look on 37 of 41 styles (only the
 *      style's NAME was restored; the rest fell back to the boot default), and
 *      🔠 CAPS on key words / auto-emoji / timing switch were never saved;
 *   D. greyed controls were dead clicks even where one tap could meet their
 *      reason (Box padding with no box, Outline colour with no outline);
 *   E. the Outline colour hid on 71 of 123 styles until a width was set on the
 *      OTHER tab; Box roundness and Text case were unreachable in ✏️ Editable;
 *   F. gallery sort and "✨ Suggest for" vanished in ✏️ Editable;
 *   G. hints sent the owner to "≡ Browse styles", a button that is never shown;
 *   H. ✏️ Editable captions took their text case from the 📁 Upload view, so
 *      the Styles editor's Text case changed nothing on the timeline;
 *   I. the highlight-timing nudge and "Words per caption" said what they do.
 * This gate boots the real panel in headless Chromium (read-only fake
 * Premiere host, gallery-lib) at 1080×1920 and 1920×1080 and measures each.
 * Exit 0 pass, 1 fail, 2 skipped (no browser / puppeteer / unzip).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('./gallery-lib/panel.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const RELOAD_STYLES = 42;        // the brief asks for at least 40
const LANDSCAPE_STYLES = 12;     // the same check again on a 1920×1080 sequence

/* Makes the fake host answer CP_getEnv with the size the gate picked
   (localStorage 'gate.env' = "W×H"), so a reload keeps the sequence shape.
   Also records every host call's arguments for H. */
function envShim() {
  const ce = window.__adobe_cep__;
  if (!ce || ce.__gateWrapped) return;
  const orig = ce.evalScript;
  window.__hostScripts = [];
  ce.evalScript = function (s, cb) {
    const fn = String(s).split('(')[0];
    window.__hostScripts.push(String(s));
    if (fn === 'CP_getEnv') {
      let w = 1080, h = 1920;
      try { const m = /^(\d+)x(\d+)$/.exec(localStorage.getItem('gate.env') || ''); if (m) { w = +m[1]; h = +m[2]; } } catch (e) {}
      window.__hostCalls.push(fn);
      setTimeout(() => cb(JSON.stringify({ ok: true, width: w, height: h, sequenceName: 'Seq', fps: 30 })), 0);
      return;
    }
    return orig.call(this, s, cb);
  };
  ce.__gateWrapped = true;
}

/* In the page: open a style's card in the gallery (the way the owner does). */
async function openStyle(page, id) {
  return page.evaluate(async (id) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const b = document.getElementById('btn-browse-styles'); if (b) b.click();
    await sleep(250);
    const all = Array.from(document.querySelectorAll('#lib-cats button, #lib-cats .chip')).find(x => /^\s*All\b/.test(x.textContent));
    if (all && !all.classList.contains('on')) { all.click(); await sleep(250); }
    const cv = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).find(c => c._tpl && c._tpl.id === id);
    let el = cv; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
    if (!el) return false;
    el.click(); await sleep(300);
    return true;
  }, id);
}

async function reloadPanel(page) {
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(900);
  await page.evaluate(async () => {
    const t = document.querySelector('[data-tab="captions"]'); if (t) t.click();
    await new Promise(r => setTimeout(r, 200));
  });
}

(async () => {
  const R = G.reporter('captions: every caption option is on screen, acts when tapped, and survives a reload');
  const browser = await G.launch();
  const page = await G.openPanel(browser, { cep: true, gallery: false });
  await page.evaluateOnNewDocument(envShim);
  await page.evaluate(() => { try { localStorage.removeItem('cutpilot.look'); localStorage.setItem('gate.env', '1080x1920'); } catch (e) {} });
  await reloadPanel(page);

  // styles the gallery shows (Pulse styles, not .mogrt cards)
  const ids = await page.evaluate(async () => {
    const b = document.getElementById('btn-browse-styles'); if (b) b.click();
    await new Promise(r => setTimeout(r, 400));
    const all = Array.from(document.querySelectorAll('#lib-cats button, #lib-cats .chip')).find(x => /^\s*All\b/.test(x.textContent));
    if (all) { all.click(); await new Promise(r => setTimeout(r, 400)); }
    return Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).filter(c => c._tpl && !c._tpl.mogrt).map(c => c._tpl.id);
  });
  const T = await page.evaluate(() => window.CPCaptions.TEMPLATES.map(t => ({ id: t.id, upper: !!t.uppercase, box: !!t.boxColor,
    stroke: t.strokeWidth || 0, build: !!t.build, hls: t.highlightStyle || 'color', dark: window.CPCaptions.isDarkOnLight(t), wordHl: t.wordHl })));
  const byId = Object.fromEntries(T.map(t => [t.id, t]));
  const shown = ids.filter(id => byId[id]);
  if (shown.length < RELOAD_STYLES) { R.bad('the gallery shows only ' + shown.length + ' Pulse styles'); return R.done('', 'CAPTION OPTIONS: harness failure'); }

  // ---- A. ✨ Effects tab open → ✏️ Editable: the Style controls stay ----------
  await openStyle(page, shown[0]);
  const trap = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const vis = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const fx = document.querySelector('#cust-tabs button[data-pane="pro"]'); if (fx) fx.click(); await sleep(150);
    const onFx = vis(document.getElementById('cust-pane-pro'));
    document.querySelector('#cap-output button[data-out="editable"]').click(); await sleep(350);
    const pane = document.getElementById('cust-pane-style');
    const ctls = Array.from(pane.querySelectorAll('input:not([type=hidden]), select, .seg-control button, label.sw, .dd-mount')).filter(vis);
    const back = () => { const b = document.querySelector('#cap-output button[data-out="png"]'); b.click(); };
    back(); await sleep(350);
    const styleTabOn = !!document.querySelector('#cust-tabs button[data-pane="style"].on');
    return { onFx, paneShown: vis(pane), ctlCount: ctls.length,
             has: ['c-size', 'c-pos', 'c-box-on', 'c-upper'].filter(id => vis(document.getElementById(id))),
             styleTabOn, styleShownAfter: vis(pane) };
  });
  if (!trap.onFx) R.bad('A: could not open the ✨ Effects tab to set the trap');
  else if (!trap.paneShown || trap.ctlCount < 15 || trap.has.length < 4)
    R.bad('A: Effects tab → ✏️ Editable leaves the editor empty: Style pane shown ' + trap.paneShown + ', ' + trap.ctlCount + ' controls, of Size/Position/Box/ALL CAPS: ' + trap.has.join(','));
  else if (!trap.styleTabOn || !trap.styleShownAfter) R.bad('A: back in ✨ Pulse-rendered the Style tab is not the one lit / shown');
  else R.ok('A: Effects tab → ✏️ Editable shows the Style controls (' + trap.ctlCount + ' on screen, Size/Position/Box/ALL CAPS among them); back in Pulse-rendered the 🎨 Style tab is lit');

  // ---- B. Caption type first, and the hidden-count line + switch -------------
  const top = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const vis = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const y = id => { const e = document.getElementById(id); return e ? e.getBoundingClientRect().top + window.scrollY + (document.getElementById('tab-captions') || {}).scrollTop : NaN; };
    const ed = document.getElementById('view-editor').getBoundingClientRect().top;
    const capY = document.getElementById('cap-output').getBoundingClientRect().top - ed;
    const order = { cap: y('cap-output'), words: y('wc-block'), drawer: y('customize-drawer') };
    const linePng = vis(document.getElementById('cap-hidden-line'));
    document.querySelector('#cap-output button[data-out="editable"]').click(); await sleep(350);
    const line = document.getElementById('cap-hidden-line');
    const lineShown = vis(line), text = line ? line.textContent.replace(/\s+/g, ' ').trim() : '';
    const n = parseInt((document.getElementById('cap-hidden-n') || {}).textContent, 10);
    const pngOnlyShownInEditable = Array.from(document.querySelectorAll('#view-editor .png-only')).filter(vis).length;
    const lineBelowType = line ? (line.getBoundingClientRect().top - document.getElementById('cap-output').getBoundingClientRect().bottom) : 1e9;
    document.getElementById('btn-cap-to-pulse').click(); await sleep(350);
    // the settings that came back: Pulse-only ones on the Style tab + the Effects tab
    const SET = ['input:not([type=hidden])', 'select', '.seg-control', 'label.sw', '.anim-rail'];
    const inPane = id => SET.map(s => '#' + id + ' ' + s).join(', ');
    const back = Array.from(document.querySelectorAll(inPane('cust-pane-style'))).filter(el => el.closest('.png-only') && vis(el)).length;
    const fxb = document.querySelector('#cust-tabs button[data-pane="pro"]'); if (fxb) fxb.click(); await sleep(150);
    const fx = Array.from(document.querySelectorAll(inPane('cust-pane-pro'))).filter(vis).length;
    const stb = document.querySelector('#cust-tabs button[data-pane="style"]'); if (stb) stb.click(); await sleep(100);
    return { capY, order, linePng, lineShown, text, n, pngOnlyShownInEditable, lineBelowType,
             after: window.CP_DEBUG.capOut(), lineAfter: vis(line), tabsAfter: vis(document.getElementById('cust-tabs')),
             fxAfter: back + fx };
  });
  if (!(top.order.cap < top.order.words && top.order.cap < top.order.drawer) || !(top.capY < 700))
    R.bad('B: Caption type is not at the top of the style editor (' + Math.round(top.capY) + ' px down; above Words per caption: ' + (top.order.cap < top.order.words) + ', above the settings: ' + (top.order.cap < top.order.drawer) + ')');
  else R.ok('B: Caption type is the first setting of the style editor (' + Math.round(top.capY) + ' px down, it was ~2,175), above Words per caption and every setting it hides');
  if (top.linePng) R.bad('B: the "hidden settings" line shows in ✨ Pulse-rendered, where nothing is hidden');
  if (!top.lineShown || !(top.n >= 10) || !/hides\s+\d+/.test(top.text) || top.lineBelowType > 80)
    R.bad('B: ✏️ Editable does not say how many settings it hides right under Caption type ("' + top.text + '", n=' + top.n + ')');
  else if (top.after !== 'png' || top.lineAfter || !top.tabsAfter || top.fxAfter < top.n / 2)
    R.bad('B: the one-tap switch did not bring the settings back (type ' + top.after + ', line still shown ' + top.lineAfter + ', tabs ' + top.tabsAfter + ', ' + top.fxAfter + ' Pulse-only things on screen)');
  else R.ok('B: ✏️ Editable says "' + top.text.slice(0, 60) + '…" under Caption type; one tap switches back and ' + top.fxAfter + ' Pulse-only settings are reachable again');

  // ---- D. a greyed control whose reason one tap can meet -------------------
  const noBox = shown.find(id => !byId[id].box && byId[id].hls === 'color' && !byId[id].build);
  const noStroke = shown.find(id => byId[id].stroke === 0 && !byId[id].build);
  const capsStyle = shown.find(id => byId[id].upper && !byId[id].build);
  const buildStyle = shown.find(id => byId[id].build);
  const fixRes = {};
  const tapFix = async (styleId, ctlId, sel, pane) => {
    await openStyle(page, styleId);
    const pre = await page.evaluate(async (ctlId, sel, pane) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const b = document.querySelector('#cust-tabs button[data-pane="' + pane + '"]'); if (b) b.click(); await sleep(150);
      const e = document.getElementById(ctlId);
      const w = document.querySelector('[data-why-for="' + ctlId + '"]');
      const t = document.querySelector(sel); if (t) t.scrollIntoView({ block: 'center' }); await sleep(100);
      return { greyed: !!(e && (e.disabled || e.getAttribute('aria-disabled') === 'true')),
               why: (w && w.offsetParent !== null) ? w.textContent : '' };
    }, ctlId, sel, pane);
    const h = await page.$(sel);
    if (h) { try { await h.click(); } catch (e) { pre.clickErr = String(e.message || e); } }
    await sleep(300);
    const post = await page.evaluate((ctlId) => {
      const e = document.getElementById(ctlId);
      return { greyed: !!(e && (e.disabled || e.getAttribute('aria-disabled') === 'true')),
               box: document.getElementById('c-box-on').checked, strokew: +document.getElementById('c-strokew').value,
               upper: document.getElementById('c-upper').checked };
    }, ctlId);
    return { pre, post };
  };
  if (noBox) fixRes.pad = await tapFix(noBox, 'c-box-pad', '#c-box-pad', 'pro');
  if (noStroke) fixRes.stroke = await tapFix(noStroke, 'c-stroke', '#sw-stroke', 'style');
  if (capsStyle) fixRes.cs = await tapFix(capsStyle, 'c-case', '#c-case', 'style');
  const okFix = (r, cond, what) => {
    if (!r) return R.bad('D: no style to test "' + what + '" on');
    if (!r.pre.greyed || !/tap it to/.test(r.pre.why)) return R.bad('D: ' + what + ': not greyed with a tappable reason before the tap (' + JSON.stringify(r.pre) + ')');
    if (!cond(r.post) || r.post.greyed) return R.bad('D: ' + what + ': tapping the greyed control did not meet its reason (' + JSON.stringify(r.post) + ')');
    R.ok('D: ' + what + ' — "' + r.pre.why.slice(2, 70) + '…"');
  };
  okFix(fixRes.pad, p => p.box, 'Box padding with no box: one tap switches the box on');
  okFix(fixRes.stroke, p => p.strokew > 0, 'Outline colour with no outline: one tap gives the text an outline');
  okFix(fixRes.cs, p => !p.upper, 'Text case under ALL CAPS: one tap turns ALL CAPS off');
  if (buildStyle) {
    await openStyle(page, buildStyle);
    const b = await page.evaluate(() => {
      const e = document.getElementById('c-wordhl'), w = document.querySelector('[data-why-for="c-wordhl"]');
      return { disabled: !!(e && e.disabled), why: (w && w.offsetParent !== null) ? w.textContent : '' };
    });
    if (!b.disabled || !b.why || /tap it to/.test(b.why)) R.bad('D: a reason nothing can meet (a style that builds word by word) must keep ✨ Word-by-word disabled with its reason: ' + JSON.stringify(b));
    else R.ok('D: where nothing can meet the reason the control stays disabled with it on screen ("' + b.why.slice(2, 60) + '…")');
  }

  // ---- E. Outline width by its colour; roundness + case in ✏️ Editable -------
  if (noStroke) await openStyle(page, noStroke);
  const lay = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const vis = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const st = document.querySelector('#cust-tabs button[data-pane="style"]'); if (st) st.click(); await sleep(150);
    const sw = document.getElementById('sw-stroke'), wd = document.getElementById('c-strokew');
    const gap = (sw && wd) ? Math.abs(wd.getBoundingClientRect().top - sw.getBoundingClientRect().bottom) : 1e9;
    const out = { swShown: vis(sw), widthShown: vis(wd), gap, samePane: !!(wd && wd.closest('#cust-pane-style')) };
    document.querySelector('#cap-output button[data-out="editable"]').click(); await sleep(350);
    const box = document.getElementById('c-box-on');
    if (!box.checked) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); await sleep(150); }
    const rad = document.getElementById('c-box-radius');
    out.radShown = vis(rad); out.opShown = vis(document.getElementById('c-box-opacity'));
    out.caseShown = vis(document.getElementById('c-case'));
    out.syncShown = vis(document.getElementById('sync-nudge')) && vis(document.getElementById('c-sync'));
    const D = window.CP_DEBUG;
    // what the editable engine is sent for its BG Roundness control
    const FLUX = ['Text Color', 'Highlighted Word Color 1', 'BG Color', 'BG Opacity', 'BG Roundness'].map((name, i) => ({ i, name,
      kind: /color/i.test(name) ? 'color' : 'number', num: 100 }));
    const sent = () => { const p = (D.mapPresetToFlux(D.styledPreset(), FLUX) || []).find(x => x.i === 4); return p ? p.value : null; };
    rad.value = '4'; rad.dispatchEvent(new Event('input', { bubbles: true }));
    const r1 = sent();
    rad.value = '40'; rad.dispatchEvent(new Event('input', { bubbles: true }));
    const r2 = sent();
    out.radius = [r1, r2];
    document.querySelector('#cap-output button[data-out="png"]').click(); await sleep(300);
    return out;
  });
  if (!lay.swShown || !lay.widthShown || !lay.samePane || lay.gap > 90)
    R.bad('E: Outline width is not next to the Outline colour on the Style tab (colour shown ' + lay.swShown + ', width shown ' + lay.widthShown + ', same tab ' + lay.samePane + ', ' + Math.round(lay.gap) + ' px apart)');
  else R.ok('E: Outline width sits ' + Math.round(lay.gap) + ' px under the Outline colour on the 🎨 Style tab, and the colour shows on a style with no outline');
  if (!lay.radShown || !lay.opShown || !lay.caseShown) R.bad('E: in ✏️ Editable — Box roundness ' + lay.radShown + ', Box see-through ' + lay.opShown + ', Text case ' + lay.caseShown);
  else if (!(lay.radius[0] != null && lay.radius[1] != null && lay.radius[1] > lay.radius[0])) R.bad('E: Box roundness does not reach the ✏️ Editable caption style (' + lay.radius + ')');
  else R.ok('E: ✏️ Editable shows Box roundness (reaches the caption: ' + lay.radius.join(' → ') + '), Box see-through and Text case');
  if (!lay.syncShown) R.bad('I: the highlight-timing nudge is hidden in ✏️ Editable');
  else R.ok('I: the highlight-timing nudge and its switch show in ✏️ Editable too');

  // ---- F. gallery sort + Suggest in ✏️ Editable -------------------------------
  const gal = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const vis = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    document.querySelector('#cap-output button[data-out="editable"]').click(); await sleep(300);
    const b = document.getElementById('btn-browse-styles'); if (b) b.click(); await sleep(300);
    const more = document.getElementById('lib-more'); if (more) more.open = true; await sleep(100);
    const sort = document.getElementById('lib-sort');
    const out = { sort: vis(sort), niche: vis(document.querySelector('.niche-row')) };
    sort.value = 'az'; sort.dispatchEvent(new Event('change', { bubbles: true })); await sleep(300);
    const names = Array.from(document.querySelectorAll('#tpl-grid .tpl-card .tpl-name')).filter(vis).map(n => n.textContent.trim()).slice(0, 6);
    out.sorted = names.length >= 3 && names.every((n, i) => !i || names[i - 1].localeCompare(n, undefined, { sensitivity: 'base' }) <= 0);
    out.names = names;
    sort.value = 'popular'; sort.dispatchEvent(new Event('change', { bubbles: true })); await sleep(200);
    if (more) more.open = false;
    document.querySelector('#cap-output button[data-out="png"]').click(); await sleep(300);
    return out;
  });
  if (!gal.sort || !gal.niche) R.bad('F: in ✏️ Editable the gallery sort (' + gal.sort + ') / ✨ Suggest for (' + gal.niche + ') is hidden');
  else if (!gal.sorted) R.bad('F: sorting A–Z in ✏️ Editable did not sort the cards: ' + gal.names.join(', '));
  else R.ok('F: in ✏️ Editable the gallery sort and ✨ Suggest for are on screen, and A–Z sorts (' + gal.names.slice(0, 3).join(', ') + '…)');

  // ---- G. no hint names a button that is never shown --------------------------
  {
    const html = fs.readFileSync(path.join(G.PANEL_DIR, 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(G.PANEL_DIR, 'js', 'main.js'), 'utf8');
    const hidden = [];
    const re = /<button\b[^>]*class="[^"]*\bui-offstage\b[^"]*"[^>]*>([^<]+)<\/button>/g;
    let m; while ((m = re.exec(html))) hidden.push(m[1].replace(/^[^A-Za-z]+/, '').trim());
    const htmlWithout = html.replace(re, '');
    const strings = (js.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g) || []).join('\n');
    const hits = [];
    for (const label of hidden) {
      if (strings.indexOf(label) >= 0) hits.push('main.js names "' + label + '"');
      if (htmlWithout.replace(/<!--[\s\S]*?-->/g, '').indexOf(label) >= 0) hits.push('index.html names "' + label + '"');
    }
    const pointsAtStyles = (js.match(/use a Pulse style instead \([^)]*🎨 Styles/g) || []).length;
    if (!hidden.length) R.bad('G: found no off-stage buttons to check against (the check is not reaching the page)');
    else if (hits.length) R.bad('G: a hint still sends the owner to a button that is never shown: ' + hits.join('; '));
    else if (pointsAtStyles < 3) R.bad('G: the "use a Pulse style instead" hints do not point at 🎨 Styles (' + pointsAtStyles + ' of 3)');
    else R.ok('G: no hint names a hidden button (' + hidden.join(', ') + '); the 3 template hints point at 🎨 Styles, which is on screen');
  }
  const stylesVisible = await page.evaluate(() => { const b = document.querySelector('#cap-view button[data-view="templates"]'); return !!(b && b.offsetParent !== null && /🎨 Styles/.test(b.textContent)); });
  if (!stylesVisible) R.bad('G: the 🎨 Styles button the hints point at is not on screen');

  // ---- H. ✏️ Editable text case follows the Styles editor's Text case ---------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-gate-case-'));
  const srt = path.join(tmp, 'talk.srt');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,400\nDekho bhai, Consistency sabse IMPORTANT hai.\n\n' +
    '2\n00:00:02,600 --> 00:00:05,000\nयह बहुत ज़रूरी है, Trust me on this.\n\n' +
    '3\n00:00:05,200 --> 00:00:07,500\nThe Audience notices every small Detail.\n');
  let caseRes;
  try {
    const light = shown.find(id => !byId[id].upper && !byId[id].dark && !byId[id].build) || shown[0];
    await openStyle(page, light);
    caseRes = await page.evaluate(async (srt) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { path: srt, label: 'talk.srt' } });
      document.querySelector('#cap-output button[data-out="editable"]').click(); await sleep(300);
      const up = document.getElementById('c-upper');
      if (up.checked) { up.checked = false; up.dispatchEvent(new Event('change', { bubbles: true })); }
      // the 📁 Upload view's case says UPPER — it must no longer decide
      const mg = document.querySelector('#mg-case button[data-case="upper"]'); if (mg) mg.click();
      const out = {};
      for (const mode of ['lower', 'title', 'upper', 'original']) {
        const cs = document.getElementById('c-case');
        cs.value = mode; cs.dispatchEvent(new Event('change', { bubbles: true }));
        window.__hostScripts.length = 0;
        const ov = document.getElementById('cp-confirm-ov'); if (ov) ov.remove();
        document.getElementById('btn-magic').click();
        let s = null;
        for (let i = 0; i < 40 && !s; i++) { await sleep(100); s = window.__hostScripts.find(x => /^CP_insertMogrtCaptions\(/.test(x)); }
        if (!s) { out[mode] = null; continue; }
        const arg = JSON.parse(JSON.parse(s.slice('CP_insertMogrtCaptions('.length, s.lastIndexOf(')'))));
        out[mode] = (arg.cues || []).map(c => c.text);
      }
      document.querySelector('#cap-output button[data-out="png"]').click(); await sleep(200);
      return out;
    }, srt);
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  {
    const all = m => (caseRes[m] || []).join(' | ');
    const lat = s => s.replace(/[^A-Za-z\s]/g, ' ').split(/\s+/).filter(Boolean);
    const bad = [];
    if (!caseRes.lower || !caseRes.lower.length) bad.push('no editable captions were placed');
    else {
      if (all('lower') !== all('lower').toLowerCase()) bad.push('Text case lowercase → "' + all('lower') + '"');
      if (!lat(all('title')).every(w => w[0] === w[0].toUpperCase() && w.slice(1) === w.slice(1).toLowerCase())) bad.push('Title Case → "' + all('title') + '"');
      if (all('upper') !== all('upper').toUpperCase()) bad.push('UPPERCASE → "' + all('upper') + '"');
      if (!/Consistency/.test(all('original')) || !/IMPORTANT/.test(all('original'))) bad.push('Original → "' + all('original') + '"');
      if (!/यह/.test(all('lower'))) bad.push('the Hindi words were lost');
    }
    if (bad.length) R.bad('H: ✏️ Editable captions do not follow the Styles editor\'s Text case (the 📁 Upload view said UPPER): ' + bad.join('; '));
    else R.ok('H: ✏️ Editable captions follow Text case (lower: "' + caseRes.lower[0] + '", Title: "' + caseRes.title[0] + '") even with the 📁 Upload view set to UPPER');
  }

  // ---- I. Words per caption says what it does --------------------------------
  const wc = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const n = document.getElementById('wc-num'), full = document.getElementById('wc-full');
    if (!full.classList.contains('on')) { full.click(); await sleep(150); }
    const auto = { text: n.textContent, tip: n.title, fullTip: full.title };
    document.getElementById('wc-plus').click(); await sleep(150);
    document.getElementById('wc-plus').click(); await sleep(150);
    const set = { text: n.textContent, tip: n.title, val: document.getElementById('c-words').value };
    return { auto, set };
  });
  if (wc.auto.text !== 'Auto' || !/whole phrases, fitted to your video/i.test(wc.auto.tip) || !/whole phrases, fitted to your video/i.test(wc.auto.fullTip))
    R.bad('I: ✨ Auto does not say "whole phrases, fitted to your video" (' + JSON.stringify(wc.auto) + ')');
  else if (wc.set.text !== wc.set.val || wc.set.tip.indexOf(wc.set.val + ' word') !== 0)
    R.bad('I: the stepper shows "' + wc.set.text + '" / "' + wc.set.tip + '" for ' + wc.set.val + ' words per caption');
  else R.ok('I: Words per caption shows the value it uses ("' + wc.auto.tip + '"; then "' + wc.set.tip + '")');

  // ---- C. a reload keeps the picked style's look — and the owner's changes ----
  const diffOv = (a, b) => {
    const d = {};
    for (const k of new Set(Object.keys(a || {}).concat(Object.keys(b || {})))) {
      const x = JSON.stringify(a[k]), y = JSON.stringify(b[k]);
      if (x !== y) d[k] = [a[k], b[k]];
    }
    return d;
  };
  const reloadOne = async (id) => {
    if (!(await openStyle(page, id))) return { err: 'no card' };
    await sleep(150);
    const before = await page.evaluate(() => window.CP_DEBUG.readOverrides());
    await reloadPanel(page);
    const after = await page.evaluate(() => ({ ov: window.CP_DEBUG.readOverrides(), id: window.CP_DEBUG.snapshot().presetId }));
    return { diff: diffOv(before, after.ov), sameStyle: after.id === id };
  };
  const runReloads = async (list, label) => {
    const changed = [];
    let n = 0;
    for (const id of list) {
      const r = await reloadOne(id);
      if (r.err) { changed.push(id + ': ' + r.err); continue; }
      n++;
      const keys = Object.keys(r.diff);
      if (keys.length || !r.sameStyle) changed.push(id + (r.sameStyle ? '' : ' (another style came back)') + ' ' + keys.slice(0, 4).map(k => k + ' ' + JSON.stringify(r.diff[k][0]) + '→' + JSON.stringify(r.diff[k][1])).join(', '));
    }
    if (changed.length) R.bad('C: after a reload ' + changed.length + ' of ' + list.length + ' styles look different @' + label + ': ' + changed.slice(0, 6).join(' · '));
    else R.ok('C: a reload keeps every setting of the picked style identical on ' + n + ' styles @' + label);
  };
  // spread over the whole gallery, Hindi Podcast Bar and Bold Pop included
  const pick = (list, k) => { const step = list.length / k, out = []; for (let i = 0; i < k; i++) out.push(list[Math.floor(i * step)]); return out; };
  const must = ['tr-hindi-podcast', 'pro-boldpop', 'karaoke'].filter(id => shown.indexOf(id) >= 0);
  const portraitSet = Array.from(new Set(must.concat(pick(shown, RELOAD_STYLES)))).slice(0, Math.max(RELOAD_STYLES, must.length));
  await runReloads(portraitSet, '1080×1920');
  await page.evaluate(() => { try { localStorage.setItem('gate.env', '1920x1080'); } catch (e) {} });
  await reloadPanel(page);
  const env = await page.evaluate(() => window.CP_DEBUG.env());
  if (!env || env.width !== 1920) R.bad('C: could not stand the panel in front of a 1920×1080 sequence (' + JSON.stringify(env) + ')');
  await runReloads(pick(shown.slice().reverse(), LANDSCAPE_STYLES), '1920×1080');

  // the owner's own changes survive too — including 🔠 CAPS / auto-emoji / timing switch
  const edit = must[0] || shown[0];
  await openStyle(page, edit);
  const set = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const fire = e => { e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
    const chk = (id, v) => { const e = document.getElementById(id); e.checked = v; fire(e); };
    const val = (id, v) => { const e = document.getElementById(id); e.value = String(v); fire(e); };
    chk('c-box-on', true); val('c-box-radius', 33); val('c-linegap', 150); chk('c-grad', true); val('c-fill2', '#12ab34');
    chk('c-kwcaps', true); chk('c-emoji', true); chk('c-sync', false);
    await sleep(200);
    return { ov: window.CP_DEBUG.readOverrides() };
  });
  await reloadPanel(page);
  const got = await page.evaluate(() => ({
    ov: window.CP_DEBUG.readOverrides(),
    kwcaps: document.getElementById('c-kwcaps').checked, emoji: document.getElementById('c-emoji').checked,
    sync: document.getElementById('c-sync').checked,
    gradRow: getComputedStyle(document.getElementById('c-grad-opts')).display !== 'none'
  }));
  const ed = diffOv(set.ov, got.ov);
  if (Object.keys(ed).length) R.bad('C: the owner\'s own changes did not survive a reload: ' + JSON.stringify(ed).slice(0, 300));
  else if (!got.kwcaps || !got.emoji || got.sync) R.bad('C: after a reload 🔠 CAPS on key words ' + got.kwcaps + ', 😀 Auto-emoji ' + got.emoji + ', 🎯 Match words to the voice ' + got.sync + ' (set: true, true, false)');
  else if (!got.gradRow) R.bad('C: two-colour text came back on but its colour row stayed closed');
  else R.ok('C: the owner\'s changes survive a reload (box roundness 33, line spacing 150%, two-colour text with its colour row open, 🔠 CAPS on key words, 😀 Auto-emoji, timing switch off)');

  if (page._cpErrors.length) R.bad('page errors: ' + page._cpErrors.slice(0, 3).join(' | '));
  await page.evaluate(() => { try { localStorage.removeItem('cutpilot.look'); localStorage.removeItem('gate.env'); } catch (e) {} });
  await browser.close();
  R.done('CAPTION OPTIONS: every option is on screen, acts when tapped and survives a reload ✓', 'CAPTION OPTIONS: failures above');
})().catch(e => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
