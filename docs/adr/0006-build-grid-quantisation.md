# ADR-0006: Absolute 4 m world-aligned build grid

**Status:** Accepted · **Date:** 2026-09-17 · **Deciders:** design, engineering

## Context

Build placement must be quantised. The open questions are the cell size and,
more consequentially, whether the grid is **absolute** (aligned to world origin,
identical for every player) or **relative** (aligned to the placing player's
position and facing).

A relative grid feels freer and lets a player place cover at exactly the angle
they want. An absolute grid means any two players building in the same area
produce interlocking geometry.

Cell size trades off cover granularity against piece count. Smaller cells mean
finer control and far more pieces to simulate, replicate, and render.

## Decision

An **absolute grid aligned to world origin, 4 m × 4 m × 4 m.**

- A cell is addressed by integer `(x, y, z)`. World position is `cell * 4.0`.
- Pieces attach to a cell **face** (wall, floor) or occupy the **interior**
  (ramp, cone).
- Grid coordinates are the network wire format (ADR-0002), so quantisation is
  not merely a placement aid — it is the data model.
- 4 m is chosen so a wall comfortably covers a 1.8 m character with headroom, and
  a ramp's 45° rise matches the cell height exactly. A 1×1×1 box is a 4 m cube:
  enough to move inside, small enough to be quickly destroyed.

## Consequences

**We accept:**

- Players cannot place cover at an arbitrary angle. Build orientation is one of
  four cardinal faces. This is a real expressive loss and it is the price of
  everything below.
- Structures on sloped terrain need a grounding rule, since a cell floor rarely
  matches the terrain height. Rule: a piece is supported if its cell intersects
  terrain at all; visual gaps are filled by the piece's skirt geometry, which is
  a generator parameter.
- 4 m is a large cell. Fine-grained cover is impossible, and a player cannot
  build a small ledge.

**We gain:**

- Integer grid coordinates as the wire format: 9 bytes per piece rather than a
  float transform. This is what makes the bandwidth budget work.
- Interlocking structures. Two players building into the same space produce a
  coherent structure, not an overlapping mess. Mid-fight, this is the difference
  between legible and chaotic.
- Trivially cheap occupancy queries and support checks — array lookups, not
  physics overlap tests.
- Predictable placement. A player knows exactly where a piece will land, which
  pillar 1 requires.
- Generators produce exactly-fitting pieces because the target dimension is a
  constant, not a per-asset decision.

## Alternatives considered

**Relative grid aligned to the player.** Rejected: structures from different
players do not interlock, the wire format needs full transforms, and placement
becomes unpredictable when the player turns.

**Smaller cells (2 m).** Rejected: roughly 8× the pieces for a given volume, and
the piece count drives every budget in the project — simulation, replication, and
draw calls alike.

**Larger cells (6 m).** Rejected: a 6 m wall is visually oversized next to a
1.8 m character, and the ramp angle stops being a clean 45°.

**Free placement with physics-based support.** Rejected outright: unpredictable
under pressure (pillar 1), expensive to replicate, and expensive to simulate at
the piece counts an end-game fight reaches.
