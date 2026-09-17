"""Generators for the four build pieces, in three materials.

These are the most load-bearing assets in the game: a wall is what the player
sees a hundred times a match, and its dimensions are what make the 4 m grid
read correctly. Everything here derives from :mod:`tonight.units` rather than
using literals, so changing the cell size changes the art with it.
"""

from __future__ import annotations

from dataclasses import dataclass

from tonight import units
from tonight.mesh import MeshData, box, pyramid, wedge
from tonight.rng import seeded


@dataclass(frozen=True)
class MaterialStyle:
    """How a build material affects its geometry.

    Material is not only a texture swap: stone is chunkier than wood, and metal
    is thinner and flatter. Keeping that as data means a fourth material is an
    entry here plus a Blueprint asset.
    """

    key: str
    thickness_scale: float
    #: Depth of the surface relief, in metres. Zero means a flat slab.
    relief_depth: float
    #: How many relief panels across the face.
    panel_divisions: int


WOOD = MaterialStyle(key="Wood", thickness_scale=1.0, relief_depth=0.04, panel_divisions=4)
STONE = MaterialStyle(key="Stone", thickness_scale=1.4, relief_depth=0.07, panel_divisions=3)
METAL = MaterialStyle(key="Metal", thickness_scale=0.7, relief_depth=0.02, panel_divisions=2)

MATERIALS: tuple[MaterialStyle, ...] = (WOOD, STONE, METAL)


def _relief_panels(style: MaterialStyle, width: float, height: float, thickness: float,
                   seed_name: str) -> list[MeshData]:
    """Shallow raised panels that give a flat slab some silhouette.

    Panel offsets are jittered from a seeded stream so wood does not look
    machine-perfect, while staying reproducible run to run (ADR-0004).
    """
    if style.relief_depth <= 0.0 or style.panel_divisions < 1:
        return []

    rng = seeded(seed_name)
    panels: list[MeshData] = []
    divisions = style.panel_divisions
    panel_w = width / divisions
    panel_h = height / divisions
    margin = min(panel_w, panel_h) * 0.12

    for column in range(divisions):
        for row in range(divisions):
            jitter = rng.uniform(-margin * 0.3, margin * 0.3)
            # X is centred on the cell face; Z runs from the cell floor upward,
            # matching how the wall slab itself is placed. Centring Z here
            # instead would leave the panels floating half a cell below.
            centre_x = -width / 2.0 + panel_w * (column + 0.5)
            centre_z = panel_h * (row + 0.5)
            panels.append(
                box(
                    size=(
                        panel_w - margin * 2 + jitter,
                        style.relief_depth,
                        panel_h - margin * 2 + jitter,
                    ),
                    centre=(centre_x, -(thickness / 2.0 + style.relief_depth / 2.0), centre_z),
                    name=f"Panel_{column}_{row}",
                )
            )

    return panels


def wall(style: MaterialStyle, with_skirt: bool = True) -> MeshData:
    """A full wall: one cell face.

    The skirt extends below the cell so the piece meets sloped terrain without
    a visible gap (ADR-0006).
    """
    thickness = units.PIECE_THICKNESS * style.thickness_scale
    name = units.asset_name(units.PREFIX_STATIC_MESH, "Build", "Wall", style.key)

    height = units.WALL_HEIGHT + (units.SKIRT_DEPTH if with_skirt else 0.0)
    # Centre is offset downward by half the skirt so the cell face itself stays
    # aligned to the grid and only the skirt hangs below.
    centre_z = units.WALL_HEIGHT / 2.0 - (units.SKIRT_DEPTH / 2.0 if with_skirt else 0.0)

    slab = box(
        size=(units.WALL_WIDTH, thickness, height),
        centre=(0.0, 0.0, centre_z),
        name=name,
        uv_scale=units.CELL_SIZE,
    )

    parts = [slab, *_relief_panels(style, units.WALL_WIDTH, units.WALL_HEIGHT, thickness, name)]
    return MeshData.join(parts, name=name)


def floor(style: MaterialStyle) -> MeshData:
    """A floor: one horizontal cell face."""
    thickness = units.PIECE_THICKNESS * style.thickness_scale
    name = units.asset_name(units.PREFIX_STATIC_MESH, "Build", "Floor", style.key)

    slab = box(
        size=(units.FLOOR_SIZE, units.FLOOR_SIZE, thickness),
        centre=(0.0, 0.0, 0.0),
        name=name,
        uv_scale=units.CELL_SIZE,
    )

    # Support ribs under the floor, so it reads as a structure from below --
    # players spend a lot of time looking up at their own floors.
    ribs: list[MeshData] = []
    rib_count = max(1, style.panel_divisions)
    for i in range(rib_count):
        offset = -units.FLOOR_SIZE / 2.0 + units.FLOOR_SIZE * (i + 0.5) / rib_count
        ribs.append(
            box(
                size=(units.FLOOR_SIZE, thickness * 0.6, thickness * 0.8),
                centre=(0.0, offset, -thickness * 0.8),
                name=f"Rib_{i}",
            )
        )

    return MeshData.join([slab, *ribs], name=name)


def ramp(style: MaterialStyle) -> MeshData:
    """A ramp rising exactly one cell over one cell, so the slope is 45 degrees.

    Tread battens across the slope are what let a player read which way a ramp
    faces at a glance -- a bare wedge is ambiguous from above, which matters
    during a ramp rush.
    """
    name = units.asset_name(units.PREFIX_STATIC_MESH, "Build", "Ramp", style.key)

    parts = [
        wedge(
            size=(units.CELL_SIZE, units.CELL_SIZE, units.CELL_SIZE),
            centre=(0.0, 0.0, units.CELL_SIZE / 2.0),
            name=name,
        )
    ]

    batten_count = max(2, style.panel_divisions + 1)
    batten_depth = units.PIECE_THICKNESS * style.thickness_scale * 0.45
    for index in range(batten_count):
        # Space battens along the slope, skipping the very ends where they
        # would poke through the wedge's triangular caps.
        fraction = (index + 1) / (batten_count + 1)
        along = -units.CELL_SIZE / 2.0 + units.CELL_SIZE * fraction
        height = units.CELL_SIZE * fraction
        parts.append(
            box(
                size=(units.CELL_SIZE * 0.92, batten_depth, batten_depth),
                centre=(0.0, along, height),
                name=f"Batten_{index}",
            )
        )

    return MeshData.join(parts, name=name)


def cone(style: MaterialStyle) -> MeshData:
    """The cone (pyramid) piece, filling a cell's interior.

    Hip ribs along the four edges give the pyramid a silhouette break and make
    the material visually distinct, as with the wall's relief panels.
    """
    name = units.asset_name(units.PREFIX_STATIC_MESH, "Build", "Cone", style.key)

    parts = [pyramid(base=units.CELL_SIZE, height=units.CELL_SIZE, name=name)]

    if style.relief_depth > 0.0:
        rib = style.relief_depth * 2.0 * style.thickness_scale
        # A square collar partway up reads as structure and differentiates the
        # three materials by thickness alone.
        collar_fraction = 0.45
        collar_half = units.CELL_SIZE / 2.0 * (1.0 - collar_fraction)
        parts.append(
            box(
                size=(collar_half * 2.0 + rib, collar_half * 2.0 + rib, rib),
                centre=(0.0, 0.0, units.CELL_SIZE * collar_fraction),
                name="Collar",
            )
        )

    return MeshData.join(parts, name=name)


#: Mask constants matching ``EditVariant.GridMask`` in the Unity Blueprint
#: schema. Row-major, top-left first. Kept here so the mesh and the Blueprint
#: mask cannot drift apart.
MASK_SOLID = (True,) * 9
MASK_DOORWAY = (True, True, True, True, False, True, True, False, True)
MASK_WINDOW = (True, True, True, True, False, True, True, True, True)


def wall_variant(style: MaterialStyle, mask: tuple[bool, ...], variant_name: str) -> MeshData:
    """A wall built from a 3x3 mask, with the false cells cut away.

    This is the generator side of the edit system: adding a new edit shape is a
    new mask here and a new ``EditVariant`` entry on the Blueprint, with no C#
    change on either side.
    """
    if len(mask) != 9:
        raise ValueError(f"A wall mask needs exactly 9 entries, got {len(mask)}.")

    thickness = units.PIECE_THICKNESS * style.thickness_scale
    name = units.asset_name(units.PREFIX_STATIC_MESH, "Build", "Wall", style.key, variant_name)

    cell_w = units.WALL_WIDTH / 3.0
    cell_h = units.WALL_HEIGHT / 3.0

    parts: list[MeshData] = []
    for index, filled in enumerate(mask):
        if not filled:
            continue
        column = index % 3
        # Mask index 0 is top-left, so row 0 is the TOP of the wall. Getting
        # this inverted would silently produce upside-down doorways.
        row = 2 - (index // 3)

        parts.append(
            box(
                size=(cell_w, thickness, cell_h),
                centre=(
                    -units.WALL_WIDTH / 2.0 + cell_w * (column + 0.5),
                    0.0,
                    cell_h * (row + 0.5),
                ),
                name=f"Cell_{index}",
                uv_scale=units.CELL_SIZE,
            )
        )

    if not parts:
        raise ValueError("A wall mask with no filled cells produces no geometry.")

    return MeshData.join(parts, name=name)


def generate_all() -> dict[str, MeshData]:
    """Every build-piece mesh, keyed by asset name."""
    result: dict[str, MeshData] = {}

    for style in MATERIALS:
        for mesh in (wall(style), floor(style), ramp(style), cone(style)):
            result[mesh.name] = mesh

        for mask, variant in ((MASK_DOORWAY, "Doorway"), (MASK_WINDOW, "Window")):
            mesh = wall_variant(style, mask, variant)
            result[mesh.name] = mesh

    return result
