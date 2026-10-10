/*
 * ui-honest-messages — messages the owner reads promise only what will happen,
 * in plain words.
 *
 * Found in release verification (a first-time walkthrough):
 *   - pressing Clean up showed "I'll add the captions automatically when it's
 *     done" — Clean up never adds captions;
 *   - the transcription-done toast named the engine and model ("Cloud · Groq
 *     (large-v3) … Word-level highlight ready");
 *   - a status line read "…almost as loud as the voice —, so nothing…";
 *   - a phone guest's hum was described as possibly "music mixed into the voice".
 * Static checks on js/main.js: each would come straight back with a careless edit.
 */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const PANEL_DIR = process.env.CP_PANEL_DIR || path.join(ROOT, 'CutPilot');
const src = fs.readFileSync(path.join(PANEL_DIR, 'js', 'main.js'), 'utf8');
let failed = 0;
const ok = (c, m) => { console.log('  ' + (c ? '✓' : '✗') + ' ' + m); if (!c) failed++; };
console.log('honest messages (promise only what happens, in plain words)');
const fnAt = src.indexOf('function ensureTranscriptThen(');
const body = src.slice(fnAt, src.indexOf('\n  }\n', fnAt));
const auto = (body.match(/action === 'autoclean'\s*\?\s*'([^']*(?:\\'[^']*)*)'/) || [])[1] || '';
ok(fnAt > 0 && auto.length > 0, 'Clean up has its own waiting message');
ok(auto && !/caption/i.test(auto), 'Clean up\'s waiting message does not promise captions: "' + auto.slice(0, 80) + '"');
const doneAt = src.indexOf("toast('✓ Got the words from");
ok(doneAt > 0, 'the transcription-done toast says what was done');
const doneStmt = doneAt > 0 ? src.slice(doneAt, src.indexOf(');', doneAt)) : '';
ok(doneStmt && !/modelLabel|Groq|large-v3|Word-level/.test(doneStmt), 'the transcription-done toast names no engine or model');
ok(!/as loud as the voice —'/.test(src) && !/—', so nothing it plays over/.test(src), 'no stray "—," in the "never goes quiet" line');
ok(!/If that is music mixed into the voice/.test(src), 'a loud background is not assumed to be music');
console.log(failed ? 'HONEST MESSAGES: ' + failed + ' FAILURE(S)' : 'HONEST MESSAGES: every message promises only what happens ✓');
process.exit(failed ? 1 : 0);
