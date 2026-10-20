/*
 * publish.js — 📣 Publish kit: everything to paste when uploading.
 *
 * From the transcript (and the chapters, when made), the AI writes three
 * title options, a description with the chapters in it, hashtags, tags and a
 * pinned comment — in the language the video is spoken in (Hinglish stays
 * Hinglish). Each part has its own Copy button.
 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function K() { return window.CPKit || null; }

  /* The words, short enough for one AI call: every line when they fit, else
     evenly spread lines from the whole video (never just the start). */
  function digest(cues, maxChars) {
    maxChars = maxChars || 12000;
    var lines = (cues || []).map(function (c) { return String(c.text || '').replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    var all = lines.join('\n');
    if (all.length <= maxChars) return all;
    var avg = all.length / lines.length, keep = Math.max(1, Math.floor(maxChars / avg)), step = lines.length / keep, out = [];
    for (var i = 0; i < keep; i++) out.push(lines[Math.floor(i * step)]);
    return out.join('\n');
  }

  function prompt(cues, chapters, kind) {
    return {
      system: 'You write YouTube / Instagram publishing text for an Indian creator. Write in the SAME language and script the ' +
        'transcript is spoken in (Hinglish in English letters stays Hinglish; Hindi in Devanagari stays Hindi). No clickbait lies: ' +
        'every title must be true to the video. Answer with JSON only: {"titles":[3 strings, each under 70 characters],' +
        '"description":"2–4 short paragraphs, no chapters, no hashtags","hashtags":[5–8 strings starting with #],' +
        '"tags":[10–15 search keywords],"pinned":"one friendly pinned comment that asks viewers a question about the topic"}',
      user: 'This is a ' + (kind === 'short' ? 'short vertical reel' : 'long video / podcast') + '.' +
        (chapters ? '\nIts chapters:\n' + chapters : '') + '\nTranscript:\n' + digest(cues)
    };
  }

  /* The AI's reply (text, maybe wrapped in prose or ```), as an object. */
  function parseReply(c) {
    if (c && typeof c === 'object') return c;
    var s = String(c || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }
  /* The AI's answer, made safe to show: right types, sensible counts. */
  function normalize(r) {
    r = parseReply(r) || {};
    function strs(a, n) { return (Array.isArray(a) ? a : []).map(function (x) { return String(x || '').trim(); }).filter(Boolean).slice(0, n); }
    var tags = strs(r.hashtags, 8).map(function (h) { h = h.replace(/\s+/g, ''); return h.charAt(0) === '#' ? h : '#' + h; });
    return { titles: strs(r.titles, 3), description: String(r.description || '').trim(), hashtags: tags,
             tags: strs(r.tags, 15), pinned: String(r.pinned || '').trim() };
  }

  /* The full description to paste: the AI's text, the chapters, the hashtags. */
  function fullDescription(kit, chapters) {
    var parts = [kit.description];
    if (chapters) parts.push('Chapters\n' + chapters);
    if (kit.hashtags.length) parts.push(kit.hashtags.join(' '));
    return parts.filter(Boolean).join('\n\n');
  }

  function chaptersText() {
    var res = $('ch-results'), out = $('ch-out');
    if (!out || !res || res.classList.contains('hidden')) return '';
    return String(out.textContent || '').trim();
  }

  function copy(text) {
    var kit = K();
    try {
      var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      if (kit) kit.toast('⧉ Copied.');
    } catch (e) { if (kit) kit.toast('Could not copy — select the text and copy it yourself.', true); }
  }

  function show(kit, chapters) {
    var box = $('pk-out'); if (!box) return;
    box.innerHTML = '';
    function block(title, text, multi) {
      var wrap = document.createElement('div'); wrap.className = 'pk-block';
      var head = document.createElement('div'); head.className = 'pk-head';
      var t = document.createElement('span'); t.className = 'field-label'; t.textContent = title; head.appendChild(t);
      var b = document.createElement('button'); b.type = 'button'; b.className = 'chip-btn'; b.textContent = 'Copy';
      b.addEventListener('click', function () { copy(text); }); head.appendChild(b);
      wrap.appendChild(head);
      var pre = document.createElement(multi ? 'pre' : 'p'); pre.className = multi ? 'diag-out' : 'pk-line'; pre.textContent = text;
      wrap.appendChild(pre);
      box.appendChild(wrap);
    }
    kit.titles.forEach(function (tt, i) { block('Title ' + (i + 1), tt, false); });
    block('Description', fullDescription(kit, chapters), true);
    if (kit.pinned) block('Pinned comment', kit.pinned, false);
    if (kit.tags.length) block('Tags', kit.tags.join(', '), false);
    box.classList.remove('hidden');
  }

  var busy = false;
  function run() {
    var kit = K(); if (!kit) return;
    if (busy) return;
    var cues;
    try { cues = kit.readTranscript(); } catch (e) { return kit.toast(e.message, true); }
    var chapters = chaptersText();
    var kind = (kit.env() && kit.env().height > kit.env().width) ? 'short' : 'long';
    busy = true;
    var btn = $('btn-pk-make'); if (btn) btn.disabled = true;
    var st = $('pk-status'); if (st) { st.textContent = 'Writing your titles and description…'; st.classList.remove('hidden'); }
    kit.aiChat(prompt(cues, chapters, kind), { json: true, maxTokens: 2500 }).then(function (r) {
      var k = normalize(r);
      if (!k.titles.length && !k.description) throw new Error('The AI sent nothing usable — tap again.');
      show(k, chapters);
      if (st) st.textContent = chapters ? 'Ready — your chapters are in the description.' : 'Ready. Tip: make chapters above first and they go into the description too.';
    }).catch(function (e) {
      if (st) st.textContent = '⚠️ ' + ((e && e.message) || e);
      kit.toast((e && e.message) || String(e), true);
    }).then(function () { busy = false; if (btn) btn.disabled = false; });
  }

  function wire() { if ($('btn-pk-make')) $('btn-pk-make').addEventListener('click', run); }
  window.CPPublish = { digest: digest, prompt: prompt, parseReply: parseReply, normalize: normalize, fullDescription: fullDescription, run: run };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
