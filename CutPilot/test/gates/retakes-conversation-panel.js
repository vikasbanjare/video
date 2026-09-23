/*
 * retakes-conversation-panel.js — "Who is talking?" reaches the retake finder
 * and the AI Smart Cleanup prompt, in the REAL panel.
 *
 * The AI pass always told the model "this is usually a SCRIPT being
 * re-recorded … KEEP ONLY THE LAST clean take of every line" and always asked
 * for "tangent" cuts — on a podcast that is the wrong job: a guest's answer
 * that echoes the question reads like a re-read line, and a side story is the
 * content. `scripted` was hard-coded to true.
 *
 * Checked (fake Premiere, fake network; the prompt is read from the request
 * the panel really sends):
 *   1. "Two or more people" → no "script being re-recorded" framing and no
 *      "tangent" category; "Just me" → both;
 *   2. Auto + a transcript whose labels show two people → conversation
 *      framing; Auto + no labels → the scripted framing as before;
 *   3. "Find repeated takes" on an unlabelled podcast whose guest agrees in the
 *      host's words cuts nothing on Strong with "Two or more people", while
 *      "Just me" catches a lone speaker's "right, …" restart.
 *
 * Exit 0 = pass, 1 = fail, 2 = skipped (no puppeteer / Chromium).
 */
'use strict';
const fs = require('fs');
const H = require('./retakes-lib/harness');
const C = H.checker();

function stream(lines) {
  const out = []; let t = 0.3;
  lines.forEach((l) => {
    const text = Array.isArray(l) ? l[0] : l, spk = Array.isArray(l) ? l[1] : null;
    text.split(' ').forEach((w) => { const o = { text: w, start: +t.toFixed(3), end: +(t + 0.3).toFixed(3) }; if (spk != null) o.speaker = spk; out.push(o); t += 0.36; });
    t += 0.8;
  });
  return out;
}
const POD = ['I think consistency is the key to growing.', 'Yes, consistency is the key to growing, absolutely.',
             'And posting every single day matters a lot.', 'Posting every single day matters, but quality matters more.',
             'The algorithm rewards watch time more than likes.', 'Right, the algorithm rewards watch time more than anything.'];
const SOLO = ['The algorithm rewards watch time more than', 'right, the algorithm rewards watch time more than likes.', 'So focus on the first three seconds.'];

async function run() {
  console.log('retakes: "Who is talking?" in the real panel');
  const browser = await H.launch();
  try {
    const prompts = [];
    const curl = (args) => {
      const url = args.find(a => /^https:\/\//.test(a)) || '';
      if (/groq\.com\/openai\/v1\/models/.test(url)) return JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] });
      if (/groq\.com\/openai\/v1\/chat/.test(url)) {
        const f = args[args.indexOf('--data-binary') + 1].replace(/^@/, '');
        const body = JSON.parse(fs.readFileSync(f, 'utf8'));
        prompts.push(body.messages[body.messages.length - 1].content);
        return JSON.stringify({ choices: [{ message: { content: '{"cuts":[]}' }, finish_reason: 'stop' }] });
      }
      return '{}';
    };
    const { page } = await H.openPanel(browser, { curl, host: () => ({}), settings: { groqKey: 'gsk-test-key' } });
    async function smart(kind, words) {
      prompts.length = 0;
      await page.evaluate((k, ws) => {
        const sel = document.getElementById('tk-kind');
        if (sel) { sel.value = k; sel.dispatchEvent(new Event('change')); }
        window.CP_DEBUG_EXT.retakes.setTranscript({ words: ws, captionCues: null, transcript: null });
        document.getElementById('toast').textContent = '';
        document.getElementById('takes-results').classList.add('hidden');
        document.getElementById('btn-smart-cleanup').click();
      }, kind, words);
      await H.waitFor(page, () => /failed/.test(document.getElementById('toast').textContent) ||
        !document.getElementById('takes-results').classList.contains('hidden'), 10000);
      const p = prompts.join('\n');
      return { scripted: /SCRIPT being re-recorded/.test(p), tangent: /"tangent"/.test(p), sent: prompts.length };
    }
    const one = await smart('one', stream(POD));
    const many = await smart('many', stream(POD));
    C.check('"Two or more people": the AI is NOT told this is a script being re-recorded', many.sent > 0 && !many.scripted, JSON.stringify(many));
    C.check('"Two or more people": the AI is not asked to cut "tangents" (a podcast\'s side story is content)', many.sent > 0 && !many.tangent, JSON.stringify(many));
    C.check('"Just me": the scripted re-record framing and tangents are kept', one.sent > 0 && one.scripted && one.tangent, JSON.stringify(one));
    const labelled = await smart('auto', stream(POD.map((l, i) => [l, i % 2])));
    C.check('Auto + speaker labels showing two people → conversation framing', labelled.sent > 0 && !labelled.scripted && !labelled.tangent, JSON.stringify(labelled));
    const plain = await smart('auto', stream(POD));
    C.check('Auto + no labels → the scripted framing as before', plain.sent > 0 && plain.scripted, JSON.stringify(plain));

    async function find(kind, strength, words) {
      return page.evaluate(async (k, s, ws) => {
        const sel = document.getElementById('tk-kind'); if (sel) sel.value = k;
        const b = document.querySelector('#tk-strength button[data-s="' + s + '"]'); if (b) b.click();
        window.CP_DEBUG_EXT.retakes.setTranscript({ words: ws, captionCues: null, transcript: null });
        document.getElementById('takes-results').classList.add('hidden');
        document.getElementById('btn-takes-find').click();
        for (let i = 0; i < 60 && document.getElementById('takes-results').classList.contains('hidden'); i++) await new Promise(r => setTimeout(r, 50));
        return { stats: document.getElementById('takes-stats').textContent,
                 list: Array.from(document.querySelectorAll('#takes-list .seg-item span[title]')).map(x => x.title).join(' | ') };
      }, kind, strength, words);
    }
    const podMany = await find('many', 'strong', stream(POD));
    C.check('Find · Strong · "Two or more people" on an unlabelled podcast: nothing is cut', /Nothing to remove/.test(podMany.stats), podMany.stats + ' | ' + podMany.list);
    const soloOne = await find('one', 'balanced', stream(SOLO));
    C.check('Find · Balanced · "Just me": the "…more than / right, the algorithm…" restart is found',
      /Found\s*1\s*cut/.test(soloOne.stats) && /more than/.test(soloOne.list) && !/likes/.test(soloOne.list), soloOne.stats + ' | ' + soloOne.list);
    await page.close();
  } finally {
    await browser.close();
  }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
