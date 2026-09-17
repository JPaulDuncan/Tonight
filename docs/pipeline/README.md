# Content pipeline

How art gets from a Python function into a Unity scene.

```
 blender/lib/tonight/          pure Python, no bpy, unit-tested in CI
   └─ generator function ──► MeshData ──► validate()
                                │
 blender/scripts/build_all.py   │  runs every generator
                                ▼
                      check_before_export()    unit errors, bad names, degenerates
                                │
                                ▼
        tonight.blender_adapter (the ONLY module importing bpy)
                                │  Z-up ──► Y-up, metric scale
                                ▼
                    blender/exports/<Category>/SM_*.fbx     (gitignored)
                    blender/exports/manifest.json           (committed)
                                │
                                ▼
            unity/Tonight/Assets/Tonight/Art/<Category>/
                                │
                                ▼
                   Prefab  ──►  Blueprint asset  ──►  in the game
```

## The three rules

**1. The Python is the source of truth, not the `.blend`.**
`.blend` files are not committed. Nor is exported FBX. Both are output, and the
generator is the asset ([ADR-0004](../adr/0004-procedural-art-pipeline.md)).

**2. The library must import without `bpy`.**
Geometry logic — the part with the bugs in it — lives in `blender/lib/tonight/`
and is tested on every push with no Blender install. Only
`tonight.blender_adapter` imports `bpy`, and it raises a clear error when called
outside Blender rather than failing somewhere deeper.

**3. Export goes through `tonight.export.export_fbx()`.**
Never `bpy.ops.export_scene.fbx` directly. That function owns the
Blender-Z-up → Unity-Y-up conversion and the metric scale. Getting the axis
wrong looks fine in the viewport and surfaces much later as rotated props.

## Running it

```bash
python3 -m pytest blender/tests -q                            # 1. tests first
python3 blender/scripts/build_all.py -- --dry-run             # 2. no Blender needed
git diff blender/exports/manifest.json                        # 3. what changed?
blender --background --python blender/scripts/build_all.py    # 4. real export
```

Step 3 is the point of the manifest, and it is what makes procedural art
reviewable. Content hashes show exactly which assets a generator change altered,
instead of leaving a reviewer to trust that "regenerated all art" did what it
said. If a change to the wall generator shows the *vehicle* hash moving,
something shares state that should not — most likely an RNG stream, which
`test_generators_do_not_share_rng_state` exists to catch.

Useful flags:

| Flag | Effect |
| --- | --- |
| `--dry-run` | Generate, validate, and write the manifest without touching Blender |
| `--only build` | One family. Repeatable: `--only build --only weapon` |
| `--out <dir>` | Write FBX somewhere other than `blender/exports` |

## What the pre-export checks catch

`check_before_export()` runs on every asset before anything is written:

| Check | Why |
| --- | --- |
| Mesh validates | Out-of-range face indices, non-finite vertices, UV/face mismatch |
| Non-zero extent | A degenerate mesh imports as an invisible object |
| Largest extent ≤ 500 m | Almost always a metres/centimetres mix-up, the single most common pipeline error |
| Name parses as `PREFIX_Category_Name` | A miscategorised asset lands in the wrong folder with the wrong import settings, and nobody notices until it renders wrong |

These fail the build rather than warning. A broken mesh reaching Unity costs far
more time to diagnose there than here.

## Adding a new asset family

1. Write `blender/lib/tonight/<family>.py` with a `generate_all()` returning
   `{asset_name: MeshData}`.
2. Register it in `GENERATORS` in `blender/scripts/build_all.py`.
3. Add the category to `CATEGORY_FOLDERS` in `tonight/export.py`.
4. Write tests in `blender/tests/`. At minimum: dimensions, determinism, and
   well-formedness for every asset the family produces.
5. Run the dry run and commit the manifest change.

## Further reading

- [units-and-naming.md](units-and-naming.md) — scale, axes, prefixes.
- [blender-generators.md](blender-generators.md) — writing a generator.
- [../adr/0004-procedural-art-pipeline.md](../adr/0004-procedural-art-pipeline.md) — why any of this.
