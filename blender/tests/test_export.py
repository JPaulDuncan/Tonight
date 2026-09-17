"""Tests for export path resolution, pre-export checks, and the manifest."""

import json
from pathlib import Path

import pytest
from tonight import units
from tonight.export import (
    build_record,
    category_for,
    check_before_export,
    diff_manifests,
    export_path,
    read_manifest,
    write_manifest,
)
from tonight.mesh import box


class TestCategoryResolution:
    @pytest.mark.parametrize(
        "name,expected",
        [
            ("SM_Build_Wall_Wood", "build"),
            ("SM_Weapon_Sniper", "weapon"),
            ("SM_Harvest_Tree_00", "harvest"),
            ("SM_Tool_Pickaxe", "tool"),
        ],
    )
    def test_known_categories_resolve(self, name, expected):
        assert category_for(name) == expected

    def test_unknown_category_is_rejected_rather_than_guessed(self):
        # A silently miscategorised asset lands in the wrong folder with the
        # wrong import settings, and nobody notices until it renders wrong.
        with pytest.raises(ValueError, match="unknown category"):
            category_for("SM_Nonsense_Thing")

    def test_malformed_name_is_rejected(self):
        with pytest.raises(ValueError, match="PREFIX_Category_Name"):
            category_for("JustAName")

    def test_weapons_and_tools_share_a_folder(self):
        assert export_path("SM_Weapon_Sniper").parent == export_path("SM_Tool_Pickaxe").parent


class TestAssetNaming:
    def test_valid_name_is_assembled(self):
        assert units.asset_name("SM", "Build", "Wall", "Wood") == "SM_Build_Wall_Wood"

    def test_unknown_prefix_is_rejected(self):
        with pytest.raises(ValueError, match="Unknown asset prefix"):
            units.asset_name("XX", "Thing")

    def test_empty_part_is_rejected(self):
        with pytest.raises(ValueError, match="Empty name part"):
            units.asset_name("SM", "Build", "")

    def test_underscore_in_a_part_is_rejected(self):
        # Otherwise the convention stops being parseable back into its parts.
        with pytest.raises(ValueError, match="contains an underscore"):
            units.asset_name("SM", "Build_Wall")

    def test_prefix_alone_is_rejected(self):
        with pytest.raises(ValueError, match="at least one part"):
            units.asset_name("SM")


class TestPreExportChecks:
    def test_a_good_mesh_passes(self):
        assert check_before_export(box((4.0, 0.2, 4.0), name="SM_Build_Wall_Wood")) == []

    def test_a_unit_error_is_caught(self):
        # Almost always a metres/centimetres mix-up, which is the single most
        # common way a pipeline produces art that is wrong in the engine.
        huge = box((4000.0, 0.2, 4.0), name="SM_Build_Wall_Wood")
        assert any("unit error" in problem for problem in check_before_export(huge))

    def test_a_degenerate_mesh_is_caught(self):
        flat = box((0.0, 0.0, 0.0), name="SM_Build_Wall_Wood")
        assert check_before_export(flat) != []

    def test_a_badly_named_mesh_is_caught(self):
        mesh = box((1.0, 1.0, 1.0), name="untitled")
        assert any("PREFIX_Category_Name" in problem for problem in check_before_export(mesh))


class TestManifest:
    def test_manifest_paths_are_repository_relative(self, tmp_path):
        # An absolute path would make the manifest machine-dependent, so every
        # contributor's diff would show every asset changing.
        record = build_record(box((4.0, 0.2, 4.0), name="SM_Build_Wall_Wood"))
        assert not Path(record.relative_path).is_absolute()
        assert record.relative_path.startswith("blender/exports/")

    def test_manifest_round_trips(self, tmp_path):
        records = [
            build_record(box((4.0, 0.2, 4.0), name="SM_Build_Wall_Wood")),
            build_record(box((4.0, 4.0, 0.2), name="SM_Build_Floor_Wood")),
        ]
        path = tmp_path / "manifest.json"
        write_manifest(records, path)

        payload = read_manifest(path)
        assert payload["assetCount"] == 2
        assert {a["name"] for a in payload["assets"]} == {
            "SM_Build_Wall_Wood",
            "SM_Build_Floor_Wood",
        }

    def test_manifest_is_sorted_for_a_stable_diff(self, tmp_path):
        records = [
            build_record(box((1.0, 1.0, 1.0), name="SM_Weapon_Sniper")),
            build_record(box((1.0, 1.0, 1.0), name="SM_Build_Wall_Wood")),
        ]
        path = tmp_path / "manifest.json"
        write_manifest(records, path)

        names = [a["name"] for a in read_manifest(path)["assets"]]
        assert names == sorted(names)

    def test_manifest_write_is_byte_identical_for_identical_input(self, tmp_path):
        records = [build_record(box((4.0, 0.2, 4.0), name="SM_Build_Wall_Wood"))]
        first, second = tmp_path / "a.json", tmp_path / "b.json"
        write_manifest(records, first)
        write_manifest(records, second)
        assert first.read_bytes() == second.read_bytes()

    def test_diff_detects_added_removed_and_changed(self):
        old = {
            "assets": [
                {"name": "A", "content_hash": "1"},
                {"name": "B", "content_hash": "2"},
            ]
        }
        new = {
            "assets": [
                {"name": "A", "content_hash": "1"},
                {"name": "B", "content_hash": "99"},
                {"name": "C", "content_hash": "3"},
            ]
        }

        diff = diff_manifests(old, new)
        assert diff["added"] == ["C"]
        assert diff["removed"] == []
        assert diff["changed"] == ["B"]

    def test_diff_of_identical_manifests_is_empty(self):
        manifest = {"assets": [{"name": "A", "content_hash": "1"}]}
        diff = diff_manifests(manifest, manifest)
        assert diff == {"added": [], "removed": [], "changed": []}


class TestBlenderGuard:
    def test_the_library_imports_without_blender(self):
        # The whole point of the lib/scripts split (ADR-0004): geometry logic
        # must be testable in ordinary CI with no Blender install.
        import tonight
        import tonight.build_pieces
        import tonight.export
        import tonight.harvestables
        import tonight.mesh
        import tonight.weapons

        assert tonight.__version__

    def test_the_adapter_fails_with_a_useful_message(self):
        from tonight.blender_adapter import HAS_BPY, require_bpy

        if HAS_BPY:
            pytest.skip("Running inside Blender; the guard does not apply.")

        with pytest.raises(RuntimeError, match="blender --background"):
            require_bpy()
