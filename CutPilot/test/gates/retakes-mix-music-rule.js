/*
 * retakes-mix-music-rule — the verbatim mix leaves a track out as music ONLY
 * the way Clean up does: by the owner's answer or the Premiere track name,
 * never by how it sounds.
 *
 * Found in release verification: prepareTimelineMix left out any file that
 * merely SOUNDED steady (voice under 10 dB above its noise) — its comment
 * still claimed "the same test Clean up uses", which the silence fix had made
 * untrue. A remote guest on a noisy phone line (a Deepgram key set, the
 * default "Repeated takes" on, Podcast preset) was dropped from what the
 * verbatim engine heard, and the host re-asking a question right after the
 * guest's answer cut that answer as a "retake". The owner has a Deepgram key
 * and makes podcasts.
 *
 * Runs the REAL prepareTimelineMix in the panel; only the two listening steps
 * (file info, level measurement) are replaced with fixed answers.
 */
const path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const PANEL_DIR = process.env.CP_PANEL_DIR || path.join(ROOT, 'CutPilot');
let failed = 0;
const ok = (c, m, d) => { console.log('  ' + (c ? '✓' : '✗') + ' ' + m + (c || !d ? '' : '\n      ' + d)); if (!c) failed++; };
let pptr = null;
for (const t of [path.join(ROOT, 'node_modules', 'puppeteer'), 'puppeteer', 'puppeteer-core']) { try { pptr = require(t); break; } catch (e) {} }
const exe = ['/opt/pw-browsers/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
if (!pptr || !exe) { console.log('  ? no puppeteer/Chromium — skipped'); process.exit(2); }
console.log('verbatim mix: music leaves only by the owner\'s answer or the track name, never by sound');
(async () => {
  const browser = await pptr.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.goto('file://' + path.join(PANEL_DIR, 'index.html'), { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1000));
  const r = await page.evaluate(async () => {
    const X = window.CP_DEBUG_EXT && window.CP_DEBUG_EXT.mix;
    if (!X) return { fatal: 'CP_DEBUG_EXT.mix missing' };
    const item = (p) => ({ mediaPath: p, seqStart: 0, seqEnd: 60, inPoint: 0, outPoint: 60, speed: 1 });
    // steady = what the level meter says: the guest on a noisy phone line and a
    // music bed both "sound steady"; the studio host does not.
    const STEADY = { '/m/guest_phone.wav': true, '/m/bed.wav': true };
    const deps = {
      audioInfo: () => Promise.resolve({ streams: 1 }),
      measure: (inp) => Promise.resolve({ continuous: !!STEADY[inp.path], digital: false })
    };
    const run = async (seqId, tracks) => {
      const s = { sequenceId: seqId, audio: tracks.map((t, i) => ({ index: i, name: t[0], items: [item(t[1])] })) };
      const res = await X.prepare(s, deps);
      return { left: Object.keys(res.left), notes: res.notes };
    };
    const out = {};
    out.guest = await run('s1', [['Audio 1', '/m/host.wav'], ['Audio 2', '/m/guest_phone.wav']]);
    out.named = await run('s2', [['Audio 1', '/m/host.wav'], ['Audio 2', '/m/guest.wav'], ['Music', '/m/bed.wav']]);
    X.setRole('s3', 'A3', 'music');
    out.answered = await run('s3', [['Audio 1', '/m/host.wav'], ['Audio 2', '/m/guest.wav'], ['Audio 3', '/m/bed.wav']]);
    X.setRole('s4', 'A2', 'mic');
    out.overrule = await run('s4', [['Audio 1', '/m/host.wav'], ['Music', '/m/guest_phone.wav']]);
    out.unnamedBed = await run('s5', [['Audio 1', '/m/host.wav'], ['Audio 2', '/m/guest.wav'], ['Audio 3', '/m/bed.wav']]);
    return out;
  });
  await browser.close();
  if (r.fatal) { ok(false, r.fatal); process.exit(1); }
  ok(r.guest.left.length === 0, 'the owner\'s case: a guest on a noisy phone line (sounds steady) is KEPT in what the verbatim engine hears',
     'left out: ' + JSON.stringify(r.guest.left));
  ok(r.guest.notes.some(n => /kept in/.test(n) && /name the track/.test(n)), 'and the owner is told it was kept, and how to leave real music out',
     JSON.stringify(r.guest.notes));
  ok(r.named.left.length === 1 && r.named.left[0] === '/m/bed.wav', 'a track named "Music" is left out, by its name', JSON.stringify(r.named.left));
  ok(r.answered.left.length === 1 && r.answered.left[0] === '/m/bed.wav', 'an unnamed bed the owner answered "Yes, it\'s music" for is left out', JSON.stringify(r.answered.left));
  ok(r.overrule.left.length === 0, 'the owner\'s "No, it\'s a voice" beats a track named Music: kept', JSON.stringify(r.overrule.left));
  ok(r.unnamedBed.left.length === 0, 'an unnamed, unanswered steady bed is KEPT (never left out by sound alone)', JSON.stringify(r.unnamedBed.left));
  console.log(failed ? 'MIX MUSIC RULE: ' + failed + ' FAILURE(S)' : 'MIX MUSIC RULE: no voice is left out of the verbatim mix by its sound ✓');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('  ✗ harness error: ' + e.message); process.exit(1); });
