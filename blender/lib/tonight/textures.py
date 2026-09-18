"""Procedural textures, written as PNG from pure Python.

Same rule as the meshes: art is *generated*, not sourced
([ADR-0004](../../../docs/adr/0004-procedural-art-pipeline.md)). A texture that
came from a download would be an opaque binary in the repository, un-reviewable
and un-parameterisable -- the exact thing that ADR rejects for models, and no
less true for images.

That also makes them diffable the way meshes are: a texture has a content hash in
the manifest, so a change to a generator shows up as a changed hash rather than
as a binary blob nobody can read.

Deliberately ``bpy``-free, and deliberately dependency-free: PNG is a container
around zlib, and ``zlib`` plus ``struct`` are in the standard library. Adding
Pillow to write a handful of stylised tiles would put a C extension in the
dependency chain of a test suite whose whole point is that it runs anywhere.

Everything here is **stylised and low-frequency** on purpose (pillar 3, readable
over realistic). These are flat colour, banding and blocking -- the kind of
surface detail that reads at gameplay distance -- not photographic material.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass
from pathlib import Path

from tonight import units
from tonight.rng import seeded

#: Tile size. Big enough that plank seams and mortar lines are not chunky at
#: arm's length, small enough that all of them together stay well under a
#: megabyte and CI does not spend its time compressing pixels.
TEXTURE_SIZE = 256

Rgb = tuple[int, int, int]


def _clamp_byte(value: float) -> int:
    return 0 if value < 0 else (255 if value > 255 else int(value))


@dataclass
class Texture:
    """An RGB pixel buffer, addressed with the origin at the top-left."""

    width: int
    height: int
    pixels: bytearray

    @classmethod
    def filled(cls, colour: Rgb, size: int = TEXTURE_SIZE) -> "Texture":
        return cls(size, size, bytearray(bytes(colour) * (size * size)))

    def set(self, x: int, y: int, colour: Rgb) -> None:
        if not (0 <= x < self.width and 0 <= y < self.height):
            return
        offset = (y * self.width + x) * 3
        self.pixels[offset : offset + 3] = bytes(colour)

    def get(self, x: int, y: int) -> Rgb:
        offset = ((y % self.height) * self.width + (x % self.width)) * 3
        return (self.pixels[offset], self.pixels[offset + 1], self.pixels[offset + 2])

    def shade(self, x: int, y: int, amount: float) -> None:
        """Multiply one pixel's brightness. Cheap way to add grain and edges."""
        r, g, b = self.get(x, y)
        self.set(x, y, (_clamp_byte(r * amount), _clamp_byte(g * amount), _clamp_byte(b * amount)))

    def rect(self, x0: int, y0: int, x1: int, y1: int, colour: Rgb) -> None:
        for y in range(max(0, y0), min(self.height, y1)):
            for x in range(max(0, x0), min(self.width, x1)):
                self.set(x, y, colour)

    def content_hash(self) -> str:
        """Stable hash of the pixels, for the manifest."""
        import hashlib

        return hashlib.sha256(bytes(self.pixels)).hexdigest()[:16]

    # ------------------------------------------------------------------ png

    def to_png(self) -> bytes:
        """Encode as an 8-bit RGB PNG.

        Filter type 0 (None) on every scanline. A real encoder would try the
        adaptive filters for a smaller file, but these are flat, blocky images
        where filtering buys little, and a filter bug would be a silent
        corruption rather than a loud failure.
        """

        def chunk(kind: bytes, payload: bytes) -> bytes:
            return (
                struct.pack(">I", len(payload))
                + kind
                + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
            )

        raw = bytearray()
        stride = self.width * 3
        for y in range(self.height):
            raw.append(0)  # filter: None
            raw.extend(self.pixels[y * stride : (y + 1) * stride])

        header = struct.pack(">IIBBBBB", self.width, self.height, 8, 2, 0, 0, 0)
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b"")
        )

    def write(self, destination: Path) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(self.to_png())
        return destination


# ---------------------------------------------------------------------------
# Generators
#
# Each takes a name and returns a tileable Texture. Tileable matters: build
# pieces repeat one texture across a 4 m face, and a seam down the middle of
# every wall is the first thing anyone would notice.
# ---------------------------------------------------------------------------


def _grain(texture: Texture, rng, amount: float, density: float = 1.0) -> None:
    """Per-pixel brightness noise. The cheapest way to stop a flat fill reading as plastic."""
    for y in range(texture.height):
        for x in range(texture.width):
            if density < 1.0 and rng.random() > density:
                continue
            texture.shade(x, y, 1.0 + rng.uniform(-amount, amount))


def planks(name: str, base: Rgb, seam: Rgb, count: int = 4) -> Texture:
    """Horizontal boards with darker seams and lengthwise grain."""
    rng = seeded(f"texture:{name}")
    texture = Texture.filled(base)
    size = texture.height
    board_height = size // count

    for index in range(count):
        top = index * board_height
        # Each board gets its own tone, so a wall does not read as one slab.
        tone = rng.uniform(0.88, 1.12)
        for y in range(top, min(size, top + board_height)):
            for x in range(size):
                texture.shade(x, y, tone)

        # Lengthwise grain: long, low-contrast streaks along the board.
        for _ in range(board_height // 2):
            gy = rng.randrange(top, min(size, top + board_height))
            streak = rng.uniform(0.9, 1.08)
            run = rng.randrange(size // 4, size)
            start = rng.randrange(0, size)
            for step in range(run):
                texture.shade((start + step) % size, gy, streak)

        # The seam, drawn on the board's top edge so the tile wraps cleanly.
        for x in range(size):
            texture.set(x, top % size, seam)
            texture.shade(x, (top + 1) % size, 0.82)

    _grain(texture, rng, 0.05)
    return texture


def blocks(name: str, base: Rgb, mortar: Rgb, rows: int = 4) -> Texture:
    """Offset masonry: staggered blocks with mortar lines."""
    rng = seeded(f"texture:{name}")
    texture = Texture.filled(mortar)
    size = texture.height
    row_height = size // rows
    gap = max(2, size // 96)

    for row in range(rows):
        top = row * row_height
        # Every other row is offset by half a block, which is what makes it
        # read as masonry rather than as a grid.
        offset = (row % 2) * (size // (rows * 2))
        columns = rows
        block_width = size // columns

        for column in range(columns + 1):
            left = column * block_width - offset
            tone = rng.uniform(0.82, 1.18)
            shaded = tuple(_clamp_byte(c * tone) for c in base)

            for y in range(top + gap, top + row_height):
                for x in range(left + gap, left + block_width):
                    texture.set(x % size, y % size, shaded)  # type: ignore[arg-type]

    _grain(texture, rng, 0.09)
    return texture


def panelled(name: str, base: Rgb, rivet: Rgb, panels: int = 2) -> Texture:
    """Sheet metal: large panels, a brushed streak, rivets at the corners."""
    rng = seeded(f"texture:{name}")
    texture = Texture.filled(base)
    size = texture.height
    panel = size // panels

    # Brushed streaks run in one direction only; crossing them reads as cloth.
    for _ in range(size * 2):
        y = rng.randrange(size)
        texture.shade(rng.randrange(size), y, rng.uniform(0.94, 1.06))
    # The streak period must divide the tile, or the pattern cannot wrap and
    # every metal wall gets a band across it where the tile repeats. The texture
    # size is a power of two, so the period is one too.
    STREAK_PERIOD = 8
    assert size % STREAK_PERIOD == 0
    for y in range(size):
        streak = 1.0 + 0.04 * ((y * 3) % STREAK_PERIOD - STREAK_PERIOD / 2) / (STREAK_PERIOD / 2)
        for x in range(size):
            texture.shade(x, y, streak)

    for row in range(panels):
        for column in range(panels):
            top, left = row * panel, column * panel
            # Panel edges: a light top-left and a dark bottom-right reads as a
            # raised plate under any light direction.
            for i in range(panel):
                texture.shade((left + i) % size, top % size, 1.18)
                texture.shade(left % size, (top + i) % size, 1.18)
                texture.shade((left + i) % size, (top + panel - 1) % size, 0.8)
                texture.shade((left + panel - 1) % size, (top + i) % size, 0.8)

            for dy, dx in ((6, 6), (6, panel - 7), (panel - 7, 6), (panel - 7, panel - 7)):
                for oy in range(-1, 2):
                    for ox in range(-1, 2):
                        texture.set((left + dx + ox) % size, (top + dy + oy) % size, rivet)

    _grain(texture, rng, 0.03)
    return texture


def bark(name: str, base: Rgb) -> Texture:
    """Vertical striations, for tree trunks."""
    rng = seeded(f"texture:{name}")
    texture = Texture.filled(base)
    size = texture.height

    for _ in range(size // 2):
        x = rng.randrange(size)
        width = rng.randrange(1, 4)
        tone = rng.uniform(0.7, 1.25)
        # Full-height ridges keep the tile seamless top to bottom.
        for y in range(size):
            wobble = int(3 * ((y / size) * 6 % 2 - 1))
            for step in range(width):
                texture.shade((x + step + wobble) % size, y, tone)

    _grain(texture, rng, 0.07)
    return texture


def foliage(name: str, base: Rgb, highlight: Rgb) -> Texture:
    """Clustered leaf blobs, for canopies."""
    rng = seeded(f"texture:{name}")
    texture = Texture.filled(base)
    size = texture.height

    for _ in range(size // 3):
        cx, cy = rng.randrange(size), rng.randrange(size)
        radius = rng.randrange(3, 9)
        lit = rng.random() < 0.4
        tone = rng.uniform(0.75, 1.0)
        for dy in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                if dx * dx + dy * dy > radius * radius:
                    continue
                if lit:
                    texture.set((cx + dx) % size, (cy + dy) % size, highlight)
                else:
                    texture.shade((cx + dx) % size, (cy + dy) % size, tone)

    _grain(texture, rng, 0.08)
    return texture


def cloth(name: str, base: Rgb) -> Texture:
    """A woven weave, for the character's clothed parts."""
    rng = seeded(f"texture:{name}")
    texture = Texture.filled(base)
    size = texture.height

    for y in range(size):
        for x in range(size):
            # A two-pixel checker reads as weave at close range and as flat
            # colour further out, which is exactly the falloff we want.
            if ((x // 2) + (y // 2)) % 2 == 0:
                texture.shade(x, y, 1.06)
            else:
                texture.shade(x, y, 0.94)

    _grain(texture, rng, 0.04)
    return texture


def speckle(name: str, base: Rgb, fleck: Rgb) -> Texture:
    """Mottled mineral surface, for rock and the ground."""
    rng = seeded(f"texture:{name}")
    texture = Texture.filled(base)
    size = texture.height

    for _ in range(size * 6):
        cx, cy = rng.randrange(size), rng.randrange(size)
        radius = rng.randrange(1, 4)
        for dy in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                if dx * dx + dy * dy <= radius * radius:
                    texture.set((cx + dx) % size, (cy + dy) % size, fleck)

    _grain(texture, rng, 0.1)
    return texture


# ---------------------------------------------------------------------------

#: Every shipped texture, keyed by asset name. Colours are close to the
#: BuildMaterialBlueprint colours they sit under, because the client multiplies
#: the two: a texture that fights its material's tint reads as the wrong material.
SHIPPED: dict[str, "callable"] = {
    "T_Build_Wood": lambda: planks("wood", (168, 120, 66), (96, 63, 33)),
    "T_Build_Stone": lambda: blocks("stone", (138, 136, 132), (86, 85, 82)),
    "T_Build_Metal": lambda: panelled("metal", (150, 156, 164), (94, 99, 107)),
    "T_Harvest_Bark": lambda: bark("bark", (110, 78, 50)),
    "T_Harvest_Canopy": lambda: foliage("canopy", (58, 92, 62), (86, 126, 78)),
    "T_Harvest_Rock": lambda: speckle("rock", (126, 126, 132), (152, 150, 146)),
    "T_Character_Cloth": lambda: cloth("cloth", (86, 108, 150)),
    "T_Character_Skin": lambda: cloth("skin", (198, 164, 126)),
    "T_Terrain_Ground": lambda: speckle("ground", (86, 108, 68), (104, 124, 78)),
}


def generate_all() -> dict[str, Texture]:
    """Every texture, keyed by asset name."""
    return {name: build() for name, build in SHIPPED.items()}


def texture_path(asset_name: str, root: Path) -> Path:
    """Where a texture belongs, mirroring the mesh folder split."""
    parts = asset_name.split("_")
    if len(parts) < 3 or parts[0] != units.PREFIX_TEXTURE:
        raise ValueError(
            f"Texture {asset_name!r} does not follow T_Category_Name. "
            "Build names with tonight.units.asset_name()."
        )
    return root / "Textures" / f"{asset_name}.png"
