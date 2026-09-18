# System: Harvesting

**Owner:** design + engineering · **Status:** specified, unimplemented · **Milestone:** M1

## 1. Design intent

Harvesting is the pump that feeds building. It must be fast enough not to be a
chore and slow enough that materials are a real resource under pressure.

The anchor is **a full tree in about seven seconds**, yielding 150–270 wood —
15 to 27 build pieces. That makes a tree a meaningful commitment of time
mid-fight while keeping materials from feeling scarce in the early game.

Everything in GDD §2.1's loop-timing table is derived from the rates below
rather than set independently, and the `harvesting` suite in
`web/tests/systems.test.ts` re-derives them so
the numbers and the prose cannot drift apart. An earlier draft asserted a
"30 material wall in 4.5 s", which contradicted both the 10-material piece cost
in GDD §4.3 and these rates by a factor of five.

## 2. Mechanic

```
swing pickaxe → hit a HarvestableBlueprint object
              → deal damage, yield YieldPerHit materials
              → a weak-point marker appears at a random point on the object
              → hitting the marker yields BonusYieldOnWeakPoint extra
              → object destroyed → YieldOnDestroy bonus
```

The weak point is the skill expression, and it is why harvesting is an activity
rather than a hold-to-fill bar. Its position is seeded from
`(objectId, hitCount)` so client and server agree without extra replication.

## 3. Rates

| Harvestable | Material | Total HP | Yield/hit | Weak point | On destroy |
| --- | --- | --- | --- | --- | --- |
| Tree | Wood | 300 | 12 | +12 | +30 |
| Wooden prop | Wood | 150 | 10 | +10 | +20 |
| Rock | Stone | 400 | 10 | +10 | +25 |
| Masonry | Stone | 300 | 10 | +10 | +20 |
| Vehicle | Metal | 500 | 8 | +8 | +20 |
| Machinery | Metal | 400 | 8 | +8 | +15 |

Pickaxe swing rate: **1.4 swings/s**, pickaxe damage **30**.

A tree therefore takes 10 swings (7.1 s) and yields 150 wood with no weak-point
hits or 270 with all of them. At 10 materials per build piece that is 15 to 27
pieces from one tree, and hitting every weak point is worth 80% more material
for the same time spent — which is the whole reason the weak point exists.

Metal is deliberately the slowest per second and the strongest to build with.

## 4. Caps

`BuildMaterialBlueprint.MaxCarried`, default 500 each. At cap, further harvest
yields nothing and the HUD flashes the material. Harvesting still damages the
object — a player clearing a tree for sightlines at cap is doing something
intentional.

## 5. Networking

Server-authoritative. The client predicts the swing animation and the material
increment for responsiveness; the server confirms. A rejected harvest corrects
the count, which is visible but rare and acceptable — unlike a build rejection,
a wrong material count does not move the world.

Harvestable HP replicates quantised, as with structures.

## 6. Blueprint surface

`HarvestableBlueprint` — material, HP, yields, respawn. Adding a new harvestable
prop is a JSON entry plus a mesh.

`respawnSeconds` is −1 (never) for everything in the shipped set. It exists for
the practice range, where infinite materials are wanted.

## 7. Test plan

| Test | Level | Asserts |
| --- | --- | --- |
| Yield totals | Unit | Fully harvesting each type yields the documented total |
| Weak-point determinism | Unit | Same `(objectId, hitCount)` ⇒ same marker position |
| Cap | Unit | Yield stops at `maxCarried`; damage still applies |
| Wall-time target | Browser | 30 wood in ≤ 4.5 s with consistent weak-point hits |
| Prediction correction | Integration (M4) | A rejected harvest corrects the count without desyncing the object |
