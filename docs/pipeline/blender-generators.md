# Writing a Blender generator

A generator is a Python function that returns a `MeshData`. It does not touch
`bpy`, it is deterministic, and it derives its dimensions from
`tonight.units` rather than from literals.

## The shape of one

```python
from tonight import units
from tonight.mesh import MeshData, box
from tonight.rng import seeded


def crate(variant: int = 0) -> MeshData:
    """A wooden crate. Harvestable for wood."""
    name = units.asset_name(units.PREFIX_STATIC_MESH, "Harvest", "Crate", f"{variant:02d}")
    rng = seeded("crate", salt=variant)          # seeded, never module-level random

    size = rng.uniform(0.8, 1.2)
    body = box(size=(size, size, size), centre=(0.0, 0.0, size / 2.0), name=name)
    #                                            ^ base at Z=0, not centred

    return MeshData.join([body], name=name)
```

Then register it:

1. Add it to the module's `generate_all()`.
2. Make sure the module is in `GENERATORS` in `blender/scripts/build_all.py`.
3. Make sure the category is in `CATEGORY_FOLDERS` in `tonight/export.py`.

## The rules, and why each one exists

### Never import `bpy`

Generators live in `blender/lib/tonight/`, which must import with no Blender
installed. This is what lets CI run the geometry tests on every push rather than
only when someone remembers to open Blender.

If you genuinely need a Blender operator — a bevel, a boolean, a real UV unwrap
— the generator returns `MeshData` and a *script* in `blender/scripts/` applies
the operator afterwards. Keep the split.

### Seed every random draw

```python
rng = seeded("crate", salt=variant)     # yes
value = random.uniform(0, 1)            # no
```

Module-level `random` ties a generator's output to whatever ran before it in the
same process, so running one family alone would produce different meshes than
running the full build. `test_generators_do_not_share_rng_state` checks this
explicitly.

`seeded()` uses a SHA-256-derived seed rather than Python's `hash()`, because
`hash()` is randomised per process and would make "deterministic" generators
produce different geometry on every run.

### Derive dimensions from `units`

```python
box(size=(units.CELL_SIZE, thickness, units.CELL_SIZE))   # yes
box(size=(4.0, 0.2, 4.0))                                 # no
```

A literal `4.0` means changing the cell size changes the code but not the art,
and the mismatch shows up as pieces that no longer tile.

### Put the base at Z = 0 for world props

A prop centred on the origin floats or sinks when placed. Build pieces are the
exception: they are positioned by their grid slot, and the wall deliberately
hangs `SKIRT_DEPTH` below zero.

### Keep faces wound counter-clockwise from outside

`MeshData.is_manifold_ish()` catches a missing face; it does not catch inverted
winding. If a mesh renders inside-out in the client, check the vertex order in the
face that is wrong.

## Testing a generator

Every generator needs, at minimum:

```python
def test_dimensions(self):
    width, depth, height = crate(0).size()
    assert 0.7 < width < 1.3

def test_variants_differ(self):
    assert len({crate(v).content_hash() for v in range(5)}) == 5

def test_is_reproducible(self):
    assert crate(0).content_hash() == crate(0).content_hash()

def test_is_well_formed(self):
    assert crate(0).validate() == []
```

Prefer asserting **properties** over exact vertex positions. "A wall spans
exactly one cell" survives a refactor of how the wall is built; "vertex 7 is at
(2, 0.1, 4)" does not, and a test that breaks on every harmless change stops
being read.

The one place an exact value is right is the content-hash regression test, which
is hard-coded precisely so it cannot be self-fulfilling.

## Debugging in Blender

Prototype interactively, then write the generator. To see what your generator
produces:

```bash
blender --python-expr "
import sys; sys.path.insert(0, 'blender/lib')
from tonight.harvestables import tree
from tonight.blender_adapter import create_object
create_object(tree(0))
"
```

Remember that nothing you build by hand in the GUI is real until it is a
generator — `.blend` files are not committed
([ADR-0004](../adr/0004-procedural-art-pipeline.md)).

## Common mistakes

| Symptom | Cause |
| --- | --- |
| Asset is rotated 90° in the client | Exported without going through `export_gltf()` |
| Asset is 100× too big | Metres/centimetres mix-up; the pre-export check catches extents over 500 m |
| Asset floats above the ground | Mesh centred on the origin instead of based at Z = 0 |
| Asset renders inside-out | Face winding is clockwise from outside |
| Mesh has holes | A missing cap face; `is_manifold_ish()` catches it |
| Hash changes on every run | An unseeded `random` call, or `hash()` instead of `stable_hash()` |
| Two materials produce identical meshes | The generator accepted a `style` argument and ignored it |
