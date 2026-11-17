/*
 * silence-remember-choice.js — Clean up remembers how much the owner cuts.
 *
 * Clean up opened on ▶️ YouTube every time: an owner who makes reels or
 * podcasts tapped ⚡ Reel or 🎙 Podcast again on every visit, and the one-tap
 * card cut a reel with YouTube's gentler pauses whenever they forgot.
 *
 * Checked in the REAL panel (fake Premiere):
 *   · never picked, landscape sequence → ▶️ YouTube;
 *   · never picked, vertical (9:16) sequence → ⚡ Reel, on both the one-tap
 *     card and the step-by-step tools;
 *   · a pick (🎙 Podcast) survives closing and reopening the panel, wins over
 *     the vertical-sequence default, and is what the cut actually uses;
 *   · the retake strength (Gentle / Balanced / Strong) is remembered too.
 *
 * Exit 0 = pass, 1 = fail, 2 = skipped (no puppeteer / Chromium).
 */
'use strict';
const H = require('./retakes-lib/harness');

const C = H.checker();

async function run() {
  console.log('Clean up remembers the owner\'s pick');
  const browser = await H.launch();
  try {
    let env = { sequenceName: 'Episode', width: 1920, height: 1080 };
    const host = (fn) => fn === 'CP_getEnv' ? env : {};
    async function open(settings) {
      const r = await H.openPanel(browser, { host, settings: settings || {} });
      return r.page;
    }
    const picked = (page, id) => page.evaluate((id) => {
      const on = document.querySelector('#' + id + ' button.on');
      return on ? on.getAttribute('data-s') : null;
    }, id);
    async function openCleanUp(page) {
      await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="silence"]'); if (t) t.click(); });
      await new Promise(res => setTimeout(res, 400));
    }

    // never picked, landscape
    {
      env = { sequenceName: 'Episode', width: 1920, height: 1080 };
      const page = await open({});
      await openCleanUp(page);
      C.check('never picked, landscape sequence: Clean up starts on ▶️ YouTube',
        (await picked(page, 'ac-strength')) === 'balanced' && (await picked(page, 'sil-strength')) === 'balanced',
        (await picked(page, 'ac-strength')) + ' / ' + (await picked(page, 'sil-strength')));
      await page.close();
    }

    // never picked, vertical
    let saved = null;
    {
      env = { sequenceName: 'Reel', width: 1080, height: 1920 };
      const page = await open({});
      await openCleanUp(page);
      C.check('never picked, vertical 9:16 sequence: Clean up starts on ⚡ Reel (the one-tap card and the step-by-step tools)',
        (await picked(page, 'ac-strength')) === 'strong' && (await picked(page, 'sil-strength')) === 'strong',
        (await picked(page, 'ac-strength')) + ' / ' + (await picked(page, 'sil-strength')));
      // the owner taps 🎙 Podcast, and Strong for retakes
      await page.evaluate(() => {
        document.querySelector('#ac-strength button[data-s="gentle"]').click();
        const tk = document.querySelector('#tk-strength button[data-s="strong"]'); if (tk) tk.click();
      });
      saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cutpilot.settings') || '{}'));
      C.check('the pick is saved with the settings', saved.cleanStrength === 'gentle' && saved.takeStrength === 'strong', JSON.stringify({ clean: saved.cleanStrength, take: saved.takeStrength }));
      await page.close();
    }

    // reopened, still vertical: the pick wins
    {
      env = { sequenceName: 'Reel', width: 1080, height: 1920 };
      const page = await open(saved);
      await openCleanUp(page);
      const tune = await page.evaluate(() => (window.CP_DEBUG_EXT.silence && window.CP_DEBUG_EXT.silence.strength) ? window.CP_DEBUG_EXT.silence.strength() : null);
      C.check('reopened on a vertical sequence: Clean up still shows 🎙 Podcast, the owner\'s pick, on both',
        (await picked(page, 'ac-strength')) === 'gentle' && (await picked(page, 'sil-strength')) === 'gentle',
        (await picked(page, 'ac-strength')) + ' / ' + (await picked(page, 'sil-strength')));
      C.check('…and it is what the cut uses', tune === 'gentle', String(tune));
      C.check('the retake strength is remembered too (⚡ Strong)', (await picked(page, 'tk-strength')) === 'strong', String(await picked(page, 'tk-strength')));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
