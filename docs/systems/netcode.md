# System: Netcode

**Owner:** engineering · **Status:** specified, unimplemented · **Milestone:** M4

The highest-risk system in the project. See
[ADR-0002](../adr/0002-netcode-stack.md) and
[ADR-0003](../adr/0003-defer-networking-to-m4.md).

ADR-0002's *shape* — dedicated server, server authority, 30 Hz tick, prediction
on movement and building, a bespoke structure channel — survives the move to
three.js unchanged. Its named libraries do not: Unity Transport and Netcode for
GameObjects are replaced by a browser transport and a hand-written snapshot
channel, per [ADR-0007](../adr/0007-threejs-instead-of-unity.md). The table below is the
current stack; ADR-0002 records the superseded one.

## 1. Model

| Aspect | Decision |
| --- | --- |
| Topology | Dedicated server, headless Linux |
| Authority | Server owns all simulation |
| Simulation tick | 30 Hz fixed |
| Snapshot send | 20 Hz |
| Transport | WebSocket, with WebRTC data channels if latency demands it |
| Replication | Custom snapshot + delta, plus a custom structure channel |
| Prediction | Movement, build placement |
| Lag compensation | Server rewind, 250 ms cap |

## 2. Authority

The server accepts **no** gameplay assertion from a client. Clients send *intent*;
the server decides outcome.

| Client sends | Server decides |
| --- | --- |
| "I pressed forward at tick 1042" | Where the player actually is |
| "I fired at tick 1042 toward D" | Whether anything was hit and for how much |
| "Place a wall at cell (12,3,−7)" | Whether that is legal, affordable, supported |
| "Open this chest" | What is inside |

A loot roll happens once, on the server, at spawn. A client never rolls anything
that matters.

## 3. Prediction and reconciliation

### 3.1 Movement

```
CLIENT
  tick n: sample input → MoveCommand(n) → apply locally → store (n, state, cmd)
                                        → send to server
SERVER
  receive MoveCommand(n) → validate (speed, dt bounds, no teleport)
                         → apply → broadcast authoritative state with ack n
CLIENT
  receive (state, ack=n):
    if predicted[n] == state within epsilon → discard history up to n, done
    else → snap to state, replay every stored command n+1..current
```

Replay must be exact, which is why simulation never reads `Time.deltaTime` and
never reads input ([ADR-0003](../adr/0003-defer-networking-to-m4.md) rules 2–3).
A single non-deterministic term makes reconciliation jitter permanently.

Epsilon is 0.01 m positional / 0.5° angular. Below that, a correction would be
visible jitter rather than a fix.

### 3.2 Build placement

Covered in [building.md](building.md) §2.3. The critical property is **adoption**:
a confirmed predicted piece is taken over by the authoritative record rather than
destroyed and respawned, so the player never sees a flicker.

Rejection is rare (it needs a race with another player, or a desync) and must
still be correct: the predicted piece is destroyed and materials are refunded
exactly.

## 4. Replication channels

### 4.1 Standard replicated entities

Players, projectiles, loot piles, chests, the storm. Server-authoritative, sent
as snapshot deltas with interest management.

### 4.2 The structure channel

Build pieces would be catastrophic as ordinary entities — thousands of them, never
moving, fully described by an integer cell.

```
byte 0-1  cellX       int16
byte 2-3  cellY       int16
byte 4-5  cellZ       int16
byte 6    slot 3 bits | hpBucket 4 bits   (1 bit spare)
byte 7    pieceId     uint8
byte 8    materialId  uint8
                                          = 9 bytes
```

Slot has six values and health is quantised to sixteen levels, so the two share
one byte. Listing them as separate `uint8` fields would come to **ten** bytes,
and the bandwidth budget in §6 assumes nine. Nothing asserts this yet: the
packing is specified here but not implemented, and the test that pins the size
lands with the channel in M4.

- The server keeps a monotonically increasing `structureVersion`.
- Each client acks the version it has.
- The server sends the delta between acked and current, filtered by interest.
- Clients instantiate plain, non-replicated meshes from records.
- HP is quantised to 16 buckets, so chip damage does not generate traffic.
- Joining or reconnecting clients get a chunked full snapshot, rate-limited so
  it never stalls the connection.

Because this channel is bespoke, no off-the-shelf tooling can see into it. A
debug overlay and structure-channel logging are part of the M4 deliverable, not
an afterthought — debugging this channel without them would be miserable.

## 5. Interest management

Grid-cell based, reusing the build grid at a coarser stride (32 m cells).

| Entity | Sent when |
| --- | --- |
| Player | Within 200 m, or same squad (always) |
| Structure record | Within 150 m |
| Loot | Within 100 m |
| Projectile | Within 200 m of either endpoint |
| Storm | Always (it is a handful of floats) |

Interest is recomputed at 5 Hz, not per tick. A player crossing a boundary
receives the entering set as a small catch-up burst.

**This is prototyped at the start of M4, not the end.** It is the least certain
part of the bandwidth budget and the cheapest thing to measure early.

## 6. Bandwidth budget

Per client, steady state, heavy end-game fight:

| Stream | Budget |
| --- | --- |
| Player states (≈20 in interest × 20 Hz) | ~48 kbit/s |
| Structure deltas (60 placements/s peak) | ~12 kbit/s |
| Projectiles, loot, events | ~20 kbit/s |
| Overhead, reliability, headroom | ~48 kbit/s |
| **Total** | **≤ 128 kbit/s down** |

Upstream per client is far smaller: input commands at 30 Hz, a few hundred bits
per tick.

## 7. Server performance budget

Per tick at 100 players, 33 ms wall clock available:

| Stage | Budget |
| --- | --- |
| Command intake and validation | 3 ms |
| Movement simulation | 5 ms |
| Combat, hit rewind | 4 ms |
| Build placement + integrity cascade | 4 ms |
| Interest + snapshot assembly | 4 ms |
| **Used** | **≤ 20 ms** |

13 ms of headroom, deliberately, because the integrity cascade is the one stage
with a genuinely unbounded worst case.

## 8. Anti-cheat posture

Server authority plus sanity checks. No kernel driver, no third-party product —
an explicit non-goal in [the vision](../00-vision.md).

| Check | Threshold |
| --- | --- |
| Movement speed | > `SprintSpeed * 1.1` sustained over 1 s |
| Teleport | > 20 m in one tick |
| Fire rate | > `FireRateRpm * 1.1` |
| Build rate | > 12 placements/s |
| Command timestamp | Outside ±500 ms of server time |
| Aim snap | Flagged for telemetry only, never auto-enforced |

The first five reject the command. Aim analysis is telemetry-only because false
positives there would punish good players, and a wrong ban is worse than a missed
cheater.

## 9. Test plan

| Test | Level | Asserts |
| --- | --- | --- |
| Reconciliation determinism | Browser | Replaying identical commands reproduces state bit-exactly |
| Packet loss | Integration | 5% loss produces no visible correction; 20% recovers within 500 ms |
| Latency sweep | Integration | 20/60/120/250 ms all playable; hits register correctly at each |
| Rewind bound | Integration | A 400 ms-late shot compensates exactly 250 ms |
| Structure delta | Integration | A client that acks version N receives exactly the pieces changed after N |
| Reconnect | Integration | Full structure snapshot rebuilds the world identically |
| **Load test** | Integration, M4 gate | 100 simulated clients, 60+ builds/s, 30 Hz tick held, measured |
| Bandwidth | Integration, M4 gate | ≤ 128 kbit/s down in a scripted end-game fight |

The two gate tests are the M4 exit criteria. They are measured, not estimated.

## 10. Open questions

| Question | Owner | Decide by |
| --- | --- | --- |
| Snapshot interpolation delay: fixed 100 ms or adaptive? | engineering | M4 |
| Does the structure channel need its own reliability layer, or is the transport's enough? | engineering | M4 |
| Server tick 30 Hz — is 20 Hz enough, buying headroom for the cascade? | engineering | M4 |
