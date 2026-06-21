/*
 * CutPilot — built-in sound-effects engine.
 * Synthesises short, original, royalty-free SFX (whoosh, pop, shutter, riser …)
 * as 16-bit PCM WAV bytes, so the panel can preview them (Web Audio) and drop
 * them on the timeline synced to caption / word / keyword timing — no shipped
 * copyrighted audio. Pure (no DOM / Node) so it runs in tests and in CEP.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPSfx = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var SR = 44100;

  // The curated library (id · display name · emoji · short blurb).
  var SFX = [
    { id: 'whoosh',  name: 'Whoosh',          emoji: '💨', desc: 'air swish — great per caption / transition' },
    { id: 'pop',     name: 'Pop',             emoji: '🫧', desc: 'soft bubble pop — per word / keyword' },
    { id: 'click',   name: 'Click',           emoji: '👆', desc: 'tight UI click — per word' },
    { id: 'shutter', name: 'Camera shutter',  emoji: '📸', desc: 'two-click shutter — per keyword' },
    { id: 'ding',    name: 'Ding',            emoji: '🔔', desc: 'bright bell — highlight a point' },
    { id: 'riser',   name: 'Riser (number grow)', emoji: '📈', desc: 'rising swell — numbers / reveals' },
    { id: 'tick',    name: 'Tick',            emoji: '⏱️', desc: 'counter tick — per number' },
    { id: 'thud',    name: 'Thud',            emoji: '🥁', desc: 'low impact — emphasis / drops' },
    { id: 'swoosh',  name: 'Swoosh',          emoji: '🌀', desc: 'pitched transition swipe' }
  ];

  function clamp(x) { return x < -1 ? -1 : (x > 1 ? 1 : x); }
  // gentle soft-clip (tanh-ish) — rounds peaks so nothing sounds harsh/digital
  function soft(x) { return x < -3 ? -1 : x > 3 ? 1 : x * (27 + x * x) / (27 + 9 * x * x); }

  // Raised-cosine fade in/out so the clip never starts/ends on a hard edge
  // (those discontinuities are the #1 cause of the "clicky/cheap" sound).
  function declick(a, sr, inMs, outMs) {
    var fi = Math.min(a.length >> 1, Math.floor((inMs || 4) / 1000 * sr));
    var fo = Math.min(a.length >> 1, Math.floor((outMs || 25) / 1000 * sr));
    for (var i = 0; i < fi; i++) a[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / fi);
    for (var j = 0; j < fo; j++) a[a.length - 1 - j] *= 0.5 - 0.5 * Math.cos(Math.PI * j / fo);
    return a;
  }
  // one-pole low-pass (coef 0..1; lower = darker) — tames harsh high end
  function lp1(a, coef) { var y = 0; for (var i = 0; i < a.length; i++) { y += coef * (a[i] - y); a[i] = y; } return a; }
  function softAll(a) { for (var i = 0; i < a.length; i++) a[i] = soft(a[i]); return a; }

  // ---- individual synths: each returns a Float32-ish Array of mono samples ----
  function synth(id, sr) {
    sr = sr || SR;
    var n, i, t, out, env, f, noise, ph;

    if (id === 'whoosh' || id === 'swoosh') {
      // band-passed moving noise = smooth "air", not hissy white noise
      var dur = 0.6; n = Math.floor(dur * sr); out = new Array(n);
      var yHi = 0, yLo = 0; var pitched = (id === 'swoosh'); ph = 0;
      for (i = 0; i < n; i++) {
        t = i / n;
        env = Math.sin(Math.PI * t); env *= env;                 // smooth bell
        var cHi = 0.10 + 0.22 * Math.sin(Math.PI * t);            // upper edge opens then closes
        var cLo = 0.015 + 0.05 * t;                               // lower edge drifts up
        noise = Math.random() * 2 - 1;
        yHi += cHi * (noise - yHi); yLo += cLo * (noise - yLo);
        var band = yHi - yLo;                                     // band-pass → airy
        var tone = 0;
        if (pitched) { f = 220 + 700 * t; ph += 2 * Math.PI * f / sr; tone = 0.3 * Math.sin(ph); }
        out[i] = (band * 1.7 + tone) * env * 0.7;
      }
      return declick(softAll(out), sr, 8, 40);
    }
    if (id === 'pop') {
      // pitch-dropping body + a tiny noise transient, then darkened
      var d1 = 0.16; n = Math.floor(d1 * sr); out = new Array(n); ph = 0;
      for (i = 0; i < n; i++) {
        t = i / sr; f = 440 * Math.pow(0.5, t * 5); ph += 2 * Math.PI * f / sr;
        env = Math.exp(-t * 26);
        var tr = (Math.random() * 2 - 1) * Math.exp(-t * 320) * 0.25;   // attack transient
        out[i] = (Math.sin(ph) * 0.85 + tr) * env;
      }
      lp1(out, 0.55); return declick(softAll(out), sr, 2, 30);
    }
    if (id === 'click') {
      var d2 = 0.04; n = Math.floor(d2 * sr); out = new Array(n); var yb = 0;
      for (i = 0; i < n; i++) {
        t = i / sr; env = Math.exp(-t * 150);
        noise = Math.random() * 2 - 1; yb += 0.45 * (noise - yb);       // band-ish click
        out[i] = (yb * 0.8 + Math.sin(2 * Math.PI * 1900 * t) * 0.2) * env;
      }
      return declick(softAll(out), sr, 1, 12);
    }
    if (id === 'tick') {
      var d3 = 0.05; n = Math.floor(d3 * sr); out = new Array(n); var yt = 0;
      for (i = 0; i < n; i++) {
        t = i / sr; env = Math.exp(-t * 110);
        noise = Math.random() * 2 - 1; yt += 0.6 * (noise - yt);
        out[i] = (Math.sin(2 * Math.PI * 1600 * t) * 0.6 + yt * 0.4) * env * 0.9;
      }
      return declick(softAll(out), sr, 1, 14);
    }
    if (id === 'shutter') {
      // two mechanical clicks ~60 ms apart, each band-passed + declicked
      var d4 = 0.18; n = Math.floor(d4 * sr); out = new Array(n);
      for (i = 0; i < n; i++) out[i] = 0;
      [[0, 1.0], [0.06, 0.8]].forEach(function (clk) {
        var s0 = Math.floor(clk[0] * sr), amp = clk[1], yb = 0, len = Math.floor(0.028 * sr);
        for (var k = 0; k < len && s0 + k < n; k++) {
          var tt = k / sr, e = Math.exp(-tt * 150);
          var nz = Math.random() * 2 - 1; yb += 0.5 * (nz - yb);
          // raised-cosine attack so each click is a soft "snick", not a digital spike
          var atk = k < 24 ? (0.5 - 0.5 * Math.cos(Math.PI * k / 24)) : 1;
          out[s0 + k] += (yb * 0.7 + Math.sin(2 * Math.PI * 2600 * tt) * 0.3) * e * atk * amp;
        }
      });
      return declick(softAll(out), sr, 1, 20);
    }
    if (id === 'ding') {
      // soft inharmonic bell: a few partials, gentle attack, long smooth decay
      var d5 = 0.6; n = Math.floor(d5 * sr); out = new Array(n);
      var parts = [[1, 1.0], [2.01, 0.45], [2.76, 0.2], [3.9, 0.08]], f0 = 988;
      for (i = 0; i < n; i++) {
        t = i / sr;
        var atkD = (t < 0.006) ? (t / 0.006) : 1;                 // 6 ms soft attack
        var s = 0;
        for (var pI = 0; pI < parts.length; pI++) s += Math.sin(2 * Math.PI * f0 * parts[pI][0] * t) * parts[pI][1] * Math.exp(-t * (5 + pI * 3));
        out[i] = s * 0.4 * atkD;
      }
      return declick(softAll(out), sr, 2, 60);
    }
    if (id === 'riser') {
      // rising band-passed noise + a faint octave-up tone, building to the end
      var d6 = 0.8; n = Math.floor(d6 * sr); out = new Array(n); var yH = 0, yL = 0; ph = 0;
      for (i = 0; i < n; i++) {
        t = i / n;
        var cH = 0.05 + 0.4 * t * t;                              // brightens as it rises
        noise = Math.random() * 2 - 1; yH += cH * (noise - yH); yL += 0.02 * (noise - yL);
        f = 300 + 1500 * t * t; ph += 2 * Math.PI * f / sr;
        env = t * t;                                              // swell in
        out[i] = ((yH - yL) * 1.4 + Math.sin(ph) * 0.3) * env * 0.7;
      }
      return declick(softAll(out), sr, 12, 30);
    }
    if (id === 'thud') {
      // low impact: pitch-dropping sine, soft-saturated, darkened
      var d7 = 0.3; n = Math.floor(d7 * sr); out = new Array(n); ph = 0;
      for (i = 0; i < n; i++) {
        t = i / sr; f = 95 * Math.pow(0.5, t * 3.5); ph += 2 * Math.PI * f / sr;
        env = Math.exp(-t * 9);
        out[i] = soft(Math.sin(ph) * 1.6) * env * 0.95;
      }
      lp1(out, 0.4); return declick(out, sr, 3, 40);
    }
    // unknown id → a short pop so we never return empty
    return synth('pop', sr);
  }

  // Encode mono float samples to a 16-bit PCM WAV (Uint8Array).
  function encodeWav(samples, sr) {
    sr = sr || SR;
    var n = samples.length, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    function str(o, s) { for (var j = 0; j < s.length; j++) dv.setUint8(o + j, s.charCodeAt(j)); }
    str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) { var s = clamp(samples[i]); dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true); }
    return new Uint8Array(buf);
  }

  // Render an SFX straight to WAV bytes, with optional gain (0–1) + sample rate.
  function renderWav(id, opts) {
    opts = opts || {};
    var sr = opts.sampleRate || SR;
    var s = synth(id, sr);
    var g = (opts.gain != null) ? opts.gain : 1;
    if (g !== 1) for (var i = 0; i < s.length; i++) s[i] = clamp(s[i] * g);
    return encodeWav(s, sr);
  }

  function getSfx(id) { for (var i = 0; i < SFX.length; i++) if (SFX[i].id === id) return SFX[i]; return SFX[0]; }

  return { SFX: SFX, synth: synth, encodeWav: encodeWav, renderWav: renderWav, getSfx: getSfx, SAMPLE_RATE: SR };
});
