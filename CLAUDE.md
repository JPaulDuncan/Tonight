# Tonight — agent working notes

Browser battle royale in three.js + TypeScript, with art generated in
Blender. Read `docs/00-vision.md` and `docs/02-technical-architecture.md`
before making non-trivial changes, and [ADR-0007](docs/adr/0007-threejs-instead-of-unity.md)
for why this is not a Unity project any more.

## The one rule

**Content goes in Blueprints, not code.**

A "Blueprint" here is an entry in the JSON under `web/data/`. Adding a weapon,
build piece, loot table entry or storm phase must be doable by editing JSON.
If you find yourself writing `if (weapon.id === "weapon.shotgun")`, stop —
that data belongs on a Blueprint field. A shotgun is a weapon whose
`pelletCount` is above one; there is no shotgun code path.

TypeScript in this project does three things and nothing else:
1. Defines Blueprint types (the schema in `web/src/blueprints/types.ts`).
2. Reads Blueprints at runtime and executes generic behaviour.
3. Networking, input, and rendering plumbing.

See `docs/blueprints/README.md` for the full contract.

## Layout

| Path | What lives there |
| --- | --- |
| `docs/` | All specs. Keep them current — a system change without a doc change is incomplete. |
| `web/src/core/` | Grid, RNG, math. No engine, no DOM. |
| `web/src/gameplay/` | The simulation. **Imports no three.js** — it must run headless. |
| `web/src/render/` | three.js scene, collision, HUD. The only place the browser is touched. |
| `web/data/` | Blueprint JSON: the content set |
| `blender/lib/tonight/` | Pure-Python generator library — **must import without `bpy`** |
| `blender/scripts/` | Blender entry points (`bpy` allowed here only) |

## Conventions

- **Units:** 1 world unit = 1 metre, everywhere. Blender scenes author in
  metres and export at scale 1.0. A build wall is 4 m × 4 m. See
  `docs/pipeline/units-and-naming.md`.
- **Layering:** `gameplay` may import `core` and `blueprints`. It may never
  import `render` or three.js — that boundary is what keeps the simulation
  testable in Node and reusable on a server.
- **Naming:** meshes keep the `SM_`/`SK_`/`M_`/`T_` prefixes from the Blender
  pipeline. Blueprint ids are dotted and lowercase: `weapon.shotgun`,
  `piece.wall`, `storm.phase3`.
- **Networking:** server-authoritative. Never trust a client-sent position,
  damage value, or build placement. See `docs/systems/netcode.md`.
- **Determinism:** Blender generators must be deterministic. Seed every random
  call from `tonight.rng.seeded(name)`.

## Commands

```bash
cd web && npm install
npm run dev        # the playable sandbox at localhost:5173
npm test           # 313 simulation tests, under two seconds
npm run art        # regenerate the meshes the client loads (no Blender needed)
npm run verify     # typecheck + tests + production build
npm run smoke      # drive the built game in a real browser and screenshot it

python3 -m pytest blender/tests -q                            # art generator tests
python3 blender/scripts/build_all.py                          # regenerate all art
```

## Testing expectations

- `web/tests/` runs in Node with no DOM. If a test needs a browser, the code
  under test is in the wrong layer.
- `blender/lib/tonight/` is covered by pytest and must pass **without Blender
  installed** — keep `bpy` imports inside `blender/scripts/` or behind a guard.
- Blueprint JSON is validated at boot and by `tests/blueprints.test.ts`, which
  also feeds the validator deliberately broken content so a pass means
  something.

## Things that will bite you

- Blender is Z-up right-handed; three.js is Y-up right-handed. The one axis map
  lives in `tonight.gltf`, which writes `.glb` in pure Python — the build path
  needs no Blender at all (ADR-0008). Do not call `bpy.ops.export_scene.*`.
- Build pieces are authored **based at the cell floor**, not centred on their
  origin, and ramps rise toward **−Y** (glTF +Z) because that is the direction
  collision walks. Both are pinned by tests; see `docs/pipeline/loading-art.md`.
- Unlike the old Unity target, there is no handedness flip in this pipeline.
  A mesh that looks mirrored is a generator bug, not an export setting.
- The preview ghost and the placed piece must come from the same transform and
  the same range check. Two bugs have already come from letting them diverge;
  vision pillar 1 forbids it outright.
- A shot trace is expensive: every 12 cm step asks the structure grid about 45
  cells by 4 slots. One shooter is fine; five bots asking whether they can see
  you, thirty times a second, halved the frame rate. Line of sight is now asked
  last and only when a bot would otherwise fire, and `piecesNear` returns
  immediately when nothing is built.
- The Blender MCP server talks to a *running* Blender instance with the addon
  connected. Tool calls fail unhelpfully if it is not — see
  `docs/mcp/troubleshooting.md`. The art pipeline also runs fully headless.
