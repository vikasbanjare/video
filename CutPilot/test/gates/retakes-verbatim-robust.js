/*
 * retakes-verbatim-robust.js — one bad file on the timeline no longer sinks
 * "Find retakes (Verbatim AI)", and music is not fed to the verbatim engine.
 *
 * The verbatim path mixes every unmuted audio track of the timeline, each
 * file at its own recorded level (Premiere's volume settings are not known
 * to the panel). Two things went wrong in real use:
 *   - one moved/renamed (offline) file on ANY track made ffmpeg fail, and
 *     the whole run stopped with raw ffmpeg text: "Could not read the
 *     timeline audio: … Error opening input files: No such file or directory";
 *   - a music bed on its own track went to Deepgram at full level, on top of
 *     the voices, and filled the pauses the cuts snap to.
 *
 * Checked with REAL ffmpeg and the REAL panel (fake Premiere, fake Deepgram
 * that "hears" tone bursts):
 *   1. (Node) timelineMixPlan leaves out the files it is told to;
 *   2. a voice on A1, an offline sound effect on A2 and a music bed on A3:
 *      the run succeeds, Deepgram hears the voice and NOT the music, every
 *      word lands at its timeline time, and the list names the offline file
 *      and the music track that were left out;
 *   3. when the mix fails anyway, the selected clip is read instead, and the
 *      owner is told only that clip was read;
 *   4. with nothing to fall back to, the message is plain: no "exit 254",
 *      no ffmpeg wording;
 *   5. the takes card says to mute a music track first (the music test is a
 *      heuristic — real music with loud and quiet parts may pass as a voice).
 *
 * Exit 0 = pass, 1 = fail, 2 = skipped (no ffmpeg / puppeteer / Chromium).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const H = require('./retakes-lib/harness');
const V = require(path.join(H.PANEL_DIR, 'js', 'verbatim.js'));

const FF = H.ffmpegBin();
if (!FF) H.skip('no ffmpeg');
const C = H.checker();
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-vbrobust-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {} });

/* A voice: 300 Hz "words" at the given media times over a quiet room
   (a -50 dB hiss, as a real mic has). */
function voiceFile(name, bursts, dur) {
  const f = path.join(DIR, name);
  const expr = bursts.map(b => `between(t,${b[0]},${b[1]})`).join('+');
  cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    `aevalsrc='0.5*sin(2*PI*300*t)*(${expr})+0.003*(2*random(0)-1)':s=48000:d=${dur}`, '-ac', '1', f]);
  return f;
}
/* A music bed: a steady 1500 Hz tone, as loud as the voice, all the way. */
function musicFile(name, dur) {
  const f = path.join(DIR, name);
  cp.execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    `aevalsrc='0.4*sin(2*PI*1500*t)+0.003*(2*random(0)-1)':s=48000:d=${dur}`, '-ac', '1', f]);
  return f;
}
/* Loud stretches of an audio file, by pitch: [{start,end,who}] (file time). */
function hear(file) {
  const pcm = cp.execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 28 });
  const n = pcm.length / 2, hop = 160, out = [];
  let on = false, st = 0, zc = 0, cnt = 0, prev = 0;
  const who = (hz) => hz < 500 ? 'voice' : hz > 1000 ? 'music' : 'other';
  for (let i = 0; i + hop <= n; i += hop) {
    let s = 0, z = 0;
    for (let j = 0; j < hop; j++) {
      const v = pcm.readInt16LE((i + j) * 2) / 32768; s += v * v;
      if ((v >= 0) !== (prev >= 0)) z++; prev = v;
    }
    const loud = Math.sqrt(s / hop) > 0.04;
    if (loud && !on) { on = true; st = i / 16000; zc = 0; cnt = 0; }
    if (loud) { zc += z; cnt += hop; }
    if (!loud && on) { on = false; out.push({ start: +st.toFixed(3), end: +(i / 16000).toFixed(3), who: who(zc / 2 / (cnt / 16000)) }); }
  }
  if (on) out.push({ start: +st.toFixed(3), end: +(n / 16000).toFixed(3), who: who(zc / 2 / (cnt / 16000)) });
  return out;
}
const fmtB = (l) => l.map(b => b.who[0] + '@' + b.start.toFixed(2) + '–' + b.end.toFixed(2)).join(' ');

const VOICE = voiceFile('voice.wav', [[1, 1.4], [3, 3.4], [5, 5.4], [7, 7.4]], 10);
const MUSIC = musicFile('bed.wav', 10);
const OFFLINE = path.join(DIR, 'moved-away', 'whoosh.wav');     // Premiere still points here; the file is gone
const SRC = {
  sequenceId: 'seq-r', sequenceName: 'Reel 3', fingerprint: 'fp-r', fps: 25, selection: null, video: [],
  audio: [
    { index: 0, name: 'Voice', muted: false, items: [{ mediaPath: VOICE, seqStart: 10, seqEnd: 20, inPoint: 0, outPoint: 10, speed: 1 }] },
    { index: 1, name: 'SFX', muted: false, items: [{ mediaPath: OFFLINE, seqStart: 12, seqEnd: 13, inPoint: 0, outPoint: 1, speed: 1 }] },
    { index: 2, name: 'Music', muted: false, items: [{ mediaPath: MUSIC, seqStart: 10, seqEnd: 20, inPoint: 0, outPoint: 10, speed: 1 }] }
  ]
};
const WANT = [11, 13, 15, 17];   // where the voice's words sit on the timeline

async function main() {
  console.log('verbatim retakes: offline files and music beds');

  // 1 ─ pure
  const p0 = V.timelineMixPlan(SRC, { leaveOut: { [OFFLINE]: 1, [MUSIC]: 1 } });
  C.check('timelineMixPlan leaves out the files it is told to (offline sound effect, music bed)',
    !!p0 && p0.inputs.length === 1 && p0.inputs[0].path === VOICE && p0.tracks.length === 1, JSON.stringify(p0 && p0.inputs));

  // 2, 3, 4 ─ the real panel
  const sent = [];
  const curl = (args) => {
    const url = args.find(a => /^https:\/\//.test(a)) || '';
    if (!/api\.deepgram\.com/.test(url)) return '{}';
    const f = args[args.indexOf('--data-binary') + 1].replace(/^@/, '');
    const b = hear(f);
    sent.push(b);
    const ws = b.filter(x => x.who === 'voice').map(x => ({ word: 'take', punctuated_word: 'take', start: x.start, end: x.end, confidence: 0.99, speaker: 0 }));
    return JSON.stringify({ results: { channels: [{ alternatives: [{ words: ws.length ? ws : [{ word: 'hmm', punctuated_word: 'hmm', start: 0, end: 0.2, confidence: 0.5 }] }] }] } });
  };
  const hostFor = (src, selected) => (fn) => {
    if (fn === 'CP_getCutSources') return src;
    if (fn === 'CP_getSelectedClip') {
      if (!selected) throw new Error('No clip selected. Select the clip to analyze in the timeline.');
      return { clip: selected };
    }
    if (fn === 'CP_getTranscribeSource') { if (!selected) throw new Error('nothing'); return { clip: selected }; }
    return {};
  };
  const settings = { verbatimKey: 'dg-test-key', verbatimProvider: 'deepgram', ffmpegPath: FF, whisperLang: 'auto' };
  async function run(page) {
    await page.evaluate(() => {
      document.getElementById('toast').textContent = '';
      document.getElementById('takes-results').classList.add('hidden');
      document.getElementById('btn-verbatim-retakes').click();
    });
    await H.waitFor(page, () => document.getElementById('takes-progress').classList.contains('hidden') &&
      (!document.getElementById('takes-results').classList.contains('hidden') || /failed/.test(document.getElementById('toast').textContent)), 60000);
    return page.evaluate(() => ({ toast: document.getElementById('toast').textContent, stats: document.getElementById('takes-stats').textContent,
      shown: !document.getElementById('takes-results').classList.contains('hidden'),
      words: (window.CP_DEBUG_EXT.retakes.transcriptWords() || []).map(w => +w.start.toFixed(2)) }));
  }
  /* make every ffmpeg MIX fail (a file ffmpeg cannot read part-way, say) — the
     one-clip read that follows is left alone */
  async function breakTheMix(page) {
    await page.evaluate(() => {
      const req = window.require;
      window.require = function (m) {
        const mod = req(m);
        if (m !== 'child_process') return mod;
        return Object.assign({}, mod, { spawn(bin, args) {
          if (/ffmpeg/.test(bin) && (args || []).some(a => /filter_complex/.test(a))) args = ['-hide_banner', '-f', 'lavfi', '-i', 'nosuchsource=x=1', '-f', 'null', '-'];
          return mod.spawn(bin, args);
        } });
      };
    });
  }
  const browser = await H.launch();
  try {
    // 2 ─ offline file + music bed
    const a = await H.openPanel(browser, { host: hostFor(SRC, null), curl, settings, ffmpeg: FF });
    const r = await run(a.page);
    const heard = sent[0] || [];
    C.check('an offline file on another track no longer fails the run', r.shown && !/failed/.test(r.toast), r.toast);
    C.check('…Deepgram hears the voice, and not the music bed', heard.filter(b => b.who === 'voice').length === 4 && !heard.some(b => b.who === 'music'), fmtB(heard));
    C.check('…every word lands at its timeline time (±40 ms)', r.words.length === 4 && r.words.every((t, i) => Math.abs(t - WANT[i]) <= 0.04), JSON.stringify(r.words));
    C.check('…the list says the offline file was left out, by name and track', /whoosh\.wav/.test(r.stats) && /offline/i.test(r.stats) && /A2/.test(r.stats), r.stats);
    C.check('…and that the music track was left out', /bed\.wav/.test(r.stats) && /music/i.test(r.stats) && /A3/.test(r.stats), r.stats);
    C.check('…in words the owner can act on (no ffmpeg / exit codes)', !/ffmpeg|exit \d|stderr|Error opening/i.test(r.stats + ' ' + r.toast), r.stats + ' | ' + r.toast);
    // the music test is a heuristic (steady sound): real music with loud and
    // quiet parts may pass as a voice, so the card also says to mute it
    const hint = await a.page.evaluate(() => { const b = document.getElementById('btn-verbatim-retakes'); const p = b && b.previousElementSibling; return p ? p.textContent.replace(/\s+/g, ' ') : ''; });
    C.check('the takes card tells the owner to mute a music track before Verbatim retakes', /mute your music track/i.test(hint), hint);
    await a.page.close();

    // 3 ─ the mix fails anyway: read the selected clip instead
    sent.length = 0;
    const clip = { name: 'voice', mediaPath: VOICE, seqStart: 10, seqEnd: 20, inPoint: 0, outPoint: 10, nodeId: 'n1' };
    const b = await H.openPanel(browser, { host: hostFor(SRC, clip), curl, settings, ffmpeg: FF });
    await breakTheMix(b.page);
    const r3 = await run(b.page);
    C.check('the mix failing: the selected clip is read instead, and the words still land at timeline time',
      r3.shown && !/failed/.test(r3.toast) && r3.words.length === 4 && r3.words.every((t, i) => Math.abs(t - WANT[i]) <= 0.04), JSON.stringify(r3));
    C.check('…and the owner is told only the selected clip was read', /only the selected clip/i.test(r3.stats), r3.stats);
    await b.page.close();

    // 4 ─ the mix fails and there is no clip to fall back to
    const c = await H.openPanel(browser, { host: hostFor(SRC, null), curl, settings, ffmpeg: FF });
    await breakTheMix(c.page);
    const r4 = await run(c.page);
    C.check('nothing to fall back to: a plain message (no "exit 254", no ffmpeg wording)',
      /Verbatim retakes failed/.test(r4.toast) && /select/i.test(r4.toast) && !/ffmpeg|exit \d|stderr|Error opening|filter/i.test(r4.toast), r4.toast);
    await c.page.close();
  } finally {
    await browser.close();
  }
  C.finish();
}
main().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
