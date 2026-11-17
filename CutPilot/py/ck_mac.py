"""
CorridorKey 2.0 on Apple Silicon — a launcher, not a fork.

Runs the official infer.py unchanged, with NVIDIA's CUDA calls mapped onto
Apple's GPU (PyTorch's "mps" backend) before CorridorKey loads. Corridor's
files are never edited, so their updates drop straight in.

Usage (same flags as infer.py):
  CK_HOME=~/.cutpilot/corridorkey venv/bin/python ck_mac.py --input clip.mp4 --output_dir out

CorridorKey is by Corridor Digital (https://github.com/nikopueringer/CorridorKey2.0).
This launcher builds on it, so it is shared under CorridorKey's own licence
(CC BY-NC-SA 4.0 with Corridor's additional terms) and must stay free of
charge; Pulse ships the Pro key only in free builds (tools/build-protected.js).
"""
import os
import runpy
import sys

# ops Apple's GPU lacks run on the CPU instead of failing
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import torch  # noqa: E402

if not torch.backends.mps.is_available():
    sys.exit("Apple GPU (MPS) is not available in this PyTorch.")

DEV = "mps"


def _mem_get_info(device=None):
    total = torch.mps.recommended_max_memory()
    return max(0, total - torch.mps.driver_allocated_memory()), total


# torch.cuda.* → Apple GPU
torch.cuda.is_available = lambda: True
torch.cuda.mem_get_info = _mem_get_info
torch.cuda.memory_reserved = lambda device=None: 0   # already counted in driver_allocated_memory
torch.cuda.empty_cache = torch.mps.empty_cache
torch.cuda.synchronize = lambda device=None: torch.mps.synchronize()
torch.cuda.manual_seed_all = lambda seed: torch.mps.manual_seed(seed)

# .cuda() on modules and tensors → .to("mps")
torch.nn.Module.cuda = lambda self, device=None: self.to(DEV)
torch.Tensor.cuda = lambda self, device=None, non_blocking=False, **k: self.to(DEV, non_blocking=non_blocking)


# CK_MPS_FP32=1: full precision (bfloat16 under autocast gave wrong colours
# and a glitch row on Apple's GPU)
_FP32 = os.environ.get("CK_MPS_FP32", "1") == "1"


class _Autocast(torch.autocast):
    def __init__(self, device_type, *a, **k):
        if _FP32:
            k["enabled"] = False
        super().__init__(DEV if device_type == "cuda" else device_type, *a, **k)


torch.autocast = _Autocast

# CPU→GPU copies must finish before use: CorridorKey's non_blocking=True
# copies (fine on NVIDIA) raced on Apple's GPU — 32+ frame runs came out NaN
# (black), and the same run with every step synchronised came out clean.
_to_orig = torch.Tensor.to


def _to_sync(self, *a, **k):
    k.pop("non_blocking", None)
    return _to_orig(self, *a, **k)


torch.Tensor.to = _to_sync
if _FP32:
    # CorridorKey's own bf16 casts (frames, hints, buffers) stay full precision
    _to = torch.Tensor.to   # (already the synced one)

    def _to_fp32(self, *a, **k):
        if k.get("dtype") is torch.bfloat16:
            k["dtype"] = torch.float32
        a = tuple(torch.float32 if x is torch.bfloat16 else x for x in a)
        return _to(self, *a, **k)

    torch.Tensor.to = _to_fp32
    _zeros = torch.zeros
    torch.zeros = lambda *a, **k: _zeros(*a, **dict(k, dtype=torch.float32) if k.get("dtype") is torch.bfloat16 else k)

# Apple's GPU can't do adaptive average pooling (F.interpolate mode="area")
# when the sizes don't divide evenly (pytorch#96056): that one op on the CPU.
import torch.nn.functional as F  # noqa: E402

_aap = F.adaptive_avg_pool2d


def _adaptive_avg_pool2d(x, output_size):
    if x.device.type == "mps":
        oh, ow = (output_size, output_size) if isinstance(output_size, int) else output_size
        h, w = x.shape[-2:]
        if (oh and h % oh) or (ow and w % ow):
            return _aap(x.cpu().float(), output_size).to(x.device, x.dtype)
    return _aap(x, output_size)


F.adaptive_avg_pool2d = _adaptive_avg_pool2d

# Apple's attention kernel returns NaN on very long sequences (normal mode
# blacked out every frame); split the queries — results are identical.
_sdpa = F.scaled_dot_product_attention
_Q = int(os.environ.get("CK_MPS_SDPA_CHUNK", "4096"))


def _sdpa_chunked(q, k, v, attn_mask=None, dropout_p=0.0, is_causal=False, **kw):
    if q.device.type != "mps" or q.shape[-2] <= _Q or is_causal:
        return _sdpa(q, k, v, attn_mask=attn_mask, dropout_p=dropout_p, is_causal=is_causal, **kw)
    outs = []
    for i in range(0, q.shape[-2], _Q):
        m = attn_mask[..., i:i + _Q, :] if attn_mask is not None and attn_mask.dim() >= 2 and attn_mask.shape[-2] == q.shape[-2] else attn_mask
        outs.append(_sdpa(q[..., i:i + _Q, :], k, v, attn_mask=m, dropout_p=dropout_p, **kw))
    return torch.cat(outs, dim=-2)


F.scaled_dot_product_attention = _sdpa_chunked
torch.nn.functional.scaled_dot_product_attention = _sdpa_chunked

# the one place a device is named: the model loads onto the Apple GPU
here = os.environ.get("CK_HOME") or os.path.expanduser("~/.cutpilot/corridorkey")
sys.path.insert(0, here)
import corridorkey.runtime as _rt  # noqa: E402

_load = _rt.load_model
_rt.load_model = lambda paths, device="cuda": _load(paths, device=DEV)

sys.argv[0] = os.path.join(here, "infer.py")
runpy.run_path(sys.argv[0], run_name="__main__")
