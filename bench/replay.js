// replay.js — Pulse's one-tap Clean up (Balanced), step for step as the panel runs it,
// on a raw recording, scored against the owner's hand edit.
//   node replay.js [DATA=data] [WORDS=words_local_hi.json] [SCRIPT=real_script.txt|none]
//   SHOW=1   list the script's cuts · CLIP=1   list cut edges inside words
// DATA holds orig.raw (16 kHz mono s16le), acc3.json (fill.py) and the words / script.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'CutPilot', 'js');
const S = require(process.env.SIL || path.join(ROOT, 'silence.js'));
const T = require(path.join(ROOT, 'takes.js'));
const SA = require(path.join(ROOT, 'scriptalign.js'));
const D = path.join(__dirname, process.env.DATA || 'data') + '/';

// the panel's own final step, read from main.js so the replay can't drift from it
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const snapRangesToWords = new Function(MAIN.match(/  function snapRangesToWords\(ranges, words, win\) \{[\s\S]*?\n  \}\n/)[0] + '; return snapRangesToWords;')();

const b = S.makeEnvelopeBuilder(16000); b.pushBytes(fs.readFileSync(D + 'orig.raw')); const env = b.finish();
const tune = S.tuning('balanced');
const L = S.micLevels(env.db, [[0, env.db.length]], tune);
const dur = env.db.length * env.hop;
const grid = S.combineMics([{ seqStart: 0, seqEnd: dur, inPoint: 0, speed: 1, env: env, flags: S.loudFlags(env.db, L.threshold), strongDb: L.speech - 20 }], { start: 0, end: dur });
const bar = L.speech + 3;                                         // voiceBar(plan)
const W = JSON.parse(fs.readFileSync(D + (process.env.WORDS || 'words_local_hi.json'))).words.map(w => ({ start: w.start, end: w.end, text: w.word }));
const SCRTXT = process.env.SCRIPT === 'none' ? '' : fs.readFileSync(D + (process.env.SCRIPT || 'real_script.txt'), 'utf8');
const SCR = SA.scriptWords(SCRTXT);
const human = JSON.parse(fs.readFileSync(D + (process.env.HUMAN || 'acc3.json')));

function cleanUp(useScript) {
  const heard = S.audibleWords(W, grid, { bar });                  // heardWords(words, plan)
  // takesOn: retake finder + the script's cuts, sure ones only (word-level timing)
  const tk = T.findRepeatedTakes(heard, { minRun: 3, sim: 0.6, keep: 'best' }).deletes;
  let sc = [];
  if (useScript && SCR.length >= 20) { const r = T.scriptTakes(heard, SCR); if (r.rate >= 0.35) sc = r.deletes; }
  // script mode: one take per script line
  const atr = (useScript && process.env.ATTEMPTS && SCR.length >= 20) ? T.scriptAttempts(heard, grid, L.speech, SCRTXT, process.env.ATT_PAUSE ? { pause: +process.env.ATT_PAUSE } : {}) : { deletes: [], keeps: [] };
  if (useScript && process.env.SCRIPTMODE && SCR.length >= 20) { const kd = T.scriptKeep(heard, SCRTXT).deletes; sc = sc.concat(process.env.NOSPARE ? kd : T.sparingKeeps(kd, atr.keeps)); }
  sc = sc.concat(atr.deletes);
  let other = tk.concat(sc).filter(d => !d.needsReview && !d.estimated);
  // the last word on any take cut: no script line is lost

  // silences: the plan, wordless noise, the word guard, then quiet stretches
  const sil = S.protectCutsFromWords(S.planCuts(grid, tune).concat(S.wordlessNoise(heard, grid, bar, tune)), heard, { minCut: tune.minCut })
    .concat(S.quietStretches(grid, bar));
  // the last word on EVERY cut (silences and quiet stretches too): no script line is lost
  let all = sil.concat(other);
  if (useScript && SCR.length >= 20 && !process.env.NOGUARD) { if (process.env.GLINE2) T.keepEveryLine.debug = []; all = T.keepEveryLine(heard, SCRTXT, all); if (process.env.GLINE2) T.keepEveryLine.debug.forEach(d => console.log('guard2', JSON.stringify(d).slice(0, 220))); if (process.env.SHOW) (all.restored || []).forEach(l => console.log('   restored: ' + l.slice(0, 70))); }
  const cuts = S.mergeRanges(snapRangesToWords(all, heard).sort((a, c) => a.start - c.start), 0);
  return { cuts, sc, heard };
}

const n = Math.ceil(dur * 10);
const mask = (ranges, keep) => { const m = new Uint8Array(n).fill(keep ? 0 : 1); for (const r of ranges) for (let i = Math.floor(r.start * 10); i < Math.min(n, Math.ceil(r.end * 10)); i++) m[i] = keep ? 1 : 0; return m; };
const H = mask(human.map(r => ({ start: r.o0, end: r.o1 })), true);
const reg = (cond) => { const out = []; let i = 0; while (i < n) { if (cond(i)) { let j = i; while (j < n && cond(j)) j++; if (j - i >= 4) out.push([i / 10, j / 10]); i = j; } else i++; } return out; };
const said = (a, c) => W.filter(w => (w.start + w.end) / 2 >= a && (w.start + w.end) / 2 < c).map(w => w.text).join(' ');

function report(label, res) {
  const P = mask(res.cuts, false);
  let kept = 0, onlyP = 0, onlyH = 0;
  for (let i = 0; i < n; i++) { kept += P[i]; if (P[i] && !H[i]) onlyP++; else if (!P[i] && H[i]) onlyH++; }
  // a cut edge inside a heard word (more than 40 ms in from either end) chops that word
  const clips = [];
  for (const c of res.cuts) for (const t of [c.start, c.end]) {
    const w = res.heard.find(x => x.text && t > x.start + 0.04 && t < x.end - 0.04);
    // …only where the voice is actually sounding at the edge (a word stretched over silence is no clip)
    let loud = false; for (let g = Math.floor((t - 0.03) / grid.hop); g <= Math.ceil((t + 0.03) / grid.hop); g++) if (grid.peak[g] >= L.speech - 6) loud = true;
    if (w && loud) clips.push(t.toFixed(2) + ' in "' + w.text + '" ' + w.start.toFixed(2) + '-' + w.end.toFixed(2));
  }
  // speech only: tenths where the voice is actually sounding (within 0.2 s), so silences — ambiguous
  // in any map of an edit — count neither way
  let sP = 0, sH = 0;
  for (let i = 0; i < n; i++) {
    if (P[i] === H[i]) continue;
    let v = false; for (let g = Math.max(0, Math.floor((i / 10 - 0.2) / grid.hop)); g < Math.min(grid.peak.length, Math.ceil((i / 10 + 0.3) / grid.hop)) && !v; g++) if (grid.peak[g] >= L.speech - 6) v = true;
    if (v) { if (P[i]) sP++; else sH++; }
  }
  res.speech = [sP / 10, sH / 10];
  console.log(`${label}: speech only — kept that you cut ${(sP / 10).toFixed(1)}s, cut that you kept ${(sH / 10).toFixed(1)}s`);
  console.log(`${label}: keeps ${(kept / 10).toFixed(1)}s (you ${(H.reduce((a, c) => a + c, 0) / 10).toFixed(1)}s) — kept that you cut ${(onlyP / 10).toFixed(1)}s, cut that you kept ${(onlyH / 10).toFixed(1)}s, ${res.cuts.length} cuts, ${clips.length} edges inside a word`);
  if (process.env.CLIP) clips.forEach(c => console.log('   ✂~ ' + c));
  return P;
}
console.log(`levels: floor ${L.floor.toFixed(1)} dB, speech ${L.speech.toFixed(1)} dB, gate ${L.threshold.toFixed(1)} dB; ${W.length} words, script ${SCR.length} words`);
report('no script ', cleanUp(false));
const res = cleanUp(true);
if (process.env.SHOW) res.sc.forEach(d => console.log('   ✂ ' + d.start.toFixed(1) + '-' + d.end.toFixed(1) + ' ' + d.reason + ': ' + d.text.slice(0, 70)));
const P = report('with script', res);
// lines of the script present in your edit but missing from Pulse's — real content lost
if (SCRTXT) {
  const sents = SCRTXT.split(/\n|(?<=[.?!।:])\s+/).map(x => x.trim()).filter(x => x.split(/\s+/).length >= 3);
  const present = (mask) => { const ws = res.heard.filter(w => w.text && mask[Math.floor((w.start + w.end) / 2 * 10)]).map(w => T._norm(w.text));
    return sents.map(st => { const q = st.split(/\s+/).map(T._norm).filter(Boolean); let hit = 0; for (const t of q) if (ws.some(w => T._wordSc(t, w) >= 0.6)) hit++; return hit / q.length >= 0.6; }); };
  // strict: a COMPLETE take of the line (70% of its words, in order, real matches) inside the kept audio
  const presentStrict = (mask) => { const ws = res.heard.filter(w => w.text && mask[Math.floor((w.start + w.end) / 2 * 10)]).map(w => T._norm(w.text));
    return sents.map(st => { const q = st.split(/\s+/).map(T._norm).filter(Boolean); const A = q.length, B = ws.length;
      let prev = new Int16Array(B + 1), best = 0;
      for (let i = 1; i <= A; i++) { const cur = new Int16Array(B + 1); for (let j = 1; j <= B; j++) { cur[j] = Math.max(prev[j], cur[j - 1], prev[j - 1] + (T._wordSc(q[i - 1], ws[j - 1]) >= 0.6 ? 1 : 0)); } prev = cur; }
      // in order but within a window: walk windows of 2× the line
      let ok = false; const win = A * 2 + 4;
      for (let s0 = 0; s0 < B && !ok; s0 += Math.max(1, A)) { let pv = new Int16Array(win + 1); for (let i = 1; i <= A; i++) { const cu = new Int16Array(win + 1); for (let j = 1; j <= win && s0 + j - 1 < B; j++) cu[j] = Math.max(pv[j], cu[j - 1], pv[j - 1] + (T._wordSc(q[i - 1], ws[s0 + j - 1]) >= 0.6 ? 1 : 0)); pv = cu; } if (Math.max.apply(null, pv) >= 0.7 * A) ok = true; }
      return ok; }); };
  const sYou = presentStrict(H), sPulse = presentStrict(P);
  const sLost = sents.filter((st, i) => sYou[i] && !sPulse[i]);
  console.log(`complete lines: yours ${sYou.filter(Boolean).length}/${sents.length}, Pulse ${sPulse.filter(Boolean).length}; LOST complete: ${sLost.length}`);
  sLost.forEach(l => console.log('   LOST complete: ' + l.slice(0, 90)));
  const inYou = present(H), inPulse = present(P);
  const lost = sents.filter((st, i) => inYou[i] && !inPulse[i]), extra = sents.filter((st, i) => !inYou[i] && inPulse[i]);
  console.log(`script lines: in your edit ${inYou.filter(Boolean).length}/${sents.length}, in Pulse's ${inPulse.filter(Boolean).length}; LOST by Pulse: ${lost.length}`);
  lost.forEach(l => console.log('   lost: ' + l.slice(0, 90)));
}
console.log('still kept, you cut:'); for (const [a, c] of reg(i => P[i] && !H[i])) console.log(`   ${a.toFixed(1)}-${c.toFixed(1)} (${(c - a).toFixed(1)}s) ${said(a, c).slice(0, 80)}`);
console.log('cut, you kept:'); for (const [a, c] of reg(i => !P[i] && H[i])) console.log(`   ${a.toFixed(1)}-${c.toFixed(1)} (${(c - a).toFixed(1)}s) ${said(a, c).slice(0, 80)}`);
if (process.env.WHO) { const t = +process.env.WHO, heard = S.audibleWords(W, grid, { bar });
  const plan = S.planCuts(grid, tune), wn = S.wordlessNoise(heard, grid, bar, tune), q = S.quietStretches(grid, bar);
  const prot = S.protectCutsFromWords(plan.concat(wn), heard, { minCut: tune.minCut });
  const show = (name, arr) => arr.filter(c => c.start < t + 1 && c.end > t - 1).forEach(c => console.log(name, c.start.toFixed(2), c.end.toFixed(2)));
  show('plan     ', plan); show('wordless ', wn); show('protected', prot); show('quiet    ', q);
  heard.filter(w => w.start < t + 1 && w.end > t - 1).forEach(w => console.log('word', w.start.toFixed(2), w.end.toFixed(2), JSON.stringify(w.text)));
  for (let x = t - 0.6; x < t + 0.6; x += 0.05) { let m = -99; for (let g = Math.floor(x / grid.hop); g < Math.floor((x + 0.05) / grid.hop); g++) m = Math.max(m, grid.peak[g]); process.stdout.write(x.toFixed(2) + ':' + m.toFixed(0) + ' '); } console.log(); }
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify(res.cuts.map(c => [+c.start.toFixed(2), +c.end.toFixed(2)])));
if (process.env.SNAP) { const [a, c] = process.env.SNAP.split(',').map(Number); const heard = S.audibleWords(W, grid, { bar });
  console.log('snap', a, c, '→', JSON.stringify(snapRangesToWords([{ start: a, end: c }], heard)));
  heard.filter(w => w.end > a - 0.5 && w.start < c + 0.5).forEach(w => console.log('  word', w.start.toFixed(2), w.end.toFixed(2), JSON.stringify(w.text), w.part ? 'part' : '')); }
if (process.env.ALIGN) { const [a, c] = process.env.ALIGN.split(',').map(Number); const heard = S.audibleWords(W, grid, { bar }); const r = T.scriptTakes(heard, SCR, { debug: true });
  heard.forEach((w, i) => { if (w.start >= a && w.start <= c) console.log('al', w.start.toFixed(2), w.end.toFixed(2), r.at[i] >= 0 ? '= ' + SCR[r.at[i]] : r.at[i] === -2 ? '~' : '-', JSON.stringify(w.text)); }); }
if (process.env.GDEBUG) { const heard = S.audibleWords(W, grid, { bar }); const [a, c] = process.env.GDEBUG.split(',').map(Number);
  const tk = T.findRepeatedTakes(heard, { minRun: 3, sim: 0.6, keep: 'best' }).deletes;
  const atr = T.scriptAttempts(heard, grid, L.speech, SCRTXT);
  let sc = T.scriptTakes(heard, SCR).deletes.concat(T.sparingKeeps(T.scriptKeep(heard, SCRTXT).deletes, atr.keeps), atr.deletes);
  const other = tk.concat(sc).filter(d => !d.needsReview && !d.estimated);
  const show = (nm, arr) => arr.filter(d => d.end > a && d.start < c).forEach(d => console.log(nm, d.start.toFixed(1), d.end.toFixed(1), d.reason || ''));
  show('before', other); const g = T.keepEveryLine(heard, SCRTXT, other); show('after ', g); console.log('restored:', g.restored); }
if (process.env.GLINE) { T.keepEveryLine.debug = []; const heard = S.audibleWords(W, grid, { bar }); const atr = T.scriptAttempts(heard, grid, L.speech, SCRTXT);
  const other = T.findRepeatedTakes(heard, { minRun: 3, sim: 0.6, keep: 'best' }).deletes.concat(T.scriptTakes(heard, SCR).deletes, T.sparingKeeps(T.scriptKeep(heard, SCRTXT).deletes, atr.keeps), atr.deletes).filter(d => !d.needsReview && !d.estimated);
  T.keepEveryLine(heard, SCRTXT, other); T.keepEveryLine.debug.forEach(d => console.log('guard', JSON.stringify(d).slice(0, 220)));
  if (process.env.AROUND) console.log('heard around:', heard.filter(w => w.start > 88 && w.start < 96).map(w => (w.text || '·') + '@' + w.start.toFixed(1) + '-' + w.end.toFixed(1)).join(' ')); }
