/*
 * dead-control-audit.js — every control the customizer offers must CHANGE WHAT
 * THE USER SEES, on every kind of style.
 *
 * Why this exists: the hand-written "setting audit" in panel-proofs covered 16
 * controls. A mechanical sweep of all 64 found 47 that changed nothing at all —
 * the preview was built on carryableStyle() (what the mogrt ENGINE can express)
 * while the real render is handed the full {preset, overrides}. Anything the
 * narrow carry-set omitted could never appear in the preview no matter what the
 * user did, and nothing failed. This gate makes that class of bug loud.
 *
 * Hardened (pixels, every category). The first version had two blind spots:
 *   · it counted a change in the resolved STYLE OBJECT as a visible change, so
 *     a control that edited a field the renderer then ignored (gradient
 *     highlight on a Pill, glossy without a gradient, keyword glow on a white
 *     box, auto-enlarge while word-by-word is on…) passed;
 *   · it opened ONE style, so a control that is dead for a whole family of
 *     styles (every Button, every Pill-highlight style) was never seen.
 * Now it measures RENDERED PIXELS only — the live preview canvas exactly as
 * painted (which includes the on-screen position gauge) plus every frame of the
 * preview's timeline redrawn by the shipped renderer — and it repeats the whole
 * sweep on a representative style from EVERY gallery category, Buttons
 * included, in both caption types.
 *
 * Rules, per style and per control:
 *   · controls are judged in the style's OWN default state. A gate toggle is
 *     flipped only when the control is HIDDEN until that toggle is on — a
 *     visible control that does nothing until some other switch is set is
 *     exactly the "this setting does nothing" complaint;
 *   · the control is pressed (pointerdown/focus) before the "before" picture,
 *     the way a real user's hand lands on it before dragging (the preview arms
 *     its content demo for controls that act on what a caption says);
 *   · a control may be DISABLED — but only with a visible one-line reason next
 *     to it ([data-why-for="<id>"]), and a reason is a promise: a control that
 *     is disabled on every style swept must, once its reason is satisfied
 *     (ENABLE below), come back enabled and change the pixels;
 *   · a VISIBLE change is at least 16 pixels moving by more than 24 levels —
 *     antialiasing noise is not something the owner can see;
 *   · a visible, enabled control that changes zero pixels is DEAD, unless it is
 *     in CANNOT_SHOW with a written reason (and, where one exists, its ENABLE
 *     recipe proves it acts once the missing thing is supplied);
 *   · TWO IN A ROW: re-opening the style before every control hides a control
 *     that leaves the preview stuck for the NEXT one, so each style is then
 *     opened once more, a content-demo control (Lines on screen, Line spacing,
 *     Max width) is used, and every Words-per-caption press that changes the
 *     count must still change the pixels (SEQUENCES).
 *
 * Run: node tools/dead-control-audit.js   (wired into test/run-tests.js)
 *      node tools/dead-control-audit.js --verbose
 * As a module (test/gates/gallery-dead-controls.js): require it and call
 * runAudit({ pick: t => …, label: '…' }) to sweep any set of styles.
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
// CP_PANEL_DIR lets these run against the BUILT, obfuscated panel
// (CutPilot-protected) instead of the source — the build is what the owner
// installs, and obfuscation is a real chance to break behaviour that every
// source-side gate would still call green.
const PANEL_DIR = process.env.CP_PANEL_DIR || path.join(ROOT, 'CutPilot');
const PANEL = 'file://' + path.join(PANEL_DIR, 'index.html');
const VERBOSE = process.argv.indexOf('--verbose') >= 0;

/* Controls that CANNOT be observable in a frame preview, each with the reason.
   These are limits of what a preview can show, not broken wiring — every one of
   them is verified to reach the render by other gates. Keep this list short and
   justified; a control landing here without a real reason is a bug in hiding. */
const CANNOT_SHOW = {
  'c-emoji':         'auto-emoji fires on transcript keywords; the fixed sample phrase has none',
  'c-strippunct':    'the sample phrases carry no punctuation to strip',
  'c-censor':        'the sample phrases contain no profanity to mask',
  'c-speaker':       'speaker labels need cues carrying speaker identity; a one-line sample has none',
  'c-perword':       'per-word entrance is applied by Premiere to the placed clip, not baked into the frames',
  'c-perword-style': 'ditto — the style of a clip-level entrance the frames never contain',
  'c-animspeed':     'intentionally absent: animation follows the voice (see the hint in index.html)',
  // switching it on opens the keyword box; with the box still empty there is
  // no word to colour. ENABLE below types one and requires the colour to show.
  'c-brandon':       'colours only the words typed in the box it opens — with the box empty there is nothing to colour'
};
/* Hidden until another switch is on — flip that switch ONLY when the control is
   not on screen (see the header). Values: [id, value] pairs to apply in order. */
const GATE = {
  'c-box': [['c-box-on', true]], 'c-box2': [['c-boxgrad', true]],
  'c-shadow': [['c-shadow-on', true]], 'c-shadow-blur': [['c-shadow-on', true]],
  'c-shadow-dx': [['c-shadow-on', true]], 'c-shadow-dy': [['c-shadow-on', true]],
  'c-hl2g': [['c-hlgrad', true]], 'c-fill2': [['c-grad', true]],
  'c-num': [['c-numon', true]],
  'c-brand': [['c-brandon', true], ['c-brand-words', 'ZZTEST']], 'c-brand-words': [['c-brandon', true]],
  'c-boxstroke': [['c-boxstroke-on', true]], 'c-boxstrokew': [['c-boxstroke-on', true]],
  'c-boxglow': [['c-boxglow-on', true]], 'c-perword-style': [['c-perword', true]],
  'c-kw-mode': [['c-kw', true]], 'c-hl-scale': [['c-kw', true]],
  'c-hl2': [['c-multicolor', true]], 'c-hl3': [['c-multicolor', true]],
  'c-wordpop': [['c-wordhl', true]], 'c-multicolor': [['c-wordhl', true]], 'c-dimupcoming': [['c-wordhl', true]],
  'c-stroke': [['c-strokew', '8']]
};
/* A reason is a promise. For a control that is disabled with a reason on EVERY
   style swept (or is in CANNOT_SHOW), these steps satisfy the reason the way a
   user would — then the control must be enabled AND change the pixels.
   Steps: ['check', id, bool] · ['value', id, v] · ['click', selector] · ['press', id]. */
const COLOR_LOOK = ['click', '#c-hlstyle button[data-s="color"]'];
const ENABLE = {
  'c-emphasize':   [['check', 'c-wordhl', false]],
  'c-kw':          [['check', 'c-wordhl', false]],
  'c-kw-mode':     [['check', 'c-wordhl', false], ['check', 'c-kw', true]],
  'c-hl-scale':    [['check', 'c-wordhl', false], ['check', 'c-kw', true]],
  'c-hlgrad':      [COLOR_LOOK, ['check', 'c-multicolor', false]],
  'c-hl2g':        [COLOR_LOOK, ['check', 'c-multicolor', false], ['check', 'c-hlgrad', true]],
  'c-glossy':      [COLOR_LOOK, ['check', 'c-multicolor', false], ['check', 'c-hlgrad', true]],
  'c-hlglow':      [COLOR_LOOK],
  'c-box-opacity': [['check', 'c-box-on', true]],
  'c-box-pad':     [['check', 'c-box-on', true]],
  'c-box-radius':  [['check', 'c-box-on', true]],
  'c-boxglow-on':  [['check', 'c-box-on', true]],
  'c-box3d':       [['value', 'c-box3d-depth', '10']],
  'c-boxgloss':    [['check', 'c-box-on', true], ['value', 'c-box', '#202020']],
  'c-linegap':     [['click', '#c-lines button[data-l="0"]']],
  'c-wordspace':   [['press', 'wc-plus'], ['press', 'wc-plus']],
  'c-case':        [['check', 'c-upper', false]],
  'c-dimupcoming': [['click', '#c-reveal button[data-r="karaoke"]']],
  'c-hl3':         [['check', 'c-wordhl', true], ['check', 'c-multicolor', true], ['press', 'wc-plus'], ['press', 'wc-plus']],
  'c-brandon':     [['value', 'c-brand-words', 'ZZTEST']],
  'c-numon':       [['check', 'c-kw', false]],
  'c-hlserif':     [['check', 'c-wordhl', true]],
  'c-box-on':      [['check', 'c-boxgrad', false], ['value', 'c-box3d-depth', '0'], ['value', 'c-boxgloss', '0']]
};
/* TWO CONTROLS IN A ROW. The sweep re-opens the style before EVERY control, so
   a control that leaves the preview in a state where the NEXT one looks dead
   could never show up. It did: the layout controls switch the preview to a
   long demo caption, and after one touch of Lines on screen the preview stayed
   a single 10-word caption, so the Words-per-caption stepper changed the
   output but never the preview (measured on Podcast Dark Bar, Karaoke and
   Bold Statement). Here each style is opened ONCE, a content-demo control is
   used the way the owner uses it, and then every stepper button must still
   change the pixels. Steps as in ENABLE. */
const SEQUENCES = [
  { name: 'Lines on screen', first: [['press', 'c-lines'], ['click', '#c-lines button:not(.on)']] },
  { name: 'Line spacing', first: [['press', 'c-linegap'], ['value', 'c-linegap', '160']] },
  { name: 'Max width', first: [['press', 'c-maxwidth'], ['value', 'c-maxwidth', '60']] }
];
const SEQ_THEN = ['wc-plus', 'wc-minus'];   // judged like DRIVERS: the stepper is live if a press shows
/* Segmented button groups the user clicks — bound controls too. */
const SEGS = ['#c-hlstyle', '#c-reveal', '#c-lines', '#c-align'];
/* Hidden backing inputs and the on-screen buttons that drive them. */
const DRIVERS = { 'c-words': ['wc-plus', 'wc-minus'] };
/* Bound controls with their own handler, outside the preview's input list.
   ✨ Word-by-word highlight was never swept, and switching it off did nothing
   on a third of the library (styles whose own animation is the sweep). */
const EXTRA_IDS = ['c-wordhl'];

function requirePuppeteer() {
  for (const t of ['/home/user/video/node_modules/puppeteer', path.join(ROOT, 'node_modules', 'puppeteer'), 'puppeteer', 'puppeteer-core']) {
    try { return require(t); } catch (e) {}
  }
  return null;
}
function resolveBrowser(pptr) {
  if (process.env.CP_CHROMIUM && fs.existsSync(process.env.CP_CHROMIUM)) return process.env.CP_CHROMIUM;
  for (const c of ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'])
    if (fs.existsSync(c)) return c;
  try { const p = pptr.executablePath(); if (p && fs.existsSync(p)) return p; } catch (e) {}
  return null;
}

async function setCapOut(page, kind) {
  return page.evaluate(async (k) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const b = document.querySelector('#cap-output button[data-out="' + k + '"]');
    if (!b) return false;
    b.click(); await sleep(400);
    return true;
  }, kind);
}

/* One representative style per gallery category (the first one the gallery
   actually shows), plus the first style that declares the stacked two-tier
   fields so those two sliders are reachable, plus a white-box style (a halo in
   white vanishes on white). Picked from the live grid, so a category the
   gallery hides is not silently "represented" by nothing. */
async function pickReps(page) {
  return page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const b = document.getElementById('btn-browse-styles'); if (b) b.click();
    await sleep(500);
    const C = window.CPCaptions || {};
    const T = C.TEMPLATES || [];
    const inGrid = new Set(Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas'))
      .filter(c => c._tpl).map(c => c._tpl.id));
    const reps = [], used = new Set();
    for (const cat of (C.CATEGORIES || [])) {
      const t = T.find(x => x.category === cat && inGrid.has(x.id) && !used.has(x.id)) ||
                T.find(x => x.category === cat && inGrid.has(x.id));
      if (t) { reps.push({ cat, id: t.id }); used.add(t.id); }
      else reps.push({ cat, id: null });
    }
    const tt = T.find(x => inGrid.has(x.id) && x.subScale != null && x.wordsPerLine != null) ||
               T.find(x => inGrid.has(x.id) && (x.subScale != null || x.wordsPerLine != null));
    if (tt && !used.has(tt.id)) { reps.push({ cat: '(stacked two-tier fields)', id: tt.id }); used.add(tt.id); }
    const wb = T.find(x => inGrid.has(x.id) && !used.has(x.id) && /^#f[0-9a-f]f[0-9a-f]f[0-9a-f]$/i.test(String(x.boxColor || '')) && (x.highlightStyle || 'color') === 'color');
    if (wb) reps.push({ cat: '(white-box family)', id: wb.id });
    return reps;
  });
}

/* The whole sweep for ONE style, run inside the page. Synchronous between a
   control's "before" and "after" pictures, so the preview's own animation
   timer can never move a frame in between and fake a change.
   opts.only limits it to some controls; opts.recipe runs ENABLE steps after
   every reset (the "reason is a promise" pass). */
async function sweepStyle(page, styleId, cfg, opts) {
  return page.evaluate(async (styleId, cfg, opts) => {
    opts = opts || {};
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const el = id => document.getElementById(id);
    const fire = e => { e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
    const press = e => {
      try { e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); } catch (x) {}
      try { e.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch (x) {}
      try { e.dispatchEvent(new FocusEvent('focus')); e.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); } catch (x) {}
    };
    const R = window.CPRender;
    const card = () => {
      const c = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).find(x => x._tpl && x._tpl.id === styleId);
      if (!c) return null;
      let n = c; while (n && !(n.classList && n.classList.contains('tpl-card'))) n = n.parentNode;
      return n || c;
    };
    // Every byte of the canvas — a sampled read can step over a thin outline.
    const grab = cv => { try { return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; } catch (e) { return null; } };
    // PIXELS ONLY: the live canvas as painted (frame 0 + the position gauge),
    // then every frame of the preview's timeline redrawn at the same size by
    // the shipped renderer. No style fields, no frame metadata.
    const snap = () => {
      const c = el('preview-canvas');
      if (!c) return [];
      const parts = [grab(c)];
      const fr = c._pvFrames || [], st = c._pvStyle;
      if (st && R && R.drawFrame) {
        const off = document.createElement('canvas'); off.width = c.width; off.height = c.height;
        for (const f of fr) { try { R.drawFrame(off, f, st); parts.push(grab(off)); } catch (e) { parts.push(null); } }
      }
      return parts;
    };
    // VISIBLE change, not any change: at least 16 pixels moved by more than 24
    // levels in some channel. An exact byte comparison counted antialiasing
    // noise as "live" — a white halo drawn on a white box passed while the
    // owner saw nothing.
    const differs = (a, b) => {
      if (a.length !== b.length) return true;
      for (let k = 0; k < a.length; k++) {
        const x = a[k], y = b[k];
        if (!x || !y || x.length !== y.length) return true;
        let n = 0;
        for (let i = 0; i < x.length; i += 4) {
          if (Math.abs(x[i] - y[i]) > 24 || Math.abs(x[i + 1] - y[i + 1]) > 24 ||
              Math.abs(x[i + 2] - y[i + 2]) > 24 || Math.abs(x[i + 3] - y[i + 3]) > 24) { if (++n >= 16) return true; }
        }
      }
      return false;
    };
    const paneOf = e => {
      const p = e.closest && e.closest('#cust-pane-style, #cust-pane-pro');
      return p ? (p.id === 'cust-pane-pro' ? 'pro' : 'style') : null;
    };
    const showPane = which => {
      const b = document.querySelector('#cust-tabs button[data-pane="' + which + '"]');
      if (b && b.offsetParent !== null) b.click();
    };
    const visible = e => {
      if (!e) return false;
      // A hidden BACKING input (a visible stepper or colour picker drives it) is
      // reachable only if the thing that drives it is on screen.
      const box = e.closest('label, .swatches, .ctrl-row, .cust-group') || e.parentElement;
      return (e.offsetParent !== null) || (!!box && box !== e && box.offsetParent !== null);
    };
    const why = id => {
      const w = document.querySelector('[data-why-for="' + id + '"]');
      return (w && w.offsetParent !== null && String(w.textContent || '').trim()) ? String(w.textContent).trim() : '';
    };
    const valOf = e => (e.type === 'checkbox' ? e.checked : e.value);
    const setVal = (e, v) => { if (e.type === 'checkbox') e.checked = !!v; else e.value = String(v); fire(e); };
    // Re-open the style from its gallery card before EVERY control, so one
    // control's leftovers can never make the next one look dead (or alive).
    // Two change handlers set STICKY session flags that re-opening a style
    // deliberately keeps (they remember an explicit user opt-out); clear them
    // the way a user would, or the first style's gate would leak into every
    // later style: word-by-word ON again, "All together" again. Typed keyword
    // words are not part of a style either — clear them.
    const unstick = () => {
      const w = el('c-wordhl'); if (w && !w.checked) { w.checked = true; fire(w); }
      const k = document.querySelector('#c-reveal button[data-r="karaoke"]');
      if (k && !k.classList.contains('on')) k.click();
      const bw = el('c-brand-words'); if (bw && bw.value) { bw.value = ''; fire(bw); }
    };
    const runRecipe = steps => {
      for (const s of (steps || [])) {
        if (s[0] === 'click') { const b = document.querySelector(s[1]); if (b && !b.disabled) b.click(); }
        else if (s[0] === 'press') { const b = el(s[1]); if (b && !b.disabled) b.click(); }
        else { const g = el(s[1]); if (g && !g.disabled) setVal(g, s[2]); }
      }
    };
    const reset = () => { unstick(); const c = card(); if (c) c.click(); if (opts.recipe) runRecipe(opts.recipe); };

    const ids = (window._cpPreviewControlIds || []).concat(cfg.EXTRA_IDS || []).filter(id => !opts.only || opts.only.indexOf(id) >= 0);
    const results = [];
    if (!card()) return { err: 'style ' + styleId + ' has no card in the gallery grid' };

    for (const id of ids) {
      reset();
      const e = el(id);
      if (!e) { results.push({ id, skip: 'absent from the DOM' }); continue; }
      const pane = paneOf(e); if (pane) showPane(pane);
      if (!visible(e) && cfg.GATE[id]) {
        // flip the switch that reveals it — the way a user would, so a switch
        // that is itself disabled (with its reason) keeps the control hidden
        for (const [gid, gv] of cfg.GATE[id]) {
          const g = el(gid); if (!g || g.disabled) continue;
          setVal(g, gv);
        }
      }
      if (!visible(e)) { results.push({ id, hidden: true }); continue; }
      if (e.disabled) {
        const w = why(id);
        results.push(w ? { id, disabledWhy: w } : { id, disabledNoWhy: true });
        continue;
      }
      // A hidden backing input is driven by buttons the user presses (the
      // Words-per-caption stepper) — press THOSE, never type into the input
      // (an out-of-range value no user can reach proved nothing).
      if (cfg.DRIVERS[id]) {
        let hit = null;
        for (const bid of cfg.DRIVERS[id]) {
          reset(); if (pane) showPane(pane);
          const btn = el(bid);
          if (!btn || btn.offsetParent === null || btn.disabled) continue;
          press(btn);
          const b0 = snap();
          btn.click();
          if (differs(b0, snap())) { hit = bid; break; }
        }
        results.push({ id, how: 'press ' + (hit || cfg.DRIVERS[id].join('/')), changed: !!hit });
        continue;
      }
      press(e);
      const orig = valOf(e);
      const before = snap();
      let how = '', changed = false;
      if (e.tagName === 'SELECT') {
        const opts2 = Array.from(e.options).map(o => o.value).filter(v => v !== e.value);
        if (!opts2.length) { results.push({ id, skip: 'single-option select' }); continue; }
        let hit = null;
        for (const o of opts2) { e.value = o; fire(e); if (differs(before, snap())) { hit = o; break; } }
        how = 'select ' + (hit || opts2.join('/')); changed = !!hit;
      } else if (e.type === 'checkbox') {
        e.checked = !e.checked; how = 'toggle->' + e.checked; fire(e); changed = differs(before, snap());
      } else if (e.type === 'color' || /^#[0-9a-fA-F]{6}$/.test(String(e.value || ''))) {
        e.value = (String(e.value).toLowerCase() === '#ff00aa') ? '#00ffaa' : '#ff00aa'; how = 'colour ' + e.value;
        fire(e); changed = differs(before, snap());
      } else if (e.type === 'number' || e.type === 'range') {
        const min = parseFloat(e.min) || 0, max = parseFloat(e.max) || 100, cur = parseFloat(e.value);
        let v = (isFinite(cur) && Math.abs(cur - max) < Math.abs(cur - min)) ? min : max;
        if (v === cur) v = (v === max) ? min : max;
        e.value = String(v); how = 'number ' + cur + '→' + v;
        fire(e); changed = differs(before, snap());
      } else {
        e.value = (e.value === 'ZZTEST') ? 'YYTEST' : 'ZZTEST'; how = 'text'; fire(e); changed = differs(before, snap());
      }
      results.push({ id, how, changed });
      // a few controls are not re-set by opening a style (auto-emoji) — put back
      setVal(e, orig);
    }

    // segmented button groups: any OTHER button must change the pixels
    for (const sel of (opts.only ? [] : cfg.SEGS)) {
      reset();
      const box = document.querySelector(sel);
      if (!box) { results.push({ id: sel, skip: 'absent from the DOM' }); continue; }
      const pane = paneOf(box); if (pane) showPane(pane);
      if (box.offsetParent === null) { results.push({ id: sel, hidden: true }); continue; }
      const btns = Array.from(box.querySelectorAll('button'));
      const on = btns.find(b => b.classList.contains('on')) || btns[0];
      press(box);
      const before = snap();
      let hit = null;
      for (const b of btns) {
        if (b === on) continue;
        if (b.disabled) continue;
        b.click();
        if (differs(before, snap())) { hit = b.textContent.trim(); break; }
      }
      results.push({ id: sel, how: 'click ' + (hit || btns.filter(b => b !== on).map(b => b.textContent.trim()).join('/')), changed: !!hit });
      if (on) on.click();
    }
    unstick();
    await sleep(30);
    return { results };
  }, styleId, cfg, opts || {});
}

/* TWO CONTROLS IN A ROW for ONE style (see SEQUENCES): open the style once,
   use the first control, then press each stepper button and require a visible
   change. Pulse-rendered only — the layout controls are Pulse-only. */
async function sequenceSweep(page, styleId, cfg) {
  return page.evaluate(async (styleId, cfg) => {
    const el = id => document.getElementById(id);
    const fire = e => { e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
    const press = e => {
      try { e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); } catch (x) {}
      try { e.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch (x) {}
      try { e.dispatchEvent(new FocusEvent('focus')); e.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); } catch (x) {}
    };
    const R = window.CPRender;
    const grab = cv => { try { return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; } catch (e) { return null; } };
    const snap = () => {
      const c = el('preview-canvas');
      if (!c) return [];
      const parts = [grab(c)];
      const fr = c._pvFrames || [], st = c._pvStyle;
      if (st && R && R.drawFrame) {
        const off = document.createElement('canvas'); off.width = c.width; off.height = c.height;
        for (const f of fr) { try { R.drawFrame(off, f, st); parts.push(grab(off)); } catch (e) { parts.push(null); } }
      }
      return parts;
    };
    const differs = (a, b) => {
      if (a.length !== b.length) return true;
      for (let k = 0; k < a.length; k++) {
        const x = a[k], y = b[k];
        if (!x || !y || x.length !== y.length) return true;
        let n = 0;
        for (let i = 0; i < x.length; i += 4) {
          if (Math.abs(x[i] - y[i]) > 24 || Math.abs(x[i + 1] - y[i + 1]) > 24 ||
              Math.abs(x[i + 2] - y[i + 2]) > 24 || Math.abs(x[i + 3] - y[i + 3]) > 24) { if (++n >= 16) return true; }
        }
      }
      return false;
    };
    const card = () => {
      const c = Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).find(x => x._tpl && x._tpl.id === styleId);
      if (!c) return null;
      let n = c; while (n && !(n.classList && n.classList.contains('tpl-card'))) n = n.parentNode;
      return n || c;
    };
    const showPane = which => {
      const b = document.querySelector('#cust-tabs button[data-pane="' + which + '"]');
      if (b && b.offsetParent !== null) b.click();
    };
    const paneOf = e => {
      const p = e && e.closest && e.closest('#cust-pane-style, #cust-pane-pro');
      return p ? (p.id === 'cust-pane-pro' ? 'pro' : 'style') : null;
    };
    const unstick = () => {
      const w = el('c-wordhl'); if (w && !w.checked) { w.checked = true; fire(w); }
      const k = document.querySelector('#c-reveal button[data-r="karaoke"]');
      if (k && !k.classList.contains('on')) k.click();
    };
    if (!card()) return { err: 'style ' + styleId + ' has no card in the gallery grid' };
    const out = [];
    for (const seq of cfg.SEQUENCES) {
      for (const bid of cfg.SEQ_THEN) {
        unstick(); card().click();
        // the first control, used the way a hand uses it (press, then change)
        let usable = true;
        for (const s of seq.first) {
          if (s[0] === 'press') {
            const e = el(s[1]); if (!e) { usable = false; break; }
            const pane = paneOf(e); if (pane) showPane(pane);
            if (e.offsetParent === null || e.disabled) { usable = false; break; }
            press(e);
          } else if (s[0] === 'click') {
            const b = document.querySelector(s[1]); if (!b || b.disabled) { usable = false; break; }
            b.click();
          } else {
            const g = el(s[1]); if (!g || g.disabled) { usable = false; break; }
            g.value = String(s[2]); fire(g);
          }
        }
        if (!usable) { out.push({ seq: seq.name, then: bid, skip: true }); continue; }
        const btn = el(bid);
        if (!btn || btn.offsetParent === null || btn.disabled) { out.push({ seq: seq.name, then: bid, skip: true }); continue; }
        press(btn);
        const before = snap();
        const wordsBefore = el('c-words') ? el('c-words').value : '';
        btn.click();
        const wordsAfter = el('c-words') ? el('c-words').value : '';
        out.push({ seq: seq.name, then: bid, changed: differs(before, snap()), words: wordsBefore + '→' + wordsAfter });
      }
    }
    unstick();
    return { rows: out };
  }, styleId, cfg);
}

/* Run the two-controls-in-a-row pass over `reps` and judge it: after a
   content-demo control, a stepper press that changes the words per caption
   must change the pixels. Returns the failure count. */
async function judgeSequences(page, reps, opts) {
  const cfg = { SEQUENCES, SEQ_THEN };
  let failed = 0, checked = 0;
  const dead = new Map();
  for (const r of reps) {
    const res = await sequenceSweep(page, r.id, cfg);
    if (res.err) { failed++; opts.bad('two in a row / ' + r.id + ': ' + res.err); continue; }
    // per first control: the stepper is live when ANY press that changed the
    // words per caption changed the pixels (the same rule DRIVERS uses)
    const bySeq = new Map();
    for (const x of res.rows) {
      if (x.skip) continue;
      const moved = x.words && x.words.split('→')[0] !== x.words.split('→')[1];
      if (!moved) continue;
      if (!bySeq.has(x.seq)) bySeq.set(x.seq, []);
      bySeq.get(x.seq).push(x);
    }
    for (const [seqName, xs] of bySeq) {
      checked += xs.length;
      if (xs.some(x => x.changed)) continue;
      if (!dead.has(seqName)) dead.set(seqName, []);
      dead.get(seqName).push(r.id + ' (' + xs.map(x => x.then + ' ' + x.words).join(', ') + ')');
    }
  }
  for (const [k, v] of dead) { failed++; opts.bad('DEAD AFTER ANOTHER CONTROL: after ' + k + ', the Words-per-caption stepper changes the count but no pixels on ' + v.length + ' style(s): ' + v.slice(0, 6).join(', ')); }
  if (!checked) { failed++; opts.bad('two in a row: no sequence could be exercised — the pass is not reaching the customizer'); }
  else if (!dead.size) opts.ok('two controls in a row: after Lines on screen, Line spacing or Max width, the Words-per-caption stepper still changes the preview (' + checked + ' presses on ' + reps.length + ' styles)');
  return failed;
}

/* Sweep `reps` (in both caption types) and judge. Returns the failure count.
   opts: { log, ok, bad, minStyles, minLive, promise } */
async function judgeSweep(page, reps, opts) {
  const cfg = { GATE, SEGS, DRIVERS, EXTRA_IDS };
  const log = opts.log, ok = opts.ok, bad = opts.bad;
  let failed = 0;
  const fail = m => { failed++; bad(m); };
  const seenLive = new Map();          // control → a style where it changed the pixels
  const disabledOn = new Map();        // control → a reason seen on screen
  const everSeen = new Set();
  const deadRows = [];                 // {mode, style, cat, id, how}
  const noWhyRows = [];
  const cannotShowSeen = new Set();

  async function runMode(mode) {
    for (const r of reps) {
      const res = await sweepStyle(page, r.id, cfg);
      if (res.err) { fail(mode + ' / ' + r.cat + ': ' + res.err); continue; }
      for (const x of res.results) {
        everSeen.add(x.id);
        if (x.skip || x.hidden) continue;
        if (x.disabledNoWhy) { noWhyRows.push({ mode, style: r.id, cat: r.cat, id: x.id }); continue; }
        if (x.disabledWhy) { if (!disabledOn.has(x.id)) disabledOn.set(x.id, x.disabledWhy); continue; }
        if (x.changed === true) { if (!seenLive.has(x.id)) seenLive.set(x.id, mode + ' on ' + r.id); continue; }
        if (x.changed === false && CANNOT_SHOW[x.id]) { cannotShowSeen.add(x.id); continue; }
        if (x.changed === false) deadRows.push({ mode, style: r.id, cat: r.cat, id: x.id, how: x.how });
      }
      if (VERBOSE) log('  · ' + mode + ' ' + r.id + ': ' + res.results.filter(x => x.changed === false).map(x => x.id).join(' '));
    }
  }

  await runMode('Pulse-rendered');
  let editableRan = false;
  if (await setCapOut(page, 'editable')) { editableRan = true; await runMode('editable'); }
  await setCapOut(page, 'png');

  // A reason is a promise: whatever was disabled (or CANNOT_SHOW) on EVERY style
  // swept must work once the reason is satisfied.
  const promised = [];
  if (opts.promise !== false) {
    const owed = Array.from(new Set(Array.from(disabledOn.keys()).concat(Array.from(cannotShowSeen))))
      .filter(id => !seenLive.has(id) && ENABLE[id]);
    for (const id of owed) {
      let proof = null;
      for (const r of reps) {
        const res = await sweepStyle(page, r.id, cfg, { only: [id], recipe: ENABLE[id] });
        const x = (res.results || [])[0];
        if (x && x.changed === true) { proof = r.id; break; }
      }
      if (proof) { seenLive.set(id, 'Pulse-rendered on ' + proof + ' once its reason is met'); promised.push(id); }
      else fail('BROKEN PROMISE: ' + id + ' is disabled on every style swept ("' + (disabledOn.get(id) || CANNOT_SHOW[id]) +
                '"), and meeting that reason (' + JSON.stringify(ENABLE[id]) + ') still changes no pixels');
    }
    const unowed = Array.from(disabledOn.keys()).filter(id => !seenLive.has(id) && !ENABLE[id]);
    for (const id of unowed) fail('DISABLED EVERYWHERE, no way shown to enable it: ' + id + ' ("' + disabledOn.get(id) + '") — add its ENABLE recipe');
  }

  // A harness that silently stops exercising things is the failure mode that
  // hid this whole bug class — refuse to pass on a near-empty sweep. Only a
  // control that CHANGED PIXELS counts as exercised; a disabled one does not.
  const ids = Array.from(everSeen);
  const live = ids.filter(id => seenLive.has(id));
  if (reps.length < (opts.minStyles || 8)) fail('only ' + reps.length + ' styles were swept — the audit is not reaching the gallery');
  if (live.length < (opts.minLive || 45))
    fail('only ' + live.length + ' controls changed the pixels anywhere — the sweep is not reaching the customizer');
  else ok(live.length + ' controls change the rendered pixels across ' + reps.length + ' styles' +
          (editableRan ? ' (both caption types)' : '') + (promised.length ? '; ' + promised.length + ' of them once their on-screen reason is met' : ''));

  // group the dead ones: control → which styles
  const byCtl = new Map();
  for (const d of deadRows) {
    const k = d.mode + ' · ' + d.id;
    if (!byCtl.has(k)) byCtl.set(k, { how: d.how, styles: [] });
    byCtl.get(k).styles.push(d.style + ' (' + d.cat + ')');
  }
  for (const [k, v] of byCtl) fail('DEAD: ' + k + ' [' + v.how + '] changes no pixels on ' + v.styles.length + ' style(s): ' + v.styles.join(', '));
  for (const r of noWhyRows) fail('DISABLED WITHOUT A REASON: ' + r.mode + ' · ' + r.id + ' on ' + r.style + ' — show the one-line reason next to it');
  if (!byCtl.size && !noWhyRows.length) ok('no dead controls: every visible control changes the rendered pixels, or is disabled with a reason on screen that holds');

  // keep the allow-list honest in both directions
  for (const id of Object.keys(CANNOT_SHOW)) {
    const v = seenLive.get(id);
    if (v && !ENABLE[id]) log('  · ' + id + ' is observable now (' + v + ') — drop it from CANNOT_SHOW');
  }
  // (a sweep of a chosen SUBSET of styles may lack the one family that shows a
  // control — the category-wide run keeps every control reachable)
  const unreachable = ids.filter(id => !seenLive.has(id) && !disabledOn.has(id) && !CANNOT_SHOW[id] && !deadRows.some(d => d.id === id));
  if (opts.reachAll !== false) for (const id of unreachable) fail('UNREACHABLE: ' + id + ' — never on screen for any style swept');
  else if (unreachable.length) log('  · not shown by any style in this set (the category audit covers them): ' + unreachable.join(', '));
  if (!editableRan) fail('editable mode: could not switch caption type, so that half was never swept');
  return failed;
}

async function openAuditPage() {
  const pptr = requirePuppeteer();
  if (!pptr) return { skip: 'no puppeteer available' };
  const exe = resolveBrowser(pptr);
  if (!exe) return { skip: 'no Chromium available' };
  const browser = await pptr.launch({ executablePath: exe, headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e && e.message)));
  await page.goto(PANEL, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1600));
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch (e) {}
  await page.evaluate(() => { const t = document.querySelector('[data-tab="captions"]'); if (t) t.click(); });
  await new Promise(r => setTimeout(r, 400));
  return { browser, page, pageErrors };
}

/* Sweep a set of styles. Default: one representative per gallery category.
   opts.pick(t) chooses templates instead (the gallery gates sweep every new
   style this way); opts.minStyles / opts.minLive set the floors. */
async function runAudit(opts) {
  opts = opts || {};
  const log = opts.log || (m => console.log(m));
  let failed = 0;
  const ok = m => log('  ✓ ' + m), bad = m => { log('  ✗ ' + m); failed++; };
  const env = await openAuditPage();
  if (env.skip) { log('  ? ' + env.skip + ' — dead-control audit skipped'); return { skipped: true }; }
  let reps;
  if (opts.pick) {
    reps = await env.page.evaluate(async (src) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const b = document.getElementById('btn-browse-styles'); if (b) b.click(); await sleep(500);
      const pick = new Function('t', 'return (' + src + ')(t);');
      const inGrid = new Set(Array.from(document.querySelectorAll('#tpl-grid .tpl-thumb-canvas')).filter(c => c._tpl).map(c => c._tpl.id));
      return (window.CPCaptions.TEMPLATES || []).filter(t => pick(t)).map(t => ({ cat: t.category, id: inGrid.has(t.id) ? t.id : null, want: t.id }));
    }, opts.pick.toString());
    for (const r of reps.filter(x => !x.id)) bad('style "' + r.want + '" has no card in the gallery — it cannot be audited');
    reps = reps.filter(r => r.id);
  } else {
    reps = await pickReps(env.page);
    for (const r of reps.filter(x => !x.id)) bad('category "' + r.cat + '" shows no style in the gallery — it cannot be audited');
    reps = reps.filter(r => r.id);
    log('  · representatives: ' + reps.map(r => r.cat + '=' + r.id).join(', '));
  }
  failed += await judgeSweep(env.page, reps, { log, ok, bad: m => log('  ✗ ' + m), minStyles: opts.minStyles, minLive: opts.minLive,
                                              reachAll: !opts.pick });
  // the same styles again, two controls in a row without re-opening the style
  if (opts.sequences !== false) {
    await setCapOut(env.page, 'png');
    failed += await judgeSequences(env.page, reps, { ok, bad: m => log('  ✗ ' + m) });
  }
  if (env.pageErrors.length) bad('page errors: ' + env.pageErrors.slice(0, 3).join(' | '));
  await env.browser.close();
  return { failed, styles: reps.length };
}

module.exports = { CANNOT_SHOW, GATE, ENABLE, SEGS, DRIVERS, EXTRA_IDS, SEQUENCES, SEQ_THEN, runAudit, sweepStyle,
                   sequenceSweep, judgeSequences, openAuditPage, pickReps, setCapOut };

if (require.main === module) {
  (async () => {
    console.log('dead-control audit (every control must change the rendered pixels, on every kind of style)');
    const r = await runAudit({});
    if (r.skipped) process.exit(2);
    console.log(r.failed ? 'DEAD-CONTROL AUDIT: failures above' : 'DEAD-CONTROL AUDIT: every control changes what you see, on every kind of style ✓');
    process.exit(r.failed ? 1 : 0);
  })().catch(e => { console.error('  ✗ ' + (e && e.message)); process.exit(1); });
}
