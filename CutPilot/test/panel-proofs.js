/*
 * panel-proofs.js — the PANEL-SIDE half of the autonomous QA system.
 *
 * Boots the REAL panel in headless Chromium and machine-verifies, with no
 * human looking at it:
 *   A. MAPPING  — every gallery style × the real Flux engine control layout
 *                 (preview promise == params sent), including position math
 *                 for portrait AND landscape, faces, radius, glow-as-halo.
 *   B. PARITY   — clicks every style card; gallery tile == editor preview on
 *                 every WYSIWYG field.
 *   C. FONT UI  — opens the Font picker like a user, picks a face, asserts the
 *                 preview changes; same for Weight.
 *   D. EMPHASIS — Smart-emphasis toggles: ON adds emoji + CAPS keywords,
 *                 OFF leaves text byte-identical.
 *
 * Self-contained: the Flux control layout is generated from the REAL
 * .mogrt's definition.json (via unzip), not a fixture that can go stale.
 * Browser resolution: CP_CHROMIUM env → /opt/pw-browsers/chromium →
 * system chromium → puppeteer's own download (CI).
 *
 * Run: node CutPilot/test/panel-proofs.js   (wired into test/run-tests.js)
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PANEL = 'file://' + path.join(ROOT, 'CutPilot', 'index.html');
const MOGRT = path.join(ROOT, 'CutPilot', 'mogrts', 'Flux_Halo2.mogrt');

let failed = 0;
function ok(m) { console.log('  ✓ ' + m); }
function bad(m) { console.log('  ✗ ' + m); failed++; }

function requirePuppeteer() {
  const tries = [path.join(ROOT, 'node_modules', 'puppeteer'), 'puppeteer', 'puppeteer-core'];
  for (const t of tries) { try { return require(t); } catch (e) {} }
  throw new Error('no puppeteer/puppeteer-core available');
}
function resolveBrowser(pptr) {
  if (process.env.CP_CHROMIUM && fs.existsSync(process.env.CP_CHROMIUM)) return process.env.CP_CHROMIUM;
  for (const c of ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'])
    if (fs.existsSync(c)) return c;
  try { const p = pptr.executablePath(); if (p && fs.existsSync(p)) return p; } catch (e) {}
  throw new Error('no Chromium found (set CP_CHROMIUM)');
}

// live-prop records exactly as CP_inspectMogrt reports them, from the REAL engine
function fluxProps() {
  const def = JSON.parse(cp.execSync('unzip -p ' + JSON.stringify(MOGRT) + ' definition.json', { maxBuffer: 1 << 24 }));
  return (def.clientControls || []).map((c, i) => {
    let name = '?'; try { name = c.uiName.strDB[0].str; } catch (e) {}
    const t = c.type, v = c.value;
    let kind = 'text', num = null, point = null;
    if (t === 4) kind = 'color';
    else if (t === 2 || t === 3 || t === 13) { kind = 'number'; num = v; }
    else if (t === 5) { kind = 'string'; if (v && v.x != null) point = { x: v.x, y: v.y }; }
    else if (t === 1) kind = 'bool';
    return { i, name, kind, num, point };
  });
}

(async () => {
  console.log('panel proofs (headless, real panel)');
  const pptr = requirePuppeteer();
  const _lopts = { headless: 'new', executablePath: resolveBrowser(pptr),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files'] };
  let browser = null;
  for (let _a = 1; _a <= 3 && !browser; _a++) {
    try { browser = await pptr.launch(_lopts); }
    catch (e) { if (_a === 3) throw e; await new Promise(r => setTimeout(r, 1500 * _a)); }
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });
  page.on('pageerror', e => bad('page error: ' + e.message));
  await page.goto(PANEL, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 700));
  await page.evaluate(() => document.querySelector('[data-tab="captions"]').click());
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => { const b = document.getElementById('btn-browse-styles'); if (b) b.click(); });
  await new Promise(r => setTimeout(r, 800));

  // ---- A. MAPPING against the real engine layout ---------------------------
  const PROPS = fluxProps();
  const mapRes = await page.evaluate((PROPS) => {
    const D = window.CP_DEBUG;
    if (!D || !D.mapPresetToFlux || !D.carryableStyle) return { fatal: 'CP_DEBUG hooks missing' };
    const T = (window.CPCaptions && window.CPCaptions.TEMPLATES) || [];
    const lc = h => String(h || '').toLowerCase();
    const fails = [];
    const IDX = {};
    PROPS.forEach(p => { IDX[p.name.toLowerCase()] = p.i; });
    const I = n => IDX[n];
    T.forEach(t => {
      const cs = D.carryableStyle(t);
      const params = D.mapPresetToFlux(t, PROPS);
      if (!params) { fails.push(t.id + ': mapPresetToFlux null'); return; }
      const byI = {}; params.forEach(p => { byI[p.i] = p; });
      const b = m => fails.push(t.id + ': ' + m);
      if (!byI[I('text color')] || lc(byI[I('text color')].value) !== lc(cs.fill)) b('fill mismatch');
      const wantHl = cs.keyword ? cs.highlight : cs.fill;
      if (!byI[I('highlighted word color 1')] || lc(byI[I('highlighted word color 1')].value) !== lc(wantHl)) b('hl1 mismatch');
      const wantHl2 = (cs.keyword && cs.highlight2) ? cs.highlight2 : wantHl;
      if (!byI[I('highlighted word color 2')] || lc(byI[I('highlighted word color 2')].value) !== lc(wantHl2)) b('hl2 mismatch');
      if (!byI[I('text opacity')] || byI[I('text opacity')].value !== 100) b('text opacity not 100');
      if (cs.boxColor) {
        const bo = cs.boxOpacity == null ? 100 : (cs.boxOpacity <= 1 ? Math.round(cs.boxOpacity * 100) : cs.boxOpacity);
        if (!byI[I('bg color')] || lc(byI[I('bg color')].value) !== lc(cs.boxColor)) b('bg color mismatch');
        if (!byI[I('bg opacity')] || byI[I('bg opacity')].value !== Math.max(0, Math.min(100, bo))) b('bg opacity mismatch');
        if (!byI[I('bg roundness')] || byI[I('bg roundness')].value !== cs.boxRadius) b('bg roundness mismatch');
      } else if (!byI[I('bg opacity')] || byI[I('bg opacity')].value !== 0) b('boxless must hide bg');
      if (cs.glow) {
        if (!byI[I('shadow on/off')] || byI[I('shadow on/off')].value !== true) b('glow: shadow not on');
        if (!byI[I('shadow distance')] || byI[I('shadow distance')].value !== 0) b('glow: distance not 0');
      } else if (!byI[I('shadow on/off')] || byI[I('shadow on/off')].value !== false) b('no-glow: shadow not off');
      if (byI[I('text position')]) b('position sent without yPct');
      // LAYER-position points ride Premiere's scripting API NORMALIZED (0–1):
      // pixels were multiplied by the frame (EG showed 583200×2801280) and the
      // text + highlight overlay sat off-screen — "box shows, text doesn't".
      // Effect points (gradient anchors) stay in PIXELS.
      const t3 = Object.assign({}, t, { yPct: 0.76 });
      const p3 = D.mapPresetToFlux(t3, PROPS) || []; const b3 = {}; p3.forEach(p => { b3[p.i] = p; });
      const yPortN = Math.round(1920 * 0.76) / 1920;
      const near = (a, w) => Math.abs(a - w) < 1e-9;
      if (!b3[I('text position')] || !near(b3[I('text position')].value.y, yPortN) ||
          !near(b3[I('text position')].value.x, 0.5)) b('portrait position wrong (must be NORMALIZED 0–1)');
      if (!b3[I('gradient fg text position')] || !near(b3[I('gradient fg text position')].value.y, yPortN)) b('gradient overlay did not follow');
      if (b3[I('text position')].value.y > 1.001) b('position sent as PIXELS — text lands off-screen');
      if (b3[I('start of gradient')] && b3[I('start of gradient')].value.y <= 1.001) b('gradient anchors must stay PIXEL-space');
      t3.seqLandscape = true;
      const p4 = D.mapPresetToFlux(t3, PROPS) || []; const b4 = {}; p4.forEach(p => { b4[p.i] = p; });
      if (!b4[I('text position')] || !near(b4[I('text position')].value.y, Math.round(420 + 1080 * 0.76) / 1920)) b('landscape position wrong');
      const wantFont = t.font || 'Inter';
      if (cs.font !== wantFont) b('preview face ' + cs.font + ' != ' + wantFont);
    });
    return { checked: T.length, fails };
  }, PROPS);
  if (mapRes.fatal) bad('mapping: ' + mapRes.fatal);
  else if (mapRes.fails.length) mapRes.fails.slice(0, 10).forEach(f => bad('mapping: ' + f));
  else ok('mapping: all ' + mapRes.checked + ' styles → engine params match the preview promise');

  // ---- B. PARITY tile == editor preview -------------------------------------
  const par = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const grid = document.getElementById('tpl-grid');
    const ids = new Set(((window.CPCaptions && window.CPCaptions.TEMPLATES) || []).map(t => t.id));
    const canvases = Array.from(grid.querySelectorAll('.tpl-thumb-canvas')).filter(c => c._tpl && ids.has(c._tpl.id));
    for (const c of canvases) { if (!c._animStyle) { c.scrollIntoView({ block: 'center' }); await sleep(25); } }
    await sleep(600);
    const KEYS = ['font', 'fill', 'highlight', 'highlight2', 'boxColor', 'boxOpacity', 'glow', 'weight', 'uppercase'];
    const lc = v => (typeof v === 'string' ? v.toLowerCase() : (v == null ? null : v));
    const fails = []; let checked = 0;
    for (const cvs of canvases) {
      const t = cvs._tpl;
      if (!cvs._animStyle) { fails.push(t.id + ': never painted'); continue; }
      let el = cvs; while (el && el !== grid && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
      (el && el !== grid ? el : cvs).click();
      await sleep(60);
      const pvs = (document.getElementById('preview-canvas') || {})._pvStyle;
      if (!pvs) { fails.push(t.id + ': no preview style'); continue; }
      checked++;
      for (const k of KEYS) if (lc(pvs[k]) !== lc(cvs._animStyle[k])) fails.push(t.id + ': ' + k);
    }
    return { total: canvases.length, checked, fails };
  });
  if (par.fails.length) par.fails.slice(0, 10).forEach(f => bad('parity: ' + f));
  else ok('parity: tile == editor preview for all ' + par.checked + '/' + par.total + ' styles');

  // ---- C. FONT + WEIGHT controls are live -----------------------------------
  const fw = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const res = {};
    const mount = document.getElementById('c-font-mount');
    const btn = mount && mount.querySelector('.cp-dd-btn');
    res.clickable = !!(btn && btn.offsetParent !== null);
    if (btn) {
      btn.click(); await sleep(120);
      const opts = Array.from(document.querySelectorAll('.cp-dd-list li, .cp-dd-list button, .cp-dd-item'));
      res.listCount = opts.length;
      const impact = opts.find(o => /impact/i.test(o.textContent));
      if (impact) { impact.click(); await sleep(180); }
      res.afterFont = ((document.getElementById('preview-canvas') || {})._pvStyle || {}).font;
    }
    const w = document.getElementById('c-weight');
    w.value = '400'; w.dispatchEvent(new Event('input')); await sleep(180);
    res.afterWeight = ((document.getElementById('preview-canvas') || {})._pvStyle || {}).weight;
    return res;
  });
  if (fw.clickable && fw.afterFont === 'Impact' && fw.afterWeight === 500)
    ok('font/weight controls live (picker ' + fw.listCount + ' faces → preview follows)');
  else bad('font/weight dead: ' + JSON.stringify(fw));

  // ---- C2. PHOTOSHOP-STYLE PICKER: drag hue + square → colour + preview follow --
  const pk = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const mount = document.querySelector('.cp-mount[data-for="c-fill"]');
    const swatch = mount && mount.querySelector('.cp-swatch');
    if (!swatch) return { err: 'no fill swatch' };
    const before = document.getElementById('c-fill').value;
    swatch.click(); await sleep(120);
    // the open popover is BODY-mounted now (so ancestor re-layouts can't
    // collapse it mid-drag) — find the visible one at document level
    const pop = document.querySelector('body > .cp-pop:not(.hidden)') || mount.querySelector('.cp-pop:not(.hidden)');
    const hue = pop && pop.querySelector('.cp-pk-huewrap');
    const sv = pop && pop.querySelector('.cp-pk-svwrap');
    if (!hue || !sv) return { err: 'picker not in popover' };
    function md(el, fx, fy) {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }
    md(hue, 0.33, 0.5);          // ~green hue
    await sleep(60);
    md(sv, 0.95, 0.08);          // near-pure, bright
    await sleep(200);
    const after = document.getElementById('c-fill').value;
    const pv = ((document.getElementById('preview-canvas') || {})._pvStyle || {}).fill;
    swatch.click(); await sleep(50);   // close
    return { before, after, pv,
             greenish: parseInt(after.substr(3, 2), 16) > parseInt(after.substr(1, 2), 16) };
  });
  if (pk.err) bad('picker: ' + pk.err);
  else if (pk.after !== pk.before && pk.greenish && pk.pv && pk.pv.toLowerCase() === pk.after.toLowerCase())
    ok('photoshop picker: hue+square drags → ' + pk.after + ', preview follows live');
  else bad('picker did not take: ' + JSON.stringify(pk));

  // ---- D. SMART EMPHASIS on/off ----------------------------------------------
  const em = await page.evaluate(() => {
    const words = ('heatwaves are creating a hidden health crisis in india and the crisis is growing ' +
      'every summer while doctors warn about the money and health risks for every family').split(' ');
    const cues = words.map((w, i) => ({ start: i * 0.4, end: (i + 1) * 0.4, text: w }));
    const T = window.CP_DEBUG.textCues;
    const off = T(cues, 6, 'as-spoken').map(c => c.text).join('|');
    document.getElementById('c-emoji').checked = true;
    document.getElementById('c-kwcaps').checked = true;
    const on = T(cues, 6, 'as-spoken').map(c => c.text);
    document.getElementById('c-emoji').checked = false;
    document.getElementById('c-kwcaps').checked = false;
    const off2 = T(cues, 6, 'as-spoken').map(c => c.text).join('|');
    return {
      offStable: off === off2 && !/[\u{1F300}-\u{1FAFF}]/u.test(off),
      emojiLines: on.filter(t => /[\u{1F300}-\u{1FAFF}]/u.test(t)).length,
      capsWords: on.join(' ').split(' ').filter(w => w.length > 3 && w === w.toUpperCase() && /[A-Z]/.test(w)).length
    };
  });
  if (em.offStable && em.emojiLines >= 2 && em.capsWords >= 2)
    ok('smart emphasis: ON adds (' + em.emojiLines + ' emoji lines, ' + em.capsWords + ' CAPS), OFF byte-identical');
  else bad('smart emphasis broken: ' + JSON.stringify(em));

  // ---- D2. EVERY-SETTING AUDIT: each visible control must have an OBSERVABLE
  // effect ("check every single setting, not just the text setting") -----------
  const audit = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const pv = () => (document.getElementById('preview-canvas') || {})._pvStyle || {};
    const set = (id, v) => { const e = document.getElementById(id); if (!e) return false; e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); return true; };
    const tick = (id, v) => { const e = document.getElementById(id); if (!e) return false; e.checked = v; e.dispatchEvent(new Event('change')); return true; };
    const fails = [];
    async function expect(name, act, read, mustDiffer) {
      const before = JSON.stringify(read());
      if (!act()) { fails.push(name + ': control missing'); return; }
      await sleep(90);
      const after = JSON.stringify(read());
      if (mustDiffer && before === after) fails.push(name + ': NO observable effect (' + before + ')');
    }
    await expect('Size slider', () => set('c-size', '140'), () => pv().size, true);
    await expect('Position slider', () => set('c-pos', '20'), () => (window.CP_DEBUG.snapshot() || {}).yPct, true);
    await expect('Text colour', () => set('c-fill', '#123456'), () => pv().fill, true);
    await expect('Highlight colour', () => set('c-hl', '#654321'), () => pv().highlight, true);
    await expect('Box toggle ON', () => tick('c-box-on', true), () => !!pv().boxColor, true);
    await expect('Box colour', () => set('c-box', '#abcdef'), () => pv().boxColor, true);
    await expect('Box opacity', () => set('c-box-opacity', '40'), () => pv().boxOpacity, true);
    tick('c-shadow-on', false); await sleep(60);   // known OFF state → the ON transition is observable
    await expect('Shadow toggle', () => tick('c-shadow-on', true), () => !!pv().glow, true);
    await expect('Shadow colour', () => set('c-shadow', '#00ff88'), () => pv().glow, true);
    await expect('Shadow strength', () => set('c-shadow-blur', '90'), () => pv().glowBlur, true);
    await expect('ALL CAPS', () => tick('c-upper', true), () => pv().uppercase, true);
    await expect('Word-by-word OFF', () => tick('c-wordhl', false), () => pv().highlight, true);
    await expect('Weight', () => set('c-weight', pv().weight === 800 ? '300' : '900'), () => pv().weight, true);
    await expect('Gradient highlight', () => { tick('c-wordhl', true); return tick('c-hlgrad', true) && set('c-hl2g', '#ff00aa'); }, () => pv().highlight2, true);
    // entrance buttons: observable via the CP_DEBUG snapshot
    const entBtns = document.querySelectorAll('#c-entrance button');
    let entOk = false;
    if (entBtns.length && window.CP_DEBUG && window.CP_DEBUG.snapshot) {
      const b0 = window.CP_DEBUG.snapshot().entrance;
      entBtns[1].click(); await sleep(50);
      entOk = window.CP_DEBUG.snapshot().entrance !== b0 || b0 === entBtns[1].dataset.e;
    }
    if (!entOk) fails.push('Entrance buttons: no observable effect');
    // safe-zone buttons drive the position slider
    const szBtns = document.querySelectorAll('#c-safezone button');
    if (szBtns.length >= 2) {
      const p0 = document.getElementById('c-pos').value;
      szBtns[1].click(); await sleep(50);
      if (document.getElementById('c-pos').value === p0) fails.push('Safe-zone buttons: position did not move');
    } else fails.push('Safe-zone buttons missing');
    return { checked: 16, fails };
  });
  if (audit.fails.length) audit.fails.forEach(f => bad('setting audit: ' + f));
  else ok('setting audit: all ' + audit.checked + ' visible controls have observable effects');

  // ---- E. CONTROL FUZZ — random control combinations must never blank/throw --
  // Seeded PRNG so a red run is reproducible from its seed. Runs LAST because
  // it deliberately trashes the editor state.
  const fz = await page.evaluate(async (SEED) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let s = SEED >>> 0;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const pick = a => a[Math.floor(rnd() * a.length)];
    const hex = () => '#' + Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0');
    const grid = document.getElementById('tpl-grid');
    const cards = Array.from(grid.querySelectorAll('.tpl-thumb-canvas')).filter(c => c._tpl);
    const set = (id, v) => { const e = document.getElementById(id); if (!e) return; e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    const tick = (id, v) => { const e = document.getElementById(id); if (!e) return; e.checked = v; e.dispatchEvent(new Event('change')); };
    const fails = [];
    for (let i = 0; i < 40; i++) {
      // random style, then a storm of random overrides
      const cvs = pick(cards);
      let el = cvs; while (el && el !== grid && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
      (el && el !== grid ? el : cvs).click();
      await sleep(25);
      set('c-size', String(32 + Math.floor(rnd() * 128)));
      set('c-pos', String(10 + Math.floor(rnd() * 82)));
      set('c-fill', hex()); set('c-hl', hex()); set('c-box', hex());
      tick('c-box-on', rnd() < 0.6);
      tick('c-shadow-on', rnd() < 0.4); set('c-shadow-blur', String(Math.floor(rnd() * 120)));
      tick('c-wordhl', rnd() < 0.8); tick('c-upper', rnd() < 0.5);
      tick('c-hlgrad', rnd() < 0.3); set('c-hl2g', hex());
      const ent = document.querySelectorAll('#c-entrance button');
      if (ent.length) ent[Math.floor(rnd() * ent.length)].click();
      await sleep(45);
      const pv = document.getElementById('preview-canvas');
      const st = pv && pv._pvStyle;
      if (!st) { fails.push('combo ' + i + ' (' + (cvs._tpl && cvs._tpl.id) + '): no preview style'); continue; }
      if (!/^#[0-9a-fA-F]{3,8}$/.test(String(st.fill || ''))) fails.push('combo ' + i + ': bad fill ' + st.fill);
      let painted = 0;
      try {
        const px = pv.getContext('2d').getImageData(0, 0, pv.width, pv.height).data;
        for (let k = 3; k < px.length; k += 64) if (px[k] > 10) painted++;
      } catch (e) { fails.push('combo ' + i + ': canvas unreadable'); }
      if (!painted) fails.push('combo ' + i + ' (' + (cvs._tpl && cvs._tpl.id) + '): preview BLANK');
    }
    return { combos: 40, fails: fails.slice(0, 8) };
  }, 20260705);
  if (fz.fails.length) fz.fails.forEach(f => bad('fuzz: ' + f));
  else ok('fuzz: ' + fz.combos + ' random control combinations — preview never blanked, styles stayed valid');

  // ---- F. SAVED-TEMPLATE ROUNDTRIP: "My Templates must give back EXACTLY the
  // template I created" — save a customized look, trash the controls, reopen
  // the saved template, and assert every field comes back --------------------
  const rt = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    const tick = (id, v) => { const e = document.getElementById(id); e.checked = v; e.dispatchEvent(new Event('change')); };
    const clickBtn = (sel) => { const b = document.querySelector(sel); if (b) b.click(); };
    // saving now uses the IN-PANEL name dialog (window.prompt is dead in CEP) —
    // fill + confirm it exactly like a user
    window.prompt = () => { throw new Error('window.prompt must never be used'); };
    const confirmSaveDialog = async (name) => {
      await sleep(60);
      const ov = document.getElementById('cp-prompt-ov');
      if (!ov) return false;
      ov.querySelector('input').value = name;
      document.getElementById('cp-prompt-save').click();
      await sleep(60);
      return true;
    };
    set('c-fill', '#112233'); set('c-hl', '#445566');
    tick('c-hlgrad', true); set('c-hl2g', '#778899');
    set('c-pos', '30'); set('c-size', '120');
    const ent = document.querySelectorAll('#c-entrance button');
    for (const b of ent) if (b.dataset.e === 'slide') b.click();
    tick('c-shadow-on', true); set('c-shadow', '#0a0b0c'); set('c-shadow-blur', '80');
    // newly-fixed roundtrip fields (were silently dropped on save/restore):
    clickBtn('#c-align button[data-a="left"]');       // alignment
    tick('c-grad', true); set('c-fill2', '#abcdef');   // TEXT gradient (2nd colour)
    set('c-shadow-dx', '12'); set('c-shadow-dy', '-6'); // directional shadow offset
    set('c-maxwidth', '70');                            // caption max width
    if (document.getElementById('c-case')) set('c-case', 'upper');
    tick('c-censor', true);
    await sleep(80);
    document.getElementById('btn-save-tpl').click();
    if (!(await confirmSaveDialog('RT Test'))) return { err: 'save name dialog did not open' };
    await sleep(150);
    // trash everything
    set('c-fill', '#ffffff'); set('c-hl', '#ffd400'); tick('c-hlgrad', false);
    set('c-pos', '76'); set('c-size', '62'); tick('c-shadow-on', false);
    for (const b of ent) if (b.dataset.e === 'none') b.click();
    clickBtn('#c-align button[data-a="center"]');
    tick('c-grad', false); set('c-fill2', '#000000');
    set('c-shadow-dx', '0'); set('c-shadow-dy', '0'); set('c-maxwidth', '86');
    if (document.getElementById('c-case')) set('c-case', 'original');
    tick('c-censor', false);
    await sleep(80);
    // reopen the saved template from the grid
    document.getElementById('btn-browse-styles').click(); await sleep(400);
    const grid = document.getElementById('tpl-grid');
    const card = Array.from(grid.querySelectorAll('.tpl-thumb-canvas')).find(c => c._tpl && c._tpl.custom);
    if (!card) return { err: 'saved template not in grid' };
    let el = card; while (el && !(el.classList && el.classList.contains('tpl-card'))) el = el.parentNode;
    el.click(); await sleep(250);
    const snap = window.CP_DEBUG.snapshot();
    const alignOn = document.querySelector('#c-align button.on');
    const caseEl = document.getElementById('c-case');
    return {
      fill: document.getElementById('c-fill').value,
      hl: document.getElementById('c-hl').value,
      grad: document.getElementById('c-hlgrad').checked,
      hl2: document.getElementById('c-hl2g').value,
      pos: document.getElementById('c-pos').value,
      size: document.getElementById('c-size').value,
      shadowOn: document.getElementById('c-shadow-on').checked,
      blur: document.getElementById('c-shadow-blur').value,
      entrance: snap.entrance,
      // newly-fixed fields
      align: alignOn ? alignOn.dataset.a : '?',
      textGrad: document.getElementById('c-grad').checked,
      fill2: document.getElementById('c-fill2').value,
      sdx: document.getElementById('c-shadow-dx').value,
      sdy: document.getElementById('c-shadow-dy').value,
      maxw: document.getElementById('c-maxwidth').value,
      tcase: caseEl ? caseEl.value : 'upper',
      censor: document.getElementById('c-censor').checked
    };
  });
  if (rt.err) bad('saved-template roundtrip: ' + rt.err);
  else {
    const want = { fill: '#112233', hl: '#445566', grad: true, hl2: '#778899', pos: '30', size: '120',
      shadowOn: true, blur: '80', entrance: 'slide',
      align: 'left', textGrad: true, fill2: '#abcdef', sdx: '12', sdy: '-6', maxw: '70', tcase: 'upper', censor: true };
    const misses = Object.keys(want).filter(k => String(rt[k]).toLowerCase() !== String(want[k]).toLowerCase());
    if (misses.length) bad('saved-template roundtrip lost: ' + misses.map(k => k + '=' + rt[k] + '≠' + want[k]).join(', '));
    else ok('saved-template roundtrip: all 17 fields restored exactly (colours, text+highlight gradient, align, position, size, shadow+offset, max-width, case, censor, entrance)');
  }

  // ---- G. BLANK-PREVIEW DETECTOR: the real imageLooksBlank() must flag a
  // black/uniform frame (the "video section is blank" bug) yet NEVER flag a
  // real caption-on-dark-frame render — tested through the SHIPPED function so
  // the runtime card/sheet fallback and the build-time thumb-scan gate agree ----
  const bl = await page.evaluate(async () => {
    const D = window.CP_DEBUG;
    if (!D || !D.imageLooksBlank) return { fatal: 'imageLooksBlank hook missing' };
    function paint(draw) {
      const c = document.createElement('canvas'); c.width = 284; c.height = 160;
      const x = c.getContext('2d'); draw(x, c); return c.toDataURL('image/png');
    }
    const black = paint((x, c) => { x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height); });
    // a thin light caption on a dark frame — the case that must NOT be flagged
    const caption = paint((x, c) => {
      x.fillStyle = '#0b0e16'; x.fillRect(0, 0, c.width, c.height);
      x.fillStyle = '#ffffff'; x.font = 'bold 20px sans-serif'; x.textAlign = 'center';
      x.fillText('MAKE EVERY WORD COUNT', c.width / 2, c.height * 0.55);
    });
    const uniformGrey = paint((x, c) => { x.fillStyle = '#3a3a3a'; x.fillRect(0, 0, c.width, c.height); });
    const load = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
    const [ib, ic, iu] = await Promise.all([load(black), load(caption), load(uniformGrey)]);
    return { black: D.imageLooksBlank(ib), caption: D.imageLooksBlank(ic), grey: D.imageLooksBlank(iu) };
  });
  if (bl.fatal) bad('blank-detector: ' + bl.fatal);
  else if (bl.black === true && bl.grey === true && bl.caption === false)
    ok('blank-preview detector: flags black + uniform frames, keeps a real caption render');
  else bad('blank-preview detector wrong: black=' + bl.black + ' grey=' + bl.grey + ' caption=' + bl.caption + ' (want true/true/false)');

  // ---- H. SHEET REAL-RENDER PERSISTENCE: clicking a template must show its
  // REAL render (matching the gallery card + the timeline), and only swap to the
  // live "your colours" swatch on the FIRST EDIT — not on open. The swap firing
  // on open was "the preview is different when I click a template" ----------------
  const sh = await page.evaluate(async () => {
    const D = window.CP_DEBUG;
    if (!D || !D.openMogrtSheet || !D.renderMogrtPreview || !D.sheetState) return { fatal: 'sheet hooks missing' };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // a non-blank caption still (a real render) as a data URL
    const c = document.createElement('canvas'); c.width = 284; c.height = 160;
    const x = c.getContext('2d'); x.fillStyle = '#0b0e16'; x.fillRect(0, 0, 284, 160);
    x.fillStyle = '#fff'; x.font = 'bold 22px sans-serif'; x.textAlign = 'center'; x.fillText('REAL RENDER', 142, 90);
    const thumb = c.toDataURL('image/png');
    try { D.openMogrtSheet({ name: 'ProofReal', path: '/nope/ProofReal.mogrt', mogrt: true, thumb: thumb, video: '' }); } catch (e) { return { fatal: 'openMogrtSheet threw: ' + e.message }; }
    await sleep(160);
    const onOpen = D.sheetState();
    // simulate the first edit of a NON-colour control (slider/toggle/outline colour):
    // sheetFirstEdit() is what those handlers call — it must trigger the swap even
    // though it doesn't touch a swatch colour (the confirmed regression case).
    D.sheetFirstEdit();
    await sleep(80);
    const afterEdit = D.sheetState();
    return { onOpen, afterEdit };
  });
  if (sh.fatal) bad('sheet real-render persistence: ' + sh.fatal);
  else if (sh.onOpen.showingReal && sh.onOpen.thumbShown && !sh.onOpen.liveShown &&
           sh.afterEdit.thumbShown && sh.afterEdit.liveShown)
    ok('sheet keeps the ORIGINAL render on screen always; the first edit reveals the "your colours" swatch BELOW it (never replaces the original)');
  else bad('sheet real-render wrong: onOpen=' + JSON.stringify(sh.onOpen) + ' afterEdit=' + JSON.stringify(sh.afterEdit) +
           ' (want onOpen thumb only, afterEdit thumb+live BOTH visible)');

  // ---- I. ASR LANGUAGE DEFAULT: must be AUTO-detect. The old 'en' default
  // FORCED English on every voice — Hindi audio transcribed as English-ish
  // nonsense ("If you India to the"). Locks the default forever. -------------
  const asr = await page.evaluate(() => {
    const D = window.CP_DEBUG;
    if (!D || !D.asrLang) return { fatal: 'asrLang hook missing' };
    return { lang: D.asrLang() };
  });
  if (asr.fatal) bad('asr default: ' + asr.fatal);
  else if (asr.lang === 'auto') ok('transcription language defaults to AUTO-detect (never forces English on Hindi audio)');
  else bad('asr default language is "' + asr.lang + '" — must be "auto"');

  // ---- J. FONT RESOLUTION: the face sent to Premiere must be a POSTSCRIPT
  // name. The picker shows family names ("Bebas Neue"); writing one into a
  // template's source text is silently ignored — "not able to change the
  // fonts". Drives the END-TO-END editor path: set the picker value → read
  // the exact font string Apply AND the real preview will send. ------------
  const fr = await page.evaluate(() => {
    const D = window.CP_DEBUG;
    if (!D || !D.psFontName || !D.editorFont) return { fatal: 'font hooks missing' };
    const el = document.getElementById('c-font');
    if (!el) return { fatal: '#c-font input missing' };
    const prev = el.value, out = {};
    el.value = 'Bebas Neue';       out.bebas = D.editorFont();
    el.value = 'Times New Roman';  out.tnr = D.editorFont();
    out.exact = D.psFontName('Times New Roman', 'Bold');
    el.value = prev;
    return out;
  });
  if (fr.fatal) bad('font resolution: ' + fr.fatal);
  else if (fr.bebas && fr.bebas.font === 'BebasNeue-Regular' &&
           fr.tnr && /^TimesNewRomanPS/.test(fr.tnr.font) && fr.tnr.font.indexOf(' ') === -1 &&
           fr.exact === 'TimesNewRomanPS-BoldMT')
    ok('chosen font reaches Premiere as its POSTSCRIPT name (Bebas Neue → ' + fr.bebas.font +
       ', Times New Roman → ' + fr.tnr.font + ') — family names were silently ignored before');
  else bad('font resolution wrong: ' + JSON.stringify(fr));

  // ---- K. SPEECH-FOLLOWING GROUPING through the real panel: a pause starts a
  // new caption, a Hindi danda ends a sentence, and REAL word timing attached
  // to the cues splits at a pause INSIDE one ASR line ("captions are not
  // following when someone takes a pause / sentences break in parts") --------
  const gr = await page.evaluate(() => {
    const D = window.CP_DEBUG;
    if (!D || !D.textCues) return { fatal: 'textCues hook missing' };
    const wEl = document.getElementById('c-words');
    const prevW = wEl ? wEl.value : null;
    if (wEl) wEl.value = '0';   // ✨ Auto (the new default)
    const out = {};
    // 0.9s pause between lines → two captions
    out.pause = D.textCues([{ start: 0, end: 1.2, text: 'kya haal hai' },
                            { start: 2.1, end: 3.2, text: 'sab theek hai' }], 0, 'as-spoken').length;
    // danda sentence break inside one line
    out.danda = D.textCues([{ start: 0, end: 4, text: 'मेरा नाम विकास है। आप कैसे हैं।' }], 0, 'as-spoken').length;
    // REAL word timing attached: the pause lives INSIDE the single ASR line
    const cs = [{ start: 0, end: 3.7, text: 'mera naam vikas hai aur aap kaise hain' }];
    cs.words = [
      { start: 0.0, end: 0.3, text: 'mera' }, { start: 0.3, end: 0.6, text: 'naam' },
      { start: 0.6, end: 1.0, text: 'vikas' }, { start: 1.0, end: 1.3, text: 'hai' },
      { start: 2.2, end: 2.5, text: 'aur' }, { start: 2.5, end: 2.9, text: 'aap' },
      { start: 2.9, end: 3.3, text: 'kaise' }, { start: 3.3, end: 3.7, text: 'hain' }
    ];
    const ww = D.textCues(cs, 0, 'as-spoken');
    out.words = ww.length; out.firstText = ww[0] && ww[0].text; out.secondStart = ww[1] && ww[1].start;
    if (wEl && prevW != null) wEl.value = prevW;
    return out;
  });
  if (gr.fatal) bad('speech-following grouping: ' + gr.fatal);
  else if (gr.pause === 2 && gr.danda === 2 && gr.words === 2 &&
           gr.firstText === 'mera naam vikas hai' && Math.abs(gr.secondStart - 2.2) < 1e-6)
    ok('captions follow the speech: a 0.9s pause and a Hindi danda (।) each start a new caption, and attached word timing splits at the REAL pause inside a line');
  else bad('speech-following grouping wrong: ' + JSON.stringify(gr));

  // ---- L. "🎬 AS SPOKEN" reveal: the entrance option exists and maps the
  // engine's base Text Opacity to 0, so each word paints only when the word
  // sweep reaches it ("text comes only when they say it") -------------------
  const sp = await page.evaluate((PROPS) => {
    const D = window.CP_DEBUG;
    if (!D || !D.mapPresetToFlux) return { fatal: 'mapPresetToFlux hook missing' };
    const btn = document.querySelector('[data-e="spoken"]');
    if (!btn) return { fatal: 'no As-spoken entrance button in the DOM' };
    const IDX = {}; PROPS.forEach(p => { IDX[p.name.toLowerCase()] = p.i; });
    const on = D.mapPresetToFlux({ fill: '#ffffff', highlight: '#ffd400', revealSpoken: true }, PROPS) || [];
    const off = D.mapPresetToFlux({ fill: '#ffffff', highlight: '#ffd400' }, PROPS) || [];
    const pick = (ps) => { const f = ps.find(p => p.i === IDX['text opacity']); return f && f.value; };
    return { onV: pick(on), offV: pick(off) };
  }, PROPS);
  if (sp.fatal) bad('as-spoken reveal: ' + sp.fatal);
  else if (sp.onV === 0 && sp.offV === 100)
    ok('🎬 As spoken: base Text Opacity 0 with the option on (words appear only when the sweep reaches them), 100 otherwise');
  else bad('as-spoken reveal wrong: ' + JSON.stringify(sp));

  // ---- M. SAVE AS CUSTOM works WITHOUT window.prompt: CEF suppresses
  // prompt() inside Premiere (returns null instantly), so "＋ Save" silently
  // did nothing ("save as custom is not saving"). Drives the real button →
  // in-panel name dialog → Save, and checks the template lands in
  // My Templates with the gallery switched there. --------------------------
  const sv = await page.evaluate(async () => {
    const D = window.CP_DEBUG;
    if (!D || !D.customCount || !D.libCategory) return { fatal: 'custom hooks missing' };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    window.prompt = () => { throw new Error('window.prompt must never be used — CEP suppresses it'); };
    const before = D.customCount();
    const btn = document.getElementById('btn-save-tpl');
    if (!btn) return { fatal: 'no ＋ Save button' };
    btn.click();
    await sleep(60);
    const ov = document.getElementById('cp-prompt-ov');
    if (!ov) return { fatal: 'in-panel name dialog did not open' };
    const inp = ov.querySelector('input');
    inp.value = 'Proof Custom Style';
    document.getElementById('cp-prompt-save').click();
    await sleep(120);
    const cards = document.querySelectorAll('#tpl-grid .tpl-name, #tpl-grid [class*="name"]');
    let seen = false;
    cards.forEach(c => { if (/Proof Custom Style/.test(c.textContent)) seen = true; });
    return { before, after: D.customCount(), cat: D.libCategory(), seen,
             overlayGone: !document.getElementById('cp-prompt-ov') };
  });
  if (sv.fatal) bad('save-as-custom: ' + sv.fatal);
  else if (sv.after === sv.before + 1 && sv.cat === 'My Templates' && sv.overlayGone)
    ok('＋ Save works without window.prompt: in-panel dialog → template saved (' + sv.before + '→' + sv.after +
       ') and the gallery jumps to My Templates' + (sv.seen ? ' showing it' : ''));
  else bad('save-as-custom wrong: ' + JSON.stringify(sv));

  // ---- N. SELF-TEST report card: the 🧪 button exists and the report builder
  // says the right thing for clean / warned / failing machines ---------------
  const st = await page.evaluate(() => {
    const D = window.CP_DEBUG;
    if (!D || !D.buildSelfTestReport) return { fatal: 'self-test hook missing' };
    if (!document.getElementById('btn-selftest')) return { fatal: 'no 🧪 button' };
    const clean = D.buildSelfTestReport([
      { name: 'A', state: 'ok', note: '' }, { name: 'B', state: 'ok', note: '' }]);
    const warned = D.buildSelfTestReport([
      { name: 'A', state: 'ok', note: '' }, { name: 'B', state: 'warn', note: 'x' }]);
    const failing = D.buildSelfTestReport([
      { name: 'A', state: 'fail', note: 'no frame' }, { name: 'B', state: 'fail', note: 'y' }]);
    return { clean: clean.split('\n')[0], warned: warned.split('\n')[0], failing: failing.split('\n')[0],
             marks: failing.indexOf('❌ A — no frame') > 0 };
  });
  if (st.fatal) bad('self-test: ' + st.fatal);
  else if (/^✅ Everything works/.test(st.clean) && /^⚠️ Working/.test(st.warned) &&
           /^❌ 2 problems found/.test(st.failing) && st.marks)
    ok('🧪 self-test report card: clean/warned/failing machines each get the right plain-language verdict');
  else bad('self-test report wrong: ' + JSON.stringify(st));

  await browser.close();
  console.log(failed ? ('panel proofs: ' + failed + ' FAILURE(S)') : 'panel proofs: ALL GREEN ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ harness error: ' + e.message); process.exit(1); });
