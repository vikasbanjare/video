// loopfix.js audio.wav words.json out.json — find where the local transcriber got stuck
// in a loop ("इश्यू इश्यू इश्यू…", "ट्वेट्वेट्वे…") and re-transcribe ONLY those windows
// with -mc 0 (no carried-over text: the loop's cause), splicing the new words in.
// -mc 0 for the whole file is no fix: it made Edelweiss worse (6.1 s -> 27.3 s).
const fs = require('fs'), cp = require('child_process'), os = require('os'), path = require('path');
const [wav, inp, out] = process.argv.slice(2);
const W = JSON.parse(fs.readFileSync(inp)).words;
const norm = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
// a word made of one short piece said 4+ times, or the same word 4+ times in a row
const selfLoop = w => /(.{2,6})\1{3,}/u.test(norm(w.word));
const loops = [];
for (let i = 0; i < W.length; ) {
  let j = i + 1;
  while (j < W.length && norm(W[j].word) && norm(W[j].word) === norm(W[i].word)) j++;
  if (j - i >= 4 || selfLoop(W[i])) loops.push([Math.max(0, W[i].start - 1), W[j - 1].end + 1]);
  i = j;
}
// merge windows that touch
const win = [];
for (const [a, b] of loops) { const l = win[win.length - 1]; if (l && a <= l[1] + 2) l[1] = Math.max(l[1], b); else win.push([a, b]); }
console.log('loops: ' + win.map(([a, b]) => a.toFixed(1) + '-' + b.toFixed(1)).join('  '));
let words = W.slice();
for (const [a, b] of win) {
  const base = path.join(os.tmpdir(), 'loopfix-' + process.pid);
  cp.spawnSync('/opt/homebrew/bin/whisper-cli', ['-m', os.homedir() + '/.cutpilot/models/ggml-large-v3-turbo-q5_0.bin', '-f', wav,
    '-ot', String(Math.round(a * 1000)), '-d', String(Math.round((b - a) * 1000)), '-osrt', '-of', base, '-l', 'hi', '-ml', '1', '-sow', '-mc', '0', '-t', '8'], { stdio: 'ignore' });
  cp.spawnSync('node', [path.join(__dirname, 'srt2words.js'), base + '.srt', base + '.json'], { stdio: 'ignore' });
  let fresh = [];
  try { fresh = JSON.parse(fs.readFileSync(base + '.json')).words; } catch (e) {}
  // whisper's -ot times are already absolute; keep only what falls in the window
  fresh = fresh.filter(w => w.start >= a - 0.05 && w.end <= b + 0.05);
  words = words.filter(w => w.end <= a || w.start >= b).concat(fresh).sort((x, y) => x.start - y.start);
  console.log(`  ${a.toFixed(1)}-${b.toFixed(1)}: ${fresh.length} words: ${fresh.map(w => w.word).join(' ').slice(0, 120)}`);
}
fs.writeFileSync(out, JSON.stringify({ words }));
