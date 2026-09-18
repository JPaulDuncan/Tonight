# System: Building

**Owner:** engineering · **Status:** specified, unimplemented · **Milestone:** M2

Building is the pillar (see [vision](../00-vision.md) pillar 1). Every decision
below is downstream of one requirement: *a piece must appear the instant the
player asks for it, and land exactly where they expected.*

## 1. The grid

Absolute, world-origin-aligned, 4 m cubic cells — [ADR-0006](../adr/0006-build-grid-quantisation.md).

```
world_position = cell * 4.0            cell = floor(world_position / 4.0)
```

A piece is identified by `(cell, slot)` where slot is:

| Slot | Meaning | Used by |
| --- | --- | --- |
| `NorthFace`, `EastFace`, `SouthFace`, `WestFace` | Vertical face of the cell | Wall |
| `FloorFace` | Horizontal face at the cell's base | Floor |
| `Interior` | The cell volume | Ramp, Cone |

Each `(cell, slot)` holds at most one piece. A cell can therefore hold four
walls, a floor, and one interior piece simultaneously — which is exactly a 1×1
box with a ramp inside it.

The ramp/cone sharing one `Interior` slot is deliberate: a cell cannot contain
both, so placing a ramp over a cone replaces it rather than stacking.

### 1.1 Canonical slots

Two adjacent cells share a face. A wall on the **north** face of cell C is the
same physical wall as one on the **south** face of C's north neighbour, so the
two namings must resolve to one key — otherwise two players building on
opposite sides of the same boundary would each succeed and produce coincident,
double-health geometry.

Every `(cell, slot)` is therefore canonicalised before use:

| Named as | Stored as |
| --- | --- |
| `SouthFace` of cell C | `NorthFace` of C + (0, 0, −1) |
| `WestFace` of cell C | `EastFace` of C + (−1, 0, 0) |
| `FloorFace`, `NorthFace`, `EastFace`, `Interior` | unchanged |

`BuildGrid.Canonicalise` owns this, and every structure lookup goes through it.
Occupancy queries answer correctly from either side as a result: asking whether
the south face of the northern cell is free returns true once the wall exists,
whichever way it was placed.

## 2. Placement

### 2.1 Target resolution

The target cell is resolved from the camera, **not** from the crosshair hitting
geometry. Raycasting to find a surface fails in open air, and building in open
air is normal.

```
1. Ray from camera along view direction.
2. Advance to min(hit distance, maxPlaceDistance = 10 m).
3. Quantise that point to a cell.
4. Choose the slot from the piece's Placement and the player's facing:
   - Wall  → the cell face most opposed to the view direction
   - Floor → FloorFace of the cell at the player's feet height
   - Ramp/Cone → Interior
5. If the chosen (cell, slot) is occupied, walk one cell along the view
   direction and retry, up to 2 steps.
```

Step 5 is what makes building against an existing wall feel right rather than
silently failing.

### 2.2 Validation

`PlaceBuildCommand.Validate(state)` is a pure function, shared verbatim between
client prediction and server authority ([ADR-0003](../adr/0003-defer-networking-to-m4.md) rule 4).

| Check | Rule |
| --- | --- |
| Affordable | `player.materials[mat] >= piece.Cost` |
| Free | `(cell, slot)` is unoccupied |
| Supported | see §3 |
| In range | distance ≤ 10 m from the player |
| Not intersecting a player | the piece's volume contains no living character |
| Rate limit | ≤ 12 placements/second per player (server only) |

The player-intersection check exists to stop trapping opponents inside geometry.
The placing player *is* excluded — building a floor under yourself is legal and
common.

The rate limit is server-only and deliberately above any achievable human input
rate. It is a sanity check against automation, not a gameplay throttle — a real
throttle here would violate the "editing must not be rate-limited" rule in §5.

### 2.3 Prediction

```
input → validate locally → spawn predicted piece THIS FRAME → send command
```

The predicted piece is an ordinary mesh at build-HP, flagged as predicted. On
server confirmation the flag is cleared and the piece is **adopted** — not
removed and re-added — so there is no visual pop. On rejection it is removed and
materials refunded.

Adoption rather than re-add is the detail that makes prediction invisible, and it
is the most likely place for a bug to hide. It gets dedicated browser tests at
M4.

## 3. Structural integrity

A piece is **supported** when a path of connected pieces reaches terrain.

```
supported(piece) :=
      piece.cell intersects terrain
   OR any neighbouring piece in a connected slot is supported
```

Support is not recomputed per frame. Each piece caches a `supportDistance` (hops
to ground). On destruction:

1. Neighbours of the destroyed piece are marked dirty.
2. A flood-fill recomputes `supportDistance` for the dirty set.
3. Pieces that end with no path to ground are queued for destruction after
   **0.4 s**.

The 0.4 s delay is both a design choice — the player sees the tower fall, it
reads as a consequence — and a performance one: it lets the cascade be spread
across ticks inside the server's build budget (1 ms/frame client, budgeted per
tick server). A large tower's collapse is *allowed* to take several ticks.

**Known risk:** the cascade is O(structure size) in the worst case, and an
end-game mega-build could spike a tick. Mitigation is the spread-across-ticks
budget; it is listed as a high-severity risk in the
[architecture doc](../02-technical-architecture.md) §11 and is re-measured at M4.

## 4. Health and the build ramp

```
hp(t) = lerp(material.BuildHealth, material.FullHealth,
             clamp01(t / material.BuildTimeSeconds))
```

This is the game's most important balance lever (GDD §4.3). A wood wall is 90 HP
on placement and 150 HP three seconds later, so an SMG burst kills a fresh wall
and fails against a matured one. The whole build-fight rhythm comes out of this
one curve.

The pickaxe **ignores** the ramp and always does its full damage, so a player can
reliably remove their own or an enemy's fresh build.

HP is replicated quantised to 16 buckets ([ADR-0002](../adr/0002-netcode-stack.md)),
so ordinary chip damage does not generate a network update per hit.

## 5. Editing

A player may edit a piece they own. Edit variants come from
`BuildPieceBlueprint.editVariants`, each a 3×3 `gridMask` plus a mesh
([schema reference](../blueprints/schema-reference.md)).

```
hold edit → 3×3 overlay appears on the piece face
drag across cells → toggles mask entries
release → the matching EditVariant is applied; no match → revert
```

Rules:

- Editing is **never rate-limited**. Editing a piece under fire is core skill
  expression (GDD §4.5).
- An edited piece keeps its current HP, scaled by `EditVariant.HealthScale`.
- Only the owner may edit. Ownership transfers on nothing — a captured structure
  stays enemy-owned and must be destroyed, not edited.
- Reset-to-default is a single input, because fumbling an edit mid-fight and
  needing to undo it instantly is common.

Adding a new edit shape is a new mask plus a new mesh. **No code change** — this is
one of the M2 exit criteria.

## 6. Blueprint surface

| Blueprint | Governs |
| --- | --- |
| `BuildPieceBlueprint` | Placement kind, slot occupancy, meshes per material, edit variants, attachment faces |
| `BuildMaterialBlueprint` | Build/full HP, ramp time, cost, carry cap, surface material, audio |

Adding a half-wall, a new material, or a new edit shape is asset work.

## 7. Networking

Build pieces do **not** replicate as ordinary entities. The wire record is:

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
packing is specified but not implemented, and the test that pins the size lands
with the channel in M4.

Deltas are sent against a per-client acked structure version. Joining and
reconnecting clients receive a chunked full snapshot. See
[netcode.md](netcode.md).

## 8. Test plan

| Test | Level | Asserts |
| --- | --- | --- |
| Grid quantisation round-trip | Unit | `cell(world(cell)) == cell` across the full map range, including negatives |
| Slot occupancy | Unit | One piece per `(cell, slot)`; ramp replaces cone |
| Cost and refund | Unit | Rejection refunds exactly the amount deducted |
| Support flood-fill | Unit | Removing a base collapses everything above, nothing beside |
| Cascade budget | Browser | A 500-piece tower collapse stays within the per-tick budget |
| HP ramp | Unit | `hp(0) == BuildHealth`, `hp(BuildTime) == FullHealth`, monotonic between |
| Edit mask matching | Unit | Each authored mask resolves to its variant; unknown masks revert |
| Box build time | Browser | Scripted 1×1 box completes in < 0.7 s of input |
| Prediction adoption | Integration (M4) | Confirmed piece is adopted, never respawned; no transform discontinuity |
| Rejection rollback | Integration (M4) | Rejected piece disappears and materials return |
| **No-code content test** | Manual, M2 gate | A new piece type added via one Blueprint + one mesh, zero `.ts` diff |

## 9. Open questions

| Question | Owner | Decide by |
| --- | --- | --- |
| Turbo building (hold-to-place) on or off? | design | M3 |
| Does placing a piece damage a player it intersects, or is placement simply blocked? | design | M2 |
| Should support propagate through enemy-owned pieces? | design | M2 |
