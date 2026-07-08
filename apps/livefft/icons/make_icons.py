#!/usr/bin/env python3
"""Generate PWA icons for the Live FFT app: a phosphor-teal spectrum trace
with a peak, on the app's dark panel colour. Run from this directory."""
from PIL import Image, ImageDraw
import math


def trace_y(t):
    """Spectrum-like shape: noise floor + one dominant peak + a smaller one."""
    y = 0.18
    for centre, width, height in [(0.38, 0.045, 0.62), (0.62, 0.03, 0.30)]:
        y += height * math.exp(-((t - centre) ** 2) / (2 * width**2))
    # gentle low-frequency rise
    y += 0.10 * math.exp(-t * 4)
    return y


def create_icon(size, filename, maskable=True):
    s = 4  # supersample
    n = size * s
    img = Image.new('RGB', (n, n), (13, 17, 25))
    d = ImageDraw.Draw(img)

    # subtle vertical gradient
    for y in range(n):
        f = y / n
        c = (
            int(13 + 6 * (1 - f)),
            int(17 + 8 * (1 - f)),
            int(25 + 14 * (1 - f)),
        )
        d.line([(0, y), (n, y)], fill=c)

    # padding: maskable icons need content in the inner 80%
    pad = 0.16 * n if maskable else 0.10 * n
    x0, x1 = pad, n - pad
    y0, y1 = pad, n - pad

    # faint grid
    grid = (34, 44, 66)
    for i in range(1, 4):
        gy = y0 + (y1 - y0) * i / 4
        d.line([(x0, gy), (x1, gy)], fill=grid, width=max(1, n // 256))
    for i in range(1, 4):
        gx = x0 + (x1 - x0) * i / 4
        d.line([(gx, y0), (gx, y1)], fill=grid, width=max(1, n // 256))

    # trace with glow: draw thick translucent-ish layers then core line
    pts = []
    for i in range(201):
        t = i / 200
        px = x0 + (x1 - x0) * t
        py = y1 - (y1 - y0) * trace_y(t)
        pts.append((px, py))

    for width_mul, colour in [(5.0, (18, 66, 62)), (2.6, (26, 122, 111)), (1.0, (63, 232, 210))]:
        d.line(pts, fill=colour, width=max(2, int(n * 0.018 * width_mul)), joint='curve')

    # peak marker dot (amber)
    peak_t = 0.38
    px = x0 + (x1 - x0) * peak_t
    py = y1 - (y1 - y0) * trace_y(peak_t)
    r = n * 0.022
    d.ellipse([px - r, py - r, px + r, py + r], fill=(255, 180, 84))

    img = img.resize((size, size), Image.LANCZOS)
    img.save(filename, 'PNG')
    print(f'{filename} ({size}x{size})')


if __name__ == '__main__':
    create_icon(192, 'icon-192.png')
    create_icon(512, 'icon-512.png')
    create_icon(180, 'apple-touch-icon.png', maskable=False)
