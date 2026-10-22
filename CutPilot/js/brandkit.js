/*
 * brandkit.js — 🏷 Brand kit: your channel's look, saved once, used everywhere.
 *
 * Settings → Brand kit keeps the channel name, a logo, the brand colour,
 * the brand font and the words to colour (channel / product names). Then:
 *   · captions: "Brand" in the style editor puts the brand font on the style,
 *     the brand colour on the spoken word, and colours the brand words;
 *   · Safe zone: "My branding" starts with this name and logo;
 *   · Publish kit: the pinned comment and description know the channel name.
 * Kept on this computer (localStorage); the logo is kept small (256 px).
 */
(function () {
  'use strict';
  var KEY = 'cutpilot.brandKit';
  function $(id) { return document.getElementById(id); }
  function K() { return window.CPKit || null; }

  function load() {
    try { var k = JSON.parse(localStorage.getItem(KEY) || 'null'); return (k && typeof k === 'object') ? k : {}; } catch (e) { return {}; }
  }
  function save(k) { try { localStorage.setItem(KEY, JSON.stringify(k)); return true; } catch (e) { return false; } }
  /* The kit, cleaned: a #rrggbb colour, words as a list, nothing empty. */
  function normalize(k) {
    k = k || {};
    var col = /^#[0-9a-f]{6}$/i.test(String(k.accent || '')) ? String(k.accent) : null;
    var words = (Array.isArray(k.words) ? k.words : String(k.words || '').split(','))
      .map(function (w) { return String(w).trim(); }).filter(Boolean).slice(0, 20);
    return { channel: String(k.channel || '').trim().slice(0, 40), accent: col, font: String(k.font || '').trim() || null,
             words: words, logo: (typeof k.logo === 'string' && /^data:image\//.test(k.logo)) ? k.logo : null };
  }
  function get() { return normalize(load()); }
  function isSet(k) { k = k || get(); return !!(k.channel || k.accent || k.font || k.logo || k.words.length); }

  /* A picked image as a small PNG data URL (fits in settings). */
  function shrinkLogo(file, cb) {
    var rd = new FileReader();
    rd.onload = function () {
      var img = new Image();
      img.onload = function () {
        var s = Math.min(1, 256 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        cb(c.toDataURL('image/png'));
      };
      img.onerror = function () { cb(null); };
      img.src = rd.result;
    };
    rd.onerror = function () { cb(null); };
    rd.readAsDataURL(file);
  }

  function fill() {
    var k = get();
    if ($('bk-channel')) $('bk-channel').value = k.channel;
    if ($('bk-accent')) $('bk-accent').value = k.accent || '#ffd400';
    if ($('bk-font')) $('bk-font').value = k.font || '';
    if ($('bk-words')) $('bk-words').value = k.words.join(', ');
    var im = $('bk-logo-img');
    if (im) { if (k.logo) { im.src = k.logo; im.classList.remove('hidden'); } else im.classList.add('hidden'); }
    if ($('bk-logo-clear')) $('bk-logo-clear').classList.toggle('hidden', !k.logo);
  }
  function update(patch) {
    var k = load(), p;
    for (p in patch) if (patch.hasOwnProperty(p)) k[p] = patch[p];
    save(normalize(k)); fill();
  }

  /* "Brand" in the caption editor. */
  function applyToCaption() {
    var kit = K(), k = get();
    if (!kit) return;
    if (!isSet(k)) return kit.toast('Set up your brand first: Settings → Brand kit.', true);
    if (kit.applyBrand && kit.applyBrand(k)) kit.toast('🏷 Your brand is on this style' + (k.font ? ' — ' + k.font : '') + '. ＋ Save keeps it as your own style.');
  }

  function fonts() {
    var sel = $('bk-font'); if (!sel || sel.options.length > 1) return;
    var list = (window.CPCaptions && CPCaptions.FONTS) || [];
    list.forEach(function (f) { var o = document.createElement('option'); o.value = f; o.textContent = f; sel.appendChild(o); });
  }

  function wire() {
    fonts(); fill();
    if ($('bk-channel')) $('bk-channel').addEventListener('change', function () { update({ channel: this.value }); });
    if ($('bk-accent')) $('bk-accent').addEventListener('change', function () { update({ accent: this.value }); });
    if ($('bk-font')) $('bk-font').addEventListener('change', function () { update({ font: this.value }); });
    if ($('bk-words')) $('bk-words').addEventListener('change', function () { update({ words: this.value }); });
    if ($('bk-logo-pick')) $('bk-logo-pick').addEventListener('click', function () {
      var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp';
      inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0]; if (!f) return;
        shrinkLogo(f, function (url) { if (url) update({ logo: url }); else if (K()) K().toast('That picture could not be read — try a PNG or JPG.', true); });
      });
      inp.click();
    });
    if ($('bk-logo-clear')) $('bk-logo-clear').addEventListener('click', function () { update({ logo: null }); });
    if ($('btn-brand-tpl')) $('btn-brand-tpl').addEventListener('click', applyToCaption);
  }

  window.CPBrand = { get: get, isSet: isSet, normalize: normalize, applyToCaption: applyToCaption, _save: function (k) { save(normalize(k)); fill(); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
