/*
 * host-render-mogrt-frames.js — CP_renderMogrtFrames draws a Premium template
 * with the owner's words without touching their timeline.
 *
 * "🎬 Preview with my words" (gallery-premium-render.js tests the panel side
 * against a stand-in) asks Premiere, through this host function, for real
 * frames of each Premium template. The REAL jsx/host.jsx in a vm with a small
 * imitation of Premiere's scripting objects (app.project, a sequence, a
 * Motion Graphics template's text property, QE's playhead and frame export):
 *   · a temporary sequence at the size asked for, made active only while it
 *     renders; the owner's sequence is active again afterwards, and the
 *     temporary one is deleted;
 *   · the template is placed on it, the owner's words go into its text, and
 *     one frame is exported per time asked, at the timecode QE's playhead
 *     writes for that time, named <outBase>_00, _01… (QE adds ".png");
 *   · a template Premiere won't place is an error, and still nothing is left
 *     behind.
 * PANEL_DIR=<dir> runs it against another copy of the panel.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PANEL = process.env.PANEL_DIR || path.join(__dirname, '..', '..');
const TICKS = 254016000000;
let failed = 0;
const report = (ok, msg) => { if (!ok) failed++; console.log('  ' + (ok ? '✓' : '✗') + ' ' + msg); };
console.log('Premium template render in Premiere (' + PANEL + ')');

function world(opts) {
  const log = { created: [], deleted: [], exports: [], active: [], texts: [] };
  const mkSeq = (name) => {
    const s = { name, sequenceID: name, settings: { videoFrameWidth: 1920, videoFrameHeight: 1080 }, playhead: 0, clips: [],
      getSettings() { return Object.assign({}, this.settings); }, setSettings(st) { this.settings = Object.assign({}, st); },
      setPlayerPosition(t) { this.playhead = Number(t) / TICKS; },
      importMGT(p) {
        if (opts.refuse) return null;
        let val = '{"textEditValue":"Flux Sample"}';
        const prop = { displayName: 'Text', getValue: () => val, setValue: (v) => { val = String(v); log.texts.push(val); } };
        const props = [prop]; props.numItems = 1;
        const clip = { path: p, end: null, getMGTComponent: () => ({ properties: props }) };
        this.clips.push(clip);
        return clip;
      } };
    return s;
  };
  const own = mkSeq('Episode 7');
  const project = {
    _active: own,
    get activeSequence() { return this._active; },
    set activeSequence(s) { this._active = s; log.active.push(s.name); },
    createNewSequence(name, id) { const s = mkSeq(name + '#' + id); log.created.push(s); return s; },
    deleteSequence(s) { log.deleted.push(s.name); return true; }
  };
  const sandbox = { JSON, Math, Date, String, Number, Array, Object, Error, RegExp,
    Time: function () { this.seconds = 0; },
    app: { enableQE() {}, project },
    qe: { project: { getActiveSequence() {
      const s = project.activeSequence;
      return {
        get CTI() { const f = Math.round(s.playhead * 25); return { timecode: '00:00:' + (Math.floor(f / 25) < 10 ? '0' : '') + Math.floor(f / 25) + ':' + (f % 25 < 10 ? '0' : '') + (f % 25) }; },
        exportFramePNG(tc, base) { log.exports.push({ seq: s.name, tc: String(tc), base, size: s.settings.videoFrameWidth + 'x' + s.settings.videoFrameHeight }); return true; }
      };
    } } }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PANEL, 'jsx', 'host.jsx'), 'utf8'), sandbox, { filename: 'host.jsx' });
  return { sandbox, log, own, project };
}

{
  const w = world({});
  const times = [0.2, 1.0, 2.6];
  const res = JSON.parse(w.sandbox.CP_renderMogrtFrames(JSON.stringify({ mogrtPath: '/m/Flux_Apex.mogrt', text: 'Namaste dosto aaj hum',
    seconds: 3, times, outBase: '/tmp/prem-x', width: 1080, height: 1920 })));
  const temp = w.log.created[0];
  report(res.ok && w.log.created.length === 1 && temp && temp.settings.videoFrameWidth === 1080 && temp.settings.videoFrameHeight === 1920 &&
         w.project.activeSequence === w.own && w.log.deleted.length === 1 && w.log.deleted[0] === temp.name && res.cleaned === true,
    'a temporary 1080×1920 sequence, active only while it renders: the owner’s sequence is active again and the temporary one is deleted');
  report(temp && temp.clips.length === 1 && temp.clips[0].path === '/m/Flux_Apex.mogrt' && w.log.texts.some(t => /"textEditValue":"Namaste dosto aaj hum"/.test(t)),
    'the template is placed on it with the owner’s words in its text (' + JSON.stringify(w.log.texts.slice(-1)[0] || 'none') + ')');
  const ex = w.log.exports;
  report(ex.length === 3 && ex.every(e => e.seq === temp.name && e.size === '1080x1920') &&
         ex.map(e => e.tc).join(',') === '00:00:00:05,00:00:01:00,00:00:02:15' &&
         ex.map(e => e.base).join(',') === '/tmp/prem-x_00,/tmp/prem-x_01,/tmp/prem-x_02' &&
         (res.files || []).join(',') === '/tmp/prem-x_00.png,/tmp/prem-x_01.png,/tmp/prem-x_02.png',
    'one frame per time, at the timecode QE’s playhead writes (' + ex.map(e => e.tc).join(', ') + '), named _00, _01, _02');
}
{
  const w = world({ refuse: true });
  const res = JSON.parse(w.sandbox.CP_renderMogrtFrames(JSON.stringify({ mogrtPath: '/m/Broken.mogrt', text: 'x', times: [1], outBase: '/tmp/b', width: 1920, height: 1080 })));
  report(res.ok === false && /would not place/.test(res.error) && w.project.activeSequence === w.own && w.log.deleted.length === 1,
    'a template Premiere won’t place is an error (' + JSON.stringify(res.error) + '), and nothing is left behind');
}

if (failed) { console.log('PREMIUM RENDER IN PREMIERE: ' + failed + ' failed'); process.exit(1); }
console.log('PREMIUM RENDER IN PREMIERE: a temporary sequence, the owner’s words, real frames, nothing left behind ✓');
