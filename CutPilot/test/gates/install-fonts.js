/*
 * install-fonts.js — 🔤 Install caption fonts puts the styles' Google fonts
 * into the user's own fonts folder, so editable captions in Premiere use the
 * same faces as the image captions.
 *
 * Owner's diagnostics (v0.10.33): 23 caption fonts were not installed, so
 * editable captions swapped Poppins → Futura, Anton → Impact and every Hindi
 * face → Kohinoor Devanagari. A stand-in curl answers Google Fonts:
 *   A. every caption family is asked for with its Regular + Bold from the
 *      css2 API — whole faces named as Premiere asks for them (the css API
 *      sent Hindi faces English-only and Rubik Bold as "RubikLight-Bold");
 *   B. each face lands in ~/Library/Fonts as <Family>-<Regular|Bold>-Pulse2.ttf,
 *      replacing the first install's -Pulse.ttf copy;
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
    // a Black (900) request: Montserrat and Poppins have one; Rubik's fails here
    '    case "$url" in *wght@900*) [ "$fam" = "Rubik" ] && exit 22; printf "@font-face {\\n  font-family: \'%s\';\\n  font-style: normal;\\n  font-weight: 900;\\n  src: url(https://fonts.gstatic.com/s/%s-900.ttf) format(\'truetype\');\\n}\\n" "$fam" "$slug"; exit 0;; esac',
    '    printf "@font-face {\\n  font-family: \'%s\';\\n  font-style: normal;\\n  font-weight: 400;\\n  src: url(https://fonts.gstatic.com/s/%s-400.ttf) format(\'truetype\');\\n}\\n" "$fam" "$slug"',
    '    printf "@font-face {\\n  font-family: \'%s\';\\n  font-style: normal;\\n  font-weight: 700;\\n  src: url(https://fonts.gstatic.com/s/%s-700.ttf) format(\'truetype\');\\n}\\n" "$fam" "$slug";;',
    '  *Teko*) printf "<html>not a font</html>%2000s" x > "$out";;',
    '  *.ttf) { printf "\\000\\001\\000\\000"; head -c 3000 /dev/zero; } > "$out";;',
    'esac', ''].join('\n'));
  fs.chmodSync(curl, 0o755);
  // the first install's copy of a face (v0.10.35, maybe misnamed) is replaced
  fs.mkdirSync(path.join(env.homedir, 'Library', 'Fonts'), { recursive: true });
  fs.writeFileSync(path.join(env.homedir, 'Library', 'Fonts', 'Rubik-Bold-Pulse.ttf'), 'old');
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
  const blackCalls = cssCalls.filter(c => /:wght@900/.test(c)).map(c => (c.match(/family=([^:]+)/) || [])[1]);
  (cssCalls.length >= 20 && cssCalls.every(c => /css2\?family=[^ ]+:wght@(400;700|900)/.test(c)) && cssCalls.some(c => /family=Baloo\+2/.test(c)) ? ok : bad)(
    'A. ' + cssCalls.length + ' families asked for, each with Regular + Bold from the css2 API (whole faces, the names Premiere asks for)');
  const dir = path.join(env.homedir, 'Library', 'Fonts');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  (files.indexOf('Poppins-Bold-Pulse2.ttf') >= 0 && files.indexOf('Baloo2-Regular-Pulse2.ttf') >= 0 && files.indexOf('BebasNeue-Bold-Pulse2.ttf') >= 0 && files.every(f => /-(Regular|Bold|Black)-Pulse2\.ttf$/.test(f)) ? ok : bad)(
    'B. ' + files.length + ' faces in ~/Library/Fonts (' + files.slice(0, 4).join(', ') + '…)');
  (files.indexOf('Rubik-Bold-Pulse.ttf') < 0 ? ok : bad)('B. the first install\'s Rubik-Bold-Pulse.ttf is replaced');
  // Black (900) for the families a style draws that heavy — and only those
  (blackCalls.sort().join(',') === 'Montserrat,Poppins,Rubik' && files.indexOf('Montserrat-Black-Pulse2.ttf') >= 0 && files.indexOf('Poppins-Black-Pulse2.ttf') >= 0 &&
   files.indexOf('Rubik-Bold-Pulse2.ttf') >= 0 && !files.some(f => /^Rubik-Black/.test(f)) ? ok : bad)(
    'B. Black (900) asked for the heavy styles\' families only (' + blackCalls.join(', ') + '); a family Google has no Black for still installs Regular + Bold', JSON.stringify(files.filter(f => /Black|Rubik/.test(f))));
  (!files.some(f => /^Teko/.test(f) || /\.part$/.test(f)) && /Rozha One/.test(t1) ? ok : bad)('C. a non-font file is never kept; a family Google lacks is named (' + t1.slice(-90) + ')');
  fs.writeFileSync(log, '');
  const t2 = await run();
  const dl2 = fs.readFileSync(log, 'utf8').split('\n').filter(c => /\.ttf/.test(c) && !/Teko/.test(c));
  (/Quit and reopen Premiere/.test(t1) && dl2.length === 0 && t2.indexOf('already installed (' + files.length + ' files)') >= 0 ? ok : bad)('D. "restart Premiere once"; a second run downloads nothing (' + t2.slice(0, 90) + ')');
  await P.close();
  if (failed) { console.log('INSTALL FONTS: ' + failed + ' failed (' + root + ')'); process.exit(1); }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log('INSTALL FONTS: the caption fonts land in the fonts folder ✓');
})().catch(e => { console.log('  ✗ harness ran without throwing\n      ' + (e && e.stack)); process.exit(1); });
