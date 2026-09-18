# Units, axes, and naming

Getting these wrong is the most common way a pipeline produces art that looks
right in Blender and wrong in the engine. Every constant here lives in
`blender/lib/tonight/units.py` rather than as a literal in a generator.

## Scale

**One world unit is one metre.** Blender authors in metres and exports at scale
1.0, so there is no conversion factor anywhere — a conversion factor is a thing
to forget.

| Constant | Value | Meaning |
| --- | --- | --- |
| `CELL_SIZE` | 4.0 m | The build grid cell ([ADR-0006](../adr/0006-build-grid-quantisation.md)) |
| `WALL_WIDTH`, `WALL_HEIGHT` | 4.0 m | One cell face |
| `PIECE_THICKNESS` | 0.2 m | Base slab thickness, scaled per material |
| `SKIRT_DEPTH` | 0.35 m | How far a wall hangs below its cell to meet sloped terrain |
| `CHARACTER_HEIGHT` | 1.8 m | Reference, used to assert a wall actually covers a player |

The 4 m cell is why the ramp's 45° is exact rather than approximate: it rises
one cell over one cell, so the angle falls out of the grid instead of being a
number someone typed.

## Axes

| | Up | Forward | Handedness |
| --- | --- | --- | --- |
| Blender | +Z | −Y | Right |
| glTF / three.js | +Y | −Z | Right |

Both are right-handed, so the export is a single axis change with no handedness
flip: `(x, y, z) -> (x, z, -y)`, applied once, in `tonight.gltf`. Its determinant
is +1, so winding is **not** reversed — a mesh that comes out mirrored is a
generator bug, not an export setting, and
`test_asset_has_positive_signed_volume` pins that for every shipped asset.

**Do not call `bpy.ops.export_scene.*` directly**
([ADR-0008](../adr/0008-headless-gltf-export.md)).

(The Unity target this pipeline was built for was Y-up *left*-handed, which made
this fiddlier. It is easier now, and the rule is unchanged — the setting still
lives in exactly one place, because it is the kind of mistake that looks fine in
the viewport and only surfaces later as rotated props.)

Two conventions that follow from this, and that generators must respect:

- **Weapons are built along +X.** After the conversion they point down the
  character's forward axis with no per-asset rotation baked into the mesh.
- **Props sit with their base at Z = 0.** A prop whose origin is not at its base
  floats or sinks when placed. `test_props_sit_on_the_ground_plane` checks this.
- **Build pieces are centred in X and Y and based at Z = 0**, spanning their
  cell. The renderer places them against the cell floor, so a piece centred on
  its own origin floats half a cell. See [loading-art.md](loading-art.md).
- **Ramps rise toward −Y**, which is +Z in glTF, because that is the direction
  the simulation's walkable-surface query rises. Getting this backwards produces
  a ramp that is walkable from the end it visibly descends to.

## Naming

```
<PREFIX>_<Category>_<Name>[_<Variant>]
```

Built with `units.asset_name()`, which rejects unknown prefixes, empty parts,
and underscores inside a part — the last one because an underscore in a part
makes the convention unparseable back into its pieces.

| Prefix | Meaning |
| --- | --- |
| `SM_` | Static mesh |
| `SK_` | Skeletal mesh |
| `M_` | Material |
| `T_` | Texture |

| Category | Export folder |
| --- | --- |
| `Build` | `Build/` |
| `Weapon` | `Weapons/` |
| `Tool` | `Weapons/` |
| `Harvest` | `Harvestables/` |

Examples:

```
SM_Build_Wall_Wood            SM_Build_Wall_Stone_Doorway
SM_Weapon_Sniper              SM_Tool_Pickaxe
SM_Harvest_Tree_00            BP_Weapon_AssaultRifle
```

The category is what routes an asset to its export folder, so
`category_for()` raises on an unknown one rather than guessing. A silently
miscategorised asset gets the wrong import settings and is found much later by
someone who cannot tell what it is.

## Triangle budget

100 players plus thousands of build pieces means individual assets stay cheap.
`test_triangle_budget_is_respected` caps every asset at **500 triangles**.

Current totals: 33 assets, 2322 triangles — an average of 70 per asset. That
headroom is deliberate; it is what pillar 3's "readable over realistic" buys.
