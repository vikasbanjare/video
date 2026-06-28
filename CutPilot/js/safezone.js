/*
 * Pulse — Safe Zone & Branding tab.
 *
 * Draws an AUTHENTIC mock of each platform's on-screen UI (TikTok / Instagram
 * Reels / YouTube Shorts) — the real action-button column, captions row, channel
 * row and bottom nav — so creators see exactly where the app's chrome will cover
 * their video and keep content + branding clear of it. The platform chrome is a
 * preview-only GUIDE (never exported). The creator's branding (logo / handle /
 * title, or a Pulse default) is composited into the safe area and IS exported as
 * one transparent overlay (via CP_placeOverlay).
 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  var state = {
    platform: 'reels', brandMode: 'pulse', titlePos: 'bottom', dur: '5',
    channel: '', title: '', handle: true, env: null, logo: null, logoName: ''
  };

  // The safe area = the central region left clear once each platform's UI is drawn.
  var SAFE = {
    none:   { top: 0.06, bottom: 0.08, left: 0.05, right: 0.05 },
    tiktok: { top: 0.10, bottom: 0.16, left: 0.04, right: 0.20 },
    reels:  { top: 0.12, bottom: 0.16, left: 0.04, right: 0.20 },
    shorts: { top: 0.12, bottom: 0.15, left: 0.04, right: 0.20 }
  };
  var PF_LABEL = { tiktok: 'TikTok', reels: 'Instagram Reels', shorts: 'YouTube Shorts', none: '' };

  function envDims() {
    var w = (state.env && +state.env.width) || 1080, h = (state.env && +state.env.height) || 1920;
    return { w: w, h: h };
  }

  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // ---------- icons (cx,cy = centre, s = half-size) ----------
  function icHeartOutline(c, x, y, s, fill) {
    c.beginPath();
    c.moveTo(x, y + s * 0.75);
    c.bezierCurveTo(x - s * 1.3, y - s * 0.2, x - s * 0.55, y - s * 1.05, x, y - s * 0.3);
    c.bezierCurveTo(x + s * 0.55, y - s * 1.05, x + s * 1.3, y - s * 0.2, x, y + s * 0.75);
    c.closePath(); fill ? c.fill() : c.stroke();
  }
  function icCommentOutline(c, x, y, s, fill) {
    c.save(); c.beginPath();
    c.ellipse ? c.ellipse(x, y - s * 0.1, s, s * 0.8, 0, 0, Math.PI * 2) : c.arc(x, y - s * 0.1, s, 0, Math.PI * 2);
    fill ? c.fill() : c.stroke();
    c.beginPath(); c.moveTo(x - s * 0.45, y + s * 0.5); c.lineTo(x - s * 0.1, y + s * 0.95); c.lineTo(x + s * 0.1, y + s * 0.55);
    c.closePath(); fill ? c.fill() : c.stroke(); c.restore();
  }
  function icPlane(c, x, y, s) {   // instagram share / paper plane
    c.beginPath();
    c.moveTo(x - s, y - s * 0.55); c.lineTo(x + s, y - s); c.lineTo(x + s * 0.1, y + s);
    c.lineTo(x - s * 0.1, y + s * 0.1); c.closePath(); c.stroke();
    c.beginPath(); c.moveTo(x - s, y - s * 0.55); c.lineTo(x - s * 0.1, y + s * 0.1); c.stroke();
  }
  function icThumbUp(c, x, y, s, down) {
    c.save(); c.translate(x, y); if (down) c.scale(1, -1);
    c.beginPath();                                  // cuff
    rr(c, -s, -s * 0.05, s * 0.55, s, s * 0.12); c.fill();
    c.beginPath();                                  // hand
    c.moveTo(-s * 0.35, -s * 0.05); c.lineTo(-s * 0.35, -s * 0.55);
    c.bezierCurveTo(-s * 0.35, -s * 1.05, s * 0.2, -s * 1.25, s * 0.18, -s * 0.6);
    c.lineTo(s, -s * 0.6); c.bezierCurveTo(s * 1.15, -s * 0.55, s * 1.1, s * 0.05, s * 0.9, s * 0.1);
    c.lineTo(-s * 0.05, s * 0.1); c.lineTo(-s * 0.35, -s * 0.05); c.closePath(); c.fill();
    c.restore();
  }
  function icShareArrow(c, x, y, s) {   // youtube share — bent arrow
    c.beginPath(); c.moveTo(x - s, y + s * 0.7); c.bezierCurveTo(x - s * 0.6, y - s * 0.3, x + s * 0.2, y - s * 0.5, x + s * 0.55, y - s * 0.5);
    c.stroke();
    c.beginPath(); c.moveTo(x + s * 0.1, y - s); c.lineTo(x + s, y - s * 0.5); c.lineTo(x + s * 0.1, y); c.stroke();
  }
  function icRemix(c, x, y, s) {        // two looping arrows
    c.beginPath(); c.arc(x, y, s * 0.8, Math.PI * 0.2, Math.PI * 1.25); c.stroke();
    c.beginPath(); c.arc(x, y, s * 0.8, Math.PI * 1.2, Math.PI * 2.25); c.stroke();
    c.beginPath(); c.moveTo(x + s * 0.8, y - s * 0.4); c.lineTo(x + s * 0.75, y + s * 0.15); c.lineTo(x + s * 1.25, y - s * 0.05); c.closePath(); c.fill();
  }
  function icBookmark(c, x, y, s) {
    c.beginPath(); c.moveTo(x - s * 0.7, y - s); c.lineTo(x + s * 0.7, y - s); c.lineTo(x + s * 0.7, y + s);
    c.lineTo(x, y + s * 0.35); c.lineTo(x - s * 0.7, y + s); c.closePath(); c.fill();
  }
  function icPlus(c, x, y, s) { c.beginPath(); c.moveTo(x - s, y); c.lineTo(x + s, y); c.moveTo(x, y - s); c.lineTo(x, y + s); c.stroke(); }
  function icSearch(c, x, y, s) { c.beginPath(); c.arc(x - s * 0.15, y - s * 0.15, s * 0.6, 0, Math.PI * 2); c.stroke(); c.beginPath(); c.moveTo(x + s * 0.35, y + s * 0.35); c.lineTo(x + s * 0.8, y + s * 0.8); c.stroke(); }
  function icDots(c, x, y, s) { for (var i = -1; i <= 1; i++) { c.beginPath(); c.arc(x + i * s * 0.7, y, s * 0.2, 0, Math.PI * 2); c.fill(); } }
  function icHome(c, x, y, s) { c.beginPath(); c.moveTo(x - s, y + s * 0.2); c.lineTo(x, y - s); c.lineTo(x + s, y + s * 0.2); c.stroke(); c.strokeRect(x - s * 0.65, y + s * 0.2, s * 1.3, s * 0.85); }

  function num(n) { return n; }

  // draw a right-column action item: icon + count label
  function colItem(c, x, y, label, drawIcon, opt) {
    opt = opt || {};
    c.save();
    c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = opt.lw || Math.max(2, x * 0.0); // set by caller scale
    c.restore();
  }

  /* Draw the authentic platform chrome (guide). unit = min(W,H). */
  function drawPlatformUI(c, W, H, pf) {
    var unit = Math.min(W, H);
    var ico = unit * 0.038;                 // icon half-size
    var lw = Math.max(2, unit * 0.006);
    var colX = W - W * 0.10;                 // right action column
    c.save();
    c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = lw; c.lineJoin = 'round'; c.lineCap = 'round';
    c.textAlign = 'center'; c.textBaseline = 'top';
    c.font = '700 ' + Math.round(unit * 0.026) + 'px Inter, system-ui, sans-serif';
    c.shadowColor = 'rgba(0,0,0,0.45)'; c.shadowBlur = unit * 0.01;

    function label(x, y, t) { c.save(); c.fillStyle = '#fff'; c.fillText(t, x, y); c.restore(); }

    if (pf === 'reels') {
      var ys = [0.58, 0.665, 0.75], counts = ['1,618', '31', '1,095'];
      // heart, comment, plane (outline style)
      c.fillStyle = 'none';
      c.strokeStyle = '#fff';
      icHeartOutline(c, colX, H * ys[0], ico, false); label(colX, H * ys[0] + ico, counts[0]);
      icCommentOutline(c, colX, H * ys[1], ico, false); label(colX, H * ys[1] + ico, counts[1]);
      icPlane(c, colX, H * ys[2], ico); label(colX, H * ys[2] + ico, counts[2]);
      c.fillStyle = '#fff'; icDots(c, colX, H * 0.83, ico * 0.8);
      // audio thumbnail
      rr(c, colX - ico * 0.8, H * 0.87, ico * 1.6, ico * 1.6, ico * 0.4); c.lineWidth = lw; c.stroke();
      // bottom caption row (left)
      brandRowMock(c, W, H, unit, 'cauldythe.app', 'A social network for the independent thinker.', 'Sponsored', false);
      navBar(c, W, H, unit, 'reels');
    } else if (pf === 'shorts') {
      // top-right search + menu
      c.fillStyle = '#fff'; c.strokeStyle = '#fff';
      icSearch(c, W * 0.86, H * 0.085, ico); icDots(c, W * 0.94, H * 0.085, ico * 0.7);
      var sy = [0.55, 0.63, 0.71, 0.79, 0.86], sc = ['1m', '', '11k', '', '2'];
      c.fillStyle = '#fff'; icThumbUp(c, colX, H * sy[0], ico, false); label(colX, H * sy[0] + ico, sc[0]);
      icThumbUp(c, colX, H * sy[1], ico, true); label(colX, H * sy[1] + ico, 'Dislike');
      icCommentOutline(c, colX, H * sy[2], ico, true); label(colX, H * sy[2] + ico, sc[2]);
      c.strokeStyle = '#fff'; icShareArrow(c, colX, H * sy[3], ico); label(colX, H * sy[3] + ico, 'Share');
      icRemix(c, colX, H * sy[4], ico); label(colX, H * sy[4] + ico, sc[4]);
      brandRowMock(c, W, H, unit, '@Skinnyfromthe9', '#shorts', '', true);
      navBar(c, W, H, unit, 'shorts');
    } else if (pf === 'tiktok') {
      // avatar + plus
      var ax = colX, ay = H * 0.52;
      c.save(); c.fillStyle = '#bbb'; c.beginPath(); c.arc(ax, ay, ico * 1.1, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#fe2c55'; c.beginPath(); c.arc(ax, ay + ico * 1.1, ico * 0.45, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#fff'; c.lineWidth = lw * 0.8; icPlus(c, ax, ay + ico * 1.1, ico * 0.22); c.restore();
      var ty = [0.63, 0.71, 0.79, 0.87], tc = ['328.7K', '1.2K', '45.1K', 'Share'];
      c.fillStyle = '#fff';
      icHeartOutline(c, colX, H * ty[0], ico, true); label(colX, H * ty[0] + ico, tc[0]);
      icCommentOutline(c, colX, H * ty[1], ico, true); label(colX, H * ty[1] + ico, tc[1]);
      icBookmark(c, colX, H * ty[2], ico); label(colX, H * ty[2] + ico, tc[2]);
      c.strokeStyle = '#fff'; icShareArrow(c, colX, H * ty[3], ico); label(colX, H * ty[3] + ico, tc[3]);
      // spinning disc
      c.save(); c.fillStyle = '#222'; c.beginPath(); c.arc(colX, H * 0.945, ico * 1.05, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#fff'; c.beginPath(); c.arc(colX, H * 0.945, ico * 0.3, 0, Math.PI * 2); c.fill(); c.restore();
      brandRowMock(c, W, H, unit, '@skinnyfromthe9', 'this is my caption 🎵 original sound', '', true);
      navBar(c, W, H, unit, 'tiktok');
    }
    c.restore();
  }

  // bottom-left channel/caption row that each app shows over the video
  function brandRowMock(c, W, H, unit, handle, caption, tag, withSub) {
    c.save();
    c.textAlign = 'left'; c.textBaseline = 'middle'; c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = unit * 0.012;
    var x = W * 0.05, y = H * 0.84;
    c.fillStyle = '#ccc'; c.beginPath(); c.arc(x + unit * 0.035, y, unit * 0.035, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#fff'; c.font = '800 ' + Math.round(unit * 0.032) + 'px Inter, system-ui, sans-serif';
    c.fillText(handle, x + unit * 0.085, y - unit * 0.004);
    if (withSub) {
      c.font = '800 ' + Math.round(unit * 0.026) + 'px Inter, system-ui, sans-serif';
      var sw = c.measureText(handle).width + unit * 0.085 + unit * 0.02;
      c.strokeStyle = '#fff'; c.lineWidth = Math.max(1.5, unit * 0.004);
      rr(c, x + sw, y - unit * 0.026, unit * 0.16, unit * 0.052, unit * 0.026); c.stroke();
      c.fillStyle = '#fff'; c.textAlign = 'center'; c.fillText('Subscribe', x + sw + unit * 0.08, y);
      c.textAlign = 'left';
    }
    c.font = '500 ' + Math.round(unit * 0.028) + 'px Inter, system-ui, sans-serif';
    c.fillStyle = 'rgba(255,255,255,0.92)';
    c.fillText(caption.slice(0, 38), x, y + unit * 0.05);
    if (tag) { c.fillStyle = 'rgba(255,255,255,0.7)'; c.fillText(tag, x, y + unit * 0.09); }
    c.restore();
  }

  // bottom navigation bar mock per platform
  function navBar(c, W, H, unit, pf) {
    c.save();
    var ny = H - H * 0.035, isz = unit * 0.03;
    c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = Math.max(2, unit * 0.005); c.lineJoin = 'round'; c.lineCap = 'round';
    c.shadowColor = 'rgba(0,0,0,0.4)'; c.shadowBlur = unit * 0.008;
    if (pf === 'reels' || pf === 'tiktok') {
      // pill background
      c.save(); c.shadowBlur = 0; c.fillStyle = 'rgba(20,20,24,0.55)';
      rr(c, W * 0.06, ny - unit * 0.045, W * 0.88, unit * 0.085, unit * 0.045); c.fill(); c.restore();
    }
    var xs = [0.16, 0.34, 0.5, 0.66, 0.84];
    for (var i = 0; i < xs.length; i++) {
      var x = W * xs[i];
      if (i === 2 && (pf === 'shorts' || pf === 'tiktok')) {   // centre create button
        c.save(); c.fillStyle = '#fff'; rr(c, x - unit * 0.045, ny - unit * 0.022, unit * 0.09, unit * 0.044, unit * 0.012); c.fill();
        c.strokeStyle = '#111'; c.lineWidth = unit * 0.006; icPlus(c, x, ny, unit * 0.014); c.restore(); continue;
      }
      c.strokeStyle = '#fff'; c.fillStyle = '#fff';
      if (i === 0) icHome(c, x, ny, isz);
      else if (i === 4) { c.beginPath(); c.arc(x, ny, isz * 0.8, 0, Math.PI * 2); c.stroke(); }
      else { rr(c, x - isz * 0.7, ny - isz * 0.7, isz * 1.4, isz * 1.4, isz * 0.3); c.stroke(); }
    }
    c.restore();
  }

  /* Master draw. guides → also draw the platform chrome + dashed safe box. */
  function draw(ctx, W, H, guides) {
    ctx.clearRect(0, 0, W, H);
    var s = SAFE[state.platform] || SAFE.none;
    var inL = s.left * W, inR = s.right * W, inT = s.top * H, inB = s.bottom * H;
    var safeX = inL, safeY = inT, safeW = W - inL - inR, safeH = H - inT - inB;
    var unit = Math.min(W, H);

    if (guides && state.platform !== 'none') {
      drawPlatformUI(ctx, W, H, state.platform);
      ctx.save();
      ctx.strokeStyle = 'rgba(80,170,255,0.95)'; ctx.lineWidth = Math.max(1.5, unit * 0.004);
      ctx.setLineDash([unit * 0.02, unit * 0.015]);
      ctx.strokeRect(safeX, safeY, safeW, safeH); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(130,195,255,0.95)';
      ctx.font = '600 ' + Math.round(unit * 0.028) + 'px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('SAFE AREA · ' + (PF_LABEL[state.platform] || ''), safeX + unit * 0.015, safeY + unit * 0.012);
      ctx.restore();
    }

    // ---- creator branding (logo + handle + title) — composited into the safe area ----
    var pulse = (state.brandMode === 'pulse');
    var channel = pulse ? 'Pulse' : (state.channel || '');
    if (state.handle && (channel || state.logo || pulse)) {
      var bx = safeX + safeW * 0.01, by = safeY + (guides ? unit * 0.05 : safeH * 0.02), badge = unit * 0.08;
      ctx.save();
      if (state.logo) { ctx.save(); rr(ctx, bx, by, badge, badge, badge * 0.28); ctx.clip(); try { ctx.drawImage(state.logo, bx, by, badge, badge); } catch (e) {} ctx.restore(); }
      else {
        var g = ctx.createLinearGradient(bx, by, bx + badge, by + badge); g.addColorStop(0, '#7c5cff'); g.addColorStop(1, '#3d7dff');
        ctx.fillStyle = g; rr(ctx, bx, by, badge, badge, badge * 0.28); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '800 ' + Math.round(badge * 0.6) + 'px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(pulse ? 'P' : (channel ? channel.replace('@', '').charAt(0).toUpperCase() : 'P'), bx + badge / 2, by + badge / 2 + badge * 0.03);
      }
      var tx = bx + badge + unit * 0.02, ty = by + badge * 0.5;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = unit * 0.01;
      ctx.font = '800 ' + Math.round(unit * 0.04) + 'px Inter, system-ui, sans-serif';
      ctx.fillText(pulse ? 'Pulse' : (channel || 'Your channel'), tx, ty - unit * 0.016);
      ctx.font = '500 ' + Math.round(unit * 0.028) + 'px Inter, system-ui, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(pulse ? 'by aiFloh' : (channel && channel.charAt(0) !== '@' ? '@' + channel.toLowerCase().replace(/\s+/g, '') : ''), tx, ty + unit * 0.022);
      ctx.restore();
    }

    // ---- title / hook ----
    var title = pulse ? (state.title || 'Made with Pulse') : (state.title || '');
    if (title) {
      ctx.save();
      var fontSize = Math.round(unit * 0.07);
      ctx.font = '900 ' + fontSize + 'px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var maxW = safeW * 0.96, words = title.toUpperCase().split(/\s+/), lines = [], cur = '';
      for (var i = 0; i < words.length; i++) { var t = cur ? cur + ' ' + words[i] : words[i]; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = words[i]; } else cur = t; }
      if (cur) lines.push(cur);
      var lh = fontSize * 1.16, blockH = lines.length * lh;
      var cy0 = state.titlePos === 'top' ? (safeY + blockH * 0.6 + safeH * 0.05)
              : state.titlePos === 'center' ? (safeY + safeH * 0.46)
              : (safeY + safeH - blockH * 0.6 - safeH * 0.03);
      var cx = safeX + safeW / 2;
      ctx.lineJoin = 'round'; ctx.strokeStyle = '#000'; ctx.lineWidth = fontSize * 0.16; ctx.fillStyle = '#fff';
      for (var L = 0; L < lines.length; L++) { var yy = cy0 - blockH / 2 + lh * (L + 0.5); ctx.strokeText(lines[L], cx, yy); ctx.fillText(lines[L], cx, yy); }
      ctx.restore();
    }
  }

  function renderPreview() {
    var cv = $('sz-canvas'); if (!cv) return;
    var wrap = $('sz-preview-wrap'); var maxW = (wrap && wrap.clientWidth) || 300;
    var d = envDims(), ar = d.w / d.h, pw = maxW, ph = Math.round(pw / ar), maxH = 360;
    if (ph > maxH) { ph = maxH; pw = Math.round(ph * ar); }
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(pw * dpr); cv.height = Math.round(ph * dpr);
    cv.style.width = pw + 'px'; cv.style.height = ph + 'px';
    var ctx = cv.getContext('2d');
    var bg = ctx.createLinearGradient(0, 0, 0, cv.height); bg.addColorStop(0, '#2a3340'); bg.addColorStop(1, '#10141c');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height);
    draw(ctx, cv.width, cv.height, true);
  }
  function renderOverlayPng() {
    var d = envDims(), cv = document.createElement('canvas'); cv.width = d.w; cv.height = d.h;
    draw(cv.getContext('2d'), d.w, d.h, false);
    return cv.toDataURL('image/png');
  }

  function seg(id, key, after) {
    var box = $(id); if (!box) return;
    var btns = box.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].addEventListener('click', function () {
      var on = box.querySelector('button.on'); if (on) on.classList.remove('on'); this.classList.add('on');
      state[key] = this.getAttribute('data-pf') || this.getAttribute('data-bm') || this.getAttribute('data-tp') || this.getAttribute('data-d');
      if (after) after(); renderPreview();
    });
  }
  function refreshCustomVisibility() { var box = $('sz-custom-fields'); if (box) box.classList.toggle('dim-disabled', state.brandMode === 'pulse'); }

  function wire() {
    seg('sz-platform', 'platform'); seg('sz-brandmode', 'brandMode', refreshCustomVisibility);
    seg('sz-titlepos', 'titlePos'); seg('sz-dur', 'dur');
    if ($('sz-channel')) $('sz-channel').addEventListener('input', function () { state.channel = this.value; renderPreview(); });
    if ($('sz-title')) $('sz-title').addEventListener('input', function () { state.title = this.value; renderPreview(); });
    if ($('sz-handle')) $('sz-handle').addEventListener('change', function () { state.handle = this.checked; renderPreview(); });
    if ($('sz-logo-pick')) $('sz-logo-pick').addEventListener('click', pickLogo);
    if ($('sz-logo-clear')) $('sz-logo-clear').addEventListener('click', function () {
      state.logo = null; state.logoName = ''; if ($('sz-logo-name')) $('sz-logo-name').textContent = 'no logo — a circle badge is used';
      $('sz-logo-clear').classList.add('hidden'); renderPreview();
    });
    if ($('sz-apply')) $('sz-apply').addEventListener('click', applyOverlay);
    // default platform highlight = reels
    var pf = $('sz-platform'); if (pf) { var on = pf.querySelector('button.on'); if (on) on.classList.remove('on'); var r = pf.querySelector('button[data-pf=reels]'); if (r) r.classList.add('on'); }
    refreshCustomVisibility();
  }

  function pickLogo() {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { var img = new Image(); img.onload = function () { state.logo = img; renderPreview(); }; img.src = rd.result; };
      rd.readAsDataURL(f); state.logoName = f.name;
      if ($('sz-logo-name')) $('sz-logo-name').textContent = f.name;
      if ($('sz-logo-clear')) $('sz-logo-clear').classList.remove('hidden');
    });
    inp.click();
  }

  function refreshEnv(cb) {
    if (window.CPBridge && CPBridge.isCEP && CPBridge.isCEP()) {
      CPBridge.callHost('CP_getEnv').then(function (env) { state.env = env; if (cb) cb(); renderPreview(); }).catch(function () { if (cb) cb(); renderPreview(); });
    } else { renderPreview(); }
  }

  function applyOverlay() {
    if (!(window.CPBridge && CPBridge.isCEP && CPBridge.isCEP())) { try { toast('Open this in Premiere to place the overlay.', true); } catch (e) {} return; }
    refreshEnv(function () {
      var fs, pathMod, osMod;
      try { fs = require('fs'); pathMod = require('path'); osMod = require('os'); } catch (e) { try { toast('Node unavailable: ' + e.message, true); } catch (e2) {} return; }
      var png = renderOverlayPng().split(',')[1];
      var dir = pathMod.join(osMod.tmpdir(), 'pulse-brand-' + Date.now());
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e0) {}
      var pngPath = pathMod.join(dir, 'brand.png');
      try { fs.writeFileSync(pngPath, Buffer.from(png, 'base64')); } catch (eW) { try { toast('Could not write overlay: ' + eW.message, true); } catch (e3) {} return; }
      var durSec = state.dur === 'full' ? Math.max(2, (state.env && +state.env.endSeconds) || 10) : (parseFloat(state.dur) || 5);
      var prog = $('sz-progress'); if (prog) { prog.classList.remove('hidden'); prog.textContent = 'Placing on timeline…'; }
      CPBridge.callHost('CP_placeOverlay', { path: pngPath, startSec: 0, durSec: durSec }).then(function (r) {
        if (prog) prog.classList.add('hidden');
        try { toast('🎉 Branding overlay added on V' + r.track + ' for ' + Math.round(durSec) + 's. ⌘Z/Ctrl+Z undoes it.'); } catch (e) {}
      }).catch(function (e) { if (prog) prog.classList.add('hidden'); try { toast('Place failed: ' + e.message, true); } catch (e2) {} });
    });
  }

  window.CPSafezone = { onShow: function () { refreshEnv(); }, render: renderPreview };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
