/*
 * ui-contrast.js — every word on every main screen is readable in BOTH themes.
 *
 * Hard-coded colours made key text unreadable in one theme or the other: the
 * Multicam "you need the audio tool" warning was pale orange on near-white
 * (1.4:1), the transcript bar's "How?" link was lime on white (1.3:1), the
 * "one tap" badge 1.7:1, and in dark theme the Organize button was white on
 * lime (1.3:1).
 *
 * Opens each main screen at 400×800 in the light and the dark theme and
 * measures the WCAG contrast of every visible piece of text against what is
 * really behind it (walking up through translucent layers and gradients, and
 * taking the worst colour a gradient passes through). Fails under 4.5:1 for
 * normal text, under 3:1 for large text and for icon-only glyphs (☆ ✕ ⓘ ›).
 * Disabled controls are exempt (WCAG does not rate inactive controls).
 *
 * CP_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const U = require('./ui-lib/panel');

function audit() {
  const cs = el => getComputedStyle(el);
  const parse = s => {
    const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\s*\)/.exec(s || '');
    if (!m) return null;
    let a = m[4] == null ? 1 : (/%$/.test(m[4]) ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return [+m[1], +m[2], +m[3], a];
  };
  const over = (top, bot) => {           // composite top (rgba) over an opaque bot
    const a = top[3];
    return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1];
  };
  const lum = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const gradColors = img => {
    const out = [];
    if (!img || img === 'none') return out;
    const re = /rgba?\([^)]*\)|transparent/g; let m;
    while ((m = re.exec(img))) out.push(m[0] === 'transparent' ? [0, 0, 0, 0] : parse(m[0]));
    return out.filter(Boolean);
  };
  // every colour the backdrop of `el` can have: its own layers, then its
  // ancestors', composited from the first opaque one up
  const backdrops = el => {
    const layers = [];
    for (let a = el; a; a = a.parentElement) {
      const s = cs(a);
      const g = gradColors(s.backgroundImage);
      const c = parse(s.backgroundColor) || [0, 0, 0, 0];
      layers.push({ c, g });
      if (c[3] >= 0.999 && !g.length) break;
      if (a === document.documentElement) break;
    }
    let bases = [[255, 255, 255, 1]];
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      let next = bases.map(b => L.c[3] > 0 ? over(L.c, b) : b);
      if (L.g.length) {
        const withG = [];
        next.forEach(b => L.g.forEach(gc => withG.push(gc[3] > 0 ? over(gc, b) : b)));
        next = withG;
      }
      // keep it small: the lightest and darkest candidates bound the worst case
      next.sort((p, q) => lum(p) - lum(q));
      bases = next.length > 2 ? [next[0], next[next.length - 1]] : next;
    }
    return bases;
  };
  const opacityOf = el => { let o = 1; for (let a = el; a; a = a.parentElement) o *= parseFloat(cs(a).opacity) || 0; return o; };
  const inClosedDetails = el => {
    for (let d = el.closest('details:not([open])'); d; d = d.parentElement ? d.parentElement.closest('details:not([open])') : null) {
      const sum = Array.from(d.children).find(c => c.tagName === 'SUMMARY');
      if (!(sum && (sum === el || sum.contains(el)))) return true;
    }
    return false;
  };
  const shown = el => {
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
    if (!el.getClientRects().length || inClosedDetails(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const name = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (!el.id && typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const page = document.querySelector('.tab-page.active');
  const roots = [page].concat(Array.from(document.querySelectorAll('#app-bar, body > header, body > nav')).filter(shown));
  const out = [];
  let checked = 0;
  for (const root of roots) {
    for (const el of [root].concat(Array.from(root.querySelectorAll('*')))) {
      if (/^(SCRIPT|STYLE|OPTION|svg|path|CANVAS|VIDEO|IMG)$/i.test(el.tagName)) continue;
      let text = '';
      for (const n of el.childNodes) if (n.nodeType === 3) text += n.nodeValue;
      const isField = el.matches('input[type="text"], input[type="number"], input[type="password"], select, textarea');
      if (isField) text = el.value || '';
      text = text.trim();
      if (!text || !shown(el)) continue;
      if (el.disabled || el.closest('[disabled]')) continue;
      // the words of a control that is switched off with a reason (dimmed on
      // purpose) — WCAG does not rate inactive controls
      const lab = el.closest('label');
      if (lab && lab.querySelector('input:disabled, select:disabled, textarea:disabled, button:disabled')) continue;
      const s = cs(el);
      const fg = parse(s.color);
      if (!fg || fg[3] === 0) continue;                          // gradient-clipped wordmark etc.
      // emoji carry their own colours; judge only what the text colour paints
      const painted = text.replace(/[\p{Extended_Pictographic}\u200d\ufe0f\u20e3]/gu, '').trim();
      if (!painted) continue;
      const iconOnly = !/[\p{L}\p{N}]/u.test(painted);
      const size = parseFloat(s.fontSize), bold = parseInt(s.fontWeight, 10) >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      const need = (iconOnly || large) ? 3 : 4.5;
      const op = opacityOf(el);
      let worst = Infinity, worstBg = null;
      for (const bg of backdrops(el)) {
        const f = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
        const r = ratio(f, bg);
        if (r < worst) { worst = r; worstBg = bg; }
      }
      checked++;
      if (worst < need) out.push({ el: name(el), text: painted.slice(0, 28), ratio: Math.round(worst * 100) / 100, need,
        fg: s.color, bg: 'rgb(' + worstBg.slice(0, 3).map(Math.round).join(',') + ')' });
    }
  }
  return { checked, fails: out };
}

(async () => {
  const R = U.reporter('ui contrast: every word on every main screen is readable in the light AND the dark theme');
  const browser = await U.launch();
  let total = 0;
  try {
    for (const th of ['light', 'dark']) {
      // both the current setting key and the one older builds used
      const page = await U.openPanel(browser, { viewport: { width: 400, height: 800 },
        storage: { 'cutpilot.themeMode': th, 'cutpilot.theme': th } });
      const got = await page.evaluate(() => document.body.classList.contains('theme-dark') ? 'dark' : 'light');
      if (got !== th) { R.bad('could not open the panel in the ' + th + ' theme (got ' + got + ')'); await page.close(); continue; }
      for (const s of U.SCREENS) {
        if (!(await U.go(page, s))) { R.note(s.label + ': not in this build'); continue; }
        await new Promise(r => setTimeout(r, 250));
        const a = await page.evaluate(audit);
        total += a.checked;
        if (a.fails.length) {
          R.bad(th + ' · ' + s.label + ': ' + a.fails.length + ' unreadable — ' +
            a.fails.slice(0, 4).map(f => f.el + ' "' + f.text + '" ' + f.ratio + ':1 (needs ' + f.need + ', ' + f.fg + ' on ' + f.bg + ')').join('; '));
        }
      }
      if (page._cpErrors.length) R.bad(th + ': page errors: ' + page._cpErrors.slice(0, 3).join(' | '));
      await page.close();
    }
  } finally { await browser.close(); }
  if (total < 400) R.bad('only ' + total + ' pieces of text were checked — the audit is not reaching the screens');
  else if (!R.failed) R.ok(total + ' pieces of text on 11 screens × 2 themes: all at least 4.5:1 (3:1 for large text and icons)');
  R.done('UI CONTRAST: every word is readable in both themes ✓', 'UI CONTRAST: ' + R.failed + ' problem(s) above');
})().catch(e => { console.error('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
