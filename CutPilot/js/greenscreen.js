/*
 * greenscreen.js — 🟩 Green screen: one tap keys out a green or blue backdrop.
 *
 * Pulse puts Premiere's own Ultra Key on the selected clips and sets its Key
 * Color to the backdrop it samples from each clip (a small frame read with
 * the bundled ffmpeg). Ultra Key plays live and stays editable in Effect
 * Controls — nothing is rendered or downloaded, and it works on any computer.
 * (CorridorKey 2.0 was weighed: NVIDIA-only and its licence forbids bundling.)
 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function K() { return window.CPKit || null; }

  /* The backdrop colour in a frame of rgb24 bytes. A backdrop pixel is one
     whose green (or blue) clearly beats the other two channels; the colour
     is the median of those pixels, so a hand or shadow cannot drag it.
     Returns { hex, kind: 'green'|'blue', share } or null (no screen found). */
  function pickKeyColor(rgb) {
    var g = [], b = [], i;
    for (i = 0; i + 2 < rgb.length; i += 3) {
      var R = rgb[i], G = rgb[i + 1], B = rgb[i + 2];
      if (G - Math.max(R, B) > 25) g.push(i); else if (B - Math.max(R, G) > 25) b.push(i);
    }
    var px = rgb.length / 3, pick = g.length >= b.length ? g : b;
    // ponytail: a screen filling under 8% of the frame reads as "none" — a green shirt is not a backdrop
    if (!px || pick.length / px < 0.08) return null;
    function med(off) {
      var v = pick.map(function (j) { return rgb[j + off]; }).sort(function (x, y) { return x - y; });
      return v[v.length >> 1];
    }
    var hex = '#' + [0, 1, 2].map(function (o) { return ('0' + med(o).toString(16)).slice(-2); }).join('').toUpperCase();
    return { hex: hex, kind: pick === g ? 'green' : 'blue', share: pick.length / px };
  }

  // one small frame of the clip's own media as rgb24 bytes
  function sampleFrame(kit, ff, clip, n) {
    var fs = kit.nodeReq('fs'), path = kit.nodeReq('path'), os = kit.nodeReq('os');
    var out = path.join(os.tmpdir(), 'pulse-key-' + Date.now() + '-' + n + '.rgb');
    return kit.runFfmpeg(ff, ['-y', '-ss', String(Math.max(0, clip.at)), '-i', clip.path, '-frames:v', '1',
      '-vf', 'scale=96:-2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', out], 30000).then(function () {
      var buf = null;
      try { buf = fs.readFileSync(out); fs.unlinkSync(out); } catch (e) {}
      return buf;
    });
  }

  var busy = false;
  function say(m) { var el = $('gs-result'); if (el) { el.textContent = m; el.classList.remove('hidden'); } }

  function run() {
    var kit = K(); if (!kit || busy) return;
    var ff = kit.resolveFfmpeg();
    if (!ff) { kit.toast('Pulse\'s video engine (ffmpeg) is missing — reinstall Pulse.', true); return; }
    busy = true;
    var btn = $('btn-green-screen'); if (btn) btn.disabled = true;
    kit.capProgress('Reading your backdrop…');
    var noScreen = [];
    CPBridge.callHost('CP_greenScreenClips').then(function (r) {
      // one sample per media file (the same take cut ten times is one backdrop)
      var byPath = {};
      return r.clips.reduce(function (p, c, n) {
        return p.then(function (acc) {
          if (byPath[c.path] !== undefined) { if (byPath[c.path]) acc.push(Object.assign({}, c, { color: byPath[c.path] })); return acc; }
          return sampleFrame(kit, ff, c, n).then(function (buf) {
            var k = buf && pickKeyColor(buf);
            byPath[c.path] = k ? k.hex : null;
            if (k) acc.push(Object.assign({}, c, { color: k.hex })); else noScreen.push(c.name);
            return acc;
          });
        });
      }, Promise.resolve([]));
    }).then(function (clips) {
      if (!clips.length) throw new Error('No green or blue backdrop found in the selected clip' + (noScreen.length > 1 ? 's' : '') + '.');
      kit.capProgress('Keying ' + clips.length + ' clip' + (clips.length === 1 ? '' : 's') + '…');
      return CPBridge.callHost('CP_applyUltraKey', { clips: clips.map(function (c) { return { track: c.track, start: c.start, color: c.color }; }) })
        .then(function (r) { return { r: r, color: clips[0].color }; });
    }).then(function (o) {
      kit.capProgress(null);
      var r = o.r, done = r.keyed + r.recolored;
      if (!done) throw new Error('Premiere would not take the key on the selected clip(s).');
      var msg = '🟩 Keyed ' + done + ' clip' + (done === 1 ? '' : 's') + ' with Ultra Key (backdrop ' + o.color + ').' +
        (r.recolored ? ' ' + r.recolored + ' already keyed got the new colour.' : '') +
        (noScreen.length ? ' No backdrop found in: ' + noScreen.join(', ') + '.' : '') +
        (r.failed ? ' ' + r.failed + ' could not be keyed.' : '') +
        ' Fine-tune in Effect Controls → Ultra Key; put your new background on the track below.';
      say(msg); kit.toast(msg);
    }).catch(function (e) {
      kit.capProgress(null);
      var m = (e && e.message) || String(e);
      say('⚠️ ' + m); kit.toast(m, true);
    }).then(function () { busy = false; if (btn) btn.disabled = false; });
  }

  /* Open the card from anywhere (Home's tile, ⌘K), like Studio sound's. */
  function show() {
    var tab = document.querySelector('.tab[data-tab="silence"]'); if (tab) tab.click();
    setTimeout(function () {
      var c = $('gs-card'); if (!c) return;
      try { c.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { c.scrollIntoView(); }
      c.classList.add('flash'); setTimeout(function () { c.classList.remove('flash'); }, 1600);
    }, 120);
  }

  function wire() {
    if ($('btn-green-screen')) $('btn-green-screen').addEventListener('click', run);
    if ($('home-greenscreen')) $('home-greenscreen').addEventListener('click', function () { setTimeout(show, 0); });
  }
  window.CPGreenScreen = { pickKeyColor: pickKeyColor, run: run, show: show };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  }
})();
