/*
 * CutPilot — installed-font discovery.
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
          var names = parseFamilyNames(fs.readFileSync(full));
          for (var n = 0; n < names.length; n++) {
            var key = names[n].toLowerCase();
            if (!set[key]) set[key] = names[n];
          }
        } catch (e3) {}
      }
    }
    for (var d = 0; d < dirs.length; d++) walk(dirs[d], 0);

    var out = [];
    for (var k in set) if (set.hasOwnProperty(k)) out.push(set[k]);
    out.sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
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
    filterFamilies: filterFamilies
  };
});
