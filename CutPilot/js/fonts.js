/*
 * Pulse — installed-font discovery.
 * Reads the family name(s) out of the font files in the OS font folders so the
 * caption picker can list every font the user actually has installed (those
 * names are exactly what the <canvas> renderer needs to draw with).
 *
 * parseFamilyNames() is pure (Buffer/Uint8Array in -> names out) and unit
 * tested; listInstalledFonts() takes fs/path injected so it stays testable.
 * No DOM/CEP dependencies.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPFonts = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
  // avoid <<24 sign issues by using multiplication for the high byte
  function u32(b, o) { return (b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
  function tag4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

  function decodeUTF16BE(b, o, len) {
    var s = '';
    for (var i = 0; i + 1 < len; i += 2) s += String.fromCharCode((b[o + i] << 8) | b[o + i + 1]);
    return s;
  }
  function decodeLatin1(b, o, len) {
    var s = '';
    for (var i = 0; i < len; i++) s += String.fromCharCode(b[o + i]);
    return s;
  }

  function cleanName(name) {
    // drop any control chars (incl. stray nulls), collapse runs of whitespace,
    // and trim — but keep the spaces inside names like "Times New Roman".
    var out = '';
    for (var i = 0; i < name.length; i++) {
      var c = name.charCodeAt(i);
      out += (c < 32) ? ' ' : name.charAt(i);
    }
    return out.replace(/\s+/g, ' ').replace(/^ +| +$/g, '');
  }

  /* Parse a 'name' table at absolute offset `tableOff`, pushing
     {nameID, name} for family records (1 = legacy family, 16 = typographic). */
  function parseNameTableAt(b, tableOff, out) {
    if (tableOff + 6 > b.length) return;
    var count = u16(b, tableOff + 2);
    var storage = tableOff + u16(b, tableOff + 4);
    var rec = tableOff + 6;
    for (var i = 0; i < count; i++, rec += 12) {
      if (rec + 12 > b.length) break;
      var nameID = u16(b, rec + 6);
      if (nameID !== 1 && nameID !== 16) continue;
      var platformID = u16(b, rec);
      var len = u16(b, rec + 8);
      var so = storage + u16(b, rec + 10);
      if (so + len > b.length) continue;
      var raw = (platformID === 1) ? decodeLatin1(b, so, len) : decodeUTF16BE(b, so, len);
      var name = cleanName(raw);
      if (name) out.push({ nameID: nameID, name: name });
    }
  }

  function parseOffsetTableAt(b, off, out) {
    if (off + 12 > b.length) return;
    var numTables = u16(b, off + 4);
    var rec = off + 12;
    for (var i = 0; i < numTables; i++, rec += 16) {
      if (rec + 16 > b.length) break;
      if (tag4(b, rec) === 'name') { parseNameTableAt(b, u32(b, rec + 8), out); return; }
    }
  }

  /* ---- glyph coverage: can this font actually DRAW the caption? ----------
     macOS installs dozens of script-only faces ("Noto Sans Coptic", "Noto Sans
     Adlam", …) that contain no English or Hindi letters. The picker offered
     every one of them, their names looked normal, and on the owner's Mac a
     caption job was sent "NotoSansCoptic-Bold" — Premiere then drew NOTHING.
     The font's own cmap table says exactly which characters it has, so read it
     instead of guessing. */
  function s16(b, o) { var v = u16(b, o); return v > 0x7FFF ? v - 0x10000 : v; }

  /* Build a has(codepoint) test from one cmap subtable (format 4 or 12). */
  function cmapSubtable(b, st) {
    if (st + 4 > b.length) return null;
    var fmt = u16(b, st);
    if (fmt === 4) {
      var segX2 = u16(b, st + 6), seg = segX2 / 2;
      var endO = st + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
      if (rangeO + segX2 > b.length) return null;
      return function (cp) {
        if (cp > 0xFFFF) return false;
        for (var i = 0; i < seg; i++) {
          var end = u16(b, endO + 2 * i);
          if (cp > end) continue;
          var start = u16(b, startO + 2 * i);
          if (cp < start) return false;
          var ro = u16(b, rangeO + 2 * i), g;
          if (ro === 0) g = (cp + s16(b, deltaO + 2 * i)) & 0xFFFF;
          else {
            var gi = rangeO + 2 * i + ro + 2 * (cp - start);
            if (gi + 2 > b.length) return false;
            g = u16(b, gi);
            if (g !== 0) g = (g + s16(b, deltaO + 2 * i)) & 0xFFFF;
          }
          return g !== 0;
        }
        return false;
      };
    }
    if (fmt === 12) {
      var n = u32(b, st + 12), gO = st + 16;
      if (gO + 12 * n > b.length) return null;
      return function (cp) {
        for (var i = 0; i < n; i++) {
          var o = gO + 12 * i;
          if (cp >= u32(b, o) && cp <= u32(b, o + 4)) return true;
        }
        return false;
      };
    }
    return null;
  }

  /* The best Unicode cmap of the font at offset `off` (full-repertoire first). */
  function cmapAt(b, off) {
    if (off + 12 > b.length) return null;
    var numTables = u16(b, off + 4), rec = off + 12, cmapOff = -1;
    for (var i = 0; i < numTables; i++, rec += 16) {
      if (rec + 16 > b.length) break;
      if (tag4(b, rec) === 'cmap') { cmapOff = u32(b, rec + 8); break; }
    }
    if (cmapOff < 0 || cmapOff + 4 > b.length) return null;
    var n = u16(b, cmapOff + 2), best = null, bestRank = 99;
    for (var j = 0; j < n; j++) {
      var r = cmapOff + 4 + 8 * j;
      if (r + 8 > b.length) break;
      var pid = u16(b, r), eid = u16(b, r + 2), so = cmapOff + u32(b, r + 4);
      if (so + 2 > b.length) continue;
      var fmt = u16(b, so), rank = 99;
      if (pid === 3 && eid === 10 && fmt === 12) rank = 0;
      else if (pid === 0 && fmt === 12) rank = 1;
      else if (pid === 3 && eid === 1 && fmt === 4) rank = 2;
      else if (pid === 0 && fmt === 4) rank = 3;
      if (rank < bestRank) { var fn = cmapSubtable(b, so); if (fn) { best = fn; bestRank = rank; } }
    }
    return best;
  }

  // Sample sets: every Latin letter, and the Devanagari letters, vowel signs and
  // virama a Hindi caption cannot do without.
  var LATIN_SAMPLE = [];
  (function () { for (var c = 65; c <= 90; c++) { LATIN_SAMPLE.push(c); LATIN_SAMPLE.push(c + 32); } })();
  var DEVANAGARI_SAMPLE = [0x0915, 0x0916, 0x0917, 0x091A, 0x091C, 0x0924, 0x0926, 0x0928, 0x092A,
                           0x092C, 0x092E, 0x092F, 0x0930, 0x0932, 0x0935, 0x0938, 0x0939,
                           0x093E, 0x093F, 0x0940, 0x0947, 0x094B, 0x094D, 0x0902];
  function covers(has, sample, need) {
    var hit = 0;
    for (var i = 0; i < sample.length; i++) if (has(sample[i])) hit++;
    return hit >= Math.ceil(sample.length * need);
  }

  /* {latin, devanagari} for a font file buffer (OR over every face in a .ttc).
     null when the file can't be read — never a false "can't draw". */
  function parseCoverage(buf) {
    var b = buf;
    if (!b || b.length < 12) return null;
    var offs = [], tag = tag4(b, 0);
    if (tag === 'ttcf') {
      var numFonts = u32(b, 8);
      for (var i = 0, p = 12; i < numFonts && p + 4 <= b.length; i++, p += 4) offs.push(u32(b, p));
    } else if (u32(b, 0) === 0x00010000 || tag === 'OTTO' || tag === 'true') {
      offs.push(0);
    } else return null;
    var out = null;
    for (var k = 0; k < offs.length; k++) {
      var has = cmapAt(b, offs[k]);
      if (!has) continue;
      out = out || { latin: false, devanagari: false };
      if (!out.latin && covers(has, LATIN_SAMPLE, 0.95)) out.latin = true;
      if (!out.devanagari && covers(has, DEVANAGARI_SAMPLE, 0.95)) out.devanagari = true;
    }
    return out;
  }

  /* Which scripts a piece of caption text needs. Pure. */
  function scriptNeeds(text) {
    var t = String(text == null ? '' : text);
    return { latin: /[A-Za-z]/.test(t), devanagari: /[\u0900-\u097F]/.test(t) };
  }
  /* Can a font with coverage `cov` draw text needing `needs`? null = unknown.
     With no text to go on, a face must at least draw English OR Hindi — the
     script-only faces are exactly the ones that draw nothing. */
  function canDraw(cov, needs) {
    if (!cov) return null;
    if (!needs || (!needs.latin && !needs.devanagari)) return !!(cov.latin || cov.devanagari);
    return (!needs.latin || cov.latin) && (!needs.devanagari || cov.devanagari);
  }

  /* Family name(s) inside a font file buffer (sfnt: ttf/otf, or a ttc
     collection). Returns [] for anything it can't read. */
  function parseFamilyNames(buf) {
    var b = buf;
    if (!b || b.length < 12) return [];
    var out = [];
    var tag = tag4(b, 0);
    if (tag === 'ttcf') {
      var numFonts = u32(b, 8), p = 12;
      for (var i = 0; i < numFonts && p + 4 <= b.length; i++, p += 4) parseOffsetTableAt(b, u32(b, p), out);
    } else if (u32(b, 0) === 0x00010000 || tag === 'OTTO' || tag === 'true' || tag === 'typ1') {
      parseOffsetTableAt(b, 0, out);
    } else {
      return [];
    }
    // prefer the typographic family (16) over the legacy family (1); dedupe
    var pref = {}, seen = {}, list = [];
    out.forEach(function (n) { if (n.nameID === 16) pref[n.name.toLowerCase()] = 1; });
    out.forEach(function (n) {
      var key = n.name.toLowerCase();
      if (pref[key] && n.nameID !== 16) return;
      if (seen[key]) return;
      seen[key] = 1; list.push(n.name);
    });
    return list;
  }

  /* The OS font folders for a platform (args injected for testability). */
  function systemFontDirs(platform, env, home) {
    platform = platform || (typeof process !== 'undefined' ? process.platform : '');
    env = env || (typeof process !== 'undefined' ? process.env : {}) || {};
    home = home || env.HOME || env.USERPROFILE || '';
    if (platform === 'win32') {
      var dirs = [(env.WINDIR || 'C:\\Windows') + '\\Fonts'];
      if (env.LOCALAPPDATA) dirs.push(env.LOCALAPPDATA + '\\Microsoft\\Windows\\Fonts');
      return dirs;
    }
    if (platform === 'darwin') {
      var d = ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts'];
      if (home) d.push(home + '/Library/Fonts');
      return d;
    }
    var ld = ['/usr/share/fonts', '/usr/local/share/fonts'];
    if (home) { ld.push(home + '/.fonts'); ld.push(home + '/.local/share/fonts'); }
    return ld;
  }

  /*
   * Scan the platform's font folders and return a sorted, de-duped list of
   * installed family names. fs/path are injected (Node). Large files and very
   * deep trees are capped so the scan can't run away.
   * opts: { dirs, platform, env, home, maxFiles, maxBytes, maxDepth }
   */
  function listInstalledFonts(fs, path, opts) {
    return listInstalledFontsDetailed(fs, path, opts).map(function (f) { return f.name; });
  }
  /* Like listInstalledFonts, but each entry carries what the family can draw:
     { name, latin, devanagari } — coverage is null when a file couldn't be read.
     A family spread over several files (Regular/Bold/…) is OR-ed together. */
  function listInstalledFontsDetailed(fs, path, opts) {
    opts = opts || {};
    var dirs = opts.dirs || systemFontDirs(opts.platform, opts.env, opts.home);
    var maxFiles = opts.maxFiles || 4000;
    var maxBytes = opts.maxBytes || (8 * 1024 * 1024);
    var maxDepth = opts.maxDepth != null ? opts.maxDepth : 4;
    var set = {}, count = 0;

    function walk(dir, depth) {
      if (depth > maxDepth || count >= maxFiles) return;
      var entries;
      try { entries = fs.readdirSync(dir); } catch (e) { return; }
      for (var i = 0; i < entries.length && count < maxFiles; i++) {
        var full = path.join(dir, entries[i]);
        var st;
        try { st = fs.statSync(full); } catch (e2) { continue; }
        if (st.isDirectory()) { walk(full, depth + 1); continue; }
        if (!/\.(ttf|otf|ttc)$/i.test(entries[i])) continue;
        count++;
        if (st.size > maxBytes) continue;
        try {
          var buf = fs.readFileSync(full);
          var names = parseFamilyNames(buf);
          var cov = names.length ? parseCoverage(buf) : null;
          for (var n = 0; n < names.length; n++) {
            var key = names[n].toLowerCase();
            if (!set[key]) set[key] = { name: names[n], cov: null };
            if (cov) {
              var e = set[key];
              e.cov = e.cov || { latin: false, devanagari: false };
              e.cov.latin = e.cov.latin || cov.latin;
              e.cov.devanagari = e.cov.devanagari || cov.devanagari;
            }
          }
        } catch (e3) {}
      }
    }
    for (var d = 0; d < dirs.length; d++) walk(dirs[d], 0);

    var out = [];
    for (var k in set) if (set.hasOwnProperty(k)) {
      var it = set[k];
      out.push({ name: it.name, latin: it.cov ? it.cov.latin : null, devanagari: it.cov ? it.cov.devanagari : null });
    }
    out.sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
    return out;
  }

  /* Case-insensitive substring filter for a font-name list (powers the
     searchable picker). Pure. */
  function filterFamilies(names, query) {
    query = String(query || '').trim().toLowerCase();
    if (!query) return names.slice();
    var out = [];
    for (var i = 0; i < names.length; i++) {
      if (String(names[i]).toLowerCase().indexOf(query) >= 0) out.push(names[i]);
    }
    return out;
  }

  return {
    parseFamilyNames: parseFamilyNames,
    systemFontDirs: systemFontDirs,
    listInstalledFonts: listInstalledFonts,
    listInstalledFontsDetailed: listInstalledFontsDetailed,
    parseCoverage: parseCoverage,
    scriptNeeds: scriptNeeds,
    canDraw: canDraw,
    filterFamilies: filterFamilies
  };
});
