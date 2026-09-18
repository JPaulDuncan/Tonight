"""Regenerate every art asset in Tonight.

Run it with plain Python:

    python3 blender/scripts/build_all.py

    python3 blender/scripts/build_all.py --dry-run
    python3 blender/scripts/build_all.py --only build --out web/public/art

Export goes through :mod:`tonight.gltf`, which writes ``.glb`` without ``bpy``,
so a full build needs no Blender install (ADR-0008). That is what lets CI
produce the art the web client loads instead of shipping a client that has
never been run against a real asset.

It still runs inside Blender, for anyone prototyping there, with arguments
after ``--``:

    blender --background --python blender/scripts/build_all.py -- --only build

``--dry-run`` skips writing meshes but still exercises every generator, runs the
pre-export checks, and rewrites the manifest.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path


def _running_inside_blender() -> bool:
    return "bpy" in sys.modules or Path(sys.argv[0]).name.startswith("blender")


def _repo_root() -> Path:
    """The repository root, whether launched by Blender or by Python."""
    return Path(__file__).resolve().parent.parent.parent


sys.path.insert(0, str(_repo_root() / "blender" / "lib"))

from tonight import build_pieces, character, harvestables, terrain, textures, weapons  # noqa: E402
from tonight.export import (  # noqa: E402
    EXPORT_ROOT,
    build_record,
    build_texture_record,
    check_before_export,
    export_path,
    write_manifest,
)
from tonight.gltf import write_glb  # noqa: E402
from tonight.mesh import MeshData  # noqa: E402

GENERATORS = {
    "build": build_pieces.generate_all,
    "weapon": weapons.generate_all,
    "harvest": harvestables.generate_all,
    "terrain": terrain.generate_all,
    "character": character.generate_all,
}


def parse_args(argv: list[str]) -> argparse.Namespace:
    # Blender passes its own arguments first; everything after "--" is ours.
    # With no "--" separator there is nothing addressed to this script, and
    # Blender's own flags must not be parsed as ours.
    # Under Blender, its own flags come first and everything after "--" is
    # ours. Run directly, there is no separator and argv is already ours.
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    elif _running_inside_blender():
        # No separator under Blender means nothing was addressed to this
        # script, and Blender's own flags must not be parsed as ours.
        argv = []
    else:
        argv = argv[1:]

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

    # Textures are generated whenever meshes are, because a mesh without its
    # surface is half an asset and the two drift the moment they are separate
    # commands.
    tiles = textures.generate_all()
    texture_records = [build_texture_record(name, tile) for name, tile in tiles.items()]

    if not args.dry_run:
        for mesh in meshes.values():
            destination = export_path(mesh.name, out_root)
            write_glb(mesh, destination)
        for name, tile in tiles.items():
            tile.write(textures.texture_path(name, out_root))
        print(
            f"[tonight] Wrote {len(meshes)} .glb and {len(tiles)} .png files "
            f"under {out_root}."
        )

    # The canonical manifest is committed and reviewed; it is how a generator
    # change is read (ADR-0004).
    manifest_path = root / "blender" / "exports" / "manifest.json"
    write_manifest(records, manifest_path, texture_records)

    # A copy beside the meshes makes an export directory self-describing, so
    # the web client fetches its index from the same place as its assets
    # instead of reaching across the repo for it.
    if not args.dry_run and out_root.resolve() != manifest_path.parent.resolve():
        write_manifest(records, out_root / "manifest.json", texture_records)

    total_tris = sum(mesh.triangle_count for mesh in meshes.values())
    elapsed = time.perf_counter() - started
    mode = "dry run" if args.dry_run else "exported"
    print(
        f"[tonight] {mode}: {len(records)} assets, {len(texture_records)} textures, "
        f"{total_tris} triangles, "
        f"{elapsed:.2f}s. Manifest at {manifest_path.relative_to(root)}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
