/*
 * broll-ai-shots — 💡 B-roll ideas gives shots to film, where they are said.
 *
 * On the owner's 8-minute webinar the ideas were single words ("world,
 * person, continues, launched, launch"). With the AI key set, the timed
 * transcript goes to the AI and its shots come back in a second toast.
 * The real panel, a fake AI:
 *   A. the AI is sent the lines with their seconds;
 *   B. its shots are shown with their times;
 *   C. an unreadable answer keeps the local list (no error toast).
 */
'use strict';
const fs = require('fs');
const H = require('./retakes-lib/harness');
const C = H.checker();
const srt = [[0, 'Google launched Gemini today'], [65, 'a robot arm in the warehouse sorts boxes'], [130, 'and the stock market went up']]
  .map((c, i) => (i + 1) + '\n00:0' + Math.floor(c[0] / 60) + ':' + String(c[0] % 60).padStart(2, '0') + ',000 --> 00:0' + Math.floor(c[0] / 60) + ':' + String(c[0] % 60 + 3).padStart(2, '0') + ',000\n' + c[1] + '\n').join('\n');

async function run() {
  console.log('🎬 B-roll ideas: AI shots where they are said (' + H.PANEL_DIR + ')');
  const browser = await H.launch();
  try {
    let sent = null, mode = 'ok';
    const curl = (args) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (/\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.1-8b-instant' }] });
      if (!/chat\/completions/.test(url)) return '{}';
      const body = JSON.parse(fs.readFileSync(args[args.indexOf('--data-binary') + 1].replace(/^@/, ''), 'utf8'));
      if (!/B-roll/.test(body.messages[0].content)) return '{}';
      sent = body.messages[1].content;
      const content = mode === 'ok' ? JSON.stringify({ ideas: [{ t: 65, shot: 'robot arm sorting boxes' }, { t: 130, shot: 'stock ticker going up' }] }) : 'sorry';
      return JSON.stringify({ choices: [{ message: { content } }] });
    };
    const o = await H.openPanel(browser, { host: () => ({}), curl, settings: { groqKey: 'gsk-test-key' } });
    const page = o.page;
    async function ideas() {
      return page.evaluate(async (srt) => {
        window.__mem['/tmp/broll.srt'] = srt;
        window.CP_DEBUG_EXT.sync.setTranscript({ transcript: { path: '/tmp/broll.srt', label: 'b', mtime: 1e16 } });
        const to = document.getElementById('toast'); to.textContent = ''; to.className = to.className.replace(/\berr\b/, '');
        document.getElementById('btn-broll').click();
        const first = to.textContent;
        for (let i = 0; i < 40 && !/🎬/.test(to.textContent); i++) await new Promise(r => setTimeout(r, 100));
        return { first, last: to.textContent, err: /\berr\b/.test(to.className) };
      }, srt);
    }
    let r = await ideas();
    C.check('A. the AI is sent the lines with their seconds', /^0 Google launched/.test(sent || '') && /\n65 a robot arm/.test(sent || ''), sent);
    C.check('B. its shots are shown with their times ("' + r.last.slice(0, 90) + '")', /🎬/.test(r.last) && /robot arm sorting boxes \(1:05/.test(r.last) && /stock ticker going up \(2:10/.test(r.last), r);
    mode = 'bad';
    r = await ideas();
    await new Promise(res => setTimeout(res, 800));
    const after = await page.evaluate(() => ({ t: document.getElementById('toast').textContent, err: /\berr\b/.test(document.getElementById('toast').className) }));
    C.check('C. an unreadable answer keeps the local list, no error', /💡 B-roll ideas/.test(after.t) && !after.err, after);
    await page.close();
  } finally { await browser.close(); }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
