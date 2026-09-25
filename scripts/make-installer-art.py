"""Installer sidebar (164x314) and header (150x57) BMPs in the Freesia 3 look."""
import pathlib
from PIL import Image, ImageDraw, ImageFilter, ImageFont

root = pathlib.Path(__file__).resolve().parent.parent
assets = root / 'assets'
fonts = root / 'src' / 'renderer' / 'fonts'
icon = Image.open(assets / 'icon.png').convert('RGBA')
tray = Image.open(assets / 'tray.png').convert('RGBA')


def graphite(w, h):
    img = Image.new('RGB', (w, h), (11, 11, 13))
    glow = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(glow)
    for i, a in enumerate(range(60, 0, -4)):
        r = int(w * 0.9) - i * 6
        d.ellipse((w // 2 - r, h // 3 - r, w // 2 + r, h // 3 + r), fill=(143, 107, 255, a // 6))
    glow = glow.filter(ImageFilter.GaussianBlur(24))
    img.paste(glow, (0, 0), glow)
    return img


side = graphite(164, 314)
logo = icon.resize((96, 96), Image.LANCZOS)
side.paste(logo, (34, 52), logo)
d = ImageDraw.Draw(side)
serif = ImageFont.truetype(str(fonts / 'InstrumentSerif-Regular.ttf'), 34)
italic = ImageFont.truetype(str(fonts / 'InstrumentSerif-Italic.ttf'), 17)
d.text((82, 170), 'Freesia', font=serif, fill=(237, 237, 241), anchor='mm')
d.text((82, 200), 'speak freely.', font=italic, fill=(182, 156, 255), anchor='mm')
side.save(assets / 'installer-sidebar.bmp')

head = Image.new('RGB', (150, 57), (251, 251, 249))
mark = tray.resize((40, 40), Image.LANCZOS)
head.paste(mark, (100, 8), mark)
head.save(assets / 'installer-header.bmp')
print('installer art written')
