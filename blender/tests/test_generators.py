"""Tests for the asset generators.

These assert the properties that matter to the game: pieces are exactly one
cell, weapon silhouettes are distinguishable, and generation is deterministic.
"""

import pytest
from tonight import units
from tonight.build_pieces import (
    MASK_DOORWAY,
    MASK_SOLID,
    MASK_WINDOW,
    MATERIALS,
    cone,
    floor,
    generate_all as generate_build,
    ramp,
    wall,
    wall_variant,
)
from tonight.harvestables import generate_all as generate_harvest, rock, tree, vehicle
from tonight.weapons import PISTOL, SNIPER, SMG, WEAPONS, firearm, generate_all as generate_weapons


class TestBuildPieces:
    @pytest.mark.parametrize("style", MATERIALS, ids=lambda s: s.key)
    def test_wall_spans_exactly_one_cell_horizontally(self, style):
        width, _, _ = wall(style).size()
        assert width == pytest.approx(units.CELL_SIZE)

    @pytest.mark.parametrize("style", MATERIALS, ids=lambda s: s.key)
    def test_wall_is_tall_enough_to_cover_a_character(self, style):
        _, _, height = wall(style).size()
        assert height > units.CHARACTER_HEIGHT

    @pytest.mark.parametrize("style", MATERIALS, ids=lambda s: s.key)
    def test_wall_skirt_hangs_below_the_cell(self, style):
        # The skirt is what stops a visible gap where a wall meets sloped
        # terrain (ADR-0006).
        low, _ = wall(style, with_skirt=True).bounds()
        assert low[2] == pytest.approx(-units.SKIRT_DEPTH)

        low_flat, _ = wall(style, with_skirt=False).bounds()
        assert low_flat[2] == pytest.approx(0.0)

    @pytest.mark.parametrize("style", MATERIALS, ids=lambda s: s.key)
    def test_floor_spans_exactly_one_cell(self, style):
        width, depth, _ = floor(style).size()
        assert width == pytest.approx(units.CELL_SIZE)
        assert depth == pytest.approx(units.CELL_SIZE)

    @pytest.mark.parametrize("style", MATERIALS, ids=lambda s: s.key)
    def test_ramp_and_cone_fill_exactly_one_cell(self, style):
        for mesh in (ramp(style), cone(style)):
            for extent in mesh.size():
                assert extent == pytest.approx(units.CELL_SIZE), f"{mesh.name} is not cell-sized"

    def test_materials_produce_visually_distinct_geometry(self):
        # Material is not only a texture swap. Identical geometry across
        # materials would mean three assets doing one asset's job.
        for generator in (wall, floor, ramp, cone):
            hashes = {generator(style).content_hash() for style in MATERIALS}
            assert len(hashes) == len(MATERIALS), (
                f"{generator.__name__} produced identical geometry for different materials"
            )

    def test_stone_is_thicker_than_metal(self):
        _, stone_depth, _ = wall(MATERIALS[1]).size()
        _, metal_depth, _ = wall(MATERIALS[2]).size()
        assert stone_depth > metal_depth


class TestEditVariants:
    def test_doorway_and_window_differ(self):
        style = MATERIALS[0]
        doorway = wall_variant(style, MASK_DOORWAY, "Doorway")
        window = wall_variant(style, MASK_WINDOW, "Window")
        assert doorway.content_hash() != window.content_hash()

    def test_doorway_removes_more_geometry_than_a_window(self):
        style = MATERIALS[0]
        doorway = wall_variant(style, MASK_DOORWAY, "Doorway")
        window = wall_variant(style, MASK_WINDOW, "Window")
        assert doorway.vertex_count < window.vertex_count

    def test_doorway_opening_reaches_the_ground(self):
        # A doorway whose opening floated above the floor would be a window
        # with extra steps. Mask index 7 is bottom-middle; it must be cut.
        assert MASK_DOORWAY[7] is False
        assert MASK_WINDOW[7] is True

    def test_solid_mask_spans_the_full_cell(self):
        mesh = wall_variant(MATERIALS[0], MASK_SOLID, "Solid")
        width, _, height = mesh.size()
        assert width == pytest.approx(units.CELL_SIZE)
        assert height == pytest.approx(units.CELL_SIZE)

    def test_wrong_length_mask_is_rejected(self):
        with pytest.raises(ValueError, match="exactly 9 entries"):
            wall_variant(MATERIALS[0], (True, False), "Broken")

    def test_empty_mask_is_rejected(self):
        with pytest.raises(ValueError, match="no filled cells"):
            wall_variant(MATERIALS[0], (False,) * 9, "Nothing")


class TestWeapons:
    @pytest.mark.parametrize("proportions", WEAPONS, ids=lambda p: p.key)
    def test_weapons_are_plausibly_sized(self, proportions):
        length, width, height = firearm(proportions).size()
        assert 0.15 < length < 2.0, f"{proportions.key} is {length:.2f} m long"
        assert width < 0.30
        assert height < 0.60

    def test_silhouettes_are_distinguishable_by_length(self):
        # Pillar 3: a player must tell an SMG from a sniper at a glance, at
        # distance, in deep night. Length is most of that read.
        lengths = {p.key: firearm(p).size()[0] for p in WEAPONS}
        assert lengths["Sniper"] > lengths["AssaultRifle"] > lengths["Smg"] > lengths["Pistol"]

    def test_sniper_is_clearly_longer_than_every_other_class(self):
        sniper_length = firearm(SNIPER).size()[0]
        others = [firearm(p).size()[0] for p in WEAPONS if p is not SNIPER]
        assert sniper_length > max(others) * 1.2

    def test_smg_is_stubby_relative_to_the_rifle(self):
        assert firearm(SMG).size()[0] < 0.6

    def test_pistol_is_the_smallest(self):
        assert firearm(PISTOL).size()[0] == min(firearm(p).size()[0] for p in WEAPONS)

    def test_every_weapon_class_generates(self):
        meshes = generate_weapons()
        for proportions in WEAPONS:
            assert any(proportions.key in name for name in meshes)
        assert "SM_Tool_Pickaxe" in meshes


class TestHarvestables:
    def test_tree_variants_differ(self):
        hashes = {tree(v).content_hash() for v in range(5)}
        assert len(hashes) == 5, "Seeded variants produced duplicate trees"

    def test_rock_variants_differ(self):
        assert len({rock(v).content_hash() for v in range(5)}) == 5

    @pytest.mark.parametrize("variant", range(4))
    def test_trees_are_plausibly_sized(self, variant):
        _, _, height = tree(variant).size()
        assert 4.0 < height < 12.0

    @pytest.mark.parametrize("variant", range(4))
    def test_vehicles_are_car_sized(self, variant):
        length, width, height = vehicle(variant).size()
        assert 3.5 < length < 5.5
        assert 1.5 < width < 2.2
        assert 1.2 < height < 2.2

    def test_props_sit_on_the_ground_plane(self):
        # A prop whose origin is not at its base floats or sinks when placed.
        for mesh in (tree(0), rock(0), vehicle(0)):
            low, _ = mesh.bounds()
            assert low[2] == pytest.approx(0.0, abs=0.35), f"{mesh.name} does not sit on Z=0"


class TestDeterminism:
    """ADR-0004: re-running a generator must reproduce the same mesh."""

    def test_build_pieces_are_reproducible(self):
        first = {name: mesh.content_hash() for name, mesh in generate_build().items()}
        second = {name: mesh.content_hash() for name, mesh in generate_build().items()}
        assert first == second

    def test_harvestables_are_reproducible(self):
        first = {name: mesh.content_hash() for name, mesh in generate_harvest().items()}
        second = {name: mesh.content_hash() for name, mesh in generate_harvest().items()}
        assert first == second

    def test_weapons_are_reproducible(self):
        first = {name: mesh.content_hash() for name, mesh in generate_weapons().items()}
        second = {name: mesh.content_hash() for name, mesh in generate_weapons().items()}
        assert first == second

    def test_generators_do_not_share_rng_state(self):
        # Running one family alone must produce the same meshes as running it
        # as part of a full build, or build_all would not be reproducible.
        alone = tree(0).content_hash()
        generate_weapons()
        generate_build()
        assert tree(0).content_hash() == alone


class TestAllGeneratedAssets:
    def test_every_asset_is_well_formed(self):
        meshes = {**generate_build(), **generate_weapons(), **generate_harvest()}
        for name, mesh in meshes.items():
            assert mesh.validate() == [], f"{name} is malformed"
            assert mesh.vertex_count > 0
            assert mesh.face_count > 0

    def test_asset_names_are_unique_across_families(self):
        build = set(generate_build())
        weapon = set(generate_weapons())
        harvest = set(generate_harvest())
        assert not (build & weapon)
        assert not (build & harvest)
        assert not (weapon & harvest)

    def test_triangle_budget_is_respected(self):
        # Pillar 3 and the frame budget: 100 players plus thousands of build
        # pieces means individual assets stay cheap.
        meshes = {**generate_build(), **generate_weapons(), **generate_harvest()}
        for name, mesh in meshes.items():
            assert mesh.triangle_count < 500, f"{name} has {mesh.triangle_count} triangles"
