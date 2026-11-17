/*
 * ai-answer-parse — an AI answer is read whatever wrapping it comes in.
 *
 * Detect speakers failed on the owner's Mac with "Speaker data came back
 * malformed": the answers were read with a bare JSON.parse. parseAiJson takes
 * plain JSON, JSON in a ``` fence, the object inside a sentence, or a bare
 * list; it gives null for prose. The real panel.
 */
'use strict';
const H = require('./retakes-lib/harness');
const C = H.checker();
async function run() {
  console.log('🧩 AI answers are read in any wrapping (' + H.PANEL_DIR + ')');
  const browser = await H.launch();
  try {
    const o = await H.openPanel(browser, { host: () => ({}) });
    await new Promise(r => setTimeout(r, 1000));
    const r = await o.page.evaluate(() => {
      const P = window.CP_DEBUG.parseAiJson;
      return {
        plain: P('{"speakers":[1,1,2]}'),
        fence: P('Here you go:\n```json\n{"speakers":[1,2]}\n```'),
        inside: P('Sure! {"speakers":[1,1]} Hope this helps.'),
        list: P('[1,1,1]'),
        prose: P('I cannot do that.')
      };
    });
    C.check('plain JSON', JSON.stringify(r.plain) === '{"speakers":[1,1,2]}', r);
    C.check('JSON in a ``` fence', JSON.stringify(r.fence) === '{"speakers":[1,2]}', r);
    C.check('the object inside a sentence', JSON.stringify(r.inside) === '{"speakers":[1,1]}', r);
    C.check('a bare list', JSON.stringify(r.list) === '[1,1,1]', r);
    C.check('prose gives null', r.prose === null, r);
    await o.page.close();
  } finally { await browser.close(); }
  C.finish();
}
run().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
