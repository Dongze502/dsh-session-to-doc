"""Trim the uniform white border headless Edge leaves around screenshots."""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageChops

PAD = 0
WHITE = (255, 255, 255)


def crop(path: Path) -> None:
    image = Image.open(path).convert("RGB")
    background = Image.new("RGB", image.size, WHITE)
    diff = ImageChops.difference(image, background)
    box = diff.getbbox()
    if box is None:
        print(f"{path.name}: nothing to crop")
        return
    left, top, right, bottom = box
    if PAD:
        left, top = max(0, left - PAD), max(0, top - PAD)
        right = min(image.width, right + PAD)
        bottom = min(image.height, bottom + PAD)
    if (left, top, right, bottom) == (0, 0, image.width, image.height):
        print(f"{path.name}: already tight")
        return
    image.crop((left, top, right, bottom)).save(path, "PNG", optimize=True)
    print(f"{path.name}: cropped to {right - left}x{bottom - top}")


def main() -> int:
    for arg in sys.argv[1:]:
        crop(Path(arg))
    return 0


if __name__ == "__main__":
    sys.exit(main())
