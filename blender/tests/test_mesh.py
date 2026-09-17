"""Tests for the mesh primitives and MeshData operations."""

import math

import pytest
from tonight.mesh import MeshData, box, cylinder, pyramid, wedge


class TestPrimitives:
    @pytest.mark.parametrize(
        "mesh",
        [
            box((4.0, 0.2, 4.0)),
            wedge((4.0, 4.0, 4.0)),
            pyramid(4.0, 4.0),
            cylinder(0.5, 2.0),
            cylinder(1.0, 1.0, segments=3),
        ],
        ids=["box", "wedge", "pyramid", "cylinder", "min-segment-cylinder"],
    )
    def test_primitives_are_closed_solids(self, mesh):
        # Every edge used by exactly two faces. Catches the classic generator
        # bug of a missing cap face, which renders as a hole in the engine.
        assert mesh.is_manifold_ish(), f"{mesh.name} is not a closed solid"
        assert mesh.validate() == []

    def test_box_size_matches_request(self):
        mesh = box((4.0, 0.2, 3.0))
        width, depth, height = mesh.size()
        assert width == pytest.approx(4.0)
        assert depth == pytest.approx(0.2)
        assert height == pytest.approx(3.0)

    def test_box_is_centred_where_asked(self):
        mesh = box((2.0, 2.0, 2.0), centre=(10.0, -5.0, 3.0))
        low, high = mesh.bounds()
        assert low == pytest.approx((9.0, -6.0, 2.0))
        assert high == pytest.approx((11.0, -4.0, 4.0))

    def test_cylinder_rejects_degenerate_segment_counts(self):
        with pytest.raises(ValueError, match="at least 3 segments"):
            cylinder(1.0, 1.0, segments=2)

    def test_cylinder_radius_is_respected(self):
        mesh = cylinder(radius=0.5, height=2.0, segments=16)
        width, depth, height = mesh.size()
        assert height == pytest.approx(2.0)
        # A 16-gon inscribes slightly inside its circle, so width is at most 2r.
        assert width <= 1.0 + 1e-6
        assert width > 0.9

    def test_wedge_slope_is_exactly_45_degrees_on_a_cubic_cell(self):
        # The GDD's 45 degree ramp is a consequence of the grid, not a number
        # someone typed, so it should fall out of a cube-shaped wedge exactly.
        mesh = wedge((4.0, 4.0, 4.0))
        width, depth, height = mesh.size()
        assert math.degrees(math.atan2(height, depth)) == pytest.approx(45.0)


class TestMeshOperations:
    def test_translate_moves_every_vertex(self):
        mesh = box((1.0, 1.0, 1.0))
        moved = mesh.translated((5.0, 0.0, 0.0))
        low, _ = moved.bounds()
        assert low[0] == pytest.approx(4.5)
        # The original is untouched: these operations return new meshes.
        assert mesh.bounds()[0][0] == pytest.approx(-0.5)

    def test_scale_accepts_a_scalar_or_a_vector(self):
        mesh = box((1.0, 1.0, 1.0))
        assert mesh.scaled(2.0).size() == pytest.approx((2.0, 2.0, 2.0))
        assert mesh.scaled((2.0, 1.0, 3.0)).size() == pytest.approx((2.0, 1.0, 3.0))

    def test_rotate_z_by_90_swaps_the_horizontal_extents(self):
        mesh = box((4.0, 1.0, 1.0))
        rotated = mesh.rotated_z(90.0)
        width, depth, _ = rotated.size()
        assert width == pytest.approx(1.0, abs=1e-6)
        assert depth == pytest.approx(4.0, abs=1e-6)

    def test_rotate_z_by_360_is_identity(self):
        mesh = box((4.0, 1.0, 2.0), centre=(1.0, 2.0, 3.0))
        rotated = mesh.rotated_z(360.0)
        for original, turned in zip(mesh.vertices, rotated.vertices):
            assert turned == pytest.approx(original, abs=1e-9)

    def test_merge_reindexes_faces(self):
        a = box((1.0, 1.0, 1.0))
        b = box((1.0, 1.0, 1.0), centre=(5.0, 0.0, 0.0))
        merged = a.merge(b)

        assert merged.vertex_count == a.vertex_count + b.vertex_count
        assert merged.face_count == a.face_count + b.face_count
        # Every face index must still be in range after re-indexing.
        assert merged.validate() == []

    def test_join_of_nothing_is_empty_not_an_error(self):
        joined = MeshData.join([], name="Empty")
        assert joined.vertex_count == 0
        assert joined.face_count == 0

    def test_triangle_count_matches_fan_triangulation(self):
        mesh = box((1.0, 1.0, 1.0))
        assert mesh.face_count == 6
        assert mesh.triangle_count == 12


class TestValidation:
    def test_add_face_rejects_out_of_range_indices(self):
        mesh = MeshData()
        mesh.add_vertex((0.0, 0.0, 0.0))
        with pytest.raises(IndexError):
            mesh.add_face((0, 1, 2))

    def test_add_face_rejects_a_repeated_vertex(self):
        mesh = MeshData()
        for position in [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)]:
            mesh.add_vertex(position)
        with pytest.raises(ValueError, match="repeats a vertex"):
            mesh.add_face((0, 1, 1))

    def test_add_face_rejects_fewer_than_three_corners(self):
        mesh = MeshData()
        mesh.add_vertex((0.0, 0.0, 0.0))
        mesh.add_vertex((1.0, 0.0, 0.0))
        with pytest.raises(ValueError, match="at least 3 indices"):
            mesh.add_face((0, 1))

    def test_add_face_rejects_mismatched_uv_counts(self):
        mesh = MeshData()
        for position in [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)]:
            mesh.add_vertex(position)
        with pytest.raises(ValueError, match="does not match face corner count"):
            mesh.add_face((0, 1, 2), [(0.0, 0.0)])

    def test_validate_reports_a_non_finite_vertex(self):
        mesh = box((1.0, 1.0, 1.0))
        mesh.vertices[0] = (float("nan"), 0.0, 0.0)
        assert any("non-finite" in problem for problem in mesh.validate())

    def test_open_mesh_is_not_manifold(self):
        mesh = box((1.0, 1.0, 1.0))
        mesh.faces.pop()
        mesh.uvs.pop()
        assert not mesh.is_manifold_ish()


class TestContentHash:
    def test_hash_is_stable_across_calls(self):
        mesh = box((4.0, 0.2, 4.0))
        assert mesh.content_hash() == mesh.content_hash()

    def test_hash_is_stable_across_processes(self):
        # Hard-coded rather than computed: this is what catches an accidental
        # geometry change in a generator, so it must not be self-fulfilling.
        assert box((4.0, 0.2, 4.0)).content_hash() == "25a90257218a1bb1"

    def test_hash_changes_with_geometry(self):
        assert box((4.0, 0.2, 4.0)).content_hash() != box((4.0, 0.3, 4.0)).content_hash()

    def test_hash_ignores_sub_micrometre_noise(self):
        # Float noise below a micrometre is not a meaningful difference, and
        # treating it as one would make the hash useless for review.
        a = box((1.0, 1.0, 1.0))
        b = a.copy()
        b.vertices[0] = (b.vertices[0][0] + 1e-9, b.vertices[0][1], b.vertices[0][2])
        assert a.content_hash() == b.content_hash()

    def test_hash_ignores_the_name(self):
        a = box((1.0, 1.0, 1.0), name="A")
        b = box((1.0, 1.0, 1.0), name="B")
        assert a.content_hash() == b.content_hash()
