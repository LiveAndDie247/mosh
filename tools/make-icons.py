# Draws the MOSH icon (a glitched "M": red/cyan split, displaced bands) as PNGs,
# with nothing but the standard library. Run: python3 -I tools/make-icons.py
import os, struct, zlib, random

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

M = [  # 7x7 bitmap "M"
    "1.....1",
    "11...11",
    "1.1.1.1",
    "1..1..1",
    "1.....1",
    "1.....1",
    "1.....1",
]

def render(size, pad):
    rng = random.Random(7)
    img = [[(0, 0, 0)] * size for _ in range(size)]
    inner = size - 2 * pad
    cell = inner / 7.0
    def put(x, y, c):
        if 0 <= x < size and 0 <= y < size:
            r, g, b = img[y][x]
            img[y][x] = (max(r, c[0]), max(g, c[1]), max(b, c[2]))
    off = max(1, size // 64)
    for gy, row in enumerate(M):
        for gx, ch in enumerate(row):
            if ch != "1":
                continue
            x0, y0 = int(pad + gx * cell), int(pad + gy * cell)
            x1, y1 = int(pad + (gx + 1) * cell), int(pad + (gy + 1) * cell)
            for y in range(y0, y1):
                for x in range(x0, x1):
                    put(x - off, y, (255, 42, 60))   # red, left
                    put(x + off, y, (25, 240, 255))  # cyan, right
    # displace a few horizontal bands
    for _ in range(5):
        y0 = rng.randrange(pad, size - pad)
        h = rng.randrange(max(2, size // 60), max(3, size // 18))
        dx = rng.randrange(-size // 12, size // 12)
        for y in range(y0, min(size, y0 + h)):
            row = img[y]
            img[y] = [row[(x - dx) % size] for x in range(size)]
    # scanlines
    for y in range(0, size, 3):
        img[y] = [(r * 3 // 4, g * 3 // 4, b * 3 // 4) for r, g, b in img[y]]
    return img

def png(path, img):
    h, w = len(img), len(img[0])
    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in img)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) \
        + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    print("wrote", os.path.relpath(path, ROOT), f"{w}x{h}")

png(os.path.join(ROOT, "icons", "icon-192.png"), render(192, 30))
png(os.path.join(ROOT, "icons", "icon-512.png"), render(512, 80))
png(os.path.join(ROOT, "icons", "icon-maskable-512.png"), render(512, 130))   # safe zone for masks
