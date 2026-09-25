/*
 * ui-layout.js — every main screen works at every panel size and display
 * scaling Premiere can give the panel.
 *
 * The owner: "it should work in Premiere Pro whenever the panel size or display
 * scaling changes" / "the UI is still not adapting to different panel sizes".
 * Premiere ignores a docked panel's MinSize/MaxSize, so the panel really is
 * shown at 260 px wide, 400 px tall, on 1x, 125 %, 150 % and Retina screens.
 *
 * Renders all eleven main screens (Home, the caption gallery, the style editor,
 * Clean up, Podcast cameras, Transcript, Shorts, Chapters, Organize, Safe zone,
 * Settings) at widths 260/320/400/600/900/1400/1600 × heights 400/640/1000 ×
 * device pixel ratios 1/1.25/1.5/2 (1600: the widest the brief promises no
 * sideways scroll for — "260–1600 wide"), and FAILS on:
 *   · horizontal overflow — the page scrolls sideways, or something pokes past
 *     the panel edge (an intentional sideways-scrolling strip is allowed);
 *   · the screen's primary action not visible without scrolling (fully inside
 *     the panel and not covered by anything) at heights of 400 or more;
 *   · interactive elements overlapping each other (a sticky bar floating over
 *     content that scrolls under it is not an overlap);
 *   · tap targets under 28 px (a checkbox counts its whole label);
 *   · text under 11 px;
 *   · navigation taking more than 12 % of a 400 px-tall panel.
 *
 * CP_PANEL_DIR=<dir> runs it against another copy of the panel — that is how
 * it was shown to fail on the old layout (648ddc3).
 * UI_LAYOUT_QUICK=1 samples one DPR per size (for iterating; the battery runs all).
 */
'use strict';
const U = require('./ui-lib/panel');

const WIDTHS = [260, 320, 400, 600, 900, 1400, 1600];
const HEIGHTS = [400, 640, 1000];
const DPRS = process.env.UI_LAYOUT_QUICK ? [1] : [1, 1.25, 1.5, 2];
const NAV_MAX = 0.12;          // of the height, at 400 px tall
const MIN_TAP = 28;            // px
const MIN_TEXT = 11;           // px

/* Runs inside the page: one measurement of the active screen. */
function measure(args) {
  const { primary, W, H, MIN_TAP, MIN_TEXT } = args;
  const out = { overflow: [], primary: null, overlaps: [], small: [], tinyText: [], nav: 0, inter: 0, texts: 0 };
  const de = document.documentElement;
  const page = document.querySelector('.tab-page.active');
  if (!page) { out.fatal = 'no active page'; return out; }
  page.scrollTop = 0;
  const cs = el => getComputedStyle(el);
  const name = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (!el.id && el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  // inside a closed <details> (other than its summary) the owner cannot see
  // it — modern Chromium still lays such content out (content-visibility), so
  // client rects alone would count it
  const inClosedDetails = el => {
    for (let d = el.closest('details:not([open])'); d; d = d.parentElement ? d.parentElement.closest('details:not([open])') : null) {
      const sum = Array.from(d.children).find(c => c.tagName === 'SUMMARY');
      if (!(sum && (sum === el || sum.contains(el)))) return true;
    }
    return false;
  };
  const shown = el => {
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
    if (!el.getClientRects().length) return false;
    const s = cs(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    if (inClosedDetails(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // the chrome around the page: everything that is not page content
  const roots = [page];
  document.querySelectorAll('body > header, body > nav, body > footer, #app-bar').forEach(e => { if (roots.indexOf(e) < 0 && shown(e)) roots.push(e); });
  const all = [];
  roots.forEach(r => { all.push(r); r.querySelectorAll('*').forEach(e => all.push(e)); });
  const vis = all.filter(e => e.tagName !== 'SCRIPT' && e.tagName !== 'STYLE' && e.tagName !== 'OPTION' && shown(e));

  // ---- 1. horizontal overflow ------------------------------------------------
  if (de.scrollWidth > de.clientWidth + 1) out.overflow.push('the panel scrolls sideways by ' + (de.scrollWidth - de.clientWidth) + 'px');
  if (page.scrollWidth > page.clientWidth + 1) out.overflow.push('the page scrolls sideways by ' + (page.scrollWidth - page.clientWidth) + 'px');
  // an element is judged against the panel edge unless an ancestor below the
  // page clips or scrolls it sideways (that ancestor is judged instead)
  const clippedBy = el => {
    for (let a = el.parentElement; a && roots.indexOf(a) < 0; a = a.parentElement) {
      const ox = cs(a).overflowX;
      if (ox !== 'visible') return a;
    }
    return null;
  };
  const poke = [];
  for (const el of vis) {
    if (clippedBy(el)) continue;
    const s = cs(el);
    if (s.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.right > W + 1 || r.left < -1) poke.push(name(el) + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
  }
  if (poke.length) out.overflow.push(poke.length + ' element(s) past the panel edge: ' + poke.slice(0, 3).join(', '));

  // ---- 2. primary action on screen without scrolling ------------------------
  const p = primary && document.querySelector(primary);
  if (!p) out.primary = 'missing (' + primary + ')';
  else if (!shown(p)) out.primary = 'not shown (' + primary + ')';
  else {
    const r = p.getBoundingClientRect(), pr = page.getBoundingClientRect();
    const inside = r.top >= Math.max(0, pr.top) - 0.5 && r.bottom <= Math.min(H, pr.bottom) + 0.5 && r.left >= -0.5 && r.right <= W + 0.5;
    const hit = document.elementFromPoint(Math.min(W - 1, Math.max(0, r.left + r.width / 2)), Math.min(H - 1, Math.max(0, r.top + r.height / 2)));
    const onTop = !!hit && (hit === p || p.contains(hit) || (hit.tagName === 'LABEL' && hit.contains(p)));
    if (!inside) out.primary = primary + ' is at y=' + Math.round(r.top) + '..' + Math.round(r.bottom) + ' — off screen (visible ' + Math.round(Math.max(0, pr.top)) + '..' + Math.round(Math.min(H, pr.bottom)) + ')';
    else if (!onTop) out.primary = primary + ' is covered by ' + (hit ? name(hit) : 'nothing hit-testable');
  }

  // ---- 3/4. interactive elements: overlaps and tap-target size --------------
  const INTER = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"]';
  const inter = vis.filter(e => e.matches(INTER) && cs(e).pointerEvents !== 'none');
  out.inter = inter.length;
  const layerOf = el => {
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const pos = cs(a).position;
      if (pos === 'sticky' || pos === 'fixed' || pos === '-webkit-sticky') return a;
    }
    return null;
  };
  const visibleBox = el => {
    // the part of the element its clipping ancestors let the owner see
    let r = el.getBoundingClientRect();
    let L = r.left, T = r.top, R = r.right, B = r.bottom;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = cs(a);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        const q = a.getBoundingClientRect();
        if (s.overflowX !== 'visible') { L = Math.max(L, q.left); R = Math.min(R, q.right); }
        if (s.overflowY !== 'visible') { T = Math.max(T, q.top); B = Math.min(B, q.bottom); }
      }
    }
    return { left: L, top: T, right: R, bottom: B };
  };
  const boxes = inter.map(el => ({ el, r: el.getBoundingClientRect(), layer: layerOf(el) }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (a.layer !== b.layer) continue;        // a sticky bar over content that scrolls under it
      const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ix > 2 && iy > 2) out.overlaps.push(name(a.el) + ' × ' + name(b.el) + ' (' + Math.round(ix) + '×' + Math.round(iy) + 'px)');
    }
  }
  for (const el of inter) {
    let t = el;
    const type = (el.getAttribute('type') || '').toLowerCase();
    // a checkbox / radio is tapped through its label
    if ((type === 'checkbox' || type === 'radio') && el.closest('label')) t = el.closest('label');
    const r = t.getBoundingClientRect();
    // only what the owner can actually see (a chip scrolled out of its strip is not a target yet)
    const v = visibleBox(t);
    if (v.right - v.left < 1 || v.bottom - v.top < 1) continue;
    if (r.width < MIN_TAP - 0.5 || r.height < MIN_TAP - 0.5) out.small.push(name(el) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
  }

  // ---- 5. text under 11px ------------------------------------------------------
  for (const el of vis) {
    let hasText = false;
    for (const n of el.childNodes) if (n.nodeType === 3 && /\S/.test(n.nodeValue)) { hasText = true; break; }
    if (!hasText && !el.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), select, textarea')) continue;
    out.texts++;
    const fs = parseFloat(cs(el).fontSize);
    if (fs < MIN_TEXT - 0.05) out.tinyText.push(name(el) + ' ' + fs + 'px "' + String(el.textContent || el.placeholder || '').trim().slice(0, 24) + '"');
  }

  // ---- 6. navigation height ---------------------------------------------------
  const pr = page.getBoundingClientRect();
  out.nav = Math.round(Math.max(0, pr.top) + Math.max(0, H - pr.bottom));
  return out;
}

(async () => {
  const R = U.reporter('ui layout: every main screen at ' + WIDTHS.length * HEIGHTS.length * DPRS.length +
    ' panel sizes × scalings (' + WIDTHS.join('/') + ' wide × ' + HEIGHTS.join('/') + ' tall × DPR ' + DPRS.join('/') + ')');
  const browser = await U.launch();
  const fails = new Map();         // "screen · check" → [{size, detail}]
  const add = (screen, check, size, detail) => {
    const k = screen + ' · ' + check;
    if (!fails.has(k)) fails.set(k, []);
    fails.get(k).push({ size, detail });
  };
  let measured = 0, interSeen = 0, textSeen = 0;
  try {
    const page = await U.openPanel(browser, { viewport: { width: 400, height: 800 } });
    for (const s of U.SCREENS) {
      await page.setViewport({ width: 400, height: 800, deviceScaleFactor: 1 });
      const ok = await U.go(page, s);
      if (!ok) { add(s.id, 'screen', '-', 'this build has no ' + s.label + ' screen'); continue; }
      // a long, real-looking sequence name: the header must survive it
      await page.evaluate(() => { const e = document.getElementById('env-status'); if (e) e.textContent = 'Hindi Podcast Ep 12 · 1080×1920'; });
      for (const W of WIDTHS) for (const H of HEIGHTS) for (const D of DPRS) {
        await page.setViewport({ width: W, height: H, deviceScaleFactor: D });
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 140)))));
        await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.classList.add('hidden'); });
        const m = await page.evaluate(measure, { primary: s.primary, W, H, MIN_TAP, MIN_TEXT });
        const size = W + 'x' + H + '@' + D;
        measured++;
        if (m.fatal) { add(s.id, 'screen', size, m.fatal); continue; }
        interSeen += m.inter; textSeen += m.texts;
        if (m.overflow.length) add(s.id, 'horizontal overflow', size, m.overflow.join('; '));
        if (m.primary) add(s.id, 'primary action not on screen without scrolling', size, m.primary);
        if (m.overlaps.length) add(s.id, 'interactive elements overlap', size, m.overlaps.slice(0, 3).join(', ') + (m.overlaps.length > 3 ? ' …+' + (m.overlaps.length - 3) : ''));
        if (m.small.length) add(s.id, 'tap targets under ' + MIN_TAP + 'px', size, m.small.length + ': ' + m.small.slice(0, 4).join(', '));
        if (m.tinyText.length) add(s.id, 'text under ' + MIN_TEXT + 'px', size, m.tinyText.length + ': ' + m.tinyText.slice(0, 3).join(', '));
        if (H === 400 && m.nav > NAV_MAX * H) add(s.id, 'navigation over ' + Math.round(NAV_MAX * 100) + '% of a 400px-tall panel', size, m.nav + 'px of ' + H + 'px (' + Math.round(m.nav / H * 100) + '%)');
      }
    }
    if (page._cpErrors.length) add('panel', 'page errors', '-', page._cpErrors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }

  // a harness that stops measuring must not pass
  const want = U.SCREENS.length * WIDTHS.length * HEIGHTS.length * DPRS.length;
  if (measured < want * 0.5) R.bad('only ' + measured + ' of ' + want + ' screen × size combinations were measured');
  if (interSeen < measured * 3) R.bad('only ' + interSeen + ' interactive elements seen across ' + measured + ' measurements — the probe is not reaching the screens');
  for (const [k, v] of fails) {
    const sizes = v.map(x => x.size);
    R.bad(k + ' — ' + v.length + ' size(s): ' + sizes.slice(0, 6).join(' ') + (sizes.length > 6 ? ' …' : '') + '\n      e.g. ' + v[0].size + ': ' + v[0].detail);
  }
  if (!fails.size) {
    R.ok(measured + ' screen × size × scaling combinations: no sideways scroll, primary action on screen, no overlapping controls, every tap target ≥ ' + MIN_TAP + 'px, all text ≥ ' + MIN_TEXT + 'px');
    R.ok('navigation stays within ' + Math.round(NAV_MAX * 100) + '% of a 400px-tall panel on every screen');
  }
  R.done('UI LAYOUT: every main screen fits every panel size and scaling ✓',
         'UI LAYOUT: ' + fails.size + ' problem(s) above');
})().catch(e => { console.error('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
