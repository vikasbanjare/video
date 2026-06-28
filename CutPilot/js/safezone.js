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

  // ---------- REAL vector icons (Lucide 24×24 path data) for crisp, app-accurate UI ----------
  var IC = {
    heart: ['M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z'],
    comment: ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z'],
    send: ['M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z', 'm21.854 2.147-10.94 10.939'],
    thumbsUp: ['M7 10v12', 'M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z'],
    thumbsDown: ['M17 14V2', 'M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z'],
    forward: ['m15 17 5-5-5-5', 'M4 18v-2a4 4 0 0 1 4-4h12'],
    repeat: ['m17 2 4 4-4 4', 'M3 11v-1a4 4 0 0 1 4-4h14', 'm7 22-4-4 4-4', 'M21 13v1a4 4 0 0 1-4 4H3'],
    bookmark: ['m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'],
    search: ['m21 21-4.34-4.34', 'M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z'],
    home: ['m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 22V12h6v10'],
    play: ['m6 3 14 9-14 9z'],
    music: ['M9 18V5l12-2v13', 'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', 'M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
    user: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z']
  };
  // render a 24×24 icon centred at (cx,cy) at the given pixel size
  function ic(c, key, cx, cy, size, fill) {
    var paths = IC[key]; if (!paths) return;
    c.save();
    var s = size / 24;
    c.translate(cx - size / 2, cy - size / 2); c.scale(s, s);
    c.lineWidth = 1.9; c.lineJoin = 'round'; c.lineCap = 'round';
    for (var i = 0; i < paths.length; i++) { var p = new Path2D(paths[i]); if (fill) c.fill(p); else c.stroke(p); }
    c.restore();
  }
  function icPlus(c, x, y, s) { c.beginPath(); c.moveTo(x - s, y); c.lineTo(x + s, y); c.moveTo(x, y - s); c.lineTo(x, y + s); c.stroke(); }
  function icDots(c, x, y, s) { for (var i = -1; i <= 1; i++) { c.beginPath(); c.arc(x + i * s * 1.7, y, s, 0, Math.PI * 2); c.fill(); } }   // horizontal 3-dots
  function icDotsV(c, x, y, s) { for (var i = -1; i <= 1; i++) { c.beginPath(); c.arc(x, y + i * s * 1.7, s, 0, Math.PI * 2); c.fill(); } } // vertical 3-dots
  function avatar(c, x, y, r, ring) {
    if (ring) { c.save(); var g = c.createLinearGradient(x - r, y - r, x + r, y + r); g.addColorStop(0, '#feda75'); g.addColorStop(.5, '#d62976'); g.addColorStop(1, '#962fbf'); c.strokeStyle = g; c.lineWidth = r * 0.18; c.beginPath(); c.arc(x, y, r * 1.12, 0, Math.PI * 2); c.stroke(); c.restore(); }
    c.save(); var gg = c.createLinearGradient(x - r, y - r, x + r, y + r); gg.addColorStop(0, '#8a93a6'); gg.addColorStop(1, '#5a6273'); c.fillStyle = gg; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.restore();
  }

  /* Draw the platform chrome (guide) with REAL icons, solid white, like the app. */
  function drawPlatformUI(c, W, H, pf) {
    var unit = Math.min(W, H);
    var sz = unit * 0.066;                   // icon box size
    var colX = W - unit * 0.085;
    var gap = unit * 0.115;                  // vertical spacing between action items
    c.save();
    c.strokeStyle = '#fff'; c.fillStyle = '#fff';
    c.textAlign = 'center'; c.textBaseline = 'top';
    c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = unit * 0.009;
    function lbl(x, y, t) { c.save(); c.fillStyle = '#fff'; c.font = '600 ' + Math.round(unit * 0.024) + 'px Inter, system-ui, sans-serif'; c.fillText(t, x, y); c.restore(); }
    function thumb(x, y) { c.save(); c.fillStyle = 'rgba(255,255,255,0.22)'; rr(c, x - sz * 0.45, y - sz * 0.45, sz * 0.9, sz * 0.9, sz * 0.22); c.fill(); c.fillStyle = '#fff'; ic(c, 'music', x, y, sz * 0.52, false); c.restore(); }

    if (pf === 'reels') {
      var y0 = H * 0.52;
      ic(c, 'heart', colX, y0, sz, false); lbl(colX, y0 + sz * 0.62, '1,618');
      ic(c, 'comment', colX, y0 + gap, sz, false); lbl(colX, y0 + gap + sz * 0.62, '31');
      ic(c, 'send', colX, y0 + gap * 2, sz, false); lbl(colX, y0 + gap * 2 + sz * 0.62, '1,095');
      icDotsV(c, colX, y0 + gap * 2.95, unit * 0.009);
      thumb(colX, y0 + gap * 3.7);
      brandRowMock(c, W, H, unit, 'cauldythe.app', 'A social network for the independent thinker.', 'Sponsored', 'follow', true);
      navBar(c, W, H, unit, 'reels');
    } else if (pf === 'shorts') {
      ic(c, 'search', W - unit * 0.16, H * 0.07, sz * 0.82, false); icDotsV(c, W - unit * 0.055, H * 0.07, unit * 0.009);
      var y1 = H * 0.46;
      ic(c, 'thumbsUp', colX, y1, sz, true); lbl(colX, y1 + sz * 0.62, '1M');
      ic(c, 'thumbsDown', colX, y1 + gap, sz, true); lbl(colX, y1 + gap + sz * 0.62, 'Dislike');
      ic(c, 'comment', colX, y1 + gap * 2, sz, false); lbl(colX, y1 + gap * 2 + sz * 0.62, '11K');
      ic(c, 'forward', colX, y1 + gap * 3, sz, false); lbl(colX, y1 + gap * 3 + sz * 0.62, 'Share');
      ic(c, 'repeat', colX, y1 + gap * 4, sz, false); lbl(colX, y1 + gap * 4 + sz * 0.62, 'Remix');
      brandRowMock(c, W, H, unit, '@Skinnyfromthe9', '#shorts', '', 'subscribe', false);
      navBar(c, W, H, unit, 'shorts');
    } else if (pf === 'tiktok') {
      var y2 = H * 0.42;
      avatar(c, colX, y2, sz * 0.5, false);
      c.save(); c.fillStyle = '#fe2c55'; c.beginPath(); c.arc(colX, y2 + sz * 0.55, sz * 0.2, 0, Math.PI * 2); c.fill(); c.strokeStyle = '#fff'; c.lineWidth = Math.max(1.5, unit * 0.004); icPlus(c, colX, y2 + sz * 0.55, sz * 0.1); c.restore();
      c.fillStyle = '#fff';
      ic(c, 'heart', colX, y2 + gap * 1.1, sz, true); lbl(colX, y2 + gap * 1.1 + sz * 0.62, '328.7K');
      ic(c, 'comment', colX, y2 + gap * 2.1, sz, true); lbl(colX, y2 + gap * 2.1 + sz * 0.62, '1,204');
      ic(c, 'bookmark', colX, y2 + gap * 3.1, sz, true); lbl(colX, y2 + gap * 3.1 + sz * 0.62, '45.1K');
      ic(c, 'send', colX, y2 + gap * 4.1, sz, true); lbl(colX, y2 + gap * 4.1 + sz * 0.62, 'Share');
      c.save(); c.fillStyle = '#1c1c1c'; c.beginPath(); c.arc(colX, y2 + gap * 5.05, sz * 0.5, 0, Math.PI * 2); c.fill(); c.fillStyle = '#fff'; c.beginPath(); c.arc(colX, y2 + gap * 5.05, sz * 0.14, 0, Math.PI * 2); c.fill(); c.restore();
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

  // bottom navigation bar (over the video) — real icons
  function navBar(c, W, H, unit, pf) {
    c.save();
    var ny = H - unit * 0.042, isz = unit * 0.05;
    c.strokeStyle = '#fff'; c.fillStyle = '#fff';
    c.shadowColor = 'rgba(0,0,0,0.45)'; c.shadowBlur = unit * 0.006;
    var xs = [0.1, 0.3, 0.5, 0.7, 0.9];
    var labels = pf === 'shorts' ? ['Home', 'Shorts', '', 'Subscriptions', 'You'] : (pf === 'tiktok' ? ['Home', 'Friends', '', 'Inbox', 'Profile'] : ['', '', '', '', '']);
    for (var i = 0; i < xs.length; i++) {
      var x = W * xs[i];
      if (i === 2) {   // centre create button (rounded rect with +)
        c.save();
        if (pf === 'tiktok') { c.fillStyle = '#fe2c55'; rr(c, x - unit * 0.062, ny - unit * 0.02, unit * 0.026, unit * 0.04, unit * 0.01); c.fill(); c.fillStyle = '#25f4ee'; rr(c, x + unit * 0.036, ny - unit * 0.02, unit * 0.026, unit * 0.04, unit * 0.01); c.fill(); }
        c.fillStyle = '#fff'; rr(c, x - unit * 0.05, ny - unit * 0.02, unit * 0.1, unit * 0.04, unit * 0.012); c.fill();
        c.strokeStyle = '#111'; c.lineWidth = unit * 0.0055; icPlus(c, x, ny, unit * 0.013); c.restore();
        if (labels[i]) lbl2(c, x, ny + unit * 0.032, labels[i], unit);
        continue;
      }
      c.strokeStyle = '#fff'; c.fillStyle = '#fff';
      if (i === 0) ic(c, 'home', x, ny, isz, pf === 'reels');
      else if (i === 1) { pf === 'reels' || pf === 'shorts' ? ic(c, 'play', x, ny, isz * 0.9, true) : ic(c, 'user', x, ny, isz, false); }
      else if (i === 3) pf === 'reels' ? ic(c, 'search', x, ny, isz, false) : ic(c, 'home', x, ny, isz, false);
      else if (i === 4) avatar(c, x, ny, isz * 0.5, false);
      if (labels[i]) lbl2(c, x, ny + unit * 0.032, labels[i], unit);
    }
    c.restore();
  }
  function lbl2(c, x, y, t, unit) { c.save(); c.fillStyle = 'rgba(255,255,255,0.92)'; c.textAlign = 'center'; c.textBaseline = 'top'; c.font = '500 ' + Math.round(unit * 0.016) + 'px Inter, system-ui, sans-serif'; c.shadowBlur = 0; c.fillText(t, x, y); c.restore(); }

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

  /* Master draw: the GUIDE (platform UI and/or custom grid+overlays) at alpha, then
     the BRANDING at full opacity. alpha defaults to 1 so the on-panel PREVIEW is
     always crisp & solid like the real app — the opacity slider only fades the
     placed reference clip (passed by renderOverlayPng). */
  function draw(ctx, W, H, alpha) {
    ctx.clearRect(0, 0, W, H);
    var unit = Math.min(W, H);
    ctx.save();
    ctx.globalAlpha = (alpha == null ? 1 : Math.max(0.08, alpha));
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
    draw(ctx, cv.width, cv.height, 1);                       // preview = crisp, solid
  }
  function renderOverlayPng() {
    var d = envDims(), cv = document.createElement('canvas'); cv.width = d.w; cv.height = d.h;
    draw(cv.getContext('2d'), d.w, d.h, (state.opacity || 70) / 100);   // placed clip = chosen opacity
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
