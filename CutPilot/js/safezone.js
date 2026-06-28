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
    mode: 'safezones',                 // 'safezones' | 'custom'
    platform: 'reels', alsoCustom: false,
    rows: 3, cols: 3, margin: 5, gutter: 0,
    ov: { margin: false, thirds: true, cross: false, action: false, title: false, diag: false },
    brandMode: 'none', titlePos: 'bottom', dur: 'full',
    channel: '', title: '', handle: true, opacity: 70, replace: true,
    env: null, logo: null, logoName: ''
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
    // Show the CREATOR's own logo + handle here — this is where the platform shows
    // it — when they've set them; otherwise the platform's sample data.
    var useUser = (state.brandMode === 'custom' && (state.channel || state.logo));
    if (state.brandMode === 'pulse') handle = 'Pulse';
    else if (useUser && state.channel) handle = state.channel;
    if (state.brandMode === 'custom' && state.logo) { c.save(); c.beginPath(); c.arc(x + av, y, av, 0, Math.PI * 2); c.clip(); try { c.drawImage(state.logo, x, y - av, av * 2, av * 2); } catch (e) {} c.restore(); }
    else avatar(c, x + av, y, av, withRing);
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

  // the central area to keep content/branding inside (platform safe zone, or margins)
  function safeRect(W, H) {
    if (state.mode === 'safezones' && state.platform !== 'none') {
      var s = SAFE[state.platform] || SAFE.none;
      return { x: s.left * W, y: s.top * H, w: W - (s.left + s.right) * W, h: H - (s.top + s.bottom) * H };
    }
    var m = (state.margin || 0) / 100;
    return { x: m * W, y: m * H, w: W * (1 - 2 * m), h: H * (1 - 2 * m) };
  }

  function dashBox(c, x, y, w, h, unit, lbl) {
    c.save();
    c.strokeStyle = 'rgba(80,170,255,0.95)'; c.lineWidth = Math.max(1.5, unit * 0.004);
    c.setLineDash([unit * 0.02, unit * 0.015]); c.strokeRect(x, y, w, h); c.setLineDash([]);
    if (lbl) { c.fillStyle = 'rgba(130,195,255,0.95)'; c.font = '600 ' + Math.round(unit * 0.026) + 'px Inter, system-ui, sans-serif'; c.textAlign = 'left'; c.textBaseline = 'top'; c.fillText(lbl, x + unit * 0.014, y + unit * 0.012); }
    c.restore();
  }

  // Custom rows×columns grid with margins + gutter (Guideify-style)
  function drawGrid(c, W, H, unit) {
    var m = (state.margin || 0) / 100, g = (state.gutter || 0) / 100;
    var gx = m * W, gy = m * H, gw = W * (1 - 2 * m), gh = H * (1 - 2 * m);
    var rows = Math.max(0, state.rows | 0), cols = Math.max(0, state.cols | 0);
    c.save(); c.strokeStyle = 'rgba(90,200,255,0.85)'; c.lineWidth = Math.max(1, unit * 0.0028);
    if (rows > 0 || cols > 0) c.strokeRect(gx, gy, gw, gh);
    var gutX = g * W, gutY = g * H;
    if (cols > 0) { var cw = (gw - gutX * (cols - 1)) / cols; for (var i = 0; i < cols; i++) { var x0 = gx + i * (cw + gutX); if (i > 0) { c.strokeRect(x0 - gutX, gy, gutX, gh); } if (i < cols - 1 || gutX === 0) { var lx = gx + (i + 1) * cw + i * gutX; if (i < cols - 1) { c.beginPath(); c.moveTo(lx, gy); c.lineTo(lx, gy + gh); c.stroke(); } } } }
    if (rows > 0) { var rh = (gh - gutY * (rows - 1)) / rows; for (var j = 0; j < rows - 1; j++) { var ly = gy + (j + 1) * rh + j * gutY; c.beginPath(); c.moveTo(gx, ly); c.lineTo(gx + gw, ly); c.stroke(); } }
    c.restore();
  }

  // The 6 Guideify overlay toggles
  function drawOverlays(c, W, H, unit) {
    var o = state.ov || {};
    c.save(); c.lineWidth = Math.max(1, unit * 0.003);
    function box(frac, col) { var ix = (1 - frac) / 2 * W, iy = (1 - frac) / 2 * H; c.strokeStyle = col; c.strokeRect(ix, iy, W * frac, H * frac); }
    if (o.action) box(0.90, 'rgba(255,210,90,0.9)');
    if (o.title) box(0.80, 'rgba(255,150,90,0.9)');
    if (o.margin) { var mm = (state.margin || 5) / 100; c.strokeStyle = 'rgba(120,230,150,0.9)'; c.strokeRect(mm * W, mm * H, W * (1 - 2 * mm), H * (1 - 2 * mm)); }
    if (o.thirds) { c.strokeStyle = 'rgba(255,255,255,0.55)'; for (var i = 1; i <= 2; i++) { c.beginPath(); c.moveTo(W * i / 3, 0); c.lineTo(W * i / 3, H); c.stroke(); c.beginPath(); c.moveTo(0, H * i / 3); c.lineTo(W, H * i / 3); c.stroke(); } }
    if (o.diag) { c.strokeStyle = 'rgba(255,255,255,0.45)'; c.beginPath(); c.moveTo(0, 0); c.lineTo(W, H); c.moveTo(W, 0); c.lineTo(0, H); c.stroke(); }
    if (o.cross) { c.strokeStyle = 'rgba(255,255,255,0.8)'; var cl = unit * 0.04; c.beginPath(); c.moveTo(W / 2 - cl, H / 2); c.lineTo(W / 2 + cl, H / 2); c.moveTo(W / 2, H / 2 - cl); c.lineTo(W / 2, H / 2 + cl); c.stroke(); }
    c.restore();
  }

  /* The ONLY thing a creator actually burns into the video is a title/hook. Their
     logo + channel are shown by the platform itself (the bottom-left channel row of
     the guide), not a fake badge — so we don't draw a top-left logo here anymore. */
  function drawBranding(c, W, H, unit) {
    if (state.brandMode === 'none') return;
    var sr = safeRect(W, H);
    var title = state.title || '';
    if (title) {
      c.save();
      var fontSize = Math.round(unit * 0.07); c.font = '900 ' + fontSize + 'px Inter, system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      var maxW = sr.w * 0.96, words = title.toUpperCase().split(/\s+/), lines = [], curr = '';
      for (var i = 0; i < words.length; i++) { var t = curr ? curr + ' ' + words[i] : words[i]; if (c.measureText(t).width > maxW && curr) { lines.push(curr); curr = words[i]; } else curr = t; }
      if (curr) lines.push(curr);
      var lh = fontSize * 1.16, blockH = lines.length * lh;
      var cy0 = state.titlePos === 'top' ? (sr.y + blockH * 0.6 + sr.h * 0.05) : state.titlePos === 'center' ? (sr.y + sr.h * 0.46) : (sr.y + sr.h - blockH * 0.6 - sr.h * 0.03);
      var cx = sr.x + sr.w / 2;
      c.lineJoin = 'round'; c.strokeStyle = '#000'; c.lineWidth = fontSize * 0.16; c.fillStyle = '#fff';
      for (var L = 0; L < lines.length; L++) { var yy = cy0 - blockH / 2 + lh * (L + 0.5); c.strokeText(lines[L], cx, yy); c.fillText(lines[L], cx, yy); }
      c.restore();
    }
  }

  /* Master draw: the GUIDE (platform UI and/or custom grid+overlays) at the chosen
     opacity, then the BRANDING at full opacity on top. */
  function draw(ctx, W, H) {
    ctx.clearRect(0, 0, W, H);
    var unit = Math.min(W, H);
    ctx.save();
    ctx.globalAlpha = Math.max(0.08, (state.opacity || 70) / 100);
    if (state.mode === 'safezones' && state.platform !== 'none') {
      drawPlatformUI(ctx, W, H, state.platform);
      var sr = safeRect(W, H); dashBox(ctx, sr.x, sr.y, sr.w, sr.h, unit, 'SAFE AREA · ' + (PF_LABEL[state.platform] || ''));
    }
    if (state.mode === 'custom' || (state.mode === 'safezones' && state.alsoCustom)) {
      drawOverlays(ctx, W, H, unit); drawGrid(ctx, W, H, unit);
    }
    ctx.restore();
    drawBranding(ctx, W, H, unit);
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
    draw(ctx, cv.width, cv.height);
  }
  function renderOverlayPng() {
    var d = envDims(), cv = document.createElement('canvas'); cv.width = d.w; cv.height = d.h;
    draw(cv.getContext('2d'), d.w, d.h);
    return cv.toDataURL('image/png');
  }

  function seg(id, key, after) {
    var box = $(id); if (!box) return;
    var btns = box.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].addEventListener('click', function () {
      var on = box.querySelector('button.on'); if (on) on.classList.remove('on'); this.classList.add('on');
      state[key] = this.getAttribute('data-mode') || this.getAttribute('data-pf') || this.getAttribute('data-bm') || this.getAttribute('data-tp') || this.getAttribute('data-d');
      if (after) after(); renderPreview();
    });
  }
  function refreshModeVisibility() {
    if ($('sz-panel-safezones')) $('sz-panel-safezones').classList.toggle('hidden', state.mode !== 'safezones');
    if ($('sz-panel-custom')) $('sz-panel-custom').classList.toggle('hidden', state.mode !== 'custom');
  }
  function refreshBrandVisibility() { var box = $('sz-custom-fields'); if (box) box.classList.toggle('dim-disabled', state.brandMode !== 'custom'); }

  function wire() {
    seg('sz-mode', 'mode', refreshModeVisibility);
    seg('sz-platform', 'platform'); seg('sz-brandmode', 'brandMode', refreshBrandVisibility);
    seg('sz-titlepos', 'titlePos'); seg('sz-dur', 'dur');
    // text + checkbox inputs
    function num(id, key) { var el = $(id); if (el) el.addEventListener('input', function () { state[key] = parseFloat(this.value) || 0; renderPreview(); }); }
    num('sz-rows', 'rows'); num('sz-cols', 'cols'); num('sz-margin', 'margin'); num('sz-gutter', 'gutter');
    function ovChk(id, key) { var el = $(id); if (el) el.addEventListener('change', function () { state.ov[key] = this.checked; renderPreview(); }); }
    ovChk('sz-ov-margin', 'margin'); ovChk('sz-ov-thirds', 'thirds'); ovChk('sz-ov-cross', 'cross');
    ovChk('sz-ov-action', 'action'); ovChk('sz-ov-title', 'title'); ovChk('sz-ov-diag', 'diag');
    if ($('sz-also-custom')) $('sz-also-custom').addEventListener('change', function () { state.alsoCustom = this.checked; renderPreview(); });
    if ($('sz-channel')) $('sz-channel').addEventListener('input', function () { state.channel = this.value; renderPreview(); });
    if ($('sz-title')) $('sz-title').addEventListener('input', function () { state.title = this.value; renderPreview(); });
    if ($('sz-handle')) $('sz-handle').addEventListener('change', function () { state.handle = this.checked; renderPreview(); });
    if ($('sz-opacity')) $('sz-opacity').addEventListener('input', function () { state.opacity = parseInt(this.value, 10) || 70; if ($('sz-op-val')) $('sz-op-val').textContent = state.opacity + '%'; renderPreview(); });
    if ($('sz-replace')) $('sz-replace').addEventListener('change', function () { state.replace = this.checked; });
    if ($('sz-logo-pick')) $('sz-logo-pick').addEventListener('click', pickLogo);
    if ($('sz-logo-clear')) $('sz-logo-clear').addEventListener('click', function () {
      state.logo = null; state.logoName = ''; if ($('sz-logo-name')) $('sz-logo-name').textContent = 'no logo — a circle badge is used';
      $('sz-logo-clear').classList.add('hidden'); renderPreview();
    });
    if ($('sz-apply')) $('sz-apply').addEventListener('click', applyOverlay);
    if ($('sz-remove')) $('sz-remove').addEventListener('click', removeOverlay);
    refreshModeVisibility(); refreshBrandVisibility();
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
      var dir = pathMod.join(osMod.tmpdir(), 'pulse-guide-' + Date.now());
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e0) {}
      var pngPath = pathMod.join(dir, 'guide.png');
      try { fs.writeFileSync(pngPath, Buffer.from(png, 'base64')); } catch (eW) { try { toast('Could not write overlay: ' + eW.message, true); } catch (e3) {} return; }
      var durSec = state.dur === 'full' ? Math.max(2, (state.env && +state.env.endSeconds) || 10) : (parseFloat(state.dur) || 5);
      var prog = $('sz-progress'); if (prog) { prog.classList.remove('hidden'); prog.textContent = 'Placing guide on timeline…'; }
      var args = { path: pngPath, startSec: 0, durSec: durSec };
      if (state.replace && state.lastGuideTrack) args.replaceTrack = state.lastGuideTrack;  // reuse + clear the existing guide track
      CPBridge.callHost('CP_placeOverlay', args).then(function (r) {
        if (prog) prog.classList.add('hidden');
        state.lastGuideTrack = r.track;
        try { toast('🎉 Guide on V' + r.track + ' (opacity ' + state.opacity + '%) for ' + Math.round(durSec) + 's. Toggle that track\'s eye to hide it. ⌘Z/Ctrl+Z undoes it.'); } catch (e) {}
      }).catch(function (e) { if (prog) prog.classList.add('hidden'); try { toast('Place failed: ' + e.message, true); } catch (e2) {} });
    });
  }

  function removeOverlay() {
    if (!(window.CPBridge && CPBridge.isCEP && CPBridge.isCEP())) return;
    CPBridge.callHost('CP_removeOverlay', { track: state.lastGuideTrack || null }).then(function (r) {
      state.lastGuideTrack = null;
      try { toast(r && r.removed ? ('Removed ' + r.removed + ' guide clip' + (r.removed === 1 ? '' : 's') + '.') : 'No Pulse guide found to remove.'); } catch (e) {}
    }).catch(function (e) { try { toast('Remove failed: ' + e.message, true); } catch (e2) {} });
  }

  window.CPSafezone = { onShow: function () { refreshEnv(); }, render: renderPreview };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
