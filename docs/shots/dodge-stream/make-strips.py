"""Frame strips from tests/e2e/dodge-stream.capture.ts output: one PNG per car speed, frames left
to right, top to bottom, each labelled with its tick offset and the person's dodge phase and hop
from the sim trace. Usage: python3 make-strips.py SHOTS_DIR OUT_DIR [LABEL]"""
import json, os, sys
from PIL import Image, ImageDraw

shots, out = sys.argv[1], sys.argv[2]
label = sys.argv[3] if len(sys.argv) > 3 else ''
os.makedirs(out, exist_ok=True)
for name in sorted(f for f in os.listdir(shots) if f.endswith('.json') and f[0].isdigit()):
    speed = name[:-5]
    meta = json.load(open(os.path.join(shots, name)))
    frames = sorted(f for f in os.listdir(shots) if f.startswith(speed + '-') and f.endswith('.png'))
    ims = [Image.open(os.path.join(shots, f)).convert('RGB') for f in frames]
    w, h = ims[0].size
    cols = 10
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new('RGB', (w * cols, h * rows + 22), 'black')
    d = ImageDraw.Draw(sheet)
    d.text((6, 4), f'{label} car at {speed} m/s, a frame every {meta["everyTicks"]} ticks ({meta["everyTicks"] / 60:.3f} s); camera {meta.get("camera") and "follows the person from the side"}', fill='white')
    for k, im in enumerate(ims):
        t = im.copy()
        dt = ImageDraw.Draw(t)
        rows_k = meta['trace'][k * meta['everyTicks']:(k + 1) * meta['everyTicks']]
        r = rows_k[0] if rows_k else None
        text = f"+{k * meta['everyTicks']}t " + (f"{r['phase']}{' LEAP' if r['leap'] else ''} hop {r['hop']:.2f} m" if r and r['phase'] else 'walking')
        dt.rectangle([0, 0, w, 16], fill='black')
        dt.text((4, 2), text, fill='white')
        sheet.paste(t, ((k % cols) * w, 22 + (k // cols) * h))
    sheet = sheet.resize((sheet.width // 2, sheet.height // 2))
    sheet.save(os.path.join(out, f'strip-{speed}.png'))
    print(os.path.join(out, f'strip-{speed}.png'), sheet.size)
