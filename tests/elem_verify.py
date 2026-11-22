# Pixel checks for element captures. Usage: python3 elem_verify.py <outDir>
import json, sys, colorsys
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
d = sys.argv[1]
f = json.load(open(f"{d}/elem.json"))
fails = 0
def ok(c, m):
    global fails
    print(("ok  " if c else "FAIL"), m); fails += (not c)
def exp(i):
    r, g, b = colorsys.hls_to_rgb(((i * 37) % 360) / 360, 0.6, 0.7); return tuple(round(v * 255) for v in (r, g, b))
close = lambda a, b, t=8: max(abs(x - y) for x, y in zip(a, b)) <= t
for name, n, bh in (("receipt", 9, 100), ("tall", 12, 1000)):
    im = Image.open(f[name]).convert("RGB"); W, H = im.size; k = H / (n * bh)
    wrong = [i for i in range(n) for fr in (0.03, 0.5, 0.97) for x in (2, W // 2, W - 3) if not close(im.getpixel((x, int((i + fr) * bh * k))), exp(i))]
    ok(not wrong, f"{name}: only the element, every band in place edge to edge (wrong bands: {sorted(set(wrong))})")
print("verify:", "all passed" if not fails else f"{fails} FAILED"); sys.exit(1 if fails else 0)
