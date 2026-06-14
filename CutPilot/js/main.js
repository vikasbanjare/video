/*
 * CutPilot — panel controller (v0.2, automated flow).
 * Captions: auto-found transcripts → visual style + animation pickers →
 * one button. The built-in render engine draws every caption frame to a
 * transparent PNG and the host keyframes the entry animation — no MOGRTs,
 * no manual files. SRT management lives under Advanced.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------- state ----
  var state = {
    env: null,
    clip: null,
    silencesSeq: [],
    keepsMedia: [],
    keepsSeq: [],
    plan: null,
    transcript: null,        // { label, path } — the one chosen transcript
    presetId: 'hormozi',
    animId: 'pop',
    mcMode: 'rotate',
    tplSource: 'installed',  // installed | file
    installedMogrts: [],
    mogrtFile: null,
    // multicam
    mcAudioTracks: null,
    mcAudioEnd: 0,
    mcMap: null,
    // mogrt gallery
    userMogrts: [],
    selectedMogrt: null,
    mogrtWords: 0,   // words per MOGRT graphic (0 = full line)
    // template library
    customTemplates: [],
    favs: {},
    recent: [],
    libCategory: 'All',
    libSearch: '',
    libSort: 'popular'
  };

  var settings = loadSettings();
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem('cutpilot.settings')) || {}; }
    catch (e) { return {}; }
  }
  function saveSettings() {
    localStorage.setItem('cutpilot.settings', JSON.stringify(settings));
  }

  // ---------------------------------------------------------------- dom ----
  function $(id) { return document.getElementById(id); }

  function log(msg, cls) {
    var el = document.createElement('div');
    if (cls) el.className = cls;
    el.textContent = msg;
    $('log').appendChild(el);
    $('log').parentNode.scrollTop = 1e9;
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 4500);
    log(msg, isErr ? 'err' : 'ok');
  }

  function fmt(sec) {
    var m = Math.floor(sec / 60);
    var s = (sec - m * 60).toFixed(2);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function nodeReq(mod) {
    var req = (typeof cep_node !== 'undefined' && cep_node.require) || window.require;
    return req(mod);
  }

  /* Find an ffmpeg binary: the user's setting first, then common install
     locations. ffmpeg is what lets us read audio inside video files (Web
     Audio can't), so multicam/Smart-Cut work on real footage. Cached. */
  var _ffmpeg = null;
  function resolveFfmpeg() {
    if (_ffmpeg) return _ffmpeg;            // cache only a positive result
    var fs;
    try { fs = nodeReq('fs'); } catch (e) { return (settings.ffmpegPath || null); }
    var tryPath = function (p) { try { return p && fs.existsSync(p); } catch (e2) { return false; } };
    if (tryPath(settings.ffmpegPath)) return (_ffmpeg = settings.ffmpegPath);
    var cands = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg',
                 '/opt/local/bin/ffmpeg', '/snap/bin/ffmpeg', '/Applications/ffmpeg',
                 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'];
    for (var i = 0; i < cands.length; i++) if (tryPath(cands[i])) return (_ffmpeg = cands[i]);
    return null;  // not found — re-probe next call (picks up a fresh install)
  }

  function pickFile(title, exts) {
    if (window.cep && window.cep.fs && window.cep.fs.showOpenDialogEx) {
      var r = window.cep.fs.showOpenDialogEx(false, false, title, null, exts);
      if (r && r.data && r.data.length) return r.data[0];
      return null;
    }
    return prompt(title + ' — enter full file path:') || null;
  }

  // --------------------------------------------------------------- tabs ----
  var tabs = document.querySelectorAll('.tab');
  for (var t = 0; t < tabs.length; t++) {
    tabs[t].addEventListener('click', function () {
      document.querySelector('.tab.active').classList.remove('active');
      document.querySelector('.tab-page.active').classList.remove('active');
      this.classList.add('active');
      $('tab-' + this.dataset.tab).classList.add('active');
      // Re-check for a transcript when returning to Captions (e.g. after
      // exporting one), and refresh the preview now the frame has a size.
      if (this.dataset.tab === 'captions' && CPBridge.isCEP()) {
        if (!state.transcript) findTranscript();
        renderPreview();
      }
      if (this.dataset.tab === 'multicam' && CPBridge.isCEP()) {
        // re-read the timeline's audio tracks in case it changed
        state.mcAudioTracks = null; _mainTracksLoaded = false;
        syncMcSource();
      }
    });
  }

  // --------------------------------------------------------------- boot ----
  function boot() {
    $('set-ffmpeg').value = settings.ffmpegPath || '';
    $('set-dropframe').checked = !!settings.dropFrame;
    loadLibraryPrefs();
    buildFontSelect();
    buildAnimRail();
    wireCustomizer();
    wireTranscriptBar();
    wireAltMode();
    wireSubviews();
    buildLibrary();
    applyTemplate(currentPreset(), { silent: true });  // seeds controls + first preview
    updateSyncStat();

    if (!CPBridge.isCEP()) {
      $('env-status').textContent = 'browser preview';
      $('env-status').className = 'env-status err';
      setTranscriptBar('warn', '⚠️', 'Open this inside Premiere to find your transcript', 'How?');
      return;
    }
    CPBridge.callHost('CP_getEnv').then(function (env) {
      state.env = env;
      $('env-status').textContent = env.sequenceName + ' · ' + env.width + '×' + env.height;
      $('env-status').className = 'env-status ok';
    }).catch(function (e) {
      $('env-status').textContent = e.message;
      $('env-status').className = 'env-status err';
    });
    findTranscript();
  }

  // ===================================================== TRANSCRIPT (1-line) ==
  function listCaptionFilesIn(dir) {
    var out = [];
    try {
      var fs = nodeReq('fs');
      var pathMod = nodeReq('path');
      var names = fs.readdirSync(dir);
      for (var i = 0; i < names.length; i++) {
        if (/\.(srt|vtt)$/i.test(names[i])) {
          var full = pathMod.join(dir, names[i]);
          var mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch (eS) {}
          out.push({ label: names[i], path: full, mtime: mtime });
        }
      }
    } catch (e) {}
    return out;
  }

  function setTranscriptBar(cls, ico, text, btn) {
    $('tr-bar').className = 'tr-bar' + (cls ? ' ' + cls : '');
    $('tr-ico').textContent = ico;
    $('tr-text').textContent = text;
    var b = $('btn-tr-change');
    if (btn) { b.textContent = btn; b.classList.remove('hidden'); }
    else b.classList.add('hidden');
  }

  /* Find the single best transcript and confirm it in the bar. */
  function findTranscript() {
    setTranscriptBar('', '🔎', 'looking for your words…', null);
    var found = [];
    var seen = {};
    function add(s) {
      var k = (s.path || '').toLowerCase();
      if (!k || seen[k]) return; seen[k] = true; found.push(s);
    }
    var pathMod = null;
    try { pathMod = nodeReq('path'); } catch (e) {}

    CPBridge.callHost('CP_findProjectSrts').then(function (r) {
      (r.items || []).forEach(function (it) { add({ label: it.name, path: it.path, mtime: 1e15 }); });
      return CPBridge.callHost('CP_getSelectedClip').catch(function () { return null; });
    }).then(function (sel) {
      if (sel && sel.clip && sel.clip.mediaPath && pathMod) {
        var dir = pathMod.dirname(sel.clip.mediaPath);
        var base = pathMod.basename(sel.clip.mediaPath).replace(/\.[^.]+$/, '').toLowerCase();
        listCaptionFilesIn(dir).forEach(function (s) {
          if (s.label.toLowerCase().indexOf(base) === 0) s.mtime += 1e14;
          add(s);
        });
      }
      return CPBridge.callHost('CP_getProjectInfo').catch(function () { return null; });
    }).then(function (proj) {
      if (proj && proj.path && pathMod) listCaptionFilesIn(pathMod.dirname(proj.path)).forEach(add);
      found.sort(function (a, b) { return b.mtime - a.mtime; });
      if (found.length) {
        state.transcript = found[0];
        setTranscriptBar('ok', '✅', 'Using ' + found[0].label, 'Change');
      } else {
        state.transcript = null;
        setTranscriptBar('warn', '⚠️', 'No transcript found yet', 'Get one →');
      }
    }).catch(function () {
      state.transcript = null;
      setTranscriptBar('warn', '⚠️', 'No transcript found yet', 'Get one →');
    });
  }

  function wireTranscriptBar() {
    $('btn-tr-change').addEventListener('click', function () {
      if (state.transcript) {
        var p = pickFile('Choose a caption file (.srt / .vtt)', ['srt', 'vtt']);
        if (p) {
          state.transcript = { label: p.split(/[\\/]/).pop(), path: p, mtime: 1e16 };
          setTranscriptBar('ok', '✅', 'Using ' + state.transcript.label, 'Change');
        }
      } else {
        $('tr-help').classList.toggle('hidden');
      }
    });
    $('btn-tr-again').addEventListener('click', findTranscript);
    $('btn-tr-pick').addEventListener('click', function () {
      var p = pickFile('Choose a caption file (.srt / .vtt)', ['srt', 'vtt']);
      if (!p) return;
      state.transcript = { label: p.split(/[\\/]/).pop(), path: p, mtime: 1e16 };
      setTranscriptBar('ok', '✅', 'Using ' + state.transcript.label, 'Change');
      $('tr-help').classList.add('hidden');
    });
  }

  function readSelectedTranscript() {
    if (!state.transcript) throw new Error('No transcript yet — tap "Get one →" for the 1-minute steps.');
    var text = nodeReq('fs').readFileSync(state.transcript.path, 'utf8');
    var cues = CPCaptions.parseSRT(text);
    if (!cues.length) throw new Error('No captions found inside ' + state.transcript.label);
    return cues;
  }

  // ===================================================== TEMPLATE LIBRARY ====
  var MOGRT_CAT = 'Premiere (.mogrt)';
  var LS = { fav: 'cutpilot.favs', recent: 'cutpilot.recent', custom: 'cutpilot.custom', mogrts: 'cutpilot.mogrts' };

  function loadLibraryPrefs() {
    try { state.favs = JSON.parse(localStorage.getItem(LS.fav)) || {}; } catch (e) { state.favs = {}; }
    try { state.recent = JSON.parse(localStorage.getItem(LS.recent)) || []; } catch (e2) { state.recent = []; }
    try { state.customTemplates = JSON.parse(localStorage.getItem(LS.custom)) || []; } catch (e3) { state.customTemplates = []; }
    try { state.userMogrts = JSON.parse(localStorage.getItem(LS.mogrts)) || []; } catch (e4) { state.userMogrts = []; }
  }
  function saveFavs() { localStorage.setItem(LS.fav, JSON.stringify(state.favs)); }
  function saveRecent() { localStorage.setItem(LS.recent, JSON.stringify(state.recent.slice(0, 12))); }
  function saveCustom() { localStorage.setItem(LS.custom, JSON.stringify(state.customTemplates)); }
  function saveUserMogrts() { localStorage.setItem(LS.mogrts, JSON.stringify(state.userMogrts)); }

  /* MOGRT templates shown in the gallery: installed Premiere templates +
     any .mogrt files the user added. Each is a card with mogrt:true. */
  function mogrtTemplates() {
    var out = [];
    (state.installedMogrts || []).forEach(function (m) {
      out.push({ id: 'mogrt:' + m.path, name: m.name, category: MOGRT_CAT, mogrt: true,
                 path: m.path, popularity: 55, subcat: m.category });
    });
    (state.userMogrts || []).forEach(function (m) {
      out.push({ id: 'mogrt:' + m.path, name: m.name, category: MOGRT_CAT, mogrt: true,
                 path: m.path, popularity: 60, subcat: 'Added by you' });
    });
    return out;
  }

  /* All templates = built-in styles + user custom styles + MOGRT cards. */
  function allTemplates() {
    return CPCaptions.TEMPLATES.concat(state.customTemplates).concat(mogrtTemplates());
  }

  function findTemplate(id) {
    var all = allTemplates();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return CPCaptions.TEMPLATES[0];
  }

  function currentPreset() { return findTemplate(state.presetId); }

  function buildLibrary() {
    // niche suggester
    var nsel = $('lib-niche');
    CPCaptions.NICHES.forEach(function (n) {
      var o = document.createElement('option'); o.value = n; o.textContent = n; nsel.appendChild(o);
    });
    nsel.addEventListener('change', function () {
      var id = CPCaptions.NICHE_RECOMMEND[this.value];
      if (id) { applyTemplate(findTemplate(id)); toast('Suggested "' + findTemplate(id).name + '" for ' + this.value + '.'); }
      this.value = '';
    });

    // category chips
    var cats = ['All', 'Favorites', 'Recent', 'My Templates', MOGRT_CAT].concat(CPCaptions.CATEGORIES);
    var chipBox = $('lib-cats');
    cats.forEach(function (c) {
      var chip = document.createElement('button');
      chip.className = 'cat-chip' + (c === state.libCategory ? ' on' : '');
      chip.textContent = c;
      chip.addEventListener('click', function () {
        state.libCategory = c;
        var on = chipBox.querySelector('.cat-chip.on'); if (on) on.classList.remove('on');
        chip.classList.add('on');
        renderTemplateGrid();
      });
      chipBox.appendChild(chip);
    });

    $('lib-search').addEventListener('input', function () { state.libSearch = this.value.toLowerCase(); renderTemplateGrid(); });
    $('lib-sort').addEventListener('change', function () { state.libSort = this.value; renderTemplateGrid(); });
    $('btn-tpl-import').addEventListener('click', importTemplate);
    $('btn-add-mogrt').addEventListener('click', addMogrtFile);
    wireMogrtSheet();

    // pull in Premiere's installed templates so they appear as cards
    if (CPBridge.isCEP() && !state.installedMogrts.length) {
      CPBridge.callHost('CP_findInstalledMogrts').then(function (r) {
        state.installedMogrts = r.items || [];
        renderTemplateGrid();
      }).catch(function () {});
    }
    renderTemplateGrid();
  }

  function addMogrtFile() {
    var p = pickFile('Choose a Motion Graphics Template (.mogrt)', ['mogrt']);
    if (!p) return;
    var name = p.split(/[\\/]/).pop().replace(/\.mogrt$/i, '');
    state.userMogrts = (state.userMogrts || []).filter(function (m) { return m.path !== p; });
    state.userMogrts.unshift({ name: name, path: p });
    saveUserMogrts();
    state.libCategory = MOGRT_CAT;
    var on = $('lib-cats').querySelector('.cat-chip.on'); if (on) on.classList.remove('on');
    var chips = document.querySelectorAll('#lib-cats .cat-chip');
    for (var i = 0; i < chips.length; i++) if (chips[i].textContent === MOGRT_CAT) chips[i].classList.add('on');
    renderTemplateGrid();
    toast('Added "' + name + '" to your templates.');
  }

  function filteredTemplates() {
    var list = allTemplates().slice();
    var cat = state.libCategory;
    if (cat === 'Favorites') list = list.filter(function (t) { return state.favs[t.id]; });
    else if (cat === 'Recent') {
      list = state.recent.map(findTemplate).filter(Boolean);
    } else if (cat === 'My Templates') list = state.customTemplates.slice();
    else if (cat !== 'All') list = list.filter(function (t) { return t.category === cat; });

    if (state.libSearch) {
      var q = state.libSearch;
      list = list.filter(function (t) {
        return (t.name + ' ' + t.category + ' ' + (t.font || '') + ' ' + (t.anim || '') + ' ' + (t.subcat || '')).toLowerCase().indexOf(q) >= 0;
      });
    }
    if (state.libSort === 'popular' && cat !== 'Recent') list.sort(function (a, b) { return (b.popularity || 0) - (a.popularity || 0); });
    else if (state.libSort === 'az') list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    else if (state.libSort === 'favorites') list.sort(function (a, b) { return (state.favs[b.id] ? 1 : 0) - (state.favs[a.id] ? 1 : 0); });
    return list;
  }

  function renderTemplateGrid() {
    var grid = $('tpl-grid');
    grid.innerHTML = '';
    var list = filteredTemplates();
    if (!list.length) {
      var e = document.createElement('div');
      e.className = 'lib-empty';
      e.textContent = state.libCategory === 'Favorites' ? 'No favorites yet — tap the ☆ on any template.'
        : state.libCategory === 'My Templates' ? 'No custom templates yet. Open a style, tweak it, and hit ＋ Save.'
        : 'No templates match your search.';
      grid.appendChild(e);
      return;
    }
    list.forEach(function (t) {
      grid.appendChild(buildTemplateCard(t));
    });
  }

  function buildTemplateCard(t) {
    // MOGRT cards: distinct look + open the action sheet (preview / use)
    if (t.mogrt) {
      var mc = document.createElement('div');
      mc.className = 'tpl-card is-mogrt';
      var mthumb = document.createElement('div');
      mthumb.className = 'tpl-thumb';
      var mcap = document.createElement('div');
      mcap.className = 't-cap';
      mcap.textContent = '🎬';
      mthumb.appendChild(mcap);
      var badge = document.createElement('span');
      badge.className = 'tpl-pop';
      badge.textContent = 'MOGRT';
      mthumb.appendChild(badge);
      mc.appendChild(mthumb);
      var mmeta = document.createElement('div');
      mmeta.className = 'tpl-meta';
      var mnm = document.createElement('span'); mnm.className = 'tpl-name'; mnm.textContent = t.name;
      var mct = document.createElement('span'); mct.className = 'tpl-cat'; mct.textContent = t.subcat || 'Premiere';
      mmeta.appendChild(mnm); mmeta.appendChild(mct);
      mc.appendChild(mmeta);
      mc.addEventListener('click', function () { openMogrtSheet(t); });
      return mc;
    }

    var card = document.createElement('div');
    card.className = 'tpl-card' + (t.id === state.presetId ? ' on' : '');

    var thumb = document.createElement('div');
    thumb.className = 'tpl-thumb';
    var cap = document.createElement('div');
    cap.className = 't-cap';
    var animId = CPCaptions.animIdForConcept(t.anim);
    var def = CPCaptions.getAnimation(animId);
    // cards only loop the keyframed entrances; framed ones (karaoke/typewriter) just fade
    var demo = (def.kind === 'framed') ? 'anim-fade' : (def.demo || 'anim-fade');
    // a 2-word sample so keyword highlight is visible
    var w1 = t.uppercase ? 'BIG' : 'Big';
    var w2 = t.uppercase ? 'IDEA' : 'idea';
    cap.innerHTML = w1 + ' <span class="kwd">' + w2 + '</span>';
    cap.style.fontFamily = '"' + t.font + '", ' + (t.fallbackFonts || []).join(', ') + ', sans-serif';
    cap.style.color = t.fill;
    if (t.letterSpacing) cap.style.letterSpacing = t.letterSpacing + 'px';
    if (t.stroke && t.strokeWidth) {
      cap.style.textShadow = '-1.5px -1.5px 0 ' + t.stroke + ',1.5px -1.5px 0 ' + t.stroke +
        ',-1.5px 1.5px 0 ' + t.stroke + ',1.5px 1.5px 0 ' + t.stroke;
    }
    if (t.glow) cap.style.textShadow = '0 0 10px ' + t.glow;
    if (t.boxColor) { cap.style.background = t.boxColor; cap.style.padding = '2px 8px'; cap.style.borderRadius = '6px'; }
    var kwd = cap.querySelector('.kwd');
    kwd.style.color = t.highlight || t.fill;
    if (demo) cap.className = 't-cap ' + demo;
    thumb.appendChild(cap);

    var pop = document.createElement('span');
    pop.className = 'tpl-pop';
    pop.textContent = '🔥 ' + (t.popularity || 60);
    thumb.appendChild(pop);

    var fav = document.createElement('button');
    fav.className = 'tpl-fav' + (state.favs[t.id] ? ' on' : '');
    fav.textContent = state.favs[t.id] ? '★' : '☆';
    fav.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (state.favs[t.id]) delete state.favs[t.id]; else state.favs[t.id] = 1;
      saveFavs();
      fav.classList.toggle('on');
      fav.textContent = state.favs[t.id] ? '★' : '☆';
      if (state.libCategory === 'Favorites') renderTemplateGrid();
    });
    thumb.appendChild(fav);
    card.appendChild(thumb);

    var meta = document.createElement('div');
    meta.className = 'tpl-meta';
    var nm = document.createElement('span'); nm.className = 'tpl-name'; nm.textContent = t.name;
    var ct = document.createElement('span'); ct.className = 'tpl-cat'; ct.textContent = t.category;
    meta.appendChild(nm); meta.appendChild(ct);
    card.appendChild(meta);

    card.addEventListener('click', function () { applyTemplate(t); showView('editor'); });
    return card;
  }

  function trackRecent(id) {
    state.recent = [id].concat(state.recent.filter(function (x) { return x !== id; }));
    saveRecent();
  }

  // ----------------------------------------------- MOGRT card action sheet ----
  function syncMsWords() {
    var w = parseInt($('c-words').value, 10) || 0;
    var target = (w === 0) ? 0 : (w >= 2 ? 3 : 1);
    var wb = document.querySelectorAll('#ms-words button');
    for (var i = 0; i < wb.length; i++) wb[i].classList.toggle('on', parseInt(wb[i].dataset.w, 10) === target);
  }

  function openMogrtSheet(t) {
    state.selectedMogrt = { path: t.path, name: t.name };
    $('ms-name').textContent = t.name;
    $('ms-inspect-out').classList.add('hidden');
    syncMsWords();
    $('mogrt-sheet').classList.remove('hidden');
  }

  function wireMogrtSheet() {
    // these buttons drive the SAME words-per-caption value as the editor stepper
    var wb = document.querySelectorAll('#ms-words button');
    for (var i = 0; i < wb.length; i++) {
      wb[i].addEventListener('click', function () {
        setWordCount(parseInt(this.dataset.w, 10) || 0);
        syncMsWords();
      });
    }
    $('ms-close').addEventListener('click', function () { $('mogrt-sheet').classList.add('hidden'); });
    $('mogrt-sheet').addEventListener('click', function (e) {
      if (e.target === this) this.classList.add('hidden'); // tap backdrop to close
    });
    $('ms-preview').addEventListener('click', function () {
      if (!state.selectedMogrt) return;
      CPBridge.callHost('CP_previewMogrt', { path: state.selectedMogrt.path, seconds: 4 }).then(function (r) {
        toast('▶ Placed "' + state.selectedMogrt.name + '" at the playhead on V' + r.track + ' — play to preview.');
      }).catch(function (e) { toast(e.message, true); });
    });
    $('ms-use').addEventListener('click', function () {
      if (!state.selectedMogrt) return;
      $('mogrt-sheet').classList.add('hidden');
      applyMogrtWithPath(state.selectedMogrt.path, $('ms-use'));
    });
    $('ms-inspect').addEventListener('click', function () {
      if (!state.selectedMogrt) return;
      var out = $('ms-inspect-out');
      out.classList.remove('hidden'); out.className = 'diag-out'; out.textContent = 'Inspecting…';
      CPBridge.callHost('CP_inspectMogrt', { path: state.selectedMogrt.path }).then(function (r) {
        if (!r.props || !r.props.length) { out.textContent = 'No editable fields exposed.'; return; }
        out.textContent = r.props.map(function (p) {
          return '"' + p.name + '" [' + p.type + ']' + (p.type === 'string' ? ' = ' + p.sample : '');
        }).join('\n');
      }).catch(function (e) { out.className = 'diag-out err'; out.textContent = e.message; });
    });
  }

  // ----------------------------------------------------- editor controls ----
  function buildFontSelect() {
    var sel = $('c-font');
    CPCaptions.FONTS.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f; o.textContent = f; o.style.fontFamily = '"' + f + '", sans-serif';
      sel.appendChild(o);
    });
  }

  function setFontValue(font) {
    var sel = $('c-font');
    var has = false;
    for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === font) has = true;
    if (!has) {
      var o = document.createElement('option');
      o.value = font; o.textContent = font;
      sel.insertBefore(o, sel.firstChild);
    }
    sel.value = font;
  }

  function toHex(c, fb) {
    return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) ? c : (fb || '#ffffff');
  }

  /* Load a template into all customizer controls, refresh preview.
     opts.silent skips the recent-tracking + toast (used on boot). */
  function applyTemplate(p, opts) {
    opts = opts || {};
    state.presetId = p.id;
    $('editor-tpl-name').textContent = p.name;

    setFontValue(p.font);
    $('c-size').value = p.fontSize;
    $('c-pos').value = (p.layout === 'top') ? 18 : (p.layout === 'center') ? 50 : 76;
    setLayoutButton($('c-pos').value);
    $('c-fill').value = toHex(p.fill, '#ffffff');
    $('c-hl').value = toHex(p.highlight, '#ffd400');
    $('c-stroke').value = toHex(p.stroke, '#000000');
    $('c-strokew').value = p.strokeWidth || 0;
    $('c-box-on').checked = !!p.boxColor;
    $('c-box').value = toHex(p.boxColor, '#ff3b6b');
    $('c-upper').checked = !!p.uppercase;
    setWordCount(p.wordsPerCue);
    syncHlStyleButtons(p.highlightStyle || 'color');
    $('c-kw').checked = !!p.keyword;
    $('c-kw-mode-wrap').classList.toggle('hidden', !p.keyword);
    $('c-hl-scale').value = Math.round((p.highlightScale || 1) * 100);
    $('c-speaker').checked = !!p.speaker;
    selectAnim(CPCaptions.animIdForConcept(p.anim));
    updateVals();
    renderPreview();

    if (!opts.silent) { trackRecent(p.id); toast('Applied "' + p.name + '". Tweak it below, then Add captions.'); }
  }

  function setLayoutButton(pos) {
    var btns = document.querySelectorAll('#c-layout button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.pos === String(pos));
  }

  function buildAnimRail() {
    var rail = $('anim-rail');
    CPCaptions.ANIMATIONS.forEach(function (a) {
      var chip = document.createElement('button');
      chip.className = 'anim-chip' + (a.id === state.animId ? ' on' : '');
      chip.dataset.id = a.id;
      chip.textContent = a.name;
      chip.title = a.description;
      chip.addEventListener('click', function () { selectAnim(a.id); renderPreview(); });
      rail.appendChild(chip);
    });
  }

  function selectAnim(id) {
    state.animId = id;
    var chips = document.querySelectorAll('.anim-chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('on', chips[i].dataset.id === id);
    }
  }

  function updateVals() {
    $('c-size-val').textContent = $('c-size').value;
    $('c-pos-val').textContent = $('c-pos').value + '%';
    $('c-strokew-val').textContent = $('c-strokew').value;
    $('c-hlscale-val').textContent = $('c-hl-scale').value + '%';
  }

  function wireCustomizer() {
    var ids = ['c-font', 'c-size', 'c-pos', 'c-fill', 'c-hl', 'c-stroke', 'c-box',
               'c-strokew', 'c-box-on', 'c-upper', 'c-words', 'c-kw', 'c-kw-mode',
               'c-hl-scale', 'c-speaker'];
    ids.forEach(function (id) {
      $(id).addEventListener('input', function () { updateVals(); renderPreview(); });
      $(id).addEventListener('change', function () { updateVals(); renderPreview(); });
    });
    $('c-kw').addEventListener('change', function () {
      $('c-kw-mode-wrap').classList.toggle('hidden', !this.checked);
    });
    // layout quick buttons set the position slider
    var lay = document.querySelectorAll('#c-layout button');
    for (var i = 0; i < lay.length; i++) {
      lay[i].addEventListener('click', function () {
        $('c-pos').value = this.dataset.pos;
        setLayoutButton(this.dataset.pos);
        updateVals(); renderPreview();
      });
    }
    $('c-pos').addEventListener('input', function () { setLayoutButton(this.value); });
    // highlight look: colour vs box/pill
    var hb = document.querySelectorAll('#c-hlstyle button');
    for (var h = 0; h < hb.length; h++) {
      hb[h].addEventListener('click', function () { syncHlStyleButtons(this.dataset.s); renderPreview(); });
    }
    // prominent Words-per-caption stepper
    $('wc-minus').addEventListener('click', function () {
      var w = parseInt($('c-words').value, 10) || 0;
      setWordCount(w <= 1 ? 1 : w - 1); renderPreview();
    });
    $('wc-plus').addEventListener('click', function () {
      var w = parseInt($('c-words').value, 10) || 0;
      setWordCount(w === 0 ? 1 : w + 1); renderPreview();
    });
    $('wc-full').addEventListener('click', function () {
      var w = parseInt($('c-words').value, 10) || 0;
      setWordCount(w === 0 ? 1 : 0); renderPreview();
    });
    $('c-sync').addEventListener('change', updateSyncStat);
    $('btn-replay').addEventListener('click', renderPreview);
  }

  function updateSyncStat() {
    var el = $('sync-stat'); if (!el) return;
    if (!$('c-sync').checked) { el.textContent = '(off)'; return; }
    el.textContent = resolveFfmpeg() ? '· ready' : '· needs ffmpeg (Settings)';
  }

  /* Single source of truth for words-per-caption; keeps the hidden input,
     the slider, its label, and the quick buttons all in sync. */
  function setWordCount(w) {
    w = isNaN(w) ? 1 : Math.max(0, Math.min(10, w));
    $('c-words').value = w;
    $('wc-num').textContent = (w === 0) ? '—' : w;
    var full = document.getElementById('wc-full');
    if (full) full.classList.toggle('on', w === 0);
  }

  function readKeyword() {
    return { on: $('c-kw').checked, mode: $('c-kw-mode').value };
  }

  // ----------------------------------------------------- sub-views / save ----
  function showView(v) {
    $('view-templates').classList.toggle('hidden', v !== 'templates');
    $('view-editor').classList.toggle('hidden', v !== 'editor');
    var btns = document.querySelectorAll('#cap-view button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.view === v);
    if (v === 'editor') renderPreview();
    if (v === 'templates') renderTemplateGrid();
  }

  function wireSubviews() {
    var btns = document.querySelectorAll('#cap-view button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () { showView(this.dataset.view); });
    }
    $('btn-back-lib').addEventListener('click', function () { showView('templates'); });
    $('btn-save-tpl').addEventListener('click', saveAsTemplate);
    $('btn-dup-tpl').addEventListener('click', duplicateTemplate);
    $('btn-export-tpl').addEventListener('click', exportTemplate);
  }

  /* Build a template object from the current customizer state. */
  function styleFromControls(name, id) {
    var o = readOverrides();
    return {
      id: id || ('custom-' + Date.now()),
      name: name || 'My Template',
      category: 'My Templates',
      popularity: 50,
      custom: true,
      font: o.font, fallbackFonts: currentPreset().fallbackFonts || [],
      fontSize: o.fontSize, fill: o.fill, highlight: o.highlight,
      stroke: o.strokeWidth ? o.stroke : null, strokeWidth: o.strokeWidth,
      boxColor: o.boxColor, boxRadius: currentPreset().boxRadius || 10,
      glow: currentPreset().glow || null,
      letterSpacing: currentPreset().letterSpacing || 0,
      highlightScale: o.highlightScale,
      uppercase: o.uppercase,
      layout: o.yPct <= 0.3 ? 'top' : o.yPct >= 0.66 ? 'bottom' : 'center',
      keyword: $('c-kw').checked,
      speaker: $('c-speaker').checked,
      wordsPerCue: parseInt($('c-words').value, 10) || 0,
      anim: state.animId
    };
  }

  function saveAsTemplate() {
    var name = prompt('Name this template:', currentPreset().name + ' Custom');
    if (!name) return;
    var tpl = styleFromControls(name);
    state.customTemplates.push(tpl);
    saveCustom();
    state.presetId = tpl.id;
    $('editor-tpl-name').textContent = tpl.name;
    toast('Saved "' + name + '" to My Templates.');
  }

  function duplicateTemplate() {
    var tpl = styleFromControls(currentPreset().name + ' Copy');
    state.customTemplates.push(tpl);
    saveCustom();
    state.presetId = tpl.id;
    $('editor-tpl-name').textContent = tpl.name;
    toast('Duplicated as "' + tpl.name + '".');
  }

  function exportTemplate() {
    var tpl = styleFromControls(currentPreset().name, currentPreset().id);
    var json = JSON.stringify(tpl, null, 2);
    try {
      var p = nodeReq('path');
      var out = p.join(nodeReq('os').homedir(), (tpl.name.replace(/[^\w]+/g, '_')) + '.cutpilot.json');
      nodeReq('fs').writeFileSync(out, json, 'utf8');
      toast('Exported to ' + out);
    } catch (e) { toast('Export failed: ' + e.message, true); }
  }

  function importTemplate() {
    var p = pickFile('Choose a CutPilot template (.json)', ['json']);
    if (!p) return;
    try {
      var tpl = JSON.parse(nodeReq('fs').readFileSync(p, 'utf8'));
      if (!tpl || !tpl.font) throw new Error('Not a CutPilot template file.');
      tpl.id = 'custom-' + Date.now();
      tpl.category = 'My Templates';
      tpl.custom = true;
      state.customTemplates.push(tpl);
      saveCustom();
      state.libCategory = 'My Templates';
      var on = $('lib-cats').querySelector('.cat-chip.on'); if (on) on.classList.remove('on');
      renderTemplateGrid();
      toast('Imported "' + (tpl.name || 'template') + '".');
    } catch (e) { toast('Import failed: ' + e.message, true); }
  }

  /* Read the customizer into an overrides object for mergeStyle / render. */
  function readOverrides() {
    return {
      font: $('c-font').value,
      fontSize: parseInt($('c-size').value, 10),
      yPct: parseInt($('c-pos').value, 10) / 100,
      fill: $('c-fill').value,
      highlight: $('c-hl').value,
      stroke: $('c-stroke').value,
      strokeWidth: parseInt($('c-strokew').value, 10),
      boxColor: $('c-box-on').checked ? $('c-box').value : null,
      highlightScale: (parseInt($('c-hl-scale').value, 10) || 100) / 100,
      highlightStyle: readHlStyle(),
      uppercase: $('c-upper').checked
    };
  }

  function readHlStyle() {
    var on = document.querySelector('#c-hlstyle button.on');
    return on ? on.dataset.s : 'color';
  }
  function syncHlStyleButtons(s) {
    var b = document.querySelectorAll('#c-hlstyle button');
    for (var i = 0; i < b.length; i++) b[i].classList.toggle('on', b[i].dataset.s === (s || 'color'));
  }

  function readSpeaker() { return { on: $('c-speaker').checked }; }

  function fontStack(font, fallbacks) {
    return '"' + font + '", "' + (fallbacks || []).join('", "') + '", sans-serif';
  }

  // --------------------------------------------------------- live preview ----
  var previewTimer = null;
  var SAMPLE = ['THIS', 'LOOKS', 'INSANE'];
  var SAMPLE_SENTENCE = ['THIS', 'IS', 'EXACTLY', 'HOW', 'YOUR', 'CAPTIONS', 'WILL', 'LOOK'];
  function longestIdx(arr) {
    var best = 0, bl = 0;
    for (var i = 0; i < arr.length; i++) { var l = arr[i].replace(/[^A-Za-z]/g, '').length; if (l > bl) { bl = l; best = i; } }
    return best;
  }

  function renderPreview() {
    if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
    var st = CPCaptions.mergeStyle(currentPreset(), readOverrides());
    var cap = $('preview-caption');
    var frame = $('preview-frame');
    var frameH = frame.clientHeight || 168;
    var px = Math.max(11, Math.round(st.fontSize * frameH / 1080));

    cap.style.fontFamily = fontStack(st.font, st.fallbackFonts);
    cap.style.fontSize = px + 'px';
    cap.style.color = st.fill;
    cap.style.top = Math.max(2, Math.round(st.yPct * frameH - px)) + 'px';

    // outline / glow
    var shadow = '';
    if (st.stroke && st.strokeWidth) {
      var sw = Math.max(1, Math.round(st.strokeWidth * frameH / 1080));
      shadow = [-sw + 'px -' + sw + 'px 0 ' + st.stroke, sw + 'px -' + sw + 'px 0 ' + st.stroke,
                '-' + sw + 'px ' + sw + 'px 0 ' + st.stroke, sw + 'px ' + sw + 'px 0 ' + st.stroke].join(', ');
    }
    if (st.glow) shadow = (shadow ? shadow + ', ' : '') + '0 0 ' + Math.round(px * 0.5) + 'px ' + st.glow;
    cap.style.textShadow = shadow;

    // background box
    if (st.boxColor) {
      cap.style.background = st.boxColor;
      cap.style.borderRadius = Math.round((st.boxRadius || 10) * frameH / 1080) + 'px';
      cap.style.padding = '2px ' + Math.round(px * 0.3) + 'px';
    } else {
      cap.style.background = 'transparent';
      cap.style.padding = '2px 6px';
    }

    var anim = state.animId;
    var words = parseInt($('c-words').value, 10) || 0;
    var caps = st.uppercase;
    var hlPct = Math.round((st.highlightScale || 1) * 100);
    var hlBox = readHlStyle() === 'box';
    function contrastHex(hex) {
      var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '#ffd400'));
      if (!m) return '#111';
      var nn = parseInt(m[1], 16);
      var lum = (0.299 * ((nn >> 16) & 255) + 0.587 * ((nn >> 8) & 255) + 0.114 * (nn & 255)) / 255;
      return lum > 0.6 ? '#111' : '#fff';
    }
    function hlSpan(t) {
      if (hlBox) {
        return '<span style="background:' + st.highlight + ';color:' + contrastHex(st.highlight) +
               ';font-size:' + hlPct + '%;padding:1px 7px;border-radius:7px">' + t + '</span>';
      }
      return '<span style="color:' + st.highlight + ';font-size:' + hlPct + '%">' + t + '</span>';
    }

    // speaker label preview
    var spkEl = $('preview-speaker');
    if ($('c-speaker').checked) {
      spkEl.classList.remove('hidden');
      spkEl.innerHTML = '<span style="color:' + st.highlight + '">HOST</span>';
      spkEl.style.top = Math.max(2, Math.round(st.yPct * frameH - px) - 22) + 'px';
    } else {
      spkEl.classList.add('hidden');
    }

    // reset animation classes
    cap.className = 'preview-caption';

    // show exactly the number of words the slider selects (0 = full line)
    var kwOn = $('c-kw').checked;
    function cased(w) { return caps ? w.toUpperCase() : (w.charAt(0) + w.slice(1).toLowerCase()); }
    var nShow = (words === 0) ? 6 : Math.min(words, SAMPLE_SENTENCE.length);
    var shown = SAMPLE_SENTENCE.slice(0, Math.max(1, nShow)).map(cased);

    if (anim === 'karaoke') {
      var idx = 0;
      var paint = function () {
        cap.innerHTML = shown.map(function (word, i) { return i === idx ? hlSpan(word) : word; }).join(' ');
        idx = (idx + 1) % shown.length;
      };
      paint();
      previewTimer = setInterval(paint, 520);
    } else if (anim === 'typewriter') {
      var n = 1;
      var typ = function () {
        cap.textContent = shown.slice(0, n).join(' ');
        n = n >= shown.length ? 1 : n + 1;
      };
      typ();
      previewTimer = setInterval(typ, 420);
    } else {
      var hi = kwOn ? longestIdx(shown) : -1;
      cap.innerHTML = shown.map(function (word, i) {
        return (i === hi || (shown.length === 1 && kwOn)) ? hlSpan(word) : word;
      }).join(' ');
      if (anim !== 'none') {
        void cap.offsetWidth; // re-trigger the CSS animation
        cap.classList.add('pa-' + anim);
      }
    }
  }

  // ============================================================ ADD CAPTIONS ==
  function capProgress(msg) {
    var el = $('cap-progress');
    if (msg == null) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.textContent = msg;
  }

  function textCues(cues, words, upper) {
    if (words > 0) return CPCaptions.explodeWords(cues, { wordsPerCue: words, uppercase: upper });
    if (upper) return cues.map(function (c) { return { start: c.start, end: c.end, text: c.text.toUpperCase() }; });
    return cues;
  }

  // ---- main button: the animated engine ----
  $('btn-magic').addEventListener('click', function () {
    var cues;
    try { cues = readSelectedTranscript(); }
    catch (e) { return toast(e.message, true); }
    if (!state.env) return toast('Open a sequence in Premiere first.', true);

    var preset = currentPreset();
    var overrides = readOverrides();
    var words = parseInt($('c-words').value, 10) || 0;
    var anim = state.animId;
    var wantSync = $('c-sync').checked && words !== 0;

    $('btn-magic').disabled = true;
    capProgress(wantSync ? 'Listening to the audio for sync…' : 'Preparing…');

    getCaptionWordCues(cues, wantSync).then(function (wordCues) {
      var frames = CPCaptions.buildCaptionFrames(cues, {
        anim: anim,
        wordsPerCue: words,
        uppercase: overrides.uppercase,
        keyword: readKeyword(),
        speaker: readSpeaker(),
        wordCues: wordCues
      });

      if (frames.length > 1500 &&
          !confirm(frames.length + ' caption frames will be rendered — that can take a few minutes. Continue?')) {
        $('btn-magic').disabled = false; capProgress(null); return;
      }

      var outDir;
      try {
        var pm = nodeReq('path');
        outDir = pm.join(nodeReq('os').tmpdir(), 'cutpilot-frames-' + Date.now());
      } catch (e) { $('btn-magic').disabled = false; capProgress(null); return toast('Node unavailable: ' + e.message, true); }

      capProgress('Rendering 0 / ' + frames.length);
      return CPRender.renderFrames(frames, {
        width: state.env.width || 1920,
        height: state.env.height || 1080,
        preset: preset,
        overrides: overrides,
        outDir: outDir,
        onProgress: function (done, total) { capProgress('Rendering ' + done + ' / ' + total); }
      }).then(function (items) {
        capProgress('Placing ' + items.length + ' captions in your timeline');
        return CPBridge.callHost('CP_placeCaptionImages', { items: items, anim: anim });
      }).then(function (r) {
        $('btn-magic').disabled = false;
        capProgress(null);
        toast('🎉 ' + r.placed + ' captions added on V' + r.track +
              (wordCues ? ' · audio-synced' : '') +
              (r.animated ? ' · ' + CPCaptions.getAnimation(anim).name : ''));
      });
    }).catch(function (e) {
      $('btn-magic').disabled = false;
      capProgress(null);
      toast('Captions failed: ' + e.message, true);
    });
  });

  /* Build audio-aligned word cues for tight sync (null = fall back to
     length-weighted timing). Uses the first audio track's envelope. */
  function getCaptionWordCues(cues, wantSync) {
    if (!wantSync) return Promise.resolve(null);
    var ff = resolveFfmpeg();
    if (!ff) return Promise.resolve(null);
    return ensureAudioTracks().then(function (tracks) {
      if (!tracks.length) return null;
      var track = tracks[0];
      return CPAudio.ffmpegEnvelope(track.mediaPath, ff, 0.1).then(function (env) {
        if (!env.samples || !env.samples.length) return null;
        return CPCaptions.alignCuesToAudio(cues, env.samples, track.inPoint || 0,
          { rise: 6, minSpacing: 0.1, snapWin: 0.18 });
      });
    }).catch(function () { return null; });  // any failure → silent fallback
  }

  // ---- advanced: Premiere template / plain track ----
  function wireAltMode() {
    // scan installed templates the first time the user expands "Other ways"
    var det = document.querySelector('#view-editor details.advanced');
    if (det) det.addEventListener('toggle', function () {
      if (this.open && !state.installedMogrts.length) scanInstalledMogrts();
    });
    var subs = document.querySelectorAll('#tpl-source button');
    for (var s = 0; s < subs.length; s++) {
      subs[s].addEventListener('click', function () {
        document.querySelector('#tpl-source button.on').classList.remove('on');
        this.classList.add('on');
        state.tplSource = this.dataset.src;
        $('tpl-installed').classList.toggle('hidden', state.tplSource !== 'installed');
        $('tpl-file').classList.toggle('hidden', state.tplSource !== 'file');
      });
    }
    $('btn-tpl-rescan').addEventListener('click', scanInstalledMogrts);
    $('btn-tpl-pick').addEventListener('click', function () {
      var p = pickFile('Choose a Motion Graphics Template', ['mogrt']);
      if (!p) return;
      state.mogrtFile = p;
      $('tpl-file-name').textContent = p.split(/[\\/]/).pop();
    });
    $('btn-alt-apply').addEventListener('click', applyMogrtTemplate);
    $('btn-native-apply').addEventListener('click', applyNative);
    $('btn-tpl-inspect').addEventListener('click', inspectMogrt);
  }

  /* Resolve the currently-selected .mogrt path (installed dropdown or file). */
  function selectedMogrtPath() {
    if (state.tplSource === 'installed') {
      var idx = parseInt($('tpl-select').value, 10);
      return (!isNaN(idx) && state.installedMogrts[idx]) ? state.installedMogrts[idx].path : null;
    }
    return state.mogrtFile || null;
  }

  /* Drop one instance of the template and list its editable fields, so we
     can see exactly which field holds the text. */
  function inspectMogrt() {
    var path = selectedMogrtPath();
    var out = $('tpl-inspect-out');
    if (!path) { out.classList.remove('hidden'); out.className = 'diag-out err'; out.textContent = 'Pick a template first.'; return; }
    out.classList.remove('hidden'); out.className = 'diag-out'; out.textContent = 'Inspecting ' + path.split(/[\\/]/).pop() + '…';
    CPBridge.callHost('CP_inspectMogrt', { path: path }).then(function (r) {
      if (!r.props || !r.props.length) { out.textContent = 'This template exposes no editable fields (count 0).'; return; }
      var lines = r.props.map(function (p) {
        return '#' + p.i + '  "' + p.name + '"  [' + p.type + ']' + (p.type === 'string' ? '  = ' + p.sample : '');
      });
      out.textContent = path.split(/[\\/]/).pop() + ' — ' + r.count + ' fields:\n' + lines.join('\n');
    }).catch(function (e) { out.className = 'diag-out err'; out.textContent = 'Inspect failed: ' + e.message; });
  }

  function scanInstalledMogrts() {
    var sel = $('tpl-select');
    sel.innerHTML = '<option>scanning…</option>';
    CPBridge.callHost('CP_findInstalledMogrts').then(function (r) {
      state.installedMogrts = r.items || [];
      sel.innerHTML = '';
      if (!state.installedMogrts.length) {
        sel.innerHTML = '<option value="">No installed templates</option>';
        $('tpl-installed-hint').textContent =
          'No Motion Graphics Templates are installed in Premiere yet. Install one ' +
          '(Essential Graphics panel → Install Motion Graphics Template), or use "From a ' +
          'file". Note: this lists Essential Graphics templates, not the Effects panel.';
        return;
      }
      var lastCat = null, group = null;
      state.installedMogrts.forEach(function (m, i) {
        if (m.category !== lastCat) {
          group = document.createElement('optgroup');
          group.label = m.category || 'Templates';
          sel.appendChild(group);
          lastCat = m.category;
        }
        var o = document.createElement('option');
        o.value = String(i); o.textContent = m.name;
        group.appendChild(o);
      });
      $('tpl-installed-hint').textContent =
        state.installedMogrts.length + ' templates found in your Premiere.';
    }).catch(function (e) {
      sel.innerHTML = '<option value="">scan failed</option>';
      $('tpl-installed-hint').textContent = e.message;
    });
  }

  function applyMogrtTemplate() {
    var path = selectedMogrtPath();
    if (!path) return toast('Pick an installed template, or choose a .mogrt file.', true);
    applyMogrtWithPath(path, $('btn-alt-apply'));
  }

  /* Make sure the project is saved (MOGRT/media import is unreliable on an
     unsaved project). Resolves true to proceed, false to stop. */
  function ensureProjectSaved() {
    return CPBridge.callHost('CP_saveProject').then(function (r) {
      if (r.needsSaveAs) {
        toast('Save your Premiere project once first (⌘S / Ctrl+S), then try again.', true);
        return false;
      }
      return true;
    }).catch(function () { return true; });  // if save errors, proceed anyway
  }

  /* Caption the whole transcript with a specific .mogrt (used by the gallery
     sheet and the advanced section). Honors the MOGRT word-count control. */
  function applyMogrtWithPath(mogrtPath, btn) {
    var cues;
    try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
    var words = parseInt($('c-words').value, 10) || 0;   // the one Words-per-caption stepper
    var tcues = textCues(cues, words, $('c-upper').checked);
    if (tcues.length > 400 &&
        !confirm(tcues.length + ' graphics will be added (one per line). Continue?')) return;
    if (btn) btn.disabled = true;
    capProgress('Saving project…');
    ensureProjectSaved().then(function (ok) {
      if (!ok) { if (btn) btn.disabled = false; capProgress(null); return null; }
      capProgress('Adding ' + tcues.length + ' template graphics');
      return CPBridge.callHost('CP_insertMogrtCaptions', {
        mogrtPath: mogrtPath, cues: tcues, videoTrack: null, audioTrack: 0
      });
    }).then(function (r) {
      if (r == null) return;
      if (btn) btn.disabled = false;
      capProgress(null);
      if (r.inserted === 0) {
        var why = (r.sampleErrors && r.sampleErrors.length) ? ' (' + r.sampleErrors[0] + ')' : '';
        return toast('Couldn\'t add this template' + why + '. Try another, or use an Animated style.', true);
      }
      if (r.textSet === 0) {
        toast('Placed ' + r.inserted + ' graphics, but couldn\'t find a text field. ' +
              'Fields: ' + ((r.fields && r.fields.join(', ')) || 'none') + '. Tell me one and I\'ll target it.', true);
      } else {
        toast('🎬 Added ' + r.inserted + ' template captions (' + r.textSet + ' with text)' +
              (r.failed ? ' · ' + r.failed + ' failed' : '') + '.');
      }
    }).catch(function (e) { if (btn) btn.disabled = false; capProgress(null); toast(e.message, true); });
  }

  function applyNative() {
    var cues;
    try { cues = readSelectedTranscript(); } catch (e) { return toast(e.message, true); }
    var preset = currentPreset();
    var ncues = textCues(cues, parseInt($('c-words').value, 10) || 0, $('c-upper').checked);
    try {
      var pathMod = nodeReq('path');
      var out = pathMod.join(nodeReq('os').tmpdir(), 'cutpilot-' + Date.now() + '.srt');
      nodeReq('fs').writeFileSync(out, CPCaptions.toSRT(ncues), 'utf8');
      capProgress('Creating caption track');
      CPBridge.callHost('CP_importSrtCaptions', { srtPath: out }).then(function () {
        capProgress(null);
        toast('✓ Caption track added (' + ncues.length + ' lines). Style it once in Essential ' +
              'Graphics: ' + preset.font + ' ' + preset.fontSize + 'px, ' + preset.fill +
              (preset.stroke ? ' + stroke ' + preset.stroke : ''));
      }).catch(function (e) { capProgress(null); toast(e.message, true); });
    } catch (e) { capProgress(null); toast(e.message, true); }
  }

  // ========================================================== SMART CUT ====
  function selectedSilences() {
    return state.silencesSeq.filter(function (s) { return s.keep; })
      .map(function (s) { return { start: s.start, end: s.end }; });
  }

  $('btn-analyze').addEventListener('click', function () {
    var opts = {
      thresholdDb: parseFloat($('opt-threshold').value),
      minSilence: parseFloat($('opt-minsilence').value),
      padding: parseFloat($('opt-padding').value),
      minKeep: parseFloat($('opt-minkeep').value)
    };
    var prog = $('analyze-progress');
    prog.classList.remove('hidden');
    prog.textContent = 'Reading selected clip';

    CPBridge.callHost('CP_getSelectedClip').then(function (res) {
      state.clip = res.clip;
      $('clip-badge').textContent = res.clip.name;
      $('clip-badge').className = 'badge ok';
      prog.textContent = 'Listening for silences';
      var ff = resolveFfmpeg();
      if (ff) {
        return CPAudio.ffmpegDetect(state.clip.mediaPath, ff,
                                     opts.thresholdDb, Math.min(opts.minSilence, 0.3), CPSilence);
      }
      return CPAudio.webAudioDetect(state.clip.mediaPath, { thresholdDb: opts.thresholdDb }, CPSilence);
    }).then(function (det) {
      var clip = state.clip;
      var mediaDuration = det.duration || clip.outPoint;
      var refined = CPSilence.refineSilences(det.silences, {
        minSilence: opts.minSilence,
        padding: opts.padding,
        totalDuration: mediaDuration
      });

      var silencesMedia = [];
      for (var i = 0; i < refined.length; i++) {
        var s = Math.max(refined[i].start, clip.inPoint);
        var e = Math.min(refined[i].end, clip.outPoint);
        if (e > s) silencesMedia.push({ start: s, end: e });
      }
      state.silencesSeq = silencesMedia.map(function (r) {
        return { start: clip.seqStart + (r.start - clip.inPoint),
                 end: clip.seqStart + (r.end - clip.inPoint), keep: true };
      });

      var clipRangeSil = silencesMedia.map(function (r) {
        return { start: r.start - clip.inPoint, end: r.end - clip.inPoint };
      });
      var clipDur = clip.outPoint - clip.inPoint;
      state.keepsMedia = CPSilence.invertToKeep(clipRangeSil, clipDur, opts.minKeep)
        .map(function (k) { return { start: k.start + clip.inPoint, end: k.end + clip.inPoint }; });
      state.keepsSeq = state.keepsMedia.map(function (k) {
        return { start: clip.seqStart + (k.start - clip.inPoint),
                 end: clip.seqStart + (k.end - clip.inPoint) };
      });

      renderResults(clipDur);
      prog.classList.add('hidden');
      toast('Found ' + state.silencesSeq.length + ' silences.');
    }).catch(function (e) {
      prog.classList.add('hidden');
      toast('Analyze failed: ' + e.message, true);
    });
  });

  function renderResults(clipDur) {
    var cut = CPSilence.totalDuration(selectedSilences());
    $('stats').innerHTML =
      'Removing <b>' + fmt(cut) + '</b> of dead air — that\'s <b>' +
      (clipDur ? Math.round(100 * cut / clipDur) : 0) + '%</b> of your clip';

    var list = $('silence-list');
    list.innerHTML = '';
    state.silencesSeq.forEach(function (s, i) {
      var item = document.createElement('div');
      item.className = 'seg-item';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = s.keep;
      cb.addEventListener('change', function () { s.keep = cb.checked; renderResults(clipDur); });
      item.appendChild(cb);
      var span = document.createElement('span');
      span.textContent = '#' + (i + 1) + '  ' + fmt(s.start) + ' → ' + fmt(s.end);
      item.appendChild(span);
      var dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = (s.end - s.start).toFixed(2) + 's';
      item.appendChild(dur);
      list.appendChild(item);
    });
    $('results').classList.remove('hidden');
  }

  $('btn-markers').addEventListener('click', function () {
    CPBridge.callHost('CP_addMarkers', { ranges: selectedSilences(), label: 'Silence' })
      .then(function (r) { toast('Added ' + r.created + ' preview markers.'); })
      .catch(function (e) { toast(e.message, true); });
  });

  $('btn-clear-markers').addEventListener('click', function () {
    CPBridge.callHost('CP_clearCutPilotMarkers', { label: 'Silence' })
      .then(function (r) { toast('Removed ' + r.removed + ' markers.'); })
      .catch(function (e) { toast(e.message, true); });
  });

  $('btn-rebuild').addEventListener('click', function () {
    if (!state.clip) return toast('Run the analysis first.', true);
    if (!state.keepsMedia.length) return toast('No keep segments computed.', true);
    CPBridge.callHost('CP_rebuildTrimmed', {
      nodeId: state.clip.nodeId,
      keeps: state.keepsMedia,
      name: 'CutPilot · ' + state.clip.name
    }).then(function (r) {
      toast('🎉 Built "' + r.sequence + '" — ' + r.segmentsPlaced + ' segments, ' + fmt(r.finalDuration) + ' long.');
    }).catch(function (e) { toast('Rebuild failed: ' + e.message, true); });
  });

  $('btn-cut').addEventListener('click', function () {
    var ranges = selectedSilences();
    if (!ranges.length) return toast('Nothing selected to cut.', true);
    if (!confirm('Cut ' + ranges.length + ' silent ranges directly in this sequence?')) return;
    CPBridge.callHost('CP_razorRipple', {
      ranges: ranges,
      closeGaps: $('opt-closegaps').checked,
      backup: $('opt-backup').checked,
      dropFrame: !!settings.dropFrame
    }).then(function (r) {
      toast('Cut done — removed ' + r.removedClips + ' pieces, closed ' + r.closedGaps + ' gaps.');
    }).catch(function (e) { toast('Cut failed: ' + e.message, true); });
  });

  // =========================================================== MULTICAM ====
  var mcButtons = document.querySelectorAll('#mc-mode button');
  for (var m = 0; m < mcButtons.length; m++) {
    mcButtons[m].addEventListener('click', function () {
      document.querySelector('#mc-mode button.on').classList.remove('on');
      this.classList.add('on');
      state.mcMode = this.dataset.mode;
    });
  }
  /* Run an ffmpeg command, capturing stdout/stderr (panel-side via Node).
     Kills the process after `timeoutMs` so it can never appear frozen. */
  function runFfmpeg(ffPath, args, timeoutMs) {
    return new Promise(function (resolve) {
      try {
        var cp = nodeReq('child_process');
        var proc = cp.spawn(ffPath, args);
        var out = '', err = '', done = false;
        function finish(o) { if (done) return; done = true; resolve(o); }
        var timer = setTimeout(function () {
          try { proc.kill(); } catch (e) {}
          finish({ code: -1, stdout: out, stderr: err, timedOut: true });
        }, timeoutMs || 120000);
        proc.stdout.on('data', function (d) { out += d.toString(); });
        proc.stderr.on('data', function (d) { err += d.toString(); });
        proc.on('error', function (e) { clearTimeout(timer); finish({ error: e.message }); });
        proc.on('close', function (code) { clearTimeout(timer); finish({ code: code, stdout: out, stderr: err }); });
      } catch (e) { resolve({ error: e.message }); }
    });
  }

  /* One-tap diagnostic: is ffmpeg found, can it read your mic, does it hear speech? */
  function testAudioEngine() {
    var box = $('mc-diag');
    box.classList.remove('hidden'); box.className = 'diag-out';
    box.textContent = 'Testing audio engine…';
    var report = [];
    _ffmpeg = null;
    var ff = resolveFfmpeg();
    report.push('ffmpeg: ' + (ff || 'NOT FOUND in common locations'));
    if (!ff) {
      report.push('\nFix: open Terminal, run  brew install ffmpeg  then tap Test again.');
      report.push('Or set the exact path in Settings → ffmpeg path.');
      box.textContent = report.join('\n');
      return;
    }
    runFfmpeg(ff, ['-version']).then(function (v) {
      if (v.error) { report.push('ffmpeg failed to launch: ' + v.error); box.textContent = report.join('\n'); return null; }
      report.push('version: ' + String(v.stdout || '').split('\n')[0]);
      return CPBridge.callHost('CP_getAudioTracks');
    }).then(function (r) {
      if (!r) return;
      var tracks = (r.audioTracks || []).filter(function (t) { return t.mediaPath; });
      if (!tracks.length) { report.push('No audio tracks with media found.'); box.textContent = report.join('\n'); return; }
      var t = tracks[0];
      report.push('\nReading first 60s of mic: ' + t.mediaPath);
      return runFfmpeg(ff, ['-hide_banner', '-nostats', '-t', '60', '-i', t.mediaPath,
        '-vn', '-ac', '1', '-af', 'silencedetect=noise=-40dB:d=0.3', '-f', 'null', '-'], 60000).then(function (res) {
        if (res.error) {
          report.push('COULD NOT RUN: ' + res.error);
        } else {
          report.push('exit code: ' + res.code);
          var sil = (String(res.stderr).match(/silence_start/g) || []).length;
          report.push('speech gaps detected: ' + sil + (sil ? '  ✅ working!' : '  ⚠️ none — check threshold/audio'));
          var dm = /Duration:\s*([\d:.]+)/.exec(res.stderr);
          if (dm) report.push('duration read: ' + dm[1]);
          report.push('\n--- ffmpeg output (tail) ---\n' + String(res.stderr).slice(-600));
        }
        box.textContent = report.join('\n');
      });
    }).catch(function (e) { report.push('ERROR: ' + e.message); box.textContent = report.join('\n'); });
  }

  function updateMcFfmpegBanner() {
    var el = $('mc-ffmpeg');
    if (!el) return;
    var src = $('mc-source').value;
    var needsAudio = (src === 'follow' || src === 'speech');
    if (!needsAudio) { el.classList.add('hidden'); return; }
    var ff = resolveFfmpeg();
    el.classList.remove('hidden');
    if (ff) {
      el.className = 'ff-banner ok';
      el.innerHTML = '✅ Audio engine ready (ffmpeg found). This mode can read your mics.';
    } else {
      el.className = 'ff-banner';
      el.innerHTML = '⚠️ <b>This mode needs ffmpeg</b> because your mics are inside video files ' +
        '(.MOV/.MP4), which Premiere\'s panel can\'t read on its own.<br>' +
        'Install it once — open Terminal and run: <code>brew install ffmpeg</code><br>' +
        'Then tap re-check. (Or set its path in Settings.)' +
        '<br><button class="chip-btn" id="mc-ff-recheck">↻ Re-check ffmpeg</button>';
      var btn = document.getElementById('mc-ff-recheck');
      if (btn) btn.addEventListener('click', function () { _ffmpeg = null; updateMcFfmpegBanner(); refreshFfmpegStatus(); });
    }
  }

  function syncMcSource() {
    var src = $('mc-source').value;
    $('mc-speaker-opts').classList.toggle('hidden', src !== 'follow');
    $('mc-main-opts').classList.toggle('hidden', src !== 'speech');
    $('mc-interval-wrap').classList.toggle('hidden', src !== 'interval');
    // the rotate/random pattern applies to everything except follow-the-speaker
    $('mc-pattern-opts').classList.toggle('hidden', src === 'follow');
    if (src === 'speech') populateMainTracks();
    if (src === 'follow') renderMcMap();
    updateMcFfmpegBanner();
  }
  $('mc-source').addEventListener('change', syncMcSource);
  $('mc-angles').addEventListener('change', function () {
    if ($('mc-source').value === 'follow') renderMcMap();
  });
  $('mc-center').addEventListener('input', function () {
    $('mc-center-val').textContent = (parseInt(this.value, 10) || 0) === 0 ? 'off' : this.value + 's';
  });
  syncMcSource();

  // cache the timeline's audio tracks (the per-speaker mics)
  function ensureAudioTracks() {
    if (state.mcAudioTracks) return Promise.resolve(state.mcAudioTracks);
    return CPBridge.callHost('CP_getAudioTracks').then(function (r) {
      state.mcAudioTracks = (r.audioTracks || []).filter(function (t) { return t.mediaPath; });
      state.mcAudioEnd = r.end || 0;
      if (!state.mcAudioTracks.length) throw new Error('No audio on the timeline.');
      return state.mcAudioTracks;
    });
  }

  function syncCenterCtrl() {
    var has = (state.mcMap || []).indexOf(-1) >= 0;
    $('mc-center-wrap').classList.toggle('hidden', !has);
  }

  /* Render a "V1 mic: [A1 ▾]" row per camera so the user maps mics manually. */
  function renderMcMap() {
    ensureAudioTracks().then(function (tracks) {
      var n = parseInt($('mc-angles').value, 10) || 2;
      var box = $('mc-map');
      box.innerHTML = '';
      state.mcMap = state.mcMap || [];
      for (var i = 0; i < n; i++) {
        var row = document.createElement('div');
        row.className = 'map-row';
        var lab = document.createElement('span');
        lab.className = 'map-cam';
        lab.textContent = 'V' + (i + 1);
        row.appendChild(lab);

        var sel = document.createElement('select');
        sel.dataset.angle = String(i);
        tracks.forEach(function (t, ti) {
          var o = document.createElement('option');
          o.value = String(ti);
          o.textContent = t.name || ('A' + (t.index + 1));
          sel.appendChild(o);
        });
        var oc = document.createElement('option');
        oc.value = '-1';
        oc.textContent = 'Center / wide (no mic)';
        sel.appendChild(oc);

        var def = (state.mcMap[i] != null) ? state.mcMap[i] : (i < tracks.length ? i : -1);
        sel.value = String(def);
        state.mcMap[i] = def;
        sel.addEventListener('change', function () {
          state.mcMap[parseInt(this.dataset.angle, 10)] = parseInt(this.value, 10);
          syncCenterCtrl();
        });
        row.appendChild(sel);
        box.appendChild(row);
      }
      state.mcMap.length = n;
      syncCenterCtrl();
    }).catch(function (e) {
      $('mc-map').innerHTML = '<p class="hint">' +
        (CPBridge.isCEP() ? 'No audio tracks found yet. Add your audio, then reopen this tab.' :
         'Open inside Premiere to map your mics.') + '</p>';
    });
  }

  var _mainTracksLoaded = false;
  function populateMainTracks() {
    if (_mainTracksLoaded) return;
    ensureAudioTracks().then(function (tracks) {
      var sel = $('mc-main-track');
      sel.innerHTML = '';
      tracks.forEach(function (t, i) {
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = t.name || ('A' + (t.index + 1));
        sel.appendChild(o);
      });
      _mainTracksLoaded = true;
    }).catch(function () {});
  }
  $('mc-interval').addEventListener('input', function () { $('mc-interval-val').textContent = this.value; });
  $('mc-minseg').addEventListener('input', function () { $('mc-minseg-val').textContent = this.value; });

  /* Resolve switch-point segments for the pattern sources (not speaker).
     Returns a Promise of [{start,end}]. */
  function mcSegments() {
    var src = $('mc-source').value;
    if (src === 'smartcut') {
      if (!state.keepsSeq.length) {
        return Promise.reject(new Error('No Smart Cut points yet. Run Smart Cut, or pick another switch mode.'));
      }
      return Promise.resolve(state.keepsSeq);
    }
    if (src === 'markers') {
      return CPBridge.callHost('CP_getMarkers').then(function (r) {
        if (!r.times || r.times.length < 1) throw new Error('No timeline markers found. Add markers, or use "Every few seconds".');
        return CPMulticam.segmentsFromBoundaries(r.times, r.end || (state.env && state.env.endSeconds) || 0);
      });
    }
    return CPBridge.callHost('CP_getEnv').then(function (env) {
      state.env = env;
      var dur = env.endSeconds || 0;
      if (!(dur > 0)) throw new Error('The sequence looks empty. Add your clips to the timeline first.');
      return CPMulticam.segmentsByInterval(dur, parseFloat($('mc-interval').value) || 3);
    });
  }

  /* Analyze one audio track's speech regions (sequence time). */
  var MC_STEP = 0.2; // loudness window / grid resolution in seconds

  /* Get a mic's loudness envelope (Promise of {samples,duration}); ffmpeg only. */
  function micEnvelope(track) {
    var ff = resolveFfmpeg();
    if (!ff) return Promise.reject(new Error('ffmpeg is required to read audio — install it (brew install ffmpeg) and re-check in Settings.'));
    return CPAudio.ffmpegEnvelope(track.mediaPath, ff, MC_STEP);
  }

  /* Resample a mic envelope onto the shared sequence-time grid. A mic clip's
     inPoint is the sync offset: sequence time 0 = media time inPoint. */
  function envToSeqGrid(env, track, nWindows) {
    var grid = new Array(nWindows);
    var s = env.samples || [];
    for (var k = 0; k < nWindows; k++) {
      var mediaT = k * MC_STEP + (track.inPoint || 0);
      var idx = Math.round(mediaT / MC_STEP);
      grid[k] = (idx >= 0 && idx < s.length) ? s[idx].db : -100;
    }
    return grid;
  }

  /* "Switch on speech": one main/mixed mic → cut at each talk burst. */
  function mcSpeechBurstSegments() {
    return ensureAudioTracks().then(function (tracks) {
      var idx = parseInt($('mc-main-track').value, 10) || 0;
      var track = tracks[idx] || tracks[0];
      var dur = state.mcAudioEnd || (state.env && state.env.endSeconds) || 0;
      capMcProgress('Listening to ' + (track.name || 'the main track') + '…');
      return micEnvelope(track).then(function (env) {
        capMcProgress(null);
        var starts = CPMulticam.burstStarts(env.samples, { offset: 8, minGap: 0.6 })
          .map(function (mt) { return mt - (track.inPoint || 0); })   // media → sequence time
          .filter(function (t) { return t > 0.3 && t < dur; });
        var segs = CPMulticam.segmentsFromBoundaries(starts, dur);
        if (segs.length < 2) throw new Error('Couldn\'t hear distinct talk bursts on that track. Try the "Every few seconds" mode.');
        return segs;
      });
    });
  }

  /* FireCut-style: cut to whoever is LOUDEST, using the manual mic→camera map.
     Relative loudness beats fixed silence thresholds on mics with room tone. */
  function mcSpeakerPlan(numAngles) {
    return ensureAudioTracks().then(function (tracks) {
      var map = state.mcMap || [];
      var dur = state.mcAudioEnd || (state.env && state.env.endSeconds) || 0;
      var center = -1;
      var micFor = [];   // angle → track (or null for center)
      for (var i = 0; i < numAngles; i++) {
        var mi = (map[i] != null) ? map[i] : (i < tracks.length ? i : -1);
        if (mi < 0 || !tracks[mi]) { if (center < 0) center = i; micFor.push(null); }
        else micFor.push(tracks[mi]);
      }
      var micCount = micFor.filter(function (t) { return t; }).length;
      if (micCount < 1) throw new Error('Assign at least one camera to a mic (V1 → A1, …).');

      capMcProgress('Listening to ' + micCount + ' mic' + (micCount > 1 ? 's' : '') + '…');
      var jobs = micFor.map(function (t) { return t ? micEnvelope(t) : Promise.resolve(null); });
      return Promise.all(jobs).then(function (envs) {
        capMcProgress('Working out who is talking…');
        var nWin = Math.ceil(dur / MC_STEP);
        var dbGrids = [];
        for (var a = 0; a < numAngles; a++) {
          dbGrids.push(envs[a] ? envToSeqGrid(envs[a], micFor[a], nWin) : []);
        }
        var regions = CPMulticam.loudnessToRegions(dbGrids, MC_STEP, { gate: -50, margin: 2 });
        capMcProgress(null);
        var minSeg = parseFloat($('mc-minseg').value) || 1.2;
        return CPMulticam.directorPlan(regions, dur, {
          minSegment: minSeg,
          wideAngle: center,
          wideOnSilence: center >= 0,
          centerEvery: parseInt($('mc-center').value, 10) || 0,
          centerHold: Math.max(1.2, minSeg)
        });
      });
    });
  }

  function capMcProgress(msg) {
    var el = $('mc-progress');
    if (!el) return;
    if (msg == null) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden'); el.textContent = msg;
  }

  function patternPlan(numAngles, segmentsPromise) {
    return segmentsPromise.then(function (segments) {
      if (!segments.length) throw new Error('Could not work out any switch points.');
      return CPMulticam.buildAnglePlan(segments, numAngles, {
        mode: state.mcMode,
        holdCuts: parseInt($('mc-hold').value, 10),
        minSegmentForSwitch: 0.4,
        seed: Date.now() & 0xffff
      });
    });
  }

  $('btn-mc-plan').addEventListener('click', function () {
    var numAngles = parseInt($('mc-angles').value, 10);
    var src = $('mc-source').value;
    var planner;
    if (src === 'follow') planner = mcSpeakerPlan(numAngles);
    else if (src === 'speech') planner = patternPlan(numAngles, mcSpeechBurstSegments());
    else planner = patternPlan(numAngles, mcSegments());

    planner.then(function (plan) {
      if (!plan || !plan.length) return toast('No camera switches were produced.', true);
      state.plan = plan;
      renderMcPlan(numAngles);
    }).catch(function (e) {
      capMcProgress(null);
      toast(e.message, true);
      var box = $('mc-diag');
      box.classList.remove('hidden'); box.className = 'diag-out err';
      box.textContent = 'Build failed:\n' + e.message + '\n\nTap "Test audio engine" to check ffmpeg.';
    });
  });

  $('btn-mc-test').addEventListener('click', testAudioEngine);

  function renderMcPlan(numAngles) {
    var stats = CPMulticam.planStats(state.plan, numAngles);
    var view = $('mc-plan-view');
    view.innerHTML = '';
    state.plan.forEach(function (p, i) {
      var item = document.createElement('div');
      item.className = 'seg-item';
      var chip = document.createElement('span');
      chip.className = 'angle-chip';
      chip.textContent = 'V' + (p.angle + 1);
      item.appendChild(chip);
      var span = document.createElement('span');
      span.textContent = '#' + (i + 1) + '  ' + fmt(p.start) + ' → ' + fmt(p.end);
      item.appendChild(span);
      view.appendChild(item);
    });
    $('mc-plan-card').classList.remove('hidden');
    $('btn-mc-apply').classList.remove('hidden');
    toast(stats.segments + ' segments, ' + stats.switches + ' camera switches planned.');
  }

  $('btn-mc-apply').addEventListener('click', function () {
    if (!state.plan) return;
    CPBridge.callHost('CP_applyMulticamPlan', {
      plan: state.plan,
      numAngles: parseInt($('mc-angles').value, 10),
      dropFrame: !!settings.dropFrame
    }).then(function (r) {
      toast('🎬 Multicam applied — ' + r.razored + ' cuts, ' + r.toggled +
            ' angle toggles across ' + r.tracksUsed + ' tracks.');
    }).catch(function (e) { toast('Multicam failed: ' + e.message, true); });
  });

  // =========================================================== SETTINGS ====
  function refreshFfmpegStatus() {
    _ffmpeg = null; // re-probe
    var ff = resolveFfmpeg();
    var el = $('ffmpeg-status');
    if (ff) { el.textContent = '✅ ffmpeg found: ' + ff; el.className = 'hint'; }
    else { el.textContent = '⚠️ No ffmpeg found. Multicam & Smart Cut can\'t read audio inside ' +
            'video files without it. Install ffmpeg (e.g. "brew install ffmpeg") or set its path below.'; el.className = 'hint'; }
  }

  $('btn-ffmpeg-pick').addEventListener('click', function () {
    var path = pickFile('Locate the ffmpeg binary', []);
    if (path) $('set-ffmpeg').value = path;
  });

  $('btn-save-settings').addEventListener('click', function () {
    settings.ffmpegPath = $('set-ffmpeg').value.trim();
    settings.dropFrame = $('set-dropframe').checked;
    saveSettings();
    refreshFfmpegStatus();
    toast('Settings saved.');
  });

  // ----------------------------------------------------- diagnostics ----
  var diagButtons = document.querySelectorAll('#tab-settings [data-diag]');
  for (var d = 0; d < diagButtons.length; d++) {
    diagButtons[d].addEventListener('click', function () {
      var fn = this.dataset.diag;
      var out = $('diag-out');
      out.className = 'diag-out';
      out.textContent = 'Running ' + fn + '…';
      if (!CPBridge.isCEP()) { out.textContent = 'Not running inside Premiere.'; return; }
      CPBridge.callHost(fn).then(function (r) {
        out.className = 'diag-out';
        out.textContent = fn + ' →\n' + JSON.stringify(r, null, 2);
      }).catch(function (e) {
        out.className = 'diag-out err';
        out.textContent = fn + ' FAILED →\n' + e.message;
      });
    });
  }
  $('btn-diag-copy').addEventListener('click', function () {
    var t = $('diag-out').textContent;
    try {
      var ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      toast('Diagnostics copied — paste them to me.');
    } catch (e) { toast('Select the text and copy manually.', true); }
  });

  /* One button that gathers everything: connection, ffmpeg + a real mic
     read, a caption-template field list, and transcript status. */
  $('btn-diag-full').addEventListener('click', function () {
    var out = $('diag-out');
    out.className = 'diag-out';
    var R = ['CutPilot ' + ($('ver') ? $('ver').textContent : '') + ' — full diagnostic', ''];
    function show() { out.textContent = R.join('\n'); }
    if (!CPBridge.isCEP()) { out.textContent = 'Not running inside Premiere.'; return; }
    show();

    var ff = resolveFfmpeg();
    R.push('1) ffmpeg: ' + (ff || 'NOT FOUND — run  brew install ffmpeg'));
    show();

    CPBridge.callHost('CP_getEnv').then(function (env) {
      R.push('2) sequence: "' + env.sequenceName + '" ' + env.width + 'x' + env.height +
             ', V' + env.videoTracks + '/A' + env.audioTracks + ', ' + Math.round(env.endSeconds) + 's');
      show();
      return CPBridge.callHost('CP_getAudioTracks');
    }).then(function (r) {
      var tracks = (r.audioTracks || []).filter(function (t) { return t.mediaPath; });
      R.push('3) mics on audio tracks: ' + tracks.length);
      tracks.forEach(function (t) { R.push('     ' + t.name + ' → ' + t.mediaPath.split('/').pop()); });
      show();
      if (ff && tracks.length) {
        R.push('   testing ffmpeg on first 60s of ' + tracks[0].name + '…'); show();
        return runFfmpeg(ff, ['-hide_banner', '-nostats', '-t', '60', '-i', tracks[0].mediaPath,
          '-vn', '-ac', '1', '-af', 'silencedetect=noise=-40dB:d=0.3', '-f', 'null', '-'], 60000).then(function (res) {
          if (res.error) R.push('   ❌ ffmpeg could not run: ' + res.error);
          else if (res.timedOut) R.push('   ⏱️ timed out at 60s — drive may be slow, but ffmpeg works');
          else {
            var sil = (String(res.stderr).match(/silence_start/g) || []).length;
            R.push('   exit ' + res.code + ', speech gaps: ' + sil + (sil ? '  ✅ multicam audio works' : '  ⚠️ no gaps detected'));
          }
          show();
        });
      } else if (!ff) { R.push('   (skipped mic test — no ffmpeg)'); show(); }
    }).then(function () {
      // inspect a caption template's fields
      var capTpl = (state.installedMogrts || []).filter(function (m) { return /caption/i.test(m.category) || /caption/i.test(m.name); })[0];
      if (!capTpl) { R.push('4) MOGRT: no caption template found to inspect'); show(); return null; }
      R.push('4) inspecting MOGRT "' + capTpl.name + '"…'); show();
      return CPBridge.callHost('CP_inspectMogrt', { path: capTpl.path }).then(function (ins) {
        if (!ins.props || !ins.props.length) R.push('   no editable fields found');
        else ins.props.forEach(function (p) { R.push('   field: "' + p.name + '" [' + p.type + ']' + (p.type === 'string' ? ' = ' + p.sample : '')); });
        show();
      }).catch(function (e) { R.push('   inspect failed: ' + e.message); show(); });
    }).then(function () {
      R.push('5) transcript: ' + (state.transcript ? ('✅ ' + state.transcript.label) : '⚠️ none loaded — captions need one (Window→Text→Transcribe→export SRT)'));
      R.push('', 'Done. Tap "Copy results" and send this to support.');
      show();
    }).catch(function (e) { R.push('ERROR: ' + e.message); show(); });
  });

  refreshFfmpegStatus();

  boot();
})();
