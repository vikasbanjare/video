/*
 * short-names-unique — a short made again from the same moment gets its own
 * sequence name, so ⤴ Export all sends the new one, to its own file.
 *
 * On the owner's project three shorts were named "Mass Uninstall Shock";
 * Export all picks shorts by name, so it would have sent the oldest, and all
 * to one .mp4. The REAL host.jsx:
 *   A. a free name is kept;  B. a taken one becomes "… 2", then "… 3".
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ES3 = require(path.join(__dirname, '..', 'es3-runtime.js'));
let failed = 0;
const check = (m, c, d) => { if (c) console.log('  ✓ ' + m); else { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); } };
console.log('🎬 Shorts get names of their own');
const names = ['QA Webinar', 'Mass Uninstall Shock', 'Mass Uninstall Shock 2'];
const seqs = names.map(n => ({ name: n })); seqs.numSequences = names.length;
const sb = { app: { project: { sequences: seqs } } };
vm.createContext(sb); ES3.strip(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'jsx', 'host.jsx'), 'utf8'), sb, { filename: 'host.jsx' });
check('A. a free name is kept ("Future AI Advantage")', sb.CP_uniqueSequenceName('Future AI Advantage') === 'Future AI Advantage');
const n = sb.CP_uniqueSequenceName('Mass Uninstall Shock');
check('B. "Mass Uninstall Shock" (taken, and "… 2" too) → "' + n + '"', n === 'Mass Uninstall Shock 3', n);
console.log(failed ? 'SHORT NAMES: ' + failed + ' failed' : 'SHORT NAMES: each its own ✓');
process.exit(failed ? 1 : 0);
