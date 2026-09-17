# Technical architecture

Version 0.1 · Owner: engineering

## 1. Stack

| Layer | Choice | Rationale |
| --- | --- | --- |
| Engine | Unity 6000.0 LTS | Required by the brief. Mature C# tooling, good headless server story. |
| Render pipeline | URP | Stylised art (pillar 3) needs no HDRP feature. URP hits the 100-player frame budget on mid-spec hardware. |
| Networking | Netcode for GameObjects + Unity Transport | First-party, server-authoritative, integrates with prediction. See [ADR-0002](adr/0002-netcode-stack.md). |
| Input | Unity Input System | Action-map abstraction keeps a controller port possible. |
| Content authoring | ScriptableObject "Blueprints" | See [ADR-0001](adr/0001-blueprint-data-layer.md). |
| Art generation | Blender 4.2+ headless Python | See [ADR-0004](adr/0004-procedural-art-pipeline.md). |
| Agent control | unity-mcp + blender-mcp | See [ADR-0005](adr/0005-mcp-as-build-tooling.md). |

## 2. The shape of the codebase

The central architectural idea: **C# is a runtime, Blueprints are the program.**

```
   ┌─────────────────────────────────────────────────────────────┐
   │  Blueprint assets (ScriptableObjects)                        │
   │  WeaponBlueprint · BuildPieceBlueprint · LootTableBlueprint  │
   │  StormPhaseBlueprint · MovementBlueprint · …                 │
   └───────────────────────────┬─────────────────────────────────┘
                               │ read at runtime, never mutated
   ┌───────────────────────────▼─────────────────────────────────┐
   │  Tonight.Gameplay — generic systems                          │
   │  "apply a WeaponBlueprint" not "apply the shotgun"           │
   └───────────────────────────┬─────────────────────────────────┘
                               │ commands + events
   ┌───────────────────────────▼─────────────────────────────────┐
   │  Tonight.Net — authority, replication, prediction            │
   └───────────────────────────┬─────────────────────────────────┘
                               │
   ┌───────────────────────────▼─────────────────────────────────┐
   │  Tonight.Core — math, grid, RNG, service locator             │
   └─────────────────────────────────────────────────────────────┘
```

A system in `Tonight.Gameplay` may never name a specific piece of content. There
is no `if (weapon.name == "Shotgun")` anywhere in the codebase; there is
`weapon.pelletCount`. This is checked in review and is the single most important
code-quality rule in the project.

## 3. Assembly graph

Each module is a separate assembly definition (`.asmdef`). Assemblies enforce the
dependency direction — a violation is a compile error, not a code review comment.

```
Tonight.Core                 (no Unity gameplay deps; math, grid, RNG)
   ▲
   ├── Tonight.Blueprints     (ScriptableObject schema; depends on Core only)
   │      ▲
   │      ├── Tonight.Gameplay    (systems that consume Blueprints)
   │      │      ▲
   │      │      ├── Tonight.Net       (replication of gameplay state)
   │      │      └── Tonight.UI        (HUD; reads gameplay, never writes)
   │      │
   │      └── Tonight.Editor      (Editor-only: inspectors, validation, gen tools)
   │
   └── Tonight.Tests.EditMode / Tonight.Tests.PlayMode
```

Rules:

- `Tonight.Core` references no other Tonight assembly, and nothing Unity-specific
  beyond `UnityEngine.CoreModule`. It is the part that could be unit-tested
  outside Unity.
- `Tonight.Blueprints` holds **only** data definitions and validation. No
  behaviour, no `Update()`.
- `Tonight.Editor` is `includePlatforms: [Editor]`. Nothing runtime may reference
  it — this is what stops Editor-only code shipping in a build.
- `Tonight.UI` may read gameplay state and raise input intents. It may never
  mutate simulation state directly.

## 4. Data flow: one build placement, end to end

Worth tracing once in full, because it exercises every layer and it is the
project's latency-critical path.

```
1. Input System reports "place" action
      │
2. BuildController (Gameplay, client) resolves target cell from camera ray,
   quantised by Tonight.Core.BuildGrid
      │
3. Local validation against the active BuildPieceBlueprint:
   material cost affordable? cell free? support present?
      │
4. PREDICT: piece spawns locally, immediately, at build-HP.
   The player sees it this frame. ← pillar 1 lives here
      │
5. A PlaceBuildCommand (cell, face, pieceId, materialId, clientTick)
   goes to the server
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

| Aspect | Decision |
| --- | --- |
| Topology | Dedicated server, headless Linux build |
| Authority | Server for all simulation |
| Tick rate | 30 Hz simulation, 20 Hz snapshot send |
| Client prediction | Movement and build placement |
| Reconciliation | Rewind + replay from last acked server state |
| Hit registration | Server-side lag compensation, 250 ms rewind cap |
| Interest management | Grid-cell based; clients receive only nearby entities |
| Build replication | Delta over a structure graph, not per-GameObject transforms |

Build replication deserves a note: replicating thousands of build pieces as
individual networked GameObjects does not fit the bandwidth budget. Instead the
structure is a sparse graph keyed by grid cell, and the wire format is
`(cell, face, pieceId, materialId, hpBucket)` — 9 bytes per piece. Clients
instantiate visuals from that. See ADR-0002.

## 6. Performance budget

Per frame, 1080p, reference machine (Ryzen 5 5600 / RTX 3060):

| Budget | Target |
| --- | --- |
| Frame time | 16.6 ms (60 fps) |
| CPU main thread | ≤ 8 ms |
| Render thread | ≤ 6 ms |
| Gameplay simulation | ≤ 2 ms |
| Build system | ≤ 1 ms |
| GC allocation | **0 bytes** in steady state |

Zero steady-state allocation is a hard rule, not an aspiration. It means:

- No LINQ in per-frame code paths.
- No `foreach` over interfaces in hot loops.
- Pooled projectiles, damage events, and build previews.
- `NativeArray` / `struct` for the build grid.

Server budget, per tick at 100 players: **33 ms wall clock, ≤ 20 ms used.**

## 7. Scene structure

| Scene | Contents |
| --- | --- |
| `Boot` | Service bootstrap, Blueprint registry load. Additively loads everything else. |
| `Frontend` | Main menu, mode select |
| `PracticeRange` | Single-player sandbox; ships at M2 |
| `Match_NightfallIsle` | The map. Split into additive terrain chunks. |
| `Systems_Gameplay` | Gameplay managers, loaded additively into any match scene |

`Boot` is always scene 0. Nothing else may assume it is loaded first — systems
resolve dependencies through the registry rather than by scene order.

## 8. Blueprint loading

Blueprints are loaded through `BlueprintRegistry`, built at import time by an
Editor script that scans `Assets/Tonight/Blueprints/`. At runtime, lookup is by
a stable `BlueprintId` (a string GUID authored on the asset), never by asset name
or path — renaming an asset must not break a save, a replay, or a wire message.

The registry is an addressable-backed lookup so that a build only loads the
Blueprints a given scene needs.

## 9. Testing strategy

| Level | Where | What it covers |
| --- | --- | --- |
| Pure unit | `blender/tests/` (pytest) | Generator library, mesh math |
| EditMode | `Assets/Tonight/Tests/EditMode/` | Blueprint validation, grid math, loot distribution, damage formulas |
| PlayMode | `Assets/Tonight/Tests/PlayMode/` | Movement, build placement, prediction/reconciliation |
| Integration | `tools/` harness | Headless server + N simulated clients |
| Statistical | EditMode | Loot tables over 10⁵ rolls against expected distribution |

Loot distribution deserves a statistical test rather than an example-based one:
a weighted table that is subtly wrong still produces plausible individual rolls.

## 10. Build and CI

CI runs on every push:

1. `pytest blender/tests` — generator library, no Blender required.
2. `tools/validate_blueprints.py` — schema-checks every Blueprint asset.
3. Unity EditMode tests, when a Unity licence is available to the runner.

Art regeneration (`build_all.py`) runs on demand rather than per push, because it
needs a Blender install and produces binary output that does not belong in git.

## 11. Known architectural risks

Stated plainly, because pretending they do not exist is how projects fail.

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Build prediction mispredicts under packet loss, causing visible pop | High | Adopt-not-respawn on confirm (§4 step 7); extensive reconciliation tests at M4 |
| Structural-integrity cascade is O(structure) and spikes the server tick | High | Cascade is budgeted per tick and spread across ticks; 0.4 s delay is cover for this |
| Netcode arriving at M4 reveals a gameplay assumption that does not survive being networked | High | M1–M3 written command-style as if networked; ADR-0003 |
| Blueprint layer becomes a bottleneck — designers wait on new *fields* | Medium | Fields are cheap to add; watch for it, revisit if it recurs |
| 100-player interest management is harder than budgeted | Medium | Prototype interest management at M4 start, not M4 end |
| Blender determinism breaks across Blender versions | Low | Version pinned in `tools/requirements.txt`; CI asserts mesh hashes |

## Next

- [blueprints/README.md](blueprints/README.md) — the authoring contract.
- [adr/](adr/) — the decisions behind this document.
- [systems/](systems/) — per-system specifications.
