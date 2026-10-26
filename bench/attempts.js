// attempts.js — prototype: script mode by ATTEMPT, not by word.
// A take-by-take recording (Ashish) is speech blocks separated by pauses; an editor keeps
// or drops whole attempts. Each attempt is placed in the script by local alignment
// (sound skeletons); an attempt another one re-says (80% of its script words) is cut —
// the later one wins, unless the later is clearly less complete. Attempts that say no
// script line are chatter, cut unless they look like a line no kept attempt has.
const T = require('../CutPilot/js/takes.js');

function attemptKeep(words, grid, speechDb, scriptText, opts) {
  opts = opts || {};
  const PAUSE = opts.pause || 1.0, quietDb = speechDb - 12;
  // 1. attempts: speech between pauses of PAUSE+ (0.1 s blocks under speech − 12 dB)
  const step = Math.round(0.1 / grid.hop), blocks = [];
  for (let g = 0; g < grid.n; g += step) { let m = -99; for (let k = g; k < g + step && k < grid.n; k++) m = Math.max(m, grid.peak[k]); blocks.push(m >= quietDb); }
  const att = []; let s0 = -1, lastLoud = -1;
  for (let b = 0; b <= blocks.length; b++) {
    const loud = b < blocks.length && blocks[b];
    if (loud) { if (s0 < 0) s0 = b; lastLoud = b; }
    else if (s0 >= 0 && (b - lastLoud) * 0.1 >= PAUSE || (b === blocks.length && s0 >= 0)) { att.push({ start: s0 * 0.1, end: (lastLoud + 1) * 0.1 }); s0 = -1; }
  }
  // 2. the script as words with sentence numbers (lines and full stops end sentences)
  const S = [], sid = [];
  let sn = 0;
  scriptText.split(/\r?\n/).forEach(line => {
    line.split(/\s+/).filter(Boolean).forEach(w => { const t = T._norm(w); if (t) { S.push(t); sid.push(sn); } if (/[.?!।:]$/.test(w)) sn++; });
    sn++;
  });
  // 3. place each attempt in the script: local alignment, match +2/+1, mismatch / gap −1
  att.forEach(a => {
    a.w = words.filter(w => w.text && (w.start + w.end) / 2 >= a.start && (w.start + w.end) / 2 < a.end);
    const A = a.w.map(w => T._norm(w.text)).filter(Boolean), n = A.length, m = S.length;
    a.n = n; a.pos = new Set();
    if (n < 2) return;
    const H = [], D = [];
    for (let i = 0; i <= n; i++) { H.push(new Float32Array(m + 1)); D.push(new Uint8Array(m + 1)); }
    let best = 0, bi = 0, bj = 0;
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      const v = T._wordSc(A[i - 1], S[j - 1]), sc = v >= 2 ? 2 : v >= 0.6 ? 1 : -1;
      let h = H[i - 1][j - 1] + sc, d = 1;
      if (H[i - 1][j] - 1 > h) { h = H[i - 1][j] - 1; d = 2; }
      if (H[i][j - 1] - 1 > h) { h = H[i][j - 1] - 1; d = 3; }
      if (h <= 0) { h = 0; d = 0; }
      H[i][j] = h; D[i][j] = d;
      if (h > best) { best = h; bi = i; bj = j; }
    }
    for (let i = bi, j = bj; i > 0 && j > 0 && D[i][j]; ) {
      const d = D[i][j];
      if (d === 1) { if (T._wordSc(A[i - 1], S[j - 1]) >= 0.6) a.pos.add(j - 1); i--; j--; } else if (d === 2) i--; else j--;
    }
    a.score = best;
  });
  // 4. which attempts another re-says
  const sp = att.filter(a => a.pos.size >= 3);
  sp.forEach(a => {
    a.cut = sp.some(b => {
      if (b === a) return false;
      let ov = 0; a.pos.forEach(p => { if (b.pos.has(p)) ov++; });
      return ov >= 0.8 * a.pos.size && (b.start > a.start ? b.pos.size >= 0.6 * a.pos.size : a.pos.size < 0.6 * b.pos.size);   // an earlier take wins only over a clearly broken-off later one
    });
  });
  // 5. chatter: speech that says no script line — unless it looks like a line nobody kept
  const kept = new Set(); sp.forEach(a => { if (!a.cut) a.pos.forEach(p => kept.add(p)); });
  const lineKept = {}; kept.forEach(p => { lineKept[sid[p]] = true; });
  att.forEach(a => {
    if (a.pos.size >= 3) return;
    let lost = 0; a.pos.forEach(p => { if (!lineKept[sid[p]]) lost++; });
    a.cut = a.n >= 2 && lost < 2;
    a.chatter = true;
  });
  return { attempts: att, deletes: att.filter(a => a.cut).map(a => ({ start: a.start, end: a.end, reason: a.chatter ? 'not in your script' : 'another take of a line in your script',
    text: a.w.map(w => w.text).join(' ') })) };
}
module.exports = { attemptKeep };
