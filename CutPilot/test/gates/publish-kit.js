/*
 * publish-kit.js — 📣 Publish kit: everything to paste when uploading.
 *   A. the AI is asked in the video's own language, true titles, JSON; a
 *      long podcast is sent as lines from the WHOLE video (not just its start);
 *   B. whatever the AI sends back is made safe: three titles at most,
 *      hashtags start with #, a reply wrapped in prose or ``` is still read;
 *   C. in the panel: tap → titles, a description WITH the chapters and the
 *      hashtags, tags and a pinned comment, each with its own Copy; without
 *      words it says to transcribe first.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };

(async () => {
  console.log('📣 Publish kit');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-pk-'));
  const env = { tmpdir: path.join(root, 't'), homedir: path.join(root, 'h'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  try {
    const r = await P.page.evaluate(async () => {
      const Pk = window.CPPublish, out = {};
      // A
      const long = []; for (let i = 0; i < 3000; i++) long.push({ text: 'line ' + i + ' aaj hum paise ki baat karenge' });
      const d = Pk.digest(long, 12000), ls = d.split('\n');
      out.digest = { len: d.length, first: ls[0], last: ls[ls.length - 1], n: ls.length };
      const p = Pk.prompt([{ text: 'Aaj hum paise ki baat karenge' }], '0:00 Intro', 'long');
      out.prompt = { sys: p.system, user: p.user };
      // B
      out.norm = Pk.normalize('Here you go:\n```json\n{"titles":["A","B","C","D"],"description":"desc","hashtags":["paisa","#money"],"tags":["x"],"pinned":"Kya aap?"}\n```');
      // C — no words yet
      const K = window.CPKit;
      const realRead = K.readTranscript, realAi = K.aiChat;
      K.readTranscript = () => { throw new Error('No transcript yet — transcribe first.'); };
      document.getElementById('btn-pk-make').click();
      await new Promise(r => setTimeout(r, 300));
      out.noWords = (document.querySelector('.toast') || {}).textContent || '';
      // words + chapters + a fake AI
      K.readTranscript = () => [{ start: 0, end: 3, text: 'Aaj hum paise ki baat karenge' }];
      let asked = null;
      K.aiChat = (pr) => { asked = pr; return Promise.resolve(JSON.stringify({ titles: ['Paise kaise bachayein', 'Saving 101', 'Budget hack'], description: 'Is video mein…', hashtags: ['#paisa', '#finance'], tags: ['saving', 'budget'], pinned: 'Aap kitna bachate ho?' })); };
      document.getElementById('ch-out').textContent = '0:00 Intro\n1:20 Budget';
      document.getElementById('ch-results').classList.remove('hidden');
      document.getElementById('btn-pk-make').click();
      for (let i = 0; i < 40 && document.getElementById('pk-out').classList.contains('hidden'); i++) await new Promise(r => setTimeout(r, 50));
      const blocks = Array.from(document.querySelectorAll('#pk-out .pk-block')).map(b => ({ h: b.querySelector('.field-label').textContent, t: b.lastChild.textContent, copy: !!b.querySelector('button') }));
      out.blocks = blocks; out.askedChapters = !!(asked && /1:20 Budget/.test(asked.user));
      K.readTranscript = realRead; K.aiChat = realAi;
      return out;
    });
    const dg = r.digest;
    (dg.len <= 12500 && /line 0 /.test(dg.first) && Number(/line (\d+)/.exec(dg.last)[1]) > 2800 && /SAME language/.test(r.prompt.sys) && /JSON/.test(r.prompt.sys) && /0:00 Intro/.test(r.prompt.user) ? ok : bad)(
      'A. asked in the video\'s own language, as JSON, with the chapters; a 3000-line podcast goes as lines from start to end (' + dg.n + ' lines, ' + dg.first + ' … ' + dg.last + ')', JSON.stringify(dg));
    const n = r.norm;
    (n.titles.length === 3 && JSON.stringify(n.hashtags) === '["#paisa","#money"]' && n.pinned === 'Kya aap?' ? ok : bad)('B. a reply wrapped in prose and ``` is read; 3 titles at most; every hashtag starts with #', JSON.stringify(n));
    (/transcribe/i.test(r.noWords) ? ok : bad)('C. without words it says to transcribe first ("' + r.noWords.slice(0, 80) + '")');
    const by = (h) => (r.blocks.find(b => b.h === h) || {}).t || '';
    const desc = by('Description');
    (r.blocks.filter(b => /^Title /.test(b.h)).length === 3 && /Is video mein/.test(desc) && /Chapters\n0:00 Intro\n1:20 Budget/.test(desc) && /#paisa #finance/.test(desc) &&
     by('Pinned comment') === 'Aap kitna bachate ho?' && /saving, budget/.test(by('Tags')) && r.blocks.every(b => b.copy) && r.askedChapters ? ok : bad)(
      'C. three titles, a description with the chapters and hashtags, the pinned comment and tags — each with its own Copy', JSON.stringify(r.blocks));
  } finally { await P.close(); }
  if (failed) { console.log('PUBLISH KIT: ' + failed + ' failed'); process.exit(1); }
  console.log('PUBLISH KIT: titles, description, chapters, hashtags, pinned comment ✓');
})().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
