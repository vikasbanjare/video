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

  // ---- individual synths: each returns a Float32-ish Array of mono samples ----
  function synth(id, sr) {
    sr = sr || SR;
    var n, i, t, out, env, f, lp, noise;

    if (id === 'whoosh' || id === 'swoosh') {
      var dur = 0.55; n = Math.floor(dur * sr); out = new Array(n); lp = 0;
      var pitched = (id === 'swoosh');
      for (i = 0; i < n; i++) {
        t = i / n;
        env = Math.sin(Math.PI * t); env *= env;          // smooth bell in/out
        var cutoff = 0.03 + 0.28 * Math.sin(Math.PI * t); // open then close the filter
        noise = Math.random() * 2 - 1;
        lp += cutoff * (noise - lp);                        // one-pole low-pass on noise
        var tone = pitched ? 0.35 * Math.sin(2 * Math.PI * (300 + 900 * t) * (i / sr)) : 0;
        out[i] = clamp((lp * 0.8 + tone) * env * 0.8);
      }
      return out;
    }
    if (id === 'pop') {
      var d1 = 0.13; n = Math.floor(d1 * sr); out = new Array(n);
      for (i = 0; i < n; i++) { t = i / sr; f = 520 * Math.pow(0.5, t * 7); env = Math.exp(-t * 34); out[i] = clamp(Math.sin(2 * Math.PI * f * t) * env * 0.85); }
      return out;
    }
    if (id === 'click') {
      var d2 = 0.035; n = Math.floor(d2 * sr); out = new Array(n);
      for (i = 0; i < n; i++) { t = i / sr; env = Math.exp(-t * 200); out[i] = clamp(((Math.random() * 2 - 1) * 0.6 + Math.sin(2 * Math.PI * 2200 * t) * 0.4) * env); }
      return out;
    }
    if (id === 'tick') {
      var d3 = 0.045; n = Math.floor(d3 * sr); out = new Array(n);
      for (i = 0; i < n; i++) { t = i / sr; env = Math.exp(-t * 130); out[i] = clamp(Math.sin(2 * Math.PI * 1800 * t) * env * 0.8); }
      return out;
    }
    if (id === 'shutter') {
      var d4 = 0.17; n = Math.floor(d4 * sr); out = new Array(n);
      for (i = 0; i < n; i++) out[i] = 0;
      // two mechanical clicks ~55 ms apart
      [0, 0.06].forEach(function (off) {
        var s0 = Math.floor(off * sr);
        for (var k = 0; k < Math.floor(0.03 * sr) && s0 + k < n; k++) {
          var tt = k / sr, e = Math.exp(-tt * 180);
          out[s0 + k] = clamp(out[s0 + k] + ((Math.random() * 2 - 1) * 0.7 + Math.sin(2 * Math.PI * 3000 * tt) * 0.3) * e);
        }
      });
      return out;
    }
    if (id === 'ding') {
      var d5 = 0.5; n = Math.floor(d5 * sr); out = new Array(n);
      for (i = 0; i < n; i++) {
        t = i / sr; env = Math.exp(-t * 6);
        out[i] = clamp((Math.sin(2 * Math.PI * 1245 * t) + 0.5 * Math.sin(2 * Math.PI * 2490 * t) + 0.25 * Math.sin(2 * Math.PI * 3735 * t)) * env * 0.5);
      }
      return out;
    }
    if (id === 'riser') {
      var d6 = 0.7; n = Math.floor(d6 * sr); out = new Array(n); lp = 0; var ph = 0;
      for (i = 0; i < n; i++) {
        t = i / n; f = 200 + 1000 * t * t;                  // accelerating pitch climb
        ph += 2 * Math.PI * f / sr;
        env = t * t;                                        // builds toward the end
        noise = Math.random() * 2 - 1; lp += 0.15 * (noise - lp);
        out[i] = clamp((Math.sin(ph) * 0.6 + lp * 0.5) * env * 0.85);
      }
      return out;
    }
    if (id === 'thud') {
      var d7 = 0.28; n = Math.floor(d7 * sr); out = new Array(n);
      for (i = 0; i < n; i++) { t = i / sr; f = 85 * Math.pow(0.5, t * 5); env = Math.exp(-t * 11); out[i] = clamp(Math.sin(2 * Math.PI * f * t) * env * 0.95); }
      return out;
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
