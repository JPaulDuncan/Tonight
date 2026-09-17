"""Harvestable world props: trees, rocks, vehicles.

These feed the building loop, so there are a lot of them on the map and they
need to be cheap. Each generator takes a ``variant`` seed so one function
produces a forest's worth of distinct-looking trees without a forest's worth of
authored assets.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from tonight import units
from tonight.mesh import MeshData, box, cylinder, pyramid
from tonight.rng import seeded


@dataclass(frozen=True)
class HarvestableSpec:
    key: str
    material: str
    #: Roughly how tall, in metres, before per-variant jitter.
    nominal_height: float


TREE = HarvestableSpec(key="Tree", material="Wood", nominal_height=7.0)
ROCK = HarvestableSpec(key="Rock", material="Stone", nominal_height=2.2)
VEHICLE = HarvestableSpec(key="Vehicle", material="Metal", nominal_height=1.6)

HARVESTABLES: tuple[HarvestableSpec, ...] = (TREE, ROCK, VEHICLE)


def tree(variant: int = 0) -> MeshData:
    """A stylised conifer: trunk plus stacked canopy tiers."""
    name = units.asset_name(units.PREFIX_STATIC_MESH, "Harvest", "Tree", f"{variant:02d}")
    rng = seeded("tree", salt=variant)

    height = TREE.nominal_height * rng.uniform(0.82, 1.2)
    trunk_radius = rng.uniform(0.16, 0.24)
    trunk_height = height * rng.uniform(0.32, 0.42)

    parts = [
        cylinder(
            radius=trunk_radius,
            height=trunk_height,
            segments=6,
            centre=(0.0, 0.0, trunk_height / 2.0),
            name="Trunk",
        )
    ]

    tiers = rng.randint(3, 4)
    canopy_base = trunk_height * 0.75
    canopy_height = height - canopy_base

    for tier in range(tiers):
        fraction = tier / tiers
        tier_radius = rng.uniform(1.1, 1.6) * (1.0 - fraction * 0.55)
        tier_height = canopy_height / tiers * rng.uniform(1.25, 1.55)
        tier_z = canopy_base + canopy_height * fraction

        canopy = pyramid(base=tier_radius * 2.0, height=tier_height, name=f"Canopy_{tier}")
        # A small yaw per tier stops the stack reading as one extruded shape.
        canopy = canopy.rotated_z(rng.uniform(0.0, 90.0)).translated((0.0, 0.0, tier_z))
        parts.append(canopy)

    return MeshData.join(parts, name=name)


def rock(variant: int = 0) -> MeshData:
    """A boulder cluster: a few jittered boxes, which reads as rock cheaply."""
    name = units.asset_name(units.PREFIX_STATIC_MESH, "Harvest", "Rock", f"{variant:02d}")
    rng = seeded("rock", salt=variant)

    parts: list[MeshData] = []
    chunks = rng.randint(3, 5)

    for index in range(chunks):
        scale = rng.uniform(0.5, 1.0)
        size = (
            ROCK.nominal_height * rng.uniform(0.6, 1.1) * scale,
            ROCK.nominal_height * rng.uniform(0.6, 1.1) * scale,
            ROCK.nominal_height * rng.uniform(0.4, 0.9) * scale,
        )
        angle = rng.uniform(0.0, math.tau)
        spread = ROCK.nominal_height * 0.35
        centre = (
            math.cos(angle) * rng.uniform(0.0, spread),
            math.sin(angle) * rng.uniform(0.0, spread),
            size[2] / 2.0 * rng.uniform(0.75, 1.0),
        )
        parts.append(
            box(size=size, centre=centre, name=f"Chunk_{index}").rotated_z(rng.uniform(0.0, 90.0))
        )

    return MeshData.join(parts, name=name)


def vehicle(variant: int = 0) -> MeshData:
    """A derelict car: the metal source, and a rotation landmark."""
    name = units.asset_name(units.PREFIX_STATIC_MESH, "Harvest", "Vehicle", f"{variant:02d}")
    rng = seeded("vehicle", salt=variant)

    length = rng.uniform(3.9, 4.6)
    width = rng.uniform(1.7, 1.95)
    body_height = rng.uniform(0.62, 0.78)
    cabin_height = rng.uniform(0.52, 0.66)
    wheel_radius = 0.33

    parts = [
        box(
            size=(length, width, body_height),
            centre=(0.0, 0.0, wheel_radius + body_height / 2.0),
            name="Body",
        ),
        box(
            size=(length * 0.52, width * 0.86, cabin_height),
            centre=(
                -length * 0.05,
                0.0,
                wheel_radius + body_height + cabin_height / 2.0,
            ),
            name="Cabin",
        ),
    ]

    for index, (x_sign, y_sign) in enumerate(((1, 1), (1, -1), (-1, 1), (-1, -1))):
        wheel = cylinder(radius=wheel_radius, height=0.24, segments=8, name=f"Wheel_{index}")
        # Cylinders generate along Z; a wheel's axle runs across the car (Y).
        wheel = _lay_along_y(wheel)
        wheel = wheel.translated(
            (x_sign * length * 0.33, y_sign * width / 2.0, wheel_radius)
        )
        parts.append(wheel)

    return MeshData.join(parts, name=name)


def _lay_along_y(mesh: MeshData) -> MeshData:
    """Rotate a Z-aligned mesh onto the Y axis."""
    rotated = mesh.copy()
    # (x, y, z) -> (x, z, -y): a -90 degree turn about X.
    rotated.vertices = [(v[0], v[2], -v[1]) for v in mesh.vertices]
    return rotated


def generate_all(variants_per_kind: int = 3) -> dict[str, MeshData]:
    """Every harvestable mesh, keyed by asset name.

    Args:
        variants_per_kind: How many seeded variants of each kind to produce.
            Three is enough that a forest does not look cloned at gameplay
            distance without tripling the import time.
    """
    result: dict[str, MeshData] = {}
    for variant in range(variants_per_kind):
        for mesh in (tree(variant), rock(variant), vehicle(variant)):
            result[mesh.name] = mesh
    return result
