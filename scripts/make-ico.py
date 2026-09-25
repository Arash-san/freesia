"""Builds assets/icon.ico (16-256 px) and the tray icon from assets/icon.png."""
import pathlib
from PIL import Image

assets = pathlib.Path(__file__).resolve().parent.parent / 'assets'
src = Image.open(assets / 'icon.png').convert('RGBA')
sizes = [256, 128, 64, 48, 32, 24, 16]
frames = [src.resize((s, s), Image.LANCZOS) for s in sizes]
frames[0].save(assets / 'icon.ico', sizes=[(s, s) for s in sizes], append_images=frames[1:])
src.resize((256, 256), Image.LANCZOS).save(assets / 'icon-256.png')
print('icon.ico written with sizes', sizes)
