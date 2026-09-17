# Tonight — agent working notes

Battle royale in Unity 6 + Blender. Read `docs/00-vision.md` and
`docs/02-technical-architecture.md` before making non-trivial changes.

## The one rule

**Content goes in Blueprints, not C#.**

A "Blueprint" here is a `ScriptableObject` asset under
`unity/Tonight/Assets/Tonight/Blueprints/`. Adding a weapon, build piece, loot
table entry, storm phase, or ability must be doable by a designer creating an
asset in the Editor. If you find yourself writing `case WeaponId.Shotgun:` in
C#, stop — that data belongs on a Blueprint field.

C# in this project does three things and nothing else:
1. Defines Blueprint types (the schema).
2. Reads Blueprints at runtime and executes generic behaviour.
3. Networking, input, and rendering plumbing.

See `docs/blueprints/README.md` for the full contract.

## Layout

| Path | What lives there |
| --- | --- |
| `docs/` | All specs. Keep them current — a system change without a doc change is incomplete. |
| `unity/Tonight/Assets/Tonight/Scripts/` | Runtime C#, split by assembly (`.asmdef` per module) |
| `unity/Tonight/Assets/Tonight/Blueprints/` | ScriptableObject content assets |
| `blender/lib/tonight/` | Pure-Python generator library — **must import without `bpy`** |
| `blender/scripts/` | Blender entry points (`bpy` allowed here only) |
| `tools/` | Validation + build scripts |

## Conventions

- **Units:** 1 Unity unit = 1 metre. Blender scenes author in metres, export at
  scale 1.0. A build wall is 4 m × 4 m. See `docs/pipeline/units-and-naming.md`.
- **Assemblies:** every module folder has an `.asmdef`. Runtime assemblies must
  not reference Editor assemblies.
- **Naming:** `SM_` static mesh, `SK_` skeletal, `M_` material, `T_` texture,
  `BP_` Blueprint asset, `PF_` prefab.
- **Networking:** server-authoritative. Never trust a client-sent position,
  damage value, or build placement. See `docs/systems/netcode.md`.
- **Determinism:** Blender generators must be deterministic. Seed every random
  call from `tonight.rng.seeded(name)`.

## Commands

```bash
python3 -m pytest blender/tests -q                 # generator library tests
python3 tools/validate_blueprints.py               # schema-check Blueprint JSON/assets
blender --background --python blender/scripts/build_all.py   # regenerate all art
```

## Testing expectations

- `blender/lib/tonight/` is covered by pytest and must pass **without Blender
  installed** — keep `bpy` imports inside `blender/scripts/` or behind a guard.
- Unity EditMode tests live in `Assets/Tonight/Tests/EditMode/` and must not
  require entering Play mode.
- Blueprint assets are validated by `tools/validate_blueprints.py` in CI.

## Things that will bite you

- Blender's Z-up vs Unity's Y-up: **always** export via
  `tonight.export.export_fbx()`, which sets the axis conversion correctly. Do not
  call `bpy.ops.export_scene.fbx` directly.
- Unity `.meta` files are part of the asset. Never delete one without deleting
  its asset, and never regenerate GUIDs for an asset already referenced.
- The MCP servers talk to a *running* Editor/Blender instance. Tool calls fail
  silently-ish if the app is closed — check `docs/mcp/troubleshooting.md`.
