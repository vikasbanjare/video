/*
 * studio.js — 🎚 Studio sound: one tap makes a podcast sound finished.
 *
 * Each recording on the timeline is cleaned by the audio engine (ffmpeg):
 * rumble and mains hum taken out, steady background noise lowered, the voice
 * evened out, and the loudness set for where the video goes (YouTube and
 * Reels −14 LUFS, podcast apps −16). Each mic is set to the same level, so a
 * quiet guest comes up to the host. The cleaned copy is laid on new audio
 * tracks exactly where the original pieces play, and the original tracks are
 * muted — never deleted: unmute them to compare or to go back.
 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function K() { return window.CPKit || null; }

  /* The engine's recipe, as one ffmpeg filter chain. Pure (gates read it).
     What a speech enhancer (Adobe Podcast's kind) audibly does, done on this
     computer: noise down, the voice balanced word by word, a clear and
     present tone, soft "s" sounds, and the loudness set.
     o: { noise, hum, level, clarity, target (LUFS), mics (how many voices) } */
  function filterChain(o) {
    o = o || {};
    var parts = ['highpass=f=70'];                       // rumble, desk knocks, AC
    if (o.hum !== false) {
      // mains hum and its first harmonics, 50 Hz (India) and 60 Hz, narrow notches
      [50, 100, 150, 60, 120, 180].forEach(function (f) { parts.push('bandreject=f=' + f + ':width_type=q:w=30'); });
    }
    if (o.noise !== false) parts.push('afftdn=nr=12:nf=-35:tn=1');   // steady hiss / fan / room tone
    if (o.clarity !== false) {
      // a clear, present voice: less mud and boom, more presence, gentler "s"
      parts.push('equalizer=f=250:t=q:w=1:g=-3', 'equalizer=f=3500:t=q:w=1.2:g=3');
      if (!o.legacy) parts.push('deesser=i=0.4:m=0.5:f=0.5');
    }
    // balance: quiet words lifted, loud ones held, as the person talks (a
    // speech leveller, not one level for the whole file)
    // (an older audio engine without the speech leveller: a gentle compressor)
    if (o.level !== false) parts.push(o.legacy ? 'acompressor=threshold=0.1:ratio=3:attack=15:release=200:makeup=1' : 'speechnorm=e=6.25:r=0.00001:l=1');
    // two or more mics play together: each a little lower, so the mix lands on target
    var target = (o.target != null ? Number(o.target) : -14) - ((o.mics || 1) > 1 ? 3 : 0);
    parts.push('loudnorm=I=' + target + ':TP=-1.5:LRA=11');
    return parts.join(',');
  }

  /* The pieces of audio that play, from Pulse's read of the timeline
     (CP_getCutSources): unmuted tracks, real files, normal speed. */
  function piecesOf(src) {
    var out = [], skipped = 0, seenTrack = {};
    (src && src.audio || []).forEach(function (tr) {
      if (seenTrack[tr.index]) return;                   // a nest's inner tracks: its own clip is enough
      seenTrack[tr.index] = 1;
      if (tr.muted) return;
      (tr.items || []).forEach(function (it) {
        if (!it.mediaPath || it.disabled) return;
        if (it.reversed || Math.abs((it.speed || 1) - 1) > 0.001) { skipped++; return; }
        out.push({ src: it.mediaPath, from: it.inPoint, dur: it.seqEnd - it.seqStart, at: it.seqStart, track: tr.index });
      });
    });
    return { pieces: out, skipped: skipped };
  }

  var busy = false;
  function readOpts() {
    var on = document.querySelector('#ss-target button.on');
    return {
      noise: !$('ss-noise') || $('ss-noise').checked,
      hum: !$('ss-hum') || $('ss-hum').checked,
      level: !$('ss-level') || $('ss-level').checked,
      clarity: !$('ss-clarity') || $('ss-clarity').checked,
      target: on ? Number(on.getAttribute('data-lufs')) : -14
    };
  }
  function say(msg) { var r = $('ss-result'); if (r) { r.textContent = msg; r.classList.remove('hidden'); } }

  function run() {
    var kit = K();
    if (!kit) return;
    if (busy) return kit.toast('Studio sound is already working…');
    if (!(window.CPBridge && CPBridge.isCEP && CPBridge.isCEP())) return kit.toast('Studio sound needs Pulse inside Premiere.', true);
    var ff = kit.resolveFfmpeg();
    if (!ff) return kit.toast('Studio sound needs the audio engine — Settings → ⬇️ Set up audio engine, then tap again.', true);
    var fs, pathMod, os;
    try { fs = kit.nodeReq('fs'); pathMod = kit.nodeReq('path'); os = kit.nodeReq('os'); } catch (e) { return kit.toast('Node unavailable in this panel.', true); }
    var opts = readOpts();
    busy = true;
    var btn = $('btn-studio-sound'); if (btn) btn.disabled = true;
    kit.capProgress('🎚 Reading your timeline…');
    var found;
    CPBridge.callHost('CP_getCutSources', {}).then(function (src) {
      found = piecesOf(src);
      if (!found.pieces.length) throw new Error('No sound to clean on this sequence — every audio track is empty or muted.');
      var files = [], seen = {};
      found.pieces.forEach(function (p) { if (!seen[p.src]) { seen[p.src] = 1; files.push(p.src); } });
      var mics = {}; found.pieces.forEach(function (p) { mics[p.track] = 1; });
      opts.mics = Object.keys(mics).length;
      var dir = pathMod.join(os.homedir(), 'Documents', 'Pulse', 'Studio Sound');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (eMk) {}
      var stamp = Date.now().toString(36), cleanOf = {}, i = 0;
      var chain = filterChain(opts);
      function next() {
        if (i >= files.length) return Promise.resolve();
        var f = files[i++], base = pathMod.basename(f).replace(/\.[^.]+$/, '');
        var out = pathMod.join(dir, base + '-studio-' + stamp + '.wav');
        kit.capProgress('🎚 Cleaning the sound — ' + i + ' of ' + files.length + ': ' + pathMod.basename(f), 60000);
        function once(ch) { return kit.runFfmpeg(ff, ['-hide_banner', '-nostdin', '-y', '-i', f, '-vn', '-af', ch, '-ar', '48000', '-c:a', 'pcm_s24le', out], 45 * 60 * 1000); }
        return once(chain).then(function (r) {
          // an older audio engine that lacks a filter: the simpler recipe
          if (r && r.code !== 0 && /No such filter|Filter not found/i.test(String(r.stderr || ''))) {
            var lo = {}, k; for (k in opts) if (opts.hasOwnProperty(k)) lo[k] = opts[k];
            lo.legacy = true; chain = filterChain(lo);
            return once(chain);
          }
          return r;
        })
          .then(function (r) {
            var size = 0; try { size = fs.statSync(out).size; } catch (eS) {}
            if (r.error || r.code !== 0 || !size) {
              var why = r.timedOut ? 'it took too long' : (String(r.error || r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || 'the audio engine stopped');
              throw new Error('Pulse could not clean “' + pathMod.basename(f) + '” (' + why + '). Nothing on your timeline was changed.');
            }
            cleanOf[f] = out;
            return next();
          });
      }
      return next().then(function () {
        kit.capProgress('🎚 Putting the clean sound on your timeline…');
        return CPBridge.callHost('CP_studioSoundPlace', {
          pieces: found.pieces.map(function (p) { return { path: cleanOf[p.src], from: p.from, dur: p.dur, at: p.at, track: p.track }; })
        });
      });
    }).then(function (r) {
      kit.capProgress(null);
      var msg = '🎚 Studio sound on ' + (r.tracks || []).map(function (n) { return 'A' + n; }).join(', ') +
        ' (' + r.placed + ' piece' + (r.placed === 1 ? '' : 's') + ', ' + (opts.target === -16 ? 'podcast apps, −16 LUFS' : 'YouTube & Reels, −14 LUFS') + '). ' +
        'Your original sound is still there, muted' + ((r.muted || []).length ? ' (' + r.muted.map(function (n) { return 'A' + n; }).join(', ') + ')' : '') +
        ' — unmute it to compare.' + (found.skipped ? ' ' + found.skipped + ' sped-up or reversed piece(s) were left as they are.' : '') +
        (r.missed ? ' ' + r.missed + ' piece(s) could not be placed.' : '');
      say(msg); kit.toast(msg);
      try { window.dispatchEvent(new Event('pulse:sound-changed')); } catch (eEv) {}
    }).catch(function (e) {
      kit.capProgress(null);
      var m = (e && e.message) || String(e);
      say('⚠️ ' + m); kit.toast(m, true);
    }).then(function () { busy = false; if (btn) btn.disabled = false; });
  }

  function wire() {
    var seg = $('ss-target');
    if (seg) seg.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('button'); if (!b) return;
      var on = seg.querySelector('button.on'); if (on) on.classList.remove('on'); b.classList.add('on');
    });
    if ($('btn-studio-sound')) $('btn-studio-sound').addEventListener('click', run);
  }

  window.CPStudio = { filterChain: filterChain, piecesOf: piecesOf, run: run };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
