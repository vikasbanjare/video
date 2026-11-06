# Discovered gates

Every `*.js` file in this folder is run by `test/run-tests.js` as its own gate.

- exit **0** — pass
- exit **2** — skipped: a tool it needs is missing (`node tools/doctor.js` says which). Counted and named in the summary banner; a skipped gate guards nothing.
- any other exit — **FAIL**

Add a gate by adding a file here. Do not edit `run-tests.js` to register it — that is what lets independent changes land without colliding on the same lines.

A gate must be able to fail: before relying on one, break the thing it guards on purpose and confirm it exits non-zero, then restore.

Panel hooks for a gate belong in `window.CP_DEBUG_EXT.<area>` (defined next to the code they expose in `js/main.js`), not in the shared `window.CP_DEBUG` block.
