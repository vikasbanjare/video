/*
 * host-remove-safety.js — "Remove captions" and "Remove guide" take only what
 * Pulse put on the timeline, never the owner's footage.
 *
 * Both removals judged a clip by its NAME alone:
 *   · Remove Pulse's captions (CP_removePulseCaptionTracks) cleared every
 *     video track whose clips all had names containing flux, subtitle, pulse,
 *     cap_1…, so the owner's "Pulse ep 3.mp4" or "Flux intro.mov" alone on a
 *     track was deleted with the captions;
 *   · Remove guide (CP_removeOverlay), whenever the panel no longer knew the
 *     guide's track (after a reload), deleted EVERY clip on EVERY video track
 *     whose name contained guide, pulse or brand — "Brand story.mp4", a
 *     "Style guide.mov", a "pulse" episode.
 * The REAL host.jsx (ES3 built-ins, test/es3-runtime.js) on a small timeline:
 *   A. Remove captions clears Pulse's caption images (cap_00012.png), its
 *      one-clip overlay (pulse-captions-….mov, and captions.mov from older
 *      versions) and caption templates (graphics named like Pulse's), and
 *      keeps footage whose file name merely contains pulse / flux /
 *      subtitle, a logo, and a track mixing a caption with footage
 *   B. Remove guide takes Pulse's guide.png only — on the track it was told,
 *      or anywhere when it was not told — never footage named guide / pulse /
 *      brand
 * PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ES3 = require('../es3-runtime.js');

const PANEL = process.env.PANEL_DIR || path.join(__dirname, '..', '..');
let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
console.log('removals take only what Pulse placed (' + PANEL + ')');

/* tracks: [[{ name, media }]] — media '' for a graphic (a caption template) */
function world(tracks) {
  const V = tracks.map(t => t.map(c => Object.assign({}, c)));
  const domTracks = () => {
    const list = V.map(clips => ({
      clips: new Proxy({}, { get(t, k) {
        if (k === 'numItems') return clips.length;
        const n = Number(k), c = clips[n];
        return Number.isInteger(n) && c ? { name: c.name, projectItem: { getMediaPath: () => c.media, nodeId: 'n-' + c.name } } : undefined;
      } })
    }));
    list.numTracks = V.length;
    return list;
  };
  const seq = { name: 'Episode 7', get videoTracks() { return domTracks(); }, audioTracks: Object.assign([], { numTracks: 0 }) };
  const ctx = vm.createContext({
    app: { enableQE() {}, project: { activeSequence: seq } },
    qe: { project: { getActiveSequence: () => ({
      getVideoTrackAt: (i) => ({
        get numItems() { return V[i].length; },
        getItemAt: (k) => { const c = V[i][k]; return c ? { name: c.name, type: 'Clip', remove() { V[i].splice(V[i].indexOf(c), 1); } } : null; }
      })
    }) } }
  });
  ES3.strip(ctx);
  vm.runInContext(fs.readFileSync(path.join(PANEL, 'jsx', 'host.jsx'), 'utf8'), ctx, { filename: 'host.jsx' });
  return { V, call: (fn, a) => JSON.parse(ctx[fn](JSON.stringify(a || {}))) };
}
const names = (t) => t.map(c => c.name).join('+') || '(empty)';

// A. Remove captions
{
  const w = world([
    [{ name: 'Pulse ep 3.mp4', media: '/Users/owner/Shows/Pulse ep 3.mp4' }],                         // V1 footage
    [{ name: 'Flux intro.mov', media: '/Users/owner/Shows/Flux intro.mov' }],                          // V2 footage
    [{ name: 'cap_10000.png', media: '/Users/owner/Shows/Pulse Media/caption-images-ep7-1/cap_10000.png' },
     { name: 'cap_10001.png', media: '/Users/owner/Shows/Pulse Media/caption-images-ep7-1/cap_10001.png' }],   // V3 caption images
    [{ name: 'Flux_Apex', media: '' }, { name: 'Flux_Apex', media: '/Users/owner/Documents/Adobe/Flux_Apex.aegraphic' }], // V4 templates
    [{ name: 'pulse-captions-Main-1-p-20260101.mov', media: '/Users/owner/Shows/Pulse Media/pulse-captions-Main-1-p-20260101.mov' }], // V5 overlay
    [{ name: 'captions.mov', media: '/Users/owner/Shows/captions.mov' }],                              // V6 a v0.9.36x overlay
    [{ name: 'cap_10002.png', media: '/tmp/cutpilot-frames-1/cap_10002.png' }, { name: 'Subtitle b-roll.mp4', media: '/Users/owner/Subtitle b-roll.mp4' }], // V7 mixed
    [{ name: 'brand.png', media: '/Users/owner/Logos/brand.png' }]                                     // V8 a logo
  ]);
  const r = w.call('CP_removePulseCaptionTracks');
  const kept = w.V.map(names);
  report(r.ok && kept[2] === '(empty)' && kept[3] === '(empty)' && kept[4] === '(empty)' && kept[5] === '(empty)' && r.tracks.join(',') === '6,5,4,3',
    'A. Pulse’s caption images, templates and overlays are cleared (tracks ' + (r.tracks || []).join(', ') + ', ' + r.cleared + ' clips)');
  report(kept[0] === 'Pulse ep 3.mp4' && kept[1] === 'Flux intro.mov',
    'A. footage whose file name only contains pulse / flux stays (V1 ' + kept[0] + ', V2 ' + kept[1] + ')');
  report(kept[6] === 'cap_10002.png+Subtitle b-roll.mp4' && kept[7] === 'brand.png',
    'A. a track mixing a caption with footage, and a logo, stay (V7 ' + kept[6] + ', V8 ' + kept[7] + ')');
}

// B. Remove guide
{
  const tracks = () => [
    [{ name: 'Pulse ep 3.mp4', media: '/Users/owner/Pulse ep 3.mp4' }, { name: 'Brand story.mp4', media: '/Users/owner/Brand story.mp4' }],
    [{ name: 'Style guide.mov', media: '/Users/owner/Style guide.mov' }],
    [{ name: 'guide.png', media: '/var/folders/x/T/pulse-guide-1712/guide.png' }]
  ];
  const w = world(tracks());
  const r = w.call('CP_removeOverlay', {});
  report(r.ok && r.removed === 1 && names(w.V[2]) === '(empty)' && names(w.V[0]) === 'Pulse ep 3.mp4+Brand story.mp4' && names(w.V[1]) === 'Style guide.mov',
    'B. not told the track: only Pulse’s guide.png goes; “Pulse ep 3”, “Brand story”, “Style guide” stay (removed ' + r.removed + ')');
  const w2 = world(tracks());
  const r2 = w2.call('CP_removeOverlay', { track: 3 });
  const w3 = world(tracks());
  const r3 = w3.call('CP_removeOverlay', { track: 2 });
  report(r2.ok && r2.removed === 1 && names(w2.V[2]) === '(empty)' && r3.ok && r3.removed === 0 && names(w3.V[1]) === 'Style guide.mov',
    'B. told the track: its guide.png goes, and a told track holding footage keeps it');
}

if (failed) { console.log('REMOVE SAFETY: ' + failed + ' failed'); process.exit(1); }
console.log('REMOVE SAFETY: Remove captions and Remove guide never take the owner’s footage ✓');
