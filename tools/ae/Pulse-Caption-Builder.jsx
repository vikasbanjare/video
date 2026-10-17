/*
 * Pulse-Caption-Builder.jsx — builds Pulse's own editable caption template
 * in After Effects and saves it as Pulse_Caption.mogrt on the Desktop.
 *
 * Run once: After Effects → File → Scripts → Run Script File… → this file.
 * (If AE says scripts may not write files: Settings/Preferences → Scripting &
 * Expressions → tick "Allow Scripts to Write Files and Access Network", then
 * run it again.)
 *
 * Why: editable captions rode a third-party template (Flux Halo) that cannot
 * draw an outline, a box behind only the spoken word or a growing spoken word,
 * plays its own word slide, and shows 28 controls in Premiere's Properties —
 * most of them plumbing that breaks the caption when touched. This template
 * draws what Pulse's image captions draw, and shows only these controls:
 *
 *   Text · Size · Text Color · Spoken Word Color · Spoken Word Grow ·
 *   Letter Spacing · Outline Color · Outline Width ·
 *   Box (None / Whole line / Spoken word / Line and spoken word) ·
 *   Box Color · Word Box Color · Box Opacity · Box Roundness ·
 *   Shadow Opacity · Shadow Distance · Animation (None / Pop / Fade / Slide up)
 *
 * v4 adds: Text Gradient (on/off) + Text Color 2 (the warm top-to-bottom
 * gradient of Sunset Fade), Upcoming Opacity (words not yet said stay faint,
 * Soft Focus), Tilt (Tilt Tag, Line Ribbons) and Exit (None / Fade / Shrink /
 * Slide down: the caption leaves the way the image captions can).
 *
 * Word timing needs no control: a one-frame protected region at the start
 * turns on Premiere's "Responsive Design – Time", so the comp stretches over
 * the clip and the spoken word is the one whose share of the clip is playing.
 *
 * ExtendScript (ES3): no let/const, arrow functions or Array.forEach here.
 * The expressions are plain ES5 so they run on either expression engine.
 */
(function () {
  var NAME = 'Pulse Caption';
  var W = 1080, H = 1920, FPS = 30, DUR = 2;       // the comp stretches to each caption's length
  var FONT_PX = 75, LEAD = 90;                     // Pulse sizes captions from this authored face
  var A = 0.18;                                    // entrance length in comp seconds (~9% of the caption)

  function fail(msg) { alert('Pulse Caption Builder\n\n' + msg); }
  var ver = parseFloat(app.version);
  if (!(ver >= 17)) { fail('This needs After Effects 2020 (17.0) or newer. This is ' + app.version + '.'); return; }

  app.beginUndoGroup(NAME);
  try {
    app.newProject();
    try { app.project.expressionEngine = 'javascript-1.0'; } catch (eEng) {}
    var comp = app.project.items.addComp(NAME, W, H, 1, DUR, FPS);
    comp.bgColor = [0.18, 0.2, 0.23];

    // ---- controls (one null; its effects are the template's settings) -----
    var ctl = comp.layers.addNull(DUR);
    ctl.name = 'Controls';
    function fxs() { return ctl.property('ADBE Effect Parade'); }   // fetched fresh: a filled menu rebuilds its effect
    function slider(name, v) { var e = fxs().addProperty('ADBE Slider Control'); e.name = name; e.property(1).setValue(v); return name; }
    function color(name, rgb) { var e = fxs().addProperty('ADBE Color Control'); e.name = name; e.property(1).setValue(rgb); return name; }
    function checkbox(name, v) { var e = fxs().addProperty('ADBE Checkbox Control'); e.name = name; e.property(1).setValue(v); return name; }
    function angle(name, v) { var e = fxs().addProperty('ADBE Angle Control'); e.name = name; e.property(1).setValue(v); return name; }
    function menu(name, items, v) {
      var e = fxs().addProperty('ADBE Dropdown Control');
      var at = e.propertyIndex;
      // filling the menu rebuilds the effect (and resets its name): find it
      // again by its place, then name it
      e.property(1).setPropertyParameters(items);
      var d = fxs().property(at);
      d.name = name;
      d.property(1).setValue(v);
      return name;
    }
    slider('Size', 100);
    color('Text Color', [1, 1, 1]);
    checkbox('Text Gradient', 0);
    color('Text Color 2', [1, 0.31, 0.31]);         // the gradient's bottom colour
    color('Spoken Word Color', [1, 0.85, 0.1]);
    // Premiere keeps a slider inside its 0–100 range, so the spoken word's
    // size is how much it GROWS: 0 = same size, 25 = a quarter bigger
    slider('Spoken Word Grow', 0);
    slider('Letter Spacing', 0);                     // × 10 = After Effects tracking
    color('Outline Color', [0, 0, 0]);
    slider('Outline Width', 0);
    menu('Box', ['None', 'Whole line', 'Spoken word', 'Line and spoken word'], 1);
    color('Box Color', [0.48, 0.19, 0.2]);
    color('Word Box Color', [0.02, 0.26, 0.05]);
    slider('Box Opacity', 100);
    slider('Box Roundness', 12);
    slider('Shadow Opacity', 50);
    slider('Shadow Distance', 0);
    menu('Animation', ['None', 'Pop', 'Fade', 'Slide up'], 1);
    menu('Exit', ['None', 'Fade', 'Shrink', 'Slide down'], 1);
    slider('Upcoming Opacity', 100);               // words not yet said: 100 = as bright as the rest
    angle('Tilt', 0);                              // the whole caption turns, box and all
    // worked out, never shown in Premiere: which word is being said, its line
    // and its place on that line
    slider('Spoken Index', 0);
    slider('Spoken Line', 0);
    slider('Spoken Pos', 0);

    // the caption's words, as an array of lines of words (expression source)
    var WORDS = [
      'function linesOf(s) {',
      '  var ls = String(s).split(/\\r\\n|\\r|\\n|\\u0003/), out = [];',
      '  for (var i = 0; i < ls.length; i++) {',
      '    var ws = ls[i].split(" "), w = [];',
      '    for (var j = 0; j < ws.length; j++) if (ws[j].length) w.push(ws[j]);',
      '    if (w.length) out.push(w);',
      '  }',
      '  return out;',
      '}',
      'var L = linesOf("" + thisComp.layer("Caption").text.sourceText);'
    ].join('\n');
    var C = 'thisComp.layer("Controls").effect';
    ctl.effect('Spoken Index').property(1).expression = WORDS + '\n' + [
      'var n = 0; for (var i = 0; i < L.length; i++) n += L[i].length;',
      'var p = time / thisComp.duration;',
      'n < 1 ? 0 : Math.max(0, Math.min(n - 1, Math.floor(p * n)));'
    ].join('\n');
    ctl.effect('Spoken Line').property(1).expression = WORDS + '\n' + [
      'var k = Math.round(' + C + '("Spoken Index")(1)), line = 0;',
      'for (var i = 0; i < L.length; i++) { if (k < L[i].length) { line = i; break; } k -= L[i].length; line = i; }',
      'line;'
    ].join('\n');
    ctl.effect('Spoken Pos').property(1).expression = WORDS + '\n' + [
      'var k = Math.round(' + C + '("Spoken Index")(1)), pos = 0;',
      'for (var i = 0; i < L.length; i++) { if (k < L[i].length) { pos = k; break; } k -= L[i].length; pos = Math.max(0, L[i].length - 1); }',
      'pos;'
    ].join('\n');

    // ---- the group everything rides on (size + entrance) ------------------
    var grp = comp.layers.addNull(DUR);
    grp.name = 'Group';
    grp.property('ADBE Transform Group').property('ADBE Position').setValue([W / 2, H / 2]);
    // entrance (e: 0 → 1 over the first A seconds) and exit (x: 1 → 0 over
    // the last A seconds). Exit: 1 None · 2 Fade · 3 Shrink · 4 Slide down
    var ANIM = 'var an = Math.round(' + C + '("Animation")(1)); var e = ease(time, 0, ' + A + ', 0, 1);' +
      ' var ex = Math.round(' + C + '("Exit")(1)); var D = thisComp.duration; var x = ease(time, D - ' + A + ', D, 1, 0);';
    grp.property('ADBE Transform Group').property('ADBE Scale').expression = [
      ANIM,
      'var s = ' + C + '("Size")(1);',
      'if (an == 2) s *= (time < ' + A + ' ? linear(time, 0, ' + A + ', 0.6, 1.06) : linear(time, ' + A + ', ' + (A * 1.6) + ', 1.06, 1));',
      'if (ex == 3) s *= 0.6 + 0.4 * x;',
      '[s, s];'
    ].join('\n');
    grp.property('ADBE Transform Group').property('ADBE Position').expression = [
      ANIM,
      // element by element: array + array is not vector maths on every engine
      'var dy = (an == 4 ? (1 - e) * 60 : 0) + (ex == 4 ? (1 - x) * 60 : 0);',
      '[value[0], value[1] + dy];'
    ].join('\n');
    grp.property('ADBE Transform Group').property('ADBE Rotate Z').expression = C + '("Tilt")(1);';
    var FADE = ANIM + '\n(an == 3 ? e : 1) * (ex == 2 || ex == 3 ? x : 1) * ';

    // ---- the caption text ----------------------------------------------------
    var cap = comp.layers.addText('AAJ PAISE KI BAAT');
    cap.name = 'Caption';
    var st = cap.property('ADBE Text Properties').property('ADBE Text Document');
    var td = st.value;
    td.resetCharStyle();
    td.resetParagraphStyle();
    td.font = 'Arial-BoldMT';
    td.fontSize = FONT_PX;
    td.applyFill = true;
    td.fillColor = [1, 1, 1];
    td.applyStroke = true;                          // the width comes from Outline Width
    td.strokeColor = [0, 0, 0];
    td.strokeWidth = 1;
    td.strokeOverFill = false;                      // outline behind the letters, like the image captions
    td.justification = ParagraphJustification.CENTER_JUSTIFY;
    try { td.autoLeading = false; td.leading = LEAD; } catch (eLd) {}
    st.setValue(td);
    cap.parent = grp;
    cap.property('ADBE Transform Group').property('ADBE Position').setValue([0, 0]);
    // the block's middle sits on the graphic's centre (Pulse moves the clip)
    cap.property('ADBE Transform Group').property('ADBE Anchor Point').expression =
      'var r = sourceRectAtTime(time, false); [0, r.top + r.height / 2];';
    cap.property('ADBE Transform Group').property('ADBE Opacity').expression = FADE + '100;';
    try { cap.property('ADBE Text Properties').property('ADBE Text More Options').property('ADBE Text Anchor Point Grouping').setValue(2); } catch (eGrp) {}

    // After Effects can leave a reference stale after something is added next
    // to it, so every step below looks its animator up again by name.
    function anims() { return cap.property('ADBE Text Properties').property('ADBE Text Animators'); }
    function anim(name) { return anims().property(name); }
    function addAnimator(name) { var a = anims().addProperty('ADBE Text Animator'); a.name = name; }
    function addProp(name, matchName, expr) {
      var p = anim(name).property('ADBE Text Animator Properties').addProperty(matchName);
      p.expression = expr;
    }
    // every letter: the text colour and the outline
    addAnimator('Look');
    anim('Look').property('ADBE Text Selectors').addProperty('ADBE Text Selector');
    addProp('Look', 'ADBE Text Fill Color', C + '("Text Color")(1);');
    addProp('Look', 'ADBE Text Stroke Color', C + '("Outline Color")(1);');
    addProp('Look', 'ADBE Text Stroke Width', C + '("Outline Width")(1);');
    addProp('Look', 'ADBE Text Tracking Amount', C + '("Letter Spacing")(1) * 10;');
    // the spoken word: its own colour and size
    addAnimator('Spoken Word');
    anim('Spoken Word').property('ADBE Text Selectors').addProperty('ADBE Text Selector');
    var adv = anim('Spoken Word').property('ADBE Text Selectors').property(1).property('ADBE Text Range Advanced');
    adv.property('ADBE Text Range Units').setValue(2);          // index
    adv.property('ADBE Text Range Type2').setValue(3);          // words
    var sel = anim('Spoken Word').property('ADBE Text Selectors').property(1);
    sel.property('ADBE Text Index Start').expression = C + '("Spoken Index")(1);';
    sel = anim('Spoken Word').property('ADBE Text Selectors').property(1);
    sel.property('ADBE Text Index End').expression = C + '("Spoken Index")(1) + 1;';
    addProp('Spoken Word', 'ADBE Text Fill Color', C + '("Spoken Word Color")(1);');
    addProp('Spoken Word', 'ADBE Text Scale 3D', 'var g = 100 + ' + C + '("Spoken Word Grow")(1); value.length > 2 ? [g, g, 100] : [g, g];');
    // words not yet said: faint (Upcoming Opacity), every word after the spoken one
    function upcoming(layer) {
      var ua = layer.property('ADBE Text Properties').property('ADBE Text Animators').addProperty('ADBE Text Animator');
      ua.name = 'Upcoming';
      var up = function () { return layer.property('ADBE Text Properties').property('ADBE Text Animators').property('Upcoming'); };
      up().property('ADBE Text Selectors').addProperty('ADBE Text Selector');
      var uadv = up().property('ADBE Text Selectors').property(1).property('ADBE Text Range Advanced');
      uadv.property('ADBE Text Range Units').setValue(2);         // index
      uadv.property('ADBE Text Range Type2').setValue(3);         // words
      up().property('ADBE Text Selectors').property(1).property('ADBE Text Index Start').expression = C + '("Spoken Index")(1) + 1;';
      up().property('ADBE Text Selectors').property(1).property('ADBE Text Index End').expression = '9999;';
      up().property('ADBE Text Animator Properties').addProperty('ADBE Text Opacity').expression = C + '("Upcoming Opacity")(1);';
    }
    upcoming(cap);

    // soft or offset shadow behind the letters
    var sh = cap.property('ADBE Effect Parade').addProperty('ADBE Drop Shadow');
    sh.name = 'Shadow';
    var shOp = cap.effect('Shadow').property('ADBE Drop Shadow-0002');
    var opMax = (shOp.hasMax ? shOp.maxValue : 100);   // the effect's own scale (255 on some versions)
    shOp.expression = C + '("Shadow Opacity")(1) / 100 * ' + opMax + ';';
    cap.effect('Shadow').property('ADBE Drop Shadow-0001').setValue([0, 0, 0]);
    cap.effect('Shadow').property('ADBE Drop Shadow-0003').setValue(135);
    cap.effect('Shadow').property('ADBE Drop Shadow-0004').expression = C + '("Shadow Distance")(1);';
    cap.effect('Shadow').property('ADBE Drop Shadow-0005').expression = 'Math.max(6, ' + C + '("Size")(1) * 0.14);';

    // ---- Text Gradient: a copy of the caption's letters, filled top to bottom
    // from Text Color to Text Color 2, laid over the caption (the outline and
    // the spoken word's own colour stay the caption's). Shown only when Text
    // Gradient is ticked.
    var gl = comp.layers.addText('M');
    gl.name = 'Gradient Text';
    gl.parent = cap;
    gl.property('ADBE Transform Group').property('ADBE Position').setValue([0, 0]);
    gl.property('ADBE Text Properties').property('ADBE Text Document').expression =
      'var s = thisComp.layer("Caption").text.sourceText; s.style.setText("" + s);';
    function gAnims() { return gl.property('ADBE Text Properties').property('ADBE Text Animators'); }
    gAnims().addProperty('ADBE Text Animator').name = 'Look';
    gAnims().property('Look').property('ADBE Text Selectors').addProperty('ADBE Text Selector');
    gAnims().property('Look').property('ADBE Text Animator Properties').addProperty('ADBE Text Stroke Width').expression = '0;';
    gAnims().property('Look').property('ADBE Text Animator Properties').addProperty('ADBE Text Tracking Amount').expression = C + '("Letter Spacing")(1) * 10;';
    // the spoken word: as big as the caption's, and left to the caption's colour
    gAnims().addProperty('ADBE Text Animator').name = 'Spoken Word';
    gAnims().property('Spoken Word').property('ADBE Text Selectors').addProperty('ADBE Text Selector');
    var gadv = gAnims().property('Spoken Word').property('ADBE Text Selectors').property(1).property('ADBE Text Range Advanced');
    gadv.property('ADBE Text Range Units').setValue(2);
    gadv.property('ADBE Text Range Type2').setValue(3);
    gAnims().property('Spoken Word').property('ADBE Text Selectors').property(1).property('ADBE Text Index Start').expression = C + '("Spoken Index")(1);';
    gAnims().property('Spoken Word').property('ADBE Text Selectors').property(1).property('ADBE Text Index End').expression = C + '("Spoken Index")(1) + 1;';
    gAnims().property('Spoken Word').property('ADBE Text Animator Properties').addProperty('ADBE Text Scale 3D').expression =
      'var g = 100 + ' + C + '("Spoken Word Grow")(1); value.length > 2 ? [g, g, 100] : [g, g];';
    gAnims().property('Spoken Word').property('ADBE Text Animator Properties').addProperty('ADBE Text Opacity').expression = '0;';
    upcoming(gl);
    var ramp = gl.property('ADBE Effect Parade').addProperty('ADBE Ramp');
    ramp.name = 'Gradient';
    gl.effect('Gradient').property('ADBE Ramp-0001').expression = 'var r = sourceRectAtTime(time, false); [r.left + r.width / 2, r.top];';
    gl.effect('Gradient').property('ADBE Ramp-0002').expression = C + '("Text Color")(1);';
    gl.effect('Gradient').property('ADBE Ramp-0003').expression = 'var r = sourceRectAtTime(time, false); [r.left + r.width / 2, r.top + r.height];';
    gl.effect('Gradient').property('ADBE Ramp-0004').expression = C + '("Text Color 2")(1);';
    // hidden unless its expression says otherwise: a failing expression falls
    // back to this value, and the first v4 build showed every caption red
    gl.property('ADBE Transform Group').property('ADBE Opacity').setValue(0);
    gl.property('ADBE Transform Group').property('ADBE Opacity').expression = FADE + '(' + C + '("Text Gradient")(1) ? 100 : 0);';

    // ---- measuring layers (guides: never drawn) ---------------------------
    function measure(name, body) {
      var m = comp.layers.addText('M');
      m.name = name;
      var mt = m.property('ADBE Text Properties').property('ADBE Text Document');
      var md = mt.value; md.font = 'Arial-BoldMT'; md.fontSize = FONT_PX; mt.setValue(md);
      m.guideLayer = true;
      m.parent = cap;
      m.property('ADBE Transform Group').property('ADBE Position').setValue([0, 0]);
      m.property('ADBE Transform Group').property('ADBE Opacity').setValue(0);
      m.property('ADBE Text Properties').property('ADBE Text Document').expression = WORDS + '\n' + [
        'var li = Math.round(' + C + '("Spoken Line")(1)), po = Math.round(' + C + '("Spoken Pos")(1));',
        'var w = L.length ? L[Math.min(li, L.length - 1)] : ["M"];',
        body,
        'thisComp.layer("Caption").text.sourceText.style.setText(t);'
      ].join('\n');
      // the caption's letter spacing, so the words measure as wide as drawn
      var ma = m.property('ADBE Text Properties').property('ADBE Text Animators').addProperty('ADBE Text Animator');
      ma.name = 'Spacing';
      m.property('ADBE Text Properties').property('ADBE Text Animators').property('Spacing').property('ADBE Text Selectors').addProperty('ADBE Text Selector');
      m.property('ADBE Text Properties').property('ADBE Text Animators').property('Spacing').property('ADBE Text Animator Properties')
        .addProperty('ADBE Text Tracking Amount').expression = C + '("Letter Spacing")(1) * 10;';
      return m;
    }
    measure('Measure Line', 'var t = w.join(" ");');
    measure('Measure Upto', 'var t = w.slice(0, po + 1).join(" ");');
    measure('Measure Word', 'var t = w[Math.min(po, w.length - 1)];');

    // ---- the two boxes (below the text) -----------------------------------
    // Box: 1 None · 2 Whole line · 3 Spoken word · 4 Line and spoken word
    function box(name, sizeExpr, posExpr, modes, colorName, opacityExpr) {
      var b = comp.layers.addShape();
      b.name = name;
      b.parent = cap;
      b.property('ADBE Transform Group').property('ADBE Position').setValue([0, 0]);
      b.property('ADBE Transform Group').property('ADBE Anchor Point').setValue([0, 0]);
      var g = b.property('ADBE Root Vectors Group').addProperty('ADBE Vector Group');
      var v = g.property('ADBE Vectors Group');
      var r = v.addProperty('ADBE Vector Shape - Rect');
      r.property('ADBE Vector Rect Size').expression = sizeExpr;
      r.property('ADBE Vector Rect Position').expression = posExpr;
      r.property('ADBE Vector Rect Roundness').expression = C + '("Box Roundness")(1);';
      var f = v.addProperty('ADBE Vector Graphic - Fill');
      f.property('ADBE Vector Fill Color').expression = C + '("' + colorName + '")(1);';
      b.property('ADBE Transform Group').property('ADBE Opacity').expression =
        FADE + '(' + modes + '.indexOf(Math.round(' + C + '("Box")(1))) >= 0 ? ' + opacityExpr + ' : 0);';
      b.moveAfter(cap);
      return b;
    }
    var PAD = 'var px = ' + (FONT_PX * 0.32) + ', py = ' + (FONT_PX * 0.16) + ';';
    box('Line Box',
      PAD + ' var r = thisComp.layer("Caption").sourceRectAtTime(time, false); [r.width + 2 * px, r.height + 2 * py];',
      'var r = thisComp.layer("Caption").sourceRectAtTime(time, false); [r.left + r.width / 2, r.top + r.height / 2];',
      '[2, 4]', 'Box Color', C + '("Box Opacity")(1)');
    var WB = [
      'var Lr = thisComp.layer("Measure Line").sourceRectAtTime(time, false);',
      'var Ur = thisComp.layer("Measure Upto").sourceRectAtTime(time, false);',
      'var Wr = thisComp.layer("Measure Word").sourceRectAtTime(time, false);',
      'var g = 1 + ' + C + '("Spoken Word Grow")(1) / 100;',
      'var li = Math.round(' + C + '("Spoken Line")(1));',
      // the caption is centred line by line; the measures are not
      // widths only: the caption centres each line, and the measures may be
      // left- or centre-aligned (After Effects copies the caption's style)
      'var right = -Lr.width / 2 + Ur.width, left = right - Wr.width;'
    ].join('\n');
    var spokenBox = box('Spoken Word Box',
      PAD + '\n' + WB + '\n[Wr.width * g + 2 * px, Lr.height * g + 2 * py];',
      WB + '\n[(left + right) / 2, li * ' + LEAD + ' + Lr.top + Lr.height / 2];',
      // on its own it takes Box Opacity; over a line box it stays solid (as the image does)
      '[3, 4]', 'Word Box Color', '(Math.round(' + C + '("Box")(1)) == 4 ? 100 : ' + C + '("Box Opacity")(1))');
    spokenBox.moveAfter(cap);

    // keep the gradient inside the letters: the layer's own alpha as its matte
    // (a ramp can fill past the letters on some After Effects versions)
    try {
      var sm = gl.property('ADBE Effect Parade').addProperty('ADBE Set Matte3');
      sm.name = 'Letters Only';
      gl.effect('Letters Only').property('ADBE Set Matte3-0001').setValue(gl.index);
    } catch (eSm) {}

    // ---- one protected frame: Premiere stretches the rest over the caption ---
    try {
      var mv = new MarkerValue('Pulse');
      mv.duration = 1 / FPS;
      mv.protectedRegion = true;
      comp.markerProperty.setValueAtTime(0, mv);
    } catch (eMk) {}

    // ---- self-check: After Effects runs every expression; report any that
    // fail (the owner screenshots this instead of hunting for error bars) ----
    var exprErrors = [];
    function scanProps(group, where) {
      for (var pi = 1; pi <= group.numProperties; pi++) {
        var pr = group.property(pi);
        if (!pr) continue;
        if (pr.propertyType === PropertyType.PROPERTY) {
          var ee = '';
          try { ee = pr.expressionError || ''; } catch (eEe) {}
          var off = false;
          try { off = pr.canSetExpression && pr.expression !== '' && pr.expressionEnabled === false; } catch (eOff) {}
          if (ee || off) exprErrors.push(where + ' > ' + pr.name + ': ' + (ee || 'expression switched off'));
        } else {
          scanProps(pr, where + ' > ' + pr.name);
        }
      }
    }
    try {
      for (var li = 1; li <= comp.numLayers; li++) scanProps(comp.layer(li), comp.layer(li).name);
    } catch (eScan) { exprErrors.push('(could not check: ' + eScan.toString() + ')'); }
    // with Text Gradient off, the gradient copy must be invisible
    try {
      var gOp = gl.property('ADBE Transform Group').property('ADBE Opacity').valueAtTime(1, false);
      if (gOp > 0) exprErrors.push('Gradient Text > Opacity is ' + gOp + ' with Text Gradient off (should be 0)');
    } catch (eG) {}

    // ---- Essential Graphics: the only controls Premiere shows --------------
    comp.motionGraphicsTemplateName = NAME;
    function expose(prop, label) {
      if (prop.canAddToMotionGraphicsTemplate(comp)) prop.addToMotionGraphicsTemplateAs(comp, label);
    }
    // After Effects puts each new control at the TOP of the list (seen on the
    // owner's AE 2026), so they go in last-first and Text ends up on top
    var order = ['Size', 'Text Color', 'Text Gradient', 'Text Color 2', 'Spoken Word Color', 'Spoken Word Grow', 'Upcoming Opacity',
                 'Letter Spacing', 'Outline Color', 'Outline Width',
                 'Box', 'Box Color', 'Word Box Color', 'Box Opacity', 'Box Roundness', 'Shadow Opacity', 'Shadow Distance',
                 'Tilt', 'Animation', 'Exit'];
    for (var i = order.length - 1; i >= 0; i--) expose(ctl.effect(order[i]).property(1), order[i]);
    expose(st, 'Text');

    // ---- save the AE project (to change it later) and the template ---------
    // Saving the project leaves every reference stale ("Object is invalid"
    // on the owner's Mac): find the comp again by name after each save.
    function theComp() {
      for (var k = 1; k <= app.project.numItems; k++) {
        var it = app.project.item(k);
        if (it instanceof CompItem && it.name === NAME) return it;
      }
      return null;
    }
    var dir = Folder.desktop.fsName;
    // After Effects takes the path as a FOLDER and writes "<comp name>.mogrt"
    // inside it (seen on the owner's Mac), so give it a folder of its own
    var folder = new Folder(dir + '/Pulse Caption Template');
    if (!folder.exists) folder.create();
    var out = folder.fsName + '/' + NAME + '.mogrt';
    var okExport;
    try { app.beginSuppressDialogs(); } catch (eSd) {}
    try { okExport = comp.exportAsMotionGraphicsTemplate(true, folder.fsName); }
    finally { try { app.endSuppressDialogs(false); } catch (eEd) {} }
    try { app.project.save(new File(dir + '/Pulse_Caption.aep')); } catch (eSave) {}
    try { var shown = theComp(); if (shown) shown.openInViewer(); } catch (eView) {}
    if (okExport === false || !new File(out).exists) {
      fail('The template was built, but After Effects did not save Pulse_Caption.mogrt.\n\n' +
           'Open Essential Graphics (Window → Essential Graphics) and click "Export Motion Graphics Template…", ' +
           'save it to the Desktop as Pulse_Caption.mogrt, and send it to Pulse\'s maker.');
    } else {
      // Font editing on the Text control cannot be switched on by script, and
      // Pulse needs it to give each style its own font in Premiere
      if (exprErrors.length) {
        alert('Pulse Caption is built, but After Effects reports ' + exprErrors.length + ' problem(s). ' +
              'Please take a screenshot of this message and send it — do not export yet.\n\n' +
              exprErrors.slice(0, 12).join('\n'));
      } else alert('Pulse Caption is built (self-check passed). One last step by hand (After Effects has no script for it):\n\n' +
            '1. In Essential Graphics, on the Text row, click "Edit Properties".\n' +
            '2. Tick "Allow font editing", "Allow faux styles" and "Allow font size editing" → OK.\n' +
            '3. Click "Export Motion Graphics Template…" → Desktop → Save (replace).\n\n' +
            'Then zip the folder "Pulse Caption Template" on your Desktop and send it.');
    }
  } catch (e) {
    fail('Something went wrong on line ' + (e.line || '?') + ':\n' + e.toString() + '\n\nSend a screenshot of this message.');
  } finally {
    app.endUndoGroup();
  }
})();
