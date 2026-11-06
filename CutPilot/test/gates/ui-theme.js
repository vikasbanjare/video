/*
 * ui-theme.js — the panel follows Premiere's theme; the 🌙/☀️ toggle is an
 * override the owner can undo.
 *
 * The panel always opened white inside Premiere's dark UI and never changed
 * when the owner changed Premiere's Appearance: it read neither CEP's
 * appSkinInfo nor com.adobe.csxs.events.ThemeColorChanged.
 *
 * With a stand-in Premiere host that answers getHostEnvironment() exactly the
 * way CEP does (appSkinInfo.panelBackgroundColor) and delivers the
 * theme-change event:
 *   1. a dark Premiere → the panel opens dark;
 *   2. the owner switches Premiere to Light → the event fires → the panel goes
 *      light, and back to dark the same way;
 *   3. the header toggle overrides: a later Premiere change does not undo it,
 *      and it survives a restart;
 *   4. Settings → Look → "Match Premiere" hands control back to Premiere;
 *   5. a host that reports no colours, and a plain browser, fall back to the
 *      computer's own light/dark setting without an error.
 *
 * CP_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const U = require('./ui-lib/panel');

const DARK = { r: 35, g: 35, b: 35 };          // Premiere "Dark"
const DARKEST = { r: 29, g: 29, b: 29 };
const LIGHT = { r: 240, g: 240, b: 240 };     // Premiere "Light"
const EVT = 'com.adobe.csxs.events.ThemeColorChanged';

const theme = page => page.evaluate(() => document.body.classList.contains('theme-dark') ? 'dark' : (document.body.classList.contains('theme-light') ? 'light' : '?'));
const hostChanges = (page, skin) => page.evaluate((skin, evt) => { window.__hostSkin = skin; return window.__fireHost(evt); }, skin, EVT);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const R = U.reporter('ui theme: the panel follows Premiere, and the owner can override it');
  const browser = await U.launch();
  try {
    // 1-4: one install, fresh storage
    const page = await U.openPanel(browser, { host: { skin: DARK }, storage: { 'cutpilot.themeMode': null, 'cutpilot.theme': null } });
    const t0 = await theme(page);
    if (t0 === 'dark') R.ok('Premiere is dark → the panel opens dark');
    else R.bad('Premiere is dark but the panel opened ' + t0);

    const n = await hostChanges(page, LIGHT); await sleep(150);
    const t1 = await theme(page);
    if (!n) R.bad('the panel never listens for Premiere\'s theme-change event (' + EVT + ')');
    if (t1 === 'light') R.ok('Premiere switched to Light → the event fired → the panel went light');
    else R.bad('Premiere switched to Light and the panel stayed ' + t1);
    await hostChanges(page, DARKEST); await sleep(150);
    const t2 = await theme(page);
    if (t2 === 'dark') R.ok('…and back to Darkest → dark again');
    else R.bad('Premiere switched back to Darkest and the panel stayed ' + t2);

    // 3. the toggle overrides
    await page.evaluate(() => { const b = document.getElementById('theme-toggle'); if (b) b.click(); });
    await sleep(100);
    const t3 = await theme(page);
    await hostChanges(page, DARK); await sleep(150);
    const t4 = await theme(page);
    if (t3 === 'light' && t4 === 'light') R.ok('the 🌙/☀️ toggle overrides: light stays light when Premiere changes again');
    else R.bad('the toggle is not an override (after toggle: ' + t3 + ', after a Premiere change: ' + t4 + ')');
    await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(900);
    const t5 = await theme(page);
    if (t5 === 'light') R.ok('the override survives a restart (Premiere still dark, panel light)');
    else R.bad('the override was lost on restart (' + t5 + ')');

    // 4. hand control back to Premiere
    const back = await page.evaluate(() => {
      const b = document.querySelector('#set-theme [data-theme="auto"]');
      if (!b) return false;
      b.click(); return true;
    });
    await sleep(100);
    const t6 = await theme(page);
    await hostChanges(page, LIGHT); await sleep(150);
    const t7 = await theme(page);
    if (!back) R.bad('Settings has no "Match Premiere" choice to undo the override');
    else if (t6 === 'dark' && t7 === 'light') R.ok('Settings → Look → Match Premiere: the panel follows Premiere again (dark, then light)');
    else R.bad('"Match Premiere" did not hand control back (' + t6 + ' then ' + t7 + ')');
    if (page._cpErrors.length) R.bad('page errors: ' + page._cpErrors.slice(0, 3).join(' | '));
    await page.close();

    // 5a. a host that reports no colours: no crash, computer setting stands in
    const p2 = await U.openPanel(browser, { host: { skin: null }, storage: { 'cutpilot.themeMode': null } });
    const t8 = await theme(p2);
    if ((t8 === 'light' || t8 === 'dark') && !p2._cpErrors.length) R.ok('a host that reports no colours still gets a theme (' + t8 + '), no error');
    else R.bad('no host colours → theme "' + t8 + '"' + (p2._cpErrors.length ? ', errors: ' + p2._cpErrors.join(' | ') : ''));
    await p2.close();

    // 5b. outside Premiere: the computer's dark mode
    const p3 = await browser.newPage();
    await p3.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await p3.evaluateOnNewDocument(() => { try { localStorage.removeItem('cutpilot.themeMode'); localStorage.removeItem('cutpilot.theme'); } catch (e) {} });
    await p3.goto(U.PANEL_URL, { waitUntil: 'networkidle0' }); await sleep(700);
    const t9 = await theme(p3);
    if (t9 === 'dark') R.ok('outside Premiere, a computer in dark mode gets the dark panel');
    else R.bad('outside Premiere, dark mode on the computer still gave the ' + t9 + ' panel');
    await p3.close();
  } finally { await browser.close(); }
  R.done('UI THEME: the panel follows Premiere, and the toggle is a real override ✓',
         'UI THEME: ' + R.failed + ' problem(s) above');
})().catch(e => { console.error('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
