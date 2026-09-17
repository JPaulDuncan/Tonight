# ADR-0003: Defer networking to M4, write M1–M3 command-style

**Status:** Accepted · **Date:** 2026-09-17 · **Deciders:** engineering

## Context

Conventional wisdom for multiplayer games is to network from the first commit.
The reasoning is sound: retrofitting networking onto single-player code reliably
reveals assumptions that cannot survive being networked — logic reading input
directly inside simulation, state mutated from five places, non-deterministic
update order — and the resulting rewrite is expensive.

The counter-pressure here is that Tonight's largest design unknown is not
networking, it is **whether the building system is fun**. Building is the pillar.
Iterating on build feel is dramatically faster single-player: no server to
restart, no prediction to reconcile, no two-machine test loop.

So this is a genuine trade, not an oversight.

## Decision

Build M1–M3 (movement, building, combat) single-player, then network at M4. To
keep the retrofit affordable, M1–M3 are written **as if already networked**, under
four rules enforced in review:

1. **All simulation state changes go through command objects.** Nothing mutates
   gameplay state inline. A command is a struct — `PlaceBuildCommand`,
   `FireCommand`, `MoveCommand` — with everything the server would need to
   validate it. At M1–M3 a local executor applies commands directly; at M4 the
   same commands become the wire format.
2. **No simulation code reads input.** Input produces commands at the edge.
   Anything downstream sees only commands.
3. **No simulation code reads `Time.deltaTime`.** Simulation runs on a fixed
   tick with an explicit `tick` and `dt` passed in, so replay during
   reconciliation is exact.
4. **Every command has a validation method separate from its application.**
   `Validate(state)` is pure and side-effect free. At M4 the server calls the
   identical method. Client-side prediction and server-side authority therefore
   share one implementation and cannot drift.

Rule 4 is the load-bearing one. Most networking retrofits fail because validation
logic gets written twice and the copies diverge.

## Consequences

**We accept:**

- Real risk that M4 still uncovers an assumption these rules did not catch. This
  is named in the architecture doc's risk table as high severity.
- More ceremony in M1–M3 than single-player code needs. Writing a command struct
  to make a player jump feels like overkill at M1 and pays for itself at M4.
- Interest management, bandwidth, and reconciliation remain unproven until M4,
  which is late for a discovery that could change the design.

**Mitigations:**

- M4 begins with an interest-management and bandwidth prototype, before feature
  work, so the scariest unknown is measured early in the milestone rather than
  late.
- A headless-server smoke test lands at M3 — the build runs headless and executes
  commands — well before real replication, so platform surprises surface early.

**We gain:**

- Build-feel iteration at single-player speed during the milestone where feel is
  the entire question.
- A command layer that is good architecture regardless: it makes replays,
  deterministic tests, and input rebinding straightforward.

## Alternatives considered

**Network from M1.** The safe choice. Rejected because it slows iteration during
the milestones where the core design question is still open, and a battle royale
with unfun building is a failed project no matter how good its netcode is.

**Network at M2, after building.** A reasonable middle. Rejected narrowly:
combat's hit registration is the other prediction-sensitive system, and doing
combat single-player first means M4 networks both prediction-heavy systems
together with one shared reconciliation design, rather than retrofitting combat
into an already-networked build system.
