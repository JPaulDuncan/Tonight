"""Tests for the bpy-free glTF writer.

These decode the bytes back rather than asserting on the encoder's own view of
what it wrote. A writer that is only checked against itself is not checked: the
failure mode that matters here is a file that parses but is *wrong* -- mirrored,
rotated, or smooth-shaded -- and only a round trip catches that.
"""

from __future__ import annotations

import json
import struct

import pytest

from tonight import build_pieces, character, harvestables, terrain, units, weapons
from tonight.gltf import (
    COMPONENT_FLOAT,
    COMPONENT_UINT32,
    MODE_TRIANGLES,
    build_gltf_document,
    encode_glb,
    face_normal,
    to_gltf_position,
)
from tonight.mesh import MeshData, box, part_role


# ---------------------------------------------------------------------------
# A minimal GLB reader, so the tests decode rather than trust.
# ---------------------------------------------------------------------------


class Glb:
    def __init__(self, raw: bytes) -> None:
        magic, version, total = struct.unpack_from("<III", raw, 0)
        assert magic == 0x46546C67, "not a glTF container"
        assert version == 2
        assert total == len(raw), "header length disagrees with the file size"

        offset = 12
        chunks: dict[int, bytes] = {}
        while offset < len(raw):
            length, kind = struct.unpack_from("<II", raw, offset)
            offset += 8
            chunks[kind] = raw[offset : offset + length]
            offset += length
        assert offset == len(raw), "chunk lengths do not tile the file"

        self.json = json.loads(chunks[0x4E4F534A].decode("utf-8"))
        self.binary = chunks[0x004E4942]

    def accessor(self, index: int) -> list[tuple[float, ...]]:
        """Read an accessor back as a list of tuples."""
        accessor = self.json["accessors"][index]
        view = self.json["bufferViews"][accessor["bufferView"]]
        components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[accessor["type"]]
        fmt = {COMPONENT_FLOAT: "f", COMPONENT_UINT32: "I"}[accessor["componentType"]]

        start = view["byteOffset"]
        count = accessor["count"]
        values = struct.unpack_from(f"<{count * components}{fmt}", self.binary, start)
        return [tuple(values[i : i + components]) for i in range(0, len(values), components)]

    def triangles(self, primitive: dict) -> list[tuple[tuple[float, ...], ...]]:
        """Positions of each triangle's three corners, in order."""
        positions = self.accessor(primitive["attributes"]["POSITION"])
        indices = [i[0] for i in self.accessor(primitive["indices"])]
        return [
            (positions[indices[i]], positions[indices[i + 1]], positions[indices[i + 2]])
            for i in range(0, len(indices), 3)
        ]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _parts_by_name(mesh: MeshData) -> dict[str, list[int]]:
    """Face indices grouped by the generator's raw part name.

    Unlike ``primitive_groups`` this keeps the instance suffix, which is what
    makes ``Cell_0`` distinguishable from ``Cell_8``.
    """
    grouped: dict[str, list[int]] = {}
    for index in range(len(mesh.faces)):
        key = mesh.face_groups[index] if index < len(mesh.face_groups) else mesh.name
        grouped.setdefault(key, []).append(index)
    return grouped


def every_generated_mesh() -> dict[str, MeshData]:
    meshes: dict[str, MeshData] = {}
    for module in (build_pieces, character, harvestables, weapons, terrain):
        meshes.update(module.generate_all())
    return meshes


# ---------------------------------------------------------------------------


class TestContainer:
    def test_header_and_chunks_are_well_formed(self):
        # Glb's constructor asserts magic, version, total length and that the
        # chunk lengths tile the file exactly.
        Glb(encode_glb(box(size=(4.0, 4.0, 4.0))))

    def test_chunks_are_four_byte_aligned(self):
        # An unaligned chunk is the classic GLB bug: it loads in the tool that
        # wrote it and fails in everything else.
        raw = encode_glb(box(size=(1.0, 2.0, 3.0), name="Odd"))
        offset = 12
        while offset < len(raw):
            length, _ = struct.unpack_from("<II", raw, offset)
            assert length % 4 == 0, f"chunk at {offset} has unaligned length {length}"
            offset += 8 + length

    def test_buffer_length_matches_the_binary_chunk(self):
        glb = Glb(encode_glb(box(size=(2.0, 2.0, 2.0))))
        # The declared length may be shorter than the padded chunk, never longer.
        declared = glb.json["buffers"][0]["byteLength"]
        assert declared <= len(glb.binary)
        assert len(glb.binary) - declared < 4

    def test_accessor_offsets_are_aligned_to_their_component_size(self):
        glb = Glb(encode_glb(harvestables.tree(0)))
        for accessor in glb.json["accessors"]:
            view = glb.json["bufferViews"][accessor["bufferView"]]
            assert view["byteOffset"] % 4 == 0

    def test_encoding_is_deterministic(self):
        # The manifest's review story depends on a generator change being the
        # only thing that can change the bytes.
        mesh = harvestables.rock(1)
        assert encode_glb(mesh) == encode_glb(mesh)


class TestAxisConversion:
    def test_blender_z_becomes_gltf_y(self):
        assert to_gltf_position((0.0, 0.0, 1.0)) == (0.0, 1.0, 0.0)

    def test_blender_y_becomes_negative_gltf_z(self):
        assert to_gltf_position((0.0, 1.0, 0.0)) == (0.0, 0.0, -1.0)

    def test_x_is_unchanged(self):
        assert to_gltf_position((1.0, 0.0, 0.0)) == (1.0, 0.0, 0.0)

    def test_the_conversion_preserves_handedness(self):
        # If this flips, every mesh exports mirrored and winding would need
        # reversing to compensate. The determinant of the map must be +1.
        x = to_gltf_position((1.0, 0.0, 0.0))
        y = to_gltf_position((0.0, 1.0, 0.0))
        z = to_gltf_position((0.0, 0.0, 1.0))
        assert cross(x, y) == pytest.approx(z)

    def test_a_wall_keeps_its_height_on_the_gltf_up_axis(self):
        # The regression that matters: a 4 m wall must be 4 m tall in the
        # client, not 4 m deep.
        mesh = build_pieces.generate_all()["SM_Build_Wall_Wood"]
        low, high = mesh.bounds()
        blender_height = high[2] - low[2]

        glb = Glb(encode_glb(mesh))
        ys = [p[1] for primitive in glb.json["meshes"][0]["primitives"]
              for p in glb.accessor(primitive["attributes"]["POSITION"])]
        assert max(ys) - min(ys) == pytest.approx(blender_height, abs=1e-5)


class TestWinding:
    def test_box_triangles_all_face_outward(self):
        """The test that would catch a mirrored export.

        For a convex solid centred on the origin, a correctly wound triangle's
        normal points away from the centre. Reversing the winding, or flipping
        handedness without reversing it, inverts every one of these.
        """
        mesh = box(size=(2.0, 3.0, 4.0), centre=(0.0, 0.0, 0.0))
        glb = Glb(encode_glb(mesh))

        for primitive in glb.json["meshes"][0]["primitives"]:
            for a, b, c in glb.triangles(primitive):
                normal = cross(sub(b, a), sub(c, a))
                centroid = tuple((a[i] + b[i] + c[i]) / 3.0 for i in range(3))
                assert dot(normal, centroid) > 0, "triangle faces inward"

    def test_stored_normals_agree_with_the_winding(self):
        # A mesh can be wound correctly and still carry normals that disagree,
        # which lights it inside-out.
        mesh = box(size=(2.0, 2.0, 2.0))
        glb = Glb(encode_glb(mesh))
        primitive = glb.json["meshes"][0]["primitives"][0]
        positions = glb.accessor(primitive["attributes"]["POSITION"])
        normals = glb.accessor(primitive["attributes"]["NORMAL"])
        indices = [i[0] for i in glb.accessor(primitive["indices"])]

        for i in range(0, len(indices), 3):
            a, b, c = (positions[indices[i + k]] for k in range(3))
            geometric = cross(sub(b, a), sub(c, a))
            assert dot(geometric, normals[indices[i]]) > 0


class TestOrientation:
    """Orientation bugs that a viewport screenshot would not reveal."""

    @pytest.mark.parametrize("name", sorted(every_generated_mesh()))
    def test_asset_has_positive_signed_volume(self, name: str):
        """Every closed mesh must be wound outward.

        The divergence theorem gives a closed mesh's signed volume from its
        triangles; a negative result means the whole mesh is inside-out. Unlike
        the convex outward-normal check this holds for a union of boxes, which
        is what most of these assets are.
        """
        mesh = every_generated_mesh()[name]
        if not mesh.is_manifold_ish():
            pytest.skip(f"{name} is not closed, so signed volume is undefined")

        glb = Glb(encode_glb(mesh))
        volume = 0.0
        for primitive in glb.json["meshes"][0]["primitives"]:
            for a, b, c in glb.triangles(primitive):
                volume += dot(a, cross(b, c)) / 6.0
        assert volume > 0, f"{name} is wound inside-out (signed volume {volume:.3f})"

    def test_ramp_rises_towards_positive_gltf_z(self):
        """The direction the simulation walks up.

        ``surfaceHeight`` in web/src/render/collision.ts returns
        ``base.y + localZ / CELL_SIZE * CELL_SIZE``, so the walkable surface
        rises with **+Z**. Blender -Y maps to glTF +Z. A ramp authored the other
        way is walkable from the end it visibly descends to, which is the
        preview-disagrees-with-reality failure pillar 1 forbids.
        """
        mesh = build_pieces.generate_all()["SM_Build_Ramp_Wood"]
        positions = [to_gltf_position(v) for v in mesh.vertices]
        peak = max(p[1] for p in positions)
        top_edge_z = {round(p[2], 3) for p in positions if p[1] > peak - 0.01}
        assert top_edge_z == {2.0}, f"top edge sits at z={top_edge_z}, expected +2.0"

    def test_cone_peaks_in_the_middle(self):
        # The cone has no rise direction to get wrong, but an off-centre peak
        # would disagree with the symmetric height query just as badly.
        mesh = build_pieces.generate_all()["SM_Build_Cone_Wood"]
        positions = [to_gltf_position(v) for v in mesh.vertices]
        peak = max(p[1] for p in positions)
        apex = [p for p in positions if p[1] > peak - 0.01]
        for point in apex:
            assert abs(point[0]) < 0.01 and abs(point[2]) < 0.01

    def test_edit_mask_index_zero_is_the_top_left_cell(self):
        """Which corner a mask bit refers to.

        The renderer resolves a click to a sub-cell with ``subCellIndex``, which
        puts index 0 at the top-left with columns running along increasing world
        X. The generator has to agree, or an asymmetric edit comes out mirrored
        or upside down. Both shipped masks -- doorway and window -- are
        horizontally symmetric, so nothing in the game would reveal a mirrored
        column mapping; this uses an asymmetric mask on purpose.
        """
        cleared_top_left = (False,) + (True,) * 8
        mesh = build_pieces.wall_variant(build_pieces.WOOD, cleared_top_left, "Probe")

        # Group vertices by the part each face belongs to, then place each
        # part by its own centre. Proximity to a third's centre does not work:
        # a box has vertices only at its corners, which sit on the boundary it
        # shares with its neighbour.
        third = units.WALL_WIDTH / 3.0
        occupied: set[tuple[int, int]] = set()
        for part_name, face_indices in _parts_by_name(mesh).items():
            xs = [mesh.vertices[i][0] for f in face_indices for i in mesh.faces[f]]
            zs = [mesh.vertices[i][2] for f in face_indices for i in mesh.faces[f]]
            centre_x = (min(xs) + max(xs)) / 2.0
            centre_z = (min(zs) + max(zs)) / 2.0
            column = int((centre_x + units.WALL_WIDTH / 2.0) // third)
            row_from_bottom = int(centre_z // third)
            occupied.add((column, row_from_bottom))
            assert part_name.startswith("Cell_")

        # Index 0 cleared means the TOP (row 2 from the bottom) LEFT (column 0,
        # the low-X side) is the hole, and nothing else is.
        assert (0, 2) not in occupied, "index 0 should clear the top-left cell"
        assert (2, 2) in occupied, "the top-right cell should remain"
        assert (0, 0) in occupied, "the bottom-left cell should remain"
        assert len(occupied) == 8, f"expected exactly one hole, got {9 - len(occupied)}"

    def test_weapons_point_the_way_their_holder_faces(self):
        """The direction a weapon is authored along.

        The docs used to claim the barrel ran along +X *because* that was the
        character's forward axis. It is not: Blender +X maps to glTF +X, which
        is the character's right, so a weapon attached to a hand would have
        pointed out sideways. Weapons are assembled along +X and then turned
        onto -Y, which is glTF +Z -- the way the character faces.
        """
        for name, mesh in weapons.generate_all().items():
            positions = [to_gltf_position(v) for v in mesh.vertices]
            depth = max(p[2] for p in positions) - min(p[2] for p in positions)
            width = max(p[0] for p in positions) - min(p[0] for p in positions)
            assert depth > width, (
                f"{name} is {width:.2f} m across and {depth:.2f} m deep; "
                "its long axis should run along +Z, the forward axis"
            )

    def test_every_weapon_has_a_grip_socket(self):
        # Without it the renderer has nothing to line up with the hand.
        for name, mesh in weapons.generate_all().items():
            assert "Grip" in mesh.sockets, f"{name} has no Grip socket"

    def test_the_character_offers_the_socket_weapons_ask_for(self):
        mesh = character.generate_all()["SM_Character_Default"]
        assert "GripRight" in mesh.sockets

    def test_a_transform_carries_sockets_with_the_geometry(self):
        """The trap this closes.

        A mesh whose vertices moved but whose sockets did not is a weapon held a
        hand's width from the hand, and nothing about it looks wrong until you
        see it in a scene.
        """
        mesh = build_pieces.generate_all()["SM_Build_Wall_Wood"].copy()
        mesh.sockets = {"Probe": (1.0, 0.0, 0.0)}
        mesh.pivots = {"Probe": (0.0, 1.0, 0.0)}

        moved = mesh.translated((5.0, 0.0, 0.0))
        assert moved.sockets["Probe"] == pytest.approx((6.0, 0.0, 0.0))
        assert moved.pivots["Probe"] == pytest.approx((5.0, 1.0, 0.0))

        turned = mesh.rotated_z(90.0)
        assert turned.sockets["Probe"] == pytest.approx((0.0, 1.0, 0.0), abs=1e-9)

    def test_character_faces_positive_gltf_z(self):
        """The direction yaw zero points.

        The motor's forward is ``yawRotate(vec3(0, 0, 1), yaw)``, so yaw zero is
        glTF +Z, which is Blender -Y. A character authored facing the other way
        runs backwards, and the third-person camera -- which sits behind the
        player along -forward -- ends up staring at its face.

        The brow block is the asymmetry that makes this checkable at all: a
        symmetric box figure has no detectable facing.
        """
        mesh = character.generate_all()["SM_Character_Default"]
        positions = [to_gltf_position(v) for v in mesh.vertices]

        # Head height, so the brow is the only thing this far forward.
        head = [p for p in positions if p[1] > mesh.bounds()[1][2] - 0.25]
        assert max(p[2] for p in head) > abs(min(p[2] for p in head)), (
            "the head's forward detail should sit at +Z"
        )

    def test_character_matches_the_blueprint_height(self):
        mesh = character.generate_all()["SM_Character_Default"]
        low, high = mesh.bounds()
        assert low[2] == pytest.approx(0.0), "a character must stand on Z=0"
        assert high[2] == pytest.approx(units.CHARACTER_HEIGHT, abs=1e-6)

    def test_character_parts_are_named_for_their_hitboxes(self):
        # CharacterBlueprint.hitboxes names these; the client tints a limb on
        # hit by matching the primitive's group, so a rename must not drift.
        mesh = character.generate_all()["SM_Character_Default"]
        groups = {name for name, _ in mesh.primitive_groups()}
        assert groups == {
            "Head", "Chest", "Pelvis", "ArmLeft", "ArmRight", "LegLeft", "LegRight",
        }

    def test_character_fits_through_a_doorway_edit(self):
        # The doorway mask removes the middle and bottom-middle of a 3x3 face,
        # so the gap is a third of the cell. A proxy wider than that cannot walk
        # through its own edits, which would make the edit system unusable.
        mesh = character.generate_all()["SM_Character_Default"]
        width = mesh.size()[0]
        assert width < units.CELL_SIZE / 3.0

    def test_pieces_are_authored_with_their_base_at_the_cell_floor(self):
        """The origin convention the renderer places against.

        Every build piece sits on the cell floor at glTF y=0 and is centred in
        x and z. The renderer relies on this to line a loaded mesh up with the
        grid slot; a piece authored centred on its own origin would float half
        a cell high.
        """
        for name, mesh in build_pieces.generate_all().items():
            low, high = mesh.bounds()
            # Blender z is glTF y. The skirt is allowed to hang below.
            assert low[2] >= -units.SKIRT_DEPTH - 0.01, f"{name} starts at z={low[2]}"
            assert high[2] <= units.CELL_SIZE + 0.01, f"{name} reaches z={high[2]}"
            assert abs(low[0] + high[0]) < 0.01, f"{name} is not centred in x"


class TestShading:
    def test_face_corners_are_not_shared_between_faces(self):
        """Flat shading needs split vertices; sharing one smooths the edge."""
        mesh = box(size=(1.0, 1.0, 1.0))
        glb = Glb(encode_glb(mesh))
        primitive = glb.json["meshes"][0]["primitives"][0]
        positions = glb.accessor(primitive["attributes"]["POSITION"])
        normals = glb.accessor(primitive["attributes"]["NORMAL"])

        # A cube corner appears in three faces with three different normals.
        by_position: dict[tuple[float, ...], set[tuple[float, ...]]] = {}
        for position, normal in zip(positions, normals):
            by_position.setdefault(position, set()).add(normal)
        assert any(len(n) == 3 for n in by_position.values()), "corners were welded"

    def test_every_triangle_has_one_normal_across_its_corners(self):
        # Walk the indices rather than assuming three vertices per triangle:
        # corners are shared within a face, so a quad contributes four
        # vertices to two triangles.
        mesh = box(size=(1.0, 2.0, 1.0))
        glb = Glb(encode_glb(mesh))
        primitive = glb.json["meshes"][0]["primitives"][0]
        normals = glb.accessor(primitive["attributes"]["NORMAL"])
        indices = [i[0] for i in glb.accessor(primitive["indices"])]

        for i in range(0, len(indices), 3):
            corners = {normals[indices[i + k]] for k in range(3)}
            assert len(corners) == 1, f"triangle {i // 3} has {len(corners)} normals"

    def test_a_quad_face_contributes_four_vertices_not_six(self):
        # The saving that motivates sharing corners within a face.
        mesh = box(size=(1.0, 1.0, 1.0))
        glb = Glb(encode_glb(mesh))
        primitive = glb.json["meshes"][0]["primitives"][0]
        positions = glb.accessor(primitive["attributes"]["POSITION"])
        indices = glb.accessor(primitive["indices"])
        assert len(positions) == 6 * 4, "six quad faces, four corners each"
        assert len(indices) == 6 * 2 * 3, "six quads, two triangles each"

    def test_newell_handles_a_non_planar_quad(self):
        # A cross product of the first three corners would ignore the fourth.
        mesh = MeshData(name="Skew")
        for position in ((0, 0, 0), (1, 0, 0), (1, 1, 0.5), (0, 1, 0)):
            mesh.add_vertex(position)
        mesh.add_face((0, 1, 2, 3))
        normal = face_normal(mesh.vertices, mesh.faces[0])
        assert normal[2] > 0.9, "normal should still point broadly +Z"
        assert abs(normal[0]) > 1e-6, "a skewed quad should tilt the normal"


class TestUvs:
    def test_v_is_flipped_for_gltf(self):
        mesh = MeshData(name="Quad")
        for position in ((0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)):
            mesh.add_vertex(position)
        mesh.add_face((0, 1, 2, 3), [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)])

        glb = Glb(encode_glb(mesh))
        primitive = glb.json["meshes"][0]["primitives"][0]
        uvs = glb.accessor(primitive["attributes"]["TEXCOORD_0"])
        assert (0.0, 1.0) in uvs, "Blender v=0 should become glTF v=1"
        assert (1.0, 0.0) in uvs, "Blender v=1 should become glTF v=0"


class TestPrimitiveGroups:
    def test_a_tree_exports_its_trunk_and_canopy_separately(self):
        glb = Glb(encode_glb(harvestables.tree(0)))
        groups = [p["extras"]["group"] for p in glb.json["meshes"][0]["primitives"]]
        assert "Trunk" in groups
        assert "Canopy" in groups

    def test_repeated_parts_coalesce_into_one_primitive(self):
        # Seventeen panels must not become seventeen draw calls.
        mesh = build_pieces.generate_all()["SM_Build_Wall_Wood"]
        glb = Glb(encode_glb(mesh))
        assert len(glb.json["meshes"][0]["primitives"]) <= 3

    def test_part_role_strips_only_numeric_suffixes(self):
        assert part_role("Panel_0_0") == "Panel"
        assert part_role("Canopy_3") == "Canopy"
        assert part_role("SM_Build_Wall_Wood") == "SM_Build_Wall_Wood"
        assert part_role("Trunk") == "Trunk"


class TestEveryShippedAsset:
    @pytest.mark.parametrize("name", sorted(every_generated_mesh()))
    def test_asset_encodes_and_round_trips(self, name: str):
        mesh = every_generated_mesh()[name]
        glb = Glb(encode_glb(mesh))

        assert glb.json["meshes"][0]["name"] == name
        primitives = glb.json["meshes"][0]["primitives"]
        assert primitives, f"{name} exported no geometry"

        total_triangles = 0
        for primitive in primitives:
            assert primitive["mode"] == MODE_TRIANGLES
            total_triangles += len(glb.triangles(primitive))
        assert total_triangles == mesh.triangle_count

    def test_document_declares_every_accessor_it_uses(self):
        document, _ = build_gltf_document(harvestables.vehicle(0))
        used = set()
        for primitive in document["meshes"][0]["primitives"]:
            used.update(primitive["attributes"].values())
            used.add(primitive["indices"])
        assert used == set(range(len(document["accessors"])))
