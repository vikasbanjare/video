/*
 * Font facts for the gallery gates: which families index.html's Google Fonts
 * link loads, which faces ship with macOS / Windows (need no loading), and
 * which faces carry Devanagari (Hindi) glyphs.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const norm = s => String(s || '').toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').trim();

/* Faces that ship with the OS on the owner's machines (mirrors the FONT SAFETY
   list in test/run-tests.js) plus the generic families. */
const SYSTEM = ['helvetica neue', 'helvetica', 'arial', 'arial black', 'arial narrow', 'avenir next', 'avenir',
  'futura', 'impact', 'menlo', 'consolas', 'courier new', 'courier', 'didot', 'marker felt', 'snell roundhand',
  'trebuchet ms', 'georgia', 'times new roman', 'times', 'verdana', 'tahoma', 'comic sans ms', 'bradley hand',
  'palatino', 'gill sans', 'optima', 'baskerville', 'segoe ui', 'calibri', 'cambria', 'rockwell',
  'kohinoor devanagari', 'devanagari mt', 'itf devanagari', 'nirmala ui', 'mangal',
  'sans-serif', 'serif', 'monospace', 'cursive'];

/* Faces with Devanagari glyphs: the Google families the panel loads for Hindi,
   and the system Devanagari faces of macOS / Windows / Linux. */
const DEVANAGARI = ['baloo 2', 'mukta', 'hind', 'anek devanagari', 'rozha one', 'kalam', 'teko',
  'tiro devanagari hindi', 'noto sans devanagari', 'noto serif devanagari', 'poppins', 'yatra one', 'martel',
  'khand', 'rajdhani', 'eczar', 'palanquin', 'kohinoor devanagari', 'devanagari mt', 'itf devanagari',
  'nirmala ui', 'mangal', 'lohit devanagari'];

function googleFamilies(indexHtml) {
  const html = indexHtml || fs.readFileSync(path.join(__dirname, '..', '..', '..', 'index.html'), 'utf8');
  const out = [];
  const re = /<link[^>]+href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const q = m[1].replace(/&amp;/g, '&').split('?')[1] || '';
    q.split('&').forEach(kv => {
      const p = kv.split('=');
      if (p[0] !== 'family' || !p[1]) return;
      out.push(norm(decodeURIComponent(p[1].split(':')[0].replace(/\+/g, ' '))));
    });
  }
  return out;
}

const isSystem = f => SYSTEM.indexOf(norm(f)) >= 0;
const isDevanagari = f => DEVANAGARI.indexOf(norm(f)) >= 0;
const hasDevanagari = chain => (chain || []).some(isDevanagari);

module.exports = { norm, SYSTEM, DEVANAGARI, googleFamilies, isSystem, isDevanagari, hasDevanagari };
