# Pulse — Adobe-Compliant Build & Premiere Upgrade Plan

How to package Pulse so it installs cleanly and **keeps running without fail**, and what to
do as Adobe Premiere Pro updates (CEP → UXP).

---

## Part A — Build it the Adobe-compliant way

There are two install paths. We ship both; understanding the difference is the key to "no doubt."

| Path | What it is | Adobe stance | When |
|---|---|---|---|
| **Signed `.zxp`** | The extension signed into Adobe's official package format with `ZXPSignCmd`, installed by a ZXP installer (Anastasiy's / ZXPInstaller) or via Creative Cloud. | **This is the compliant distribution format.** | Public / customer distribution. |
| **Unsigned folder + `PlayerDebugMode`** | Copy the extension into the CEP `extensions` folder and flip the debug flag so Premiere loads unsigned panels. | Developer/sideload only — *not* for production. | Your own machine, quick testing. |

We already have the full official signing kit in `CutPilot-zxp-kit/`:
`ZXPSignCmd` **v3.0.30** and **v4.1.1** (mac + win), a `cert.p12`, and `sign-mac/win` scripts.

### The one change that makes a signed build "run without fail": **timestamp the signature**

A ZXP signed **without a timestamp stops loading when the signing certificate expires** —
the panel silently disappears from `Window → Extensions` months later. This is the single
most common cause of "it worked, then one day it didn't." **Adobe's own guidance is to sign
with a timestamp authority (`-tsa`)**, which makes the signature valid permanently regardless
of cert expiry.

✅ **Fixed in this repo:** the signing scripts now pass `-tsa https://timestamp.digicert.com`
(see `tools/make-zxp-kit.js`). Re-run `node tools/make-zxp-kit.js` to regenerate the kit.

```
ZXPSignCmd -sign CutPilot CutPilot.zxp cert.p12 <pass> -tsa https://timestamp.digicert.com
```

### Manifest compliance checklist (`CSXS/manifest.xml`)
- `RequiredRuntime CSXS 9.0` ✓ (CEP 9+ = Premiere 2018+; fine).
- `Host PPRO [14.0,99.9]` ✓ — covers Premiere 2020 → future. (Open-ended upper bound is allowed; we keep it wide so a new Premiere release doesn't lock the panel out.)
- `--enable-nodejs --mixed-context` ✓ (needed for `fs`/`ffmpeg`).
- Bundle ID `com.cutpilot.*` stable across versions ✓ (don't change it — it's the update key).

### For first-class "Adobe blessed" distribution (optional, later)
- **Adobe Exchange / Creative Cloud Marketplace** listing → users install in one click and get auto-updates. Requires submitting the signed ZXP for Adobe review and a real (non-self-signed) code-signing certificate. This is the gold standard for "put it directly so it works without doubt," but it's a review process, not a same-day step.
- Until then, a **timestamped self-signed ZXP** + the ZXP installer is the reliable path.

---

## Part B — Premiere updates: should you upgrade, and the process so it keeps working

### The big picture: CEP is being replaced by UXP
Pulse is a **CEP** panel (HTML + ExtendScript). Adobe has begun moving Premiere to **UXP**
(the same modern extension platform Photoshop/InDesign already use) and is **sunsetting
ExtendScript/CEP**. This is the one change that can eventually break the panel — so it must be
planned for, not reacted to.

- **Today (Premiere 2020 – 2025, v14–v25):** CEP panels load and run. **Stay on CEP.** It has the broadest version coverage and everything Pulse needs.
- **Direction of travel:** newer Premiere builds add UXP; ExtendScript host automation (`host.jsx`) is the part most at risk over time. The UXP caption-write API was still "under construction" in late-2025 builds, which is *another* reason the **libass burn-in plan is strategically right** — burning pixels via bundled `ffmpeg` does **not** depend on ExtendScript or UXP host APIs, so it survives the CEP→UXP transition far better than the MOGRT/`importMGT` path.

### Should you upgrade Premiere?
- **For developing/testing Pulse:** keep **two** Premiere versions installed:
  1. An **older LTS-ish build (e.g. 2022/2023)** = your compatibility floor.
  2. The **latest** = your early-warning for what Adobe changes next.
- **Don't force end-users to upgrade.** The panel should run on whatever supported Premiere they have (2020+). Upgrading Premiere is only *required* if a user is below v14 or if we later ship a UXP build.

### The "keep running without fail" process (repeat each Premiere release, ~quarterly)
1. **Install the new Premiere**, open Pulse, run the smoke test (below). Premiere updates occasionally reset `PlayerDebugMode` or change CEP — re-running the installer fixes it.
2. **Smoke test (10 min):** panel loads → transcribe a 30 s clip → add captions (burned-in) → add a MOGRT caption → preview animates → export shows captions. If all pass, that Premiere version is certified.
3. **If the panel won't load after a Premiere update:**
   - Re-run the installer (re-sets `PlayerDebugMode` / re-copies the folder).
   - Confirm the ZXP signature isn't expired (→ timestamping in Part A removes this forever).
   - Check `Host PPRO` upper bound in the manifest (we keep it at `99.9`, so this won't bite).
4. **Watch for the UXP cutover.** When a Premiere release drops CEP support (Adobe will announce a window), ship the **UXP migration** (Part C). The libass/ffmpeg engine ports as-is; only the thin host layer is rewritten.
5. **Pin the bundled `ffmpeg`** to a known full-GPL `--enable-libass` build and re-verify it on each Premiere/OS bump (one startup check — see the caption-engine plan).

---

## Part C — UXP migration (the future-proofing, when CEP sunsets)

Not needed today; this is the contingency so there's "no doubt" long-term.

- **What ports unchanged:** the entire caption *engine* — transcription, grouping, the `.ass` generator, the `ffmpeg` burn. It's Node + a binary, not CEP-specific.
- **What gets rewritten:** the host bridge (`jsx/host.jsx`, `lib/cep-bridge.js`) → UXP's `premierepro` module + UXP panel APIs. This is the smallest, most isolated part of the app **specifically because** the recommended architecture pushes rendering into ffmpeg instead of ExtendScript/MOGRT.
- **Migration trigger:** the first Premiere release that drops CEP, or when the UXP `premierepro` API covers sequence read + clip placement (track it release-by-release).
- **Keep one codebase:** isolate all host calls behind the existing `CPBridge` so a UXP backend can be swapped in without touching the UI or engine.

---

## One-paragraph answer to "should I upgrade?"

Keep shipping on **CEP** today — it runs on Premiere 2020 through 2025 and needs no user
upgrades. **Sign the ZXP with a timestamp** (done) so it never expires. Test Pulse against each
new Premiere release with the 10-minute smoke test and keep the manifest's host range open.
Adobe will eventually retire CEP for **UXP**; we're ready for that because the new caption
engine burns captions with bundled `ffmpeg` (no ExtendScript dependency), so only a thin host
layer needs porting when that day comes — the product keeps running through the transition.
