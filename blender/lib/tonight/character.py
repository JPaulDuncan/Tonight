"""The player character: a blocky humanoid proxy.

[ADR-0004](../../../docs/adr/0004-procedural-art-pipeline.md) named characters
the weakest case for a generated-art pipeline and accepted a blocky proxy
through M6. This is that proxy, and it is honest about it: the parts exist so a
third-person camera has a readable silhouette and so the hitboxes in
``CharacterBlueprint`` have something to correspond to, not because a generator
can make a convincing person.

Two things here are load-bearing rather than cosmetic.

**Facing.** The character is authored facing Blender -Y, which becomes glTF +Z.
The motor's yaw of zero points at +Z (``yawRotate(vec3(0, 0, 1), yaw)``), so a
character authored any other way turns out to run backwards, and a third-person
camera placed behind the player would be looking at its face.

**Part names.** Each part carries the name of the hitbox it stands for, so the
exported primitives line up with ``CharacterBlueprint.hitboxes``. That is what
lets the client tint a limb on hit without a second source of truth for what a
limb is.
"""

from __future__ import annotations

from dataclasses import dataclass

from tonight import units
from tonight.mesh import MeshData, box

#: Proportions as fractions of total height, so changing STAND_HEIGHT rescales
#: the whole figure rather than producing a character with a normal head and
#: tiny legs.
HEAD_FRACTION = 0.13
TORSO_FRACTION = 0.32
LEG_FRACTION = 0.47

#: Matches MovementBlueprint.standHeight. A proxy taller than the capsule would
#: clip through the ceiling of a 4 m cell it is supposed to fit under.
STAND_HEIGHT = units.CHARACTER_HEIGHT

#: Shoulder-to-shoulder. Narrow enough to fit a doorway edit, which is a 1.33 m
#: gap in a 4 m wall.
SHOULDER_WIDTH = 0.52
DEPTH = 0.26


@dataclass(frozen=True)
class CharacterProportions:
    """One character's shape. A future cosmetic variant changes these only."""

    key: str
    height: float = STAND_HEIGHT
    shoulder_width: float = SHOULDER_WIDTH
    depth: float = DEPTH


DEFAULT = CharacterProportions(key="Default")


def character(proportions: CharacterProportions = DEFAULT) -> MeshData:
    """A blocky humanoid, based at Z = 0 and facing -Y."""
    name = units.asset_name(units.PREFIX_STATIC_MESH, "Character", proportions.key)

    height = proportions.height
    width = proportions.shoulder_width
    depth = proportions.depth

    head_size = height * HEAD_FRACTION
    torso_height = height * TORSO_FRACTION
    leg_height = height * LEG_FRACTION

    # Stack from the ground up, so the figure always totals `height` no matter
    # how the fractions are retuned.
    leg_top = leg_height
    torso_top = leg_top + torso_height
    neck = torso_top + (height - torso_top - head_size)

    leg_width = width * 0.32
    leg_gap = width * 0.08
    arm_width = width * 0.18

    parts = [
        # Torso and pelvis are separate hitboxes, so they are separate parts.
        box(
            size=(width, depth, torso_height * 0.62),
            centre=(0.0, 0.0, leg_top + torso_height * 0.69),
            name="Chest",
        ),
        box(
            size=(width * 0.82, depth * 0.92, torso_height * 0.38),
            centre=(0.0, 0.0, leg_top + torso_height * 0.19),
            name="Pelvis",
        ),
        box(
            size=(head_size, head_size, head_size),
            centre=(0.0, 0.0, neck + head_size / 2.0),
            name="Head",
        ),
        # A brow block breaks the head's symmetry so the facing is readable at
        # gameplay distance. It sits toward -Y, which is forward.
        box(
            size=(head_size * 0.7, head_size * 0.22, head_size * 0.24),
            centre=(0.0, -head_size * 0.52, neck + head_size * 0.62),
            name="Head",
        ),
    ]

    for side, sign in (("Left", -1.0), ("Right", 1.0)):
        parts.append(
            box(
                size=(leg_width, depth * 0.9, leg_height),
                centre=(sign * (leg_width / 2.0 + leg_gap / 2.0), 0.0, leg_height / 2.0),
                name=f"Leg{side}",
            )
        )
        parts.append(
            box(
                size=(arm_width, depth * 0.8, torso_height * 0.9),
                centre=(
                    sign * (width / 2.0 + arm_width / 2.0),
                    0.0,
                    leg_top + torso_height * 0.55,
                ),
                name=f"Arm{side}",
            )
        )

    mesh = MeshData.join(parts, name=name)

    # Joints, in Blender coordinates. A limb rotates about the top of itself:
    # the hip is where the leg meets the pelvis, the shoulder where the arm
    # meets the chest. Emitting them here rather than deriving them in the
    # renderer keeps anatomy in the generator that already knows it.
    mesh.pivots = {
        "LegLeft": (-(leg_width / 2.0 + leg_gap / 2.0), 0.0, leg_top),
        "LegRight": (leg_width / 2.0 + leg_gap / 2.0, 0.0, leg_top),
        "ArmLeft": (-(width / 2.0 + arm_width / 2.0), 0.0, leg_top + torso_height),
        "ArmRight": (width / 2.0 + arm_width / 2.0, 0.0, leg_top + torso_height),
        # The torso leans and the head turns about the base of each.
        "Chest": (0.0, 0.0, leg_top + torso_height * 0.38),
        "Head": (0.0, 0.0, neck),
        "Pelvis": (0.0, 0.0, leg_top),
    }

    # The hand: the bottom of the right arm, nudged forward so a held weapon
    # sits in front of the fist rather than inside the thigh. A weapon's own
    # Grip socket is matched to this point, which is what lets any weapon be
    # held without a per-weapon transform in the renderer.
    mesh.sockets = {
        "GripRight": (
            width / 2.0 + arm_width / 2.0,
            -depth * 0.55,
            leg_top + torso_height * 0.10,
        ),
    }
    return mesh


def generate_all() -> dict[str, MeshData]:
    """Every character mesh, keyed by asset name."""
    mesh = character(DEFAULT)
    return {mesh.name: mesh}
