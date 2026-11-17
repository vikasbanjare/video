/*
 * Applying the multicam plan tells the truth about what reached the timeline.
 *
 * The old CP_applyMulticamPlan swallowed every razor error and returned ok, so
 * when Premiere's QE razor refused (QE off, a Premiere update, a locked track)
 * one camera ended up on screen for the whole episode while the panel said
 * "🎬 Multicam applied". And with the Drop-frame setting on, cuts on a 29.97
 * sequence landed up to 3.6 s early by the hour.
 *
 * The real host.jsx runs on a mini-Premiere whose razor can throw, do nothing,
 * or fail now and then, and whose razor reads ';' timecode as SMPTE drop-frame
 * (the sequence reports Premiere's own 29.97 / 59.94 drop-frame codes, 102 /
 * 106). With linked camera audio, switching a camera's video off switches its
 * audio off too — Apply must hand the owner's sound back untouched.
 * The panel checks go through the real panel as well.
 * MC_PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const path = require('path');
const P = require('./multicam-lib/panel');
const FH = require('./multicam-lib/fakehost');
const S = require('./multicam-lib/synth');

const HOST = path.join(P.PANEL_DIR, 'jsx', 'host.jsx');
let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };

function world(spec) {
  const w = FH.makePremiere(Object.assign({ fps: 25, end: 60, video: FH.cameras(2, 60), audio: [] }, spec));
  return { w, host: FH.loadHost(HOST, w) };
}
const PLAN4 = [{ start: 0, end: 12, angle: 0 }, { start: 12, end: 30, angle: 1 }, { start: 30, end: 44, angle: 0 }, { start: 44, end: 60, angle: 1 }];
function unchanged(w) { return w.model.video.every(t => t.clips.length === 1 && t.clips.every(c => !c.disabled)); }
/* seconds of the plan where the viewer sees a different camera (ignoring ±1 frame at cuts) */
function wrongSeconds(w, plan, fps) {
  let bad = 0;
  plan.forEach(s => { for (let t = s.start + 1 / fps; t < s.end - 1 / fps; t += 0.05) if (w.model.visibleAngle(t) !== s.angle) bad += 0.05; });
  return Math.round(bad * 100) / 100;
}

console.log('multicam apply (' + P.PANEL_DIR + ')');

// ---- a refused razor: nothing may change, and it must say so ---------------------
for (const mode of ['throws', 'noop']) {
  const { w, host } = world({ razor: mode });
  const r = FH.call(host, 'CP_applyMulticamPlan', { plan: PLAN4, numAngles: 2, dropFrame: false });
  report(r.ok === false && /nothing was switched|unchanged/i.test(r.error || '') && unchanged(w),
    'QE razor ' + (mode === 'throws' ? 'throws' : 'silently does nothing') + ': Apply fails and changes nothing — got ' +
    JSON.stringify(r.ok ? { ok: true, razored: r.razored, toggled: r.toggled } : { ok: false, error: (r.error || '').slice(0, 70) }) + ', timeline ' + (unchanged(w) ? 'unchanged' : 'CHANGED'));
}
// ---- a timeline whose timecode starts at 01:00:00:00 -------------------------------
// (if QE reads razor timecodes as the sequence's own timecode, no cut lands —
// nothing may change, and the owner must be told the way out)
{
  const { w, host } = world({ startTime: 3600 });
  const r = FH.call(host, 'CP_applyMulticamPlan', { plan: PLAN4, numAngles: 2, dropFrame: false });
  report(r.ok === false && /starts at 01:00:00:00/.test(r.error || '') && /Start Time/.test(r.error || '') && unchanged(w),
    'a timeline starting at 01:00:00:00: nothing changes and the owner is told how to fix it — got ' + JSON.stringify(r.ok ? { ok: true } : (r.error || '').slice(0, 150)));
}
// ---- a locked camera track --------------------------------------------------------
{
  const { w, host } = world({ video: [{ name: 'V1', clips: [{ start: 0, end: 60, name: 'cam1' }] }, { name: 'V2', locked: true, clips: [{ start: 0, end: 60, name: 'cam2' }] }] });
  const r = FH.call(host, 'CP_applyMulticamPlan', { plan: PLAN4, numAngles: 2, dropFrame: false });
  report(r.ok === false && /V2 is locked/.test(r.error || '') && unchanged(w),
    'a locked camera track (V2): Apply stops before changing anything and names it — got ' + JSON.stringify(r.ok ? { ok: true, toggled: r.toggled } : (r.error || '').slice(0, 60)));
}
// ---- some cuts refused: applied, but reported as partial -----------------------------
{
  const { w, host } = world({});
  let calls = 0;
  const q = w.sandbox.qe.project.getActiveSequence;
  w.sandbox.qe.project.getActiveSequence = () => {
    const s = q();
    const get = s.getVideoTrackAt.bind(s);
    s.getVideoTrackAt = (i) => { const tr = get(i); const raz = tr.razor.bind(tr); tr.razor = (tc) => { if (++calls % 3 === 0) throw new Error('razor failed'); return raz(tc); }; return tr; };
    return s;
  };
  const r = FH.call(host, 'CP_applyMulticamPlan', { plan: PLAN4, numAngles: 2, dropFrame: false });
  report(r.ok === true && r.missedCuts > 0 && Array.isArray(r.missedAt) && r.missedAt.length > 0 && r.verifiedPct < 99,
    'every third razor refused: the result counts the cuts that did not land — missedCuts ' + r.missedCuts + ' at ' + JSON.stringify(r.missedAt) + ', verified ' + r.verifiedPct + '%');
}
// ---- a camera with no footage where the plan wants it: reported apart ------------------
{
  const { w, host } = world({ video: [{ name: 'V1', clips: [{ start: 0, end: 60, name: 'cam1' }] }, { name: 'V2', clips: [{ start: 10, end: 60, name: 'cam2' }] }] });
  const plan = [{ start: 0, end: 12, angle: 1 }, { start: 12, end: 30, angle: 0 }, { start: 30, end: 60, angle: 1 }];
  const r = FH.call(host, 'CP_applyMulticamPlan', { plan, numAngles: 2, dropFrame: false });
  report(r.ok && r.noFootageSec === 12 && r.noFootageAt && r.noFootageAt[0].camera === 'V2' && r.verifiedPct === 100 && r.missedCuts === 0,
    'V2 starts at 0:10 but the plan wants it from 0:00: reported as missing footage, not a failed apply — ' +
    JSON.stringify({ noFootageSec: r.noFootageSec, at: r.noFootageAt, verified: r.verifiedPct, missed: r.missedCuts }));
}
// ---- the normal case: every shot verified on the timeline ------------------------------
{
  const { w, host } = world({});
  const r = FH.call(host, 'CP_applyMulticamPlan', { plan: PLAN4, numAngles: 2, dropFrame: false });
  report(r.ok && r.missedCuts === 0 && r.verifiedPct === 100 && wrongSeconds(w, PLAN4, 25) === 0,
    'a normal apply: every cut lands, verified ' + r.verifiedPct + '%, wrong camera ' + wrongSeconds(w, PLAN4, 25) + ' s');
}
// ---- drop-frame: cuts land on the right frame by the hour ------------------------------
{
  const plan = [{ start: 0, end: 600, angle: 0 }, { start: 600, end: 1800, angle: 1 }, { start: 1800, end: 3599, angle: 0 }, { start: 3599, end: 3660, angle: 1 }];
  for (const c of [{ fps: 30000 / 1001, df: true, tick: true, name: '29.97 DF sequence, Drop-frame setting on' },
                   { fps: 30000 / 1001, df: true, tick: false, name: '29.97 DF sequence, setting off' },
                   { fps: 60000 / 1001, df: true, tick: true, name: '59.94 DF sequence, setting on' },
                   { fps: 60000 / 1001, df: true, tick: false, name: '59.94 DF sequence, setting off (Premiere\'s own 59.94 DF code decides)' },
                   { fps: 60000 / 1001, df: false, tick: true, name: '59.94 NON-drop sequence, setting on' },
                   { fps: 30000 / 1001, df: false, tick: true, name: '29.97 NON-drop sequence, setting on' },
                   { fps: 25, df: false, tick: true, name: '25 fps sequence, setting on' }]) {
    // whichever way QE reads the timecode (by its ';' or in the sequence's own format)
    const runs = ['separator', 'sequence'].map(qeParse => {
      const { w, host } = world({ fps: c.fps, dropFrameDisplay: c.df, qeParse, end: 3660, video: FH.cameras(2, 3660) });
      const r = FH.call(host, 'CP_applyMulticamPlan', { plan, numAngles: 2, dropFrame: c.tick });
      // where did each cut land? the first clip edge after each boundary
      const edges = w.model.video[0].clips.map(x => x.start).filter(x => x > 0);
      const err = [600, 1800, 3599].map(b => Math.min.apply(null, edges.map(e => Math.abs(e - b))));
      return { ok: r.ok, worst: Math.max.apply(null, err), tcs: w.model.razorTimecodes.slice(0, 3).join(' ') };
    });
    const worst = Math.max(runs[0].worst, runs[1].worst);
    report(runs[0].ok && runs[1].ok && worst <= 1 / c.fps + 1e-6, c.name + ': worst cut off by ' + worst.toFixed(3) + ' s (need ≤ 1 frame, QE reading ' +
      'the timecode either way) — timecodes ' + runs[0].tcs);
  }
}

// ---- linked camera audio: switching a camera off must not silence the episode ----------
// Premiere may switch a camera's LINKED audio off together with its video (and
// cut it with the razor). The owner's sound must come through Apply untouched:
// every audio clip that was on stays on, a clip they switched off stays off.
{
  const { w, host } = world({
    linkedAudio: true,
    audio: [
      { name: 'A1', clips: [{ start: 0, end: 60, inPoint: 0, outPoint: 60, mediaPath: '/media/cam1.mov', name: 'cam1 audio' }] },
      { name: 'A2', clips: [{ start: 0, end: 60, inPoint: 0, outPoint: 60, mediaPath: '/media/cam2.mov', name: 'cam2 audio' }] },
      { name: 'A3', clips: [{ start: 0, end: 30, inPoint: 0, outPoint: 30, mediaPath: '/media/lav.wav', name: 'lav' },
                            { start: 30, end: 40, inPoint: 30, outPoint: 40, mediaPath: '/media/lav.wav', name: 'lav', disabled: true },
                            { start: 40, end: 60, inPoint: 40, outPoint: 60, mediaPath: '/media/lav.wav', name: 'lav' }] }
    ]
  });
  const r = FH.call(host, 'CP_applyMulticamPlan', { plan: PLAN4, numAngles: 2, dropFrame: false });
  let silent = 0;
  w.model.audio.slice(0, 2).forEach(t => t.clips.forEach(c => { if (c.disabled) silent += c.end - c.start; }));
  const lav = w.model.audio[2].clips.map(c => (c.disabled ? 'off' : 'on') + ' ' + c.start + '–' + c.end).join(', ');
  report(r.ok && silent === 0 && lav === 'on 0–30, off 30–40, on 40–60' && r.verifiedPct === 100 && wrongSeconds(w, PLAN4, 25) === 0,
    'linked camera audio: after Apply the cameras\' own sound is off for ' + silent.toFixed(1) + ' s (need 0), the lav reads "' + lav +
    '" (the owner\'s own switched-off clip stays off), verified ' + r.verifiedPct + '%');
}

// ---- a SECOND Apply keeps the sound the owner switched off, off -------------------
// After the first Apply the owner switches off camera 1's own sound (they use
// the lav). A second Apply switches camera 1 pieces back ON, and their linked
// sound came back on with them — the old restore only ever switched sound back
// ON, never off again.
{
  const linked = () => world({
    linkedAudio: true,
    audio: [
      { name: 'A1', clips: [{ start: 0, end: 60, inPoint: 0, outPoint: 60, mediaPath: '/media/cam1.mov', name: 'cam1 audio' }] },
      { name: 'A2', clips: [{ start: 0, end: 60, inPoint: 0, outPoint: 60, mediaPath: '/media/cam2.mov', name: 'cam2 audio' }] },
      { name: 'A3', clips: [{ start: 0, end: 60, inPoint: 0, outPoint: 60, mediaPath: '/media/lav.wav', name: 'lav' }] }
    ]
  });
  const PLAN4B = [{ start: 0, end: 12, angle: 1 }, { start: 12, end: 30, angle: 0 }, { start: 30, end: 44, angle: 1 }, { start: 44, end: 60, angle: 0 }];
  const { w, host } = linked();
  const r1 = FH.call(host, 'CP_applyMulticamPlan', { plan: PLAN4, numAngles: 2, dropFrame: false });
  w.model.audio[0].clips.forEach(c => { c.disabled = true; });          // the owner: camera 1's own sound off
  const r2 = FH.call(host, 'CP_applyMulticamPlan', { plan: PLAN4B, numAngles: 2, dropFrame: false });
  const a1on = w.model.audio[0].clips.filter(c => !c.disabled).reduce((s, c) => s + c.end - c.start, 0);
  const a2off = w.model.audio[1].clips.filter(c => c.disabled).reduce((s, c) => s + c.end - c.start, 0);
  const lavOff = w.model.audio[2].clips.some(c => c.disabled);
  report(r1.ok && r2.ok && a1on === 0 && a2off === 0 && !lavOff && r2.audioKeptOff > 0 && r2.verifiedPct === 100 && wrongSeconds(w, PLAN4B, 25) === 0,
    'second Apply: camera 1\'s sound the owner switched off stays off (on for ' + a1on.toFixed(1) + ' s, need 0; kept off ' + r2.audioKeptOff +
    '), camera 2\'s sound and the lav stay on, every shot as planned (verified ' + r2.verifiedPct + '%)');
}

// ---- if Premiere links sound and picture BOTH ways --------------------------------
// Switching a sound back off then takes its camera piece along (the plan's
// picture wins: the piece goes back on, linkedOn), and switching a sound back
// on brings a switched-off camera piece with it (the sound wins: pictureOn, and
// the shot check reports the plan as only partly applied — never "applied").
{
  const { w, host } = world({
    linkedAudio: true, linkedBothWays: true,
    video: [{ name: 'V1', clips: [{ start: 0, end: 30, name: 'cam1' }, { start: 30, end: 60, name: 'cam1' }] },
            { name: 'V2', clips: [{ start: 0, end: 30, name: 'cam2' }, { start: 30, end: 60, name: 'cam2' }] }],
    audio: [
      { name: 'A1', clips: [{ start: 0, end: 30, inPoint: 0, outPoint: 30, mediaPath: '/media/cam1.mov', name: 'cam1 audio', disabled: true },
                            { start: 30, end: 60, inPoint: 30, outPoint: 60, mediaPath: '/media/cam1.mov', name: 'cam1 audio', disabled: true }] },
      { name: 'A2', clips: [{ start: 0, end: 30, inPoint: 0, outPoint: 30, mediaPath: '/media/cam2.mov', name: 'cam2 audio' },
                            { start: 30, end: 60, inPoint: 30, outPoint: 60, mediaPath: '/media/cam2.mov', name: 'cam2 audio' }] }
    ]
  });
  // as a first Apply left it: camera 2 on screen, then camera 1 — set without the links' side effects
  w.model.video[0].clips[0].disabled = true; w.model.video[1].clips[1].disabled = true;
  const r = FH.call(host, 'CP_applyMulticamPlan', { plan: [{ start: 0, end: 30, angle: 0 }, { start: 30, end: 60, angle: 1 }], numAngles: 2, dropFrame: false });
  const a2off = w.model.audio[1].clips.filter(c => c.disabled).reduce((s, c) => s + c.end - c.start, 0);
  report(r.ok && r.audioLinkedOn === 1 && r.audioPictureOn === 1 && a2off === 0 && r.verifiedPct < 99,
    'sound and picture linked both ways: the owner\'s switched-off sound that would take its camera with it stays on (linkedOn ' + r.audioLinkedOn +
    '), sound switched back on that brought a camera with it is counted (pictureOn ' + r.audioPictureOn + '), camera 2\'s sound is never off (' +
    a2off.toFixed(1) + ' s) and the plan reads as partly applied (verified ' + r.verifiedPct + '%)');
}

(async () => {
  // ---- the panel says what happened ---------------------------------------------------
  await P.withBrowser(async (browser) => {
    const sim = S.podcast({ dur: 60, pattern: 'balanced', seed: 2, minTurn: 6, maxTurn: 12 });
    const env = {}, audio = [];
    sim.grids.forEach((g, m) => {
      env['/media/mic' + (m + 1) + '.wav'] = g.slice();
      audio.push({ name: 'A' + (m + 1), clips: [{ start: 0, end: 60, inPoint: 0, outPoint: 60, mediaPath: '/media/mic' + (m + 1) + '.wav', name: 'mic' + (m + 1) }] });
    });
    for (const mode of ['throws', 'flaky', 'late']) {
      const video = mode === 'late' ? [{ name: 'V1', clips: [{ start: 10, end: 60, name: 'cam1' }] }, { name: 'V2', clips: [{ start: 0, end: 60, name: 'cam2' }] }] : FH.cameras(2, 60);
      const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: 60, video, audio, razor: mode === 'throws' ? 'throws' : 'ok' }, envelopes: env });
      if (mode === 'flaky') {
        let calls = 0;
        const q = ctx.world.sandbox.qe.project.getActiveSequence;
        ctx.world.sandbox.qe.project.getActiveSequence = () => {
          const s = q(); const get = s.getVideoTrackAt.bind(s);
          s.getVideoTrackAt = (i) => { const tr = get(i); const raz = tr.razor.bind(tr); tr.razor = (tc) => { if (++calls % 2 === 0) throw new Error('razor failed'); return raz(tc); }; return tr; };
          return s;
        };
      }
      const r = await P.runMulticam(ctx, { cameras: 2, source: 'follow' });
      await ctx.page.close();
      const last = r.toasts[r.toasts.length - 1] || '';
      const isErr = /\berr\b/.test(last.split('|')[0]);
      const msg = last.split('|').slice(1).join('|');
      const want = mode === 'throws' ? /nothing was switched/i : (mode === 'flaky' ? /only partly/i : /V1 has no video at 0:00/);
      const what = mode === 'throws' ? 'razor refused' : (mode === 'flaky' ? 'razor failing half the time' : 'host camera (V1) starts at 0:10 while the host speaks first');
      report(isErr && want.test(msg) && !/^🎬 Multicam applied — \d+ cuts, \d+ angle toggles/.test(msg),
        'panel, ' + what + ': the owner sees ' + JSON.stringify(msg.slice(0, 110)) + (isErr ? ' (as an error)' : ' (as success)'));
    }
    // ---- applied only partly: the advice works — tapping Apply again finishes it -----------
    // (one ⌘Z in Premiere undoes one of hundreds of scripted steps, and more
    // presses walk back into the owner's earlier edits — Apply is safe to repeat)
    {
      const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: 60, video: FH.cameras(2, 60), audio }, envelopes: env });
      let calls = 0, flaky = true;
      const q = ctx.world.sandbox.qe.project.getActiveSequence;
      ctx.world.sandbox.qe.project.getActiveSequence = () => {
        const s = q(); const get = s.getVideoTrackAt.bind(s);
        s.getVideoTrackAt = (i) => { const tr = get(i); const raz = tr.razor.bind(tr); tr.razor = (tc) => { if (flaky && ++calls % 2 === 0) throw new Error('razor failed'); return raz(tc); }; return tr; };
        return s;
      };
      const r = await P.runMulticam(ctx, { cameras: 2, source: 'follow' });
      const advice = r.diag || '';
      flaky = false;
      const again = await ctx.page.evaluate(async () => {
        const n = document.getElementById('log').children.length;
        document.getElementById('btn-mc-apply').click();
        for (let i = 0; i < 200 && document.getElementById('log').children.length === n; i++) await new Promise(res => setTimeout(res, 50));
        await new Promise(res => setTimeout(res, 200));
        const box = document.getElementById('mc-diag');
        const last = document.getElementById('log').lastElementChild;
        return { toast: last ? last.textContent : '', box: box.classList.contains('hidden') ? null : box.textContent };
      });
      await ctx.page.close();
      const res2 = ctx.calls.filter(c => c.fn === 'CP_applyMulticamPlan').pop().result || {};
      const plan = ctx.calls.filter(c => c.fn === 'CP_applyMulticamPlan').pop().args.plan;
      report(/Tap Apply again/.test(advice) && !/⌘Z|Undo/.test(advice),
        'panel, applied only partly: the advice is to tap Apply again, not ⌘Z — ' + JSON.stringify(advice.split('\n').slice(-1)[0].slice(0, 90)));
      report(res2.missedCuts === 0 && res2.verifiedPct === 100 && wrongSeconds(ctx.world, plan, 25) === 0 && /Multicam applied/.test(again.toast) && !/only partly/.test(again.box || ''),
        'panel, tapping Apply again finishes it: missed cuts ' + res2.missedCuts + ', verified ' + res2.verifiedPct + '%, wrong camera ' +
        wrongSeconds(ctx.world, plan, 25) + ' s, the owner sees ' + JSON.stringify(again.toast.slice(0, 60)) + (again.box ? ' and the box still says ' + JSON.stringify(again.box.slice(0, 50)) : ''));
    }

    // ---- 🔁 Redo: says so when there is nothing to change, re-cuts when there is ----------
    // ("the redo button is not working": with the same settings it rebuilt the
    // same edit and said "Multicam applied — 0 cuts, 0 angle toggles"; and
    // Calm vs Balanced made the same edit, so switching pace changed nothing)
    {
      const isim = S.podcast({ dur: 120, pattern: 'interview', share: 0.85, seed: 5 });
      const ienv = {}, iaudio = [];
      isim.grids.forEach((g, m) => {
        ienv['/media/mic' + (m + 1) + '.wav'] = g.slice();
        iaudio.push({ name: 'A' + (m + 1), clips: [{ start: 0, end: 120, inPoint: 0, outPoint: 120, mediaPath: '/media/mic' + (m + 1) + '.wav', name: 'mic' + (m + 1) }] });
      });
      const ctx = await P.openPanel(browser, { premiere: { fps: 25, end: 120, video: FH.cameras(2, 120), audio: iaudio }, envelopes: ienv });
      await P.runMulticam(ctx, { cameras: 2, source: 'follow' });
      const redo = (pace) => ctx.page.evaluate(async (pace) => {
        if (pace) { const b = document.querySelector('#mc-pace button[data-pace="' + pace + '"]'); if (b) b.click(); }
        const n = document.getElementById('log').children.length;
        document.getElementById('btn-mc-redo').click();
        for (let i = 0; i < 300; i++) {
          await new Promise(res => setTimeout(res, 50));
          const last = document.getElementById('log').lastElementChild;
          if (document.getElementById('log').children.length > n && last && /Multicam|already has this edit|failed/i.test(last.textContent)) break;
        }
        await new Promise(res => setTimeout(res, 200));
        const last = document.getElementById('log').lastElementChild;
        return last ? last.textContent : '';
      }, pace);
      const same = await redo(null);
      const sameRes = ctx.calls.filter(c => c.fn === 'CP_applyMulticamPlan').pop().result || {};
      report(sameRes.razored === 0 && sameRes.toggled === 0 && /already has this edit/.test(same) && !/0 cuts/.test(same),
        'panel, 🔁 Redo with the same settings: says the timeline already has this edit (not "applied — 0 cuts") — ' + JSON.stringify(same.slice(0, 70)));
      const snappy = await redo('high');
      const sn = ctx.calls.filter(c => c.fn === 'CP_applyMulticamPlan').pop();
      const snRes = sn.result || {};
      report(snRes.razored > 0 && snRes.verifiedPct === 100 && wrongSeconds(ctx.world, sn.args.plan, 25) === 0 && /Multicam applied — \d+ cuts/.test(snappy),
        'panel, ⚡ Snappy then 🔁 Redo: re-cuts the timeline with the new edit (' + snRes.razored + ' new cuts, verified ' + snRes.verifiedPct + '%) — ' +
        JSON.stringify(snappy.slice(0, 60)));
      await ctx.page.close();
    }
  });
  if (failed) { console.log('MULTICAM APPLY: ' + failed + ' check(s) failed'); process.exit(1); }
  console.log('MULTICAM APPLY: failures are reported, nothing half-done reads as success, drop-frame lands on the frame ✓');
})().catch((e) => { console.error(e); process.exit(1); });
