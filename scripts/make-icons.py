"""Render the Orrery mark to PNG app icons. No dependencies beyond zlib.

Usage: python3 scripts/make-icons.py frontend/public

Matches favicon.svg: a raspberry core, two tilted orbits, three planets.
"""
import math
import struct
import sys
import zlib
from pathlib import Path

out = Path(sys.argv[1])
VOID = (4, 2, 10)
PLANETS = [((54, 24), 3.6, (0x38, 0xBD, 0xF8)), ((17.5, 38), 2.8, (0xFB, 0xBF, 0x24)), ((11, 45), 2.2, (0xC0, 0x84, 0xFC))]
TILT = math.radians(-20)


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


def ellipse_distance(x, y, rx, ry):
    # Rotate into the ellipse's frame, then an approximate distance to its outline.
    dx, dy = x - 32, y - 32
    ex = dx * math.cos(-TILT) - dy * math.sin(-TILT)
    ey = dx * math.sin(-TILT) + dy * math.cos(-TILT)
    k = math.hypot(ex / rx, ey / ry)
    return abs(k - 1) * min(rx, ry)


def pixel(x, y, px):
    col = VOID
    for rx, ry, a in ((25, 10, 0.3), (16, 6.5, 0.22)):
        d = ellipse_distance(x, y, rx, ry)
        col = mix(col, (255, 255, 255), a * max(0.0, 1 - d / (0.7 + px)))
    r = math.hypot(x - 32, y - 32)
    glow = max(0.0, 1 - r / 13)
    core = mix((0xFF, 0x2A, 0x6D), (0xFF, 0x8F, 0xB4), min(1, max(0, 1 - r / 7)))
    core = mix(core, (255, 255, 255), max(0.0, 1 - r / 3.2))
    col = mix(col, core, min(1.0, glow * 1.6))
    for (cx, cy), rad, c in PLANETS:
        d = math.hypot(x - cx, y - cy) - rad
        col = mix(col, c, min(1.0, max(0.0, 0.5 - d / px)))
    return col


def render(size, inset):
    # inset shrinks the mark for maskable icons, whose safe zone is the middle 80%.
    rows = []
    for py in range(size):
        row = bytearray([0])
        for qx in range(size):
            px = 64 / size / inset
            x = ((qx + 0.5) / size - 0.5) * 64 / inset + 32
            y = ((py + 0.5) / size - 0.5) * 64 / inset + 32
            row += bytes(int(max(0, min(255, round(v)))) for v in pixel(x, y, px))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


for name, size, inset in (("icon-192.png", 192, 1), ("icon-512.png", 512, 1), ("maskable-512.png", 512, 0.75), ("apple-touch-icon.png", 180, 0.9)):
    (out / name).write_bytes(render(size, inset))
    print("wrote", out / name)
