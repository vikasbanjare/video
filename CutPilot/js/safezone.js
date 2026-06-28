/*
 * Pulse — Safe Zone & Branding tab.
 *
 * Shows where each platform's on-screen UI (action buttons, caption, username)
 * sits on a 9:16 video, so creators keep their content + branding clear of it,
 * then composites their logo / channel handle / title (or a default Pulse brand)
 * into the safe area and drops it on the timeline as ONE transparent overlay
 * (via CP_placeOverlay). Pure canvas rendering — same draw routine for the live
 * preview (with dotted guides) and the exported overlay PNG (branding only).
 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  var state = {
    platform: 'none', brandMode: 'pulse', titlePos: 'bottom', dur: '5',
    channel: '', title: '', icons: true, handle: true,
    logo: null,          // HTMLImageElement once uploaded
    logoName: '', env: null
  };

  // Fraction insets of the area each platform's native UI occupies (9:16).
  // right = action-button column, bottom = caption/username, top = header.
  var SAFE = {
    none:   { top: 0.04, bottom: 0.06, left: 0.04, right: 0.04 },
    tiktok: { top: 0.08, bottom: 0.20, left: 0.04, right: 0.16 },
    reels:  { top: 0.10, bottom: 0.22, left: 0.05, right: 0.18 },
    shorts: { top: 0.08, bottom: 0.18, left: 0.04, right: 0.15 }
  };
  var PF_LABEL = { tiktok: 'TikTok', reels: 'Instagram Reels', shorts: 'YouTube Shorts', none: '' };

  function envDims() {
    var w = (state.env && +state.env.width) || 1080, h = (state.env && +state.env.height) || 1920;
    return { w: w, h: h };
  }

  /* Rounded-rect path helper. */
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawHeart(ctx, cx, cy, s) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + s * 0.35);
    ctx.bezierCurveTo(cx - s, cy - s * 0.3, cx - s * 0.5, cy - s, cx, cy - s * 0.35);
    ctx.bezierCurveTo(cx + s * 0.5, cy - s, cx + s, cy - s * 0.3, cx, cy + s * 0.35);
    ctx.closePath(); ctx.fill();
  }
  function drawBubble(ctx, cx, cy, s) {
    rr(ctx, cx - s, cy - s * 0.8, s * 2, s * 1.4, s * 0.5); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx - s * 0.3, cy + s * 0.5); ctx.lineTo(cx - s * 0.1, cy + s); ctx.lineTo(cx + s * 0.3, cy + s * 0.5); ctx.closePath(); ctx.fill();
  }
  function drawShare(ctx, cx, cy, s) {
    ctx.beginPath(); ctx.moveTo(cx - s, cy + s * 0.7); ctx.lineTo(cx + s, cy - s); ctx.lineTo(cx + s, cy + s * 0.2);
    ctx.lineTo(cx - s * 0.1, cy + s * 0.2); ctx.closePath(); ctx.fill();
  }

  /*
   * Draw the whole overlay onto ctx sized W×H.
   *  guides=true → also draw the dotted platform-safe-zone overlay (preview only).
   * Returns nothing; caller manages the canvas.
   */
  function draw(ctx, W, H, guides) {
    ctx.clearRect(0, 0, W, H);
    var s = SAFE[state.platform] || SAFE.none;
    var inL = s.left * W, inR = s.right * W, inT = s.top * H, inB = s.bottom * H;
    var safeX = inL, safeY = inT, safeW = W - inL - inR, safeH = H - inT - inB;
    var unit = Math.min(W, H);

    // ---- platform UI guides (NOT exported) ----
    if (guides && state.platform !== 'none') {
      ctx.save();
      ctx.fillStyle = 'rgba(10,12,20,0.34)';
      ctx.fillRect(0, 0, W, inT);
      ctx.fillRect(0, H - inB, W, inB);
      ctx.fillRect(0, 0, inL, H);
      ctx.fillRect(W - inR, 0, inR, H);
      ctx.strokeStyle = 'rgba(80,170,255,0.9)';
      ctx.lineWidth = Math.max(1.5, unit * 0.004);
      ctx.setLineDash([unit * 0.02, unit * 0.015]);
      ctx.strokeRect(safeX, safeY, safeW, safeH);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(120,190,255,0.95)';
      ctx.font = '600 ' + Math.round(unit * 0.03) + 'px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('SAFE AREA · ' + (PF_LABEL[state.platform] || ''), safeX + unit * 0.02, safeY + unit * 0.015);
      ctx.restore();
    }

    var pulse = (state.brandMode === 'pulse');
    var channel = pulse ? 'Pulse' : (state.channel || '');
    var handleTxt = pulse ? '⚡ by aiFloh' : (state.channel ? '' : '');

    // ---- top-left: logo badge + channel handle + Follow pill ----
    if (state.handle && (channel || state.logo || pulse)) {
      var bx = safeX + safeW * 0.01, by = safeY + safeH * 0.012;
      var badge = unit * 0.085;
      ctx.save();
      // logo badge
      if (state.logo) {
        ctx.save(); rr(ctx, bx, by, badge, badge, badge * 0.28); ctx.clip();
        try { ctx.drawImage(state.logo, bx, by, badge, badge); } catch (e) {}
        ctx.restore();
      } else {
        var grad = ctx.createLinearGradient(bx, by, bx + badge, by + badge);
        grad.addColorStop(0, '#7c5cff'); grad.addColorStop(1, '#3d7dff');
        ctx.fillStyle = grad; rr(ctx, bx, by, badge, badge, badge * 0.28); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '800 ' + Math.round(badge * 0.6) + 'px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(pulse ? 'P' : (channel ? channel.replace('@', '').charAt(0).toUpperCase() : 'P'), bx + badge / 2, by + badge / 2 + badge * 0.03);
      }
      // handle text
      var tx = bx + badge + unit * 0.022, ty = by + badge * 0.5;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = unit * 0.01;
      ctx.font = '800 ' + Math.round(unit * 0.042) + 'px Inter, system-ui, sans-serif';
      var nm = pulse ? 'Pulse' : (channel || 'Your channel');
      ctx.fillText(nm, tx, ty - unit * 0.018);
      ctx.font = '500 ' + Math.round(unit * 0.03) + 'px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      ctx.fillText(pulse ? 'by aiFloh' : (channel && channel.charAt(0) !== '@' ? '@' + channel.toLowerCase().replace(/\s+/g, '') : ''), tx, ty + unit * 0.024);
      // Follow pill
      ctx.shadowBlur = 0;
      var fw = unit * 0.16, fh = unit * 0.055, fx = tx, fy = ty + unit * 0.05;
      var fg = ctx.createLinearGradient(fx, fy, fx + fw, fy);
      fg.addColorStop(0, '#ff3b6b'); fg.addColorStop(1, '#ff6a3d');
      ctx.fillStyle = fg; rr(ctx, fx, fy, fw, fh, fh / 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '800 ' + Math.round(fh * 0.5) + 'px Inter, system-ui, sans-serif';
      ctx.fillText('Follow', fx + fw / 2, fy + fh / 2 + fh * 0.02);
      ctx.restore();
    }

    // ---- right column: like / comment / share icons ----
    if (state.icons) {
      var ix = safeX + safeW - unit * 0.02, iy = safeY + safeH * 0.5, gap = unit * 0.13, isz = unit * 0.05;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = unit * 0.012;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      var labels = ['1.2M', '8.4K', 'Share'];
      [['heart', '#ff3b6b'], ['bubble', '#ffffff'], ['share', '#ffffff']].forEach(function (it, k) {
        var cy = iy + (k - 1) * gap;
        ctx.fillStyle = it[1];
        if (it[0] === 'heart') drawHeart(ctx, ix, cy, isz);
        else if (it[0] === 'bubble') drawBubble(ctx, ix, cy, isz);
        else drawShare(ctx, ix, cy, isz);
        ctx.fillStyle = '#fff'; ctx.font = '700 ' + Math.round(unit * 0.026) + 'px Inter, system-ui, sans-serif';
        ctx.fillText(labels[k], ix, cy + isz + unit * 0.01);
      });
      ctx.restore();
    }

    // ---- title / hook ----
    var title = pulse ? (state.title || 'Made with Pulse') : (state.title || '');
    if (title) {
      ctx.save();
      var fontSize = Math.round(unit * 0.072);
      ctx.font = '900 ' + fontSize + 'px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // Reserve the right-hand icon column (when shown) so the title never collides
      // with the like/comment/share icons — centre the title in the remaining width.
      var iconsW = state.icons ? unit * 0.18 : 0;
      var titleAreaW = safeW - iconsW;
      var maxW = titleAreaW * 0.94, words = title.toUpperCase().split(/\s+/), lines = [], cur = '';
      for (var i = 0; i < words.length; i++) {
        var test = cur ? cur + ' ' + words[i] : words[i];
        if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = words[i]; } else cur = test;
      }
      if (cur) lines.push(cur);
      var lh = fontSize * 1.16, blockH = lines.length * lh;
      var cy0 = state.titlePos === 'top' ? (safeY + blockH * 0.6 + safeH * 0.04)
              : state.titlePos === 'center' ? (safeY + safeH * 0.5)
              : (safeY + safeH - blockH * 0.6 - safeH * 0.04);
      var cx = safeX + titleAreaW / 2;
      ctx.lineJoin = 'round'; ctx.strokeStyle = '#000'; ctx.lineWidth = fontSize * 0.16;
      ctx.fillStyle = '#fff';
      for (var L = 0; L < lines.length; L++) {
        var yy = cy0 - blockH / 2 + lh * (L + 0.5);
        ctx.strokeText(lines[L], cx, yy); ctx.fillText(lines[L], cx, yy);
      }
      ctx.restore();
    }
  }

  function renderPreview() {
    var cv = $('sz-canvas'); if (!cv) return;
    var wrap = $('sz-preview-wrap'); var maxW = (wrap && wrap.clientWidth) || 300;
    var d = envDims(), ar = d.w / d.h;
    var pw = maxW, ph = Math.round(pw / ar);
    var maxH = 320; if (ph > maxH) { ph = maxH; pw = Math.round(ph * ar); }
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(pw * dpr); cv.height = Math.round(ph * dpr);
    cv.style.width = pw + 'px'; cv.style.height = ph + 'px';
    var ctx = cv.getContext('2d');
    // checker-ish dark "video" background so white branding is visible
    var bg = ctx.createLinearGradient(0, 0, 0, cv.height);
    bg.addColorStop(0, '#1a2130'); bg.addColorStop(1, '#0c0f17');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height);
    draw(ctx, cv.width, cv.height, true);
  }

  /* Render the EXPORT overlay (branding only, transparent, full sequence res) to a
     PNG data URL. */
  function renderOverlayPng() {
    var d = envDims();
    var cv = document.createElement('canvas'); cv.width = d.w; cv.height = d.h;
    var ctx = cv.getContext('2d');
    draw(ctx, d.w, d.h, false);   // no guides
    return cv.toDataURL('image/png');
  }

  // ---------- wiring ----------
  function seg(id, key, after) {
    var box = $(id); if (!box) return;
    var btns = box.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].addEventListener('click', function () {
      var on = box.querySelector('button.on'); if (on) on.classList.remove('on');
      this.classList.add('on');
      state[key] = this.getAttribute('data-pf') || this.getAttribute('data-bm') || this.getAttribute('data-tp') || this.getAttribute('data-d');
      if (after) after();
      renderPreview();
    });
  }

  function refreshCustomVisibility() {
    var box = $('sz-custom-fields'); if (box) box.classList.toggle('dim-disabled', state.brandMode === 'pulse');
  }

  function wire() {
    seg('sz-platform', 'platform');
    seg('sz-brandmode', 'brandMode', refreshCustomVisibility);
    seg('sz-titlepos', 'titlePos');
    seg('sz-dur', 'dur');
    if ($('sz-channel')) $('sz-channel').addEventListener('input', function () { state.channel = this.value; renderPreview(); });
    if ($('sz-title')) $('sz-title').addEventListener('input', function () { state.title = this.value; renderPreview(); });
    if ($('sz-icons')) $('sz-icons').addEventListener('change', function () { state.icons = this.checked; renderPreview(); });
    if ($('sz-handle')) $('sz-handle').addEventListener('change', function () { state.handle = this.checked; renderPreview(); });

    if ($('sz-logo-pick')) $('sz-logo-pick').addEventListener('click', pickLogo);
    if ($('sz-logo-clear')) $('sz-logo-clear').addEventListener('click', function () {
      state.logo = null; state.logoName = '';
      if ($('sz-logo-name')) $('sz-logo-name').textContent = 'no logo — a circle badge is used';
      $('sz-logo-clear').classList.add('hidden'); renderPreview();
    });
    if ($('sz-apply')) $('sz-apply').addEventListener('click', applyOverlay);
    refreshCustomVisibility();
  }

  function pickLogo() {
    // Use a hidden file input (works in CEP's Chromium). Accept common image types.
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var img = new Image();
        img.onload = function () { state.logo = img; renderPreview(); };
        img.src = rd.result;
      };
      rd.readAsDataURL(f);
      state.logoName = f.name;
      if ($('sz-logo-name')) $('sz-logo-name').textContent = f.name;
      if ($('sz-logo-clear')) $('sz-logo-clear').classList.remove('hidden');
    });
    inp.click();
  }

  function refreshEnv(cb) {
    if (window.CPBridge && CPBridge.isCEP && CPBridge.isCEP()) {
      CPBridge.callHost('CP_getEnv').then(function (env) { state.env = env; if (cb) cb(); renderPreview(); })
        .catch(function () { if (cb) cb(); renderPreview(); });
    } else { renderPreview(); }
  }

  function applyOverlay() {
    if (!(window.CPBridge && CPBridge.isCEP && CPBridge.isCEP())) { try { toast('Open this in Premiere to place the overlay.', true); } catch (e) {} return; }
    refreshEnv(function () {
      var fs, pathMod, cpMod, osMod;
      try { fs = require('fs'); pathMod = require('path'); cpMod = require('child_process'); osMod = require('os'); }
      catch (e) { try { toast('Node unavailable: ' + e.message, true); } catch (e2) {} return; }
      var d = envDims();
      var png = renderOverlayPng().split(',')[1];
      var dir = pathMod.join(osMod.tmpdir(), 'pulse-brand-' + Date.now());
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e0) {}
      var pngPath = pathMod.join(dir, 'brand.png');
      try { fs.writeFileSync(pngPath, Buffer.from(png, 'base64')); } catch (eW) { try { toast('Could not write overlay: ' + eW.message, true); } catch (e3) {} return; }

      var durSec = state.dur === 'full' ? Math.max(2, (state.env && +state.env.endSeconds) || 10) : (parseFloat(state.dur) || 5);
      var prog = $('sz-progress'); if (prog) { prog.classList.remove('hidden'); prog.textContent = 'Placing on timeline…'; }
      // Place the transparent PNG as ONE clip, held for the chosen duration, on a
      // fresh top track (CP_placeOverlay sets the clip end from durSec).
      CPBridge.callHost('CP_placeOverlay', { path: pngPath, startSec: 0, durSec: durSec }).then(function (r) {
        if (prog) prog.classList.add('hidden');
        try { toast('🎉 Branding overlay added on V' + r.track + ' for ' + Math.round(durSec) + 's. ⌘Z/Ctrl+Z undoes it.'); } catch (e) {}
      }).catch(function (e) { if (prog) prog.classList.add('hidden'); try { toast('Place failed: ' + e.message, true); } catch (e2) {} });
    });
  }

  // expose a hook so main.js can refresh the preview when the tab is shown
  window.CPSafezone = { onShow: function () { refreshEnv(); }, render: renderPreview };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
