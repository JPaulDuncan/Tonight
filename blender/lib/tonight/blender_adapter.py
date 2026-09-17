"""The only module in the library permitted to touch ``bpy``.

Importing this module without Blender raises a clear error rather than failing
somewhere deeper, so the "library must import without bpy" rule has an obvious
boundary instead of an implicit one.
"""

from __future__ import annotations

from pathlib import Path

from tonight import units
from tonight.mesh import MeshData

try:  # pragma: no cover - exercised only inside Blender
    import bpy

    HAS_BPY = True
except ImportError:  # pragma: no cover - the CI path
    bpy = None
    HAS_BPY = False


def require_bpy() -> None:
    """Raise a useful error when called outside Blender."""
    if not HAS_BPY:
        raise RuntimeError(
            "This function needs Blender's Python. Run it as:\n"
            "  blender --background --python blender/scripts/build_all.py\n"
            "The pure-geometry parts of tonight.* work without Blender; only "
            "scene creation and export need it."
        )


def clear_scene() -> None:
    """Remove everything from the current scene.

    Generators run in a single Blender process one after another, so a stale
    object left behind would end up welded into the next asset's export.
    """
    require_bpy()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    # Orphaned datablocks survive object deletion and accumulate across a full
    # build, inflating memory and occasionally re-linking themselves.
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.objects):
        for datablock in list(collection):
            if datablock.users == 0:
                collection.remove(datablock)


def create_object(mesh: MeshData):
    """Create a Blender object from a :class:`MeshData`."""
    require_bpy()

    blender_mesh = bpy.data.meshes.new(mesh.name)
    blender_mesh.from_pydata(mesh.vertices, [], [list(face) for face in mesh.faces])
    blender_mesh.update()

    uv_layer = blender_mesh.uv_layers.new(name="UVMap")
    loop_index = 0
    for face_index, face in enumerate(mesh.faces):
        face_uvs = mesh.uvs[face_index] if face_index < len(mesh.uvs) else None
        for corner in range(len(face)):
            if face_uvs is not None and corner < len(face_uvs):
                uv_layer.data[loop_index].uv = face_uvs[corner]
            loop_index += 1

    obj = bpy.data.objects.new(mesh.name, blender_mesh)
    bpy.context.scene.collection.objects.link(obj)

    # Shade flat: the art is stylised and faceted (pillar 3), and smooth
    # shading on hard-edged generated geometry looks like a mistake.
    for polygon in blender_mesh.polygons:
        polygon.use_smooth = False

    return obj


def export_fbx(obj, destination: Path) -> Path:
    """Export one object to FBX with the project's axis and scale settings.

    **Always export through this function.** Calling
    ``bpy.ops.export_scene.fbx`` directly is prohibited because the axis
    conversion is easy to get wrong in a way that looks fine in the viewport and
    only surfaces later as rotated props or broken animation.
    """
    require_bpy()

    destination.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    bpy.ops.export_scene.fbx(
        filepath=str(destination),
        use_selection=True,
        apply_unit_scale=True,
        global_scale=units.METRES_PER_UNIT,
        apply_scale_options="FBX_SCALE_NONE",
        axis_forward=units.FBX_AXIS_FORWARD,
        axis_up=units.FBX_AXIS_UP,
        object_types={"MESH"},
        use_mesh_modifiers=True,
        mesh_smooth_type="FACE",
        use_tspace=True,
        bake_space_transform=True,
        path_mode="COPY",
    )

    return destination
