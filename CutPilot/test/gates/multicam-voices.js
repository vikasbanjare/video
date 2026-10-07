/*
 * multicam-voices.js — one mic, two people: Podcast cameras follow each voice.
 *
 * The owner's podcasts are often on ONE mic. Pulse can't tell who is talking
 * by loudness then, so it switched cameras on each talk burst, whoever spoke.
 * Now it offers the free voice engine once ("Who's talking"), tells the voices
 * apart and gives each a camera. The REAL panel and host.jsx, real ffmpeg and
 * the real engine (set up by Pulse's own installer — voices-lib/engine.js) on
 * a conversation cut from sherpa-onnx's four-speaker recording, so who talks
 * when is known:
 *   A. engine not set up: Pulse asks once, before any download, saying how
 *      big it is; "Cancel" keeps the talk-burst plan and says where to set it
 *      up later; a second build doesn't ask again
 *   B. the download agreed to but the set-up fails: still a plan, and it says why
 *   C. engine set up, 2 cameras: no question, and the camera shows whoever is
 *      talking (Voice 1 → V1, Voice 2 → V2)
 *   D. ⇄ Swap speakers flips them; Redo after Apply keeps the swap — and
 *      neither listens again (the engine ran once), even with the recording
 *      razored into pieces
 *   E. 3 cameras, V1 set to “No mic (wide / cutaway)” by the owner: the
 *      voices go to V2 and V3
 *   F. 3 cameras, nothing set: Pulse decides how many people and says how
 *      many it heard; “How many people talk?” → 2 listens again for exactly
 *      two, and the camera left over is the wide
 *   G. Settings: Who's talking says whether it is set up, with the credit
 *      NVIDIA's model licence (CC-BY-4.0) asks for
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./multicam-lib/panel');
const FH = require('./multicam-lib/fakehost');
const E = require('./voices-lib/engine');
const V = require(path.join(P.PANEL_DIR, 'js', 'voices.js'));

let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Person A (host) and person D (guest) of the four-speaker recording, each
   piece trimmed 0.15 s inside its turn, as a 10-turn conversation. */
const A = [[0.47, 6.72], [22.29, 24.69], [52.68, 54.45]];
const D = [[27.79, 29.33], [30.15, 31.40], [33.83, 37.78]];
const TURNS = [['A', [0]], ['D', [2]], ['A', [1, 2]], ['D', [0, 1]], ['A', [2, 0]],
               ['D', [2, 0]], ['A', [1, 0]], ['D', [1, 2]], ['A', [0]], ['D', [0, 2, 1]]];
const LEAD = 6, TRIM = 1;          // the clip sits at 0:06 on the timeline, its first second trimmed off

(async () => {
  console.log('multicam who’s talking, one mic (' + P.PANEL_DIR + ')');
  if (!P.hasFfmpeg()) P.skip('no ffmpeg');
  const eng = await E.setUp(V);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-mc-voices-'));
  try {
    // the conversation, and who talks when on the timeline
    const pieces = [], truth = [];
    let at = 0;
    TURNS.forEach(([who, idx]) => {
      const src = who === 'A' ? A : D;
      let gap = 0.8, start = null;
      idx.forEach((k) => {
        at += gap; if (start == null) start = at;
        pieces.push({ from: src[k][0], to: src[k][1], gap });
        at += src[k][1] - src[k][0]; gap = 0.3;
      });
      truth.push({ start: LEAD - TRIM + start, end: LEAD - TRIM + at, who });
    });
    const convo = path.join(work, 'podcast-one-mic.wav');
    E.splice(eng.four, pieces, convo);
    const len = at + 0.5, DUR = Math.ceil(LEAD - TRIM + len + 1);
    const audio = [{ name: 'A1', clips: [{ start: LEAD, end: LEAD - TRIM + len, inPoint: TRIM, outPoint: len, mediaPath: convo, name: 'podcast-one-mic' }] }];
    const prog = eng.dir + '/' + V.binName('darwin');                         // the panel runs as on an Intel Mac
    const MB = Math.round(V.downloadSize('darwin', 'x64') / 1e6);
    const files = V.needFiles('darwin', 'x64').map(f => eng.dir + '/' + f);
    // % of talking (after a second's grace at each hand-over) with the right camera on screen
    const score = (world, camOf) => {
      let ok = 0, n = 0;
      truth.forEach(t => {
        for (let x = t.start + 1; x < t.end; x += 0.1) { n++; if (world.model.visibleAngle(x) === camOf[t.who]) ok++; }
      });
      return Math.round(1000 * ok / Math.max(1, n)) / 10;
    };
    const engineRuns = (ctx) => ctx.calls.filter(c => c.fn === 'spawn' && c.bin === prog).length;
    const open = (browser, cams, ready) => P.openPanel(browser, {
      premiere: { fps: 25, end: DUR, video: FH.cameras(cams, DUR), audio }, realFfmpeg: true,
      settings: { voicesDir: ready ? eng.dir : path.join(work, 'not-set-up') },
      files: ready ? files : [], bins: ready ? [prog] : []
    });
    // tap a button, then wait for the plan to change ('plan') or for Apply's own report ('apply')
    const tap = async (ctx, id, wait) => ctx.page.evaluate(async (id, wait) => {
      const sl = (ms) => new Promise(r => setTimeout(r, ms));
      const log = document.getElementById('log'), n0 = log.children.length, view = document.getElementById('mc-plan-view'), v0 = view.innerHTML;
      const applied = /Multicam applied|already has this edit|applied only partly|Multicam failed|wasn’t applied/;
      document.getElementById(id).click();
      for (let i = 0; i < 600; i++) {
        await sl(50);
        const news = Array.from(log.children).slice(n0).map(e => e.textContent);
        if (wait === 'apply' ? news.some(t => applied.test(t)) : (view.innerHTML !== v0 && view.querySelector('.seg-item'))) break;
      }
      await sl(300);
      return { view: view.innerText, toasts: Array.from(log.children).slice(n0).map(e => e.textContent) };
    }, id, wait);
    const mapLine = (r) => ((r.planView || r.view || '').split('\n').find(l => /Voice 1/.test(l)) || '').trim();

    await P.withBrowser(async (browser) => {
      // A. not set up: ask once, Cancel keeps the talk-burst plan
      {
        const ctx = await open(browser, 2, false);
        const r1 = await P.runMulticam(ctx, { cameras: 2, voices: 'no', apply: false });
        const r2 = await P.runMulticam(ctx, { cameras: 2, voices: 'no', apply: false });
        const q = r1.asked[0] || '';
        report(r1.asked.length === 1 && /one mic/i.test(q) && new RegExp('\\b' + MB + ' MB\\b').test(q) && !engineRuns(ctx),
          'A. not set up: Pulse asks before downloading, saying how big it is — ' + JSON.stringify(q.slice(0, 110)));
        const t1 = r1.toasts.join(' ');
        report(r1.planned && /one-mic mode/.test(t1) && /Who’s talking in Settings/.test(t1),
          'A. “Cancel”: the talk-burst plan, and where to set it up later — ' + JSON.stringify((r1.toasts.find(t => /one-mic/.test(t)) || '').split('|').pop().slice(0, 150)));
        report(r2.asked.length === 0 && r2.planned, 'A. a second build doesn’t ask again (' + r2.asked.length + ' questions)');
        await ctx.page.close();
      }
      // B. agreed, but the set-up can't run: still a plan, and why
      {
        const ctx = await open(browser, 2, false);
        const r = await P.runMulticam(ctx, { cameras: 2, voices: 'yes', apply: false });
        const t = r.toasts.join(' ');
        report(r.planned && /one-mic mode/.test(t) && /didn’t work this time/.test(t),
          'B. download agreed but the set-up fails: still a plan, and it says why — ' + JSON.stringify((r.toasts.find(x => /didn’t work/.test(x)) || '').split('|').pop().slice(0, 150)));
        await ctx.page.close();
      }
      // C + D. set up, two cameras
      {
        const ctx = await open(browser, 2, true);
        const r = await P.runMulticam(ctx, { cameras: 2 });
        const acc = r.plan ? score(ctx.world, { A: 0, D: 1 }) : 0;
        report(r.asked.length === 0 && /Voice 1 → V1/.test(mapLine(r)) && /Voice 2 → V2/.test(mapLine(r)) && !/Voice 3/.test(mapLine(r)) && acc >= 90,
          'C. 2 cameras: Pulse listens for two people, and the camera shows whoever is talking ' + acc + '% of the time (need ≥ 90%) — ' + JSON.stringify(mapLine(r)) +
          (r.plan ? '' : ' — no plan: ' + JSON.stringify((r.diag || r.toasts.slice(-1)[0] || '').slice(0, 160))));
        const sw = await tap(ctx, 'btn-mc-swap', 'plan');
        await tap(ctx, 'btn-mc-apply', 'apply');
        const accS = score(ctx.world, { A: 1, D: 0 });
        report(/Voice 1 → V2/.test(mapLine(sw)) && accS >= 90,
          'D. ⇄ Swap speakers: Voice 1 → V2, and the cameras follow it ' + accS + '% (need ≥ 90%) — ' + JSON.stringify(mapLine(sw)));
        // the recording razored into pieces (as Apply does to a camera's own linked sound)
        const a1 = ctx.world.model.audio[0];
        [20, 35.5, 50].forEach((cut) => {
          const c = a1.clips.find(q => q.start < cut && q.end > cut);
          const piece = Object.assign({}, c, { start: cut, inPoint: c.inPoint + (cut - c.start) });
          c.end = cut; c.outPoint = c.inPoint + (cut - c.start);
          a1.clips.push(piece); a1.ver = (a1.ver || 0) + 1;
        });
        const rd = await tap(ctx, 'btn-mc-redo', 'apply');
        const accR = score(ctx.world, { A: 1, D: 0 });
        report(/Voice 1 → V2/.test(mapLine(rd)) && accR >= 90 && engineRuns(ctx) === 1,
          'D. Redo after Apply — the recording now in ' + a1.clips.length + ' pieces — keeps the swap (' + accR + '%), and the engine listened once in all (' +
          engineRuns(ctx) + ' runs)');
        // G. Settings with the engine set up
        const st = await ctx.page.evaluate(() => ({ status: document.getElementById('voices-status').textContent,
          credit: document.getElementById('voices-credits').textContent }));
        report(/Ready/.test(st.status) && /NVIDIA/.test(st.credit) && /CC-BY-4\.0/.test(st.credit) && /sherpa-onnx/.test(st.credit) && /pyannote/.test(st.credit),
          'G. Settings: “' + st.status.slice(0, 40) + '…”, credit: ' + JSON.stringify(st.credit));
        await ctx.page.close();
      }
      // E. three cameras, V1 the owner's wide
      {
        const ctx = await open(browser, 3, true);
        const r = await P.runMulticam(ctx, { cameras: 3, map: ['-1'] });
        const acc = r.plan ? score(ctx.world, { A: 1, D: 2 }) : 0;
        report(/Voice 1 → V2/.test(mapLine(r)) && /Voice 2 → V3/.test(mapLine(r)) && acc >= 90,
          'E. 3 cameras, V1 set to “No mic (wide)”: the voices go to V2 and V3, right camera ' + acc + '% (need ≥ 90%) — ' + JSON.stringify(mapLine(r)));
        await ctx.page.close();
      }
      // F. three cameras, nothing set: Pulse decides, then the owner says "2 people"
      {
        const ctx = await open(browser, 3, true);
        const r = await P.runMulticam(ctx, { cameras: 3, apply: false });
        const sel = await ctx.page.evaluate(() => { const s = document.getElementById('mc-voices-people'); return s ? s.options[s.selectedIndex].textContent : null; });
        report(!!sel && /^Pulse decides \(heard \d\)$/.test(sel),
          'F. 3 cameras, nothing set: Pulse decides how many people and says so — “How many people talk?” ' + JSON.stringify(sel) + ', ' + JSON.stringify(mapLine(r)));
        const two = await ctx.page.evaluate(async () => {
          const sl = (ms) => new Promise(res => setTimeout(res, ms));
          const view = document.getElementById('mc-plan-view'), v0 = view.innerHTML, s = document.getElementById('mc-voices-people');
          s.value = '2'; s.dispatchEvent(new Event('change'));
          for (let i = 0; i < 600 && (view.innerHTML === v0 || !view.querySelector('.seg-item')); i++) await sl(50);
          await sl(300);
          const s2 = document.getElementById('mc-voices-people');
          return { view: view.innerText, sel: s2 ? s2.value : null };
        });
        await tap(ctx, 'btn-mc-apply', 'apply');
        const acc = score(ctx.world, { A: 0, D: 1 });
        report(two.sel === '2' && /Voice 1 → V1/.test(mapLine(two)) && /Voice 2 → V2/.test(mapLine(two)) && !/Voice 3/.test(mapLine(two)) && acc >= 90 &&
               engineRuns(ctx) === 2,
          'F. “2 people”: Pulse listens again for exactly two (' + engineRuns(ctx) + ' runs in all), V3 is left as the wide, right camera ' + acc +
          '% (need ≥ 90%) — ' + JSON.stringify(mapLine(two)));
        await ctx.page.close();
      }
      // G. Settings without the engine
      {
        const ctx = await open(browser, 2, false);
        const st = await ctx.page.evaluate(() => document.getElementById('voices-status').textContent);
        report(/Not set up yet/.test(st) && st.indexOf(MB + ' MB') >= 0, 'G. Settings before set-up: ' + JSON.stringify(st));
        await ctx.page.close();
      }
    });
  } finally {
    E.cleanUp(work); E.cleanUp(eng.dir);
  }
  if (failed) { console.log('MULTICAM WHO’S TALKING: ' + failed + ' failed'); process.exit(1); }
  console.log('MULTICAM WHO’S TALKING: one mic, the camera follows each voice ✓');
})().catch((e) => { console.log('  ✗ ' + (e && e.stack || e)); process.exit(1); });
