// srt2words.js in.srt out.json — whisper-cli -ml 1 -sow SRT (one word per cue) → {words:[{word,start,end}]}
const fs = require('fs');
const ts = s => { const m = s.match(/(\d+):(\d+):(\d+)[,.](\d+)/); return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000; };
const words = fs.readFileSync(process.argv[2], 'utf8').replace(/\r/g, '').split(/\n\n+/).map(b => b.split('\n'))
  .filter(b => b.length >= 3 && /-->/.test(b[1]))
  .map(b => { const [a, c] = b[1].split('-->'); return { word: b.slice(2).join(' ').trim(), start: ts(a), end: ts(c) }; })
  .filter(w => w.word);
fs.writeFileSync(process.argv[3], JSON.stringify({ words }));
console.log(words.length + ' words, ' + (words.length ? words[words.length - 1].end.toFixed(1) : 0) + ' s');
