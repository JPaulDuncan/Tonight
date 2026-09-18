"""Regenerate every art asset in Tonight.

Run inside Blender:

    blender --background --python blender/scripts/build_all.py

Optional arguments come after ``--``:

    blender --background --python blender/scripts/build_all.py -- --dry-run
    blender --background --python blender/scripts/build_all.py -- --only build

``--dry-run`` needs no Blender at all and is what CI uses: it exercises every
generator, runs the pre-export checks, and writes the manifest, without
touching ``bpy``. That is deliberate -- it means a generator bug fails CI
instead of waiting for someone to run Blender locally.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path


def _repo_root() -> Path:
    """The repository root, whether launched by Blender or by Python."""
    return Path(__file__).resolve().parent.parent.parent


sys.path.insert(0, str(_repo_root() / "blender" / "lib"))

from tonight import build_pieces, harvestables, terrain, weapons  # noqa: E402
from tonight.export import (  # noqa: E402
    EXPORT_ROOT,
    build_record,
    check_before_export,
    export_path,
    write_manifest,
)
from tonight.mesh import MeshData  # noqa: E402

GENERATORS = {
    "build": build_pieces.generate_all,
    "weapon": weapons.generate_all,
    "harvest": harvestables.generate_all,
    "terrain": terrain.generate_all,
}


def parse_args(argv: list[str]) -> argparse.Namespace:
    # Blender passes its own arguments first; everything after "--" is ours.
    # With no "--" separator there is nothing addressed to this script, and
    # Blender's own flags must not be parsed as ours.
    argv = argv[argv.index("--") + 1 :] if "--" in argv else []

    parser = argparse.ArgumentParser(description="Regenerate Tonight's art assets.")
    parser.add_argument(
        "--only",
        choices=sorted(GENERATORS),
        action="append",
        help="Generate only this family. Repeatable.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Generate and validate without writing meshes. Needs no Blender.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Export root. Defaults to blender/exports relative to the repo.",
    )
    return parser.parse_args(argv)


def collect(families: list[str] | None) -> dict[str, MeshData]:
    selected = families or sorted(GENERATORS)
    meshes: dict[str, MeshData] = {}

    for family in selected:
        produced = GENERATORS[family]()
        overlap = set(produced) & set(meshes)
        if overlap:
            raise RuntimeError(
                f"Generators produced duplicate asset names: {sorted(overlap)}. "
                "Names must be unique across families."
            )
        meshes.update(produced)

    return meshes


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    root = _repo_root()
    out_root = args.out or (root / EXPORT_ROOT)

    started = time.perf_counter()
    meshes = collect(args.only)
    print(f"[tonight] Generated {len(meshes)} meshes.")

    problems: list[str] = []
    for mesh in meshes.values():
        problems.extend(check_before_export(mesh))

    if problems:
        print(f"[tonight] {len(problems)} problem(s) found:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    # Records carry repo-relative paths regardless of where meshes are written.
    records = [build_record(mesh) for mesh in meshes.values()]

    if not args.dry_run:
        from tonight.blender_adapter import clear_scene, create_object, export_gltf

        for mesh in meshes.values():
            clear_scene()
            obj = create_object(mesh)
            destination = export_path(mesh.name, out_root)
            export_gltf(obj, destination)
            print(f"[tonight]   exported {destination.name}")

    manifest_path = root / "blender" / "exports" / "manifest.json"
    write_manifest(records, manifest_path)

    total_tris = sum(mesh.triangle_count for mesh in meshes.values())
    elapsed = time.perf_counter() - started
    mode = "dry run" if args.dry_run else "exported"
    print(
        f"[tonight] {mode}: {len(records)} assets, {total_tris} triangles, "
        f"{elapsed:.2f}s. Manifest at {manifest_path.relative_to(root)}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
