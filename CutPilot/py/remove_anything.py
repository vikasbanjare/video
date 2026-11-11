"""
Pulse — Remove anything: keep one person or object from ANY footage, no green screen.

  python remove_anything.py --input clip.mp4 --out_dir out --points "540,900;600,1300" [--frame 0]

1. SAM 2.1 (Meta, Apache-2.0) follows what was clicked through the clip.
2. ViTMatte (MIT) turns its hard outline into a soft matte on a thin band
   around the edge — hair, motion blur — the inside stays solid.
3. The edge colour is cleaned of the old background (blur-fusion foreground
   estimate), so the person doesn't carry a halo onto a new background.
Writes alpha_%05d.png and fg_%05d.png (straight colour) at the clip's size.
Progress lines: "PROGRESS <stage> <done>/<total>".
"""
import argparse, os, sys, glob, subprocess

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
import numpy as np
import torch
import cv2

ap = argparse.ArgumentParser()
ap.add_argument("--input", required=True)
ap.add_argument("--out_dir", required=True)
ap.add_argument("--points", required=True, help='"x,y;x,y" in the clip\'s pixels (keep); prefix "-" to exclude: "-x,y"')
ap.add_argument("--max_frames", type=int, default=0, help="1 = a preview of the first frame only")
ap.add_argument("--segment", type=int, default=300, help="frames SAM holds at once (memory); each segment starts from the last mask")
ap.add_argument("--ffmpeg", default="ffmpeg")
ap.add_argument("--models", default=os.path.expanduser("~/.cutpilot/matte"))
ap.add_argument("--band", type=int, default=0, help="edge band in px (0 = auto from size)")
a = ap.parse_args()

dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
os.makedirs(a.out_dir, exist_ok=True)
frames_dir = os.path.join(a.out_dir, "frames")
os.makedirs(frames_dir, exist_ok=True)
cmd = [a.ffmpeg, "-v", "error", "-y", "-i", a.input, "-q:v", "2"]
if a.max_frames:
    cmd += ["-frames:v", str(a.max_frames)]
subprocess.run(cmd + [os.path.join(frames_dir, "%05d.jpg")], check=True)
names = sorted(glob.glob(os.path.join(frames_dir, "*.jpg")))
N = len(names)
H, W = cv2.imread(names[0]).shape[:2]
print(f"PROGRESS frames {N}/{N}  {W}x{H} on {dev}", flush=True)

# ---- 1. SAM 2.1: the clicked thing, every frame -----------------------------
from sam2.build_sam import build_sam2_video_predictor
pred = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_b+.yaml",
                                  os.path.join(a.models, "sam2.1_hiera_base_plus.pt"), device=dev)
pts, labels = [], []
for p in a.points.split(";"):
    p = p.strip()
    if not p:
        continue
    neg = p.startswith("-")
    x, y = (float(v) for v in p.lstrip("-").split(","))
    pts.append([x, y]); labels.append(0 if neg else 1)
masks = [None] * N
# segments of a.segment frames (SAM keeps every frame of a segment in memory);
# the first starts from the clicks on frame 1, each next one from the last mask
seg_dir = os.path.join(a.out_dir, "seg")
with torch.inference_mode():
    s0 = 0
    while s0 < N:
        s1 = min(N, s0 + a.segment)
        if os.path.isdir(seg_dir):
            for f in os.listdir(seg_dir):
                os.remove(os.path.join(seg_dir, f))
        else:
            os.makedirs(seg_dir)
        for j, nm in enumerate(names[s0:s1]):
            os.symlink(nm, os.path.join(seg_dir, f"{j:05d}.jpg"))
        st = pred.init_state(seg_dir, offload_video_to_cpu=True, offload_state_to_cpu=True)
        if s0 == 0:
            pred.add_new_points_or_box(st, frame_idx=0, obj_id=1, points=np.array(pts, np.float32), labels=np.array(labels, np.int32))
        else:
            pred.add_new_mask(st, frame_idx=0, obj_id=1, mask=masks[s0])
        for fi, _, logits in pred.propagate_in_video(st, start_frame_idx=0):
            masks[s0 + fi] = (logits[0, 0] > 0).cpu().numpy()
            print(f"PROGRESS track {s0 + fi + 1}/{N}", flush=True)
        pred.reset_state(st)
        if s1 >= N:
            break
        s0 = s1 - 1          # one frame of overlap: the next segment starts from this mask
del pred
if dev == "mps":
    torch.mps.empty_cache()

# ---- 2. ViTMatte: soft edges on a band around the outline -------------------
from transformers import VitMatteImageProcessor, VitMatteForImageMatting
proc = VitMatteImageProcessor.from_pretrained("hustvl/vitmatte-small-composition-1k", cache_dir=os.path.join(a.models, "hf"))
vm = VitMatteForImageMatting.from_pretrained("hustvl/vitmatte-small-composition-1k", cache_dir=os.path.join(a.models, "hf")).to(dev).eval()
band = a.band or max(6, round(min(W, H) / 70))        # ~15 px at 1080 wide: room for hair and blur
k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * band + 1, 2 * band + 1))
S = min(1.0, 1100.0 / max(W, H))                     # ViTMatte works on a ≤1100 px copy; inside/outside stay exact


def blur_fusion(img, alpha, r=45):
    """Foreground colour without the old background mixed in (Forte 2021, blur-fusion)."""
    a3 = alpha[..., None]
    def bl(x): return cv2.blur(x, (r, r))
    ba = bl(alpha)[..., None]
    bf = bl(img * a3) / (ba + 1e-5)
    bb = bl(img * (1 - a3)) / (bl(1 - alpha)[..., None] + 1e-5)
    f = bf + a3 * (img - a3 * bf - (1 - a3) * bb)
    return np.clip(f, 0, 1)


for i, (name, m) in enumerate(zip(names, masks)):
    img = cv2.cvtColor(cv2.imread(name), cv2.COLOR_BGR2RGB)
    if m is None or not m.any():
        alpha = np.zeros((H, W), np.float32)
    else:
        # small gaps enclosed by the subject (SAM's own hole-filling needs its
        # CUDA extension) are UNDECIDED, not filled: the edge model looks at
        # each pixel — a gap in the curls closes, lamp light seen through the
        # hair stays out (filling them blindly kept a patch of lamp)
        inv = (~m).astype(np.uint8)
        n, lab, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
        filled = m.copy()
        for c in range(1, n):
            x, y, w, h, area = stats[c]
            if area < 0.004 * W * H and x > 0 and y > 0 and x + w < W and y + h < H:
                filled[lab == c] = True
        fg_in = cv2.erode(m.astype(np.uint8) * 255, k)
        bg_out = cv2.dilate(filled.astype(np.uint8) * 255, k)
        tri = np.where(fg_in > 0, 255, np.where(bg_out > 0, 128, 0)).astype(np.uint8)
        ys, xs = np.where(tri == 128)
        alpha = (tri == 255).astype(np.float32)
        if len(ys):
            pad = band * 2
            y0, y1 = max(0, ys.min() - pad), min(H, ys.max() + pad + 1)
            x0, x1 = max(0, xs.min() - pad), min(W, xs.max() + pad + 1)
            crop, tc = img[y0:y1, x0:x1], tri[y0:y1, x0:x1]
            cw, ch = max(32, int((x1 - x0) * S)), max(32, int((y1 - y0) * S))
            cs = cv2.resize(crop, (cw, ch), interpolation=cv2.INTER_AREA)
            ts = cv2.resize(tc, (cw, ch), interpolation=cv2.INTER_NEAREST)
            with torch.inference_mode():
                inp = proc(images=cs, trimaps=ts, return_tensors="pt").to(dev)
                am = vm(**inp).alphas[0, 0].float().cpu().numpy()[:ch, :cw]
            am = cv2.resize(am, (x1 - x0, y1 - y0), interpolation=cv2.INTER_LINEAR)
            sub = alpha[y0:y1, x0:x1]
            unk = tc == 128
            sub[unk] = np.clip(am[unk], 0, 1)
    fg = blur_fusion(img.astype(np.float32) / 255, alpha)
    cv2.imwrite(os.path.join(a.out_dir, f"alpha_{i + 1:05d}.png"), (alpha * 255).astype(np.uint8))
    cv2.imwrite(os.path.join(a.out_dir, f"fg_{i + 1:05d}.png"), cv2.cvtColor((fg * 255).astype(np.uint8), cv2.COLOR_RGB2BGR))
    print(f"PROGRESS edges {i + 1}/{N}", flush=True)
print("DONE", N, flush=True)
