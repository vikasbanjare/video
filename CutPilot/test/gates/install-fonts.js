/*
 * install-fonts.js — 🔤 Install caption fonts puts the styles' Google fonts
 * into the user's own fonts folder, so editable captions in Premiere use the
 * same faces as the image captions.
 *
 * Owner's diagnostics (v0.10.33): 23 caption fonts were not installed, so
 * editable captions swapped Poppins → Futura, Anton → Impact and every Hindi
 * face → Kohinoor Devanagari. A stand-in curl answers Google Fonts:
 *   A. every caption family is asked for with its Regular + Bold AND its
 *      Hindi letters (subset=…devanagari — without it the Hindi faces came
 *      down English-only);
 *   B. each face lands in ~/Library/Fonts as <Family>-<Regular|Bold>-Pulse.ttf;
 *   C. a file that is not a font is never kept; a family Google does not have
 *      is named, not faked;
 *   D. Pulse says to restart Premiere once; a second run downloads nothing.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./overlay-lib.cjs');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };

(async () => {
  console.log('🔤 Install caption fonts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-if-'));
  const env = { tmpdir: path.join(root, 't'), homedir: path.join(root, 'h'), platform: 'darwin' };
  fs.mkdirSync(env.tmpdir, { recursive: true }); fs.mkdirSync(env.homedir, { recursive: true });
  const log = path.join(root, 'curl.txt'), curl = path.join(root, 'curl');
  // css: two faces per family (Teko: a "font" that is really an HTML page; Rozha One: not on Google)
  fs.writeFileSync(curl, [
    '#!/bin/sh',
    'echo "$*" >> ' + JSON.stringify(log),
    'out=""; url=""; for a in "$@"; do case "$prev" in -o) out="$a";; esac; prev="$a"; url="$a"; done',
    'case "$url" in',
    '  *fonts.googleapis.com/css*)',
    '    fam=$(printf "%s" "$url" | sed -e "s/.*family=//" -e "s/:.*//" -e "s/+/ /g")',
    '    [ "$fam" = "Rozha One" ] && { echo "@font-face { font-family: \'Rozha One\'; src: local(x); }"; exit 0; }',
    '    slug=$(printf "%s" "$fam" | tr -d " ")',
    '    printf "@font-face {\\n  font-family: \'%s\';\\n  font-style: normal;\\n  font-weight: 400;\\n  src: url(https://fonts.gstatic.com/s/%s-400.ttf) format(\'truetype\');\\n}\\n" "$fam" "$slug"',
    '    printf "@font-face {\\n  font-family: \'%s\';\\n  font-style: normal;\\n  font-weight: 700;\\n  src: url(https://fonts.gstatic.com/s/%s-700.ttf) format(\'truetype\');\\n}\\n" "$fam" "$slug";;',
    '  *Teko*) printf "<html>not a font</html>%2000s" x > "$out";;',
    '  *.ttf) { printf "\\000\\001\\000\\000"; head -c 3000 /dev/zero; } > "$out";;',
    'esac', ''].join('\n'));
  fs.chmodSync(curl, 0o755);
  const P = await L.launchPanel({ env });
  if (P.skip) { console.log('  ? ' + P.skip + ' — skipped'); process.exit(2); }
  P.bridge.state.alias = { curl };
  async function run() {
    return P.page.evaluate(async () => {
      document.getElementById('toast').textContent = '';
      const s = document.querySelector('.tab[data-tab="settings"]'); if (s) s.click();
      await new Promise(r => setTimeout(r, 150));
      document.getElementById('btn-install-fonts').click();
      for (let i = 0; i < 600; i++) {
        await new Promise(r => setTimeout(r, 200));
        if (/Installed|already installed|Every caption font|Couldn.t download/.test(document.getElementById('toast').textContent)) break;
      }
      return document.getElementById('toast').textContent;
    });
  }
  const t1 = await run();
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  const cssCalls = calls.filter(c => /fonts\.googleapis\.com\/css/.test(c));
  (cssCalls.length >= 20 && cssCalls.every(c => /:400,700&subset=latin,latin-ext,devanagari/.test(c)) && cssCalls.some(c => /family=Baloo\+2/.test(c)) ? ok : bad)(
    'A. ' + cssCalls.length + ' families asked for, each with Regular + Bold and its Hindi letters');
  const dir = path.join(env.homedir, 'Library', 'Fonts');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  (files.indexOf('Poppins-Bold-Pulse.ttf') >= 0 && files.indexOf('Baloo2-Regular-Pulse.ttf') >= 0 && files.indexOf('BebasNeue-Bold-Pulse.ttf') >= 0 && files.every(f => /-(Regular|Bold)-Pulse\.ttf$/.test(f)) ? ok : bad)(
    'B. ' + files.length + ' faces in ~/Library/Fonts (' + files.slice(0, 4).join(', ') + '…)');
  (!files.some(f => /^Teko/.test(f) || /\.part$/.test(f)) && /Rozha One/.test(t1) ? ok : bad)('C. a non-font file is never kept; a family Google lacks is named (' + t1.slice(-90) + ')');
  fs.writeFileSync(log, '');
  const t2 = await run();
  const dl2 = fs.readFileSync(log, 'utf8').split('\n').filter(c => /\.ttf/.test(c) && !/Teko/.test(c));
  (/Quit and reopen Premiere/.test(t1) && dl2.length === 0 && /already installed \(48 files\)/.test(t2) ? ok : bad)('D. "restart Premiere once"; a second run downloads nothing (' + t2.slice(0, 90) + ')');
  await P.close();
  if (failed) { console.log('INSTALL FONTS: ' + failed + ' failed (' + root + ')'); process.exit(1); }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log('INSTALL FONTS: the caption fonts land in the fonts folder ✓');
})().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
