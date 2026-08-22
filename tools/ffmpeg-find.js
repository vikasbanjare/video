/* Shared ffmpeg discovery.
 *
 * Why this file exists: thumb-scan and overlay-render-check each grew their
 * own finder, and they disagreed — the overlay gate located a working ffmpeg
 * while thumb-scan reported "no ffmpeg" and SKIPPED all 14 animated .mp4
 * previews on the same machine. A gate that skips is a gate that is not
 * guarding anything, and those mp4s are exactly what the style gallery plays.
 * One finder, one answer.
 *
 * opts.libass = true  -> only accept a build whose filter list has `subtitles`
 *                        (burning captions needs libass; most distro builds
 *                        have it, the Playwright-bundled one does not).
 */
const fs = require('fs');
const cp = require('child_process');

function candidates() {
  const out = [];
  if (process.env.CP_FFMPEG) out.push(process.env.CP_FFMPEG);
  // pip's imageio-ffmpeg ships a full build (H.264 decode + libass) and is the
  // easiest thing to install in a container that has no apt.
  try {
    const py = cp.execSync(
      'python3 -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())" 2>/dev/null',
      { encoding: 'utf8' }).trim();
    if (py) out.push(py);
  } catch (e) {}
  out.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg',
           '/opt/pw-browsers/ffmpeg-linux');
  return out;
}

function usable(bin, needLibass) {
  try {
    const v = cp.execSync(JSON.stringify(bin) + ' -hide_banner -version 2>&1',
      { encoding: 'utf8', maxBuffer: 1 << 22 });
    if (!/ffmpeg version/i.test(v)) return false;
  } catch (e) { return false; }
  if (!needLibass) return true;
  try {
    const f = cp.execSync(JSON.stringify(bin) + ' -hide_banner -filters 2>&1',
      { encoding: 'utf8', maxBuffer: 1 << 24 });
    return /\bsubtitles\b/.test(f);
  } catch (e) { return false; }
}

function findFfmpeg(opts) {
  const needLibass = !!(opts && opts.libass);
  for (const c of candidates()) {
    if (!c) continue;
    let path = c;
    if (!/[\\/]/.test(c)) {                       // bare name -> resolve on PATH
      try { path = cp.execSync('command -v ' + c + ' 2>/dev/null', { encoding: 'utf8' }).trim(); }
      catch (e) { continue; }
    }
    if (!path || !fs.existsSync(path)) continue;
    if (usable(path, needLibass)) return path;
  }
  // last resort: whatever PATH gives us
  try {
    const p = cp.execSync('command -v ffmpeg 2>/dev/null', { encoding: 'utf8' }).trim();
    if (p && usable(p, needLibass)) return p;
  } catch (e) {}
  return null;
}

module.exports = { findFfmpeg };
