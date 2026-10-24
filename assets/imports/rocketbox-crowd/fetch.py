"""Download the pinned Microsoft Rocketbox (MIT) inputs for the pedestrian crowd.
Usage: python3 fetch.py OUTPUT_DIRECTORY
For each character in crowd.json: its FBX, the textures the FBX names (read from the file), and
the idle/walk/run clips for its gender. Writes OUTPUT_DIRECTORY/source-manifest.json with a
SHA-256 for every input. Python 3 standard library only.
"""
from pathlib import Path
import hashlib, json, re, sys, urllib.request

HERE = Path(__file__).parent
spec = json.loads((HERE / 'crowd.json').read_text())
commit = spec['commit']
base = f'https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/{commit}/'
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
records = []

def get(path: str, dest: Path) -> bytes:
    if dest.exists():
        data = dest.read_bytes()
    else:
        data = urllib.request.urlopen(base + path, timeout=120).read()
        dest.write_bytes(data)
    records.append({'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    return data

for clip in sorted({c for g in spec['clips'].values() for c in g.values()}):
    get('Assets/Animations/' + clip, out / Path(clip).name)
for ch in spec['characters']:
    folder = f"Assets/Avatars/{ch['group']}/{ch['name']}"
    (out / ch['name']).mkdir(exist_ok=True)
    fbx = get(f"{folder}/Export/{ch['name']}.fbx", out / ch['name'] / f"{ch['name']}.fbx")
    names = sorted({m.decode() for m in re.findall(rb'([A-Za-z0-9_]+\.tga)', fbx)})
    if not names: raise SystemExit(f"no textures named in {ch['name']}.fbx")
    for name in names:
        get(f"{folder}/Textures/{name}", out / ch['name'] / name)
(out / 'source-manifest.json').write_text(json.dumps({'repository': 'https://github.com/microsoft/Microsoft-Rocketbox', 'commit': commit, 'files': records}, indent=2) + '\n')
print(f'{len(records)} files')
