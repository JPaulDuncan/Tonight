# System: Loot

**Owner:** design + engineering · **Status:** specified, unimplemented · **Milestone:** M3

## 1. Sources

| Source | Table | Notes |
| --- | --- | --- |
| Floor spawn | `PoiBlueprint.FloorTable` | Visible on the ground, no interaction to spot |
| Chest | `PoiBlueprint.ChestTable` | Audible hum, ~20 m, through walls |
| Supply drop | Dedicated table | Epic/Legendary only; existence still an open question |
| Death pile | Victim's inventory | Not a roll — the actual items dropped |

## 2. Rolling

**All rolls happen on the server, once, at spawn time.** Never on a client, never
re-rolled, never influenced by who opens the container.

```
Roll(table, rng):
  n = rng.Range(table.RollCount.Min, table.RollCount.Max)
  repeat n times:
    entry = WeightedPick(table.Entries, rng)
    switch entry.Kind:
      Item    → emit entry.Item at rarity = RollRarity(table.RarityBias, rng)
                          count = rng.Range(entry.CountRange)
      Table   → recurse into entry.Table
      Nothing → emit nothing
  if !table.AllowDuplicates: de-duplicate by BlueprintId, re-rolling collisions
```

Recursion is bounded by a cycle check at validation time, so a table that
references itself fails CI rather than hanging the server.

### 2.1 Rarity

Rarity is rolled separately from item identity, using `RarityBlueprint.LootWeight`
shifted by the table's `rarityBias`:

| Rarity | Weight (floor) | Tier |
| --- | --- | --- |
| Common | 50 | 0 |
| Uncommon | 30 | 1 |
| Rare | 14 | 2 |
| Epic | 5 | 3 |
| Legendary | 1 | 4 |

`RarityBias = 1` (chests) shifts each rolled tier up one, clamped at Legendary.
`rarityOverrideId` on an entry forces a tier outright, which is how supply drops
guarantee a high roll.

Rarity multiplies damage only (GDD §5.3). A Common AR remains a viable weapon,
so the loot loop is a gradient rather than a gate.

Because rarity is orthogonal to the item, five weapon classes across five
rarities is **five** Blueprints, not twenty-five.

## 3. Spawning

At match start, for each POI:

```
for each chest spawn point:
    if rng < ChestSpawnChance: place a chest, roll ChestTable now
place rng.Range(FloorLootCount) floor items from FloorTable
```

Everything is rolled at match start so that opening a chest is a pure reveal, not
a server round-trip. The contents already exist and are simply revealed to the
opening client.

Spawn RNG is seeded from the match seed, so a match is reproducible for debugging
— a genuinely valuable property when chasing a report about a specific match.

## 4. Pickup

```
walk within 1.5 m → prompt
press interact    → server validates proximity and inventory space
                  → transfers, replicates
```

The server validates proximity. A client claiming to pick up an item 200 m away
is rejected, logged, and counted toward the telemetry that would justify a ban
review.

Ammo and consumables auto-pickup when they stack onto something already held.

## 5. Blueprint surface

| Blueprint | Governs |
| --- | --- |
| `LootTableBlueprint` | Entries, weights, roll count, rarity bias, duplicate policy |
| `LootEntry` | Item or nested table, weight, count range, rarity override |
| `RarityBlueprint` | Tier, colour, damage multiplier, loot weight |
| `PoiBlueprint` | Chest count and chance, floor loot count, both tables |

Rebalancing the entire loot economy is editing assets. Table nesting means a
change to the shared "Weapons" table propagates to every container that
references it.

## 6. Test plan

| Test | Level | Asserts |
| --- | --- | --- |
| **Distribution** | Unit | 10⁵ rolls per table land within χ² tolerance of the authored weights |
| Rarity bias | Unit | Chest tables measurably shift one tier up; clamped at Legendary |
| Nesting | Unit | Nested tables contribute proportionally to their entry weight |
| Cycle detection | Validation | A self-referencing table fails CI |
| No duplicates | Unit | `AllowDuplicates = false` never emits two of one id |
| Determinism | Unit | Same match seed ⇒ identical spawns across the whole map |
| Pickup authority | Integration (M4) | An out-of-range pickup is rejected |
| Zero-weight | Unit | A table whose weights sum to zero fails validation rather than dividing by zero |

The distribution test is statistical rather than example-based on purpose: a
weighted table that is subtly wrong still produces individually plausible rolls,
so only aggregate testing catches it.

## 7. Open questions

| Question | Owner | Decide by |
| --- | --- | --- |
| Do supply drops exist? Leaning yes, low count | design | M4 |
| Should death piles preserve rarity, or normalise down? | design | M3 |
