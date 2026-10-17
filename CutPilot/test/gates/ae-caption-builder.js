/*
 * ae-caption-builder.js — the After Effects script that builds Pulse's own
 * editable caption template (tools/ae/Pulse-Caption-Builder.jsx) runs, and
 * what it builds behaves.
 *
 * The owner runs the script once in After Effects; it cannot be run here, so
 * it runs against a stand-in After Effects object model that records what
 * the script asks for, and the expressions it writes are run on their own:
 *   A. the script is ES3 (ExtendScript) and runs to the end without an error;
 *   B. Premiere shows ONLY the 14 controls a caption needs, by these names,
 *      in this order (no "Note", "Word Index", gradient plumbing…);
 *   C. every expression it writes parses;
 *   D. the spoken word follows the caption's share of time, across lines
 *      (index, line and place on the line);
 *   E. the measuring layers hold the spoken word's line, the words up to it
 *      and the word itself, and the spoken-word box sits on that word;
 *   F. one protected frame at the start (Premiere then stretches the rest
 *      over each caption) and the template is saved as Pulse_Caption.mogrt.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { failed++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')); };
const SRC = path.join(__dirname, '..', '..', '..', 'tools', 'ae', 'Pulse-Caption-Builder.jsx');
const code = fs.readFileSync(SRC, 'utf8');

console.log('🎬 Pulse Caption template builder (After Effects)');
let acorn = null;
try { acorn = require('acorn'); } catch (e) {
  for (const p of [path.join(__dirname, '..', '..', '..', 'node_modules', 'acorn'), '/usr/lib/node_modules/acorn']) { try { acorn = require(p); break; } catch (e2) {} }
}

// ---- a stand-in After Effects ---------------------------------------------
const rec = { expressions: [], exposed: [], alerts: [], markers: [], saved: [], exported: [] };
function Node(matchName, owner, layer) {
  this.matchName = matchName; this.name = matchName; this.kids = []; this.owner = owner; this.layer = layer || null;
  this.hasMax = false; this.maxValue = 255;
}
Node.prototype.where = function () { const l = this.layer ? this.layer.name : '?'; let n = this, p = []; while (n && n !== this.layer) { p.unshift(n.name); n = n.owner; } return l + ' › ' + p.join(' › '); };
Node.prototype.addProperty = function (m) { const k = new Node(m, this, this.layer); if (/Drop Shadow-0002/.test(m)) k.hasMax = true; this.kids.push(k); return k; };
Node.prototype.property = function (x) {
  if (typeof x === 'number') { while (this.kids.length < x) this.addProperty(this.matchName + '-' + String(this.kids.length + 1).padStart(4, '0')); return this.kids[x - 1]; }
  const hit = this.kids.find(k => k.name === x || k.matchName === x);
  if (hit) return hit;
  if (this.matchName === 'ADBE Effect Parade') return null;   // AE: no effect by that name
  return this.addProperty(x);
};
Node.prototype.setValue = function (v) { this.v = v; };
// the self-check's view: groups hold properties; a leaf reports its
// expression error (the stand-in can fail one on purpose: FAIL_EXPR)
Object.defineProperty(Node.prototype, 'numProperties', { get() { return this.kids.length; } });
Object.defineProperty(Node.prototype, 'propertyType', { get() { return this.kids.length ? 2 : 1; } });
Object.defineProperty(Node.prototype, 'expressionError', { get() { return (process.env.FAIL_EXPR && this.expr && this.expr.indexOf(process.env.FAIL_EXPR) >= 0) ? 'Error: boom' : ''; } });
Node.prototype.valueAtTime = function () { return this.v != null ? this.v : 0; };
// After Effects rebuilds a dropdown effect when its menu is filled: the old
// reference goes stale and the name resets (the owner's AE: "null is not an
// object" when the script looked it up by the name it had set)
Node.prototype.setPropertyParameters = function (items) {
  const eff = this.owner, grp = eff.owner, at = grp.kids.indexOf(eff);
  const fresh = new Node(eff.matchName, grp, eff.layer); fresh.name = 'Dropdown Menu Control';
  const menu = fresh.property(1); menu.items = items;
  grp.kids[at] = fresh; eff.stale = true;
  return menu;
};
Object.defineProperty(Node.prototype, 'propertyIndex', { get() { return this.owner.kids.indexOf(this) + 1; } });
Node.prototype.canAddToMotionGraphicsTemplate = function () { return true; };
// AE puts each newly added control at the TOP of the Essential Graphics list
Node.prototype.addToMotionGraphicsTemplateAs = function (comp, label) { rec.exposed.unshift({ label, prop: this }); return true; };
Object.defineProperty(Node.prototype, 'expression', { set(e) { this.expr = e; rec.expressions.push({ where: this.where(), prop: this, expr: e }); }, get() { return this.expr || ''; } });
Object.defineProperty(Node.prototype, 'value', { get() { return this.v || { resetCharStyle() {}, resetParagraphStyle() {} }; } });
function Layer(name) { Node.call(this, 'layer', null, null); this.layer = this; this.name = name; this.parent = null; }
Layer.prototype = Object.create(Node.prototype);
Layer.prototype.effect = function (n) { return this.property('ADBE Effect Parade').property(n); };
Layer.prototype.moveAfter = function (l) { this.after = l.name; };
Object.defineProperty(Layer.prototype, 'index', { get() { return comp.layers.list.indexOf(this) + 1; } });
const comp = {
  layers: { list: [], add(l) { this.list.unshift(l); return l; },
    addNull() { return this.add(new Layer('Null')); }, addText(t) { const l = new Layer('Text'); l.text0 = t; return this.add(l); }, addShape() { return this.add(new Layer('Shape')); } },
  markerProperty: { setValueAtTime(t, mv) { rec.markers.push({ t, mv }); } },
  get numLayers() { return this.layers.list.length; },
  layer(i) { return this.layers.list[i - 1]; },
  exportAsMotionGraphicsTemplate(over, p) { if (this.stale) throw new Error('Object is invalid'); rec.exported.push(p); return true; },
  openInViewer() { if (this.stale) throw new Error('Object is invalid'); }
};
const sandbox = {
  app: { version: '24.1.0', beginUndoGroup() {}, endUndoGroup() {}, newProject() {}, beginSuppressDialogs() {}, endSuppressDialogs() {},
         project: { items: { addComp(n, w, h, pa, d, f) { Object.assign(comp, { name: n, width: w, height: h, duration: d, frameRate: f }); return comp; } },
                    // a save leaves the comp reference stale, as on the owner's Mac
                    save(f) { rec.saved.push(f.path); comp.stale = true; },
                    get numItems() { return 1; }, item(k) { return k === 1 ? freshComp : null; } } },
  CompItem: function () {},
  PropertyType: { PROPERTY: 1, INDEXED_GROUP: 2, NAMED_GROUP: 3 },
  ParagraphJustification: { CENTER_JUSTIFY: 'center' },
  MarkerValue: function (c) { this.comment = c; },
  File: function (p) { this.path = p; this.fsName = p; this.exists = true; },
  Folder: Object.assign(function (p) { this.fsName = p; this.exists = false; this.create = () => true; }, { desktop: { fsName: '/Users/owner/Desktop' } }),
  alert: (m) => rec.alerts.push(String(m))
};

const freshComp = Object.create(sandbox.CompItem.prototype);
Object.assign(freshComp, { name: 'Pulse Caption', openInViewer() { rec.viewed = true; } });

// A. ES3 + runs
if (acorn) {
  try { acorn.parse(code, { ecmaVersion: 3, allowReserved: 'never' }); ok('A. the script is ES3 (what After Effects runs)'); }
  catch (e) { bad('A. the script is ES3', e.message); }
} else console.log('  ? acorn not found — ES3 parse skipped');
try { vm.runInNewContext(code, sandbox, { filename: 'Pulse-Caption-Builder.jsx' }); } catch (e) { bad('A. the script runs', e.stack); }
const wentWrong = rec.alerts.filter(a => /went wrong|needs After Effects|did not save/.test(a));
(!wentWrong.length && rec.alerts.some(a => /is built/.test(a) && /Allow font editing/.test(a)) ? ok : bad)('A. it runs to the end, says the template is built and how to allow font editing', JSON.stringify(rec.alerts));

// B. the controls Premiere shows
const WANT = ['Text', 'Size', 'Text Color', 'Text Gradient', 'Text Color 2', 'Spoken Word Color', 'Spoken Word Grow', 'Upcoming Opacity',
  'Letter Spacing', 'Outline Color', 'Outline Width',
  'Box', 'Box Color', 'Word Box Color', 'Box Opacity', 'Box Roundness', 'Shadow Opacity', 'Shadow Distance', 'Tilt', 'Animation', 'Exit'];
const labels = rec.exposed.map(e => e.label);
(JSON.stringify(labels) === JSON.stringify(WANT) ? ok : bad)('B. Premiere shows only the ' + WANT.length + ' caption controls, in order', JSON.stringify(labels));
const menus = rec.exposed.filter(e => e.prop.items).map(e => e.label + ': ' + e.prop.items.join(' / '));
(menus.length === 3 && /Box: None \/ Whole line \/ Spoken word \/ Line and spoken word/.test(menus[0]) && /Animation: None \/ Pop \/ Fade \/ Slide up/.test(menus[1]) &&
  /Exit: None \/ Fade \/ Shrink \/ Slide down/.test(menus[2]) ? ok : bad)('B. the three menus: ' + menus.join(' · '));
const kinds = {};
rec.exposed.forEach(e => { kinds[e.label] = e.prop.owner && e.prop.owner.matchName; });
(kinds['Tilt'] === 'ADBE Angle Control' && kinds['Text Gradient'] === 'ADBE Checkbox Control' && kinds['Text Color 2'] === 'ADBE Color Control' &&
  kinds['Upcoming Opacity'] === 'ADBE Slider Control' ? ok : bad)('B. Tilt is an angle, Text Gradient a tick box, Text Color 2 a colour, Upcoming Opacity a slider', JSON.stringify(kinds));

// C. expressions parse
let parseBad = [];
rec.expressions.forEach(x => { try { if (acorn) acorn.parse(x.expr, { ecmaVersion: 5 }); else new Function(x.expr); } catch (e) { parseBad.push(x.where + ': ' + e.message); } });
(!parseBad.length && rec.expressions.length > 20 ? ok : bad)('C. all ' + rec.expressions.length + ' expressions parse (ES5)', parseBad.join('\n      '));

// ---- run the expressions --------------------------------------------------
const exprOf = (layer, re) => { const x = rec.expressions.find(e => e.where.indexOf(layer + ' ›') === 0 && re.test(e.where)); return x ? x.expr : null; };
function run(expr, env) {
  const f = new Function('thisComp', 'time', 'value', 'ease', 'linear', 'sourceRectAtTime', 'return eval(arguments[6]);');
  const linear = (t, a, b, x, y) => t <= a ? x : t >= b ? y : x + (y - x) * (t - a) / (b - a);
  return f(env.thisComp, env.time, env.value, linear, linear, env.sourceRectAtTime, expr);
}
function world(text, time, centred) {
  const ctl = {};
  const measured = {};
  const charW = 40;
  const thisComp = {
    duration: 2,
    layer(n) {
      if (n === 'Caption') {
        const st = { toString: () => text, style: { setText: (t) => t } };
        return { text: { sourceText: st }, sourceRectAtTime: () => ({ left: -200, top: -60, width: 400, height: 150 }) };
      }
      if (n === 'Controls') return { effect: (e) => () => ctl[e] };
      if (/^Measure /.test(n)) return { sourceRectAtTime: () => { const s = measured[n] || '', w = s.length * charW; return { left: centred ? -w / 2 : 0, top: -55, width: w, height: 70 }; } };
      throw new Error('no layer ' + n);
    }
  };
  const env = { thisComp, time, value: [0, 0] };
  ctl['Spoken Word Grow'] = 0;
  for (const k of ['Spoken Index', 'Spoken Line', 'Spoken Pos']) ctl[k] = run(exprOf('Controls', new RegExp(k)), env);
  for (const m of ['Measure Line', 'Measure Upto', 'Measure Word']) measured[m] = run(exprOf(m, /Text Document/), env);
  const sz = run(exprOf('Spoken Word Box', /Rect Size/), env), pos = run(exprOf('Spoken Word Box', /Rect Position/), env);
  return { ctl, measured, sz, pos };
}

// D. the spoken word over time (5 words on two lines, the comp is 2 s)
const TXT = 'AAJ PAISE KI\rBAAT KARENGE';
const seq = [0.05, 0.45, 0.85, 1.25, 1.65, 1.99].map(t => world(TXT, t).ctl);
const idx = seq.map(c => c['Spoken Index']), lines = seq.map(c => c['Spoken Line']), poss = seq.map(c => c['Spoken Pos']);
(JSON.stringify(idx) === '[0,1,2,3,4,4]' && JSON.stringify(lines) === '[0,0,0,1,1,1]' && JSON.stringify(poss) === '[0,1,2,0,1,1]' ? ok : bad)(
  'D. the spoken word follows its share of the caption, across lines (index ' + idx.join(',') + ' · line ' + lines.join(',') + ' · place ' + poss.join(',') + ')');

// E. measures + the box on "PAISE"
const w1 = world(TXT, 0.45);
(w1.measured['Measure Line'] === 'AAJ PAISE KI' && w1.measured['Measure Upto'] === 'AAJ PAISE' && w1.measured['Measure Word'] === 'PAISE' ? ok : bad)(
  'E. the measures hold the line, the words up to the spoken one and the word', JSON.stringify(w1.measured));
// monospace 40 px: the centred line spans -240..240, PAISE is chars 4-8 → -80..120
(Math.abs(w1.pos[0] - 20) < 0.01 && Math.abs(w1.sz[0] - (200 + 2 * 75 * 0.32)) < 0.01 ? ok : bad)(
  'E. the spoken-word box sits on PAISE (centre x ' + w1.pos[0] + ', width ' + w1.sz[0] + ')');
const wc = world(TXT, 0.45, true);
(Math.abs(wc.pos[0] - 20) < 0.01 ? ok : bad)('E. the same when After Effects centres the measuring text (centre x ' + wc.pos[0] + ')');
const w2 = world(TXT, 1.25);
(w2.measured['Measure Word'] === 'BAAT' && Math.abs(w2.pos[1] - (90 - 55 + 35)) < 0.01 ? ok : bad)('E. on the second line the box moves down one line (y ' + w2.pos[1] + ')');

// G. which box shows for each Box choice (1 None · 2 Line · 3 Spoken word · 4 both)
const opOf = (layer, box) => run(exprOf(layer, /ADBE Opacity/), { thisComp: { layer: () => ({ effect: (e) => () => ({ Animation: 1, Box: box, 'Box Opacity': 88 })[e] }) }, time: 0.5 });
const ops = [1, 2, 3, 4].map(b => [opOf('Line Box', b), opOf('Spoken Word Box', b)]);
(JSON.stringify(ops) === '[[0,0],[88,0],[0,88],[88,100]]' ? ok : bad)('G. line box on 2 and 4, word box on 3 and 4 (solid over a line box): ' + JSON.stringify(ops));

// H. v4: exit, tilt, upcoming words, gradient
const grpExpr = (re) => { const x = rec.expressions.find(e => /^Group ›/.test(e.where) && re.test(e.where)); return x ? x.expr : null; };
// as in After Effects, a control reaches an expression as an OBJECT (it
// becomes a number only in arithmetic): a bare `ctrl ? a : b` is always a
function ctlEnv(vals, time) { return { thisComp: { duration: 2, layer: () => ({ effect: (e) => () => ({ valueOf: () => vals[e] }) }) }, time, value: [540, 960] }; }
const base = { Animation: 1, Exit: 1, Size: 100, Tilt: 0 };
const opAt = (ex, t) => run(exprOf('Line Box', /ADBE Opacity/), ctlEnv(Object.assign({}, base, { Exit: ex, Box: 2, 'Box Opacity': 100 }), t));
(opAt(1, 1.99) === 100 && opAt(2, 1.0) === 100 && opAt(2, 2) === 0 && opAt(2, 1.91) > 0 && opAt(2, 1.91) < 100 ? ok : bad)(
  'H. Exit Fade: full until the last stretch, gone at the end (None stays: ' + opAt(1, 1.99) + ', Fade at 1.91 s: ' + Math.round(opAt(2, 1.91)) + ')');
const scAt = (ex, t) => +run(grpExpr(/ADBE Scale/), ctlEnv(Object.assign({}, base, { Exit: ex }), t))[0];   // + : AE uses a returned control's number
const poAt = (ex, t) => run(grpExpr(/ADBE Position/), ctlEnv(Object.assign({}, base, { Exit: ex }), t))[1];
(scAt(3, 2) === 60 && scAt(3, 1) === 100 && poAt(4, 2) === 1020 && poAt(4, 1) === 960 && scAt(1, 2) === 100 ? ok : bad)(
  'H. Exit Shrink ends at 60%, Slide down ends 60 px lower, both untouched mid-caption');
(+run(grpExpr(/ADBE Rotate Z/), ctlEnv(Object.assign({}, base, { Tilt: -4 }), 1)) === -4 ? ok : bad)('H. Tilt turns the whole caption group');
const upS = exprOf('Caption', /Upcoming.*Index Start/), upO = exprOf('Caption', /Upcoming.*Opacity/);
(upS && upO && run(upS, ctlEnv({ 'Spoken Index': 2 }, 1)) === 3 && +run(upO, ctlEnv({ 'Upcoming Opacity': 35 }, 1)) === 35 ? ok : bad)(
  'H. Upcoming Opacity reaches the words after the spoken one');
const gOp = (on) => run(exprOf('Gradient Text', /ADBE Opacity/), ctlEnv(Object.assign({}, base, { 'Text Gradient': on }), 1));
const gSpoken = exprOf('Gradient Text', /Spoken Word.*ADBE Text Opacity/);
const gStroke = exprOf('Gradient Text', /Look.*Stroke Width/);
const gC1 = exprOf('Gradient Text', /Ramp-0002/), gC2 = exprOf('Gradient Text', /Ramp-0004/);
(gOp(1) === 100 && gOp(0) === 0 && gSpoken === '0;' && gStroke === '0;' && /Text Color"/.test(gC1) && /Text Color 2"/.test(gC2) ? ok : bad)(
  'H. Text Gradient: a letters-only copy shown only when ticked, Text Color → Text Color 2, no outline, the spoken word left to the caption');

// I. the self-check: a clean build says so; the gradient copy starts hidden
(rec.alerts.some(a => /self-check passed/.test(a)) ? ok : bad)('I. a clean build says its self-check passed', JSON.stringify(rec.alerts));
const gOpacity = (() => { const L = comp.layers.list.find(l => l.name === 'Gradient Text'); return L && L.property('ADBE Transform Group').property('ADBE Opacity').v; })();
(gOpacity === 0 ? ok : bad)('I. the gradient copy is hidden unless its expression shows it (a failing expression cannot paint every caption)');
if (!process.env.FAIL_EXPR) {
  const cpr = require('child_process').spawnSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { FAIL_EXPR: 'Text Gradient' }), encoding: 'utf8' });
  (/I\. FAILED-EXPR-REPORTED/.test(cpr.stdout) ? ok : bad)('I. an expression After Effects rejects is named in the final message, with "do not export yet"');
} else {
  const a = rec.alerts.find(x => /reports \d+ problem/.test(x)) || '';
  if (/do not export yet/.test(a) && /Gradient Text > .*Opacity: Error: boom/.test(a)) console.log('  I. FAILED-EXPR-REPORTED');
  process.exit(0);
}

// F. protected frame + saved
const mk = rec.markers[0];
(mk && mk.t === 0 && mk.mv.protectedRegion === true && Math.abs(mk.mv.duration - 1 / 30) < 1e-9 ? ok : bad)('F. one protected frame at the start (Premiere stretches the rest over the caption)');
(rec.exported.length === 1 && /Desktop\/Pulse Caption Template$/.test(rec.exported[0]) && rec.saved.some(p => /Pulse_Caption\.aep$/.test(p)) ? ok : bad)('F. saved into the Desktop folder "Pulse Caption Template" (and the .aep)', JSON.stringify({ exported: rec.exported, saved: rec.saved }));

if (failed) { console.log('AE CAPTION BUILDER: ' + failed + ' failed'); process.exit(1); }
console.log('AE CAPTION BUILDER: builds the clean template ✓');
