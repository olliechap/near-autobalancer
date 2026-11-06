# Draws the Ballast favicon (a 16x16 pixel lighthouse) and writes favicon.svg, favicon.ico, favicon-32.png
# and apple-touch-icon.png. Run from web/: python3 scripts/favicon.py .
import sys
import PIL.ImageDraw
from PIL import Image
G = """
.......rr.......
......rrrr......
ggg...yyyy...ggg
hhhhhhyyyyhhhhhh
ggg..rrrrrr..ggg
......wwww......
......wwww......
......rrrr......
......rrrr......
.....wwwwww.....
.....wwwwww.....
.....rrrrrr.....
....rrrrrrrr....
bbbbrrrrrrrrbbbb
bBbbbbbbbbbbbbBb
bbbbbBbbbbBbbbbb
""".split()
C = {".": "#1c1b19", "r": "#d03b3b", "w": "#f6f5f2", "y": "#ffd866", "h": "#e9b85a", "g": "#c98a2c", "b": "#2f5f9e", "B": "#6f9be0"}
assert len(G) == 16 and all(len(r) == 16 for r in G), [len(r) for r in G]
out = sys.argv[1]
# SVG: rounded ink tile with crisp pixels on top
rects = []
for y, row in enumerate(G):
    x = 0
    while x < 16:
        ch = row[x]; n = 1
        while x + n < 16 and row[x + n] == ch: n += 1
        if ch != ".": rects.append(f'<rect x="{x}" y="{y}" width="{n}" height="1" fill="{C[ch]}"/>')
        x += n
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">
<clipPath id="r"><rect width="16" height="16" rx="3"/></clipPath>
<g clip-path="url(#r)"><rect width="16" height="16" fill="{C['.']}"/>
{chr(10).join(rects)}
</g></svg>
'''
open(f"{out}/favicon.svg", "w").write(svg)
def img(rounded):
    im = Image.new("RGBA", (16, 16))
    for y, row in enumerate(G):
        for x, ch in enumerate(row):
            im.putpixel((x, y), tuple(int(C[ch][i:i+2], 16) for i in (1, 3, 5)) + (255,))
    if rounded:
        for (x, y) in [(0,0),(15,0),(0,15),(15,15)]: im.putpixel((x, y), (0,0,0,0))
    return im
small = img(True)
# one exact frame per size, so the small ones stay crisp instead of being downscaled
small.resize((48, 48), Image.NEAREST).save(f"{out}/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], bitmap_format="bmp",
                                          append_images=[small, small.resize((32, 32), Image.NEAREST)])
# apple touch: full bleed, pixel art centred with a margin
big = Image.new("RGBA", (180, 180), (0x1c, 0x1b, 0x19, 255))
art = img(False).resize((160, 160), Image.NEAREST)
big.paste(art, (10, 20))
# continue the sea to the bottom edge
big.paste(Image.new("RGBA", (180, 20), (0x2f, 0x5f, 0x9e, 255)), (0, 160))
big.paste(art.crop((0, 130, 160, 160)), (10, 150))
d = PIL.ImageDraw.Draw(big)
d.rectangle((0, 150, 9, 179), fill=(0x2f, 0x5f, 0x9e, 255)); d.rectangle((170, 150, 179, 179), fill=(0x2f, 0x5f, 0x9e, 255))
big.convert("RGB").save(f"{out}/apple-touch-icon.png")
