"""Export paths, the asset manifest, and pre-export checks.

Deliberately ``bpy``-free: everything here is decisions about *what* to export
and *where*, which is testable without Blender. The part that actually talks to
Blender lives in :mod:`tonight.blender_adapter`.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from tonight.mesh import MeshData

#: Repository-relative export root. Gitignored: exported meshes are build output,
#: regenerated from the Python that is the real source of truth (ADR-0004).
EXPORT_ROOT = Path("blender/exports")

#: Where the web client will pick the meshes up. Nothing loads from here yet --
#: the sandbox still draws procedural geometry -- but the path is fixed so the
#: generators and the client agree in advance.
WEB_ART_ROOT = Path("web/public/art")

#: Subfolder per asset family, so loaders can apply different handling per
#: family without matching on names.
CATEGORY_FOLDERS = {
    "build": "Build",
    "weapon": "Weapons",
    "harvest": "Harvestables",
    "tool": "Weapons",
    "terrain": "Terrain",
    "character": "Characters",
}


@dataclass
class ExportRecord:
    """One exported asset, as it appears in the manifest."""

    name: str
    category: str
    #: Path relative to the export root, e.g. ``Build/SM_Build_Wall_Wood.glb``.
    #: The web client joins this onto its art base URL, so neither side has to
    #: reimplement the category-to-folder mapping and drift from the other.
    file: str
    relative_path: str
    vertex_count: int
    triangle_count: int
    size_metres: tuple[float, float, float]
    content_hash: str


def category_for(asset_name: str) -> str:
    """Infer the category from a conventional asset name.

    ``SM_Build_Wall_Wood`` is a build asset. Raises rather than guessing,
    because a silently miscategorised asset ends up in the wrong folder with
    the wrong import settings and nobody notices until it renders wrong.
    """
    parts = asset_name.split("_")
    if len(parts) < 3:
        raise ValueError(
            f"Asset name {asset_name!r} does not follow PREFIX_Category_Name. "
            "Build names with tonight.units.asset_name()."
        )

    category = parts[1].lower()
    if category not in CATEGORY_FOLDERS:
        raise ValueError(
            f"Asset {asset_name!r} has unknown category {parts[1]!r}. "
            f"Known categories: {sorted(CATEGORY_FOLDERS)}."
        )
    return category


def export_path(asset_name: str, root: Path = EXPORT_ROOT, suffix: str = ".glb") -> Path:
    """Where an asset's exported mesh belongs.

    Defaults to ``.glb``: the three.js client loads glTF natively, so that is
    the pipeline's primary format.
    """
    category = category_for(asset_name)
    return root / CATEGORY_FOLDERS[category] / f"{asset_name}{suffix}"


def check_before_export(mesh: MeshData) -> list[str]:
    """Problems that should stop an asset being exported.

    Catching these here means a broken mesh fails the build rather than
    reaching the client as an invisible or exploded object.
    """
    problems = list(mesh.validate())

    size = mesh.size()
    if max(size) <= 0.0:
        problems.append(f"{mesh.name}: mesh has zero extent in every axis.")
    # Terrain is legitimately map-sized; everything else over 500 m is
    # almost certainly a metres/centimetres mix-up.
    extent_limit = 4000.0 if mesh.name.startswith("SM_Terrain") else 500.0
    if max(size) > extent_limit:
        problems.append(
            f"{mesh.name}: largest extent is {max(size):.1f} m, above the "
            f"{extent_limit:.0f} m limit for this asset kind -- almost "
            "certainly a unit error, since scenes author in metres."
        )

    try:
        category_for(mesh.name)
    except ValueError as error:
        problems.append(str(error))

    return problems


def build_record(mesh: MeshData) -> ExportRecord:
    """Build a manifest record for a mesh.

    The recorded path is always repository-relative. An absolute path would
    make the manifest machine-dependent, which would defeat the point of
    committing it -- every contributor's diff would show every asset changing.
    """
    return ExportRecord(
        name=mesh.name,
        category=category_for(mesh.name),
        file=export_path(mesh.name, Path(".")).as_posix(),
        relative_path=export_path(mesh.name, EXPORT_ROOT).as_posix(),
        vertex_count=mesh.vertex_count,
        triangle_count=mesh.triangle_count,
        size_metres=tuple(round(component, 4) for component in mesh.size()),
        content_hash=mesh.content_hash(),
    )


def write_manifest(records: list[ExportRecord], path: Path) -> None:
    """Write the asset manifest.

    The manifest is what makes a procedural pipeline reviewable: content hashes
    in a diff show exactly which assets a generator change actually altered,
    rather than leaving a reviewer to trust that "regenerated all art" did what
    it claimed.
    """
    path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "version": 1,
        "assetCount": len(records),
        # Sorted so the manifest diff reflects content changes, not dict order.
        "assets": [asdict(record) for record in sorted(records, key=lambda r: r.name)],
    }

    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def read_manifest(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def diff_manifests(old: dict, new: dict) -> dict[str, list[str]]:
    """Compare two manifests by content hash.

    Returns a dict with ``added``, ``removed``, and ``changed`` asset names.
    """
    old_hashes = {a["name"]: a["content_hash"] for a in old.get("assets", [])}
    new_hashes = {a["name"]: a["content_hash"] for a in new.get("assets", [])}

    return {
        "added": sorted(set(new_hashes) - set(old_hashes)),
        "removed": sorted(set(old_hashes) - set(new_hashes)),
        "changed": sorted(
            name for name in set(old_hashes) & set(new_hashes)
            if old_hashes[name] != new_hashes[name]
        ),
    }
