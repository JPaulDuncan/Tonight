"""Serialise :class:`~tonight.mesh.MeshData` straight to binary glTF (``.glb``).

Deliberately ``bpy``-free, like the rest of the library. The generators build
complete geometry in pure Python -- vertices, faces and UVs -- and use no Blender
modelling operator, so Blender's only remaining job in the build was writing the
file. This module does that job instead, which is what lets the whole art
pipeline run in CI and on a machine with no Blender install (ADR-0008).

Three conversions happen here, each in exactly one place because each is the kind
of mistake that looks fine in a viewport and surfaces much later:

**Axes.** Blender is Z-up right-handed; glTF is Y-up right-handed. The map is
``(x, y, z) -> (x, z, -y)``. Its determinant is +1, so handedness is preserved
and winding is *not* flipped -- a mesh that comes out mirrored is a generator
bug, not an export setting.

**Shading.** The art is stylised and faceted (pillar 3), so every face corner
becomes its own glTF vertex carrying the face normal. glTF normals are
per-vertex, so sharing a vertex between two faces is what would smooth it.

**UVs.** Blender's V axis points up from the bottom-left; glTF's points down from
the top-left, so V is flipped.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

from tonight.mesh import MeshData, Vec3

#: glTF component type for a 32-bit float, from the spec's accessor table.
COMPONENT_FLOAT = 5126
#: glTF component type for an unsigned 32-bit integer.
COMPONENT_UINT32 = 5125
#: Primitive mode 4 is TRIANGLES.
MODE_TRIANGLES = 4

_GLB_MAGIC = 0x46546C67  # "glTF"
_GLB_VERSION = 2
_CHUNK_JSON = 0x4E4F534A  # "JSON"
_CHUNK_BIN = 0x004E4942  # "BIN\0"

GENERATOR = "tonight.gltf"


def to_gltf_position(vertex: Vec3) -> Vec3:
    """Blender Z-up right-handed to glTF Y-up right-handed."""
    return (vertex[0], vertex[2], -vertex[1])


def face_normal(vertices: list[Vec3], face: tuple[int, ...]) -> Vec3:
    """Newell's method, in Blender space.

    Newell rather than a single cross product because faces may be polygons with
    more than three corners, and a cross product of the first three would be
    wrong for any face that is not perfectly planar -- which, after a generator
    scales a box non-uniformly, some are.
    """
    nx = ny = nz = 0.0
    count = len(face)
    for i in range(count):
        current = vertices[face[i]]
        following = vertices[face[(i + 1) % count]]
        nx += (current[1] - following[1]) * (current[2] + following[2])
        ny += (current[2] - following[2]) * (current[0] + following[0])
        nz += (current[0] - following[0]) * (current[1] + following[1])

    length = (nx * nx + ny * ny + nz * nz) ** 0.5
    if length == 0.0:
        # A degenerate face has no meaningful normal. Point it up rather than
        # emitting NaN, which would poison the whole accessor's min/max.
        return (0.0, 0.0, 1.0)
    return (nx / length, ny / length, nz / length)


def _triangulate(face: tuple[int, ...]) -> list[tuple[int, int, int]]:
    """Fan triangulation, matching MeshData.triangle_count's assumption."""
    return [(face[0], face[i], face[i + 1]) for i in range(1, len(face) - 1)]


def build_primitive_arrays(
    mesh: MeshData, faces: list[int]
) -> tuple[list[float], list[float], list[float], list[int]]:
    """Flatten a subset of a mesh's faces into glTF attribute arrays.

    Returns ``(positions, normals, uvs, indices)``. Every face corner becomes its
    own vertex, so the caller gets flat shading for free and the indices are
    sequential per triangle.
    """
    positions: list[float] = []
    normals: list[float] = []
    uvs: list[float] = []
    indices: list[int] = []

    for face_index in faces:
        face = mesh.faces[face_index]
        normal = to_gltf_position(face_normal(mesh.vertices, face))
        face_uvs = mesh.uvs[face_index] if face_index < len(mesh.uvs) else None

        # One glTF vertex per face corner, shared by that face's fan triangles
        # but never across faces. Sharing within the face is free -- the corners
        # already agree on normal and UV -- and saves a third of the payload on
        # quad-heavy meshes; sharing across faces is what would smooth the edge.
        base = len(positions) // 3
        for corner, vertex_index in enumerate(face):
            positions.extend(to_gltf_position(mesh.vertices[vertex_index]))
            normals.extend(normal)
            if face_uvs is not None and corner < len(face_uvs):
                u, v = face_uvs[corner]
            else:
                u, v = 0.0, 0.0
            uvs.extend((u, 1.0 - v))

        for corner in range(1, len(face) - 1):
            indices.extend((base, base + corner, base + corner + 1))

    return positions, normals, uvs, indices


def _pad_to_four(data: bytearray, filler: int) -> None:
    while len(data) % 4 != 0:
        data.append(filler)


def _accessor(
    buffer_view: int, component_type: int, count: int, type_name: str
) -> dict[str, object]:
    return {
        "bufferView": buffer_view,
        "componentType": component_type,
        "count": count,
        "type": type_name,
    }


def build_gltf_document(mesh: MeshData) -> tuple[dict[str, object], bytes]:
    """Build the glTF JSON document and its binary buffer for one mesh.

    Split out from :func:`write_glb` so tests can assert on the structure
    without going through a file.
    """
    groups = mesh.primitive_groups()

    binary = bytearray()
    buffer_views: list[dict[str, object]] = []
    accessors: list[dict[str, object]] = []
    primitives: list[dict[str, object]] = []

    def add_view(payload: bytes, target: int | None = None) -> int:
        # Accessor byte offsets must be aligned to their component size; all of
        # ours are 4 bytes, so aligning every view to 4 satisfies the spec.
        _pad_to_four(binary, 0)
        view: dict[str, object] = {"buffer": 0, "byteOffset": len(binary), "byteLength": len(payload)}
        if target is not None:
            view["target"] = target
        binary.extend(payload)
        buffer_views.append(view)
        return len(buffer_views) - 1

    for group_name, face_indices in groups:
        positions, normals, uvs, indices = build_primitive_arrays(mesh, face_indices)
        if not indices:
            continue

        vertex_count = len(positions) // 3

        position_view = add_view(struct.pack(f"<{len(positions)}f", *positions), 34962)
        normal_view = add_view(struct.pack(f"<{len(normals)}f", *normals), 34962)
        uv_view = add_view(struct.pack(f"<{len(uvs)}f", *uvs), 34962)
        index_view = add_view(struct.pack(f"<{len(indices)}I", *indices), 34963)

        position_accessor = _accessor(position_view, COMPONENT_FLOAT, vertex_count, "VEC3")
        # POSITION is the one accessor the spec requires min/max on: viewers use
        # it for bounding volumes and frustum culling.
        position_accessor["min"] = [min(positions[i::3]) for i in range(3)]
        position_accessor["max"] = [max(positions[i::3]) for i in range(3)]
        accessors.append(position_accessor)
        accessors.append(_accessor(normal_view, COMPONENT_FLOAT, vertex_count, "VEC3"))
        accessors.append(_accessor(uv_view, COMPONENT_FLOAT, vertex_count, "VEC2"))
        accessors.append(_accessor(index_view, COMPONENT_UINT32, len(indices), "SCALAR"))

        base = len(accessors) - 4
        primitive: dict[str, object] = {
            "attributes": {"POSITION": base, "NORMAL": base + 1, "TEXCOORD_0": base + 2},
            "indices": base + 3,
            "mode": MODE_TRIANGLES,
        }
        # The group name rides along as an extra so the client can give the
        # trunk and the canopy different materials. glTF has no per-primitive
        # name field, and inventing a material here would put an art decision in
        # the pipeline instead of in a Blueprint.
        primitive["extras"] = {"group": group_name}
        primitives.append(primitive)

    document: dict[str, object] = {
        "asset": {"version": "2.0", "generator": GENERATOR},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": mesh.name}],
        "meshes": [{"name": mesh.name, "primitives": primitives}],
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(binary)}],
    }
    return document, bytes(binary)


def encode_glb(mesh: MeshData) -> bytes:
    """Encode one mesh as a binary glTF container."""
    document, binary = build_gltf_document(mesh)

    # separators without spaces keeps the file compact; sort_keys keeps it
    # byte-identical across runs, which is what makes the output reviewable.
    json_bytes = bytearray(
        json.dumps(document, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    _pad_to_four(json_bytes, 0x20)  # JSON chunks pad with spaces, per the spec.

    binary_bytes = bytearray(binary)
    _pad_to_four(binary_bytes, 0x00)

    total = 12 + 8 + len(json_bytes) + 8 + len(binary_bytes)

    out = bytearray()
    out.extend(struct.pack("<III", _GLB_MAGIC, _GLB_VERSION, total))
    out.extend(struct.pack("<II", len(json_bytes), _CHUNK_JSON))
    out.extend(json_bytes)
    out.extend(struct.pack("<II", len(binary_bytes), _CHUNK_BIN))
    out.extend(binary_bytes)
    return bytes(out)


def write_glb(mesh: MeshData, destination: Path) -> Path:
    """Write one mesh to ``destination`` as ``.glb``."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(encode_glb(mesh))
    return destination
