/*
 * retakes-doc-comments.js — every doc comment in the retake modules sits on
 * the code it describes.
 *
 * smartedit.js had two doc comments stacked above replyDoc(): the first
 * ("Every cut the reply holds… a reply cut off mid-list still yields the cuts
 * that were complete") described replyCuts(), which lives further down — a
 * reader of replyDoc() got the wrong contract. A doc comment followed straight
 * by another doc comment is always one of them orphaned.
 *
 * Checked: takes.js, transcript.js, smartedit.js and verbatim.js have no
 * block comment immediately followed by another block comment.
 *
 * Exit 0 = pass, 1 = fail.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
console.log('retake modules: no orphaned doc comments');
const STACKED = /\/\*(?:(?!\*\/)[\s\S])*\*\/[ \t]*\n[ \t]*\/\*(?:(?!\*\/)[\s\S])*\*\/[ \t]*\n/g;
for (const f of ['takes.js', 'transcript.js', 'smartedit.js', 'verbatim.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', f), 'utf8');
  const hits = [];
  let m;
  while ((m = STACKED.exec(src))) hits.push('line ' + src.slice(0, m.index).split('\n').length + ': ' + m[0].split('\n')[0].trim());
  check(f + ': no doc comment stacked on another', hits.length === 0, hits.join(' | '));
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
