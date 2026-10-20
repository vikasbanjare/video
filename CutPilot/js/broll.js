/*
 * broll.js — 🎞 B-roll on keywords.
 *
 * The owner keeps a folder of B-roll named by what it shows ("money.mp4",
 * "stock-market.jpg", "पैसा.png"). Pulse reads the transcript and, where a
 * file's name is said, lays that picture over the video for a moment, on a
 * new video track at the top. Rules that keep it watchable: a gap between
 * two B-rolls, the same file not again within a minute, and every B-roll
 * filling the frame. Video B-roll goes in silent (its sound never reaches the
 * podcast): Pulse places a silent copy of its first seconds.
 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function K() { return window.CPKit || null; }

  var STILL = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i, MOVIE = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;
  var SKIP = { the: 1, a: 1, an: 1, of: 1, and: 1, in: 1, on: 1, to: 1, clip: 1, broll: 1, b: 1, roll: 1, stock: 1, video: 1, footage: 1,
               img: 1, image: 1, photo: 1, pic: 1, final: 1, copy: 1, new: 1, hd: 1, '4k': 1, mp4: 1, mov: 1 };

  function norm(t) { return String(t || '').toLowerCase().replace(/^[^a-z0-9ऀ-ॿ]+|[^a-z0-9ऀ-ॿ]+$/g, ''); }
  /* The words a file's name says, up to three ("MarketCrash_02.mp4" →
     ["market", "crash"]); filler words of B-roll names ("stock", "clip",
     "final", numbers) are left out. */
  function keywordsOf(name) {
    var base = String(name || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    base = base.replace(/([a-z])([A-Z])/g, '$1 $2');
    var out = [];
    base.split(/[^A-Za-z0-9ऀ-ॿ]+/).forEach(function (w) {
      w = norm(w);
      if (!w || SKIP[w] || /^\d+$/.test(w) || out.indexOf(w) >= 0) return;
      out.push(w);
    });
    return out.slice(0, 3);
  }
  function same(word, kw) {
    if (!word || !kw) return false;
    if (word === kw) return true;
    // a longer form of the word ("investing" for "invest", "paise" for "paisa" is not)
    if (kw.length >= 5 && word.indexOf(kw) === 0) return true;
    return word.length >= 5 && kw.indexOf(word) === 0;
  }
  /* Where each B-roll goes. words: [{text,start,end}] (sequence seconds);
     files: [{path, kws, still}]. o: {gap, reuse, dur}. → [{path, at, dur, still, word}] */
  function plan(words, files, o) {
    o = o || {};
    var gap = o.gap != null ? o.gap : 8, reuse = o.reuse != null ? o.reuse : 60, dur = o.dur || 2.5;
    var ws = (words || []).filter(function (w) { return w && String(w.text || '').trim(); })
      .map(function (w) { return { t: norm(w.text), start: +w.start }; }).sort(function (a, b) { return a.start - b.start; });
    var out = [], lastEnd = -Infinity, lastUse = {};
    for (var i = 0; i < ws.length; i++) {
      if (ws[i].start < lastEnd + gap) continue;
      for (var f = 0; f < files.length; f++) {
        var file = files[f], kws = file.kws || [];
        if (!kws.length || !same(ws[i].t, kws[0])) continue;
        // the rest of a two- or three-word name within the next few words
        var all = true;
        for (var k = 1; k < kws.length; k++) {
          var hit = false;
          for (var j = i + 1; j <= i + 4 && j < ws.length; j++) if (same(ws[j].t, kws[k])) { hit = true; break; }
          if (!hit) { all = false; break; }
        }
        if (!all) continue;
        if (lastUse[file.path] != null && ws[i].start - lastUse[file.path] < reuse) continue;
        out.push({ path: file.path, at: +ws[i].start.toFixed(3), dur: dur, still: !!file.still, word: ws[i].t });
        lastUse[file.path] = ws[i].start; lastEnd = ws[i].start + dur;
        break;
      }
    }
    return out;
  }

  function listFolder(dir) {
    var kit = K(), fs = kit.nodeReq('fs'), pathMod = kit.nodeReq('path');
    return fs.readdirSync(dir).filter(function (n) { return STILL.test(n) || MOVIE.test(n); }).map(function (n) {
      return { path: pathMod.join(dir, n), kws: keywordsOf(n), still: STILL.test(n) };
    }).filter(function (f) { return f.kws.length; });
  }

  function say(msg) { var r = $('br-result'); if (r) { r.textContent = msg; r.classList.remove('hidden'); } }
  function folder() { var k = K(); return (k && k.settings().brollDir) || ''; }
  function showFolder() {
    var el = $('br-folder'), d = folder();
    if (el) el.textContent = d ? d.split(/[\\/]/).pop() : 'no folder yet';
  }

  var busy = false;
  function run() {
    var kit = K(); if (!kit || busy) return;
    var dir = folder();
    if (!dir) return kit.toast('Pick your B-roll folder first.', true);
    var words = kit.words ? kit.words() : null;
    if (!words || !words.length) return kit.toast('B-roll follows your words — transcribe first.', true);
    var files;
    try { files = listFolder(dir); } catch (e) { return kit.toast('Could not read the B-roll folder — pick it again.', true); }
    if (!files.length) return kit.toast('No pictures or clips in that folder (name them by what they show, like money.mp4).', true);
    var items = plan(words, files, { dur: Number(($('br-dur') && $('br-dur').value) || 2.5) });
    if (!items.length) return say('None of your B-roll names is said in this video. Name files by the words you say (e.g. “paisa.jpg”, “stock-market.mp4”).');
    var ff = kit.resolveFfmpeg(), pathMod = kit.nodeReq('path'), os = kit.nodeReq('os'), fs = kit.nodeReq('fs');
    if (items.some(function (x) { return !x.still; }) && !ff) return kit.toast('Video B-roll needs the audio engine — Settings → ⬇️ Set up audio engine.', true);
    busy = true;
    // the silent copies the timeline links to: beside the captions (Pulse
    // Media), not the OS temp folder macOS clears
    var tmp = pathMod.join(os.tmpdir(), 'pulse-broll-' + Date.now());
    var where = window.CPMediaPlace ? window.CPMediaPlace().then(function (pl) { tmp = pathMod.join(pl.dir, 'broll-' + Date.now()); }, function () {}) : Promise.resolve();
    var silent = {}, dims = {}, i = 0;
    // each picture's size, so Premiere can fill the frame with it
    function probe(p) {
      if (!ff || dims[p]) return Promise.resolve();
      return kit.runFfmpeg(ff, ['-hide_banner', '-nostdin', '-i', p], 20000).then(function (r) {
        var m = /Video:[^\n]*?, (\d{2,5})x(\d{2,5})[ ,\[]/.exec(String(r.stderr || ''));
        if (m) dims[p] = { w: +m[1], h: +m[2] };
      });
    }
    function prep() {
      if (i >= items.length) return Promise.resolve();
      var it = items[i++];
      if (it.still) return probe(it.path).then(prep);
      if (silent[it.path]) return prep();
      kit.capProgress('🎞 Preparing B-roll ' + i + ' of ' + items.length + '…');
      var out = pathMod.join(tmp, 'b' + i + '-' + pathMod.basename(it.path).replace(/\.[^.]+$/, '') + '.mp4');
      // its first seconds, silent: its sound never lands on the podcast
      return kit.runFfmpeg(ff, ['-hide_banner', '-nostdin', '-y', '-i', it.path, '-t', String(it.dur + 0.5), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out], 120000)
        .then(function (r) { if (!r.error && r.code === 0) silent[it.path] = out; return probe(it.path); }).then(prep);
    }
    where.then(function () { try { fs.mkdirSync(tmp, { recursive: true }); } catch (eM) {} return prep(); }).then(function () {
      kit.capProgress('🎞 Laying B-roll on your timeline…');
      var put = items.filter(function (x) { return x.still || silent[x.path]; })
        .map(function (x) { var d = dims[x.path] || {}; return { path: x.still ? x.path : silent[x.path], at: x.at, dur: x.dur, still: x.still, w: d.w || 0, h: d.h || 0 }; });
      return CPBridge.callHost('CP_placeBroll', { items: put });
    }).then(function (r) {
      kit.capProgress(null);
      var msg = '🎞 ' + r.placed + ' B-roll' + (r.placed === 1 ? '' : 's') + ' on V' + r.track + ' where you say: ' +
        items.slice(0, 6).map(function (x) { return '“' + x.word + '”'; }).join(', ') + (items.length > 6 ? '…' : '') +
        '. Delete any you don’t like; ⌘Z undoes it.';
      say(msg); kit.toast(msg);
    }).catch(function (e) {
      kit.capProgress(null);
      var m = (e && e.message) || String(e); say('⚠️ ' + m); kit.toast(m, true);
    }).then(function () { busy = false; });
  }

  function pick() {
    var kit = K(); if (!kit) return;
    var d = kit.pickFolder ? kit.pickFolder('Your B-roll folder') : null;
    if (!d) return;
    kit.settings().brollDir = d; kit.saveSettings(); showFolder();
  }

  function wire() {
    showFolder();
    if ($('br-pick')) $('br-pick').addEventListener('click', pick);
    if ($('btn-broll-add')) $('btn-broll-add').addEventListener('click', run);
  }

  window.CPBroll = { keywordsOf: keywordsOf, plan: plan, run: run };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
