# Roadmap

Seven milestones. Each has **hard exit criteria** — objective, checkable
statements. A milestone is not done because it feels done; it is done when every
box is ticked.

Milestones are deliberately ordered so the riskiest unknowns land early. Netcode
and building come before content, because if those two do not work the project
has no reason to continue.

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

- [ ] Character controller matching the movement table in the GDD, driven by a
      `MovementBlueprint`.
- [ ] 200 m × 200 m test terrain with trees and rocks imported from Blender.
- [ ] Harvesting yields materials at the specified rates.
- [ ] Material counts display in a working HUD.
- [ ] Frame time under 8 ms on the reference machine with the test terrain loaded.
- [ ] EditMode tests cover movement value application from Blueprint.

**Risk retired:** art pipeline actually delivers usable meshes into Unity.

---

## M2 — Building

The core mechanic, single-player.

**Exit criteria**

- [ ] All four piece types placeable on the 4 m grid, driven by `BuildPieceBlueprint`.
- [ ] Placement preview is grid-accurate and never disagrees with the placed result.
- [ ] Build-HP ramp implemented; a fresh wall is measurably weaker than a matured one.
- [ ] Structural integrity: destroying a support collapses everything above it.
- [ ] Edit mode with at least doorway and window variants.
- [ ] A 1×1 box can be built in under 0.7 s of input time.
- [ ] Practice range scene exists and is playable.
- [ ] **A new build piece can be added by creating one Blueprint asset and one
      mesh, with zero C# changes.** ← the milestone's real test

**Risk retired:** the building system is tractable and asset-driven.

---

## M3 — Combat

Weapons, damage, loot. Still single-player, against dummies.

**Exit criteria**

- [ ] Five weapon classes implemented from `WeaponBlueprint` assets.
- [ ] Rarity multipliers applied; headshots register at the specified multipliers.
- [ ] Structure damage multipliers per class working.
- [ ] Loot tables roll correctly; distribution verified statistically over 10⁵ rolls.
- [ ] Chests and floor spawns populate a test POI.
- [ ] Inventory: 5 slots, pickup, drop, swap, stacking for consumables.
- [ ] Damage numbers and hit markers distinguish player from structure hits.
- [ ] **A new weapon can be added with one Blueprint asset and one mesh.**

**Risk retired:** combat feel is achievable with the chosen feedback model.

---

## M4 — Netcode and the first real match

The hard one. Everything above becomes server-authoritative and 100 players run
at once.

**Exit criteria**

- [ ] Dedicated server build runs headless on Linux.
- [ ] Server-authoritative movement with client prediction and reconciliation.
- [ ] Build placement is predicted client-side and confirmed by the server, with
      correct rollback on rejection.
- [ ] Lag-compensated hit registration, bounded at 250 ms rewind.
- [ ] Storm implemented across all eight phases with the night-clock lighting arc.
- [ ] Full match flow: lobby → bus → freefall → match → victory.
- [ ] **100 simulated clients hold a 30 Hz server tick on an 8-core instance with
      60+ build events per second**, measured, not estimated.
- [ ] Bandwidth under 128 kbit/s down per client in a heavy end-game fight.
- [ ] Solo mode playable end to end by real players.

**Risk retired:** the whole thing. If M4 fails, the design needs to change.

---

## M5 — Squads and the real map

**Exit criteria**

- [ ] Duos and Squads, with DBNO and revives, toggled by `MatchRulesBlueprint`.
- [ ] Squad UI: teammate health, markers, ping system.
- [ ] Nightfall Isle complete: 5 major POIs, 12 minor, 8 landmarks.
- [ ] Map satisfies the GDD's spacing and slope constraints, verified by a
      tooling check, not by eye.
- [ ] Matchmaking assembles a 100-player lobby from a queue.
- [ ] Full 18-minute match completes without a desync or a server-side error.

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

## Not scheduled

Vehicles, mobile, console, voice chat, cosmetics economy, anti-cheat product.
See [00-vision.md](00-vision.md) §"What Tonight is not".
