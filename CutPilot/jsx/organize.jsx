/*
 * CutPilot — One-Click Organizer (ExtendScript host, ES3 / CEP).
 * Self-contained: defines CPO_* functions and never touches CutPilot's host.jsx.
 * Loaded by js/organize.js via $.evalFile at panel start.
 * Returns JSON strings shaped {ok:true,...} / {ok:false,error:"..."} to match
 * CutPilot's bridge convention (CPBridge.callHost).
 */

function CPO_ok(o) { o.ok = true; return JSON.stringify(o); }
function CPO_fail(m) { return JSON.stringify({ ok: false, error: String(m) }); }

function CPO_ext(s) {
  if (!s) return "";
  s = String(s);
  var slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  var base = slash >= 0 ? s.substring(slash + 1) : s;
  var dot = base.lastIndexOf(".");
  return dot >= 0 ? base.substring(dot + 1).toLowerCase() : "";
}

var CPO_EXT = {
  video: "3g2,3gp,ari,arri,asf,av1,avi,braw,cine,crm,divx,dv,f4v,flv,gxf,insv,m2t,m2ts,m2v,m4v,mkv,mov,mp4,mpeg,mpg,mts,mxf,ogv,qt,r3d,ts,vob,webm,wmv,y4m",
  audio: "aac,aif,aiff,bwf,flac,m4a,mp3,ogg,wav,wma",
  image: "arw,bmp,cr2,cr3,dng,gif,heic,jpeg,jpg,nef,png,psd,tif,tiff,webp",
  graphic: "ai,eps,mogrt,svg",
  caption: "cap,dfxp,mcc,sami,scc,smi,srt,stl,ttml,vtt",
  afterEffects: "aep,aepx",
  lut: "3dl,cube,epr,look,prfpset",
  projectData: "aaf,csv,edl,fcpxml,json,prproj,xml",
  document: "doc,docx,md,pdf,rtf,txt,xls,xlsx"
};
function CPO_inList(list, ext) {
  if (!ext) return false;
  return ("," + list + ",").indexOf("," + ext + ",") >= 0;
}
var CPO_ALL = (function () { var a = ""; for (var k in CPO_EXT) { a += CPO_EXT[k] + ","; } return a; })();

var CPO_RE = {
  proxy:     /(^|[\s._-])(proxy|proxies|lowres|low-res)($|[\s._-])/i,
  voiceover: /(^|[\s._-])(vo|voiceover|voice-over|narration|dialogue|dialog|adr)($|[\s._-])/i,
  music:     /(^|[\s._-])(music|song|score|soundtrack|bgm|instrumental|theme)($|[\s._-])/i,
  sfx:       /(^|[\s._-])(sfx|sound-effect|sound_effect|soundeffect|foley|ambience|ambient|whoosh|impact|riser|roomtone|room-tone)($|[\s._-])/i,
  generated: /^(adjustment layer|bars and tone|black video|color matte|transparent video|universal counting leader)/i
};

function CPO_classify(name, mediaPath, isSeq) {
  if (CPO_RE.generated.test(name)) return "generated";
  if (isSeq) return "sequence";
  var searchable = name + " " + (mediaPath || "");
  var ext = CPO_ext(mediaPath);
  if (!ext) { var ne = CPO_ext(name); if (CPO_inList(CPO_ALL, ne)) ext = ne; }
  if (CPO_inList(CPO_EXT.afterEffects, ext)) return "afterEffects";
  if (CPO_inList(CPO_EXT.caption, ext)) return "caption";
  if (CPO_inList(CPO_EXT.lut, ext)) return "lut";
  if (CPO_inList(CPO_EXT.projectData, ext)) return "projectData";
  if (CPO_inList(CPO_EXT.document, ext)) return "document";
  if (CPO_inList(CPO_EXT.graphic, ext)) return "graphic";
  if (CPO_inList(CPO_EXT.image, ext)) return "image";
  if (CPO_inList(CPO_EXT.video, ext)) return CPO_RE.proxy.test(searchable) ? "proxy" : "video";
  if (CPO_inList(CPO_EXT.audio, ext)) {
    if (CPO_RE.voiceover.test(searchable)) return "voiceover";
    if (CPO_RE.music.test(searchable)) return "music";
    if (CPO_RE.sfx.test(searchable)) return "sfx";
    return "audio";
  }
  return "other";
}

function CPO_path(cat) {
  if (cat === "sequence") return ["Sequences"];
  if (cat === "video") return ["Video"];
  if (cat === "proxy") return ["Video", "Proxies"];
  if (cat === "image") return ["Images & Photos"];
  if (cat === "music") return ["Audio", "Music"];
  if (cat === "sfx") return ["Audio", "Sound Effects (SFX)"];
  if (cat === "voiceover") return ["Audio", "Voiceover & Dialogue"];
  if (cat === "audio") return ["Audio", "Other Audio"];
  if (cat === "graphic") return ["Graphics & Titles"];
  if (cat === "caption") return ["Captions & Subtitles"];
  if (cat === "generated") return ["Adjustment & Generated Media"];
  if (cat === "lut") return ["LUTs & Presets"];
  if (cat === "afterEffects" || cat === "projectData" || cat === "document") return ["Project & Data Files"];
  return ["Other"];
}

function CPO_findChildBin(parent, name) {
  var kids = parent.children;
  for (var i = 0; i < kids.numItems; i++) {
    var c = kids[i];
    if (c && c.type === 2 && String(c.name) === String(name)) return c;
  }
  return null;
}
function CPO_ensureBin(parent, name) {
  var b = CPO_findChildBin(parent, name);
  if (b) return b;
  parent.createBin(name);
  return CPO_findChildBin(parent, name);
}
function CPO_ensurePath(root, path) {
  var cur = root;
  for (var i = 0; i < path.length; i++) { cur = CPO_ensureBin(cur, path[i]); if (!cur) return null; }
  return cur;
}

function CPO_sequenceNames() {
  var set = {};
  try {
    var seqs = app.project.sequences;
    var n = seqs.numSequences;
    for (var i = 0; i < n; i++) { set[String(seqs[i].name)] = true; }
  } catch (e) {}
  return set;
}

function CPO_organize() {
  try {
    if (!app.project) return CPO_fail("Open a project first.");
    var root = app.project.rootItem;
    var seqNames = CPO_sequenceNames();

    // Snapshot loose (non-bin) top-level items before mutating the tree.
    var items = [];
    var kids = root.children;
    for (var i = 0; i < kids.numItems; i++) {
      var c = kids[i];
      if (!c) continue;
      if (c.type === 2) continue; // skip bins (including our own, so re-runs are safe)
      items.push(c);
    }
    if (items.length === 0) return CPO_ok({ moved: 0, counts: {}, report: [], message: "Nothing to organize. Add media to your project first." });

    var counts = {};
    var report = [];
    var moved = 0;

    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      var name = "";
      try { name = String(it.name); } catch (eN) {}
      var mp = "";
      try { if (it.getMediaPath) mp = String(it.getMediaPath()); } catch (eM) { mp = ""; }
      var isSeq = false;
      try { if (it.isSequence) isSeq = it.isSequence(); } catch (eS) {}
      if (!isSeq && (!mp || mp === "") && seqNames[name]) isSeq = true;

      var cat = CPO_classify(name, mp, isSeq);
      var path = CPO_path(cat);
      var dest = CPO_ensurePath(root, path);
      var top = path[0];
      counts[top] = (counts[top] || 0) + 1;

      var ok = false;
      if (dest) { try { it.moveBin(dest); moved++; ok = true; } catch (eMove) {} }
      report.push({ name: name, ext: CPO_ext(mp || name), dest: path.join("/"), moved: ok });
    }

    return CPO_ok({ moved: moved, counts: counts, report: report });
  } catch (e) {
    return CPO_fail(e);
  }
}
