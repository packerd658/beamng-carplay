"""Generates the app.png icon for the BeamPlay BeamNG UI app.

Run once with `python3 generate_icon.py` (requires Pillow). The resulting
app.png is a static asset checked into the repo, so this script does not
need to run again unless the icon design changes.
"""
from PIL import Image, ImageDraw

SIZE = 256
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded-square app-icon background, matching the in-app tile gradient.
pad = 6
draw.rounded_rectangle(
    [pad, pad, SIZE - pad, SIZE - pad],
    radius=56,
    fill=(23, 33, 48, 255),
    outline=(255, 255, 255, 40),
    width=2,
)

top = (47, 111, 237, 255)
bottom = (16, 26, 40, 255)
for y in range(pad, SIZE - pad):
    t = (y - pad) / (SIZE - 2 * pad)
    r = int(top[0] * (1 - t) + bottom[0] * t)
    g = int(top[1] * (1 - t) + bottom[1] * t)
    b = int(top[2] * (1 - t) + bottom[2] * t)
    draw.line([(pad, y), (SIZE - pad, y)], fill=(r, g, b, 255))

mask = Image.new("L", (SIZE, SIZE), 0)
mdraw = ImageDraw.Draw(mask)
mdraw.rounded_rectangle([pad, pad, SIZE - pad, SIZE - pad], radius=56, fill=255)

bg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
bg.paste(img, (0, 0), mask)
img = bg
draw = ImageDraw.Draw(img)

# Stylised speedometer needle + dashboard glyph.
cx, cy = SIZE // 2, SIZE // 2 + 10
r_outer = 78
draw.arc([cx - r_outer, cy - r_outer, cx + r_outer, cy + r_outer], 200, 340, fill=(255, 255, 255, 210), width=10)

import math
needle_angle_deg = 250
angle = math.radians(needle_angle_deg)
nx = cx + math.cos(angle) * (r_outer - 12)
ny = cy + math.sin(angle) * (r_outer - 12)
draw.line([(cx, cy), (nx, ny)], fill=(255, 255, 255, 255), width=8)
draw.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=(255, 255, 255, 255))

# Small "play" triangle bottom-right to nod at the CarPlay/media angle.
tri = [(178, 190), (178, 224), (206, 207)]
draw.polygon(tri, fill=(51, 224, 122, 255))

img.save("ui/modules/apps/BeamPlay/app.png")
print("wrote ui/modules/apps/BeamPlay/app.png")
