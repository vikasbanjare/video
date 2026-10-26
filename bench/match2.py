# match2.py orig.raw edit.raw out.json — map an edit onto the original by the SHAPE of
# the sound (log-mel spectrogram, each band normalised), robust to cleanup/EQ/levels.
# Monotonic DTW-like walk: an edit keeps the original's order.
import sys, json
import numpy as np

SR, HOP, NFFT, NM = 16000, 160, 512, 40          # 100 feature frames a second
def feats(x):
    x = x.astype(np.float32) / 32768
    n = 1 + (len(x) - NFFT) // HOP
    fr = np.lib.stride_tricks.as_strided(x, (n, NFFT), (x.strides[0] * HOP, x.strides[0])) * np.hanning(NFFT)
    P = np.abs(np.fft.rfft(fr, axis=1)) ** 2
    f = np.linspace(0, SR / 2, P.shape[1]); mel = 2595 * np.log10(1 + f / 700)
    edges = np.linspace(mel[1], mel[-1], NM + 2); fb = np.zeros((NM, len(f)))
    for i in range(NM):
        l, c, r = edges[i:i + 3]
        fb[i] = np.clip(np.minimum((mel - l) / (c - l), (r - mel) / (r - c)), 0, None)
    M = np.log(P @ fb.T + 1e-7)
    loud = M.max(1)
    M = M - M.mean(0)                              # per band: EQ / level differences cancel
    M = M - M.mean(1, keepdims=True)
    return M, loud

if __name__ == '__main__':
    o, lo = feats(np.fromfile(sys.argv[1], np.int16))
    e, le = feats(np.fromfile(sys.argv[2], np.int16))
    W = 40                                             # 0.4 s windows
    def norm_rows(X):
        return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
    def wins(X):
        n = len(X) - W + 1
        V = np.lib.stride_tricks.sliding_window_view(X, (W, X.shape[1]))[:, 0].reshape(n, -1)
        return norm_rows(V - V.mean(1, keepdims=True))
    Vo, Ve = wins(o), wins(e)
    speech_o = np.convolve(lo > np.percentile(lo, 40), np.ones(W), 'valid') / W
    speech_e = np.convolve(le > np.percentile(le, 40), np.ones(W), 'valid') / W
    rows, floor = [], 0
    for p in range(0, len(Ve), 5):                     # every 50 ms of the edit
        if speech_e[p] < 0.5:
            continue
        sims = Vo[floor:] @ Ve[p]
        sims[speech_o[floor:] < 0.3] = -1
        k = int(np.argmax(sims)); sc = float(sims[k])
        if sc > 0.75:
            pos = floor + k
            rows.append((p / 100, pos / 100, sc))
            floor = max(0, pos - 50)                   # keep order, allow 0.5 s jitter back
    ranges = []
    for t, ot, sc in rows:
        off = ot - t
        if ranges and abs(off - ranges[-1]['off']) < 0.06 and t - ranges[-1]['e1'] < 2.0:
            r = ranges[-1]; r['e1'] = t + W / 100; r['o1'] = ot + W / 100; r['n'] += 1; r['off'] = off
        else:
            ranges.append({'off': off, 'e0': t, 'e1': t + W / 100, 'o0': ot, 'o1': ot + W / 100, 'n': 1})
    ranges = [r for r in ranges if r['n'] >= 3]
    json.dump(ranges, open(sys.argv[3], 'w'), indent=0)
    print(f'{len(rows)} windows matched, {len(ranges)} kept ranges, covering {sum(r["e1"]-r["e0"] for r in ranges):.1f}s of {len(e)/100:.1f}s edit')
