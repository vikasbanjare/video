/*
 * fonts-coverage — a caption must never be sent a font that cannot draw it.
 *
 * Reported from the owner's Mac: editable captions came out BLANK. The log
 * showed "fontSent":"NotoSansCoptic-Bold" — macOS installs dozens of
 * script-only "Noto Sans <script>" faces, the picker offered all of them with
 * normal-looking names, and Premiere drew nothing (it has no per-glyph
 * fallback the way a browser does).
 *
 * Part A reads real font files' cmap tables (and a synthetic Coptic-only font
 * built byte-for-byte here) and cross-checks the parser.
 * Part B drives the real panel: script-only faces are hidden, Hindi-capable
 * ones are labelled, every send is checked against the actual words, a saved
 * bad font is repaired, and an unreadable font is never swapped on a guess.
 *
 * Part B also covers a face that is NOT INSTALLED (review of the gallery
 * work): the nine Devanagari-first styles use Google faces a stock Mac does
 * not have (Baloo 2, Mukta, Hind…). Premiere cannot draw a missing font and
 * keeps the template's own (Inter — no Hindi letters), so once the scan knows
 * a face is missing, Hindi words go out in an installed face that draws them,
 * a Latin web face goes out as its Mac stand-in (Anton → Impact), and when no
 * installed face can draw the Hindi the owner is told. Before the scan has
 * run, nothing is swapped (unknown is not "cannot").
 */
const path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const PANEL_DIR = process.env.CP_PANEL_DIR || path.join(ROOT, 'CutPilot');
const F = require(path.join(PANEL_DIR, 'js', 'fonts.js'));
let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { console.log('  ✗ ' + m); failed++; };
console.log('fonts coverage (never send a caption a font that cannot draw it)');

// ---- A1: a synthetic font whose cmap covers ONLY Coptic — the owner's case ----
function coptic() {
  const be16 = v => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xFFFF); return b; };
  const be32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  const fmt4 = Buffer.concat([be16(4), be16(32), be16(0), be16(4), be16(4), be16(1), be16(0),
    be16(0x2CFF), be16(0xFFFF), be16(0), be16(0x2C80), be16(0xFFFF),
    be16((1 - 0x2C80) & 0xFFFF), be16(1), be16(0), be16(0)]);
  const cmap = Buffer.concat([be16(0), be16(1), be16(3), be16(1), be32(12), fmt4]);
  const nm = Buffer.from('Noto Sans Coptic', 'utf16le').swap16();
  const name = Buffer.concat([be16(0), be16(1), be16(18), be16(3), be16(1), be16(0x409), be16(1), be16(nm.length), be16(0), nm]);
  const hdr = Buffer.concat([be32(0x00010000), be16(2), be16(32), be16(1), be16(0)]);
  const o1 = 12 + 32, o2 = o1 + cmap.length;
  const recs = Buffer.concat([Buffer.from('cmap'), be32(0), be32(o1), be32(cmap.length),
                              Buffer.from('name'), be32(0), be32(o2), be32(name.length)]);
  return Buffer.concat([hdr, recs, cmap, name]);
}
const cbuf = coptic();
const cnames = F.parseFamilyNames(cbuf), ccov = F.parseCoverage(cbuf);
if (cnames[0] !== 'Noto Sans Coptic') bad('synthetic font name not read: ' + JSON.stringify(cnames));
else if (!ccov || ccov.latin !== false || ccov.devanagari !== false) bad('a Coptic-only font is not detected as drawing neither English nor Hindi: ' + JSON.stringify(ccov));
else ok('a Coptic-only font (built byte-for-byte) reads as "Noto Sans Coptic", drawing neither English nor Hindi');
if (F.canDraw(ccov, F.scriptNeeds('Make every word count')) !== false) bad('canDraw says a Coptic font can draw English');
else ok('canDraw: the Coptic font cannot draw an English caption');
if (F.canDraw(null, F.scriptNeeds('Hello')) !== null) bad('unknown coverage must be null (never a guessed "no")');
else ok('an unreadable font is "unknown", never a guessed "cannot draw"');
const sn = F.scriptNeeds('Aaj हम baat करेंगे');
if (!sn.latin || !sn.devanagari) bad('mixed Hinglish text must need both scripts: ' + JSON.stringify(sn));
else ok('mixed Hinglish text needs both English and Hindi letters');

// ---- A2: real installed fonts, cross-checked against fontconfig -------------
let fcAvailable = false;
try { require('child_process').execFileSync('fc-list', ['--version'], { stdio: 'pipe' }); fcAvailable = true; } catch (e) {}
const real = F.listInstalledFontsDetailed(fs, path, {});
if (!real.length || !fcAvailable) {
  console.log('  ? no installed fonts / fontconfig here — real-font cross-check skipped');
} else {
  const cp = require('child_process');
  const fcHas = (fam, cpHex) => { try { return cp.execFileSync('fc-list', [':family=' + fam + ':charset=' + cpHex], { stdio: 'pipe' }).toString().trim().length > 0; } catch (e) { return null; } };
  let checked = 0, mism = [];
  for (const f of real.slice(0, 400)) {
    if (f.latin == null) continue;
    const a = fcHas(f.name, '41 61 7a'), k = fcHas(f.name, '915 92e 94d');
    if (a == null || k == null) continue;
    checked++;
    if (a !== f.latin || k !== f.devanagari) mism.push(f.name + ' (pulse ' + f.latin + '/' + f.devanagari + ', fontconfig ' + a + '/' + k + ')');
  }
  if (mism.length > Math.max(1, checked * 0.02)) bad('coverage disagrees with fontconfig on ' + mism.length + '/' + checked + ': ' + mism.slice(0, 4).join('; '));
  else ok('coverage matches fontconfig on ' + (checked - mism.length) + '/' + checked + ' installed families' + (mism.length ? ' (' + mism.length + ' edge case: ' + mism[0] + ')' : ''));
}

// ---- B: the real panel ------------------------------------------------------
let pptr = null;
for (const t of [path.join(ROOT, 'node_modules', 'puppeteer'), 'puppeteer', 'puppeteer-core']) { try { pptr = require(t); break; } catch (e) {} }
const exe = ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
if (!pptr || !exe) { console.log('  ? no puppeteer/Chromium — panel part skipped'); process.exit(failed ? 1 : 2); }

(async () => {
  const browser = await pptr.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e && e.message)));
  await page.goto('file://' + path.join(PANEL_DIR, 'index.html'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1500));
  const r = await page.evaluate(() => {
    const X = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.fonts;
    if (!X) return { fatal: 'CP_DEBUG_EXT.fonts missing' };
    // before any scan: nothing is known about installation — sent as chosen
    const preScan = X.resolve('Baloo 2', 'आज हम बात करेंगे');
    X.setCoverage([
      { name: 'Noto Sans Coptic', latin: false, devanagari: false },
      { name: 'Noto Sans Adlam', latin: false, devanagari: false },
      { name: 'Helvetica Neue', latin: true, devanagari: false },
      { name: 'Kohinoor Devanagari', latin: true, devanagari: true },
      { name: 'Samyak Devanagari', latin: false, devanagari: true },
      { name: 'Impact', latin: true, devanagari: false },
      { name: 'Mystery Font', latin: null, devanagari: null }
    ]);
    const opts = X.options();
    const has = n => opts.some(o => o.value === n);
    const label = n => (opts.find(o => o.value === n) || {}).label || '';
    const out = {
      copticOffered: has('Noto Sans Coptic'), adlamOffered: has('Noto Sans Adlam'),
      kohinoorLabel: label('Kohinoor Devanagari'), samyakLabel: label('Samyak Devanagari'),
      helveticaOffered: has('Helvetica Neue'), mysteryOffered: has('Mystery Font'),
      hidden: X.hidden(),
      english: X.resolve('Noto Sans Coptic', 'Make every word count'),
      hindiInLatinFont: X.resolve('Helvetica Neue', 'आज हम बात करेंगे'),
      latinInHindiOnly: X.resolve('Samyak Devanagari', 'aaj hum baat karenge'),
      fine: X.resolve('Helvetica Neue', 'Make every word count'),
      unknown: X.resolve('Mystery Font', 'Make every word count')
    };
    // NOT INSTALLED (Baloo 2, Mukta, Anton are absent from the scan above)
    out.preScan = preScan;
    out.hindiNotInstalled = X.resolve('Baloo 2', 'आज हम बात करेंगे');
    out.hinglishNotInstalled = X.resolve('Mukta', 'Ye trick सच में काम करती है');
    out.latinNotInstalled = X.resolve('Anton', 'Make every word count');
    out.installedKept = X.resolve('Impact', 'Make every word count');
    X.setFont('Noto Sans Coptic');
    out.repaired = X.repair();
    // a machine where NOTHING installed draws Hindi: send, but say so
    X.setCoverage([{ name: 'Helvetica Neue', latin: true, devanagari: false }, { name: 'Impact', latin: true, devanagari: false }]);
    const tEl = document.getElementById('toast'); if (tEl) tEl.textContent = '';
    out.noHindiFont = X.resolve('Hind', 'आज हम बात करेंगे');
    out.noHindiToast = tEl ? tEl.textContent : '';
    return out;
  });
  await browser.close();
  if (r.fatal) { bad(r.fatal); process.exit(1); }
  if (r.copticOffered || r.adlamOffered) bad('the font picker still offers faces that draw neither English nor Hindi');
  else ok('the picker hides faces that draw neither English nor Hindi (' + r.hidden.join(', ') + ')');
  if (!/हिंदी/.test(r.kohinoorLabel) || /only/.test(r.kohinoorLabel)) bad('a Hindi+English font is not labelled "हिंदी": ' + r.kohinoorLabel);
  else ok('Hindi-capable fonts are labelled in the picker ("' + r.kohinoorLabel.trim() + '")');
  if (!/हिंदी only/.test(r.samyakLabel)) bad('a Hindi-only font is not labelled "हिंदी only": ' + r.samyakLabel);
  else ok('a Hindi-only font says so, since Hinglish words in it would vanish');
  if (!r.helveticaOffered || !r.mysteryOffered) bad('a usable or unreadable font was hidden — never hide on a guess');
  else ok('ordinary fonts and fonts whose coverage is unknown stay in the picker');
  if (!r.english || /Coptic/i.test(r.english.font) || r.english.substitutedFrom !== 'Noto Sans Coptic') bad('an English caption is still sent the Coptic font: ' + JSON.stringify(r.english));
  else ok('the reported case: an English caption is never sent "NotoSansCoptic-Bold" (sent ' + r.english.font + ')');
  if (!r.hindiInLatinFont || !/Kohinoor/.test(r.hindiInLatinFont.font)) bad('Hindi words sent to an English-only font: ' + JSON.stringify(r.hindiInLatinFont));
  else ok('Hindi words in an English-only font switch to one that draws Hindi (' + r.hindiInLatinFont.font + ')');
  if (!r.latinInHindiOnly || /Samyak/.test(r.latinInHindiOnly.font)) bad('English words sent to a Hindi-only font: ' + JSON.stringify(r.latinInHindiOnly));
  else ok('Hinglish in Latin letters never goes to a Hindi-only font (' + r.latinInHindiOnly.font + ')');
  if (!r.fine || r.fine.substitutedFrom) bad('a font that CAN draw the words was swapped anyway: ' + JSON.stringify(r.fine));
  else ok('a font that can draw the words is sent exactly as chosen');
  if (!r.unknown || r.unknown.substitutedFrom) bad('a font with unknown coverage was swapped on a guess');
  else ok('a font with unreadable coverage is sent as chosen, never guessed away');
  if (r.repaired === 'Noto Sans Coptic') bad('a saved look holding the Coptic font is not repaired');
  else ok('a saved look that already holds a blank-drawing font is repaired on launch (→ ' + r.repaired + ')');
  // not installed
  if (!r.preScan || r.preScan.substitutedFrom) bad('before the installed-font scan a face was swapped on a guess: ' + JSON.stringify(r.preScan));
  else ok('before the installed-font scan nothing is swapped (Baloo 2 sent as chosen: ' + r.preScan.font + ')');
  if (!r.hindiNotInstalled || !/Kohinoor/.test(r.hindiNotInstalled.font) || r.hindiNotInstalled.substitutedFrom !== 'Baloo 2')
    bad('Hindi words in a face that is not installed (Baloo 2) still go to Premiere, which would keep its template font: ' + JSON.stringify(r.hindiNotInstalled));
  else ok('Hindi words in a face that is not installed (Baloo 2) go out in an installed Hindi face (' + r.hindiNotInstalled.font + ')');
  if (!r.hinglishNotInstalled || !/Kohinoor/.test(r.hinglishNotInstalled.font))
    bad('Hinglish in a face that is not installed (Mukta) is not sent in a face that draws both scripts: ' + JSON.stringify(r.hinglishNotInstalled));
  else ok('Hinglish in a face that is not installed (Mukta) goes out in one that draws both scripts (' + r.hinglishNotInstalled.font + ')');
  if (!r.latinNotInstalled || r.latinNotInstalled.font !== 'Impact' || r.latinNotInstalled.substitutedFrom !== 'Anton')
    bad('a Latin web face that is not installed (Anton) is not sent as its Mac stand-in: ' + JSON.stringify(r.latinNotInstalled));
  else ok('a Latin web face that is not installed (Anton) goes out as its Mac stand-in (Impact)');
  if (!r.installedKept || r.installedKept.substitutedFrom) bad('an installed face was swapped: ' + JSON.stringify(r.installedKept));
  else ok('an installed face that draws the words is sent as chosen (Impact)');
  if (!/Hindi/.test(r.noHindiToast || '') || !/Pulse-rendered/.test(r.noHindiToast || ''))
    bad('with no installed face that draws Hindi, the owner is not told (toast: "' + r.noHindiToast + '", sent ' + JSON.stringify(r.noHindiFont) + ')');
  else ok('with no installed face that draws Hindi, the owner is told to use Pulse-rendered captions (' + r.noHindiFont.font + ' sent)');
  if (errs.length) bad('page errors: ' + errs.slice(0, 2).join(' | '));
  console.log(failed ? 'FONTS COVERAGE: ' + failed + ' FAILURE(S)' : 'FONTS COVERAGE: no caption is sent a font that cannot draw it ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ harness error: ' + e.message); process.exit(1); });
