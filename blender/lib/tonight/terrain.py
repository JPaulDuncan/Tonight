"""Terrain heightfield generation and the constraints it must satisfy.

The map has design constraints that GDD §8 states and `MapBlueprint` declares:
no slope above 40 degrees outside designed cliffs, and at least 30% open
terrain. Those are asserted by tooling rather than judged by eye, and this
module is the tooling.

The M1 deliverable is a 200 m test island; the same generator scales to
Nightfall Isle's 1400 m at M5.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from tonight import units
from tonight.mesh import MeshData
from tonight.rng import seeded


@dataclass(frozen=True)
class TerrainSpec:
    """Parameters for one heightfield."""

    name: str
    size_metres: float
    #: Vertices per side. Resolution, not size.
    resolution: int
    #: Peak height of the terrain, in metres.
    amplitude: float
    #: Largest feature size, in metres.
    feature_size: float
    seed: str = "terrain"
    #: Metres added before the island falloff, lifting the interior above sea
    #: level. Without it the noise averages around zero and roughly half the
    #: island sits underwater.
    base_height: float = 0.0

    @property
    def cell_size(self) -> float:
        return self.size_metres / (self.resolution - 1)


#: How quickly octave amplitude falls off. Lower is gentler terrain.
OCTAVE_DECAY = 0.40

#: How far the shoreline drops below sea level, and where the falloff begins as
#: a fraction of the half-extent.
SHORE_DROP = 3.0
SHORE_EDGE = 0.62

#: The M1 test island. 200 m is large enough to rotate across and small enough
#: to iterate on.
TEST_ISLAND = TerrainSpec(
    name="TestIsland",
    size_metres=200.0,
    resolution=101,
    # Tuned so the finished field lands at ~31 degrees max slope and ~69% open
    # terrain: comfortably inside the 40-degree and 30% limits, with headroom
    # for designed cliffs to be carved in later without breaching either.
    amplitude=5.0,
    feature_size=110.0,
    seed="test-island",
)


def _value_noise(spec: TerrainSpec) -> list[list[float]]:
    """Smooth pseudo-random heights, built from summed cosine octaves.

    Deliberately not Perlin or simplex: this needs no gradient tables, no
    dependency, and is trivially deterministic, which is what ADR-0004 asks
    for. It produces rolling hills rather than convincing geology, and rolling
    hills are exactly what a build-fight arena wants (GDD §8: building must
    always be viable).
    """
    rng = seeded(spec.seed)

    # Four octaves, each half the feature size and 40% of the amplitude. The
    # decay is what controls ruggedness: at 0.55 the field failed the 30%
    # open-terrain constraint outright.
    octaves = []
    for octave in range(4):
        wavelength = spec.feature_size / (2**octave)
        octaves.append(
            (
                wavelength,
                spec.amplitude * (OCTAVE_DECAY**octave),
                rng.uniform(0.0, math.tau),
                rng.uniform(0.0, math.tau),
                rng.uniform(0.0, math.tau),
            )
        )

    heights: list[list[float]] = []
    for row in range(spec.resolution):
        y = row * spec.cell_size
        line: list[float] = []
        for column in range(spec.resolution):
            x = column * spec.cell_size
            height = 0.0
            for wavelength, amplitude, phase_x, phase_y, phase_d in octaves:
                k = math.tau / wavelength
                height += amplitude * (
                    0.5 * math.cos(k * x + phase_x)
                    + 0.5 * math.cos(k * y + phase_y)
                    + 0.35 * math.cos(k * (x + y) * 0.7071 + phase_d)
                )
            line.append(height)
        heights.append(line)

    return heights


def _island_falloff(spec: TerrainSpec, heights: list[list[float]]) -> list[list[float]]:
    """Pull the edges down to sea level so the map is an island.

    A hard boundary would be a cliff the player can fall off; a smooth falloff
    reads as a shoreline and keeps the playable area away from the edge.
    """
    half = spec.size_metres / 2.0
    for row in range(spec.resolution):
        y = row * spec.cell_size - half
        for column in range(spec.resolution):
            x = column * spec.cell_size - half
            # Normalised distance from centre, by the larger axis so corners
            # fall away rather than forming a circular plateau.
            distance = max(abs(x), abs(y)) / half
            falloff = 1.0 - _smoothstep(SHORE_EDGE, 1.0, distance)
            lifted = heights[row][column] + spec.base_height
            heights[row][column] = lifted * falloff - (1.0 - falloff) * SHORE_DROP
    return heights


def _smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge1 <= edge0:
        return 0.0 if x < edge0 else 1.0
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


def _limit_slope(spec: TerrainSpec, heights: list[list[float]], max_degrees: float,
                 iterations: int = 40) -> list[list[float]]:
    """Relax the heightfield until no cell exceeds the buildable slope.

    Works like a thermal-erosion pass: wherever the drop between neighbours is
    steeper than allowed, move material from the high side to the low one.

    Cells are relaxed in place, so a later fix in the same pass can re-break
    an earlier pair; convergence comes from repeating rather than from one
    exact pass. Twelve iterations was not enough and left the field at 44
    degrees against a 40 degree limit -- the loop exits early once the worst
    excess falls below a tenth of a millimetre, so the iteration cap is a
    safety net rather than the usual stopping point.
    """
    max_drop = math.tan(math.radians(max_degrees)) * spec.cell_size

    for _ in range(iterations):
        worst = 0.0
        for row in range(spec.resolution):
            for column in range(spec.resolution):
                for d_row, d_col in ((0, 1), (1, 0)):
                    r2, c2 = row + d_row, column + d_col
                    if r2 >= spec.resolution or c2 >= spec.resolution:
                        continue

                    difference = heights[row][column] - heights[r2][c2]
                    excess = abs(difference) - max_drop
                    if excess <= 0.0:
                        continue

                    worst = max(worst, excess)
                    shift = excess * 0.5
                    if difference > 0:
                        heights[row][column] -= shift
                        heights[r2][c2] += shift
                    else:
                        heights[row][column] += shift
                        heights[r2][c2] -= shift

        if worst <= 1e-4:
            break

    return heights


def heightfield(spec: TerrainSpec, max_slope_degrees: float = 40.0) -> list[list[float]]:
    """Generate a heightfield satisfying the buildable-slope constraint."""
    heights = _value_noise(spec)
    heights = _island_falloff(spec, heights)
    heights = _limit_slope(spec, heights, max_slope_degrees)
    return heights


def max_slope_degrees(spec: TerrainSpec, heights: list[list[float]]) -> float:
    """The steepest slope anywhere in the field, in degrees."""
    steepest = 0.0
    for row in range(spec.resolution):
        for column in range(spec.resolution):
            for d_row, d_col in ((0, 1), (1, 0)):
                r2, c2 = row + d_row, column + d_col
                if r2 >= spec.resolution or c2 >= spec.resolution:
                    continue
                drop = abs(heights[row][column] - heights[r2][c2])
                steepest = max(steepest, math.degrees(math.atan2(drop, spec.cell_size)))
    return steepest


def open_terrain_fraction(
    spec: TerrainSpec, heights: list[list[float]], flat_threshold_degrees: float = 12.0
) -> float:
    """Fraction of the field gentle enough to count as open build-fight space.

    GDD §8 requires at least 30%: build-fights need room, and a map that is all
    hillside is a map where cover is free.
    """
    gentle = 0
    total = 0
    for row in range(spec.resolution - 1):
        for column in range(spec.resolution - 1):
            drop = max(
                abs(heights[row][column] - heights[row][column + 1]),
                abs(heights[row][column] - heights[row + 1][column]),
            )
            total += 1
            if math.degrees(math.atan2(drop, spec.cell_size)) <= flat_threshold_degrees:
                gentle += 1

    return gentle / total if total else 0.0


def sample_height(spec: TerrainSpec, heights: list[list[float]], x: float, y: float) -> float:
    """Bilinearly sample the heightfield at a world position."""
    half = spec.size_metres / 2.0
    fx = (x + half) / spec.cell_size
    fy = (y + half) / spec.cell_size

    column = max(0, min(spec.resolution - 2, int(fx)))
    row = max(0, min(spec.resolution - 2, int(fy)))
    tx = max(0.0, min(1.0, fx - column))
    ty = max(0.0, min(1.0, fy - row))

    h00 = heights[row][column]
    h10 = heights[row][column + 1]
    h01 = heights[row + 1][column]
    h11 = heights[row + 1][column + 1]

    return (
        h00 * (1 - tx) * (1 - ty)
        + h10 * tx * (1 - ty)
        + h01 * (1 - tx) * ty
        + h11 * tx * ty
    )


def to_mesh(spec: TerrainSpec, heights: list[list[float]]) -> MeshData:
    """Build the terrain mesh from a heightfield."""
    name = units.asset_name(units.PREFIX_STATIC_MESH, "Terrain", spec.name)
    mesh = MeshData(name=name)
    half = spec.size_metres / 2.0

    for row in range(spec.resolution):
        y = row * spec.cell_size - half
        for column in range(spec.resolution):
            x = column * spec.cell_size - half
            mesh.add_vertex((x, y, heights[row][column]))

    uv_scale = spec.size_metres
    for row in range(spec.resolution - 1):
        for column in range(spec.resolution - 1):
            a = row * spec.resolution + column
            b = a + 1
            c = a + spec.resolution + 1
            d = a + spec.resolution

            u0 = column * spec.cell_size / uv_scale
            u1 = (column + 1) * spec.cell_size / uv_scale
            v0 = row * spec.cell_size / uv_scale
            v1 = (row + 1) * spec.cell_size / uv_scale

            mesh.add_face((a, b, c, d), [(u0, v0), (u1, v0), (u1, v1), (u0, v1)])

    return mesh


@dataclass(frozen=True)
class ScatterPoint:
    kind: str
    x: float
    y: float
    z: float
    yaw_degrees: float
    variant: int


def scatter(
    spec: TerrainSpec,
    heights: list[list[float]],
    kinds: tuple[tuple[str, int], ...] = (("Tree", 120), ("Rock", 60)),
    min_spacing: float = 6.0,
    max_slope_degrees_for_props: float = 25.0,
) -> list[ScatterPoint]:
    """Place harvestable props across the terrain.

    Uses dart-throwing with a spacing constraint rather than pure random
    placement, because clumps of overlapping trees look like a bug and leave
    the rest of the map bare.
    """
    rng = seeded(spec.seed + ":scatter")
    half = spec.size_metres / 2.0
    placed: list[ScatterPoint] = []
    spacing_squared = min_spacing * min_spacing

    for kind, count in kinds:
        attempts = 0
        made = 0
        # Bounded so a too-tight spacing fails fast rather than hanging.
        while made < count and attempts < count * 60:
            attempts += 1
            # Inset from the shoreline so props are not half-submerged.
            x = rng.uniform(-half * 0.88, half * 0.88)
            y = rng.uniform(-half * 0.88, half * 0.88)
            z = sample_height(spec, heights, x, y)

            if z < 0.5:
                continue

            local_slope = _local_slope_degrees(spec, heights, x, y)
            if local_slope > max_slope_degrees_for_props:
                continue

            if any(
                (point.x - x) ** 2 + (point.y - y) ** 2 < spacing_squared
                for point in placed
            ):
                continue

            placed.append(
                ScatterPoint(
                    kind=kind,
                    x=round(x, 3),
                    y=round(y, 3),
                    z=round(z, 3),
                    yaw_degrees=round(rng.uniform(0.0, 360.0), 2),
                    variant=rng.randint(0, 2),
                )
            )
            made += 1

    return placed


def _local_slope_degrees(
    spec: TerrainSpec, heights: list[list[float]], x: float, y: float
) -> float:
    step = spec.cell_size
    here = sample_height(spec, heights, x, y)
    dx = abs(sample_height(spec, heights, x + step, y) - here)
    dy = abs(sample_height(spec, heights, x, y + step) - here)
    return math.degrees(math.atan2(max(dx, dy), step))


def generate_all() -> dict[str, MeshData]:
    """The terrain meshes. One for now; Nightfall Isle's chunks arrive at M5."""
    heights = heightfield(TEST_ISLAND)
    mesh = to_mesh(TEST_ISLAND, heights)
    return {mesh.name: mesh}
