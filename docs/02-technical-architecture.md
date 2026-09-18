# Technical architecture

Version 0.1 · Owner: engineering

## 1. Stack

| Layer | Choice | Rationale |
| --- | --- | --- |
| Client | three.js + TypeScript | Runs in a browser with no install. See [ADR-0007](adr/0007-threejs-instead-of-unity.md). |
| Build | Vite | Fast dev server, one production bundle. |
| Tests | vitest, Node environment | The simulation is headless, so the tests need no DOM. |
| Content | JSON in `web/data/` | See [ADR-0001](adr/0001-blueprint-data-layer.md). |
| Art | Python generators exporting glTF, no Blender on the build path | See [ADR-0004](adr/0004-procedural-art-pipeline.md) and [ADR-0008](adr/0008-headless-gltf-export.md). |
| Networking | Not yet built. Authoritative Node server planned. | ADR-0002's stack is superseded; its 9-byte structure channel survives as a design. |

## 2. The shape of the codebase

Two ideas, and everything follows from them.

**TypeScript is a runtime; the JSON is the program.**

```
   web/data/*.json          weapons · pieces · loot · storm · rules
          │  read at boot, validated, never mutated
          ▼
   src/blueprints           schema + registry + cross-asset validation
          │
          ▼
   src/gameplay             generic systems: "apply a weapon", never "the shotgun"
          │  commands + events
          ▼
   src/render               three.js, collision, HUD, input
```

**The simulation does not know the renderer exists.**

`src/gameplay` imports no three.js and touches no DOM. That is not stylistic: it
is what lets 288 tests run in Node in under two seconds, and it is what will let
the same code run on an authoritative server without a rewrite.

The boundary is enforced by review and by the tests themselves — a test that
needs a browser means the code under test is in the wrong layer.

## 3. Module boundaries

```
core           grid, RNG, math. No engine, no DOM, no dependencies.
  ▲
blueprints     schema, registry, validation. Depends on core.
  ▲
gameplay       motor, build, combat, combatant, consumable, bot,
               harvest, loot, storm.
               Depends on core + blueprints. NEVER on render.
  ▲
render         three.js scene, collision, meshes, HUD, input.
               The only place the browser exists.
```

Rules:

- `core` has no imports outside itself.
- `gameplay` may never import `render` or `three`. This is the load-bearing rule.
- `render` reads gameplay state and produces commands. It never mutates
  simulation state directly.
- Content lives in `web/data/`, never in code.

## 4. Data flow: one build placement, end to end

Worth tracing once in full, because it exercises every layer and it is the
project's latency-critical path.

```
1. The render layer reads a click and the camera transform
      │
2. resolvePlacement (gameplay) turns the camera ray into a (cell, slot),
   quantised by core/grid
      │
3. Local validation against the active build piece Blueprint:
   material cost affordable? cell free? support present?
      │
4. PREDICT: piece spawns locally, immediately, at build-HP.
   The player sees it this frame. ← pillar 1 lives here
      │
5. A PlaceBuildCommand (cell, slot, pieceId, materialId, tick)
   goes to the server (not yet built; today it applies locally)
      │
6. Server re-runs step 3 authoritatively. It trusts nothing:
   re-checks cost, occupancy, support, and the player's build-rate budget
      │
   ├── accepted → spawns networked piece, broadcasts to all clients
   └── rejected → sends rejection with the client tick
      │
7. Client reconciles. On rejection the predicted piece is removed and the
   materials are refunded. On acceptance the predicted piece is adopted by
   the networked object rather than respawned, so there is no visual pop.
```

Step 4 before step 6 is what makes the game feel good. Step 6 not trusting step 3
is what keeps it honest. Both are non-negotiable.

## 5. Networking model

Full detail: [systems/netcode.md](systems/netcode.md). Summary:

**Not yet built.** The design below stands; the implementation does not exist.

| Aspect | Decision |
| --- | --- |
| Topology | Authoritative Node server |
| Authority | Server for all simulation |
| Tick rate | 30 Hz simulation, 20 Hz snapshot send |
| Client prediction | Movement and build placement |
| Transport | WebSocket (WebRTC data channels if latency demands it) |
| Reconciliation | Rewind + replay from last acked server state |
| Hit registration | Server-side lag compensation, 250 ms rewind cap |
| Interest management | Grid-cell based; clients receive only nearby entities |
| Build replication | Delta over a structure graph, not per-object transforms |

Build replication deserves a note: replicating thousands of build pieces as
individual networked objects does not fit the bandwidth budget. Instead the
structure is a sparse graph keyed by grid cell, and the wire format is
`(cell, face, pieceId, materialId, hpBucket)` — 9 bytes per piece. Clients
instantiate visuals from that. See ADR-0002.

## 6. Performance budget

Per frame, 1080p, reference machine:

| Budget | Target |
| --- | --- |
| Frame time | 16.6 ms (60 fps) |
| Simulation | ≤ 2 ms |
| Build system | ≤ 1 ms |
| GC pressure | No per-frame allocation in hot paths |

**None of this is measured yet**, and the browser makes it harder than Unity
would have. Draw calls are the constraint: a late-game fight puts thousands of
build pieces on screen, and three.js gives no automatic batching or LOD. The
plan is instanced rendering keyed by (piece, material), which turns the whole
structure into a handful of draw calls — but it is unwritten, and until it is
measured the 30-player target is an aspiration.

That risk is the reason the player count was rescoped from 100
([ADR-0007](adr/0007-threejs-instead-of-unity.md)).

## 7. Scene structure

There are no scene files. The world is assembled in code from data:

| Piece | Source |
| --- | --- |
| Terrain | `render/terrain.ts`, a seeded heightfield |
| Props | Dart-thrown scatter over the heightfield |
| Build pieces | Instantiated from the structure graph as it changes |
| Lighting | `lighting.nightfall` keyframes, interpolated by storm phase |

For a procedurally generated map this is close to neutral against a scene
editor. For hand-placed set dressing it is a real loss, and is named as a cost
in ADR-0007.

## 8. Blueprint loading

The six JSON files in `web/data/` are imported by `blueprints/library.ts`, which
Vite inlines at build time — so the browser makes no extra requests and the
tests read them synchronously.

Lookup is by a stable dotted id (`weapon.shotgun`, `piece.wall`), never by file
path or array position. Renaming a file must not break a save, a replay, or a
wire message.

`validateLibrary` runs at boot. A content error fails loudly with a list of
findings rather than producing a subtly wrong game.

## 9. Testing strategy

| Level | Where | What it covers |
| --- | --- | --- |
| Simulation | `web/tests/` (vitest, Node) | Grid, motor, build, combat, harvest, loot, storm, validation |
| Statistical | `web/tests/systems.test.ts` | Loot tables over 10⁵ rolls against expected distribution |
| Browser | `web/tools/smoke.mjs` (Playwright) | Boots, walks, harvests, builds; asserts on the HUD |
| Art | `blender/tests/` (pytest) | Generator library, mesh math, map constraints |

The browser smoke test earns its place: it caught two bugs no unit test would
have, both cases of the preview ghost disagreeing with where the piece actually
landed.

Loot distribution deserves a statistical test rather than an example-based one:
a weighted table that is subtly wrong still produces plausible individual rolls.

## 10. Build and CI

CI runs on every push:

1. `npm run typecheck` — TypeScript in strict mode.
2. `npm test` — 150 simulation tests, including content validation.
3. `npm run build` — the production bundle must build.
4. The Playwright smoke test, with the screenshot uploaded as an artifact.
5. `pytest blender/tests` — generator library, no Blender required.

Art regeneration (`build_all.py`) runs on demand rather than per push, because it
needs a Blender install and produces binary output that does not belong in git.

## 11. Known architectural risks

Stated plainly, because pretending they do not exist is how projects fail.

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **WebGL cannot hold 30 players and thousands of pieces** | **High** | Instanced rendering keyed by (piece, material); unwritten and unmeasured. This is the top risk. |
| Networking is entirely unbuilt | High | The simulation is shaped for it — commands, determinism, shared validation — but shaped-for is not built |
| Build prediction mispredicts under packet loss, causing visible pop | High | Adopt-not-respawn on confirm (§4 step 7); reconciliation tests when networking lands |
| Structural-integrity cascade is O(structure) and spikes the server tick | High | Cascade is budgeted per tick and spread across ticks; 0.4 s delay is cover for this |
| Networking reveals a gameplay assumption that does not survive being networked | High | Written command-style throughout, and replay determinism is tested; ADR-0003 |
| Blueprint layer becomes a bottleneck — designers wait on new *fields* | Medium | Fields are cheap to add; watch for it, revisit if it recurs |
| 100-player interest management is harder than budgeted | Medium | Prototype interest management at M4 start, not M4 end |
| Blender determinism breaks across Blender versions | Low | Version pinned in `tools/requirements.txt`; CI asserts mesh hashes |
| Collision is bespoke rather than a physics engine | Medium | Exact for axis-aligned pieces on a known grid; terrain edge cases will surface |

## Next

- [blueprints/README.md](blueprints/README.md) — the authoring contract.
- [adr/](adr/) — the decisions behind this document.
- [systems/](systems/) — per-system specifications.
