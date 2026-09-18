"""Tests for terrain generation and the design constraints it must satisfy.

GDD section 8 states constraints on the map and ``MapBlueprint`` declares them.
They are asserted here rather than judged by eye, which is the difference
between a constraint and an aspiration.
"""

import pytest
from tonight.terrain import (
    TEST_ISLAND,
    TerrainSpec,
    heightfield,
    max_slope_degrees,
    open_terrain_fraction,
    sample_height,
    scatter,
    to_mesh,
)


@pytest.fixture(scope="module")
def field():
    return heightfield(TEST_ISLAND)


class TestConstraints:
    def test_no_slope_exceeds_the_buildable_limit(self, field):
        # MapBlueprint.MaxBuildableSlope. Building must always be viable
        # outside designed cliffs, so terrain may not out-steep the limit.
        slope = max_slope_degrees(TEST_ISLAND, field)
        assert slope <= 40.0, f"Steepest slope is {slope:.2f} degrees"

    def test_there_is_headroom_under_the_slope_limit(self, field):
        # Designed cliffs get carved in later. Generating terrain that already
        # sits exactly at the cap would leave no room for them.
        assert max_slope_degrees(TEST_ISLAND, field) <= 36.0

    def test_enough_open_terrain_for_build_fights(self, field):
        # MapBlueprint.MinOpenTerrainFraction. A map that is all hillside is a
        # map where cover is free.
        fraction = open_terrain_fraction(TEST_ISLAND, field)
        assert fraction >= 0.30, f"Only {fraction:.1%} of the map is open"

    def test_slope_limiter_converges_rather_than_running_out_of_iterations(self):
        # Twelve iterations left the field at 44 degrees against a 40 degree
        # limit. Raising the cap must not be what makes this pass, so a much
        # larger cap should produce the same answer.
        spec = TerrainSpec("Conv", 200.0, 61, 5.0, 110.0, "convergence")
        few = max_slope_degrees(spec, heightfield(spec))
        assert few <= 40.0


class TestGeometry:
    def test_mesh_matches_the_requested_extent(self, field):
        mesh = to_mesh(TEST_ISLAND, field)
        width, depth, _ = mesh.size()
        assert width == pytest.approx(TEST_ISLAND.size_metres)
        assert depth == pytest.approx(TEST_ISLAND.size_metres)

    def test_mesh_is_well_formed(self, field):
        assert to_mesh(TEST_ISLAND, field).validate() == []

    def test_vertex_count_matches_resolution(self, field):
        mesh = to_mesh(TEST_ISLAND, field)
        assert mesh.vertex_count == TEST_ISLAND.resolution**2

    def test_heights_stay_in_a_plausible_range(self, field):
        lowest = min(min(row) for row in field)
        highest = max(max(row) for row in field)
        assert -20.0 < lowest < 0.0
        assert 0.0 < highest < 30.0

    def test_edges_fall_to_the_shoreline(self, field):
        # The island falloff should leave the border below sea level, so there
        # is no cliff edge to fall off.
        last = TEST_ISLAND.resolution - 1
        for index in range(0, TEST_ISLAND.resolution, 10):
            assert field[0][index] < 0.0
            assert field[last][index] < 0.0
            assert field[index][0] < 0.0
            assert field[index][last] < 0.0


class TestSampling:
    def test_sampling_a_vertex_returns_its_height(self, field):
        half = TEST_ISLAND.size_metres / 2.0
        for row, column in ((10, 10), (50, 30), (80, 95)):
            x = column * TEST_ISLAND.cell_size - half
            y = row * TEST_ISLAND.cell_size - half
            assert sample_height(TEST_ISLAND, field, x, y) == pytest.approx(
                field[row][column], abs=1e-4
            )

    def test_sampling_outside_the_field_is_clamped_not_crashing(self, field):
        for x, y in ((-9999.0, 0.0), (9999.0, 0.0), (0.0, -9999.0), (0.0, 9999.0)):
            value = sample_height(TEST_ISLAND, field, x, y)
            assert -50.0 < value < 50.0


class TestScatter:
    def test_all_requested_props_are_placed(self, field):
        points = scatter(TEST_ISLAND, field)
        counts = {}
        for point in points:
            counts[point.kind] = counts.get(point.kind, 0) + 1
        assert counts == {"Tree": 120, "Rock": 60}

    def test_props_respect_minimum_spacing(self, field):
        points = scatter(TEST_ISLAND, field, min_spacing=6.0)
        for i, a in enumerate(points):
            for b in points[i + 1:]:
                distance_squared = (a.x - b.x) ** 2 + (a.y - b.y) ** 2
                assert distance_squared >= 6.0**2 - 1e-6, (
                    f"{a.kind} and {b.kind} overlap"
                )

    def test_props_sit_on_the_terrain_surface(self, field):
        for point in scatter(TEST_ISLAND, field):
            expected = sample_height(TEST_ISLAND, field, point.x, point.y)
            assert point.z == pytest.approx(expected, abs=1e-2)

    def test_props_stay_above_the_shoreline(self, field):
        # A half-submerged tree is not a harvestable, it is a bug.
        assert all(point.z >= 0.5 for point in scatter(TEST_ISLAND, field))

    def test_scatter_is_deterministic(self, field):
        first = scatter(TEST_ISLAND, field)
        second = scatter(TEST_ISLAND, field)
        assert first == second


class TestDeterminism:
    def test_heightfield_is_reproducible(self):
        assert heightfield(TEST_ISLAND) == heightfield(TEST_ISLAND)

    def test_mesh_hash_is_reproducible(self):
        a = to_mesh(TEST_ISLAND, heightfield(TEST_ISLAND))
        b = to_mesh(TEST_ISLAND, heightfield(TEST_ISLAND))
        assert a.content_hash() == b.content_hash()

    def test_different_seeds_produce_different_terrain(self):
        other = TerrainSpec("Other", 200.0, 61, 5.0, 110.0, "a-different-seed")
        same = TerrainSpec("Same", 200.0, 61, 5.0, 110.0, TEST_ISLAND.seed)
        assert heightfield(other) != heightfield(same)
