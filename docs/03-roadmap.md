# Roadmap

Seven milestones. Each has **hard exit criteria** — objective, checkable
statements. A milestone is not done because it feels done; it is done when every
box is ticked.

Milestones are deliberately ordered so the riskiest unknowns land early. Netcode
and building come before content, because if those two do not work the project
has no reason to continue.

---

## How to read the checkboxes

This repository was built without a Unity licence, a running Editor, or a
Blender install. That splits every exit criterion into two kinds, and they are
marked differently throughout:

| Mark | Meaning |
| --- | --- |
| `[x]` | **Done and verified.** Something automated checks it and fails if it regresses. |
| `[~]` | **Implemented, unverified.** The code and assets exist and are covered by tests that have never been executed, because running them needs the Unity Editor. |
| `[ ]` | **Not done.** |

`[~]` is the honest answer for most of M1–M5. The simulation layer is written
and carries 215 EditMode tests, but **no C# in this repository has ever been
compiled**. Treat the first Unity open as a debugging pass, not a demo.

What *is* verified is everything reachable without an engine: 136 Python tests
covering the Blender generator library, terrain and map constraints, and the
Blueprint validator; plus 57 seed Blueprint assets that the validator checks on
every push.

A criterion needing a running game — "frame time under 8 ms", "100 simulated
clients hold 30 Hz", "playable end to end by real players" — cannot be ticked
from here at all, and is marked `[ ]` with a note rather than quietly claimed.

---

## M0 — Foundation *(this repository, current)*

Design and technical specification, project skeleton, art pipeline.

**Exit criteria**

- [x] Vision, GDD, and technical architecture written and internally consistent.
- [x] Blueprint authoring contract specified with a full schema reference.
- [x] One spec per gameplay system.
- [x] Unity project opens on a clean checkout with packages resolving.
- [x] Blender generator library runs headless and is covered by tests.
- [x] `build_all.py` produces every placeholder asset from scratch.
- [x] MCP wiring documented for both Unity and Blender.
- [x] CI runs generator tests and Blueprint validation on every push.

**Risk retired:** none — this milestone exists to make the later ones estimable.

---

## M1 — Vertical slice: one player, one island

A single player can move around a small piece of terrain and harvest it. No
networking yet.

**Exit criteria**

- [~] Character controller matching the movement table in the GDD, driven by a
      `MovementBlueprint`. `CharacterMotor` is a pure step function; 17 tests.
- [x] 200 m × 200 m test terrain with trees and rocks. Generated, and asserted
      to satisfy the slope and open-terrain constraints.
- [~] Harvesting yields materials at the specified rates, with seed-derived
      weak points. The GDD's loop timings are re-derived by test.
- [ ] Material counts display in a working HUD. `MaterialWallet` exists; no UI
      is wired, because a HUD needs prefabs and a scene.
- [ ] Frame time under 8 ms. **Needs a running Editor and the reference machine.**
- [~] EditMode tests cover movement value application from Blueprint.

**Risk retired:** art pipeline actually delivers usable meshes into Unity.

---

## M2 — Building

The core mechanic, single-player.

**Exit criteria**

- [~] All four piece types placeable on the 4 m grid, driven by
      `BuildPieceBlueprint`. All four exist as seed assets.
- [~] Placement preview is grid-accurate. Preview and placement share one
      transform function, so they cannot disagree by construction.
- [~] Build-HP ramp implemented; a test shows 95 damage kills a fresh wall and
      not a matured one.
- [~] Structural integrity: destroying a support collapses everything above it,
      budgeted at 32 collapses per tick, and rebuilding a leg rescues the stack.
- [~] Edit mode with doorway and window variants, as 3×3 masks.
- [~] A 1×1 box can be built in under 0.7 s of input time.
- [ ] Practice range scene exists and is playable. **Needs the Editor.**
- [~] **A new build piece can be added by creating one Blueprint asset and one
      mesh, with zero C# changes.** The seam exists; unprovable until someone
      does it in the Editor.

**Risk retired:** the building system is tractable and asset-driven.

---

## M3 — Combat

Weapons, damage, loot. Still single-player, against dummies.

**Exit criteria**

- [~] Five weapon classes implemented from `WeaponBlueprint` assets. All five
      exist as seed assets with authored stats.
- [~] Rarity multipliers applied; headshots register at the specified multipliers.
- [~] Structure damage multipliers per class working.
- [x] Loot tables roll correctly; distribution verified statistically over 10⁵
      rolls. The RNG's weighted pick is verified in Python over 2×10⁵ draws.
- [~] Chests and floor spawns populate a test POI, deterministically from the
      match seed.
- [~] Inventory: 5 slots, pickup, drop, swap, stacking for consumables.
- [ ] Damage numbers and hit markers. **Needs prefabs and a scene.**
- [~] **A new weapon can be added with one Blueprint asset and one mesh.**

**Risk retired:** combat feel is achievable with the chosen feedback model.

---

## M4 — Netcode and the first real match

The hard one. Everything above becomes server-authoritative and 100 players run
at once.

**Exit criteria**

- [ ] Dedicated server build runs headless on Linux. **Needs a build.**
- [~] Server-authoritative movement with client prediction and reconciliation.
      `MovementPredictionBuffer` snaps and replays; a test requires two
      independently built histories to reconcile bit-identically.
- [~] Build placement is predicted client-side and confirmed by the server, with
      correct rollback on rejection. One `Validate` shared by both sides.
- [~] Lag-compensated hit registration, bounded at 250 ms rewind.
- [~] Storm implemented across all eight phases. `StormDirector` runs the
      schedule; the lighting arc is authored as a seed asset but not wired to a
      light rig.
- [~] Full match flow: lobby → bus → freefall → match → victory, with only the
      documented transitions legal.
- [ ] **100 simulated clients hold a 30 Hz server tick.** **Cannot be measured
      from here.** This is the milestone's real gate and it remains open.
- [~] Bandwidth under 128 kbit/s down per client. The 9-byte structure record is
      asserted by test and the arithmetic checks out against the budget, but the
      figure is derived, not measured.
- [ ] Solo mode playable end to end by real players. **Needs a running game.**

**Risk retired:** the whole thing. If M4 fails, the design needs to change.

---

## M5 — Squads and the real map

**Exit criteria**

- [~] Duos and Squads, with DBNO and revives, toggled by `MatchRulesBlueprint`.
      Three rules assets; `SquadState` runs unchanged in all three.
- [ ] Squad UI: teammate health, markers, ping system. **Needs a scene.**
- [x] Nightfall Isle laid out: 5 major POIs, 12 minor, 8 landmarks, placed on a
      1400 m heightfield.
- [x] **Map satisfies the GDD's spacing and slope constraints, verified by a
      tooling check, not by eye.** 36.9° max slope against a 40° limit, 55.4%
      open terrain against a 30% minimum, worst nearest-neighbour 247.7 m
      against a 450 m limit. The validator is itself tested against deliberately
      broken maps, so passing means something.
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

The simulation layer for M1–M5 is written and specified. The presentation
layer — scenes, prefabs, UI, the light rig, audio — is not, because every part
of it needs the Unity Editor.

**The single next task** is to open `unity/Tonight/` and compile. Nothing in
this repository has been through a C# compiler, so expect errors. After that,
in order:

1. Fix compile errors and run the 215 EditMode tests. They encode the design
   decisions; a failure is information, not noise.
2. Work the Editor Console's list of unbound art references — that list is the
   binding checklist, and runbook RB-07 covers it.
3. Export the Blender meshes (`build_all.py`) and bind them to the seed pieces.
4. Build the practice range scene. That closes most of M1–M2's open boxes at
   once and makes the build system playable.
5. Only then start M4's load test, which is the project's real gate.

## Honest risks

| Risk | Why it is real |
| --- | --- |
| Uncompiled C# | ~4,500 lines never compiled. Some of it is wrong. The tests are written but have never run. |
| M4's gate is untested | 100 clients at 30 Hz is the criterion that decides whether the design survives, and nothing here moves it. |
| Deferring netcode (ADR-0003) | Mitigated by writing M1–M3 command-style, and reconciliation determinism is tested — but only against a flat plane, not real collision. |
| No art bound | Meshes generate and Blueprints exist, but nothing connects them yet. |
| Collapse cascade cost | Budgeted at 32/tick and tested, but never measured under a real end-game structure. |

## Not scheduled

Vehicles, mobile, console, voice chat, cosmetics economy, anti-cheat product.
See [00-vision.md](00-vision.md) §"What Tonight is not".
