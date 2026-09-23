/*
 * Pulse — verbatim transcription (for retake removal).
 *
 * Groq's Whisper produces a CLEAN "intended" transcript — it drops/merges
 * repeated re-reads by design, so the retakes the editor needs to find aren't
 * even in the text. This module talks to a VERBATIM engine that keeps every
 * take + filler with a per-word confidence:
 *   - Deepgram  (one POST: ?filler_words=true&punctuate=true)
 *   - AssemblyAI (upload → submit disfluencies=true → poll)
 * Pure request-builders + response parsers (DOM/Node-free, unit-tested); the
 * actual curl/upload/poll lives in main.js. Every parser returns the same shape:
 *   [{ text, start, end, conf }]  (seconds; conf 0..1)
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPVerbatim = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // ----------------------------------------------------------- Deepgram ----
  /* The panel's language choice → Deepgram's language parameter. Deepgram
     does NOT auto-detect when the parameter is missing: it assumes English,
     so Hindi speech came back as English-sounding nonsense. nova-3's "multi"
     model understands Hindi and English mixed in one sentence (the owner's
     Hinglish), so Auto-detect and Hinglish both send language=multi; a
     language picked explicitly is sent as is (a Sarvam-style "hi-IN" → "hi"). */
  function deepgramLanguage(ui) {
    var l = String(ui == null ? '' : ui).trim();
    if (!l || l === 'auto' || l === 'hinglish' || l === 'multi' || l === 'unknown') return 'multi';
    if (/^[a-z]{2,3}-[A-Z]{2}$/.test(l) && !/^(en|pt|zh|es|fr|de|nl)-/.test(l)) return l.split('-')[0];
    return l;
  }
  /* Listen URL — nova-3 keeps every utterance; filler_words keeps um/uh; word
     timings + confidence come standard. opts:{model,language,diarize}.
     opts.language is the panel's choice (mapped by deepgramLanguage);
     diarize asks for a speaker label on every word, which the retake finder
     uses so one person echoing another is never taken for a retake. */
  function deepgramUrl(opts) {
    opts = opts || {};
    var q = [
      'model=' + (opts.model || 'nova-3'),
      'smart_format=true', 'punctuate=true', 'filler_words=true', 'utterances=true'
    ];
    if (opts.language) q.push('language=' + encodeURIComponent(deepgramLanguage(opts.language)));
    if (opts.diarize) q.push('diarize=true');
    return 'https://api.deepgram.com/v1/listen?' + q.join('&');
  }
  /* Deepgram JSON → words. Prefers the punctuated_word form when present. */
  function parseDeepgram(json) {
    var out = [];
    try {
      var alts = json.results.channels[0].alternatives;
      var words = (alts && alts[0] && alts[0].words) || [];
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        var t = (w.punctuated_word != null ? w.punctuated_word : w.word);
        if (t == null) continue; t = String(t).trim(); if (!t) continue;
        var o = { text: t, start: +w.start || 0, end: +w.end || 0, conf: (w.confidence != null ? +w.confidence : null) };
        if (w.speaker != null) o.speaker = w.speaker;          // diarize=true
        out.push(o);
      }
    } catch (e) {}
    return out;
  }

  // --------------------------------------------------------- AssemblyAI ----
  /* Body for POST /v2/transcript — disfluencies keeps um/uh + false starts.
     AssemblyAI assumes English (en_us) when no language is given, so the
     panel's choice is always sent: Hindi and Hinglish → "hi", Auto-detect →
     language_detection, anything else as picked. opts:{language,
     speakerLabels, disfluencies (default true)}. */
  function assemblySubmitBody(audioUrl, opts) {
    opts = opts || {};
    var b = { audio_url: audioUrl, disfluencies: opts.disfluencies !== false, punctuate: true, format_text: true };
    var l = String(opts.language == null ? '' : opts.language).trim();
    if (l === 'hinglish') l = 'hi';
    if (/^[a-z]{2,3}-[A-Z]{2}$/.test(l)) l = l.split('-')[0];
    if (l === 'auto' || l === 'multi' || l === 'unknown') b.language_detection = true;
    else if (l) b.language_code = l;
    if (opts.speakerLabels) b.speaker_labels = true;
    return b;
  }
  /* AssemblyAI completed-transcript JSON → words (start/end are MILLISECONDS). */
  function parseAssembly(json) {
    var out = [];
    try {
      var words = json.words || [];
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        var t = (w.text != null) ? String(w.text).trim() : '';
        if (!t) continue;
        var o = { text: t, start: (+w.start || 0) / 1000, end: (+w.end || 0) / 1000, conf: (w.confidence != null ? +w.confidence : null) };
        if (w.speaker != null) o.speaker = w.speaker;          // speaker_labels:true
        out.push(o);
      }
    } catch (e) {}
    return out;
  }

  // ------------------------------------------------ the timeline's voices ----
  /* A verbatim transcript must hear EVERY voice on the timeline. The old path
     read one clip: on a two-mic podcast the other person's words (and their
     retakes) were never transcribed, and on a timeline already cut into
     pieces only the first piece was. These build ONE mono mix of every live
     audio track, each piece placed at its own timeline position (in point,
     speed and direction honoured), so a word at t seconds in the mix was said
     at span.start + t on the timeline. Each file is mixed at its own recorded
     level: Premiere's clip and track volumes are not known to the panel —
     which suits voices (a quiet mic is heard as well as a loud one), and is
     why the panel leaves a music bed out (opts.leaveOut) instead of mixing it
     in at full level.
       src = CP_getCutSources(): { audio:[{ muted, items:[{ mediaPath, seqStart,
             seqEnd, inPoint, outPoint, speed, reversed, disabled }] }], selection }
       opts.leaveOut = { mediaPath: reason } — files not to hear (offline, no
             sound, steady music or noise)
     Returns null when there is nothing to hear. */
  var NOT_AUDIO = /\.(aegraphic|mogrt|prproj|psd|ai|png|jpe?g|gif|tiff?|svg|eps|bmp|webp|heic)$/i;
  function r6(x) { return Math.round(x * 1e6) / 1e6; }
  function timelineMixPlan(src, opts) {
    var leave = (opts && opts.leaveOut) || {};
    var items = [], lo = Infinity, hi = -Infinity, i;
    ((src && src.audio) || []).forEach(function (t, ti) {
      if (!t || t.muted) return;                                    // a muted track is not heard
      (t.items || []).forEach(function (it) {
        if (!it || it.disabled || !it.mediaPath || NOT_AUDIO.test(String(it.mediaPath))) return;
        if (Object.prototype.hasOwnProperty.call(leave, String(it.mediaPath))) return;
        var s = +it.seqStart, e = +it.seqEnd, a = +it.inPoint || 0, b = +it.outPoint || 0, sp = +it.speed;
        if (!(e - s > 0.05)) return;
        if (!(sp > 0)) sp = (b > a) ? (b - a) / (e - s) : 1;
        if (!(b > a)) b = a + (e - s) * sp;
        items.push({ track: ti, path: String(it.mediaPath), seqStart: s, seqEnd: e, from: a, to: b, speed: sp, reversed: !!it.reversed });
        lo = Math.min(lo, s); hi = Math.max(hi, e);
      });
    });
    var sel = src && src.selection;
    if (sel && +sel.end > +sel.start) { lo = Math.max(lo, +sel.start); hi = Math.min(hi, +sel.end); }   // the owner's selected span only
    if (!items.length || !(hi - lo > 0.05)) return null;
    var pieces = [];
    items.forEach(function (x) {
      var s = Math.max(x.seqStart, lo), e = Math.min(x.seqEnd, hi);
      if (!(e - s > 0.02)) return;
      // media time of timeline time t: from + (t - seqStart)·speed, or counted
      // back from `to` when the clip plays reversed
      var a = x.reversed ? x.to - (e - x.seqStart) * x.speed : x.from + (s - x.seqStart) * x.speed;
      var b = x.reversed ? x.to - (s - x.seqStart) * x.speed : x.from + (e - x.seqStart) * x.speed;
      pieces.push({ track: x.track, path: x.path, seqStart: s, seqEnd: e, from: a, to: b, speed: x.speed, reversed: x.reversed, streams: 1 });
    });
    // one recording at the same place on two tracks — a stereo pair split in
    // two, or the second audio stream of a multi-track file — is read once,
    // with all its streams
    var kept = [];
    pieces.forEach(function (p) {
      for (var k = 0; k < kept.length; k++) {
        var q = kept[k];
        if (q.path === p.path && Math.abs(q.seqStart - p.seqStart) < 0.01 && Math.abs(q.from - p.from) < 0.01 &&
            Math.abs(q.speed - p.speed) < 1e-3 && q.reversed === p.reversed) { q.streams++; return; }
      }
      kept.push(p);
    });
    var inputs = [], at = {};
    kept.forEach(function (p) {
      if (at[p.path] == null) { at[p.path] = inputs.length; inputs.push({ path: p.path, from: p.from, to: p.to, streams: 1 }); }
      var inp = inputs[at[p.path]];
      inp.from = Math.min(inp.from, p.from); inp.to = Math.max(inp.to, p.to); inp.streams = Math.max(inp.streams, p.streams);
      p.input = at[p.path];
    });
    // decode only the part of each file the timeline uses (+ half a second)
    for (i = 0; i < inputs.length; i++) { inputs[i].from = Math.max(0, inputs[i].from - 0.5); inputs[i].to += 0.5; }
    var byTrack = {}, order = [];
    kept.forEach(function (p) { if (!byTrack[p.track]) { byTrack[p.track] = []; order.push(p.track); } byTrack[p.track].push(p); });
    order.sort(function (a, b) { return a - b; });
    return {
      span: { start: lo, end: hi },
      inputs: inputs,
      tracks: order.map(function (t) { return byTrack[t].sort(function (a, b) { return a.seqStart - b.seqStart; }); })
    };
  }

  function tempo(sp) {
    if (!(sp > 0) || Math.abs(sp - 1) < 1e-4) return '';
    var out = [];
    while (sp > 2) { out.push('atempo=2'); sp /= 2; }          // older ffmpeg: 0.5 … 2 per atempo
    while (sp < 0.5) { out.push('atempo=0.5'); sp /= 0.5; }
    out.push('atempo=' + r6(sp));
    return ',' + out.join(',');
  }
  /* The ffmpeg filter graph for a timelineMixPlan: every track laid out on the
     timeline (silence in its gaps, each piece trimmed from its file, sped /
     reversed as it plays) and the tracks mixed to [mix]. opts.oneStream reads
     only each file's first audio stream (the retry when a file has fewer
     streams than tracks). */
  function mixFilterGraph(plan, opts) {
    opts = opts || {};
    var R = opts.rate || 16000;
    var FMT = 'aformat=sample_fmts=fltp:sample_rates=' + R + ':channel_layouts=mono';
    var tracks = [], uses = [], k;
    plan.tracks.forEach(function (tr) {
      var segs = [], cur = plan.span.start;
      tr.forEach(function (p) {
        var s = Math.max(p.seqStart, cur), a = p.from, b = p.to;
        if (s > p.seqStart) { if (p.reversed) b -= (s - p.seqStart) * p.speed; else a += (s - p.seqStart) * p.speed; }
        if (!(p.seqEnd - s > 0.002) || !(b - a > 0.001)) return;
        if (s - cur > 0.0005) segs.push({ gap: s - cur });
        segs.push({ p: p, a: a - plan.inputs[p.input].from, b: b - plan.inputs[p.input].from });
        uses[p.input] = (uses[p.input] || 0) + 1;
        cur = p.seqEnd;
      });
      if (plan.span.end - cur > 0.0005) segs.push({ gap: plan.span.end - cur });
      if (segs.length) tracks.push(segs);
    });
    var g = [], label = {}, taken = {};
    for (k = 0; k < plan.inputs.length; k++) {
      if (!uses[k]) continue;
      var S = opts.oneStream ? 1 : Math.max(1, plan.inputs[k].streams || 1), head = '', outs = '', s;
      if (S > 1) { for (s = 0; s < S; s++) head += '[' + k + ':a:' + s + ']'; head += 'amix=inputs=' + S + ':duration=longest:dropout_transition=0,'; }
      else head = '[' + k + ':a:0]';
      label[k] = []; taken[k] = 0;
      for (s = 0; s < uses[k]; s++) { label[k].push('in' + k + '_' + s); outs += '[in' + k + '_' + s + ']'; }
      g.push(head + FMT + (uses[k] > 1 ? ',asplit=' + uses[k] : '') + outs);
    }
    var n = 0, tOut = [];
    tracks.forEach(function (segs, ti) {
      var ins = '';
      segs.forEach(function (sg) {
        var l = 's' + (n++);
        if (sg.gap != null) g.push('anullsrc=r=' + R + ':cl=mono,atrim=duration=' + r6(sg.gap) + ',' + FMT + '[' + l + ']');
        else {
          var p = sg.p;
          g.push('[' + label[p.input][taken[p.input]++] + ']atrim=start=' + r6(sg.a) + ':end=' + r6(sg.b) + ',asetpts=PTS-STARTPTS' +
                 (p.reversed ? ',areverse' : '') + tempo(p.speed) + ',' + FMT + '[' + l + ']');
        }
        ins += '[' + l + ']';
      });
      g.push(ins + (segs.length > 1 ? 'concat=n=' + segs.length + ':v=0:a=1' : 'anull') + '[t' + ti + ']');
      tOut.push('[t' + ti + ']');
    });
    g.push(tOut.join('') + (tOut.length > 1 ? 'amix=inputs=' + tOut.length + ':duration=longest:dropout_transition=0' : 'anull') + '[mix]');
    return g.join(';\n');
  }
  /* ffmpeg arguments that write the mix to `out` (mono mp3, 16 kHz). With
     opts.graphFile the graph is read from that file (opts.graphFlag, default
     -filter_complex_script) — a long timeline's graph would not fit on a
     Windows command line. */
  function mixFfmpegArgs(plan, out, opts) {
    opts = opts || {};
    var args = ['-y', '-hide_banner', '-nostats'];
    plan.inputs.forEach(function (inp) { args.push('-ss', String(r6(inp.from)), '-t', String(r6(inp.to - inp.from)), '-i', inp.path); });
    if (opts.graphFile) args.push(opts.graphFlag || '-filter_complex_script', opts.graphFile);
    else args.push('-filter_complex', mixFilterGraph(plan, opts));
    return args.concat(['-map', '[mix]', '-ac', '1', '-ar', String(opts.rate || 16000), '-b:a', '64k', out]);
  }

  /* Group a word stream into sentence-ish cues (so the rest of the pipeline,
     which expects {text,start,end}, can use a verbatim transcript). Splits on
     sentence punctuation or a pause > gap. */
  function wordsToCues(words, gap) {
    gap = (gap != null) ? gap : 0.7;
    var cues = [], cur = [];
    for (var i = 0; i < (words || []).length; i++) {
      cur.push(words[i]);
      var endsSentence = /[.!?।॥۔؟…]["'”’)\]]*$/.test(words[i].text);   // incl. the Hindi full stop "।"
      var g = (i + 1 < words.length) ? (words[i + 1].start - words[i].end) : 99;
      if (endsSentence || g > gap || cur.length >= 16) {
        cues.push({ text: cur.map(function (x) { return x.text; }).join(' '), start: cur[0].start, end: cur[cur.length - 1].end });
        cur = [];
      }
    }
    if (cur.length) cues.push({ text: cur.map(function (x) { return x.text; }).join(' '), start: cur[0].start, end: cur[cur.length - 1].end });
    return cues;
  }

  return {
    deepgramLanguage: deepgramLanguage,
    deepgramUrl: deepgramUrl,
    parseDeepgram: parseDeepgram,
    assemblySubmitBody: assemblySubmitBody,
    parseAssembly: parseAssembly,
    timelineMixPlan: timelineMixPlan,
    mixFilterGraph: mixFilterGraph,
    mixFfmpegArgs: mixFfmpegArgs,
    wordsToCues: wordsToCues
  };
});
