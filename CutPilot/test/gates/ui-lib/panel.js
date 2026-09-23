/*
 * Shared helpers for the UI-shell gates (test/gates/ui-*.js).
 *
 * This folder is not a gate itself: run-tests.js only runs the *.js files that
 * sit directly in test/gates/.
 *
 *   launch()                headless Chromium (exit 2 when puppeteer/Chromium is missing)
 *   openPanel(browser, o)   boots the real panel (CutPilot/index.html, or the
 *                           copy named by CP_PANEL_DIR — that is how a gate is
 *                           proven to fail on an older build). o.host fakes a
 *                           Premiere host: { skin: {r,g,b} } answers
 *                           getHostEnvironment() the way CEP does and records the
 *                           theme-change listener, so a test can fire it.
 *   go(page, screen)        opens one of the owner's main screens the way the
 *                           panel itself does (the .tab[data-tab] buttons every
 *                           other gate uses), then the gallery / style editor.
 *   SCREENS                 the main screens and each one's primary action.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PANEL_DIR = process.env.CP_PANEL_DIR
  ? path.resolve(process.env.CP_PANEL_DIR)
  : path.join(__dirname, '..', '..', '..');
const PANEL_URL = 'file://' + path.join(PANEL_DIR, 'index.html');

/* Each main screen, how to reach it, and the one thing the owner came to do
   there. The primary action is what must be on screen without scrolling. */
const SCREENS = [
  { id: 'home',           tab: 'home',       primary: '#home-captions',  label: 'Home' },
  { id: 'captions',       tab: 'captions',   view: 'templates', primary: '#btn-magic', label: 'Captions (style gallery)' },
  { id: 'caption-editor', tab: 'captions',   view: 'style',     primary: '#btn-magic', label: 'Caption style editor' },
  { id: 'cleanup',        tab: 'silence',    primary: '#btn-autoclean',  label: 'Clean up' },
  { id: 'cameras',        tab: 'multicam',   primary: '#btn-mc-plan',    label: 'Podcast cameras' },
  { id: 'transcript',     tab: 'transcribe', primary: '#btn-tr-auto-ai', label: 'Transcript' },
  { id: 'shorts',         tab: 'shorts',     primary: '#btn-find-shorts', label: 'Shorts' },
  { id: 'chapters',       tab: 'chapters',   primary: '#btn-ch-build',   label: 'Chapters' },
  { id: 'organize',       tab: 'organize',   primary: '#cpo-run',        label: 'Organize' },
  { id: 'safezone',       tab: 'safezone',   primary: '#sz-apply',       label: 'Safe zone' },
  { id: 'settings',       tab: 'settings',   primary: '#set-groq-key',   label: 'Settings' }
];

function skip(why) {
  console.log('  ? ' + why + ' — gate SKIPPED (not a code failure; run node tools/doctor.js)');
  process.exit(2);
}

function loadPuppeteer() {
  const tries = ['/home/user/video/node_modules/puppeteer',
    path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'puppeteer'), 'puppeteer'];
  for (const t of tries) { try { return require(t); } catch (e) {} }
  return skip('puppeteer is not installed');
}

function chromiumPath(pptr) {
  const c = [process.env.CP_CHROMIUM, '/opt/pw-browsers/chromium', '/usr/bin/chromium-browser',
             '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
  for (const p of c) if (fs.existsSync(p)) return p;
  try { const p = pptr.executablePath(); if (p && fs.existsSync(p)) return p; } catch (e) {}
  return skip('no Chromium found (set CP_CHROMIUM)');
}

async function launch() {
  const pptr = loadPuppeteer();
  const exe = chromiumPath(pptr);
  let browser = null;
  for (let a = 1; a <= 3 && !browser; a++) {
    try {
      browser = await pptr.launch({ executablePath: exe, headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files'] });
    } catch (e) { if (a === 3) throw e; await new Promise(r => setTimeout(r, 1500 * a)); }
  }
  return browser;
}

/* A read-only stand-in for Premiere's CEP host: it answers the theme question
   the way CSInterface does (getHostEnvironment() → JSON with appSkinInfo) and
   keeps the listeners the panel registers, so window.__fireHost(type) can
   deliver com.adobe.csxs.events.ThemeColorChanged like Premiere does when the
   owner changes Appearance. Every ExtendScript call answers {ok:true}. */
function hostShim(host) {
  return '(' + function (H) {
    var listeners = {};
    window.__hostSkin = H.skin || null;
    window.__hostListeners = listeners;
    window.__fireHost = function (type) {
      (listeners[type] || []).forEach(function (fn) { try { fn({ type: type, data: '' }); } catch (e) {} });
      return (listeners[type] || []).length;
    };
    window.__adobe_cep__ = {
      getSystemPath: function () { return ''; },
      evalScript: function (s, cb) {
        var fn = String(s).split('(')[0], r = { ok: true };
        if (fn === 'CP_getEnv') r = { ok: true, width: 1080, height: 1920, sequenceName: H.seq || 'Hindi Podcast Ep 12', fps: 30 };
        setTimeout(function () { cb(JSON.stringify(r)); }, 0);
      },
      getHostEnvironment: function () {
        var s = window.__hostSkin;
        if (!s) return '{}';
        var col = { red: s.r, green: s.g, blue: s.b, alpha: 255 };
        return JSON.stringify({ appName: 'PPRO', appVersion: '25.0', appSkinInfo: {
          baseFontFamily: 'Adobe Clean', baseFontSize: 10,
          panelBackgroundColor: { antialiasLevel: 0, type: 1, color: col },
          appBarBackgroundColor: { antialiasLevel: 0, type: 1, color: col } } });
      },
      addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener: function () {},
      dispatchEvent: function () {}
    };
  }.toString() + ')(' + JSON.stringify(host || {}) + ');';
}

async function openPanel(browser, o) {
  o = o || {};
  const page = await browser.newPage();
  await page.setViewport(o.viewport || { width: 400, height: 800 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  page._cpErrors = errors;
  if (o.storage) {
    // seed the owner's saved settings on the FIRST load only — a reload is a
    // restart, and must see whatever the panel itself saved since
    await page.evaluateOnNewDocument((kv) => {
      try {
        if (sessionStorage.getItem('__cpSeeded')) return;
        sessionStorage.setItem('__cpSeeded', '1');
        Object.keys(kv).forEach(k => { if (kv[k] == null) localStorage.removeItem(k); else localStorage.setItem(k, kv[k]); });
      } catch (e) {}
    }, o.storage);
  }
  if (o.host) {
    // a fake host must not touch anything real: no network either
    await page.setRequestInterception(true);
    page.on('request', r => { if (r.url().startsWith('file:') || r.url().startsWith('data:')) r.continue(); else r.abort(); });
    await page.evaluateOnNewDocument(hostShim(o.host));
  }
  await page.goto(PANEL_URL, { waitUntil: o.host ? 'domcontentloaded' : 'networkidle0' });
  await new Promise(r => setTimeout(r, o.settle || 900));
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch (e) {}
  return page;
}

/* Open a main screen the way the owner does. Returns false when the screen
   does not exist in this build (the old panel has no Home). */
async function go(page, screen) {
  return page.evaluate(async (s) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const tab = document.querySelector('.tab[data-tab="' + s.tab + '"]');
    if (!tab) return false;
    tab.click(); await sleep(250);
    if (s.view === 'templates') {
      const vt = document.getElementById('view-templates');
      if (vt && vt.classList.contains('hidden')) {
        const b = document.querySelector('#cap-view button[data-view="templates"]') || document.getElementById('btn-browse-styles');
        if (b) b.click(); await sleep(400);
      }
    } else if (s.view === 'style') {
      const vt = document.getElementById('view-templates');
      if (vt && vt.classList.contains('hidden')) {
        const b = document.querySelector('#cap-view button[data-view="templates"]') || document.getElementById('btn-browse-styles');
        if (b) b.click(); await sleep(400);
      }
      const card = document.querySelector('#tpl-grid .tpl-card');
      if (!card) return false;
      card.click(); await sleep(450);
    }
    const t = document.getElementById('toast'); if (t) t.classList.add('hidden');
    return true;
  }, screen);
}

function reporter(title) {
  let failed = 0;
  console.log(title + '  (' + PANEL_DIR + ')');
  return {
    ok: m => console.log('  ✓ ' + m),
    bad: m => { console.log('  ✗ ' + m); failed++; },
    note: m => console.log('  · ' + m),
    get failed() { return failed; },
    done(passMsg, failMsg) {
      console.log(failed ? (failMsg || 'FAILED') : passMsg);
      process.exit(failed ? 1 : 0);
    }
  };
}

module.exports = { PANEL_DIR, PANEL_URL, SCREENS, skip, launch, openPanel, go, reporter, hostShim };
