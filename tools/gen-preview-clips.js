/*
 * gen-preview-clips.js — render clean, on-brand ANIMATED preview clips for the
 * Flux .mogrt templates, so the gallery shows a readable looping word-by-word
 * animation in each template's REAL colours (gradient / box / highlight, read
 * from the template's definition.json) instead of the low-res, blobby thumb.mp4
 * that After Effects bakes in.
 *
 * Output: CutPilot/mogrts/thumbs/<Name>.mp4  (tiny yuv420p loops, ~30 KB each)
 * which loadBundledMogrts() picks up as the card's looping video.
 *
 * This is a DEV-time generator (needs Chromium + playwright-core + ffmpeg); the
 * produced .mp4s are committed as assets, so end-users never run this. Re-run it
 * after adding/recolouring a Flux template:
 *
 *   PW=/path/to/chromium  FF=/path/to/ffmpeg  node tools/gen-preview-clips.js
 *
 * It renders each template's word-by-word reveal with the SAME CPRender engine the
 * panel uses (js/render.js + js/captions.js), so the preview matches the engine's
 * real output styling. Sample phrase: "MAKE EVERY WORD COUNT".
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
const MDIR = path.join(ROOT, 'CutPilot', 'mogrts');
const TDIR = path.join(MDIR, 'thumbs');
const JS = path.join(ROOT, 'CutPilot', 'js');
const CHROME = process.env.PW || process.env.CHROME;
const FFMPEG = process.env.FF || 'ffmpeg';

if (!CHROME) { console.error('Set PW=/path/to/chromium (Playwright chromium executable).'); process.exit(1); }
let chromium; try { chromium = require('playwright-core').chromium; } catch (e) { console.error('npm i playwright-core'); process.exit(1); }

// --- read a template's accurate look (gradient/box/highlight) from definition.json ---
function styleOf(mogrt) {
  let cc = [];
  try { cc = JSON.parse(cp.execSync('unzip -p ' + JSON.stringify(mogrt) + ' definition.json', { maxBuffer: 64 << 20 }).toString()).clientControls || []; } catch (e) {}
  const nm = c => { try { return c.uiName.strDB[0].str; } catch (e) { return ''; } };
  const hx = a => { const h = x => { x = Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16); return x.length < 2 ? '0' + x : x; }; try { return '#' + h(a[0]) + h(a[1]) + h(a[2]); } catch (e) { return null; } };
  const role = n => { n = n.toLowerCase(); if (/highlight|active|spoken|current|emphasi/.test(n)) return 'hl'; if (/background|\bbg\b|\bbox\b|pill|panel|behind/.test(n)) return 'box'; if (/\btext\b|\bword\b|title|caption|\bfill\b/.test(n)) return 'fill'; return null; };
  let fill = null, box = null, hl = null, first = null, grad = [];
  cc.forEach(c => {
    if (c.type !== 4 || !c.value) return; const hex = hx(c.value); if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return;
    const rn = nm(c), n = rn.toLowerCase();
    if (/gradient/.test(n)) { grad.push(hex); return; } if (/light\s*sweep|shine|sheen/.test(n)) return;
    const r = role(rn); if (r === 'fill' && !fill) fill = hex; else if (r === 'box' && !box) box = hex; else if (r === 'hl' && !hl) hl = hex; if (!first) first = hex;
  });
  let fill2 = null; if (grad.length >= 2) { fill = grad[0]; fill2 = grad[grad.length - 1]; } else if (grad.length === 1 && !fill) fill = grad[0];
  return { fill: fill || first || '#ffffff', fill2: fill2, box: box, highlight: hl || fill2 || '#ffd400' };
}

const PAGE = `<!doctype html><html><head><meta charset="utf8"><style>html,body{margin:0;background:#0b0e16}#c{display:block}</style></head>
<body><canvas id="c"></canvas>
<script>${fs.readFileSync(path.join(JS, 'captions.js'))}</script>
<script>${fs.readFileSync(path.join(JS, 'render.js'))}</script>
<script>
var W=640,H=360,DPR=2,cv=document.getElementById('c');cv.width=W*DPR;cv.height=H*DPR;cv.style.width=W+'px';cv.style.height=H+'px';
var S=JSON.parse(decodeURIComponent(location.hash.slice(1)||'%7B%7D'));
var preset={id:'mg',name:'mg',font:'Inter',fontSize:150,weight:800,uppercase:true,fill:S.fill,fill2:S.fill2||null,highlight:S.highlight,boxColor:S.box||null,keyword:true,wordsPerCue:4,vCenter:true};
var st=CPRender.styleForFrame(preset,cv.height,{fontSize:Math.round(0.80*1080/(2*1.18)),maxWidthPct:0.92,maxLines:2,vCenter:true},cv.width);
var words=['MAKE','EVERY','WORD','COUNT'];
window.renderAt=function(i){var a=i%(words.length+2);var shown=a<words.length?words.slice(0,a+1):words;var act=a<words.length?a:-1;try{CPRender.drawFrame(cv,{words:shown,active:act},st);}catch(e){}};
</script></body></html>`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsegen-'));
  const html = path.join(tmp, 'anim.html'); fs.writeFileSync(html, PAGE);
  const mogrts = fs.readdirSync(MDIR).filter(f => /^Flux_.*\.mogrt$/i.test(f));
  const browser = await chromium.launch({ executablePath: CHROME });
  for (const file of mogrts) {
    const base = file.replace(/\.mogrt$/i, ''), style = styleOf(path.join(MDIR, file));
    const page = await browser.newPage();
    await page.goto('file://' + html + '#' + encodeURIComponent(JSON.stringify(style)));
    await page.waitForTimeout(250);
    const fdir = path.join(tmp, base); fs.mkdirSync(fdir, { recursive: true });
    let fi = 0;
    for (let s = 0; s < 6; s++) { await page.evaluate(i => window.renderAt(i), s); const reps = s >= 4 ? 10 : 8; for (let r = 0; r < reps; r++) { await page.locator('#c').screenshot({ path: path.join(fdir, String(1000 + fi).slice(1) + '.png') }); fi++; } }
    await page.close();
    cp.execSync(FFMPEG + ' -y -framerate 24 -i ' + JSON.stringify(path.join(fdir, '%03d.png')) + ' -vf format=yuv420p -movflags +faststart ' + JSON.stringify(path.join(TDIR, base + '.mp4')), { stdio: 'ignore' });
    console.log('  ✓ ' + base + '.mp4');
  }
  await browser.close();
  console.log('Done → ' + path.relative(process.cwd(), TDIR));
})().catch(e => { console.error(e); process.exit(1); });
