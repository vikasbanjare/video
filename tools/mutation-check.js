/*
 * mutation-check.js — do the gates actually FAIL when the code is broken?
 *
 * Three separate times in one session I wrote a gate that could not fail:
 *   · an orientation check that passed with the sequence shape ignored
 *   · a caption-box check that passed with the box disabled (a thick outline
 *     paints the same colour, and colour was all it measured)
 *   · a placement check that compared against NaN, printed "drift NaNs", passed
 * Each was caught by hand, by breaking the fix on purpose and re-running. A
 * gate that cannot fail is worse than no gate: it converts an untested area
 * into a green badge. So the habit is automated here.
 *
 * Each entry breaks ONE thing in the shipped code and names the gate that must
 * notice. A mutation that survives is reported as a hole in the gate, not as a
 * pass. The original file is restored in a finally, and the run refuses to end
 * with a dirty tree.
 *
 * Run: node tools/mutation-check.js            (all)
 *      node tools/mutation-check.js overlay    (one, by name)
 * Not part of the default battery — it runs whole gates several times over.
 * Run it before shipping, and after writing any new gate.
 */
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const MUTANTS = [
  {
    name: 'preview-colour',
    file: 'CutPilot/js/main.js',
    find: '    povOpts.vCenter = pov.vCenter;',
    repl: "    povOpts.vCenter = pov.vCenter; povOpts.fill = '#ff0000';",
    gate: 'tools/preview-render-match.js',
    why: 'the preview draws a colour the render never produces'
  },
  {
    name: 'preview-orientation',
    file: 'CutPilot/js/main.js',
    find: "    var _envW = (state.env && state.env.width) || 1080;",
    repl: "    var _envW = 1080; var _ignored =",
    gate: 'tools/preview-render-match.js',
    why: 'the preview stops following the sequence shape'
  },
  {
    name: 'caption-box',
    file: 'CutPilot/js/ass.js',
    find: '    var borderStyle = boxCol ? 3 : 1;',
    repl: '    var borderStyle = 1;',
    gate: 'tools/overlay-render-check.js',
    why: 'a boxed style loses its box on the long-video path'
  },
  {
    name: 'item-contract',
    file: 'CutPilot/js/render.js',
    find: '              results.push({ path: file, start: frames[i].start, end: frames[i].end });',
    repl: '              results.push({ file: file, from: frames[i].start, to: frames[i].end });',
    gate: 'tools/pipeline-contract-check.js',
    why: 'what the panel returns no longer fits what Premiere places'
  },
  {
    name: 'caption-cleanup',
    file: 'CutPilot/jsx/host.jsx',
    find: '        if (!pat.test(nm) && !legacyOverlay.test(nm)) { allCaps = false; break; }',
    repl: '        if (!pat.test(nm)) { allCaps = false; break; }',
    gate: 'CutPilot/test/host-tests.js',
    why: 'Remove-all-captions stops finding a long video\'s overlay'
  },
  {
    name: 'legibility-floor',
    file: 'CutPilot/js/render.js',
    find: '          px = Math.max(px, Math.round(shortSide * 0.05));',
    repl: '          px = px;',
    gate: 'tools/style-quality-audit.js',
    why: 'small styles render below the phone-legible floor'
  },
  {
    name: 'motion-parity',
    file: 'CutPilot/js/main.js',
    find: '    var pvAnimId = currentAnim();   // the EXACT call the render pipeline makes',
    repl: "    var pvAnimId = CPCaptions.animIdForConcept((carry.entrance && carry.entrance !== 'none') ? carry.entrance : carry.anim);",
    gate: 'CutPilot/test/panel-proofs.js',
    why: 'the editor preview animates differently from the gallery tile again'
  },
  {
    name: 'band-calibration',
    file: 'CutPilot/js/main.js',
    find: '      var pov = { fontSize: Math.round(191 * ratio),',
    repl: '      var pov = { fontSize: Math.round(400 * ratio),',
    gate: 'tools/sim-preview-check.js',
    why: 'gallery tiles drift from the engine\'s authored proportions'
  },
  {
    name: 'dead-control',
    file: 'CutPilot/js/main.js',
    find: '    if (ov.wordsPerCue != null && isFinite(ov.wordsPerCue)) eff.wordsPerCue = ov.wordsPerCue;',
    repl: '    if (false) eff.wordsPerCue = ov.wordsPerCue;',
    gate: 'tools/dead-control-audit.js',
    why: 'Words-per-line goes dead in the preview again'
  },
  {
    name: 'caption-sync-speed',
    file: 'CutPilot/js/captions.js',
    find: '        var p = ps[k], sp = (+p.speed > 0) ? +p.speed : 1;\n        var s = Math.max(+it.start, +p.inPoint)',
    repl: '        var p = ps[k], sp = 1;\n        var s = Math.max(+it.start, +p.inPoint)',
    gate: 'CutPilot/test/gates/caption-sync-placement.js',
    why: 'captions on a sped-up reel drift behind the voice again'
  },
  {
    name: 'caption-sync-host-speed',
    file: 'CutPilot/jsx/host.jsx',
    find: '            var sp = CP_clipSpeed(clip, ip, op, st, en);   // recording (or nest) s per s of THIS sequence',
    repl: '            var sp = 1;',
    gate: 'CutPilot/test/host-tests.js',
    why: 'Premiere\'s answer reads a sped-up clip as 1:1 again'
  },
  {
    name: 'caption-sync-saved',
    file: 'CutPilot/js/main.js',
    find: '          var placed = (!sparse && !forceFresh) ? placeTranscript(cached, insts) : null;',
    repl: '          var placed = (!sparse && !forceFresh) ? { cues: cached.lines, words: cached.words } : null;',
    gate: 'CutPilot/test/gates/caption-sync-placement.js',
    why: 'a reused transcript puts captions where the words were before the clip moved'
  },
  {
    name: 'caption-sync-scan',
    file: 'CutPilot/js/main.js',
    find: '          var placed = placeTranscript(cc, pieces);',
    repl: '          var placed = { cues: cc.lines, words: cc.words };',
    gate: 'CutPilot/test/gates/caption-sync-placement.js',
    why: 'selecting a clip auto-loads its saved words at the old place'
  },
  {
    name: 'caption-sync-refine',
    file: 'CutPilot/js/main.js',
    find: '        var at = CPCaptions.timelineToMedia(words, src.pieces);',
    repl: '        src.pieces = [{ inPoint: src.pieces[0].inPoint, outPoint: 1e9, seqStart: src.pieces[0].seqStart, speed: src.pieces[0].speed }]; var at = CPCaptions.timelineToMedia(words, src.pieces);',
    gate: 'CutPilot/test/gates/caption-sync-placement.js',
    why: 'after a cut, words are snapped against the wrong stretch of the recording'
  },
  {
    name: 'caption-sync-fallback',
    file: 'CutPilot/js/main.js',
    find: '        var at = CPCaptions.timelineToMedia(cues, src.pieces), out = [];',
    repl: '        return CPCaptions.alignCuesToAudio(cues, env.samples, src.pieces[0].inPoint || 0, opt); var at, out = [];',
    gate: 'CutPilot/test/gates/caption-sync-placement.js',
    why: 'the words of a picked .srt are timed against the wrong audio'
  },
  {
    name: 'caption-sync-follow',
    file: 'CutPilot/js/main.js',
    find: '      if (!now.length || !res.clip || res.clip.mediaPath !== pl.mediaPath || samePieces(now, pl.pieces)) return false;',
    repl: '      return false;',
    gate: 'CutPilot/test/gates/caption-sync-placement.js',
    why: 'words made before the clip was trimmed or moved stay where the voice used to be'
  },
  {
    name: 'caption-sync-follow-hook',
    file: 'CutPilot/js/main.js',
    find: "      if (action === 'autoclean' || !state.transcriptPlacement || (Date.now() - (state._placementCheckedAt || 0)) < 3000) return true;",
    repl: '      return true;',
    gate: 'CutPilot/test/gates/caption-sync-placement.js',
    why: 'Add captions stops checking where the clip sits before it places the words'
  },
  {
    name: 'caption-sync-scan-guard',
    file: 'CutPilot/js/main.js',
    find: 'if (!curProtected && findCachedTranscriptForMedia(mediaPath)) saved = CPBridge.callHost(',
    repl: 'if (true) saved = CPBridge.callHost(',
    gate: 'CutPilot/test/gates/caption-sync-placement.js',
    why: 'every panel focus makes Premiere walk the whole timeline again, saved transcript or not'
  },
  {
    name: 'multicam-keep-off',
    file: 'CutPilot/jsx/host.jsx',
    find: '      else if (!dis && mine) { try { c.disabled = true; keptOff++; } catch (eO) {} }',
    repl: '',
    gate: 'CutPilot/test/gates/multicam-apply.js',
    why: 'a second Apply turns back on the camera sound the owner switched off'
  },
  {
    name: 'multicam-picture-wins',
    file: 'CutPilot/jsx/host.jsx',
    find: 'if (now[i][2] && !camWas[t][i][2]) { try { now[i][3].disabled = false; linkedOn++; } catch (eL) {} }',
    repl: 'if (false) {}',
    gate: 'CutPilot/test/gates/multicam-apply.js',
    why: 'keeping a sound off takes the planned camera shot off with it'
  },
  {
    name: 'transcript-reuse-after-cut',
    file: 'CutPilot/js/main.js',
    find: '    // the copies above were just re-timed for this cut: followMovedRecording',
    repl: '    state._forceRetranscribe = true;\n    // the copies above were just re-timed for this cut: followMovedRecording',
    gate: 'CutPilot/test/gates/retakes-stale-retranscribe.js',
    why: 'every Pulse cut makes the next Auto-transcribe listen for a minute again'
  },
  {
    name: 'transcript-reuse-head-cut',
    file: 'CutPilot/js/main.js',
    find: ' ||\n                     findCachedTranscriptForMedia(clip.mediaPath, { minIn: minIn, maxOut: maxOut });',
    repl: ';',
    gate: 'CutPilot/test/gates/retakes-stale-retranscribe.js',
    why: 'a clean-up that cut the start makes the saved transcript unusable'
  },
  {
    name: 'redo-button-name',
    file: 'CutPilot/js/main.js',
    find: "    'Tap ↻ Redo on the Transcribe page — it listens to your clip again, about a minute — then run this again.';",
    repl: "    'Tap ↻ Re-transcribe (Transcribe tab) — it listens to your clip again, about a minute — then run this again.';",
    gate: 'CutPilot/test/gates/retakes-stale-retranscribe.js',
    why: 'the message sends the owner to a button that does not exist'
  },
  {
    name: 'clean-pick-saved',
    file: 'CutPilot/js/main.js',
    find: "      if (key) { settings[key] = b.getAttribute('data-s'); saveSettings(); }",
    repl: '',
    gate: 'CutPilot/test/gates/silence-remember-choice.js',
    why: 'Clean up forgets Podcast / Reel and opens on YouTube again'
  },
  {
    name: 'clean-vertical-default',
    file: 'CutPilot/js/main.js',
    find: "    applySilStrength(e && e.height > e.width ? 'strong' : 'balanced');",
    repl: "    applySilStrength('balanced');",
    gate: 'CutPilot/test/gates/silence-remember-choice.js',
    why: 'a vertical reel starts on the gentler YouTube cut'
  },
  {
    name: 'hindi-chip-up-front',
    file: 'CutPilot/js/main.js',
    find: "c !== '🔥 Trending' && c !== HINDI_CAT; });\n    var head = ['All'];\n    if (C.indexOf('🔥 Trending') >= 0) head.push('🔥 Trending');\n    if (C.indexOf(HINDI_CAT) >= 0) head.push(HINDI_CAT);",
    repl: "c !== '🔥 Trending'; });\n    var head = ['All'];\n    if (C.indexOf('🔥 Trending') >= 0) head.push('🔥 Trending');",
    gate: 'CutPilot/test/gates/gallery-categories.js',
    why: 'the Hindi styles chip is off-screen in a docked panel again'
  },
  {
    name: 'caption-language-picker',
    file: 'CutPilot/js/main.js',
    find: "    mountInto('cap-lang', 'l');   // the Captions page: Hindi letters took six taps through Transcribe",
    repl: '',
    gate: 'CutPilot/test/gates/captions-language-picker.js',
    why: 'the Captions page loses its language picker (six taps through Transcribe again)'
  },
  {
    name: 'caption-words-follow-language',
    file: 'CutPilot/js/main.js',
    find: "        if (kind === 'l') captionScriptFollow(v);   // words already heard follow the new script",
    repl: '',
    gate: 'CutPilot/test/gates/captions-language-picker.js',
    why: 'choosing a language leaves the words already on screen in the old script'
  },
  {
    name: 'redo-button-name-cleanup',
    file: 'CutPilot/js/main.js',
    find: "Tap ↻ Redo on the Transcribe page to get word timing, then run Clean up again.');",
    repl: "Re-transcribe (Transcribe tab) to get word timing, then run Clean up again.');",
    gate: 'CutPilot/test/gates/silence-e2e-oneshot-words.js',
    why: 'the one-tap clean-up sends the owner to a button that does not exist'
  },
  {
    name: 'multicam-redo-nothing-to-change',
    file: 'CutPilot/js/main.js',
    find: '      } else if (!r.razored && !r.toggled && !r.audioRestored && !r.audioKeptOff) {',
    repl: '      } else if (false) {',
    gate: 'CutPilot/test/gates/multicam-apply.js',
    why: 'Redo with the same settings says "applied — 0 cuts" as if it did nothing'
  },
  {
    name: 'multicam-distinct-paces',
    file: 'CutPilot/js/multicam.js',
    find: '    low:    { minseg: 3.5, maxshot: 45, cutaway: 3, leadin: 0 },\n    medium: { minseg: 2.0, maxshot: 20, cutaway: 3, leadin: 0 },',
    repl: '    low:    { minseg: 2.5, maxshot: 300, cutaway: 3, leadin: 0 },\n    medium: { minseg: 2.0, maxshot: 120, cutaway: 3, leadin: 0 },',
    gate: 'CutPilot/test/gates/multicam-edit-quality.js',
    why: 'Calm and Balanced make the same edit again, with no reaction shots'
  },
  {
    name: 'multicam-reaction-on-a-breath',
    file: 'CutPilot/js/multicam.js',
    find: '      var ps = pausesIn(angle, lo, maxEnd), best = null, bestSc = -Infinity, k, m;',
    repl: '      return { start: target, end: Math.min(maxEnd, target + hold) }; var ps = [], best = null, bestSc = -Infinity, k, m;',
    gate: 'CutPilot/test/gates/multicam-edit-quality.js',
    why: 'reaction shots cut away from the talker mid-word again'
  },
  // ---- who's talking (one mic, several people) ----
  {
    name: 'voices-sha-check',
    file: 'CutPilot/js/voices.js',
    find: '          if (sha256File(node, it.file) !== it.spec.sha256) {',
    repl: '          if (false) {',
    gate: 'CutPilot/test/gates/voices-engine.js',
    why: 'a voice engine download that does not match its SHA-256 is installed and run anyway'
  },
  {
    name: 'voices-clean-on-failure',
    file: 'CutPilot/js/voices.js',
    find: '    return chain.catch(function (err) { clean(); throw err; });',
    repl: '    return chain;',
    gate: 'CutPilot/test/gates/voices-engine.js',
    why: 'a failed install leaves its downloads behind'
  },
  {
    name: 'voices-threshold',
    file: 'CutPilot/js/voices.js',
    find: "(opts.threshold || 0.8)",
    repl: "(opts.threshold || 0.5)",
    gate: 'CutPilot/test/gates/voices-engine.js',
    why: 'the engine decides the number of people at its own default, which split 4 people into 8'
  },
  {
    name: 'voices-num-clusters',
    file: 'CutPilot/js/voices.js',
    find: "    if (opts.speakers >= 2) a.push('--clustering.num-clusters=' + Math.floor(opts.speakers));",
    repl: "    if (false) a.push('--clustering.num-clusters=' + Math.floor(opts.speakers));",
    gate: 'CutPilot/test/gates/voices-engine.js',
    why: 'asking for two people no longer gives exactly two voices'
  },
  {
    name: 'voices-offset',
    file: 'CutPilot/js/main.js',
    find: '      var regions = CPVoices.voicesToRegions(v.turns, numAngles, angleOf, v.start);',
    repl: '      var regions = CPVoices.voicesToRegions(v.turns, numAngles, angleOf, 0);',
    gate: 'CutPilot/test/gates/multicam-voices.js',
    why: 'the voices are placed as if the recording started at 0:00 on the timeline'
  },
  {
    name: 'voices-cache',
    file: 'CutPilot/js/main.js',
    find: '      if (_mcVoices && _mcVoices.key === key) return _mcVoices;',
    repl: '      if (false) return _mcVoices;',
    gate: 'CutPilot/test/gates/multicam-voices.js',
    why: 'Swap and Redo listen to the whole recording again'
  },
  {
    name: 'voices-cache-razor',
    file: 'CutPilot/js/main.js',
    find: "        var k = it.mediaPath + '@' + Math.round(zero * 20) + '×' + Math.round(sp * 1000) + (it.reversed ? 'r' : '');",
    repl: "        var k = it.mediaPath + '@' + it.seqStart + '×' + Math.round(sp * 1000) + (it.reversed ? 'r' : '');",
    gate: 'CutPilot/test/gates/multicam-voices.js',
    why: 'a recording razored into pieces counts as a new recording, so Redo listens again'
  },
  {
    name: 'voices-ask-first',
    file: 'CutPilot/js/main.js',
    find: '    var ask = voicesReady() ? Promise.resolve(true) :',
    repl: '    var ask = true ? Promise.resolve(true) :',
    gate: 'CutPilot/test/gates/multicam-voices.js',
    why: 'the voice engine is downloaded without asking'
  },
  {
    name: 'voices-remember-no',
    file: 'CutPilot/js/main.js',
    find: '      if (!yes) { state.voicesDeclined = true; return bursts(',
    repl: '      if (!yes) { return bursts(',
    gate: 'CutPilot/test/gates/multicam-voices.js',
    why: '“Cancel” is asked again on every build'
  },
  {
    name: 'voices-fallback',
    file: 'CutPilot/js/main.js',
    find: '      return mcVoicesPlan(numAngles, track).catch(function (e) {',
    repl: '      return mcVoicesPlan(numAngles, track).then(null, function (e) { throw e; }).catch(function (e) { throw e; }).catch(function (e) {\n        throw e;',
    gate: 'CutPilot/test/gates/multicam-voices.js',
    why: 'a voice engine that fails leaves the owner with no plan at all'
  },
  {
    name: 'voices-mapping-ui',
    file: 'CutPilot/js/main.js',
    find: "    if (an && (an.mode === 'transcript' || an.mode === 'voices') && an.labelled && an.mapping.length) {",
    repl: "    if (an && an.mode === 'transcript' && an.labelled && an.mapping.length) {",
    gate: 'CutPilot/test/gates/multicam-voices.js',
    why: 'the plan no longer says which voice is on which camera, and Swap is gone'
  },
  {
    name: 'voices-swap-kept',
    file: 'CutPilot/js/main.js',
    find: "      var sig = 'voices|' + v.key;\n      if (!state.mcTrPicks || state.mcTrPicks.sig !== sig) state.mcTrPicks = { sig: sig, map: {} };",
    repl: "      var sig = 'voices|' + v.key;\n      state.mcTrPicks = { sig: sig, map: {} };",
    gate: 'CutPilot/test/gates/multicam-voices.js',
    why: '⇄ Swap speakers is forgotten on the next build'
  },
  {
    name: 'voices-people-count',
    file: 'CutPilot/js/main.js',
    find: '          state.mcVoicesPeople = { key: an.recording, n: n };',
    repl: '          state.mcVoicesPeople = null;',
    gate: 'CutPilot/test/gates/multicam-voices.js',
    why: '“How many people talk?” changes nothing'
  },
  {
    name: 'voices-two-cameras-two-people',
    file: 'CutPilot/js/main.js',
    find: '    var want = cams.length === 2 ? 2 : 0;',
    repl: '    var want = 0;',
    gate: 'CutPilot/test/gates/multicam-voices.js',
    why: 'with two cameras the engine guesses the number of people instead of listening for two'
  },
  {
    name: 'voices-owner-wide',
    file: 'CutPilot/js/main.js',
    find: "    for (var a = 0; a < numAngles; a++) if (!(String(map[a]) === '-1' && auto[a] === false)) cams.push(a);",
    repl: "    for (var a = 0; a < numAngles; a++) cams.push(a);",
    gate: 'CutPilot/test/gates/multicam-voices.js',
    why: 'a camera the owner set to “No mic (wide)” is given a voice'
  },
  {
    name: 'voices-credit',
    file: 'CutPilot/js/main.js',
    find: "  if ($('voices-credits')) $('voices-credits').textContent = CPVoices.CREDITS;",
    repl: "",
    gate: 'CutPilot/test/gates/multicam-voices.js',
    why: 'Settings no longer credits NVIDIA’s CC-BY-4.0 model'
  },
  // ---- transcribe on this computer (the free speech engine) ----
  {
    name: 'whisper-member',
    file: 'CutPilot/js/voices.js',
    find: '      var data = zipMember(fs.readFileSync(whl), w.member, node.zlib);',
    repl: "      var data = zipMember(fs.readFileSync(whl), w.member + '.old', node.zlib);",
    gate: 'CutPilot/test/gates/whisper-engine.js',
    why: 'the speech engine is unpacked from the wrong place in its download'
  },
  {
    name: 'whisper-runnable',
    file: 'CutPilot/js/voices.js',
    find: "      if (node.platform !== 'win32') fs.chmodSync(prog, 493);   // 0755",
    repl: '',
    gate: 'CutPilot/test/gates/whisper-engine.js',
    why: 'the speech engine is installed but cannot be run'
  },
  {
    name: 'whisper-own-engine',
    file: 'CutPilot/js/main.js',
    find: '    if (own && tryPath(own)) return (_whisper = own);',
    repl: '    if (false) return (_whisper = own);',
    gate: 'CutPilot/test/gates/transcribe-on-this-computer.js',
    why: 'the engine Pulse set up is never found, so transcribing still asks for a key'
  },
  {
    name: 'whisper-setup-retry',
    file: 'CutPilot/js/main.js',
    find: "      _whisperSetup = null; diag('asr', 'speech engine set-up failed: '",
    repl: "      diag('asr', 'speech engine set-up failed: '",
    gate: 'CutPilot/test/gates/transcribe-on-this-computer.js',
    why: 'one failed set-up blocks the speech engine until Premiere restarts'
  },
  {
    name: 'whisper-ask-model',
    file: 'CutPilot/js/main.js',
    find: '      if (!(mb >= 100)) return Promise.resolve(true);',
    repl: '      return Promise.resolve(true);',
    gate: 'CutPilot/test/gates/transcribe-on-this-computer.js',
    why: 'the 574 MB model is downloaded without asking'
  },
  {
    name: 'whisper-cancel-plain',
    file: 'CutPilot/js/main.js',
    find: "      if (e && e.cancelled) {\n        setTranscriptBar('', '🎙️', 'Not transcribed — nothing was downloaded.', null);",
    repl: "      if (false) {\n        setTranscriptBar('', '🎙️', 'Not transcribed — nothing was downloaded.', null);",
    gate: 'CutPilot/test/gates/transcribe-on-this-computer.js',
    why: '“Cancel” on the model download reads as “Auto-transcribe failed”'
  },
  {
    name: 'whisper-wl-option',
    file: 'CutPilot/js/main.js',
    find: "    { value: 'large-v3-turbo-q5_0', label: '💻 On this computer — free, no key (about 600 MB, once)' },",
    repl: '',
    gate: 'CutPilot/test/gates/transcribe-on-this-computer.js',
    why: 'the owner’s build offers no free on-this-computer transcription'
  },
  {
    name: 'whisper-wl-model-name',
    file: 'CutPilot/js/main.js',
    find: "      var what = WHITE_LABEL ? 'the speech model' : name;",
    repl: '      var what = name;',
    gate: 'CutPilot/test/gates/transcribe-on-this-computer.js',
    why: 'the owner’s build shows the model’s file name while downloading'
  },
  {
    name: 'whisper-key-message',
    file: 'CutPilot/js/main.js',
    find: "(WHITE_LABEL ? ' — or pick “💻 On this computer” there (free, no key).' : '.')",
    repl: "'.'",
    gate: 'CutPilot/test/gates/transcribe-on-this-computer.js',
    why: 'the “paste your key” message no longer says there is a free way without one'
  },
  {
    name: 'multicam-reaction-length',
    file: 'CutPilot/js/multicam.js',
    find: '          if (d > hold + 6) break;',
    repl: '          if (d > hold + 40) break;',
    gate: 'CutPilot/test/gates/multicam-follow.js',
    why: 'a reaction shot holds the silent listener for up to 40 s'
  },
  // ---- Pulse's Premiere script (jsx/host.jsx) not loaded ----
  {
    name: 'host-heal-load',
    file: 'CutPilot/js/lib/cep-bridge.js',
    find: "      (path ? ' $.evalFile(new File(' + JSON.stringify(path) + '));' : '') +",
    repl: "      '' +",
    gate: 'CutPilot/test/gates/host-load-recovery.js',
    why: 'when Premiere has not loaded Pulse’s script, Pulse no longer loads it itself'
  },
  {
    name: 'host-heal-line',
    file: 'CutPilot/js/lib/cep-bridge.js',
    find: "      ' catch (e) { return \"LOADERR \" + (e && e.message ? e.message : e) + (e && e.line ? \" (line \" + e.line + \")\" : \"\"); } })()';",
    repl: "      ' catch (e) { return \"LOADERR \" + (e && e.message ? e.message : e); } })()';",
    gate: 'CutPilot/test/gates/host-load-recovery.js',
    why: 'a script that cannot load no longer says which line broke it'
  },
  {
    name: 'host-heal-retry',
    file: 'CutPilot/js/lib/cep-bridge.js',
    find: "            if (r2 === 'EvalScript error.' || /^CALLERR /.test(String(r2))) {",
    repl: '            if (true) {',
    gate: 'CutPilot/test/gates/host-load-recovery.js',
    why: 'after loading the script, the call that needed it still fails'
  },
  {
    name: 'host-diag-line',
    file: 'CutPilot/js/main.js',
    find: "    try { var hs = CPBridge.hostState ? CPBridge.hostState() : null; if (hs) row('Premiere script: ' + hs.state + (hs.detail ? ' — ' + hs.detail : '')); } catch (e) {}",
    repl: '',
    gate: 'CutPilot/test/gates/host-load-recovery.js',
    why: '📋 diagnostics no longer says whether Premiere loaded Pulse’s script'
  },
  // ---- multicam: when the QE razor ignores Pulse's timecodes ----
  {
    name: 'multicam-playhead-fallback',
    file: 'CutPilot/jsx/host.jsx',
    find: '          razorAtPlayhead(t0, bounds[need[t0][0]]);',
    repl: '          void 0;',
    gate: 'CutPilot/test/gates/multicam-razor-fallback.js',
    why: 'when the razor ignores Pulse’s timecodes, Apply no longer cuts at the playhead’s own timecode'
  },
  {
    name: 'multicam-cut-facts',
    file: 'CutPilot/js/main.js',
    find: "      box.textContent = 'Multicam wasn’t applied:\\n' + msg + (facts ? '\\n\\nWhat Premiere answered: ' + facts : '');",
    repl: "      box.textContent = 'Multicam wasn’t applied:\\n' + msg;",
    gate: 'CutPilot/test/gates/multicam-razor-fallback.js',
    why: 'a failed Apply no longer shows what Premiere answered'
  },
  // ---- Premium previews drawn by Premiere with the owner's words ----
  {
    name: 'premium-owner-words',
    file: 'CutPilot/js/main.js',
    find: "    return picked.length >= 3 ? picked.join(' ') : 'Make every word count';",
    repl: "    return 'Make every word count';",
    gate: 'CutPilot/test/gates/gallery-premium-render.js',
    why: 'the Premium previews are drawn with a stand-in phrase instead of the owner’s words'
  },
  {
    name: 'premium-own-render-wins',
    file: 'CutPilot/js/main.js',
    find: '        var thumbUrl = (ownImg && ownImg + stamp) || shipImg || findIn(mdir, base, IMG);',
    repl: '        var thumbUrl = shipImg || (ownImg && ownImg + stamp) || findIn(mdir, base, IMG);',
    gate: 'CutPilot/test/gates/gallery-premium-render.js',
    why: 'the cards keep the shipped clips after Premiere drew them with the owner’s words'
  },
  {
    name: 'premium-caption-box',
    file: 'CutPilot/js/main.js',
    find: "'-vf', 'bbox=min_val=24', '-f', 'null', '-']).then(function (err) {",
    repl: "'-vf', 'cropdetect=limit=24:round=2:reset=0', '-f', 'null', '-']).then(function (err) {",
    gate: 'CutPilot/test/gates/gallery-premium-render.js',
    why: 'a thin caption in a tall frame reads as “nothing visible” again (cropdetect averages whole columns)'
  },
  {
    name: 'premium-host-text',
    file: 'CutPilot/jsx/host.jsx',
    find: '        if (tp) CP_setMgrtText(tp, args.text, true, null);',
    repl: '        if (false) CP_setMgrtText(tp, args.text, true, null);',
    gate: 'CutPilot/test/gates/host-render-mogrt-frames.js',
    why: 'Premiere draws the template with its sample text, not the owner’s words'
  },
  // ---- the real-Premiere feature test (🧪 Test everything) ----
  {
    name: 'selftest-newest-item',
    file: 'CutPilot/jsx/host.jsx',
    find: '    if (!seen[id]) { seen[id] = 1; return it; }',
    repl: '    if (false) { seen[id] = 1; return it; }',
    gate: 'CutPilot/test/gates/selftest-premiere-host.js',
    why: 'the test clips are looked up by their path, which a Mac reports under /private/var — the test never starts'
  },
  {
    name: 'selftest-second-camera',
    file: 'CutPilot/jsx/host.jsx',
    find: '      if (s1.videoTracks.numTracks < 2) CP_addTopVideoTrack();',
    repl: '      if (false) CP_addTopVideoTrack();',
    gate: 'CutPilot/test/gates/selftest-premiere-host.js',
    why: 'a sequence made with one video track gets no second camera, so Multicam cannot be tried'
  },
  {
    name: 'selftest-cleanup-templates',
    file: 'CutPilot/jsx/host.jsx',
    find: '        try { g.moveBin(st.bin); }',
    repl: '        try { if (false) g.moveBin(st.bin); }',
    gate: 'CutPilot/test/gates/selftest-premiere-host.js',
    why: 'the templates the test placed stay in the owner’s Motion Graphics Template Media bin'
  },
  {
    name: 'selftest-cleanup-leftover',
    file: 'CutPilot/jsx/host.jsx',
    find: '      var ours = (c.type === 2 && name === CP_ST_NAME);',
    repl: '      var ours = false;',
    gate: 'CutPilot/test/gates/selftest-premiere-host.js',
    why: 'a bin a stopped earlier test left is never deleted'
  },
  {
    name: 'selftest-cleanup-owner-bins',
    file: 'CutPilot/jsx/host.jsx',
    find: "        if (!ours && name.indexOf('Pulse') !== 0 && name !== CP_MGT_BIN) continue;",
    repl: '        if (false) continue;',
    gate: 'CutPilot/test/gates/selftest-premiere-host.js',
    why: 'the tidy-up deletes a bin the owner made while the test ran'
  },
  {
    name: 'selftest-cleanup-prev',
    file: 'CutPilot/jsx/host.jsx',
    find: "      try { CP_activateSequence(st.prev); done.push('your sequence is active again'); }",
    repl: "      try { done.push('your sequence is active again'); }",
    gate: 'CutPilot/test/gates/selftest-premiere-host.js',
    why: 'after the test the owner is left looking at a deleted sequence instead of theirs'
  },
  {
    name: 'selftest-keeps-going',
    file: 'CutPilot/js/main.js',
    find: '          if (i < 2) stopped = true;   // no clips or no test sequence: nothing else can run',
    repl: '          stopped = true;',
    gate: 'CutPilot/test/gates/selftest-premiere.js',
    why: 'one failing feature hides every feature after it from the report'
  },
  {
    name: 'selftest-cleanup-always',
    file: 'CutPilot/js/main.js',
    find: "      if (progress) progress(steps.length, steps.length, 'putting everything back');",
    repl: "      if (stopped) return null;\n      if (progress) progress(steps.length, steps.length, 'putting everything back');",
    gate: 'CutPilot/test/gates/selftest-premiere.js',
    why: 'a test that could not build its sequence leaves its bin and clips in the owner’s project'
  },
  {
    name: 'selftest-facts',
    file: 'CutPilot/js/main.js',
    find: "      }, function (e) { throw new Error(e.message + facts(e)); });\n    });\n    function razorStep(name, args) {",
    repl: "      });\n    });\n    function razorStep(name, args) {",
    gate: 'CutPilot/test/gates/selftest-premiere.js',
    why: 'a failed Multicam Apply reports only its message, not what Premiere answered'
  },
  {
    name: 'selftest-camera-colour',
    file: 'CutPilot/js/main.js',
    find: "          var right = seen.join(',') === 'red,blue,red';",
    repl: '          var right = true;',
    gate: 'CutPilot/test/gates/selftest-premiere.js',
    why: 'Multicam passes on Premiere’s word while the wrong camera is on screen'
  },
  {
    name: 'selftest-premium-ink',
    file: 'CutPilot/js/main.js',
    find: "          return { state: r.inserted > 0 && (ink == null || ink > 0.002) ? (ink == null ? 'warn' : 'ok') : 'fail', note: note };\n        });\n      });\n    });\n    add('Long videos: one overlay clip'",
    repl: "          return { state: r.inserted > 0 ? (ink == null ? 'warn' : 'ok') : 'fail', note: note };\n        });\n      });\n    });\n    add('Long videos: one overlay clip'",
    gate: 'CutPilot/test/gates/selftest-premiere.js',
    why: 'Premium captions Premiere places but does not draw pass as working'
  },
  {
    name: 'selftest-unsaved-premium',
    file: 'CutPilot/js/main.js',
    find: "      if (!saved) return Promise.resolve({ state: 'warn', note: 'not tried — Premium templates need a saved project: save yours once (⌘S), then test again' });\n      return host('CP_insertMogrtCaptions', {",
    repl: "      return host('CP_insertMogrtCaptions', {",
    gate: 'CutPilot/test/gates/selftest-premiere.js',
    why: 'an unsaved project gets a Premium failure the ✨ flow would never hit (it asks for ⌘S first)'
  },
  {
    name: 'selftest-clip-names',
    file: 'CutPilot/js/main.js',
    find: "    var cam1 = pathMod.join(dir, 'test-camera-1.mov'), cam2 = pathMod.join(dir, 'test-camera-2.mov');",
    repl: "    var cam1 = pathMod.join(dir, 'pulse-selftest-cam1.mov'), cam2 = pathMod.join(dir, 'pulse-selftest-cam2.mov');",
    gate: 'CutPilot/test/gates/selftest-premiere.js',
    why: '“Remove Pulse’s captions” takes the test cameras for captions and deletes them mid-test'
  },
  {
    name: 'selftest-sfx-track',
    file: 'CutPilot/js/main.js',
    find: '        var tr = (src.audio || []).filter(function (a) { return a.index === placed.track - 1 && !a.nested; })[0];',
    repl: '        var tr = (src.audio || [])[placed.track];',
    gate: 'CutPilot/test/gates/selftest-premiere.js',
    why: 'the sound-effect check looks at the wrong audio track'
  },
  {
    name: 'selftest-env-back',
    file: 'CutPilot/js/main.js',
    find: '        if (env && env.sequenceName !== ST_SEQ) {',
    repl: '        if (false) {',
    gate: 'CutPilot/test/gates/selftest-premiere.js',
    why: 'after the test the panel still thinks the deleted test sequence is the owner’s'
  },
  {
    name: 'selftest-audit-optin',
    file: 'CutPilot/js/main.js',
    find: '    if (!audit) { settings.useRealPreviews = true; saveSettings(); }   // explicit opt-in: the 🎥 button only',
    repl: '    { settings.useRealPreviews = true; saveSettings(); }',
    gate: 'CutPilot/test/gates/selftest-premiere.js',
    why: 'the style audit after the first test switches every style card to the editable engine’s render'
  },
  {
    name: 'selftest-audit-append',
    file: 'CutPilot/js/main.js',
    find: "                  so.textContent = audit && /In Premiere: /.test(so.textContent) ? so.textContent + '\\n\\n' + rep : rep;",
    repl: '                  so.textContent = rep;',
    gate: 'CutPilot/test/gates/selftest-premiere.js',
    why: 'the style audit’s report replaces the test report the owner is reading'
  }
];

const only = process.argv[2];
const list = only ? MUTANTS.filter(m => m.name.indexOf(only) >= 0) : MUTANTS;
if (!list.length) { console.error('no mutant matches "' + only + '"'); process.exit(1); }

let survived = 0, checked = 0, skipped = 0;
const touched = new Set();
console.log('mutation check (a gate that cannot fail is not a gate)');

for (const m of list) {
  const abs = path.join(ROOT, m.file);
  const original = fs.readFileSync(abs, 'utf8');
  if (original.indexOf(m.find) < 0) {
    console.log('  ? ' + m.name + ' — anchor no longer present in ' + m.file + ' (mutation needs updating)');
    skipped++;
    continue;
  }
  try {
    touched.add(m.file);
    fs.writeFileSync(abs, original.split(m.find).join(m.repl));
    const r = cp.spawnSync(process.execPath, [path.join(ROOT, m.gate)],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    checked++;
    if (r.status === 2) {
      console.log('  ? ' + m.name + ' — ' + path.basename(m.gate) + ' skipped itself here (no browser/ffmpeg)');
      skipped++; checked--;
    } else if (r.status === 0) {
      console.log('  ✗ ' + m.name + ' SURVIVED — ' + path.basename(m.gate) +
                  ' still passes while ' + m.why);
      survived++;
    } else {
      console.log('  ✓ ' + m.name + ' — ' + path.basename(m.gate) + ' catches it (' + m.why + ')');
    }
  } finally {
    fs.writeFileSync(abs, original);
  }
}

// never leave the tree dirty, whatever happened above
// Check the files this run actually MUTATED are back as they were. Checking the
// whole tree instead flagged unrelated work in progress — including this tool's
// own uncommitted edits — as a failed restore, which would train someone to
// ignore the one line that means the repo was corrupted.
if (touched.size) {
  const dirty = cp.spawnSync('git', ['-C', ROOT, 'status', '--porcelain', '--'].concat([...touched]),
    { encoding: 'utf8' }).stdout.split('\n')
    .filter(l => l.trim() && !/^\?\?/.test(l)).join('\n').trim();
  if (dirty) {
    console.log('  ✗ a mutated file was NOT restored — the repo is corrupted:\n' + dirty);
    survived++;
  }
}

console.log(survived
  ? ('MUTATION CHECK: ' + survived + ' mutation(s) survived — those gates are not guarding what they claim')
  : ('MUTATION CHECK: all ' + checked + ' mutations were caught' + (skipped ? ' (' + skipped + ' skipped)' : '') + ' ✓'));
process.exit(survived ? 1 : 0);
