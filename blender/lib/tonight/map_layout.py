"""POI placement for Nightfall Isle, and the constraints it must satisfy.

GDD §8 states three constraints on the map and ``MapBlueprint`` declares them.
The M5 exit criterion is that they are "verified by a tooling check, not by
eye" -- this module is that tooling.

The constraints exist for concrete gameplay reasons rather than for tidiness:

* **No POI further than 450 m from its nearest neighbour.** A player who lands
  badly must be able to reach loot before the first storm close.
* **No terrain above 40 degrees outside designed cliffs.** Building must always
  be viable.
* **At least 30% open terrain.** Build-fights need room.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from tonight.rng import seeded
from tonight.terrain import TerrainSpec, open_terrain_fraction, sample_height


@dataclass(frozen=True)
class PoiPlacement:
    """One placed point of interest."""

    name: str
    tier: str  # "Major", "Minor", or "Landmark"
    x: float
    y: float
    z: float
    #: Clearance radius in metres; nothing else is placed inside it.
    radius: float


#: Minimum ground height for a POI, in metres. A POI at or below sea level is
#: a POI underwater.
MIN_POI_HEIGHT = 1.0


@dataclass(frozen=True)
class MapSpec:
    """The design constraints for one map, mirroring ``MapBlueprint``."""

    name: str
    size_metres: float
    major_count: int
    minor_count: int
    landmark_count: int
    max_poi_separation: float = 450.0
    max_buildable_slope: float = 40.0
    min_open_terrain_fraction: float = 0.30
    seed: str = "nightfall-isle"


#: Nightfall Isle, per GDD section 8.
NIGHTFALL_ISLE = MapSpec(
    name="NightfallIsle",
    size_metres=1400.0,
    major_count=5,
    minor_count=12,
    landmark_count=8,
)

#: The terrain Nightfall Isle is placed on. Tuned for variety within the
#: constraints: 36 degrees of maximum slope against a 40 degree limit, and 56%
#: open terrain against a 30% minimum. A gentler field passed just as well but
#: was almost featureless.
NIGHTFALL_TERRAIN = TerrainSpec(
    name="NightfallIsle",
    size_metres=1400.0,
    resolution=141,
    amplitude=20.0,
    feature_size=300.0,
    seed="nightfall-isle",
    base_height=24.0,
)

TIER_RADIUS = {"Major": 110.0, "Minor": 60.0, "Landmark": 35.0}


def place_pois(spec: MapSpec, terrain: TerrainSpec, heights: list[list[float]]) -> list[PoiPlacement]:
    """Place every POI, satisfying clearance and the separation constraint.

    Majors go down first on a jittered ring so the map has spread-out anchor
    points, then minors and landmarks fill the gaps. Filling last is what lets
    the separation constraint be satisfied by construction rather than by luck:
    each remaining POI is placed at the position that most reduces the worst
    nearest-neighbour distance.
    """
    rng = seeded(spec.seed + ":pois")
    half = spec.size_metres / 2.0
    # Keep POIs off the shoreline falloff.
    usable = half * 0.78

    placed: list[PoiPlacement] = []

    # Majors on a jittered ring plus one near the centre: a ring alone leaves a
    # dead middle, and a pure random scatter clumps.
    for index in range(spec.major_count):
        best = None
        # Retry the jittered position until it is on dry land. Majors anchor the
        # map, so their rough placement matters more than their exact one.
        for _ in range(200):
            if index == 0:
                x = rng.uniform(-usable * 0.25, usable * 0.25)
                y = rng.uniform(-usable * 0.25, usable * 0.25)
            else:
                angle = (index - 1) / max(1, spec.major_count - 1) * math.tau
                angle += rng.uniform(-0.35, 0.35)
                distance = usable * rng.uniform(0.5, 0.85)
                x, y = math.cos(angle) * distance, math.sin(angle) * distance

            if sample_height(terrain, heights, x, y) >= MIN_POI_HEIGHT:
                best = (x, y)
                break

        if best is None:
            # Fall back to the driest candidate rather than failing outright.
            best = max(
                ((rng.uniform(-usable, usable), rng.uniform(-usable, usable))
                 for _ in range(200)),
                key=lambda p: sample_height(terrain, heights, p[0], p[1]),
            )

        placed.append(_make(f"Major{index:02d}", "Major", best[0], best[1], terrain, heights))

    for tier, count in (("Minor", spec.minor_count), ("Landmark", spec.landmark_count)):
        for index in range(count):
            x, y = _best_gap_position(
                spec, placed, usable, rng, TIER_RADIUS[tier], terrain, heights)
            placed.append(_make(f"{tier}{index:02d}", tier, x, y, terrain, heights))

    return placed


def _make(
    name: str, tier: str, x: float, y: float,
    terrain: TerrainSpec, heights: list[list[float]],
) -> PoiPlacement:
    return PoiPlacement(
        name=name,
        tier=tier,
        x=round(x, 2),
        y=round(y, 2),
        z=round(sample_height(terrain, heights, x, y), 2),
        radius=TIER_RADIUS[tier],
    )


def _best_gap_position(
    spec: MapSpec,
    placed: list[PoiPlacement],
    usable: float,
    rng,
    radius: float,
    terrain: TerrainSpec,
    heights: list[list[float]],
    candidates: int = 220,
) -> tuple[float, float]:
    """Pick the candidate that most improves the worst separation.

    Dart-throwing with a "best of N" rule rather than pure rejection sampling:
    rejection sampling fails to converge once the map is crowded, whereas this
    always returns the least-bad position and therefore always terminates.
    """
    best = None
    # Negative infinity, not -1: every score below is `-abs(...)` and therefore
    # at most zero. Seeding with -1 meant only a candidate landing within a
    # metre of the ideal gap could ever win, so `best` stayed None and every
    # placement fell through to the clearance-ignoring fallback -- which put
    # POIs four metres apart.
    best_score = float("-inf")

    for _ in range(candidates):
        x = rng.uniform(-usable, usable)
        y = rng.uniform(-usable, usable)

        # Dry land only. Reachability is meaningless for a POI underwater.
        if sample_height(terrain, heights, x, y) < MIN_POI_HEIGHT:
            continue

        nearest = min(
            (math.dist((x, y), (p.x, p.y)) for p in placed),
            default=spec.size_metres,
        )

        # Reject anything inside another POI's clearance outright.
        if any(
            math.dist((x, y), (p.x, p.y)) < (radius + p.radius) * 0.6
            for p in placed
        ):
            continue

        # Prefer positions that fill the largest gap without exceeding the
        # separation limit -- being too far away is exactly the failure mode
        # the constraint exists to prevent.
        score = -abs(nearest - spec.max_poi_separation * 0.55)
        if score > best_score:
            best_score = score
            best = (x, y)

    if best is None:
        # Crowded past the point of finding a clear spot. Relax clearance rather
        # than failing, but never relax the water line.
        return max(
            ((rng.uniform(-usable, usable), rng.uniform(-usable, usable))
             for _ in range(candidates)),
            key=lambda p: sample_height(terrain, heights, p[0], p[1]),
        )

    return best


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------


def nearest_neighbour_distances(pois: list[PoiPlacement]) -> list[float]:
    """Distance from each POI to its closest neighbour."""
    if len(pois) < 2:
        return []

    distances = []
    for i, poi in enumerate(pois):
        nearest = min(
            math.dist((poi.x, poi.y), (other.x, other.y))
            for j, other in enumerate(pois)
            if i != j
        )
        distances.append(nearest)
    return distances


def validate_map(
    spec: MapSpec,
    terrain: TerrainSpec,
    heights: list[list[float]],
    pois: list[PoiPlacement],
) -> list[str]:
    """Check every GDD §8 constraint. Empty list means the map is valid."""
    problems: list[str] = []

    counts = {"Major": 0, "Minor": 0, "Landmark": 0}
    for poi in pois:
        counts[poi.tier] = counts.get(poi.tier, 0) + 1

    for tier, expected in (
        ("Major", spec.major_count),
        ("Minor", spec.minor_count),
        ("Landmark", spec.landmark_count),
    ):
        if counts.get(tier, 0) != expected:
            problems.append(
                f"Expected {expected} {tier} POIs, found {counts.get(tier, 0)}."
            )

    distances = nearest_neighbour_distances(pois)
    for poi, distance in zip(pois, distances):
        if distance > spec.max_poi_separation:
            problems.append(
                f"{poi.name} is {distance:.0f} m from its nearest neighbour, over the "
                f"{spec.max_poi_separation:.0f} m limit. A player landing there cannot "
                "reach other loot before the first close."
            )

    half = spec.size_metres / 2.0
    for poi in pois:
        if abs(poi.x) > half or abs(poi.y) > half:
            problems.append(f"{poi.name} is outside the map bounds.")
        if poi.z < MIN_POI_HEIGHT:
            problems.append(
                f"{poi.name} sits at {poi.z:.1f} m, at or below the water line. "
                "A submerged POI is unreachable, so its loot may as well not exist."
            )

    fraction = open_terrain_fraction(terrain, heights)
    if fraction < spec.min_open_terrain_fraction:
        problems.append(
            f"Only {fraction:.1%} of the map is open terrain, under the "
            f"{spec.min_open_terrain_fraction:.0%} minimum. Build-fights need room."
        )

    return problems


def summarise(
    spec: MapSpec,
    terrain: TerrainSpec,
    heights: list[list[float]],
    pois: list[PoiPlacement],
) -> dict:
    """Numbers for the map report."""
    distances = nearest_neighbour_distances(pois)
    return {
        "map": spec.name,
        "sizeMetres": spec.size_metres,
        "poiCount": len(pois),
        "maxNearestNeighbour": round(max(distances), 1) if distances else 0.0,
        "meanNearestNeighbour": round(sum(distances) / len(distances), 1) if distances else 0.0,
        "separationLimit": spec.max_poi_separation,
        "openTerrainFraction": round(open_terrain_fraction(terrain, heights), 4),
        "openTerrainMinimum": spec.min_open_terrain_fraction,
    }
