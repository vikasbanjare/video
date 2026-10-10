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
    find: '|| /^pulse-captions/i.test(file) ||',
    repl: '||',
    gate: 'CutPilot/test/gates/host-remove-safety.js',
    why: 'Remove-all-captions stops finding a long video\'s overlay'
  },
  {
    name: 'legibility-floor',
    file: 'CutPilot/js/render.js',
    find: '          px = Math.max(px, r2(shortSide * 0.05));',
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
    find: "          if (tp) CP_setMgrtText(tp, args.text, true, args.textStyle || null);",
    repl: "          if (false) CP_setMgrtText(tp, args.text, true, args.textStyle || null);",
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
    repl: "    var cam1 = pathMod.join(dir, 'pulse-captions-camera-1.mov'), cam2 = pathMod.join(dir, 'test-camera-2.mov');",
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
  },
  // ---- removals that took the owner's footage; text that broke host calls ----
  {
    name: 'remove-guide-by-name',
    file: 'CutPilot/jsx/host.jsx',
    find: "        if (nm === 'guide.png') { try { it.remove(0, 0); removed++; } catch (eR) {} }",
    repl: "        if (nm.indexOf('guide') >= 0 || nm.indexOf('pulse') >= 0 || nm.indexOf('brand') >= 0) { try { it.remove(0, 0); removed++; } catch (eR) {} }",
    gate: 'CutPilot/test/gates/host-remove-safety.js',
    why: 'Remove guide takes “Brand story.mp4” and “Style guide.mov” off the timeline'
  },
  {
    name: 'remove-captions-by-name',
    file: 'CutPilot/jsx/host.jsx',
    find: '  if (!CP_MEDIA_FILE.test(file)) return CP_CAPTION_NAME.test(nm) || /^captions\\.mov$/i.test(nm);',
    repl: '  if (true) return CP_CAPTION_NAME.test(nm) || /^captions\\.mov$/i.test(nm);',
    gate: 'CutPilot/test/gates/host-remove-safety.js',
    why: 'Remove captions deletes the owner’s “Pulse ep 3.mp4” with the captions'
  },
  {
    name: 'json-control-chars',
    file: 'CutPilot/jsx/host.jsx',
    find: "              .replace(/[\\u0000-\\u001f\\u2028\\u2029]/g, function (c) {",
    repl: "              .replace(/[\\u0000]/g, function (c) {",
    gate: 'CutPilot/test/gates/host-json-roundtrip.js',
    why: 'a control character in a name comes back raw and the panel refuses Premiere’s whole answer'
  },
  {
    name: 'bridge-line-separators',
    file: 'CutPilot/js/lib/cep-bridge.js',
    find: "      if (typeof json === 'string') json = json.replace(/\\u2028/g, '\\\\u2028').replace(/\\u2029/g, '\\\\u2029');",
    repl: '',
    gate: 'CutPilot/test/gates/host-json-roundtrip.js',
    why: 'a pasted line separator reaches ExtendScript raw — the whole call is a syntax error'
  },
  {
    name: 'es3-runtime-active',
    file: 'CutPilot/jsx/host.jsx',
    find: "  var nm = '', mp = '';\n  try { nm = String(clip.name || ''); } catch (eN) {}",
    repl: "  var nm = '', mp = '', first = [1, 2].indexOf(1);\n  try { nm = String(clip.name || ''); } catch (eN) {}",
    gate: 'CutPilot/test/gates/host-remove-safety.js',
    why: 'host.jsx calls Array.indexOf, which Premiere’s ExtendScript does not have, and no gate notices'
  },
  {
    name: 'cleanup-playhead-fallback',
    file: 'CutPilot/jsx/host.jsx',
    find: '    if (unc.length) {\n      triedPlayhead = true;',
    repl: '    if (false) {\n      triedPlayhead = true;',
    gate: 'CutPilot/test/host-tests.js',
    why: 'on a Premiere whose razor ignores Pulse’s timecodes (the owner’s Mac), Clean up cuts nothing at all'
  },
  {
    name: 'cleanup-cut-facts',
    file: 'CutPilot/jsx/host.jsx',
    find: "          triedPlayhead: triedPlayhead, uncut: bad.join('/'), qeProblem: qeProblem });",
    repl: "          uncut: bad.join('/') });",
    gate: 'CutPilot/test/host-tests.js',
    why: 'a Clean up Premiere refused reports nothing of what Premiere answered'
  },
  {
    name: 'selftest-mirror-display',
    file: 'CutPilot/jsx/host.jsx',
    find: '        if (ps && ts && ps.videoDisplayFormat != null && ts.videoDisplayFormat !== ps.videoDisplayFormat) { ts.videoDisplayFormat = ps.videoDisplayFormat; seq.setSettings(ts); }',
    repl: '',
    gate: 'CutPilot/test/gates/selftest-premiere-host.js',
    why: 'the test sequence shows time its own way, so a razor that fails on the owner’s Frames timeline passes the test'
  },
  {
    name: 'selftest-mirror-size',
    file: 'CutPilot/js/main.js',
    find: "          size = (w - w % 2) + 'x' + (h - h % 2); rate = rateOf(f);",
    repl: '',
    gate: 'CutPilot/test/gates/selftest-premiere.js',
    why: 'the test clips are 1280×720 in a vertical sequence — letterboxed, unlike the owner’s, and the black reads as captions'
  },
  {
    name: 'selftest-mirror-ntsc',
    file: 'CutPilot/js/main.js',
    find: "      var known = [[23.976, '24000/1001'], [29.97, '30000/1001'], [59.94, '60000/1001'], [47.952, '48000/1001'], [119.88, '120000/1001']];",
    repl: '      var known = [];',
    gate: 'CutPilot/test/gates/selftest-premiere.js',
    why: 'a 29.97 fps sequence gets test clips at a rounded rate, so the test sequence is not like the owner’s'
  },
  // ---- the engines that listen, on speech the Mac speaks ----
  {
    name: 'speech-words-check',
    file: 'CutPilot/js/main.js',
    find: '          var heard = /test/i.test(txt) && /\\b(one|1)\\b/i.test(txt) && /\\b(three|3)\\b/i.test(txt);',
    repl: '          var heard = !!txt;',
    gate: 'CutPilot/test/gates/selftest-speech.js',
    why: 'a transcription that misses words passes as working'
  },
  {
    name: 'speech-voice-order',
    file: 'CutPilot/js/main.js',
    find: '        var right = who[0] != null && who[1] != null && who[0] !== who[1] && who[2] === who[0] && who[3] === who[1];',
    repl: '        var right = who[0] !== who[1];',
    gate: 'CutPilot/test/gates/selftest-speech.js',
    why: 'Who’s talking passes when it gives the third and fourth lines to the wrong voice'
  },
  {
    name: 'speech-line-slots',
    file: 'CutPilot/js/main.js',
    find: "aresample=16000,apad=whole_dur=' + ST_LINE + ',atrim=0:' + ST_LINE + '[l'",
    repl: "aresample=16000[l'",
    gate: 'CutPilot/test/gates/selftest-speech.js',
    why: 'the spoken lines run together, so the voice heard at each line’s moment is not that line’s'
  },
  {
    name: 'speech-mac-only',
    file: 'CutPilot/js/main.js',
    find: '    if (!ff || !fs.existsSync(ST_SAY)) return Promise.resolve();',
    repl: '    if (!ff) return Promise.resolve();',
    gate: 'CutPilot/test/gates/selftest-speech.js',
    why: 'a computer without `say` (Windows) gets failing speech rows for a test it cannot run'
  },
  {
    name: 'speech-tidy',
    file: 'CutPilot/js/main.js',
    find: '    return chain.then(tidy, function (e) { tidy(); throw e; });',
    repl: '    return chain;',
    gate: 'CutPilot/test/gates/selftest-speech.js',
    why: 'the test’s speech recordings stay in the temp folder'
  },
  {
    name: 'overlay-replace-by-name',
    file: 'CutPilot/jsx/host.jsx',
    find: "          if (nmR.indexOf('cap_') === 0 || nmR.indexOf('pulse-captions') === 0 || nmR === 'captions.mov' || nmR === 'guide.png') { try { itR.remove(0, 0); } catch (eRem) {} }",
    repl: "          if (nmR.indexOf('pulse') >= 0 || nmR.indexOf('caption') >= 0 || nmR.indexOf('cap_') === 0) { try { itR.remove(0, 0); } catch (eRem) {} }",
    gate: 'CutPilot/test/gates/overlay-host.js',
    why: 'replacing a caption track also takes the owner’s “Caption intro.mp4” off it'
  },
  // ---- one click lands: caption grouping, timing and fit (captions-generate-lands) ----
  {
    name: 'capcore-words-cap',
    file: 'CutPilot/js/captions.js',
    find: '        if (N && y - x > N) return false;',
    repl: '        if (N && y - x > N + 1) return false;',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: '"Words per caption" says 1 (or 3) and a caption holds one word more'
  },
  {
    name: 'capcore-sentence-end',
    file: 'CutPilot/js/captions.js',
    find: '      if (isSentenceEnd(w.text)) return true;',
    repl: '',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'a caption runs across a sentence end, showing the next sentence early'
  },
  {
    name: 'capcore-pause',
    file: 'CutPilot/js/captions.js',
    find: '      if (nx.start - w.end >= pause - 1e-9) return true;',
    repl: '',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'a caption stays up through a pause of half a second or more'
  },
  {
    name: 'capcore-7s',
    file: 'CutPilot/js/captions.js',
    find: '        if (words[y - 1].end - words[x].start > maxDur + 1e-9) return false;',
    repl: '',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'slow speech with no pause gives a caption longer than 7 s'
  },
  {
    name: 'capcore-chaining',
    file: 'CutPilot/js/captions.js',
    find: '        if (nx.s - e < half) {',
    repl: '        if (false) {',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'a 3-11 frame flicker is left between captions instead of exactly 2 frames'
  },
  {
    name: 'capcore-lag-out',
    file: 'CutPilot/js/captions.js',
    find: '      var want = Math.max(cp.sp + lag, cp.s + minF);',
    repl: '      var want = Math.max(cp.sp, cp.s + minF);',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'a caption vanishes on its last syllable instead of holding 0.5 s'
  },
  {
    name: 'capcore-min-duration',
    file: 'CutPilot/js/captions.js',
    find: '      var minF = Math.ceil(((cp.b - cp.a) > 1 ? R.minMulti : R.minSingle) * F - 1e-6);',
    repl: '      var minF = Math.ceil(R.minSingle * F - 1e-6);',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'a quick two-word caption flashes by under 0.833 s with silence after it'
  },
  {
    name: 'capcore-postposition',
    file: 'CutPilot/js/captions.js',
    find: '    if (_POSTPOS[nb] || _AUX[nb]) return Infinity;',
    repl: '    if (_AUX[nb]) return Infinity;',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'a caption or a line starts with a Hindi postposition ("YouTube | par")'
  },
  {
    name: 'capcore-short-words',
    file: 'CutPilot/js/captions.js',
    find: '        if (whole ? (e >= s) : (e - s > min)) {',
    repl: '        if (e - s > min) {',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'quick Hindi words ("ki", "to") stamped 0-50 ms are dropped from the captions'
  },
  {
    name: 'capcore-fit',
    file: 'CutPilot/js/captions.js',
    find: "      fits: fit ? function (a, b) { var cw = capWords(a, b); return fit(cw, fitHow(cw)); } : null,",
    repl: "      fits: null,",
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'Auto groups more words than fit the frame, so captions shrink or overflow'
  },
  {
    name: 'capcore-emoji',
    file: 'CutPilot/js/captions.js',
    find: '      if (opts.emoji) {',
    repl: '      if (false) {',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: '✨ Auto-emoji does nothing once the words have real timing'
  },
  {
    name: 'capcore-caps',
    file: 'CutPilot/js/captions.js',
    find: '      if (capsSet && capsSet[capsKey(w.text)]) t = t.toUpperCase();',
    repl: '',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: '🔠 CAPS on key words does nothing once the words have real timing'
  },
  {
    name: 'capcore-native-wrap',
    file: 'CutPilot/js/captions.js',
    find: '      out.push({ start: cur.s / F, end: e / F, text: wrapForNative(cur.text, opts.perLine || 42) });',
    repl: '      out.push({ start: cur.s / F, end: e / F, text: cur.text });',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'Premiere\'s own caption track gets one long unbroken line it re-wraps at its own width'
  },
  {
    name: 'capcore-landscape-size',
    file: 'CutPilot/js/render.js',
    find: '      if (asked > knee) scale *= (knee + (asked - knee) * LAND_SLOPE) / asked;',
    repl: '',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'the default captions are oversized on a 1920x1080 podcast again (capitals 6.6%)'
  },
  {
    name: 'capcore-landscape-size-audit',
    file: 'CutPilot/js/render.js',
    find: '      if (asked > knee) scale *= (knee + (asked - knee) * LAND_SLOPE) / asked;',
    repl: '',
    gate: 'tools/style-quality-audit.js',
    why: 'the style audit cannot see an oversized default on a landscape podcast'
  },
  {
    name: 'capcore-size-floor',
    file: 'CutPilot/js/render.js',
    find: '    var minPx = (style.minSize > 0) ? Math.min(base, style.minSize) : Math.max(6, base * 0.34);',
    repl: '    var minPx = Math.max(6, base * 0.34);',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'a long URL shrinks to microscopic text instead of being broken'
  },
  {
    name: 'capcore-box-extent',
    file: 'CutPilot/js/render.js',
    find: '      ext = Math.max(ext, padX + edge);',
    repl: '',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'at Max width 98% a boxed style draws its box outside the frame'
  },
  {
    name: 'capcore-hindi-line-step',
    file: 'CutPilot/js/render.js',
    find: '        adv = Math.max(adv, ink + air);',
    repl: '',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'two lines of Hindi overlap at a tight line spacing (Two-Tone Stack)'
  },
  {
    name: 'capcore-one-layout',
    file: 'CutPilot/js/render.js',
    find: '{ wordSync: wordSync, highlightSet: frame.words != null ? frame.highlightSet : null });',
    repl: '{ wordSync: false, highlightSet: (frame.active != null) ? [frame.active].reduce(function (o, a) { o[a] = true; return o; }, {}) : (frame.words != null ? frame.highlightSet : null) });',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'the layout follows the spoken word, so lines jump while a caption is said'
  },
  {
    name: 'capcore-line-grammar',
    file: 'CutPilot/js/render.js',
    find: '    var lay = at(base, words, srcs0, maxLines, true);',
    repl: '    var lay = at(base, words, srcs0, maxLines, false);',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'a caption fits only by starting a line with a postposition or auxiliary'
  },
  {
    name: 'capcore-one-word-size',
    file: 'CutPilot/js/render.js',
    find: '    var base = style.size, hlScale = (wordSync && words.length === 1) ? 1 : (style.highlightScale || 1);',
    repl: '    var base = style.size, hlScale = style.highlightScale || 1;',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'one-word captions are all drawn at the pop size, oversized on a podcast'
  },
  {
    name: 'capcore-reels-position',
    file: 'CutPilot/js/main.js',
    find: '    return (portraitSeq() && def > REELS_SAFE_POS) ? REELS_SAFE_POS : def;',
    repl: '    return def;',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'on a vertical reel the default captions sit under the app\'s buttons (76%)'
  },
  {
    name: 'capcore-owner-position',
    file: 'CutPilot/js/main.js',
    find: "    if ($('c-pos')) $('c-pos').addEventListener('input', function () { state.posUserSet = true; });",
    repl: '',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'the owner moves Position and the captions stay at the automatic spot'
  },
  {
    name: 'capcore-preview-grouping',
    file: 'CutPilot/js/main.js',
    find: '        anim: pvAnimId, words: pvWpc, wordCues: S.wordCues,',
    repl: '        anim: pvAnimId, words: pvWpc || 4, wordCues: S.wordCues,',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'the preview groups ✨ Auto 4 words at a time while the timeline gets whole phrases'
  },
  {
    name: 'capcore-track-strict',
    file: 'CutPilot/jsx/host.jsx',
    find: 'captionTrackCreated: okCt === true,',
    repl: 'captionTrackCreated: okCt !== false,',
    gate: 'CutPilot/test/host-tests.js',
    why: 'a caption track Premiere never confirmed is reported as made'
  },
  {
    name: 'capcore-track-format',
    file: 'CutPilot/jsx/host.jsx',
    find: 'var okCt = (fmt !== undefined) ? seq.createCaptionTrack(item, 0, fmt) : seq.createCaptionTrack(item, 0);',
    repl: 'var okCt = seq.createCaptionTrack(item, 0);',
    gate: 'CutPilot/test/host-tests.js',
    why: 'the caption track is not asked for as Subtitle (CEA-708 cuts lines at 32 letters)'
  },
  {
    name: 'capcore-reading-speed',
    file: 'CutPilot/js/captions.js',
    find: '      if (cp.s + needF > want) want = cp.s + needF;',
    repl: '',
    gate: 'CutPilot/test/gates/captions-timing-rules.js',
    why: 'a caption spoken faster than it can be read vanishes half a second after its last word, with silence left unused'
  },
  {
    name: 'capcore-split-reads',
    file: 'CutPilot/js/captions.js',
    find: ' + ((j - i2 === 1 && N !== 1) ? 4 : 0) + timeCost(i2, j);',
    repl: ' + ((j - i2 === 1 && N !== 1) ? 4 : 0);',
    gate: 'CutPilot/test/gates/captions-timing-rules.js',
    why: 'a sentence splits so a quick word flashes by alone for one frame although another split avoids it'
  },
  {
    name: 'capcore-ntsc',
    file: 'CutPilot/js/captions.js',
    find: '    for (var i = 0; i < ntsc.length; i++) if (Math.abs(fps - ntsc[i] / 1001) < 0.01) return ntsc[i] / 1001;',
    repl: '',
    gate: 'CutPilot/test/gates/captions-timing-rules.js',
    why: 'on a 29.97 sequence caption times are counted at 29.97 and drift off Premiere\'s frames (gaps of 1 or 3 frames)'
  },
  {
    name: 'capcore-clamp',
    file: 'CutPilot/js/captions.js',
    find: '      if (w.end - w.start > cap) {',
    repl: '      if (false) {',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'a word the speech engine stretched into the silence shows its caption 1.8 s before it is said, or keeps it 1.8 s after'
  },
  {
    name: 'capcore-reading-speed-generate',
    file: 'CutPilot/js/captions.js',
    find: '      if (cp.s + needF > want) want = cp.s + needF;',
    repl: '',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'after a real Generate, a caption too fast to read leaves the silence after it unused'
  },
  {
    name: 'capcore-libass-same',
    file: 'CutPilot/js/main.js',
    find: '      try { events = eventsFromFrames(captionJobFrames(cues, wordCues, currentPreset(), ovr)); } catch (eEv) { events = null; }',
    repl: '      events = null;',
    gate: 'CutPilot/test/gates/captions-long-video-same.js',
    why: 'a long video drawn by the libass fallback splits and times its captions differently from the images (no 2-frame gaps, no 0.5 s hold)'
  },
  {
    name: 'capcore-libass-wordcues',
    file: 'CutPilot/js/main.js',
    find: '    var wordCuesP = (opts.wordCues !== undefined) ? Promise.resolve(opts.wordCues) : getCaptionWordCues(cues, true);',
    repl: '    var wordCuesP = getCaptionWordCues(cues, true);',
    gate: 'CutPilot/test/gates/captions-long-video-same.js',
    why: 'falling back from Pulse\'s overlay to libass throws away the word timing the job had and re-guesses it'
  },
  {
    name: 'capcore-static-fit-wordsync',
    file: 'CutPilot/js/captions.js',
    find: '      fits: fit ? function (a, b) { var cw = capWords(a, b); return fit(cw, fitHow(cw)); } : null,',
    repl: '      fits: fit ? function (a, b) { var cw = capWords(a, b); return fit(cw); } : null,',
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'a static caption with Bigger punchy words / lit key words is grouped as if one word at a time were enlarged, then shrinks below the style\'s size'
  },
  {
    name: 'capcore-static-fit-emphasis',
    file: 'CutPilot/js/captions.js',
    find: "      return { wordSync: false, highlightSet: (kw && kw.on) ? markKeywords(cw, kw) : null };",
    repl: "      return { wordSync: true, highlightSet: (kw && kw.on) ? markKeywords(cw, kw) : null };",
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'the fit ignores 🔠 Bigger punchy words (viral words 1.5x) on static captions, so those captions shrink'
  },
  {
    name: 'capcore-static-fit-keywords',
    file: 'CutPilot/js/render.js',
    find: "              highlightSet: (opts && opts.highlightSet) || null };",
    repl: "              highlightSet: null };",
    gate: 'CutPilot/test/gates/captions-generate-lands.js',
    why: 'the fit ignores the key words lit at the pop size on static captions, so those captions shrink'
  },
  {
    name: 'capcore-static-fit-tile',
    file: 'CutPilot/js/main.js',
    find: "          keyword: { on: !!raw.keyword, mode: raw.keywordMode || 'smart' }, speaker: { on: false },",
    repl: "          keyword: { on: false }, speaker: { on: false },",
    gate: 'CutPilot/test/panel-proofs.js',
    why: 'a static key-word style (Bold Pop) splits its sample differently on the gallery tile than in the editor preview and on the timeline'
  },
  // ---- ⚡ Premium (.mogrt) captions land right untouched (premium-fit.js) ----
  {
    name: 'pfit-comp-scale',
    file: 'CutPilot/jsx/host.jsx',
    find: "  var s = (fitMode === 'short') ? (Math.min(sw, sh) / Math.min(cw, ch)) * 100",
    repl: "  var s = (fitMode === 'short') ? ((sh > sw) ? (sw / 1920) * 100 : 100)",
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'every 1080×1920 Premium template is shrunk to 56.25% on a reel again (the 1920-wide guess)'
  },
  {
    name: 'pfit-motion-components',
    file: 'CutPilot/jsx/host.jsx',
    find: '  try { if (clip.components) lists.push(clip.components); } catch (e1) {}',
    repl: '',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the host looks for the clip\'s Motion only where Premiere does not keep it, so nothing is sized or placed'
  },
  {
    name: 'pfit-comp-size-sent',
    file: 'CutPilot/js/main.js',
    find: "        compW: (geom && geom.compW) || 0, compH: (geom && geom.compH) || 0,   // the comp's real size → fitted to the sequence",
    repl: '        compW: 0, compH: 0,',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the panel stops telling the host the template\'s real comp size'
  },
  {
    name: 'pfit-caption-size',
    file: 'CutPilot/js/main.js',
    find: '      k = plan.targetPx / designPx;',
    repl: '      k = 1;',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the title templates caption the whole video at their 139–200 px title size'
  },
  {
    name: 'pfit-line-width',
    file: 'CutPilot/js/main.js',
    find: '    if (total <= maxW) return { breaks: [], width: total, cost: 0 };',
    repl: '    return { breaks: [], width: total, cost: 0 };',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'captions are no longer measured against the comp, so long lines are cropped'
  },
  {
    name: 'pfit-measure-poppins',
    file: 'CutPilot/js/main.js',
    find: '    if (/^poppins/.test(s)) return 1.18;',
    repl: '    if (/^poppins/.test(s)) return 0.85;',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'Flux Prism\'s wide Poppins is measured as if narrow, so its lines overrun its box'
  },
  {
    name: 'pfit-grammar-roman',
    file: 'CutPilot/js/main.js',
    find: "    return lang !== 'english' && !!(PREM_POSTPOS_ROMAN[b] || PREM_AUX_ROMAN[b]);",
    repl: '    return false;',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'a Hinglish line can start with "raha" / "ka", split from the word it belongs to'
  },
  {
    name: 'pfit-position',
    file: 'CutPilot/js/main.js',
    find: '        posYPct: built ? built.posYPct : null,                                // whole graphic at the caption row',
    repl: '        posYPct: null,',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'Premium captions sit in the middle of the frame again, over faces'
  },
  {
    name: 'pfit-hold-host',
    file: 'CutPilot/jsx/host.jsx',
    find: '      var endSec = hasHold ? limit : wordEnd;',
    repl: '      var endSec = wordEnd;',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the host ignores the hold the panel planned, so captions blink off with the last word'
  },
  {
    name: 'pfit-hold-panel',
    file: 'CutPilot/js/main.js',
    find: '      var want = c.end + lag;',
    repl: '      var want = c.end + 60;',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the last Premium caption lingers a minute after the speech'
  },
  {
    name: 'pfit-gap-rule',
    file: 'CutPilot/js/main.js',
    find: '        if (want > limit || nx.start - want < PREM_PAUSE) want = limit;   // 2 frames apart, or at least half a second',
    repl: '        if (want > limit) want = limit;',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'captions leave flickery 0.1–0.4 s gaps instead of 2 frames or half a second'
  },
  {
    name: 'pfit-flash-merge',
    file: 'CutPilot/js/main.js',
    find: '        if (!fc.ws || !fnx.ws || fnx.start - gap2 - fc.start >= 0.2) continue;',
    repl: '        continue;',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'one-word captions on fast speech flash by in under 0.2 s'
  },
  {
    name: 'pfit-own-words',
    file: 'CutPilot/js/main.js',
    find: '                 fps: (env && env.fps) || 30, words: o.words || 0 };',
    repl: "                 fps: (env && env.fps) || 30, words: parseInt($('c-words').value, 10) || 0 };",
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'Premium inherits the Styles editor\'s stepper again — one word per graphic'
  },
  {
    name: 'pfit-deva-font',
    file: 'CutPilot/js/main.js',
    find: "    if (noDeva && (!swapTo || PREM_NO_DEVA.test(String(swapTo).replace(/\\s+/g, '')))) { swapTo = premDevaFace(); out.why = 'script'; }",
    repl: '',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'Hindi captions go out in Inter / Arial / Neue Haas and come out blank'
  },
  {
    name: 'pfit-sheet-unfolded',
    file: 'CutPilot/js/main.js',
    find: '      var collapsed = !openNow;',
    repl: '      var collapsed = hi > 0;',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'every Premium sheet opens with all its controls folded ("the options are gone")'
  },
  {
    name: 'pfit-sheet-no-premiere',
    file: 'CutPilot/js/main.js',
    find: '      build((cached && cached.props) || []);',
    repl: '      if (cached) build(cached.props || []);',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the sheet shows no controls until a live Premiere read succeeds'
  },
  {
    name: 'pfit-sheet-case',
    file: 'CutPilot/js/main.js',
    find: "    var mode = o.caseMode || 'as-spoken';",
    repl: "    var mode = state.mogrtCase || 'as-spoken';",
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'Premium text case comes from the hidden Upload view again, not the sheet'
  },
  {
    name: 'pfit-explicit-size',
    file: 'CutPilot/js/main.js',
    find: '    var designPx = (g ? g.fontPx : 0) * (Tdef / 100) * (Ldef / 100) * C;',
    repl: '    var designPx = (g ? g.fontPx : 0) * (T / 100) * (L / 100) * S * C;',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the auto size cancels the owner\'s own Font size change, so changing it does nothing'
  },
  {
    name: 'pfit-reset-box',
    file: 'CutPilot/js/main.js',
    find: "    box = box || $('tpl-params');\n    if (box && box.id === 'ms-customizer') {",
    repl: "    box = $('tpl-params');\n    if (box && box.id === 'ms-customizer') {",
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the sheet\'s ↺ Reset rebuilds the hidden Upload box and the sheet keeps showing the old values'
  },
  {
    name: 'pfit-custom-grid',
    file: 'CutPilot/js/main.js',
    find: '    (state.userMogrts || []).forEach(function (m) { var c = premiumCustomFor(m); if (c) list.push(c); });',
    repl: '',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'a look saved with ＋ Save as custom disappears from the Premium grid'
  },
  {
    name: 'pfit-sync-nudge',
    file: 'CutPilot/js/main.js',
    find: '    var off = captionSyncOffset();',
    repl: '    var off = 0;',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the owner\'s timing nudge stops reaching Premium captions'
  },
  {
    name: 'pfit-job-remembered',
    file: 'CutPilot/js/main.js',
    find: "                              kind: (opts && opts.premium) ? 'premium' : 'template', mogrtPath: mogrtPath,",
    repl: '                              kind: null, mogrtPath: null,',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'a Premium insert forgets its template, so it cannot be redone and the hint misleads'
  },
  {
    name: 'pfit-replace-editable',
    file: 'CutPilot/js/main.js',
    find: '        replaceEd = { track: pjE.track, names: captionGraphicNames(pjE.mogrtPath) };',
    repl: '        replaceEd = null;',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: '✨ Add captions stacks a second set over the Premium captions again'
  },
  {
    name: 'pfit-editable-posy',
    file: 'CutPilot/js/main.js',
    find: '      out._posYPct = yp;',
    repl: '      out._posYPct = preset.seqLandscape ? (420 + 1080 * yp) / 1920 : yp;',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'editable captions on 16:9 sit ~124 px higher than the Position slider says'
  },
  {
    name: 'pfit-card-render-plan',
    file: 'CutPilot/js/main.js',
    find: "        if (sb) { rArgs.params = sb.params; rArgs.textStyle = sb.textStyle; rArgs.compW = sb.compW; rArgs.compH = sb.compH; rArgs.fitMode = sb.fitMode; rArgs.posYPct = sb.posYPct; rArgs.sizeFit = sb.sizeFit; }",
    repl: "",
    gate: 'CutPilot/test/gates/gallery-premium-render.js',
    why: 'the Premium cards are drawn unfitted, so the preview no longer matches the timeline'
  },
  {
    name: 'pfit-last-caption',
    file: 'CutPilot/jsx/host.jsx',
    find: '      var limit = hasHold ? showUntil : (nextStart != null ? nextStart : wordEnd + 3);',
    repl: '      var limit = hasHold ? showUntil : (nextStart != null ? nextStart : wordEnd + nat + 3600);',
    gate: 'CutPilot/test/host-tests.js',
    why: 'with stretch on and no hold, the last caption of a 60 s template stays a minute'
  },
  {
    name: 'pfit-scale-param',
    file: 'CutPilot/jsx/host.jsx',
    find: "    if (kind === 'scale') return CP_setScaleParam(prop, value);",
    repl: '',
    gate: 'CutPilot/test/host-tests.js',
    why: 'a title template\'s own Scale control can no longer take the caption size'
  },
  {
    name: 'pfit-size-fallback',
    file: 'CutPilot/jsx/host.jsx',
    find: '    if (landed) return false;',
    repl: '    return false;',
    gate: 'CutPilot/test/host-tests.js',
    why: 'when Premiere refuses the Scale write, the words stay at title size'
  },
  {
    name: 'pfit-clear-guard',
    file: 'CutPilot/jsx/host.jsx',
    find: "    if (!names.length || !CP_trackIsPulseCaptions(ti, names)) return CP_ok({ cleared: 0, guard: 'foreign' });",
    repl: '',
    gate: 'CutPilot/test/host-tests.js',
    why: 'replacing a Premium set can empty a track that holds the owner\'s footage'
  },
  {
    name: 'pfit-preview-fit',
    file: 'CutPilot/jsx/host.jsx',
    find: "    var pvScale = CP_fitScalePct(seq, args.compW, args.compH, 0, 0, args.fitMode);",
    repl: "    var pvScale = 100;",
    gate: 'CutPilot/test/host-tests.js',
    why: '▶ Try on timeline shows the template at a different size than the insert'
  },
  {
    name: 'pfit-render-fit',
    file: 'CutPilot/jsx/host.jsx',
    find: "    var rfScale = CP_fitScalePct(seq, args.compW, args.compH, args.width, args.height, args.fitMode);   // the size this render was asked for",
    repl: "    var rfScale = 100;",
    gate: 'CutPilot/test/gates/host-render-mogrt-frames.js',
    why: 'the Premium card renders are drawn at a different size than the timeline gets'
  },
  {
    name: 'pfit-sheet-preview',
    file: 'CutPilot/js/main.js',
    find: "          compW: b.compW, compH: b.compH, fitMode: b.fitMode, posYPct: b.posYPct, sizeFit: b.sizeFit });",
    repl: "          compW: b.compW, compH: b.compH });",
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: '▶ Try on timeline in the Premium sheet drops the template mid-frame at its title size, not where the captions go'
  },
  {
    name: 'pfit-upload-preview-comp',
    file: 'CutPilot/js/main.js',
    find: '                   compW: (geom && geom.compW) || 0, compH: (geom && geom.compH) || 0 };',
    repl: '                   compW: 0, compH: 0 };',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the 📁 Upload view\'s ▶ Try on timeline drops the template unfitted while its insert is fitted'
  },
  {
    name: 'pfit-upload-preview-plan',
    file: 'CutPilot/js/main.js',
    find: '      if (isBundledMogrt(path)) {',
    repl: '      if (false) {',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the 📁 Upload view\'s ▶ Try on timeline shows Pulse\'s templates at title size, not as the captions will be'
  },
  {
    name: 'pfit-sheet-position',
    file: 'CutPilot/js/main.js',
    find: '      premOpts().pos = isFinite(v) ? Math.max(0.1, Math.min(0.92, v / 100)) : null; savePremOpts(); refreshPremControls();',
    repl: '      premOpts().pos = null; savePremOpts(); refreshPremControls();',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'moving the Premium sheet\'s Position slider changes nothing'
  },
  {
    name: 'pfit-sheet-stretch',
    file: 'CutPilot/js/main.js',
    find: "    if ($('ms-stretch')) $('ms-stretch').addEventListener('change', function () { premOpts().stretch = !!this.checked; savePremOpts(); });",
    repl: '',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the Premium sheet\'s stretch box changes nothing'
  },
  {
    name: 'pfit-hold-next',
    file: 'CutPilot/js/main.js',
    find: "    var f = 1 / (plan.fps || 30), lag = (hold === 'next') ? 3 : (parseFloat(hold) || 0);",
    repl: "    var f = 1 / (plan.fps || 30), lag = (hold === 'next') ? 0.5 : (parseFloat(hold) || 0);",
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: '“Stay until the next caption” does the same as the 0.5 s default'
  },
  {
    name: 'pfit-editable-sync',
    file: 'CutPilot/js/main.js',
    find: '    if (syncOff) tcues = tcues.map(',
    repl: '    if (false) tcues = tcues.map(',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the owner\'s timing nudge stops reaching ✏️ Editable captions'
  },
  {
    name: 'pfit-animspeed-dead',
    file: 'CutPilot/js/main.js',
    find: "      'c-wordsperline-val': function () { return $('c-wordsperline').value; },",
    repl: "      'c-wordsperline-val': function () { return $('c-wordsperline').value; },\n      'c-animspeed-val': function () { return $('c-animspeed').value + '%'; },",
    gate: 'tools/dom-id-check.js',
    why: 'the removed animation-speed slider is read again, a control that does not exist'
  },
  // ---- review round: replace only after the new captions exist; contain fit ----
  {
    name: 'pfit-clear-before-render',
    file: 'CutPilot/js/main.js',
    find: '    addPulseCaptions(mCues, null, replaceEd);',
    repl: '    if (replaceEd) clearReplacedTemplateSet({ replaceEditable: replaceEd });\n    addPulseCaptions(mCues, null, replaceEd);',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: '✨ Add captions deletes the Premium set before the new captions exist again — a Cancel or a failed render leaves no captions'
  },
  {
    name: 'pfit-replace-own-template',
    file: 'CutPilot/js/main.js',
    find: '        replaceEd = { track: pjE.track, names: captionGraphicNames(pjE.mogrtPath) };',
    repl: '        replaceEd = { track: pjE.track, names: captionGraphicNames() };',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'a set made from the owner\'s own uploaded template is stacked over instead of replaced'
  },
  {
    name: 'pfit-contain-fit',
    file: 'CutPilot/jsx/host.jsx',
    find: "    var fitMode = (args.fitMode === 'short' && compW > 0 && compH > 0) ? 'short' : 'contain';",
    repl: "    var fitMode = 'short';",
    gate: 'CutPilot/test/host-tests.js',
    why: 'the owner\'s own 1920×1080 .mogrt is 100% on a 1080×1920 reel again — ~420 px cropped off each side'
  },
  {
    name: 'pfit-contain-preview',
    file: 'CutPilot/jsx/host.jsx',
    find: "    var rfScale = CP_fitScalePct(seq, args.compW, args.compH, args.width, args.height, args.fitMode);",
    repl: "    var rfScale = CP_fitScalePct(seq, args.compW, args.compH, args.width, args.height, 'short');",
    gate: 'CutPilot/test/gates/host-render-mogrt-frames.js',
    why: 'a card render crops an unplanned landscape comp on a reel, unlike the insert'
  },
  {
    name: 'pfit-short-sent',
    file: 'CutPilot/js/main.js',
    find: "             fitMode: plan.known ? 'short' : 'contain' };",
    repl: "             fitMode: 'contain' };",
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'every 1080×1920 Premium template shrinks to 56.25% on a podcast frame — the panel no longer says it planned the lines'
  },
  {
    name: 'pfit-editable-preview-row',
    file: 'CutPilot/js/main.js',
    find: '        posYPct: pvPos });',
    repl: '        posYPct: (params && params._posYPct != null) ? params._posYPct : null });',
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the ✏️ Editable ▶ Real preview sits at the raw slider row, not where the insert puts the captions'
  },
  {
    name: 'pfit-editable-preview-lines',
    file: 'CutPilot/js/main.js',
    find: "      var pvText = (fitP.cues[0] && fitP.cues[0].text) || sample;",
    repl: "      var pvText = sample;",
    gate: 'CutPilot/test/gates/premium-fit.js',
    why: 'the ✏️ Editable ▶ Real preview drops the words unbroken, so a long first line is cropped where the insert breaks it'
  },
  // Caption options are reachable (captions-options-reachable): each one
  // undoes one fix the owner would see as "the option is gone again"
  {
    name: "opt-editable-trap",
    file: "CutPilot/js/main.js",
    find: "    if (_capOut === 'editable') { try { showCustPane('style'); } catch (ePane) {} }\n",
    repl: "",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "Effects tab open → ✏️ Editable leaves an empty editor again"
  },
  {
    name: "opt-hidden-count",
    file: "CutPilot/js/main.js",
    find: "    n.textContent = String(countPulseOnlySettings());",
    repl: "    n.textContent = 'some';",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "✏️ Editable no longer says how many settings it hides"
  },
  {
    name: "opt-restore-style",
    file: "CutPilot/js/main.js",
    find: "      if (lp && !lp.mogrt && lp.id === look.presetId) applyTemplate(lp, { silent: true });",
    repl: "      if (lp && false) applyTemplate(lp, { silent: true });",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "a reload shows the boot default style's settings under the picked style's name"
  },
  {
    name: "opt-save-kwcaps",
    file: "CutPilot/js/main.js",
    find: "    'c-emoji', 'c-kwcaps', 'c-sync'];",
    repl: "    'c-emoji', 'c-sync'];",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "🔠 CAPS on key words is lost when Premiere reopens"
  },
  {
    name: "opt-greyed-dead-click",
    file: "CutPilot/js/main.js",
    find: "    var canFix = dis && !!fix;",
    repl: "    var canFix = false;",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "a greyed control whose reason one tap could meet is a dead click again"
  },
  {
    name: "opt-outline-swatch",
    file: "CutPilot/js/main.js",
    find: "    if ($('sw-stroke')) $('sw-stroke').style.display = '';",
    repl: "    if ($('sw-stroke')) $('sw-stroke').style.display = (parseInt($('c-strokew').value, 10) || 0) > 0 ? '' : 'none';",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "the Outline colour vanishes on every style with no outline"
  },
  {
    name: "opt-editable-radius",
    file: "CutPilot/js/main.js",
    find: "    if (ov.boxRadius != null && ov.boxRadius !== (preset.boxRadius != null ? preset.boxRadius : 12)) eff.boxRadius = ov.boxRadius;\n",
    repl: "",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "Box roundness shows in ✏️ Editable but never reaches the caption"
  },
  {
    name: "opt-editable-case",
    file: "CutPilot/js/main.js",
    find: "    var caseMode = caps ? 'upper' : editorTextCase();",
    repl: "    var caseMode = caps ? 'upper' : (state.mogrtCase || 'as-spoken');",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "✏️ Editable captions take their text case from the 📁 Upload view again"
  },
  {
    name: "opt-lib-sort-pulse-only",
    file: "CutPilot/index.html",
    find: "<select id=\"lib-sort\" aria-label=\"Sort styles\">",
    repl: "<select id=\"lib-sort\" class=\"png-only\" aria-label=\"Sort styles\">",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "gallery sort disappears in ✏️ Editable"
  },
  {
    name: "opt-browse-hint",
    file: "CutPilot/js/main.js",
    find: "use a Pulse style instead (🎨 Styles, at the top of Captions).';",
    repl: "use a Pulse style instead (≡ Browse styles).';",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "a hint sends the owner to a button that is never shown"
  },
  {
    name: "opt-sync-nudge-pulse-only",
    file: "CutPilot/index.html",
    find: "<div class=\"wc-bar sync-nudge\" id=\"sync-nudge\">",
    repl: "<div class=\"wc-bar sync-nudge png-only\" id=\"sync-nudge\">",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "the highlight-timing nudge hides in ✏️ Editable"
  },
  {
    name: "opt-auto-tooltip",
    file: "CutPilot/js/main.js",
    find: "    var wcTip = (w === 0) ? 'Auto: whole phrases, fitted to your video'",
    repl: "    var wcTip = (w === 0) ? 'Whole sentences'",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "the Words per caption stepper no longer says what Auto does"
  },
  // review round: one fix per tap, a truthful hidden count, the nudge and the
  // Auto label on the ⚡ Premium sheet
  {
    name: "optfix-one-fix-per-tap",
    file: "CutPilot/js/main.js",
    find: "      if (!sameTap && _whyFix[id]) {",
    repl: "      if (_whyFix[id]) {",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "one tap on Two-colour highlight runs every fix in a row and swaps the style's Pill for Colour"
  },
  {
    name: "optfix-keep-under-finger",
    file: "CutPilot/js/main.js",
    find: "        if (ran && y0 != null) _keepUnderFinger(host, _whyTop(id) - y0);",
    repl: "        if (false) _keepUnderFinger(host, _whyTop(id) - y0);",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "a tap's fix opens rows above the control and the rest of the tap lands on whatever slid under the finger"
  },
  {
    name: "optfix-hidden-count-truth",
    file: "CutPilot/js/main.js",
    find: "      if (!_shownOncePulse(el, root)) continue;\n",
    repl: "",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "✏️ Editable promises more hidden settings than switching back brings"
  },
  {
    name: "optfix-premium-nudge-shown",
    file: "CutPilot/index.html",
    find: "<div class=\"wc-bar sync-nudge\" id=\"ms-sync-nudge\">",
    repl: "<div class=\"wc-bar sync-nudge hidden\" id=\"ms-sync-nudge\">",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "the ⚡ Premium sheet has no highlight-timing nudge"
  },
  {
    name: "optfix-premium-nudge-wired",
    file: "CutPilot/js/main.js",
    find: "    ['c', 'ms'].forEach(function (pre) {",
    repl: "    ['c'].forEach(function (pre) {",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "the ⚡ Premium sheet's timing buttons do nothing"
  },
  {
    name: "optfix-premium-auto-tip",
    file: "CutPilot/index.html",
    find: "id=\"ms-wc-full\" type=\"button\" title=\"Auto: whole phrases, fitted to your video\"",
    repl: "id=\"ms-wc-full\" type=\"button\" title=\"Whole sentences, sized to your video automatically\"",
    gate: "CutPilot/test/gates/captions-options-reachable.js",
    why: "✨ Auto on the ⚡ Premium sheet promises whole sentences again"
  },
  {
    name: 'tt-reflow-no-diff',
    file: 'CutPilot/js/main.js',
    find: '          if (nt[r] && nt[r] === ns[c2]) v = Math.max(v, D[r + 1][c2 + 1] + 1000',
    repl: '          if (false) v = Math.max(v, D[r + 1][c2 + 1] + 1000',
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: 'after ✨ Transcribe’s AI fix, lines whose edge splits a word are re-guessed and light up early'
  },
  {
    name: 'tt-fix1-guessed-timing',
    file: 'CutPilot/js/main.js',
    find: '    if (!(state.transcriptWords && state.transcriptWords.length)) fixOpts.wordCues = null;',
    repl: '    fixOpts.wordCues = null;',
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: '“Fix one caption” re-times its line with guesses instead of the real word stamps'
  },
  {
    name: 'tt-fix1-half-card',
    file: 'CutPilot/js/main.js',
    find: '    while (lo > 0 && sameCard(frames[lo - 1], frames[lo])) lo--;',
    repl: '',
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: '“Fix one caption” leaves half of a caption shared with the line before it un-drawn'
  },
  {
    name: 'tt-script-drops-timing',
    file: 'CutPilot/js/main.js',
    find: '            state.transcriptWords = rwS && rwS.length ? rwS : null;',
    repl: '            state.transcriptWords = null;',
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: '“✅ Script applied” throws the word timing away while saying it was kept'
  },
  {
    name: 'tt-sarvam-phrases',
    file: 'CutPilot/js/main.js',
    find: '        words = splitPhraseWords(words);',
    repl: '',
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: 'Indian Voices phrases are stored as one "word" each (11-18 word cards, shrunken text)'
  },
  {
    name: 'tt-sarvam-no-overlap',
    file: 'CutPilot/js/main.js',
    find: "    var OVER = (lang === 'translate-en') ? 0 : 1;",
    repl: '    var OVER = 0;',
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: 'Indian Voices pieces stop overlapping, so a word cut at the 28 s seam is lost or doubled'
  },
  {
    name: 'tt-groq-punctuation',
    file: 'CutPilot/js/main.js',
    find: '          if (wa.length) cues.words = punctuateWords(cues, wa);',
    repl: '          if (wa.length) cues.words = wa;',
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: 'Groq words lose the sentence punctuation, so captions lose "?" and "." and cannot end on a sentence'
  },
  {
    name: 'tt-groq-chunk-size',
    file: 'CutPilot/js/main.js',
    find: '    var chunks = Math.max(Math.ceil(size / limit), Math.ceil(durSec / Math.max(30, maxDur)), 1);',
    repl: '    var chunks = Math.max(Math.ceil(size / limit), 1);',
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: 'Groq pieces are sized from the 24 kbps file, so the 64 kbps re-encode goes over the upload limit'
  },
  {
    name: 'tt-groq-seams',
    file: 'CutPilot/js/main.js',
    find: '        var lo = idx ? startT + OVER / 2 : -Infinity, hi = (idx + 1 < chunks) ? startT + chunkDur + OVER / 2 : Infinity;',
    repl: '        var lo = -Infinity, hi = Infinity;',
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: 'overlapping Groq pieces both keep the words they share, doubling text at every seam'
  },
  {
    name: 'tt-hinglish-window',
    file: 'CutPilot/js/main.js',
    find: '      if (best >= 0) out[best].push(w);',
    repl: '      for (var jj = 0; jj < lines.length; jj++) if (+w.start >= lines[jj].start - 0.05 && +w.start < lines[jj].end + 0.05) out[jj].push(w);',
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: 'Hinglish lines rebuilt with an overlap window repeat or drop the word where two lines meet'
  },
  // (tt-short-words retired in v0.10.10: keeping 0-50 ms words is decided by
  // the caption core's mediaToTimeline since v0.10.9 — placeWordStamps' split
  // no longer changes the outcome; capcore-short-words breaks the real rule)
  {
    name: 'tt-panel-exact',
    file: 'CutPilot/js/main.js',
    find: "        if (single || overwriteOnTrack || placeArgs.replaceTrack) placeArgs.exact = true;",
    repl: "        if (single) placeArgs.exact = true;",
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: 'a range restyle or “Apply to all” places stills at their default length over the next captions'
  },
  {
    name: 'tt-host-exact-on-busy-track',
    file: 'CutPilot/jsx/host.jsx',
    find: '    try { if (track.clips.numItems > 0) exact = true; } catch (eNi) {}',
    repl: '',
    gate: 'CutPilot/test/host-tests.js',
    why: 'a range restyle without the exact flag covers the captions after it and trims the wrong clip'
  },
  {
    name: 'tt-dedupe-short-line',
    file: 'CutPilot/js/captions.js',
    find: '        var reach = shortLine ? -0.05 : margin;          // short line: must truly overlap',
    repl: '        var reach = margin;',
    gate: 'CutPilot/test/gates/captions-transcript-text.js',
    why: 'a short line said twice ("Haan." "Haan.") is merged into one'
  },
  {
    name: 'tt-deepgram-fillers',
    file: 'CutPilot/js/main.js',
    find: "    return _curlJson(['-sS', '--max-time', '900', CPVerbatim.deepgramUrl(opts),",
    repl: "    return _curlJson(['-sS', '--max-time', '900', CPVerbatim.deepgramUrl(opts).replace('filler_words=true', 'filler_words=false'),",
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: 'transcribing with Deepgram drops "um"/"uh" from the transcript, so Clean up\'s filler removal and the retake finder find nothing'
  },
  {
    name: 'tt-hindi-syllables',
    file: 'CutPilot/js/align.js',
    find: "    if (/[\\u0900-\\u097F]/.test(String(word == null ? '' : word))) return devanagariSyllables(word);",
    repl: '',
    gate: 'CutPilot/test/gates/captions-transcript-text.js',
    why: 'every Hindi word counts one syllable, so long and short words get the same highlight time'
  },
  {
    name: 'tt-reflow-borrows-next-line',
    file: 'CutPilot/js/main.js',
    find: '      if (w1 < N && owner[w1] > i && i + 1 < L) {',
    repl: '      w1 = Math.min(N, w1 + 5); if (false) {',
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: 'after a fix, a corrected word takes the next line\'s time ("accha" lights 1.6 s late) and the untouched next line is squeezed'
  },
  {
    name: 'tt-seam-merges-repeats',
    file: 'CutPilot/js/main.js',
    find: '(+w.start < +p.end - 0.02 || Math.abs(+w.start - +p.start) < 0.03)) return;',
    repl: '(+w.start < +p.end - 0.02 || Math.abs(+w.start - +p.start) < 0.15)) return;',
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: 'a quick real repeat ("no no no") near a seam of a long recording loses a word'
  },
  {
    name: 'tt-captions-show-um',
    file: 'CutPilot/js/main.js',
    find: '  function isHesitation(t) { return HESITATIONS.hasOwnProperty(_reflowNorm(t)); }',
    repl: '  function isHesitation(t) { return false; }',
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: 'captions made from a Deepgram transcript show "um" and "uh"'
  },
  {
    name: 'v10-prev-settled-poster',
    file: 'tools/real-mogrt-previews.js',
    find: "  let posterAt = mid / 10, poster = 'frame', noVideo = null, stillPath = null;",
    repl: "  let posterAt = 0.3, poster = 'frame', noVideo = null, stillPath = null;",
    gate: 'CutPilot/test/gates/gallery-real-previews.js',
    why: 'a Premium card shows its template mid-animation ("FluxVor t") instead of the settled words'
  },
  {
    name: 'v10-prev-blob-clip',
    file: 'tools/real-mogrt-previews.js',
    find: '    if (si > 0 && settledInk > si * 2.5) {',
    repl: '    if (false) {',
    gate: 'CutPilot/test/gates/gallery-real-previews.js',
    why: 'Orbit and Vector cards play their blob clip and show the blob as their still'
  },
  {
    name: 'v10-prev-tiny-crop',
    file: 'tools/real-mogrt-previews.js',
    find: '  let W = Math.min(FW, Math.max(w / 0.8, (h / 0.5) * 2, OUT_W / 3));',
    repl: '  let W = Math.min(FW, Math.max(w * 1.3 + 24, (h * 1.6 + 24) * 2, 320));',
    gate: 'CutPilot/test/gates/gallery-real-previews.js',
    why: 'Halo and Prism cards are a tiny box in a big black card again'
  },
  {
    name: 'v10-card-hover-clip',
    file: 'CutPilot/js/main.js',
    find: '    if (showReal && isMogrt && t.flux && t.thumb && t.video && !userPrev) {',
    repl: '    if (false) {',
    gate: 'CutPilot/test/gates/gallery-premium-cards.js',
    why: 'Premium cards play their loop all the time and are caught mid-animation'
  },
  {
    name: 'v10-edit-words-hidden',
    file: 'CutPilot/js/main.js',
    find: "    if ($('btn-cap-words')) $('btn-cap-words').classList.toggle('hidden', !has || placed);",
    repl: "    if ($('btn-cap-words')) $('btn-cap-words').classList.toggle('hidden', true);",
    gate: 'CutPilot/test/gates/captions-edit-words.js',
    why: 'no way to fix the words from the Captions page before making captions'
  },
  {
    name: 'v10-prem-real-face',
    file: 'CutPilot/js/main.js',
    find: '    var real = premRealEm(s, ps);',
    repl: '    var real = 0;',
    gate: 'CutPilot/test/gates/captions-any-font-fits.js',
    why: 'a Premium caption in a face wider than the table runs off both sides'
  },
  {
    name: 'v10-aifix-always',
    file: 'CutPilot/js/main.js',
    find: '  function aiFixWanted() { return settings.trAiFix !== false; }',
    repl: '  function aiFixWanted() { return true; }',
    gate: 'CutPilot/test/gates/captions-transcript-timing.js',
    why: 'switching off “Fix misheard words with AI” still rewrites the words'
  },
  {
    name: 'v10-hindi-first-face',
    file: 'CutPilot/js/main.js',
    find: "    if (preset && preset.script) devaStyle = preset.script === 'deva';",
    repl: '',
    gate: 'CutPilot/test/gates/fonts-coverage.js',
    why: 'Hindi-first styles swap to a Latin face (Avenir Next) when the style audit draws them'
  },
  {
    name: 'v11-shorts-no-tighten',
    file: 'CutPilot/js/shorts.js',
    find: '      if (gap > maxGap) {',
    repl: '      if (false) {',
    gate: 'CutPilot/test/gates/shorts-finished.js',
    why: 'a short keeps every pause (the 1.4 s gap stays in)'
  },
  {
    name: 'v11-shorts-no-trim',
    file: 'CutPilot/js/shorts.js',
    find: '    while (b - a > keep && has(LEAD_IN, w[a].text)) a++;',
    repl: '',
    gate: 'CutPilot/test/gates/shorts-finished.js',
    why: 'a short starts on "So… accha…" instead of its hook'
  },
  {
    name: 'v11-shorts-no-hook-card',
    file: 'CutPilot/js/main.js',
    find: '      if (hookTitle) { try { hookPng = writeHookCard(hookTitle, target.w, target.h, dir); } catch (eH) { hookPng = null; } }',
    repl: '',
    gate: 'CutPilot/test/gates/shorts-finished.js',
    why: 'the hook title never shows on the short'
  },
  {
    name: 'v11-shorts-no-captions',
    file: 'CutPilot/js/main.js',
    find: '      if (o.caps && plan.words.length && res && res.sequence) {',
    repl: '      if (false) {',
    gate: 'CutPilot/test/gates/shorts-finished.js',
    why: 'the short comes out without captions'
  },
  {
    name: 'v11-shorts-need-key',
    file: 'CutPilot/js/main.js',
    find: "      var hl = (typeof CPShorts !== 'undefined') ? CPShorts.localHighlights(segs, { min: len.min, max: len.max, count: 8 }) : [];",
    repl: '      var hl = [];',
    gate: 'CutPilot/test/gates/shorts-finished.js',
    why: 'without an AI key no moments are found'
  },
  // (v12-* retired in v0.10.13: the movement/skin guesser they broke is gone —
  // shorts are framed on faces or on the boxes the owner marks)
  {
    name: 'v13-face-not-framed',
    file: 'CutPilot/js/podshort.js',
    find: '    var x = Math.max(0, Math.min(src.w - cw, cx - cw / 2));\n    var y = Math.max(0, Math.min(src.h - ch, cy - ch * 0.36));',
    repl: '    var x = (src.w - cw) / 2;\n    var y = Math.max(0, Math.min(src.h - ch, cy - ch * 0.36));',
    gate: 'CutPilot/test/gates/shorts-podcast-cameras.js',
    why: 'the vertical window sits in the middle of the frame, not on the face'
  },
  {
    name: 'v13-no-voice-match',
    file: 'CutPilot/js/podshort.js',
    find: "      if (p.r < 0.05) return;            // no tie between this mic and anyone's movement",
    repl: '      return;',
    gate: 'CutPilot/test/gates/shorts-podcast-cameras.js',
    why: 'the wide shot never learns which face is which mic, so it never zooms on the talker'
  },
  {
    name: 'v13-mouth-sampled-only',
    file: 'CutPilot/js/main.js',
    find: "              var fr = both[0], mo = { motion: both[1] };",
    repl: "              var fr = both[0], mo = { motion: null };",
    gate: 'CutPilot/test/gates/shorts-podcast-cameras.js',
    why: 'mouth movement read from 2 sampled frames a second misses a mouth that moves between them'
  },
  {
    name: 'v13-caption-is-camera',
    file: 'CutPilot/js/main.js',
    find: '      return x && x.mediaPath && !x.disabled && SHORT_VIDEO_EXT.test(x.mediaPath) && !SHORT_NOT_CAMERA.test(x.mediaPath) &&',
    repl: '      return x && x.mediaPath && !x.disabled && SHORT_VIDEO_EXT.test(x.mediaPath) &&',
    gate: 'CutPilot/test/gates/shorts-podcast-cameras.js',
    why: 'a caption overlay track is taken for a second camera (the owner\'s "from 2 cameras")'
  },
  {
    name: 'v13-ignore-plan',
    file: 'CutPilot/js/main.js',
    find: '      var pieces = CPPodShort.pieces(plan.segments, cplan, multi ? speech : null,',
    repl: '      var pieces = CPPodShort.pieces(plan.segments, [], multi ? speech : null,',
    gate: 'CutPilot/test/gates/shorts-podcast-cameras.js',
    why: 'the short stays on one camera instead of following the director'
  },
  {
    name: 'v13-no-stack',
    file: 'CutPilot/js/main.js',
    find: "        } else if (multi && who === 'both' && fr.byVoice.filter(function (x) { return x >= 0; }).length >= 2) {",
    repl: "        } else if (false) {",
    gate: 'CutPilot/test/gates/shorts-podcast-cameras.js',
    why: 'when both talk on the wide shot only one of them is shown'
  },
  {
    name: 'v13-camera-sound',
    file: 'CutPilot/js/main.js',
    find: '        audio.push({ input: inputOf(at.path, at.t), channel: m.channel, track: m.track });',
    repl: '',
    gate: 'CutPilot/test/gates/shorts-podcast-cameras.js',
    why: 'the short takes the camera\'s scratch sound instead of the mics'
  },
  {
    name: 'v13-one-camera-no-turns',
    file: 'CutPilot/js/main.js',
    find: '        if (fr0.faces.length > 1) {',
    repl: '        if (false) {',
    gate: 'CutPilot/test/gates/shorts-podcast-cameras.js',
    why: 'one camera with two people stays on one face while the other talks'
  },
  {
    name: 'v13-marks-ignored',
    file: 'CutPilot/js/main.js',
    find: '              var marks = shortMarksFor(at.path);',
    repl: '              var marks = [];',
    gate: 'CutPilot/test/gates/shorts-podcast-cameras.js',
    why: 'the people the owner marked are not used'
  },
  {
    name: 'v13-marks-not-saved',
    file: 'CutPilot/js/main.js',
    find: '    saveSettings();\n  }\n  function defaultMarks(n) {',
    repl: '  }\n  function defaultMarks(n) {',
    gate: 'CutPilot/test/gates/shorts-mark-people.js',
    why: 'the marked people are forgotten when Pulse restarts'
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
