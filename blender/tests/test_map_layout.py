"""Tests for Nightfall Isle's layout against the GDD section 8 constraints.

The M5 exit criterion is that the map satisfies its constraints "verified by a
tooling check, not by eye". These are that check.
"""

import math
from dataclasses import replace

import pytest
from tonight.map_layout import (
    MIN_POI_HEIGHT,
    PoiPlacement,
    NIGHTFALL_ISLE,
    NIGHTFALL_TERRAIN,
    nearest_neighbour_distances,
    place_pois,
    summarise,
    validate_map,
)
from tonight.terrain import heightfield, max_slope_degrees, open_terrain_fraction


@pytest.fixture(scope="module")
def field():
    return heightfield(NIGHTFALL_TERRAIN)


@pytest.fixture(scope="module")
def pois(field):
    return place_pois(NIGHTFALL_ISLE, NIGHTFALL_TERRAIN, field)


class TestConstraints:
    def test_the_map_validates(self, field, pois):
        problems = validate_map(NIGHTFALL_ISLE, NIGHTFALL_TERRAIN, field, pois)
        assert problems == [], "\n".join(problems)

    def test_poi_counts_match_the_gdd(self, pois):
        counts = {}
        for poi in pois:
            counts[poi.tier] = counts.get(poi.tier, 0) + 1
        assert counts == {"Major": 5, "Minor": 12, "Landmark": 8}

    def test_no_poi_is_stranded_beyond_the_separation_limit(self, pois):
        # A player who lands badly must reach loot before the first close.
        worst = max(nearest_neighbour_distances(pois))
        assert worst <= NIGHTFALL_ISLE.max_poi_separation, (
            f"Worst nearest-neighbour distance is {worst:.0f} m"
        )

    def test_terrain_stays_under_the_buildable_slope_limit(self, field):
        slope = max_slope_degrees(NIGHTFALL_TERRAIN, field)
        assert slope <= NIGHTFALL_ISLE.max_buildable_slope, f"{slope:.2f} degrees"

    def test_enough_open_terrain_for_build_fights(self, field):
        fraction = open_terrain_fraction(NIGHTFALL_TERRAIN, field)
        assert fraction >= NIGHTFALL_ISLE.min_open_terrain_fraction, f"{fraction:.1%}"

    def test_the_map_is_not_trivially_flat(self, field):
        # A field that satisfies the constraints by being featureless would pass
        # every check above and make a dull map.
        slope = max_slope_degrees(NIGHTFALL_TERRAIN, field)
        assert slope >= 20.0, f"Only {slope:.1f} degrees of maximum slope"

    def test_every_poi_is_above_the_water_line(self, pois):
        for poi in pois:
            assert poi.z >= MIN_POI_HEIGHT, f"{poi.name} is at {poi.z} m"

    def test_every_poi_is_inside_the_map(self, pois):
        half = NIGHTFALL_ISLE.size_metres / 2.0
        for poi in pois:
            assert abs(poi.x) <= half
            assert abs(poi.y) <= half


class TestValidatorCatchesProblems:
    """The validator must fail on bad maps, or passing means nothing."""

    def test_a_stranded_poi_is_reported(self, field):
        """A sparse synthetic layout, not the real one.

        Moving a single POI to the map corner is not enough to trip the
        constraint -- with 25 POIs spread over 1400 m the furthest any corner
        can be from its nearest neighbour is about 369 m, comfortably under the
        450 m limit. Testing the rule needs a layout that actually breaks it.
        """
        spec = replace(
            NIGHTFALL_ISLE, major_count=2, minor_count=0, landmark_count=0
        )
        sparse = [
            PoiPlacement("Major00", "Major", -600.0, -600.0, 30.0, 110.0),
            PoiPlacement("Major01", "Major", 600.0, 600.0, 30.0, 110.0),
        ]

        problems = validate_map(spec, NIGHTFALL_TERRAIN, field, sparse)
        assert any("nearest neighbour" in p for p in problems), problems

    def test_a_submerged_poi_is_reported(self, field, pois):
        broken = list(pois)
        broken[0] = replace(broken[0], z=-5.0)

        problems = validate_map(NIGHTFALL_ISLE, NIGHTFALL_TERRAIN, field, broken)
        assert any("water line" in p for p in problems)

    def test_a_wrong_poi_count_is_reported(self, field, pois):
        problems = validate_map(NIGHTFALL_ISLE, NIGHTFALL_TERRAIN, field, list(pois)[:-1])
        assert any("Expected" in p for p in problems)


class TestDeterminism:
    def test_placement_is_reproducible(self, field):
        assert place_pois(NIGHTFALL_ISLE, NIGHTFALL_TERRAIN, field) == place_pois(
            NIGHTFALL_ISLE, NIGHTFALL_TERRAIN, field
        )

    def test_summary_reports_the_key_numbers(self, field, pois):
        summary = summarise(NIGHTFALL_ISLE, NIGHTFALL_TERRAIN, field, pois)
        assert summary["poiCount"] == 25
        assert summary["maxNearestNeighbour"] <= summary["separationLimit"]
        assert summary["openTerrainFraction"] >= summary["openTerrainMinimum"]


class TestSpacing:
    def test_pois_do_not_overlap_each_other(self, pois):
        for i, a in enumerate(pois):
            for b in pois[i + 1:]:
                distance = math.dist((a.x, a.y), (b.x, b.y))
                # A scoring bug once let this fall to 4 m by short-circuiting
                # the clearance check entirely, so the bar is set well above
                # "not literally overlapping".
                assert distance > 100.0, (
                    f"{a.name} and {b.name} are only {distance:.1f} m apart"
                )
