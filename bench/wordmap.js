// wordmap.js edit_words.json raw_words.json out.json — where the hand edit's words were
// taken from in the raw recording, by WORDS (sound skeletons, any script), so a
// processed edit or one that moves sections around still maps. Each 6-word window
// of the edit is placed where the raw says the same words in order; consecutive
// windows landing together become one kept range of the raw.
const fs = require('fs');
const T = require('../CutPilot/js/takes.js');
const E = JSON.parse(fs.readFileSync(process.argv[2])).words, R = JSON.parse(fs.readFileSync(process.argv[3])).words;
const key = w => { const n = T._norm(w.word); const s = T._skel(n); return s.length >= 2 ? s : n; };
const ek = E.map(key), rk = R.map(key), K = 6;
function lcs(a, b) {                       // in-order matches and where they sit in b
  const L = a.map(() => new Int16Array(b.length + 1)); L.push(new Int16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    L[i][j] = a[i] && a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const at = []; let i = 0, j = 0;
  while (i < a.length && j < b.length) { if (a[i] && a[i] === b[j]) { at.push([i, j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++; }
  return at;
}
const place = [];                          // edit word → raw word
for (let s = 0; s + K <= ek.length; s += 2) {
  const win = ek.slice(s, s + K); let best = null;
  for (let r = 0; r + K <= rk.length; r++) {
    const m = lcs(win, rk.slice(r, r + K + 3));
    if (m.length >= 4 && (!best || m.length > best.m.length || (m.length === best.m.length && r > best.r))) best = { r, m };   // ties: the later take
  }
  if (best) for (const [i, j] of best.m) if (place[s + i] == null) place[s + i] = best.r + j;
}
// group into raw ranges: consecutive edit words placed close together in the raw
const out = []; let cur = null;
for (let i = 0; i < E.length; i++) {
  const j = place[i]; if (j == null) continue;
  if (cur && j > cur.j1 && j - cur.j1 <= 4) { cur.j1 = j; cur.e1 = i; }
  else { if (cur) out.push(cur); cur = { j0: j, j1: j, e0: i, e1: i }; }
}
if (cur) out.push(cur);
const ranges = out.filter(c => c.e1 - c.e0 >= 2).map(c => ({ o0: R[c.j0].start, o1: R[c.j1].end, e0: E[c.e0].start, e1: E[c.e1].end, words: c.e1 - c.e0 + 1 }));
// what the edit really kept: the raw time under the placed words (joined across gaps < 0.8 s),
// not a section's first-to-last word — that counted 14 s of silence inside one as "kept"
const under = []; const placedRaw = [...new Set(place.filter(j => j != null))].sort((a, b) => a - b);
for (const j of placedRaw) { const w = R[j], last = under[under.length - 1]; if (last && w.start - last.o1 < 0.8) last.o1 = Math.max(last.o1, w.end); else under.push({ o0: w.start, o1: w.end }); }
if (process.argv[5]) fs.writeFileSync(process.argv[5], JSON.stringify(under));
fs.writeFileSync(process.argv[4], JSON.stringify(ranges, null, 0));
const placed = place.filter(x => x != null).length;
console.log(`${placed}/${E.length} edit words placed; ${ranges.length} raw ranges, ${ranges.reduce((a, r) => a + r.o1 - r.o0, 0).toFixed(1)} s of raw`);
ranges.forEach(r => console.log(`  edit ${r.e0.toFixed(1).padStart(5)}-${r.e1.toFixed(1).padStart(5)} ← raw ${r.o0.toFixed(1).padStart(6)}-${r.o1.toFixed(1).padStart(6)} (${r.words} words)`));
const missing = []; let m0 = -1;
for (let i = 0; i <= E.length; i++) { const miss = i < E.length && place[i] == null; if (miss && m0 < 0) m0 = i; if (!miss && m0 >= 0) { if (i - m0 >= 3) missing.push(E[m0].start.toFixed(1) + ' "' + E.slice(m0, i).map(w => w.word).join(' ').slice(0, 70) + '"'); m0 = -1; } }
if (missing.length) { console.log('edit words not found in the raw:'); missing.forEach(x => console.log('  ' + x)); }
