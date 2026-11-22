# Pixel checks for the synthetic captures. Usage: python3 shot_verify.py <outDir>
import json, sys, colorsys
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
d = sys.argv[1]
info = json.load(open(f"{d}/synth.json")); band = info["band"]; S = info["synth"]
fails = 0
def ok(cond, msg):
    global fails
    print(("ok  " if cond else "FAIL"), msg); fails += (not cond)
def exp(i):
    r, g, b = colorsys.hls_to_rgb(((i * 37) % 360) / 360, 0.6, 0.7); return tuple(round(v * 255) for v in (r, g, b))
close = lambda a, b, t=8: max(abs(x - y) for x, y in zip(a, b)) <= t
for name, n in (("bands", 40), ("inner", 20)):
    s = S[name]; im = Image.open(s["file"]).convert("RGB"); W, H = im.size; k = H / (n * band)
    ok(abs(H - n * band * k) < 2 and abs(k - W / s["cssW"]) < 0.01 if name == "bands" else abs(H / k - n * band) < 2, f"{name}: full height {H} px = {n} bands at {k:g}x")
    wrong = [i for i in range(n) for f in (0.02, 0.5, 0.98) if not close(im.getpixel((W // 2, int((i + f) * band * k))), exp(i))]
    ok(not wrong, f"{name}: every band in the right place, incl. at slice seams (wrong: {sorted(set(wrong))[:10]})")
s = S["fixed"]; im = Image.open(s["file"]).convert("RGB"); W, H = im.size; k = W / s["cssW"]
blue = lambda y: close(im.getpixel((W // 2, int(y * k))), (0, 0, 255), 20)
ok(blue(40), "fixed: header at the top")
later = [y for y in range(1000, 30000, 500) if blue(y + 40)]
ok(not later, f"fixed: header not repeated further down (found at css y {later[:5]})")
s = S["lazy"]; im = Image.open(s["file"]).convert("RGB"); W, H = im.size; k = W / s["cssW"]
ok(close(im.getpixel((int(500 * k), int(9300 * k))), (255, 0, 0), 20), "lazy: image at the bottom loaded and captured")
print("verify:", "all passed" if not fails else f"{fails} FAILED"); sys.exit(1 if fails else 0)
