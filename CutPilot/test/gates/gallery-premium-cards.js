/*
 * gallery-premium-cards.js — each ⚡ Premium card shows its template's words,
 * settled and whole; its clip plays only while it is pointed at.
 *
 * The owner's screenshot ("fix this preview also"): the cards played their
 * loops, so they were caught mid-animation — Orbit and Vector a blob over the
 * words, Vortex "FluxVor t" — and Echo's card said "Drift" (its template's own
 * words). The REAL panel (gallery-lib/panel.js, fake CEP host) on the shipped
 * previews (tools/real-mogrt-previews.js; gallery-real-previews.js checks the
 * pictures themselves):
 *   A. every Premium card shows its still (an <img> of mogrts/thumbs/<file>.png,
 *      loaded, shown whole) and no playing clip;
 *   B. pointing at a card with a clip plays it over the still; moving away
 *      takes it off again;
 *   C. Orbit and Vector (clips that turn into a blob) have no clip at all;
 *   D. the card that draws "Flux Drift" is called Flux Drift.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./gallery-lib/panel.js');

const r = G.reporter('Premium cards: settled words, clip on hover');

(async () => {
  const browser = await G.launch();
  try {
    const page = await G.openPanel(browser, { cep: true, gallery: false });
    await page.evaluate(async () => {
      const sl = (ms) => new Promise(res => setTimeout(res, ms));
      const t = document.querySelector('[data-tab="captions"]'); if (t) t.click();
      await sl(300);
      const fx = document.querySelector('[data-view="flux"]'); if (fx) fx.click();
      await sl(1200);
    });
    const cards = () => page.evaluate(() => Array.from(document.querySelectorAll('#flux-grid .tpl-card')).map(c => {
      const th = c.querySelector('.tpl-thumb'), im = th && th.querySelector('img'), v = th && th.querySelector('video');
      return { name: (c.querySelector('.tpl-name') || {}).textContent || '', img: im ? im.getAttribute('src') : null,
               loaded: !!(im && im.complete && im.naturalWidth > 0), fit: im ? getComputedStyle(im).objectFit : '',
               video: v ? v.getAttribute('src') : null, clip: th ? th.getAttribute('data-clip') : null };
    }));
    const A = await cards();
    const thumbs = path.join(G.MOGRT_DIR, 'thumbs');
    const shipped = A.filter(c => c.img && /\/mogrts\/thumbs\/Flux_[^/]+\.png$/.test(decodeURI(c.img)));
    const stillOk = A.length > 0 && shipped.length === A.length && A.every(c => c.loaded && c.fit === 'contain' && !c.video);
    (stillOk ? r.ok : r.bad)('A. all ' + A.length + ' Premium cards show their settled still, whole, with no clip playing' +
      (stillOk ? '' : ' — ' + JSON.stringify(A.filter(c => !(c.loaded && c.fit === 'contain' && !c.video) || !c.img).slice(0, 3))));
    // B. hover each card with a clip (headless Chromium can't decode H.264, so
    // a clip errors out and is taken off at once — what was put on is recorded)
    await page.evaluate(() => {
      window.__clipAdds = [];
      new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.tagName === 'VIDEO') window.__clipAdds.push(n.getAttribute('src')); })))
        .observe(document.getElementById('flux-grid'), { childList: true, subtree: true });
    });
    const handles = await page.$$('#flux-grid .tpl-card');
    let hovered = 0, played = 0, left = 0;
    for (let i = 0; i < handles.length; i++) {
      if (!A[i].clip) continue;
      hovered++;
      await handles[i].hover();
      await new Promise(res => setTimeout(res, 150));
      const on = await page.evaluate(() => window.__clipAdds.pop() || null);
      if (on && on === A[i].clip && /\/mogrts\/thumbs\/Flux_[^/]+\.mp4$/.test(decodeURI(on))) played++;
      await page.mouse.move(0, 0);
      await new Promise(res => setTimeout(res, 100));
      const off = await handles[i].evaluate(c => !c.querySelector('.tpl-thumb video'));
      if (off) left++;
    }
    const withMp4 = fs.readdirSync(thumbs).filter(f => /^Flux_.*\.mp4$/.test(f)).map(f => f.replace(/\.mp4$/, ''));
    const shownWithMp4 = A.filter(c => withMp4.some(b => decodeURI(c.img || '').indexOf('/' + b + '.png') >= 0)).length;
    (hovered > 0 && hovered === shownWithMp4 && played === hovered && left === hovered ? r.ok : r.bad)(
      'B. pointing at a card plays its own clip over the still, moving away stops it (' + played + ' of ' + hovered + ' played, ' + left + ' stopped; ' + shownWithMp4 + ' cards have a clip)');
    const blobs = A.filter(c => /Orbit|Vector/.test(c.name));
    (blobs.length === 2 && blobs.every(c => !c.clip && c.loaded) ? r.ok : r.bad)('C. Orbit and Vector show their author’s clean still and no clip (' +
      blobs.map(c => c.name + (c.clip ? ' has a clip' : ' still only')).join(', ') + ')');
    const names = A.map(c => c.name);
    (names.indexOf('Flux Drift') >= 0 && names.indexOf('Flux Echo') < 0 ? r.ok : r.bad)('D. the card that draws “Flux Drift” is called Flux Drift (' + names.join(', ') + ')');
    (!page._cpErrors.length ? r.ok : r.bad)('no script errors' + (page._cpErrors.length ? ': ' + page._cpErrors.slice(0, 2).join(' | ') : ''));
    await page.close();
  } finally {
    await browser.close();
  }
  r.done('PREMIUM CARDS: settled words on every card, clip on hover ✓', 'PREMIUM CARDS: failed');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
