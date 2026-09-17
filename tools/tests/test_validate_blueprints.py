"""Tests for the Blueprint validator.

The validator exists to catch cross-asset problems that no single asset can
detect about itself, so the fixtures here are deliberately *pairs* of assets
that are each individually fine and wrong together.
"""

import textwrap

import pytest
from validate_blueprints import Severity, validate


def write_asset(root, name, body, *, with_meta=True, guid=None):
    """Write a minimal Unity .asset file with the given serialised fields.

    ``body`` is dedented and indented to Unity's two-space field level. It is
    assembled line by line rather than through a single dedent over an
    interpolated block, because dedent computes a common prefix across the
    whole string and multi-line interpolation destroys that prefix.
    """
    guid = guid or f"{abs(hash(name)):032x}"[:32]
    root.mkdir(parents=True, exist_ok=True)

    header = [
        "%YAML 1.1",
        "%TAG !u! tag:unity3d.com,2011:",
        "--- !u!114 &11400000",
        "MonoBehaviour:",
        "  m_ObjectHideFlags: 0",
        "  m_Script: {fileID: 11500000, "
        "guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}",
        f"  m_Name: {name}",
    ]

    field_lines = [
        "  " + line
        for line in textwrap.dedent(body).strip("\n").splitlines()
        if line.strip()
    ]

    asset = root / f"{name}.asset"
    asset.write_text("\n".join(header + field_lines) + "\n", encoding="utf-8")

    if with_meta:
        (root / f"{name}.asset.meta").write_text(
            f"fileFormatVersion: 2\nguid: {guid}\n", encoding="utf-8"
        )

    return asset


def errors(findings):
    return [f for f in findings if f.severity == Severity.ERROR]


def warnings(findings):
    return [f for f in findings if f.severity == Severity.WARNING]


class TestMissingRoot:
    def test_absent_root_warns_but_does_not_fail(self, tmp_path):
        findings, count = validate(tmp_path / "nope")
        assert count == 0
        assert errors(findings) == []
        assert warnings(findings)

    def test_empty_root_warns_that_it_is_expected_pre_production(self, tmp_path):
        tmp_path.joinpath("Blueprints").mkdir()
        findings, count = validate(tmp_path / "Blueprints")
        assert count == 0
        assert errors(findings) == []
        assert any("pre-production" in f.message for f in warnings(findings))


class TestBlueprintIds:
    def test_duplicate_ids_are_an_error(self, tmp_path):
        for name in ("BP_A", "BP_B"):
            write_asset(
                tmp_path,
                name,
                """
                _blueprintId: deadbeefdeadbeefdeadbeefdeadbeef
                _displayName: Thing
                """,
            )

        findings, count = validate(tmp_path)
        assert count == 2
        assert any("claimed by 2 assets" in f.message for f in errors(findings))

    def test_distinct_ids_pass(self, tmp_path):
        for name, blueprint_id in (("BP_A", "a" * 32), ("BP_B", "b" * 32)):
            write_asset(
                tmp_path,
                name,
                f"""
                _blueprintId: {blueprint_id}
                _displayName: Thing
                """,
            )

        findings, _ = validate(tmp_path)
        assert errors(findings) == []

    def test_empty_id_on_a_blueprint_is_an_error(self, tmp_path):
        write_asset(
            tmp_path,
            "BP_Broken",
            """
            _blueprintId:
            _displayName: Thing
            """,
        )

        findings, _ = validate(tmp_path)
        assert any("BlueprintId is empty" in f.message for f in errors(findings))

    def test_a_non_blueprint_asset_without_an_id_is_ignored(self, tmp_path):
        # A registry or a Unity settings asset legitimately has no BlueprintId.
        write_asset(tmp_path, "SomeSettings", "_someOtherField: 3")
        findings, _ = validate(tmp_path)
        assert errors(findings) == []


class TestRarityTiers:
    def _rarity(self, root, name, tier, blueprint_id):
        write_asset(
            root,
            name,
            f"""
            _blueprintId: {blueprint_id}
            _displayName: {name}
            _tier: {tier}
            _damageMultiplier: 1
            _lootWeight: 50
            """,
        )

    def test_duplicate_tiers_are_an_error(self, tmp_path):
        self._rarity(tmp_path, "BP_Rarity_Common", 0, "a" * 32)
        self._rarity(tmp_path, "BP_Rarity_Uncommon", 0, "b" * 32)

        findings, _ = validate(tmp_path)
        assert any("tier 0 is used by 2 assets" in f.message for f in errors(findings))

    def test_contiguous_tiers_pass(self, tmp_path):
        for tier in range(5):
            self._rarity(tmp_path, f"BP_Rarity_{tier}", tier, f"{tier}" * 32)

        findings, _ = validate(tmp_path)
        assert errors(findings) == []
        assert not any("contiguous" in f.message for f in warnings(findings))

    def test_a_gap_in_tiers_warns(self, tmp_path):
        # A gap makes a loot table's RarityBias skip a tier silently.
        for tier in (0, 1, 3):
            self._rarity(tmp_path, f"BP_Rarity_{tier}", tier, f"{tier}" * 32)

        findings, _ = validate(tmp_path)
        assert any("contiguous" in f.message for f in warnings(findings))


class TestStormPhaseContinuity:
    def _phase(self, root, index, start, end, wait=120, close=120):
        write_asset(
            root,
            f"BP_Storm_Phase{index}",
            f"""
            _blueprintId: {index}{'0' * 31}
            _displayName: Phase {index}
            _phaseIndex: {index}
            _waitSeconds: {wait}
            _closeSeconds: {close}
            _startRadius: {start}
            _endRadius: {end}
            _damagePerSecond: 1
            """,
        )

    def test_a_radius_gap_is_an_error(self, tmp_path):
        # Each individually valid; together they teleport the circle.
        self._phase(tmp_path, 0, 1400, 900)
        self._phase(tmp_path, 1, 600, 400)

        findings, _ = validate(tmp_path)
        assert any("teleport" in f.message for f in errors(findings))

    def test_continuous_phases_pass(self, tmp_path):
        self._phase(tmp_path, 0, 1400, 900, wait=165, close=120)
        self._phase(tmp_path, 1, 900, 600, wait=90, close=90)
        self._phase(tmp_path, 2, 600, 400, wait=75, close=70)
        self._phase(tmp_path, 3, 400, 250, wait=60, close=55)

        findings, _ = validate(tmp_path)
        assert errors(findings) == []

    def test_the_gdd_schedule_is_continuous_and_the_right_length(self, tmp_path):
        """The shipped defaults from GDD section 7, re-derived rather than trusted.

        This test is why the GDD's storm table is correct: the original draft
        totalled 24.7 minutes beside a stated 16-18 minute target, and nothing
        but arithmetic was going to catch that.
        """
        schedule = [
            (0, 1400, 900, 165, 120),
            (1, 900, 600, 90, 90),
            (2, 600, 400, 75, 70),
            (3, 400, 250, 60, 55),
            (4, 250, 150, 45, 45),
            (5, 150, 80, 35, 35),
            (6, 80, 30, 30, 30),
            (7, 30, 0, 20, 35),
        ]
        for index, start, end, wait, close in schedule:
            self._phase(tmp_path, index, start, end, wait=wait, close=close)

        findings, _ = validate(tmp_path)
        assert errors(findings) == []
        assert not any("minutes" in f.message for f in warnings(findings))

        total = sum(wait + close for _, _, _, wait, close in schedule)
        assert total == 1000, f"GDD storm schedule totals {total}s, expected 1000s"

    def test_duplicate_phase_index_is_an_error(self, tmp_path):
        self._phase(tmp_path, 0, 1400, 900)
        write_asset(
            tmp_path,
            "BP_Storm_Duplicate",
            """
            _blueprintId: cccccccccccccccccccccccccccccccc
            _displayName: Dup
            _phaseIndex: 0
            _waitSeconds: 120
            _closeSeconds: 120
            _startRadius: 1400
            _endRadius: 900
            """,
        )

        findings, _ = validate(tmp_path)
        assert any("Duplicate PhaseIndex" in f.message for f in errors(findings))

    def test_an_overlong_storm_warns(self, tmp_path):
        self._phase(tmp_path, 0, 1400, 900, wait=900, close=900)
        self._phase(tmp_path, 1, 900, 600, wait=900, close=900)

        findings, _ = validate(tmp_path)
        assert any("minutes" in f.message for f in warnings(findings))


class TestMetaFiles:
    def test_a_missing_meta_is_an_error(self, tmp_path):
        write_asset(
            tmp_path,
            "BP_NoMeta",
            """
            _blueprintId: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
            _displayName: Thing
            """,
            with_meta=False,
        )

        findings, _ = validate(tmp_path)
        assert any("Missing .meta" in f.message for f in errors(findings))

    def test_an_orphaned_meta_is_an_error(self, tmp_path):
        tmp_path.mkdir(parents=True, exist_ok=True)
        (tmp_path / "BP_Ghost.asset.meta").write_text(
            "fileFormatVersion: 2\nguid: " + "f" * 32 + "\n", encoding="utf-8"
        )

        findings, _ = validate(tmp_path)
        assert any("Orphaned .meta" in f.message for f in errors(findings))


class TestLootTableCycles:
    def test_a_two_table_cycle_is_detected(self, tmp_path):
        # A -> B -> A would recurse forever when the server rolls it.
        guid_a, guid_b = "a" * 32, "b" * 32

        write_asset(
            tmp_path,
            "BP_Loot_A",
            f"""
            _blueprintId: 1{'0' * 31}
            _displayName: A
            _entries:
            - _table: {{fileID: 11400000, guid: {guid_b}, type: 2}}
            _rollCount: 1
            """,
            guid=guid_a,
        )
        write_asset(
            tmp_path,
            "BP_Loot_B",
            f"""
            _blueprintId: 2{'0' * 31}
            _displayName: B
            _entries:
            - _table: {{fileID: 11400000, guid: {guid_a}, type: 2}}
            _rollCount: 1
            """,
            guid=guid_b,
        )

        findings, _ = validate(tmp_path)
        assert any("reference cycle" in f.message for f in errors(findings))

    def test_acyclic_nesting_passes(self, tmp_path):
        # A chest table composed from a weapons table is the intended shape.
        guid_weapons = "c" * 32
        write_asset(
            tmp_path,
            "BP_Loot_Weapons",
            f"""
            _blueprintId: 3{'0' * 31}
            _displayName: Weapons
            _entries:
            - _weight: 1
            _rollCount: 1
            """,
            guid=guid_weapons,
        )
        write_asset(
            tmp_path,
            "BP_Loot_Chest",
            f"""
            _blueprintId: 4{'0' * 31}
            _displayName: Chest
            _entries:
            - _table: {{fileID: 11400000, guid: {guid_weapons}, type: 2}}
            _rollCount: 2
            """,
            guid="d" * 32,
        )

        findings, _ = validate(tmp_path)
        assert errors(findings) == []
