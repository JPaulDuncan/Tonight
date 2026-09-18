# Art

**Imported meshes land here.** Nothing in this folder is hand-authored.

The source of truth for every mesh is the Python generator in
`blender/lib/tonight/` (see [ADR-0004](../../../../../docs/adr/0004-procedural-art-pipeline.md)).
To populate this folder:

```bash
blender --background --python blender/scripts/build_all.py
```

then copy `blender/exports/**` here, keeping the folder split:

| Subfolder | Source category |
| --- | --- |
| `Build/` | Walls, floors, ramps, cones, and their edit variants |
| `Weapons/` | Weapons and the pickaxe |
| `Harvestables/` | Trees, rocks, vehicles |
| `Terrain/` | Heightfield meshes |

Binding these to the seed Blueprints is runbook
[RB-07](../../../../../docs/mcp/runbooks.md).

This file exists so the folder survives a `git clone`: git does not track empty
directories, and a tracked `Art.meta` with no `Art/` folder beside it is an
orphaned meta that both Unity and the repository's hygiene check reject.
