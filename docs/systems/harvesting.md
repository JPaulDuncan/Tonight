# System: Harvesting

**Owner:** design + engineering · **Status:** specified, unimplemented · **Milestone:** M1

## 1. Design intent

Harvesting is the pump that feeds building. It must be fast enough not to be a
chore and slow enough that materials are a real resource under pressure.

The target from GDD §2.1: **one wall's worth of wood (30 materials) in 4.5 s.**
Everything below is tuned to hit that.

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

Pickaxe swing rate: **1.4 swings/s**. A tree at 12 + 12 bonus per hit yields
roughly 34 materials/s with consistent weak-point hits, or ~17/s without — so the
4.5 s wall target is achievable with good hits and misses cost real time.

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

`HarvestableBlueprint` — material, HP, yields, prefab, VFX, respawn. Adding a new
harvestable prop is an asset plus a mesh.

`RespawnSeconds` defaults to −1 (never). It exists for the practice range, where
infinite materials are wanted.

## 7. Test plan

| Test | Level | Asserts |
| --- | --- | --- |
| Yield totals | EditMode | Fully harvesting each type yields the documented total |
| Weak-point determinism | EditMode | Same `(objectId, hitCount)` ⇒ same marker position |
| Cap | EditMode | Yield stops at `MaxCarried`; damage still applies |
| Wall-time target | PlayMode | 30 wood in ≤ 4.5 s with consistent weak-point hits |
| Prediction correction | PlayMode (M4) | A rejected harvest corrects the count without desyncing the object |
