"""Weapon mesh generators.

Weapons are built from a small kit of parts -- receiver, barrel, stock,
magazine, grip, sight -- proportioned per class. Because a weapon is a
parameter set rather than a hand-modelled asset, adding one is filling in a
:class:`WeaponProportions` and pairing it with a ``WeaponBlueprint``.

Silhouette is what matters here (pillar 3): a player must tell an SMG from a
sniper at a glance, at distance, in deep night. The proportions below are
chosen to make the five classes read differently in outline alone.
"""

from __future__ import annotations

from dataclasses import dataclass

from tonight import units
from tonight.mesh import MeshData, box, cylinder


@dataclass(frozen=True)
class WeaponProportions:
    """The parameters that define one weapon's shape, in metres."""

    key: str
    receiver_length: float
    receiver_height: float
    barrel_length: float
    barrel_radius: float
    has_stock: bool
    has_magazine: bool
    magazine_length: float
    has_scope: bool
    scope_length: float

    @property
    def total_length(self) -> float:
        return self.receiver_length + self.barrel_length


ASSAULT_RIFLE = WeaponProportions(
    key="AssaultRifle",
    receiver_length=0.46, receiver_height=0.10,
    barrel_length=0.40, barrel_radius=0.014,
    has_stock=True, has_magazine=True, magazine_length=0.20,
    has_scope=False, scope_length=0.0,
)

SHOTGUN = WeaponProportions(
    key="Shotgun",
    receiver_length=0.44, receiver_height=0.12,
    barrel_length=0.50, barrel_radius=0.022,   # fat barrel reads at distance
    has_stock=True, has_magazine=False, magazine_length=0.0,
    has_scope=False, scope_length=0.0,
)

SMG = WeaponProportions(
    key="Smg",
    receiver_length=0.30, receiver_height=0.10,
    barrel_length=0.18, barrel_radius=0.012,   # stubby: the short silhouette
    has_stock=False, has_magazine=True, magazine_length=0.24,
    has_scope=False, scope_length=0.0,
)

SNIPER = WeaponProportions(
    key="Sniper",
    receiver_length=0.52, receiver_height=0.10,
    barrel_length=0.78, barrel_radius=0.016,   # long: unmistakable at range
    has_stock=True, has_magazine=True, magazine_length=0.12,
    has_scope=True, scope_length=0.30,
)

PISTOL = WeaponProportions(
    key="Pistol",
    receiver_length=0.20, receiver_height=0.09,
    barrel_length=0.06, barrel_radius=0.011,
    has_stock=False, has_magazine=True, magazine_length=0.11,
    has_scope=False, scope_length=0.0,
)

PICKAXE = WeaponProportions(
    key="Pickaxe",
    receiver_length=0.08, receiver_height=0.06,
    barrel_length=0.0, barrel_radius=0.0,
    has_stock=False, has_magazine=False, magazine_length=0.0,
    has_scope=False, scope_length=0.0,
)

WEAPONS: tuple[WeaponProportions, ...] = (
    ASSAULT_RIFLE, SHOTGUN, SMG, SNIPER, PISTOL,
)


def _grip(proportions: WeaponProportions) -> MeshData:
    """The pistol grip. Angled back, which is most of what says 'gun'."""
    return box(
        size=(0.035, 0.05, 0.12),
        centre=(0.0, -0.01, -proportions.receiver_height / 2.0 - 0.055),
        name="Grip",
    ).rotated_z(0.0)


def firearm(proportions: WeaponProportions) -> MeshData:
    """Assemble one firearm from the part kit.

    The barrel runs along +X so that in Unity -- after the Y-up conversion at
    export -- the weapon points down the character's forward axis without a
    per-asset rotation offset baked into the prefab.
    """
    name = units.asset_name(units.PREFIX_STATIC_MESH, "Weapon", proportions.key)
    parts: list[MeshData] = []

    receiver = box(
        size=(proportions.receiver_length, 0.05, proportions.receiver_height),
        centre=(0.0, 0.0, 0.0),
        name="Receiver",
    )
    parts.append(receiver)

    if proportions.barrel_length > 0.0:
        barrel = cylinder(
            radius=proportions.barrel_radius,
            height=proportions.barrel_length,
            segments=8,
            name="Barrel",
        )
        # The cylinder generates along Z; lay it along X and push it forward.
        barrel = _lay_along_x(barrel)
        barrel = barrel.translated(
            (proportions.receiver_length / 2.0 + proportions.barrel_length / 2.0, 0.0, 0.0)
        )
        parts.append(barrel)

    parts.append(_grip(proportions))

    if proportions.has_stock:
        parts.append(
            box(
                size=(0.18, 0.045, 0.09),
                centre=(-proportions.receiver_length / 2.0 - 0.09, 0.0, -0.01),
                name="Stock",
            )
        )

    if proportions.has_magazine:
        parts.append(
            box(
                size=(0.05, 0.03, proportions.magazine_length),
                centre=(
                    proportions.receiver_length * 0.1,
                    0.0,
                    -proportions.receiver_height / 2.0 - proportions.magazine_length / 2.0,
                ),
                name="Magazine",
            )
        )

    if proportions.has_scope:
        scope = cylinder(
            radius=0.022,
            height=proportions.scope_length,
            segments=8,
            name="Scope",
        )
        scope = _lay_along_x(scope).translated(
            (0.0, 0.0, proportions.receiver_height / 2.0 + 0.03)
        )
        parts.append(scope)
    else:
        # Iron sights: a small blade at the muzzle end, so an unscoped weapon
        # still has something breaking its top line.
        parts.append(
            box(
                size=(0.02, 0.012, 0.022),
                centre=(
                    proportions.receiver_length / 2.0 - 0.03,
                    0.0,
                    proportions.receiver_height / 2.0 + 0.011,
                ),
                name="FrontSight",
            )
        )

    return MeshData.join(parts, name=name)


def pickaxe() -> MeshData:
    """The starting tool. Every player carries one, so it must read instantly."""
    name = units.asset_name(units.PREFIX_STATIC_MESH, "Tool", "Pickaxe")

    haft = box(size=(0.045, 0.045, 0.62), centre=(0.0, 0.0, 0.0), name="Haft")
    head = box(size=(0.34, 0.05, 0.06), centre=(0.0, 0.0, 0.30), name="Head")
    spike = box(size=(0.07, 0.045, 0.10), centre=(0.14, 0.0, 0.26), name="Spike")

    return MeshData.join([haft, head, spike], name=name)


def _lay_along_x(mesh: MeshData) -> MeshData:
    """Rotate a Z-aligned mesh onto the X axis."""
    rotated = mesh.copy()
    # (x, y, z) -> (z, y, -x): a -90 degree turn about Y.
    rotated.vertices = [(v[2], v[1], -v[0]) for v in mesh.vertices]
    return rotated


def generate_all() -> dict[str, MeshData]:
    """Every weapon mesh, keyed by asset name."""
    result: dict[str, MeshData] = {}
    for proportions in WEAPONS:
        mesh = firearm(proportions)
        result[mesh.name] = mesh

    tool = pickaxe()
    result[tool.name] = tool
    return result
