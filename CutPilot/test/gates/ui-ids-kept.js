/*
 * ui-ids-kept.js — the redesign rearranged and re-skinned the panel; it never
 * deleted anything. Every element id the panel had at 648ddc3 (the build the
 * owner's redesign started from) must still exist in index.html, exactly once.
 *
 * main.js, organize.js, safezone.js and ~90 gates reach for these ids; a
 * missing one is a silent no-op (`if ($('x')) …`) the other gates cannot see.
 * dom-id-check proves every id the JS asks for exists; this one also covers
 * ids no script names yet (a control the owner uses by hand), and refuses a
 * duplicate (getElementById would quietly find only the first).
 * Also: every page keeps the .tab[data-tab] button + #tab-<page> section pair
 * that the panel's navigation (and every gate) opens pages with.
 *
 * No browser needed. CP_PANEL_DIR=<dir> checks another copy of the panel.
 */
'use strict';
const fs = require('fs'), path = require('path');
const PANEL_DIR = process.env.CP_PANEL_DIR ? path.resolve(process.env.CP_PANEL_DIR) : path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(PANEL_DIR, 'index.html'), 'utf8');

/* the 489 ids of index.html at 648ddc3 — frozen: add to it, never take away */
const KEPT = [
  "ac-do-fillers", "ac-do-silence", "ac-do-takes", "ac-strength", "ae-silence", "ae-switch", "ae-takes",
  "analyze-progress", "anim-rail", "autoclean-progress", "btn-activate-lic", "btn-add-mogrt",
  "btn-add-mogrt-folder", "btn-alt-apply", "btn-analyze", "btn-autoclean", "btn-back-lib", "btn-broll",
  "btn-browse-styles", "btn-cap-edit", "btn-cap-fix1", "btn-cap-restyle", "btn-cap-segment", "btn-ch-build",
  "btn-ch-copy", "btn-ch-markers", "btn-clean-caps", "btn-clear-markers", "btn-cut", "btn-detect-speakers",
  "btn-diag-clear", "btn-diag-copy", "btn-diag-full", "btn-diagfull-copy", "btn-dup-tpl", "btn-exp-srt",
  "btn-exp-txt", "btn-exp-vtt", "btn-export-tpl", "btn-ffmpeg-pick", "btn-ffmpeg-setup", "btn-find-shorts",
  "btn-fix-wording", "btn-magic", "btn-mark-hooks", "btn-markers", "btn-mc-apply", "btn-mc-plan",
  "btn-mc-redo", "btn-mc-rescan", "btn-mc-test", "btn-mg-copystyle", "btn-mogrt-transcribe",
  "btn-preview-collapse", "btn-real-preview", "btn-rebuild", "btn-replay", "btn-reset-prev",
  "btn-retranscribe", "btn-save-settings", "btn-save-tpl", "btn-save-vb", "btn-script-apply",
  "btn-script-load", "btn-selftest", "btn-sfx-add", "btn-sfx-preview", "btn-smart-cleanup",
  "btn-speaker-reframe", "btn-takes-apply", "btn-takes-cut", "btn-takes-find", "btn-tpl-import",
  "btn-tpl-inspect", "btn-tpl-preview", "btn-tpl-rescan", "btn-tpl-testfill", "btn-tr-again", "btn-tr-auto-ai",
  "btn-tr-auto-main", "btn-tr-change", "btn-tr-edit", "btn-tr-pick", "btn-translate", "btn-true-prev",
  "btn-verbatim-retakes", "btn-viral-edit", "c-align", "c-box", "c-box-on", "c-box-opacity",
  "c-box-opacity-val", "c-box-opacity-wrap", "c-box-pad", "c-box-pad-val", "c-box-radius", "c-box-radius-val",
  "c-box2", "c-box3d", "c-box3d-depth", "c-box3d-depth-val", "c-boxgloss", "c-boxgloss-val", "c-boxglow",
  "c-boxglow-on", "c-boxglow-opts", "c-boxgrad", "c-boxgrad-opts", "c-boxstroke", "c-boxstroke-on",
  "c-boxstroke-opts", "c-boxstrokew", "c-boxstrokew-val", "c-brand", "c-brand-opts", "c-brand-words",
  "c-brandon", "c-case", "c-censor", "c-dimupcoming", "c-emoji", "c-emphasize", "c-entrance", "c-fill",
  "c-fill2", "c-font", "c-font-mount", "c-glossy", "c-grad", "c-grad-opts", "c-hl", "c-hl-scale", "c-hl2",
  "c-hl2g", "c-hl3", "c-hlglow", "c-hlgrad", "c-hlgrad-opts", "c-hlscale-val", "c-hlserif", "c-hlstyle",
  "c-kw", "c-kw-mode", "c-kw-mode-wrap", "c-kwcaps", "c-layout", "c-letter", "c-letter-val", "c-linegap",
  "c-linegap-val", "c-lines", "c-maxwidth", "c-maxwidth-val", "c-multicolor", "c-multicolor-opts", "c-num",
  "c-num-opts", "c-numon", "c-off-minus", "c-off-num", "c-off-plus", "c-off-reset", "c-perword",
  "c-perword-style", "c-perword-style-wrap", "c-pos", "c-pos-val", "c-reveal", "c-safezone", "c-shadow",
  "c-shadow-blur", "c-shadow-blur-val", "c-shadow-dx", "c-shadow-dx-val", "c-shadow-dy", "c-shadow-dy-val",
  "c-shadow-offset-row", "c-shadow-on", "c-shadow-row", "c-size", "c-size-val", "c-speaker", "c-strippunct",
  "c-stroke", "c-strokew", "c-strokew-val", "c-subscale", "c-subscale-val", "c-subscale-wrap", "c-sync",
  "c-sync-offset", "c-twotier-wrap", "c-upper", "c-weight", "c-weight-val", "c-wordhl", "c-wordhl-opts",
  "c-wordpop", "c-wordpop-val", "c-words", "c-wordspace", "c-wordspace-val", "c-wordsperline",
  "c-wordsperline-val", "c-wordsperline-wrap", "cap-actions-dock", "cap-actions-home", "cap-output",
  "cap-preview", "cap-progress", "cap-restyle-hint", "cap-reveal", "cap-view", "cap1-cancel", "cap1-editor",
  "cap1-hint", "cap1-save", "cap1-text", "cap1-time", "ch-min", "ch-min-val", "ch-out", "ch-progress",
  "ch-results", "clip-badge", "cmdk", "cmdk-input", "cmdk-list", "cmdk-open", "cpo-results", "cpo-run",
  "cpo-status", "cust-anim-group", "cust-pane-pro", "cust-pane-style", "cust-tabs", "customize-drawer",
  "diag-count", "diag-out", "diag-text", "editable-note", "editor-tpl-name", "env-status", "ffmpeg-status",
  "flux-grid", "flux-search", "legibility-note", "lib-cats", "lib-niche", "lib-search", "lib-sort",
  "lic-state", "log", "mc-angles", "mc-autosync", "mc-center", "mc-center-val", "mc-center-wrap2",
  "mc-centerhold", "mc-centerhold-val", "mc-count", "mc-cutaway", "mc-cutaway-val", "mc-diag",
  "mc-director-opts", "mc-ffmpeg", "mc-hold", "mc-interval", "mc-interval-val", "mc-interval-wrap",
  "mc-leadin", "mc-leadin-val", "mc-main-opts", "mc-main-track", "mc-map", "mc-maxshot", "mc-maxshot-val",
  "mc-minseg", "mc-minseg-val", "mc-mode", "mc-pace", "mc-pace-hint", "mc-pattern-opts", "mc-plan-card",
  "mc-plan-view", "mc-progress", "mc-redo-hint", "mc-source", "mc-speaker-opts", "mc-transcript-opts",
  "method-animated", "method-mogrt", "mg-case", "mg-match", "mg-stretch", "mg-wc-full", "mg-wc-minus",
  "mg-wc-num", "mg-wc-plus", "mg-words", "mogrt-folders", "mogrt-installed-wrap", "mogrt-section",
  "mogrt-sheet", "mogrt-tr", "mogrt-uploads", "ms-anim", "ms-back", "ms-close", "ms-customizer", "ms-hint",
  "ms-inspect", "ms-inspect-out", "ms-live-canvas", "ms-live-preview", "ms-name", "ms-preview",
  "ms-reset-orig", "ms-thumb", "ms-tr", "ms-transcribe", "ms-use", "ms-wc-full", "ms-wc-minus", "ms-wc-num",
  "ms-wc-plus", "ms-words", "ms-x", "native-recipe", "opt-backup", "opt-closegaps", "opt-fillers",
  "opt-fillers-adv", "opt-fillers-extra", "opt-minkeep", "opt-minsilence", "opt-padding", "opt-threshold",
  "opt-threshold-manual", "opt-threshold-range", "opt-threshold-val", "plsG", "preview-canvas",
  "preview-caption", "preview-frame", "preview-speaker", "results", "sc-aggressive", "script-drawer",
  "script-status", "script-text", "selftest-out", "set-dg-key", "set-dg-row", "set-dropframe",
  "set-enhance-audio", "set-ffmpeg", "set-groq-key", "set-groq-row", "set-key-msg", "set-lic-key",
  "set-lic-msg", "set-precise-timing", "set-quality-note", "set-swara-key", "set-swara-row", "set-vb-key",
  "set-vb-msg", "set-vb-provider", "set-whisper-lang", "set-whisper-quality", "sfx-card", "sfx-desc",
  "sfx-effect", "sfx-trigger", "sfx-vol", "sfx-vol-val", "sh-focus", "sh-len", "sh-ratio", "shorts-progress",
  "shorts-results", "sil-strength", "silence-list", "sr-arrange", "sr-progress", "stats", "sw-box", "sw-fill",
  "sw-hl", "sw-stroke", "sync-nudge", "sync-stat", "sz-also-custom", "sz-apply", "sz-brandmode", "sz-canvas",
  "sz-channel", "sz-cols", "sz-custom-fields", "sz-dur", "sz-gutter", "sz-handle", "sz-logo-clear",
  "sz-logo-name", "sz-logo-pick", "sz-margin", "sz-mode", "sz-op-val", "sz-opacity", "sz-ov-action",
  "sz-ov-cross", "sz-ov-diag", "sz-ov-margin", "sz-ov-thirds", "sz-ov-title", "sz-panel-custom",
  "sz-panel-safezones", "sz-platform", "sz-preview-wrap", "sz-progress", "sz-remove", "sz-replace", "sz-rows",
  "sz-title", "sz-titlepos", "tab-captions", "tab-chapters", "tab-multicam", "tab-organize", "tab-safezone",
  "tab-settings", "tab-shorts", "tab-silence", "tab-transcribe", "takes-list", "takes-progress",
  "takes-results", "takes-stats", "theme-toggle", "tk-backup", "tk-keep", "tk-kind", "tk-kind-dd", "tk-minrun",
  "tk-sim", "tk-sim-val", "tk-strength", "toast", "tpl-file-name", "tpl-grid", "tpl-inspect-out",
  "tpl-installed", "tpl-installed-hint", "tpl-params", "tpl-select", "tr-bar", "tr-dg-key", "tr-dg-wrap",
  "tr-editor", "tr-groq-key", "tr-groq-wrap", "tr-help", "tr-ico", "tr-lang", "tr-lang-row", "tr-next-hint",
  "tr-quality", "tr-swara-key", "tr-swara-lang", "tr-swara-wrap", "tr-text", "tr-tools", "tr-translate-lang",
  "tr-vocab", "tre-cancel", "tre-list", "tre-save", "ver", "ver-foot", "view-editor", "view-flux",
  "view-templates", "wc-block", "wc-full", "wc-minus", "wc-num", "wc-plus", "whisper-status"
];
const PAGES = ['transcribe', 'captions', 'silence', 'shorts', 'multicam', 'chapters', 'organize', 'safezone', 'settings'];

console.log('ui ids kept (' + PANEL_DIR + ')');
let failed = 0;
const bad = m => { console.log('  ✗ ' + m); failed++; };
const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
const seen = new Map();
const re = /\bid\s*=\s*["']([^"']+)["']/g;
let m;
while ((m = re.exec(noComments))) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
const missing = KEPT.filter(id => !seen.has(id));
const dupes = [...seen].filter(([, n]) => n > 1).map(([id, n]) => id + ' ×' + n);
if (missing.length) bad(missing.length + ' id(s) the panel had are gone: ' + missing.join(', '));
else console.log('  ✓ all ' + KEPT.length + ' ids from 648ddc3 are still in index.html');
if (dupes.length) bad('duplicate id(s): ' + dupes.join(', '));
else console.log('  ✓ every id is unique (' + seen.size + ' in all)');
const noTab = PAGES.filter(p => !new RegExp('class="[^"]*\\btab\\b[^"]*"[^>]*data-tab="' + p + '"').test(noComments));
const noPage = PAGES.filter(p => !new RegExp('<section[^>]*id="tab-' + p + '"[^>]*class="[^"]*\\btab-page\\b').test(noComments));
if (noTab.length) bad('page button(s) .tab[data-tab] missing for: ' + noTab.join(', '));
if (noPage.length) bad('page section(s) #tab-<page>.tab-page missing for: ' + noPage.join(', '));
if (!noTab.length && !noPage.length) console.log('  ✓ every page keeps its .tab[data-tab] button and #tab-<page> section');
console.log(failed ? 'UI IDS KEPT: ' + failed + ' problem(s) above' : 'UI IDS KEPT: nothing was deleted ✓');
process.exit(failed ? 1 : 0);
