"""Tests for the procedural texture generators.

These decode the PNG back rather than trusting the encoder. A hand-rolled PNG
that a permissive viewer tolerates but a browser rejects is exactly the failure
worth catching here, and the only way to catch it is to parse the bytes.
"""

from __future__ import annotations

import struct
import zlib

import pytest

from tonight import textures
from tonight.textures import TEXTURE_SIZE, Texture


def decode_png(raw: bytes) -> tuple[int, int, list[tuple[int, int, int]]]:
    """A minimal PNG reader: signature, chunks, CRCs, and 8-bit RGB pixels."""
    assert raw[:8] == b"\x89PNG\r\n\x1a\n", "bad PNG signature"

    offset = 8
    width = height = 0
    idat = bytearray()
    saw_end = False

    while offset < len(raw):
        length = struct.unpack_from(">I", raw, offset)[0]
        kind = raw[offset + 4 : offset + 8]
        payload = raw[offset + 8 : offset + 8 + length]
        stored_crc = struct.unpack_from(">I", raw, offset + 8 + length)[0]
        assert zlib.crc32(kind + payload) & 0xFFFFFFFF == stored_crc, f"bad CRC on {kind!r}"

        if kind == b"IHDR":
            width, height, depth, colour, comp, filt, interlace = struct.unpack(">IIBBBBB", payload)
            assert depth == 8, "expected 8 bits per channel"
            assert colour == 2, "expected truecolour RGB"
            assert (comp, filt, interlace) == (0, 0, 0)
        elif kind == b"IDAT":
            idat.extend(payload)
        elif kind == b"IEND":
            saw_end = True

        offset += 12 + length

    assert saw_end, "no IEND chunk"
    assert offset == len(raw), "chunk lengths do not tile the file"

    data = zlib.decompress(bytes(idat))
    stride = width * 3
    assert len(data) == height * (stride + 1), "decompressed size does not match the header"

    pixels: list[tuple[int, int, int]] = []
    for y in range(height):
        row_start = y * (stride + 1)
        assert data[row_start] == 0, "only filter type 0 is written"
        row = data[row_start + 1 : row_start + 1 + stride]
        for x in range(width):
            pixels.append((row[x * 3], row[x * 3 + 1], row[x * 3 + 2]))
    return width, height, pixels


def pixel_at(pixels, width, x, y):
    return pixels[y * width + x]


def mean_abs_difference(a, b) -> float:
    return sum(abs(p - q) for pa, pb in zip(a, b) for p, q in zip(pa, pb)) / (len(a) * 3)


ALL_TEXTURES = sorted(textures.SHIPPED)


class TestPngEncoding:
    def test_a_flat_fill_round_trips_exactly(self):
        texture = Texture.filled((10, 20, 30), size=8)
        width, height, pixels = decode_png(texture.to_png())
        assert (width, height) == (8, 8)
        assert set(pixels) == {(10, 20, 30)}

    def test_pixels_survive_the_round_trip(self):
        texture = Texture.filled((0, 0, 0), size=4)
        texture.set(1, 2, (255, 128, 64))
        _, _, pixels = decode_png(texture.to_png())
        assert pixel_at(pixels, 4, 1, 2) == (255, 128, 64)

    @pytest.mark.parametrize("name", ALL_TEXTURES)
    def test_shipped_texture_decodes(self, name: str):
        # decode_png asserts the signature, every chunk CRC, the header fields
        # and that the chunks tile the file exactly.
        width, height, pixels = decode_png(textures.SHIPPED[name]().to_png())
        assert (width, height) == (TEXTURE_SIZE, TEXTURE_SIZE)
        assert len(pixels) == TEXTURE_SIZE * TEXTURE_SIZE

    def test_encoding_is_deterministic(self):
        # The manifest's review story depends on a generator change being the
        # only thing that can change the bytes.
        assert textures.SHIPPED["T_Build_Wood"]().to_png() == (
            textures.SHIPPED["T_Build_Wood"]().to_png()
        )


class TestContent:
    @pytest.mark.parametrize("name", ALL_TEXTURES)
    def test_texture_is_not_a_flat_fill(self, name: str):
        """A generator that silently produced one colour would still decode.

        This is the check that would catch a loop that never ran -- the texture
        equivalent of the build-piece generator that accepted a style argument
        and ignored it.
        """
        _, _, pixels = decode_png(textures.SHIPPED[name]().to_png())
        assert len(set(pixels)) > 32, f"{name} has almost no variation"

    @pytest.mark.parametrize("name", ALL_TEXTURES)
    def test_texture_is_not_mostly_extremes(self, name: str):
        # Clipping to black or white means the shading maths overflowed.
        _, _, pixels = decode_png(textures.SHIPPED[name]().to_png())
        extreme = sum(1 for p in pixels if max(p) < 12 or min(p) > 243)
        assert extreme < len(pixels) * 0.02, f"{name} is {extreme} clipped pixels"


class TestTiling:
    """Seams are the failure that matters.

    A build piece repeats one texture across a 4 m face, so a discontinuity at
    the tile edge draws a line down the middle of every wall in the game.

    The comparison is against the texture's own *sharpest* interior transition,
    not its average one. Masonry, planks and sheet metal all contain deliberate
    hard edges -- mortar lines, board seams, panel joints -- and a tile boundary
    that looks like one of those is correct rather than broken. What is broken is
    a boundary sharper than anything the texture contains elsewhere, which is
    what a pattern whose period does not divide the tile produces.
    """

    @staticmethod
    def _lines(pixels, width, height, vertical: bool):
        if vertical:
            return [[pixels[y * width + x] for y in range(height)] for x in range(width)]
        return [[pixels[y * width + x] for x in range(width)] for y in range(height)]

    def _assert_seamless(self, name: str, vertical: bool) -> None:
        width, height, pixels = decode_png(textures.SHIPPED[name]().to_png())
        lines = self._lines(pixels, width, height, vertical)

        seam = mean_abs_difference(lines[0], lines[-1])
        sharpest = max(
            mean_abs_difference(lines[i], lines[i + 1]) for i in range(len(lines) - 1)
        )
        axis = "vertical" if vertical else "horizontal"
        assert seam <= sharpest * 1.05 + 2, (
            f"{name} has a {axis} seam: the wrap differs by {seam:.1f}, worse than "
            f"its sharpest interior transition at {sharpest:.1f}"
        )

    @pytest.mark.parametrize("name", ALL_TEXTURES)
    def test_horizontal_wrap_is_seamless(self, name: str):
        self._assert_seamless(name, vertical=True)

    @pytest.mark.parametrize("name", ALL_TEXTURES)
    def test_vertical_wrap_is_seamless(self, name: str):
        self._assert_seamless(name, vertical=False)

    def test_the_seam_check_catches_a_texture_that_cannot_tile(self):
        """The check has to be able to fail, or it is decoration.

        A gradient is the unambiguous case: its interior transitions are tiny
        and its two edges are as far apart as the image gets, so a metric that
        does not flag it is not measuring anything. A periodic pattern whose
        period divides the tile is the control that must pass.
        """
        size = 64
        periodic = Texture.filled((120, 120, 120), size=size)
        gradient = Texture.filled((120, 120, 120), size=size)
        for y in range(size):
            for x in range(size):
                if x % 8 == 0:
                    periodic.shade(x, y, 0.5)       # 8 divides 64, so it wraps
                gradient.shade(x, y, 0.6 + 0.8 * (x / size))

        def is_seamy(texture: Texture) -> bool:
            _, _, pixels = decode_png(texture.to_png())
            lines = self._lines(pixels, size, size, vertical=True)
            seam = mean_abs_difference(lines[0], lines[-1])
            sharpest = max(
                mean_abs_difference(lines[i], lines[i + 1]) for i in range(len(lines) - 1)
            )
            return seam > sharpest * 1.05 + 2

        assert is_seamy(gradient), "a gradient cannot tile and must be flagged"
        assert not is_seamy(periodic), "a dividing period tiles and must pass"


class TestNaming:
    @pytest.mark.parametrize("name", ALL_TEXTURES)
    def test_follows_the_prefix_convention(self, name: str):
        parts = name.split("_")
        assert parts[0] == "T", "textures use the T_ prefix"
        assert len(parts) >= 3, "T_Category_Name"

    def test_path_mirrors_the_mesh_folder_split(self, tmp_path):
        path = textures.texture_path("T_Build_Wood", tmp_path)
        assert path.parent.name == "Textures"
        assert path.name == "T_Build_Wood.png"

    def test_a_misnamed_texture_is_rejected(self, tmp_path):
        with pytest.raises(ValueError):
            textures.texture_path("Wood", tmp_path)
