#!/usr/bin/env python3
"""
Pulse — style-variant .mogrt generator (build-time tool).

Derives REAL, standalone .mogrt templates from a proven base template by
mutating ONLY the authored defaults in definition.json:
  - new capsuleID + capsuleName        (a distinct template identity)
  - new default `value`s on named controls (colours / opacities / scale)

The project.aegraphic (the After Effects payload) is copied BYTE-IDENTICAL and
every control keeps its GUID `id` — verified requirement: those GUIDs appear
inside the .aep and bind definition controls to composition properties.
capsuleID does NOT appear in the .aep (verified), so re-identifying is safe.

Each generated file inserts 1:1 like any authored template — no runtime
"style translation" layer at all. That mapping layer is exactly where every
caption-fidelity bug lived; these variants make it unnecessary.

Usage:  python3 tools/make_style_mogrts.py            # writes CutPilot/mogrts/Style_*.mogrt
        (then add matching entries to CutPilot/mogrts/index.json)
"""
import json, re, shutil, sys, uuid, zipfile, hashlib, os

ROOT = os.path.join(os.path.dirname(__file__), '..', 'CutPilot')
BASE = os.path.join(ROOT, 'mogrts', 'Subtitle_1.mogrt')
OUT_DIR = os.path.join(ROOT, 'mogrts')

# ── pilot styles (colours mirror the gallery styles they replace) ───────────
def hex_rgba(h):
    h = h.lstrip('#')
    return [round(int(h[i:i+2], 16) / 255, 6) for i in (0, 2, 4)] + [1]

PILOTS = [
    {
        'file': 'Style_BoldPop.mogrt', 'name': 'Bold Pop (Pilot)',
        'desc': 'White text, yellow spoken-word highlight, black bar — authored defaults, no translation layer',
        'set': {
            'Highlighted Word Color': hex_rgba('#FFD400'),
            'Text Color': hex_rgba('#FFFFFF'),
            'BG Color': hex_rgba('#0B0D11'),
            'BG Opacity': 85,
            'Shadow Opacity': 0,
            'Text Opacity': 100,
        },
    },
    {
        'file': 'Style_SubsLight.mogrt', 'name': 'Subs Light (Pilot)',
        'desc': 'Dark text on a white bar, blue spoken word',
        'set': {
            'Highlighted Word Color': hex_rgba('#2D7CFF'),
            'Text Color': hex_rgba('#15181E'),
            'BG Color': hex_rgba('#F1F2F4'),
            'BG Opacity': 100,
            'Shadow Opacity': 0,
            'Text Opacity': 100,
        },
    },
    {
        'file': 'Style_KaraokeBar.mogrt', 'name': 'Karaoke Bar (Pilot)',
        'desc': 'White text on a dark bar, green spoken word',
        'set': {
            'Highlighted Word Color': hex_rgba('#3DDC84'),
            'Text Color': hex_rgba('#FFFFFF'),
            'BG Color': hex_rgba('#0C0D11'),
            'BG Opacity': 90,
            'Shadow Opacity': 0,
            'Text Opacity': 100,
        },
    },
]

def ui_name(c):
    try:
        return c['uiName']['strDB'][0]['str']
    except Exception:
        return ''

def load_mogrt(path):
    z = zipfile.ZipFile(path)
    files = {n: z.read(n) for n in z.namelist()}
    z.close()
    return files

def write_mogrt(path, files):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, blob in files.items():
            z.writestr(name, blob)

def make_variant(base_files, spec):
    d = json.loads(base_files['definition.json'].decode('utf-8'))
    d['capsuleID'] = str(uuid.uuid4())
    d['capsuleName'] = spec['name']
    if isinstance(d.get('capsuleNameLocalized'), dict):
        for loc in d['capsuleNameLocalized']:
            d['capsuleNameLocalized'][loc] = spec['name']
    applied = set()
    for c in d.get('clientControls', []):
        n = ui_name(c)
        if n in spec['set']:
            c['value'] = spec['set'][n]
            applied.add(n)
    missing = set(spec['set']) - applied
    if missing:
        raise SystemExit('MISSING controls in base for %s: %s' % (spec['name'], sorted(missing)))
    out = dict(base_files)
    out['definition.json'] = json.dumps(d, separators=(',', ':')).encode('utf-8')
    return out, d

def validate(base_files, var_path, spec):
    base_d = json.loads(base_files['definition.json'].decode('utf-8'))
    v_files = load_mogrt(var_path)
    v_d = json.loads(v_files['definition.json'].decode('utf-8'))
    a = base_d['clientControls']; b = v_d['clientControls']
    assert len(a) == len(b), 'control count changed'
    diffs = []
    by_name = {}
    for ca, cb in zip(a, b):
        assert ca.get('id') == cb.get('id'), 'control GUID changed!'
        assert ca.get('type') == cb.get('type'), 'control type changed!'
        by_name[ui_name(ca)] = (ca.get('value'), cb.get('value'))
        if json.dumps(ca.get('value')) != json.dumps(cb.get('value')):
            diffs.append(ui_name(ca))
    # every diff must be intended; an intended value that produced NO diff must
    # mean the base already shipped that exact default
    assert set(diffs) <= set(spec['set']), 'unexpected value diffs: %s' % diffs
    for name in set(spec['set']) - set(diffs):
        assert json.dumps(by_name[name][1]) == json.dumps(spec['set'][name]) or by_name[name][0] == spec['set'][name], \
            'spec value for %r neither applied nor already default' % name
    assert v_d['capsuleID'] != base_d['capsuleID'], 'capsuleID not re-identified'
    h1 = hashlib.sha256(base_files['project.aegraphic']).hexdigest()
    h2 = hashlib.sha256(v_files['project.aegraphic']).hexdigest()
    assert h1 == h2, 'aegraphic changed — must be byte-identical'
    return diffs

def main():
    base_files = load_mogrt(BASE)
    print('base:', BASE, '(%d entries)' % len(base_files))
    for spec in PILOTS:
        out_path = os.path.join(OUT_DIR, spec['file'])
        files, d = make_variant(base_files, spec)
        write_mogrt(out_path, files)
        diffs = validate(base_files, out_path, spec)
        print('OK  %-24s capsuleID=%s  changed=%s' % (spec['file'], d['capsuleID'][:8], sorted(diffs)))
    print('done — %d pilot templates' % len(PILOTS))

if __name__ == '__main__':
    main()
