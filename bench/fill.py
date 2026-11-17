# fill.py orig.raw edit.raw ranges.json out.json — assign every frame of the edit
# between two matched pieces to one of them (whichever its sound fits), so the
# whole edit is accounted for. Output: kept ranges of the original, in order.
import sys, json
import numpy as np
from match2 import feats

o, _ = feats(np.fromfile(sys.argv[1], np.int16))
e, _ = feats(np.fromfile(sys.argv[2], np.int16))
R = json.load(open(sys.argv[3]))
on = o / (np.linalg.norm(o, axis=1, keepdims=True) + 1e-9)
en = e / (np.linalg.norm(e, axis=1, keepdims=True) + 1e-9)
offs = [int(round(r['off'] * 100)) for r in R]
assign = np.full(len(e), -1)
for i, r in enumerate(R):
    assign[int(r['e0'] * 100):int(r['e1'] * 100)] = i
SM = np.ones(15) / 15                          # 0.15 s smoothing of the per-frame fit
for i in range(len(R) + 1):
    a0 = int(R[i - 1]['e1'] * 100) if i > 0 else 0
    a1 = int(R[i]['e0'] * 100) if i < len(R) else len(e)
    if a1 <= a0:
        continue
    cands = [j for j in (i - 1, i) if 0 <= j < len(R)]
    fits = []
    for j in cands:
        idx = np.arange(a0, a1) + offs[j]
        ok = (idx >= 0) & (idx < len(o))
        f = np.full(a1 - a0, -1.0)
        f[ok] = (en[a0:a1][ok] * on[idx[ok]]).sum(1)
        fits.append(np.convolve(f, SM, 'same'))
    if len(cands) == 1:
        assign[a0:a1] = cands[0]
    else:
        # one cut in the gap: the best split point (left piece before it, right piece after)
        c0, c1 = np.cumsum(fits[0]), np.cumsum(fits[1][::-1])[::-1]
        score = [c0[k - 1] if k else 0 for k in range(a1 - a0 + 1)]
        score = [score[k] + (c1[k] if k < a1 - a0 else 0) for k in range(a1 - a0 + 1)]
        k = int(np.argmax(score))
        assign[a0:a0 + k] = cands[0]; assign[a0 + k:a1] = cands[1]
out = []
for i, r in enumerate(R):
    fr = np.where(assign == i)[0]
    if len(fr):
        out.append({'e0': fr[0] / 100, 'e1': (fr[-1] + 1) / 100, 'o0': (fr[0] + offs[i]) / 100, 'o1': (fr[-1] + 1 + offs[i]) / 100})
json.dump(out, open(sys.argv[4], 'w'), indent=0)
print(f'{len(out)} kept pieces, covering {sum(x["e1"]-x["e0"] for x in out):.1f}s of {len(e)/100:.1f}s')
