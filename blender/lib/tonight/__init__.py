"""Tonight's procedural asset generation library.

Every mesh in the game comes out of this library (ADR-0004). Two hard rules
shape its structure:

1. **This package must import without ``bpy``.** The geometry, naming, and
   validation logic lives here so it can be unit-tested in ordinary CI with no
   Blender install. Anything that touches ``bpy`` belongs in ``blender/scripts/``
   or behind the adapter in :mod:`tonight.blender_adapter`.

2. **Generators are deterministic.** Every random draw comes from
   :func:`tonight.rng.seeded`. Re-running a generator reproduces the same mesh,
   which is what makes art reviewable in a diff and regenerable in CI.
"""

from tonight.units import CELL_SIZE, WALL_HEIGHT, WALL_WIDTH  # noqa: F401
from tonight.mesh import MeshData  # noqa: F401
from tonight.rng import seeded  # noqa: F401

__version__ = "0.1.0"
