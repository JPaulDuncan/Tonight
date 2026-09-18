# Roadmap

Seven milestones. Each has **hard exit criteria** — objective, checkable
statements. A milestone is not done because it feels done; it is done when every
box is ticked.

Milestones are deliberately ordered so the riskiest unknowns land early. Netcode
and building come before content, because if those two do not work the project
has no reason to continue.

---

## How to read the checkboxes

| Mark | Meaning |
| --- | --- |
| `[x]` | **Done and verified.** Something automated checks it and fails if it regresses. |
| `[~]` | **Partially done** — working but incomplete, or working only in the sandbox. |
| `[ ]` | **Not done.** |

Every `[x]` below is checked by `npm run verify`, `npm run smoke`, or
`pytest blender/tests` on every push. Nothing is marked done on the strength of
having been written.

This replaces the earlier Unity-era honesty note, which had to distinguish
"implemented" from "ever compiled". That distinction is gone: the code runs.

**Rescoped to 30 players** ([ADR-0007](adr/0007-threejs-instead-of-unity.md)).
The map, storm schedule, POI counts and squad sizes in the GDD all moved with
it, and the tests re-derive them.

---

## M0 — Foundation

Design and technical specification, project skeleton, art pipeline.

**Exit criteria**

- [x] Vision, GDD, and technical architecture written and internally consistent.
- [x] Blueprint authoring contract specified with a full schema reference.
- [x] One spec per gameplay system.
- [x] The game builds and runs from a clean checkout with one `npm install`.
- [x] Blender generator library runs headless and is covered by tests.
- [x] `build_all.py` produces every placeholder asset from scratch.
- [x] MCP wiring documented for Blender.
- [x] CI runs simulation tests, Blueprint validation, art generator tests and a
      headless browser smoke test on every push.

**Risk retired:** none — this milestone exists to make the later ones estimable.

---

## M1 — Vertical slice: one player, one island

A single player can move around terrain and harvest it. No networking.

**Exit criteria**

- [x] Character controller matching the GDD movement table, driven by data.
      `stepMotor` is a pure step function; 20 tests, including a
      bit-identical replay check over 1000 randomised commands.
- [x] Terrain with trees and rocks, satisfying the slope and open-terrain
      constraints it declares.
- [x] Harvesting yields materials at the specified rates, with seeded weak
      points and the GDD's loop timings re-derived by test.
- [x] Material counts display in a working HUD.
- [~] Frame budget. 60+ fps on a real GPU is untested; the CI smoke test runs
      SwiftShader software rendering at ~14 fps, which says nothing about real
      hardware. Needs measuring on the reference machine.
- [x] Tests cover movement value application from data.

**Risk retired:** the simulation runs, is deterministic, and is testable
headless.

---

## M2 — Building

The core mechanic, single-player. **Largely complete and playable.**

**Exit criteria**

- [x] All four piece types placeable on the 4 m grid, driven by data.
- [x] Placement preview is grid-accurate and never disagrees with the placed
      result. Both go through one transform and one range check — two real bugs
      came from letting them diverge, and a test now fires 400 randomised aim
      directions through every piece type against an occupied structure.
- [x] Build-HP ramp: 95 damage kills a fresh wall and not a matured one, and
      damage does not freeze the ramp.
- [x] Structural integrity: destroying a support collapses what it carried,
      rebuilding a leg inside the 0.4 s window rescues the stack, and collapses
      are budgeted at 32 per tick.
- [~] Edit mode. Masks, variants, health scaling and ownership rules are
      implemented and tested; there is no drag UI in the sandbox yet.
- [x] A 1×1 box can be built in under 0.7 s of input time.
- [x] Playable sandbox scene.
- [x] **A new build piece needs one JSON entry and one mesh, with no code
      change.**

**Risk retired:** the building system is tractable, data-driven, and fun enough
to keep iterating on.

---

## M3 — Combat

Weapons, damage, loot. Still single-player, against dummies.

**Exit criteria**

- [x] Five weapon classes defined as data, with a firing state machine that
      branches per fire mode and never per weapon.
- [x] Rarity multipliers and headshot multipliers applied. A sniper headshot
      kills through full shield at 50 m; a body shot does not.
- [x] Structure damage multipliers per class: the SMG shreds builds, the shotgun
      does not.
- [x] Loot tables roll correctly; distribution verified over 10⁵ rolls.
- [x] Chests and floor spawns populate a POI, reproducibly from the match seed.
- [~] Inventory: slots, stacking and ammo counters are ported from the Unity
      version but not yet re-tested or wired to the sandbox.
- [ ] Damage numbers and hit markers.
- [ ] Edit variants render. The doorway and window meshes export and the lookup
      reaches them; the renderer still draws the solid piece after an edit.
- [ ] Weapons usable in the sandbox — the firing code has no trigger bound to it
      yet, so combat is tested but not playable.
- [x] **A new weapon needs one JSON entry and one mesh.**

**Risk retired:** combat feel is achievable with the chosen feedback model.

**Art pipeline closed (ADR-0008).** The client loads the generated `.glb` files;
the export runs in pure Python, so CI produces the meshes the web job then loads.
Wiring it up caught two bugs nothing could have caught while the export step
needed a Blender install: an FBX writer being handed a `.glb` path, and ramps
authored rising the opposite way to the direction collision walks.

---

## M4 — Netcode and the first real match

The hard one. Everything above becomes server-authoritative and 100 players run
at once.

**Exit criteria**

- [ ] Authoritative Node server. The simulation already runs headless, which is
      most of the work; nothing is wired yet.
- [~] Client prediction and reconciliation. The design and the determinism it
      needs are proven — replaying a command sequence is bit-identical — but the
      reconciliation buffer itself has not been ported yet.
- [~] Lag compensation. Designed and specified; not ported.
- [x] Storm across all seven phases: monotonic shrink, reproducible from seed,
      and no player stranded beyond the rotation clamp.
- [~] Match flow. Ported in the Unity version; not yet re-ported.
- [ ] **30 clients hold a 30 Hz server tick**, measured.
- [ ] **Rendering holds up with 30 players and thousands of build pieces in
      WebGL.** This is now the project's top technical risk, and the reason for
      the rescope. Needs instanced rendering and culling that Unity would have
      provided.
- [ ] Solo mode playable end to end by real players.

**Risk retired:** the whole thing. If M4 fails, the design needs to change.

---

## M5 — Squads and the real map

**Exit criteria**

- [~] Duos and Trios, with DBNO and revives, toggled by data. Three rules
      entries exist; `SquadState` is not yet re-ported.
- [ ] Squad UI: teammate health, markers, ping system. **Needs a scene.**
- [~] Nightfall Isle: 14 POIs defined as data for the 800 m map. The Python
      layout tool still targets the old 1400 m island and needs rescaling.
- [x] **Map constraints verified by tooling, not by eye.** The validator is
      itself tested against deliberately broken maps, so passing means
      something. It needs re-running against the 800 m spec.
- [ ] Matchmaking assembles a 100-player lobby from a queue.
- [ ] Full 18-minute match completes without a desync. **Needs a running game.**

---

## M6 — Polish and release candidate

**Exit criteria**

- [ ] Audio implemented to the GDD's information requirements, including the
      distant-gunfire layer.
- [ ] Every open design question in GDD §12 is closed and documented.
- [ ] Performance: 60 fps at 1080p on the minimum spec machine.
- [ ] Reconnect-to-match-in-progress works.
- [ ] Server sanity checks reject out-of-band movement, fire rate, and build rate.
- [ ] Onboarding: a new player reaches their first build without reading anything.
- [ ] No known crash or desync in 50 consecutive full matches.

---

## Sequencing rationale

Three ordering choices worth defending:

**Netcode at M4, not M1.** The conventional advice is to build multiplayer from
day one. Tonight does not, because the building system's shape is the larger
unknown and it is cheaper to discover that shape single-player. The mitigation is
that M1–M3 are written *as if* networked: all gameplay state changes go through
command objects that the server layer can later validate, and nothing reads input
directly in a simulation path. ADR-0003 covers this in detail and it is the single
most likely place for this plan to go wrong.

**Building before combat.** Building is the pillar. If it is not fun without
guns, guns will not save it.

**The real map last.** Map content is the most expensive thing to build and the
cheapest thing to get wrong. Every milestone before M5 uses the practice range
and a small test island.

## Where this actually stands

**The build-fight loop is playable.** Movement, harvesting, placement, collapse
and the HP ramp all work in a browser and are covered by tests that run.

**What is missing is a match.** Combat is simulated and tested but has no
trigger bound to it; the storm runs in tests but not in the scene; there is no
networking, no other players, and no match flow.

The next tasks, in order:

1. Bind weapons to the sandbox — fire, reload, hit structures. Combat is already
   tested, so this is wiring rather than design.
2. Run the storm live in the sandbox with the night-clock lighting arc driving
   the scene. The director works; the renderer ignores it.
3. Re-port inventory, squads and match flow from the Unity branch. The logic is
   written and was reviewed; it needs translating and re-testing.
4. Instanced rendering for build pieces, then measure. This is the gate — and
   now measurable against the real meshes rather than against boxes, which
   matters because a generated wall is 408 vertices where a box was 24.
5. Only then the authoritative server.

## Honest risks

| Risk | Why it is real |
| --- | --- |
| WebGL at scale | The reason for the rescope. Thousands of build pieces plus 30 players needs instancing and culling that Unity gave us for free. Unmeasured. |
| No networking yet | The largest unbuilt piece. The simulation is shaped for it — commands, determinism, shared validation — but shaped-for is not built. |
| Collision is bespoke | Exact for axis-aligned pieces on a known grid, and deliberately limited beyond that. Terrain edge cases will surface. |
| Art is bound, but thin | The client loads the generated glTF and the pipeline is covered end to end. What it loads is still stylised blocking geometry with no textures or materials, and no animation exists at all. |
| Sandbox is not a match | Everything above M2 is tested in isolation, not in a running game. |

## Not scheduled

Vehicles, mobile, console, voice chat, cosmetics economy, anti-cheat product.
See [00-vision.md](00-vision.md) §"What Tonight is not".
