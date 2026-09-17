# ADR-0002: Netcode for GameObjects with a custom build-graph channel

**Status:** Accepted · **Date:** 2026-09-17 · **Deciders:** engineering

## Context

Tonight needs 100 players on a dedicated server at 30 Hz, server-authoritative,
with client prediction for movement and building, and lag-compensated hit
registration.

The building system is the unusual constraint. A late-game fight can produce
thousands of build pieces. Treating each as a networked GameObject with a
replicated transform is roughly the worst possible fit: build pieces never move,
their position is fully described by an integer grid cell, and their count is
enormous. Naively replicating 3000 pieces as NetworkObjects costs far more
bandwidth and CPU than the information content justifies.

Options for the transport/replication layer:

| Option | Assessment |
| --- | --- |
| Netcode for GameObjects (NGO) | First-party, server-authoritative by default, maintained, integrates with Unity Transport. Weak at very high object counts. |
| Mirror | Mature, large community, good docs. Third-party; similar object-count characteristics. |
| Photon Fusion | Excellent prediction, proven at scale. Commercial licensing, less control over the wire format. |
| Fully custom | Maximum control, enormous cost, reinvents solved problems. |

## Decision

**Netcode for GameObjects over Unity Transport**, with a **custom replication
channel for build structures**.

- Players, projectiles, loot, and the storm replicate as ordinary NGO
  NetworkObjects with server authority.
- Build structures do **not**. They replicate through a dedicated channel whose
  wire format is `(cellX, cellY, cellZ, face, pieceId, materialId, hpBucket)` —
  9 bytes per piece, sent as deltas against a per-client acked structure version.
  Clients instantiate plain (non-networked) GameObjects from those records.
- Interest management is grid-cell based for both channels.
- Movement uses NGO's client prediction with server reconciliation.
- Hit registration is server-side with a rewind buffer capped at 250 ms.

## Consequences

**We accept:**

- Two replication paths to reason about and debug, instead of one. Build pieces
  are not NetworkObjects, so NGO's tooling does not see them; we need our own
  inspector and logging for the structure graph.
- The structure channel is ours to get right — ordering, reliability, and
  partial-state-on-join are all our problem.
- A joining or reconnecting client needs a full structure snapshot, which must be
  chunked so it does not stall the connection.
- NGO's high-object-count weakness is avoided, not fixed; if some other system
  later needs thousands of networked objects, we face this again.

**We gain:**

- A build channel roughly two orders of magnitude cheaper than the naive
  approach, which is what makes the 128 kbit/s budget reachable.
- First-party support and no licence cost for everything else.
- `hpBucket` quantising HP to 16 levels removes a constant stream of updates from
  ordinary structure chip damage.

## Alternatives considered

**Everything as NetworkObjects.** Rejected on bandwidth and CPU. This was
measured on paper before deciding: 3000 pieces × even a minimal per-object
update, at 20 Hz, blows the entire per-client budget on its own.

**Photon Fusion.** Genuinely good prediction, and the closest call. Rejected for
control: the build channel requires a custom wire format, and owning the whole
stack makes that straightforward.

**Deterministic lockstep.** Rejected — it does not survive 100 players with
variable latency, and a single desync ends a match.
