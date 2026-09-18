"""A minimal, ``bpy``-free mesh representation.

Generators build geometry as :class:`MeshData` and only touch Blender at the
point of handing it over (``tonight.blender_adapter``). That split is what lets
the geometry logic -- the part with the actual bugs in it -- be unit-tested in
CI with no Blender install.

Coordinates are in Blender's convention: **Z-up, metres**. The conversion to
glTF's Y-up happens once, at export.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from typing import Iterable, Sequence

Vec3 = tuple[float, float, float]
Vec2 = tuple[float, float]


def part_role(part_name: str) -> str:
    """Strip a generator's instance suffix: ``Panel_0_0`` -> ``Panel``.

    Only trailing all-digit segments are removed, so ``SM_Build_Wall_Wood``
    survives intact and ``Canopy_3`` and ``Wheel_2`` collapse onto their role.
    """
    parts = part_name.split("_")
    while len(parts) > 1 and parts[-1].isdigit():
        parts.pop()
    return "_".join(parts)


@dataclass
class MeshData:
    """Vertices, polygon faces, and per-face-corner UVs.

    Faces are index tuples of any length; the exporter triangulates. Winding is
    counter-clockwise when viewed from outside, which is what makes the
    generated normals point outward.
    """

    vertices: list[Vec3] = field(default_factory=list)
    faces: list[tuple[int, ...]] = field(default_factory=list)
    uvs: list[list[Vec2]] = field(default_factory=list)
    name: str = "Mesh"

    #: Per-face group name, parallel to ``faces``. Populated by :meth:`merge`
    #: from the name each part carried before it was joined, so a tree exports
    #: its trunk and its canopy as separate glTF primitives and the client can
    #: give them different materials. Empty means "one group, the mesh's own
    #: name", which is the common case for a mesh built directly.
    face_groups: list[str] = field(default_factory=list)

    # ---------------------------------------------------------------- basics

    @property
    def vertex_count(self) -> int:
        return len(self.vertices)

    @property
    def face_count(self) -> int:
        return len(self.faces)

    @property
    def triangle_count(self) -> int:
        """Triangles after fan triangulation, which is what ships."""
        return sum(max(0, len(face) - 2) for face in self.faces)

    def add_vertex(self, position: Vec3) -> int:
        self.vertices.append((float(position[0]), float(position[1]), float(position[2])))
        return len(self.vertices) - 1

    def add_face(self, indices: Sequence[int], uvs: Sequence[Vec2] | None = None) -> None:
        if len(indices) < 3:
            raise ValueError(f"A face needs at least 3 indices, got {len(indices)}.")
        for index in indices:
            if not 0 <= index < len(self.vertices):
                raise IndexError(
                    f"Face index {index} is out of range for {len(self.vertices)} vertices."
                )
        if len(set(indices)) != len(indices):
            raise ValueError(f"Face {tuple(indices)} repeats a vertex.")

        self.faces.append(tuple(int(i) for i in indices))

        if uvs is None:
            # A planar default beats leaving UVs absent: an unwrapped mesh
            # renders as a flat colour and the mistake is easy to miss.
            uvs = [(0.0, 0.0)] * len(indices)
        if len(uvs) != len(indices):
            raise ValueError(
                f"UV count {len(uvs)} does not match face corner count {len(indices)}."
            )
        self.uvs.append([(float(u), float(v)) for u, v in uvs])

    # ------------------------------------------------------------ transforms

    def translated(self, offset: Vec3) -> "MeshData":
        result = self.copy()
        result.vertices = [
            (v[0] + offset[0], v[1] + offset[1], v[2] + offset[2]) for v in self.vertices
        ]
        return result

    def scaled(self, factor: Vec3 | float) -> "MeshData":
        if isinstance(factor, (int, float)):
            factor = (float(factor), float(factor), float(factor))
        result = self.copy()
        result.vertices = [
            (v[0] * factor[0], v[1] * factor[1], v[2] * factor[2]) for v in self.vertices
        ]
        return result

    def rotated_z(self, degrees: float) -> "MeshData":
        """Rotate about the Z axis. Z is up in Blender, so this is yaw."""
        radians = math.radians(degrees)
        cos_a, sin_a = math.cos(radians), math.sin(radians)
        result = self.copy()
        result.vertices = [
            (v[0] * cos_a - v[1] * sin_a, v[0] * sin_a + v[1] * cos_a, v[2])
            for v in self.vertices
        ]
        return result

    def copy(self) -> "MeshData":
        return MeshData(
            vertices=list(self.vertices),
            faces=list(self.faces),
            uvs=[list(face_uvs) for face_uvs in self.uvs],
            name=self.name,
            face_groups=list(self.face_groups),
        )

    # ----------------------------------------------------------------- merge

    def merge(self, other: "MeshData") -> "MeshData":
        """Append ``other``'s geometry, re-indexing its faces."""
        result = self.copy()
        offset = len(result.vertices)

        # Backfill this mesh's own groups before appending, so a mesh that was
        # built directly and is now being merged into does not silently donate
        # its faces to the incoming part's group.
        if not result.face_groups:
            result.face_groups = [result.name] * len(result.faces)

        result.vertices.extend(other.vertices)
        result.faces.extend(tuple(i + offset for i in face) for face in other.faces)
        result.uvs.extend([list(face_uvs) for face_uvs in other.uvs])
        result.face_groups.extend(
            other.face_groups if other.face_groups else [other.name] * len(other.faces)
        )
        return result

    @staticmethod
    def join(meshes: Iterable["MeshData"], name: str = "Joined") -> "MeshData":
        result = MeshData(name=name)
        for mesh in meshes:
            result = result.merge(mesh)
        result.name = name
        return result

    def primitive_groups(self) -> list[tuple[str, list[int]]]:
        """Face indices grouped by part *role*, in first-appearance order.

        Grouping is by role rather than by exact part name: generators name
        repeated parts ``Panel_0_0``, ``Canopy_3``, ``Wheel_2``, and one glTF
        primitive per instance would turn a 17-part wall into 17 draw calls.
        Stripping the numeric suffix gives a wall two primitives and a tree a
        trunk and a canopy, which is the distinction that actually carries a
        material.

        A mesh with no recorded groups is one group named after itself.
        """
        if not self.face_groups:
            return [(self.name, list(range(len(self.faces))))] if self.faces else []

        order: list[str] = []
        grouped: dict[str, list[int]] = {}
        for index in range(len(self.faces)):
            raw = self.face_groups[index] if index < len(self.face_groups) else self.name
            key = part_role(raw)
            if key not in grouped:
                grouped[key] = []
                order.append(key)
            grouped[key].append(index)
        return [(name, grouped[name]) for name in order]

    # ------------------------------------------------------------- inspection

    def bounds(self) -> tuple[Vec3, Vec3]:
        """Axis-aligned bounds as ``(min, max)``."""
        if not self.vertices:
            return ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0))

        xs = [v[0] for v in self.vertices]
        ys = [v[1] for v in self.vertices]
        zs = [v[2] for v in self.vertices]
        return ((min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs)))

    def size(self) -> Vec3:
        low, high = self.bounds()
        return (high[0] - low[0], high[1] - low[1], high[2] - low[2])

    def is_manifold_ish(self) -> bool:
        """Every edge used by exactly two faces.

        A cheap proxy for a closed, watertight solid. It does not check winding
        or self-intersection, so it is named honestly: it catches the common
        generator bug (a missing face) and not much else.
        """
        edge_counts: dict[tuple[int, int], int] = {}
        for face in self.faces:
            for i, a in enumerate(face):
                b = face[(i + 1) % len(face)]
                key = (a, b) if a < b else (b, a)
                edge_counts[key] = edge_counts.get(key, 0) + 1

        return bool(edge_counts) and all(count == 2 for count in edge_counts.values())

    def content_hash(self) -> str:
        """A stable hash of the geometry.

        CI asserts these so an unintended change to a generator shows up as a
        failing test rather than as art that quietly drifted. Coordinates are
        rounded to a micrometre first, because float noise below that is not a
        meaningful difference and would make the hash useless.
        """
        hasher = hashlib.sha256()
        for vertex in self.vertices:
            for component in vertex:
                hasher.update(f"{round(component, 6):.6f}|".encode("ascii"))
        for face in self.faces:
            hasher.update(("f" + ",".join(str(i) for i in face) + "|").encode("ascii"))
        return hasher.hexdigest()[:16]

    def validate(self) -> list[str]:
        """Return a list of problems. Empty means the mesh is well-formed."""
        problems: list[str] = []

        if not self.vertices:
            problems.append("Mesh has no vertices.")
        if not self.faces:
            problems.append("Mesh has no faces.")
        if len(self.uvs) != len(self.faces):
            problems.append(
                f"UV set count {len(self.uvs)} does not match face count {len(self.faces)}."
            )

        for index, face in enumerate(self.faces):
            if len(face) < 3:
                problems.append(f"Face {index} has {len(face)} corners.")
            for vertex_index in face:
                if not 0 <= vertex_index < len(self.vertices):
                    problems.append(f"Face {index} references vertex {vertex_index}.")

        for index, vertex in enumerate(self.vertices):
            for component in vertex:
                if math.isnan(component) or math.isinf(component):
                    problems.append(f"Vertex {index} has a non-finite component.")
                    break

        return problems


# --------------------------------------------------------------------------
# Primitives
# --------------------------------------------------------------------------


def box(
    size: Vec3,
    centre: Vec3 = (0.0, 0.0, 0.0),
    name: str = "Box",
    uv_scale: float = 1.0,
) -> MeshData:
    """An axis-aligned box with outward-facing, box-projected UVs.

    Args:
        size: Full extents in metres.
        centre: Centre position.
        uv_scale: World-metres-per-UV-unit. Keeping this consistent across
            pieces is what stops a stone wall's texture being twice the scale
            of the floor beside it.
    """
    half = (size[0] / 2.0, size[1] / 2.0, size[2] / 2.0)
    cx, cy, cz = centre

    mesh = MeshData(name=name)
    for sz in (-1, 1):
        for sy in (-1, 1):
            for sx in (-1, 1):
                mesh.add_vertex((cx + sx * half[0], cy + sy * half[1], cz + sz * half[2]))

    # Vertex order above is x fastest, then y, then z:
    #   0:(-,-,-) 1:(+,-,-) 2:(-,+,-) 3:(+,+,-)
    #   4:(-,-,+) 5:(+,-,+) 6:(-,+,+) 7:(+,+,+)
    su, sv = size[0] / uv_scale, size[1] / uv_scale
    du, dv = size[0] / uv_scale, size[2] / uv_scale
    eu, ev = size[1] / uv_scale, size[2] / uv_scale

    def quad_uvs(width: float, height: float) -> list[Vec2]:
        return [(0.0, 0.0), (width, 0.0), (width, height), (0.0, height)]

    mesh.add_face((0, 2, 3, 1), quad_uvs(su, sv))   # bottom, -Z
    mesh.add_face((4, 5, 7, 6), quad_uvs(su, sv))   # top, +Z
    mesh.add_face((0, 1, 5, 4), quad_uvs(du, dv))   # front, -Y
    mesh.add_face((2, 6, 7, 3), quad_uvs(du, dv))   # back, +Y
    mesh.add_face((0, 4, 6, 2), quad_uvs(eu, ev))   # left, -X
    mesh.add_face((1, 3, 7, 5), quad_uvs(eu, ev))   # right, +X

    return mesh


def wedge(
    size: Vec3,
    centre: Vec3 = (0.0, 0.0, 0.0),
    name: str = "Wedge",
) -> MeshData:
    """A right-triangular prism rising along -Y, used for ramps.

    The slope is exact rather than approximate: the ramp rises one cell over one
    cell, so the 45 degrees in the GDD is a consequence of the grid rather than
    a number someone typed.

    **The rise direction is load-bearing.** Blender -Y becomes glTF +Z, and the
    simulation's walkable-surface query rises with +Z
    (``surfaceHeight`` in ``web/src/render/collision.ts``). A ramp authored the
    other way looks right in isolation and is walkable from the wrong end, which
    is precisely the preview-disagrees-with-reality failure vision pillar 1
    forbids. ``test_ramp_rises_towards_negative_y`` pins it.
    """
    half = (size[0] / 2.0, size[1] / 2.0, size[2] / 2.0)
    cx, cy, cz = centre

    mesh = MeshData(name=name)
    # Bottom quad.
    mesh.add_vertex((cx - half[0], cy - half[1], cz - half[2]))  # 0
    mesh.add_vertex((cx + half[0], cy - half[1], cz - half[2]))  # 1
    mesh.add_vertex((cx + half[0], cy + half[1], cz - half[2]))  # 2
    mesh.add_vertex((cx - half[0], cy + half[1], cz - half[2]))  # 3
    # Top edge, above the -Y end: that is the high end.
    mesh.add_vertex((cx - half[0], cy - half[1], cz + half[2]))  # 4
    mesh.add_vertex((cx + half[0], cy - half[1], cz + half[2]))  # 5

    flat = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    tri = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]

    mesh.add_face((0, 3, 2, 1), flat)      # bottom
    mesh.add_face((1, 5, 4, 0), flat)      # vertical back, at -Y
    mesh.add_face((2, 3, 4, 5), flat)      # the slope, falling away toward +Y
    mesh.add_face((4, 3, 0), tri)          # left triangle
    mesh.add_face((2, 5, 1), tri)          # right triangle

    return mesh


def pyramid(
    base: float,
    height: float,
    centre: Vec3 = (0.0, 0.0, 0.0),
    name: str = "Pyramid",
) -> MeshData:
    """A square pyramid, used for the cone build piece."""
    half = base / 2.0
    cx, cy, cz = centre

    mesh = MeshData(name=name)
    mesh.add_vertex((cx - half, cy - half, cz))
    mesh.add_vertex((cx + half, cy - half, cz))
    mesh.add_vertex((cx + half, cy + half, cz))
    mesh.add_vertex((cx - half, cy + half, cz))
    mesh.add_vertex((cx, cy, cz + height))

    flat = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    tri = [(0.0, 0.0), (1.0, 0.0), (0.5, 1.0)]

    mesh.add_face((0, 3, 2, 1), flat)
    mesh.add_face((0, 1, 4), tri)
    mesh.add_face((1, 2, 4), tri)
    mesh.add_face((2, 3, 4), tri)
    mesh.add_face((3, 0, 4), tri)

    return mesh


def cylinder(
    radius: float,
    height: float,
    segments: int = 12,
    centre: Vec3 = (0.0, 0.0, 0.0),
    name: str = "Cylinder",
) -> MeshData:
    """A capped cylinder along Z.

    ``segments`` defaults to 12 rather than the usual 32: pillar 3 calls for
    stylised, low-ish poly art, and 12 reads as round at gameplay distances.
    """
    if segments < 3:
        raise ValueError(f"A cylinder needs at least 3 segments, got {segments}.")

    cx, cy, cz = centre
    half = height / 2.0
    mesh = MeshData(name=name)

    for ring_z in (cz - half, cz + half):
        for i in range(segments):
            angle = 2.0 * math.pi * i / segments
            mesh.add_vertex((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius, ring_z))

    bottom_centre = mesh.add_vertex((cx, cy, cz - half))
    top_centre = mesh.add_vertex((cx, cy, cz + half))

    for i in range(segments):
        nxt = (i + 1) % segments
        lower_a, lower_b = i, nxt
        upper_a, upper_b = i + segments, nxt + segments

        u0 = i / segments
        u1 = (i + 1) / segments
        mesh.add_face(
            (lower_a, lower_b, upper_b, upper_a),
            [(u0, 0.0), (u1, 0.0), (u1, 1.0), (u0, 1.0)],
        )
        mesh.add_face((bottom_centre, lower_b, lower_a), [(0.5, 0.5), (u1, 0.0), (u0, 0.0)])
        mesh.add_face((top_centre, upper_a, upper_b), [(0.5, 0.5), (u0, 1.0), (u1, 1.0)])

    return mesh
