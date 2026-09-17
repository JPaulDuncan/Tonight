"""Scale, axis, and naming conventions.

Getting these wrong is the single most common way an asset pipeline produces
art that looks fine in Blender and wrong in the engine, so every constant the
generators depend on lives here rather than being repeated as a literal.

See docs/pipeline/units-and-naming.md.
"""

from __future__ import annotations

# --------------------------------------------------------------------------
# Scale
# --------------------------------------------------------------------------

#: One Unity unit is one metre. Blender scenes author in metres and export at
#: scale 1.0, so no conversion factor exists anywhere -- a conversion factor is
#: a thing to forget.
METRES_PER_UNIT = 1.0

#: The build grid cell (ADR-0006). A wall is one cell face; a ramp rises
#: exactly one cell, which is what makes its 45 degrees exact rather than
#: approximate.
CELL_SIZE = 4.0

WALL_WIDTH = CELL_SIZE
WALL_HEIGHT = CELL_SIZE
FLOOR_SIZE = CELL_SIZE

#: Build pieces are thin slabs. Thick enough to read as solid and to bevel
#: without artefacts, thin enough that two back-to-back walls do not visibly
#: overlap.
PIECE_THICKNESS = 0.2

#: Pieces extend slightly below their cell so they meet sloped terrain without
#: a visible gap. ADR-0006 names this the "skirt".
SKIRT_DEPTH = 0.35

#: Reference character height, used to sanity-check that a wall covers a player.
CHARACTER_HEIGHT = 1.8

# --------------------------------------------------------------------------
# Axis conversion
# --------------------------------------------------------------------------

#: Blender is Z-up, right-handed. Unity is Y-up, left-handed. Export always
#: goes through ``tonight.export.export_fbx``, which applies this; calling
#: ``bpy.ops.export_scene.fbx`` directly is prohibited precisely because it is
#: easy to get this wrong in a way nobody notices until animation.
FBX_AXIS_FORWARD = "-Z"
FBX_AXIS_UP = "Y"

# --------------------------------------------------------------------------
# Naming
# --------------------------------------------------------------------------

PREFIX_STATIC_MESH = "SM"
PREFIX_SKELETAL_MESH = "SK"
PREFIX_MATERIAL = "M"
PREFIX_TEXTURE = "T"
PREFIX_PREFAB = "PF"
PREFIX_BLUEPRINT = "BP"

_VALID_PREFIXES = frozenset(
    {
        PREFIX_STATIC_MESH,
        PREFIX_SKELETAL_MESH,
        PREFIX_MATERIAL,
        PREFIX_TEXTURE,
        PREFIX_PREFAB,
        PREFIX_BLUEPRINT,
    }
)


def asset_name(prefix: str, *parts: str) -> str:
    """Build a conventional asset name, e.g. ``SM_Build_Wall_Wood``.

    Raises:
        ValueError: if the prefix is not one of the project's prefixes, or if
            any part is empty. Both are mistakes worth failing loudly on: a
            misnamed asset is found months later by someone who cannot tell
            what it is.
    """
    if prefix not in _VALID_PREFIXES:
        raise ValueError(
            f"Unknown asset prefix {prefix!r}. "
            f"Expected one of {sorted(_VALID_PREFIXES)}."
        )
    if not parts:
        raise ValueError("An asset name needs at least one part after the prefix.")
    for part in parts:
        if not part or not part.strip():
            raise ValueError(f"Empty name part in {parts!r}.")
        if "_" in part:
            raise ValueError(
                f"Name part {part!r} contains an underscore; pass separate parts "
                "instead so the convention stays parseable."
            )

    return "_".join([prefix, *parts])


def wall_covers_character() -> bool:
    """Sanity check backing the 4 m cell choice in ADR-0006."""
    return WALL_HEIGHT > CHARACTER_HEIGHT
