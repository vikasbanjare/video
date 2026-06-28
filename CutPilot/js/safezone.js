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
    channel: '', title: '', handle: true, guide: false, env: null, logo: null, logoName: ''
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

  // ---------- high-fidelity platform icons (x,y = centre, r = radius) ----------
  function igHeart(c, x, y, r, fill) {
    c.beginPath();
    c.moveTo(x, y + r * 0.92);
    c.bezierCurveTo(x - r * 1.45, y - r * 0.12, x - r * 0.92, y - r * 1.2, x, y - r * 0.42);
    c.bezierCurveTo(x + r * 0.92, y - r * 1.2, x + r * 1.45, y - r * 0.12, x, y + r * 0.92);
    c.closePath(); fill ? c.fill() : c.stroke();
  }
  function igComment(c, x, y, r, fill) {           // rounded speech bubble + small tail
    c.beginPath();
    if (c.ellipse) c.ellipse(x, y - r * 0.08, r, r * 0.9, 0, 0, Math.PI * 2); else c.arc(x, y, r, 0, Math.PI * 2);
    fill ? c.fill() : c.stroke();
    c.beginPath(); c.moveTo(x - r * 0.55, y + r * 0.55); c.lineTo(x - r * 0.78, y + r * 1.05); c.lineTo(x - r * 0.12, y + r * 0.78);
    c.closePath(); fill ? c.fill() : c.stroke();
  }
  function igPlane(c, x, y, r) {                    // paper-plane share (outline)
    c.beginPath();
    c.moveTo(x - r * 1.05, y - r * 0.35); c.lineTo(x + r * 1.05, y - r * 1.0);
    c.lineTo(x + r * 0.15, y + r * 1.05); c.lineTo(x - r * 0.02, y + r * 0.2); c.closePath(); c.stroke();
    c.beginPath(); c.moveTo(x - r * 1.05, y - r * 0.35); c.lineTo(x - r * 0.02, y + r * 0.2);
    c.lineTo(x + r * 1.05, y - r * 1.0); c.stroke();
  }
  function ytThumb(c, x, y, r, down) {              // YouTube thumbs up/down (filled)
    c.save(); c.translate(x, y); if (down) c.rotate(Math.PI);
    c.beginPath(); rr(c, -r * 1.0, -r * 0.05, r * 0.5, r * 1.0, r * 0.1); c.fill();   // sleeve
    c.beginPath();
    c.moveTo(-r * 0.42, r * 0.9); c.lineTo(-r * 0.42, -r * 0.05); c.lineTo(-r * 0.02, -r * 0.05);
    c.lineTo(r * 0.18, -r * 0.95); c.quadraticCurveTo(r * 0.55, -r * 1.08, r * 0.48, -r * 0.4);
    c.lineTo(r * 0.42, -r * 0.12); c.lineTo(r * 0.98, -r * 0.12);
    c.quadraticCurveTo(r * 1.12, -r * 0.06, r * 0.96, r * 0.28);
    c.lineTo(r * 0.72, r * 0.78); c.quadraticCurveTo(r * 0.6, r * 0.9, r * 0.32, r * 0.9);
    c.closePath(); c.fill(); c.restore();
  }
  function ytShare(c, x, y, r) {                    // YouTube share (bent reply arrow, outline)
    c.beginPath();
    c.moveTo(x - r * 1.1, y + r * 0.85);
    c.quadraticCurveTo(x - r * 0.9, y - r * 0.55, x + r * 0.15, y - r * 0.55);
    c.stroke();
    c.beginPath(); c.moveTo(x - r * 0.2, y - r * 1.05); c.lineTo(x + r * 0.9, y - r * 0.55);
    c.lineTo(x - r * 0.2, y - r * 0.05); c.closePath(); c.fill();
  }
  function ytRemix(c, x, y, r) {                    // two looping arrows
    c.beginPath(); c.arc(x, y, r * 0.78, Math.PI * 0.15, Math.PI * 1.15); c.stroke();
    c.beginPath(); c.arc(x, y, r * 0.78, Math.PI * 1.15, Math.PI * 2.15); c.stroke();
    c.beginPath(); c.moveTo(x + r * 0.55, y - r * 0.78); c.lineTo(x + r * 0.95, y - r * 0.55); c.lineTo(x + r * 0.5, y - r * 0.25); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(x - r * 0.55, y + r * 0.78); c.lineTo(x - r * 0.95, y + r * 0.55); c.lineTo(x - r * 0.5, y + r * 0.25); c.closePath(); c.fill();
  }
  function ttBookmark(c, x, y, r) {                 // TikTok bookmark (filled)
    c.beginPath(); c.moveTo(x - r * 0.65, y - r); c.lineTo(x + r * 0.65, y - r);
    c.lineTo(x + r * 0.65, y + r); c.lineTo(x, y + r * 0.35); c.lineTo(x - r * 0.65, y + r); c.closePath(); c.fill();
  }
  function ttShare(c, x, y, r) {                    // TikTok share (filled curved arrow)
    c.beginPath();
    c.moveTo(x - r * 1.0, y + r * 0.9); c.quadraticCurveTo(x - r * 0.7, y - r * 0.5, x + r * 0.15, y - r * 0.5);
    c.lineTo(x + r * 0.15, y - r); c.lineTo(x + r * 1.1, y - r * 0.1); c.lineTo(x + r * 0.15, y + r * 0.8);
    c.lineTo(x + r * 0.15, y + r * 0.3); c.quadraticCurveTo(x - r * 0.45, y + r * 0.3, x - r * 0.7, y + r * 0.95);
    c.closePath(); c.fill();
  }
  function icPlus(c, x, y, s) { c.beginPath(); c.moveTo(x - s, y); c.lineTo(x + s, y); c.moveTo(x, y - s); c.lineTo(x, y + s); c.stroke(); }
  function icSearch(c, x, y, s) { c.beginPath(); c.arc(x - s * 0.18, y - s * 0.18, s * 0.62, 0, Math.PI * 2); c.stroke(); c.beginPath(); c.moveTo(x + s * 0.32, y + s * 0.32); c.lineTo(x + s * 0.85, y + s * 0.85); c.stroke(); }
  function icDots(c, x, y, s) { for (var i = -1; i <= 1; i++) { c.beginPath(); c.arc(x + i * s * 0.85, y, s * 0.22, 0, Math.PI * 2); c.fill(); } }
  function icMusic(c, x, y, r) { c.beginPath(); c.arc(x - r * 0.55, y + r * 0.55, r * 0.4, 0, Math.PI * 2); c.arc(x + r * 0.55, y + r * 0.25, r * 0.4, 0, Math.PI * 2); c.fill(); c.lineWidth = Math.max(1.2, r * 0.18); c.beginPath(); c.moveTo(x - r * 0.18, y + r * 0.55); c.lineTo(x - r * 0.18, y - r * 0.7); c.lineTo(x + r * 0.92, y - r); c.lineTo(x + r * 0.92, y + r * 0.25); c.stroke(); }
  function icHome(c, x, y, s, fill) { c.beginPath(); c.moveTo(x - s, y + s * 0.15); c.lineTo(x, y - s * 0.9); c.lineTo(x + s, y + s * 0.15); c.closePath(); fill ? c.fill() : c.stroke(); c.beginPath(); rr(c, x - s * 0.72, y + s * 0.1, s * 1.44, s * 0.85, s * 0.12); fill ? c.fill() : c.stroke(); }
  function avatar(c, x, y, r, ring) {
    if (ring) { c.save(); var g = c.createLinearGradient(x - r, y - r, x + r, y + r); g.addColorStop(0, '#feda75'); g.addColorStop(.5, '#d62976'); g.addColorStop(1, '#962fbf'); c.strokeStyle = g; c.lineWidth = r * 0.18; c.beginPath(); c.arc(x, y, r * 1.12, 0, Math.PI * 2); c.stroke(); c.restore(); }
    c.save(); var gg = c.createLinearGradient(x - r, y - r, x + r, y + r); gg.addColorStop(0, '#8a93a6'); gg.addColorStop(1, '#5a6273'); c.fillStyle = gg; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.restore();
  }

  /* Draw authentic platform chrome (guide). col = right action column. */
  function drawPlatformUI(c, W, H, pf) {
    var unit = Math.min(W, H);
    var ico = unit * 0.05;                  // icon radius (bigger, clearer)
    var lw = Math.max(2.5, unit * 0.0075);
    var colX = W - unit * 0.085;
    var gap = unit * 0.135;                 // vertical spacing between action items
    c.save();
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.textAlign = 'center'; c.textBaseline = 'top';
    c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = unit * 0.012;
    function lbl(x, y, t, sz) { c.save(); c.fillStyle = '#fff'; c.font = '700 ' + Math.round(unit * (sz || 0.028)) + 'px Inter, system-ui, sans-serif'; c.fillText(t, x, y); c.restore(); }
    function setW() { c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = lw; }

    if (pf === 'reels') {
      var y0 = H * 0.50;
      setW(); igHeart(c, colX, y0, ico, false); lbl(colX, y0 + ico * 1.25, '1,618');
      igComment(c, colX, y0 + gap, ico, false); lbl(colX, y0 + gap + ico * 1.25, '31');
      igPlane(c, colX, y0 + gap * 2, ico); lbl(colX, y0 + gap * 2 + ico * 1.25, '1,095');
      icDots(c, colX, y0 + gap * 3, ico * 0.7);
      // audio album thumbnail (spinning)
      c.save(); c.fillStyle = '#3a3a3a'; rr(c, colX - ico * 0.85, y0 + gap * 3.55, ico * 1.7, ico * 1.7, ico * 0.5); c.fill();
      c.fillStyle = '#fff'; c.translate(colX, y0 + gap * 3.55 + ico * 0.85); c.scale(0.5, 0.5); icMusic(c, 0, 0, ico); c.restore();
      brandRowMock(c, W, H, unit, 'cauldythe.app', 'A social network for the independent thinker.', 'Sponsored', 'follow', true);
      navBar(c, W, H, unit, 'reels');
    } else if (pf === 'shorts') {
      setW(); icSearch(c, W - unit * 0.16, H * 0.075, ico * 0.85); icDots(c, W - unit * 0.06, H * 0.075, ico * 0.7);
      var y1 = H * 0.46;
      ytThumb(c, colX, y1, ico, false); lbl(colX, y1 + ico * 1.3, '1M');
      ytThumb(c, colX, y1 + gap, ico, true); lbl(colX, y1 + gap + ico * 1.3, 'Dislike');
      igComment(c, colX, y1 + gap * 2, ico, true); lbl(colX, y1 + gap * 2 + ico * 1.3, '11K');
      ytShare(c, colX, y1 + gap * 3, ico); lbl(colX, y1 + gap * 3 + ico * 1.3, 'Share');
      ytRemix(c, colX, y1 + gap * 4, ico); lbl(colX, y1 + gap * 4 + ico * 1.3, 'Remix');
      brandRowMock(c, W, H, unit, '@Skinnyfromthe9', '#shorts', '', 'subscribe', false);
      navBar(c, W, H, unit, 'shorts');
    } else if (pf === 'tiktok') {
      var y2 = H * 0.44;
      avatar(c, colX, y2, ico * 0.95, false);
      c.save(); c.fillStyle = '#fe2c55'; c.beginPath(); c.arc(colX, y2 + ico * 1.05, ico * 0.42, 0, Math.PI * 2); c.fill(); setW(); c.lineWidth = lw * 0.7; icPlus(c, colX, y2 + ico * 1.05, ico * 0.2); c.restore();
      setW();
      igHeart(c, colX, y2 + gap * 1.05, ico, true); lbl(colX, y2 + gap * 1.05 + ico * 1.3, '328.7K');
      igComment(c, colX, y2 + gap * 2.05, ico, true); lbl(colX, y2 + gap * 2.05 + ico * 1.3, '1,204');
      ttBookmark(c, colX, y2 + gap * 3.05, ico); lbl(colX, y2 + gap * 3.05 + ico * 1.3, '45.1K');
      ttShare(c, colX, y2 + gap * 4.05, ico); lbl(colX, y2 + gap * 4.05 + ico * 1.3, 'Share');
      // spinning record disc
      c.save(); c.fillStyle = '#1c1c1c'; c.beginPath(); c.arc(colX, y2 + gap * 5.0, ico * 1.0, 0, Math.PI * 2); c.fill(); c.fillStyle = '#fff'; c.beginPath(); c.arc(colX, y2 + gap * 5.0, ico * 0.28, 0, Math.PI * 2); c.fill(); c.restore();
      brandRowMock(c, W, H, unit, '@skinnyfromthe9', 'this is my caption  ♪ original sound', '', 'follow', false);
      navBar(c, W, H, unit, 'tiktok');
    }
    c.restore();
  }

  // bottom channel + caption row (over the video)
  function brandRowMock(c, W, H, unit, handle, caption, tag, btn, withRing) {
    c.save();
    c.textAlign = 'left'; c.textBaseline = 'middle'; c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = unit * 0.012;
    var x = W * 0.045, y = H * 0.835, av = unit * 0.04;
    avatar(c, x + av, y, av, withRing);
    c.fillStyle = '#fff'; c.font = '800 ' + Math.round(unit * 0.034) + 'px Inter, system-ui, sans-serif';
    var hx = x + av * 2 + unit * 0.02;
    c.fillText(handle, hx, y - unit * 0.005);
    // verified tick
    var vw = c.measureText(handle).width;
    c.save(); c.fillStyle = '#3897f0'; c.beginPath(); c.arc(hx + vw + unit * 0.022, y - unit * 0.005, unit * 0.016, 0, Math.PI * 2); c.fill(); c.fillStyle = '#fff'; c.lineWidth = unit * 0.004; c.strokeStyle = '#fff'; c.beginPath(); c.moveTo(hx + vw + unit * 0.014, y - unit * 0.005); c.lineTo(hx + vw + unit * 0.020, y + unit * 0.001); c.lineTo(hx + vw + unit * 0.030, y - unit * 0.013); c.stroke(); c.restore();
    // follow / subscribe pill
    if (btn) {
      var pillX = hx + vw + unit * 0.05, pw = unit * (btn === 'subscribe' ? 0.20 : 0.15), ph = unit * 0.05;
      if (btn === 'subscribe') { c.fillStyle = '#fff'; rr(c, pillX, y - ph / 2, pw, ph, ph / 2); c.fill(); c.fillStyle = '#111'; }
      else { c.strokeStyle = '#fff'; c.lineWidth = Math.max(1.5, unit * 0.0035); rr(c, pillX, y - ph / 2, pw, ph, ph / 2); c.stroke(); c.fillStyle = '#fff'; }
      c.textAlign = 'center'; c.font = '800 ' + Math.round(unit * 0.027) + 'px Inter, system-ui, sans-serif';
      c.fillText(btn === 'subscribe' ? 'Subscribe' : 'Follow', pillX + pw / 2, y); c.textAlign = 'left';
    }
    c.font = '500 ' + Math.round(unit * 0.03) + 'px Inter, system-ui, sans-serif'; c.fillStyle = 'rgba(255,255,255,0.95)';
    c.fillText(caption.slice(0, 36), x, y + unit * 0.052);
    if (tag) { c.fillStyle = 'rgba(255,255,255,0.7)'; c.font = '500 ' + Math.round(unit * 0.026) + 'px Inter, system-ui, sans-serif'; c.fillText(tag, x, y + unit * 0.092); }
    c.restore();
  }

  // bottom navigation bar (over the video)
  function navBar(c, W, H, unit, pf) {
    c.save();
    var ny = H - unit * 0.045, isz = unit * 0.032;
    if (pf === 'reels' || pf === 'tiktok') { c.fillStyle = 'rgba(16,16,20,0.62)'; rr(c, 0, ny - unit * 0.05, W, unit * 0.1 + (H - (ny + unit * 0.05)), 0); c.fill(); }
    c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = Math.max(2, unit * 0.0055);
    c.shadowColor = 'rgba(0,0,0,0.4)'; c.shadowBlur = unit * 0.006;
    c.textAlign = 'center'; c.textBaseline = 'top'; c.font = '500 ' + Math.round(unit * 0.018) + 'px Inter, system-ui, sans-serif';
    var xs = [0.1, 0.3, 0.5, 0.7, 0.9];
    var labels = pf === 'shorts' ? ['Home', 'Shorts', '', 'Subs', 'You'] : (pf === 'tiktok' ? ['Home', 'Friends', '', 'Inbox', 'Profile'] : ['', '', '', '', '']);
    for (var i = 0; i < xs.length; i++) {
      var x = W * xs[i];
      if (i === 2) {   // centre create button (white rounded rect with +)
        c.save(); c.fillStyle = '#fff'; rr(c, x - unit * 0.05, ny - unit * 0.018, unit * 0.1, unit * 0.04, unit * 0.012); c.fill();
        if (pf === 'tiktok') { c.fillStyle = '#fe2c55'; rr(c, x - unit * 0.062, ny - unit * 0.018, unit * 0.024, unit * 0.04, unit * 0.01); c.fill(); c.fillStyle = '#25f4ee'; rr(c, x + unit * 0.038, ny - unit * 0.018, unit * 0.024, unit * 0.04, unit * 0.01); c.fill(); c.fillStyle = '#fff'; rr(c, x - unit * 0.05, ny - unit * 0.018, unit * 0.1, unit * 0.04, unit * 0.012); c.fill(); }
        c.strokeStyle = '#111'; c.lineWidth = unit * 0.006; icPlus(c, x, ny, unit * 0.013); c.restore();
        if (labels[i]) lbl2(c, x, ny + unit * 0.028, labels[i], unit);
        continue;
      }
      c.strokeStyle = '#fff'; c.fillStyle = '#fff'; c.lineWidth = Math.max(2, unit * 0.0055);
      if (i === 0) icHome(c, x, ny, isz, pf === 'reels');
      else if (i === 4) avatar(c, x, ny, isz * 0.85, false);
      else { rr(c, x - isz * 0.78, ny - isz * 0.78, isz * 1.56, isz * 1.56, isz * 0.32); c.stroke(); }
      if (labels[i]) lbl2(c, x, ny + unit * 0.028, labels[i], unit);
    }
    c.restore();
  }
  function lbl2(c, x, y, t, unit) { c.save(); c.fillStyle = 'rgba(255,255,255,0.92)'; c.textAlign = 'center'; c.textBaseline = 'top'; c.font = '500 ' + Math.round(unit * 0.017) + 'px Inter, system-ui, sans-serif'; c.shadowBlur = 0; c.fillText(t, x, y); c.restore(); }

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
    // Include the platform-UI guide in the exported clip only if the user opted in
    // (a reference layer they hide before final export); otherwise branding only.
    draw(cv.getContext('2d'), d.w, d.h, !!state.guide);
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
    if ($('sz-guide')) $('sz-guide').addEventListener('change', function () { state.guide = this.checked; });
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
