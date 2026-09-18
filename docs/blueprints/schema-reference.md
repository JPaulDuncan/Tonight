# Blueprint schema reference

Every Blueprint type, field by field. This document is the contract between
design and engineering; `web/src/blueprints/types.ts` declares it and
`validateLibrary()` in `web/src/blueprints/registry.ts` enforces it.

Conventions used below:

- **Units** are metres, seconds, and degrees unless stated.
- `→ X` means the field holds the **`id`** of a Blueprint of type `X`, not a
  nested object. References are by id everywhere; see rule 3 in
  [README.md](README.md).
- *Req* marks fields the TypeScript interface declares non-optional. JSON has no
  concept of a default, so a required field that is missing is a typecheck
  failure, not a silent zero — the schema is the default-free layer, and rule 6
  ("defaults must be playable") applies to whoever copies an entry, not to a
  constructor.
- *Example* values are the real ones from the shipped content set, so a copy is
  always a working starting point.
- Colours are `#rrggbb` strings, parsed by the client. Keeping them as strings
  is what lets the same JSON load in Node for tests and in the browser.

---

## Base: `BlueprintBase`

Every Blueprint carries these.

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | ✓ | `"weapon.shotgun"` | Stable identity, namespaced by type. **Never edit.** Rule 2. |
| `displayName` | string | ✓ | `"Pump Shotgun"` | Shown in UI |
| `description` | string | — | — | Designer notes; may surface in tooltips |
| `tags` | string[] | — | `["weapon"]` | Free-form, used by loot filters |

Ids must be unique across **all six** data files — the registry flattens them
into one id space.

### `ItemBlueprintBase extends BlueprintBase`

Shared by anything that can sit in an inventory slot.

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `icon` | string | — | — | Asset path, resolved by the loader |
| `maxStack` | int | ✓ | `1` weapons, `5` consumables | 1 means unstackable |

A `kind` discriminator (`"weapon"` \| `"consumable"`) narrows the union. It is
the one place a string literal is allowed to drive a branch, because it
distinguishes *types*, not *content*.

---

## Combat

### `WeaponBlueprint extends ItemBlueprintBase`

`web/data/combat.json` → `weapons`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `weaponClass` | enum | ✓ | `"shotgun"` | `assaultRifle`, `shotgun`, `smg`, `sniper`, `pistol`, `melee` |
| `damageProfileId` | → `DamageProfileBlueprint` | ✓ | `"damage.shotgun"` | Damage, falloff, multipliers |
| `recoilProfileId` | → `RecoilProfileBlueprint` | — | `"recoil.heavy"` | Omit for no recoil |
| `fireMode` | enum | ✓ | `"boltAction"` | `auto`, `semi`, `burst`, `boltAction` |
| `burstCount` | int | ✓ | `3` | Only read when `fireMode === "burst"` |
| `fireRateRpm` | float | ✓ | `70` | Rounds per minute. Must be > 0 |
| `magazineSize` | int | ✓ | `5` | Must be > 0 |
| `reloadSeconds` | float | ✓ | `3.4` | Must be > 0 |
| `equipSeconds` | float | ✓ | `0.5` | |
| `pelletCount` | int | ✓ | `10` | > 1 makes it a shotgun. No special-casing in code. |
| `spreadDegrees` | float | ✓ | `4.2` | Cone half-angle per shot |
| `bloomPerShot` | float | ✓ | `0` | Degrees added per shot while firing |
| `bloomMaxDegrees` | float | ✓ | `0` | Cap |
| `bloomRecoveryPerSecond` | float | ✓ | `4` | |
| `firstShotAccurate` | bool | ✓ | `true` | Zero spread when bloom is at rest |
| `isProjectile` | bool | ✓ | `false` | False = hitscan. Snipers use projectile. |
| `projectileSpeed` | float | ✓ | `250` | m/s, read when `isProjectile` |
| `projectileGravityScale` | float | ✓ | `0.4` | Bullet drop multiplier |
| `ammoType` | enum | ✓ | `"shell"` | `none`, `light`, `medium`, `heavy`, `shell` |
| `adsFovMultiplier` | float | ✓ | `0.85` | |
| `adsTimeSeconds` | float | ✓ | `0.2` | |

**Validation:** `fireRateRpm > 0`; `magazineSize > 0`; `reloadSeconds > 0`;
`pelletCount >= 1`; `burstCount >= 2` when `fireMode` is `burst`;
`projectileSpeed > 0` when `isProjectile`; both id references resolve.
Warns when `pelletCount > 1` with zero spread (every pellet on one line), and
when `spreadDegrees > 10`.

> Note there is no rarity field. Rarity is a runtime modifier applied over a
> single Blueprint — see the last anti-pattern in [README.md](README.md).

### `DamageProfileBlueprint`

`web/data/combat.json` → `damageProfiles`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `baseDamage` | float | ✓ | `30` | Per bullet or pellet, before multipliers |
| `headshotMultiplier` | float | ✓ | `2` | 2.5 for snipers |
| `structureMultiplier` | float | ✓ | `1` | Against build pieces. GDD §5.5 |
| `falloffStartMetres` | float | ✓ | `40` | Full damage up to here |
| `falloffEndMetres` | float | ✓ | `80` | `falloffEndDamageScale` at and beyond |
| `falloffEndDamageScale` | float | ✓ | `0.6` | |
| `shieldPenetration` | float | ✓ | `0` | 0 = shield absorbs first, 1 = ignores shield |

**Validation:** `baseDamage > 0`; `headshotMultiplier >= 1`;
`falloffEndMetres >= falloffStartMetres`; `falloffEndDamageScale` and
`shieldPenetration` within [0, 1]. Warns above `structureMultiplier` 3.

### `RecoilProfileBlueprint`

`web/data/combat.json` → `recoilProfiles`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `verticalKickDegrees` | float | ✓ | `0.35` | Per shot |
| `horizontalKickDegrees` | float | ✓ | `0.18` | Randomised ± |
| `pattern` | `[number, number][]` | ✓ | `[]` | Fixed pattern; when non-empty it overrides random kick |
| `recoveryPerSecond` | float | ✓ | `10` | Degrees returned per second |
| `recoveryDelaySeconds` | float | ✓ | `0.1` | Delay before recovery begins |

### `RarityBlueprint`

`web/data/combat.json` → `rarities`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `tier` | int | ✓ | `0` | 0 = Common … 4 = Legendary. Unique across the set. |
| `colour` | `#rrggbb` | ✓ | `"#9e9e9e"` | UI tint and world-drop glow |
| `damageMultiplier` | float | ✓ | `1` | GDD §5.3 |
| `lootWeight` | float | ✓ | `50` | Default weight in floor loot |

**Validation:** `damageMultiplier > 0`; `lootWeight >= 0`; `tier` unique. Warns
when tiers are not contiguous from 0, because a gap makes a loot table's
`rarityBias` skip a tier.

---

## Building

### `BuildPieceBlueprint`

`web/data/building.json` → `buildPieces`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `placement` | enum | ✓ | `"wall"` | `wall`, `floor`, `ramp`, `cone` |
| `occupancy` | enum | ✓ | `"face"` | `face` (wall/floor) or `interior` (ramp/cone) |
| `costOverride` | int | ✓ | `-1` | −1 means use the material's `costPerPiece` |
| `editVariants` | `EditVariant[]` | ✓ | see below | `[]` for pieces with no edits |

**Validation:** `occupancy` is `interior` exactly when `placement` is `ramp` or
`cone`, and `face` otherwise — the grid depends on this (ADR-0006), and getting
it wrong lets two pieces claim one slot.

There is no mesh or material field. The renderer selects geometry from
`placement` (`web/src/render/meshes.ts`) and colour from the build material's
`colour`, so adding a material does not touch every piece and adding a piece does
not touch every material. The Blender generators produce the shipping meshes for
the same four placements; wiring the client to load them is still open — see the
roadmap.

### `EditVariant` (nested, not a standalone Blueprint)

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `variantName` | string | ✓ | `"Doorway"` | "Doorway", "Window", "Trapdoor" |
| `gridMask` | bool[9] | ✓ | `[1,1,1, 1,0,1, 1,0,1]` | 3×3 mask over the piece face; false = removed |
| `healthScale` | float | ✓ | `0.85` | Variants with holes are weaker |

The 3×3 mask is why new edit shapes are content work: a doorway is
`[1,1,1, 1,0,1, 1,0,1]`, a window is `[1,1,1, 1,0,1, 1,1,1]`. Adding a shape
means a new mask and a new mesh, not new code. Row-major, top-left first — the
same order as `MASK_*` in `blender/lib/tonight/build_pieces.py`, so the mesh and
the Blueprint cannot drift.

**Validation:** exactly 9 entries; `healthScale > 0`; no two variants on one
piece share a mask, since only the first would ever be reachable.

### `BuildMaterialBlueprint`

`web/data/building.json` → `buildMaterials`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `materialKind` | enum | ✓ | `"wood"` | `wood`, `stone`, `metal`. Unique across the set. |
| `buildHealth` | float | ✓ | `90` | HP at the instant of placement |
| `fullHealth` | float | ✓ | `150` | HP after the ramp completes |
| `buildTimeSeconds` | float | ✓ | `3` | Ramp duration. GDD §4.3 |
| `costPerPiece` | int | ✓ | `10` | |
| `maxCarried` | int | ✓ | `500` | |
| `colour` | `#rrggbb` | ✓ | `"#b8823f"` | HUD tint and placeholder surface colour |

**Validation:** `fullHealth >= buildHealth` (or a piece weakens as it matures);
`buildTimeSeconds > 0`; `costPerPiece > 0`; `maxCarried >= costPerPiece`;
`materialKind` unique.

---

## Loot

### `LootTableBlueprint`

`web/data/loot.json` → `lootTables`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `entries` | `LootEntry[]` | ✓ | see below | Weighted |
| `rollCount` | `IntRange` | ✓ | `{min: 1, max: 1}` | Inclusive number of rolls |
| `allowDuplicates` | bool | ✓ | `true` | |
| `rarityBias` | int | ✓ | `0` | Shifts rolled rarity by N tiers; chests use 1 |

### `LootEntry` (nested)

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `kind` | enum | ✓ | `"table"` | `item`, `table`, `nothing` |
| `itemId` | → `WeaponBlueprint` \| `ConsumableBlueprint` | ✓ if `item` | `"weapon.smg"` | |
| `tableId` | → `LootTableBlueprint` | ✓ if `table` | `"loot.weapons"` | Nested table |
| `weight` | float | ✓ | `45` | Relative within the table |
| `countRange` | `IntRange` | ✓ | `{min: 1, max: 1}` | Stack size for stackables |
| `rarityOverrideId` | → `RarityBlueprint` | — | — | Forces a tier; supply drops use this |

Nesting is how a "Chest" table is composed from a "Weapon" table and a
"Consumable" table rather than restated as a flat list.

**Validation:** table is non-empty and its weights sum above zero; `rollCount`
and every `countRange` are not inverted; the id matching `kind` is present and
resolves; no entry references its own table; and a depth-first walk reports any
reference cycle among nested tables by its full path.

### `ConsumableBlueprint extends ItemBlueprintBase`

`web/data/loot.json` → `consumables`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `healthRestored` | float | ✓ | `15` | |
| `shieldRestored` | float | ✓ | `0` | |
| `healthCap` | float | ✓ | `75` | Bandages cap below max; GDD §5.1 |
| `useSeconds` | float | ✓ | `3` | |
| `consumedOnUse` | bool | ✓ | `true` | |
| `cancelOnDamage` | bool | ✓ | `true` | |

---

## Match

### `MatchRulesBlueprint`

`web/data/match.json` → `matchRules`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `squadSize` | int | ✓ | `1` | 1 solo, 2 duos, 3 trios |
| `maxPlayers` | int | ✓ | `30` | Rescoped from 100; see ADR-0007 |
| `allowDbno` | bool | ✓ | `false` | True for squad modes. GDD §1.3 |
| `dbnoHealth` | float | ✓ | `100` | |
| `dbnoBleedPerSecond` | float | ✓ | `2` | |
| `reviveSeconds` | float | ✓ | `8` | |
| `stormPhaseIds` | → `StormPhaseBlueprint`[] | ✓ | seven ids | Ordered |
| `lightingId` | → `MatchLightingBlueprint` | ✓ | `"lighting.nightfall"` | |
| `busSeconds` | float | ✓ | `30` | |
| `gliderDeployAltitude` | float | ✓ | `35` | Metres above ground |
| `startingLoadoutIds` | → item[] | ✓ | `["weapon.pickaxe"]` | |
| `friendlyFire` | bool | ✓ | `false` | |

**Validation:** `squadSize >= 1`; `maxPlayers >= squadSize`;
`maxPlayers % squadSize === 0` (or the last squad is short); at least one storm
phase; every id resolves; the referenced lighting has a keyframe for every
referenced phase. Warns when the phases total outside 6–22 minutes, and when
DBNO is enabled on a solo mode.

### `StormPhaseBlueprint`

`web/data/match.json` → `stormPhases`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `phaseIndex` | int | ✓ | `0` | Ordering; unique |
| `waitSeconds` | float | ✓ | `120` | Time before closing begins |
| `closeSeconds` | float | ✓ | `90` | Duration of the shrink |
| `startRadius` | float | ✓ | `800` | |
| `endRadius` | float | ✓ | `520` | |
| `damagePerSecond` | float | ✓ | `1` | |
| `centreBiasToPlayers` | float | ✓ | `0.15` | 0 = purely random inside previous circle, 1 = player centroid |
| `maxRotationDistance` | float | ✓ | `-1` | −1 auto-computes from sprint speed × `closeSeconds` × 1.1 |

**Validation:** `endRadius <= startRadius`; `startRadius > 0`;
`closeSeconds > 0`; `phaseIndex` unique; and each phase's `startRadius` equals
the previous phase's `endRadius` within 0.01 m — a gap there is a silently
teleporting circle, which is the kind of thing no single asset can catch about
itself.

### `MatchLightingBlueprint`

`web/data/match.json` → `lighting`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `keyframesByPhase` | `LightingKeyframe[]` | ✓ | seven entries | One per storm phase |
| `minPlayerRimIntensity` | float | ✓ | `0.4` | Floor that keeps players visible. Pillar 2 |

**Validation:** at least one keyframe, one per referenced phase, and
`minPlayerRimIntensity > 0` — a zero here is what would make deep night a
stealth mechanic, which the GDD forbids.

---

## Character

### `MovementBlueprint`

`web/data/character.json` → `movement`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `walkSpeed` | float | ✓ | `4.6` | GDD §3 |
| `sprintSpeed` | float | ✓ | `7.4` | |
| `crouchSpeed` | float | ✓ | `2.3` | |
| `acceleration` | float | ✓ | `60` | m/s² |
| `deceleration` | float | ✓ | `45` | m/s² |
| `airControl` | float | ✓ | `0.35` | 0..1 |
| `jumpHeight` | float | ✓ | `1.1` | Metres apex. See the note below. |
| `gravity` | float | ✓ | `-22` | m/s²; negative |
| `terminalVelocity` | float | ✓ | `55` | |
| `fallDamageThreshold` | float | ✓ | `3.5` | Metres of drop before damage |
| `fallDamagePerMetre` | float | ✓ | `10` | |
| `mantleMaxHeight` | float | ✓ | `1.6` | |
| `mantleSeconds` | float | ✓ | `0.4` | |
| `standHeight` | float | ✓ | `1.8` | Capsule height |
| `crouchHeight` | float | ✓ | `0.9` | |

**Validation:** `sprintSpeed >= walkSpeed >= crouchSpeed`; `gravity < 0`;
`jumpHeight > 0`; `terminalVelocity > 0`; `crouchHeight < standHeight`. Warns
when `mantleMaxHeight >= 4`, since that is the cell size and players could mantle
their way up a wall.

> `jumpHeight` is the **authored apex**, and the motor hits it. A discrete
> integrator launched at the textbook `sqrt(2gh)` undershoots — 0.99 m instead of
> 1.10 m at 30 Hz — so `jumpVelocityForTick()` solves for the tick length
> instead. Change the tick rate and the apex stays at 1.1 m.

### `CharacterBlueprint`

`web/data/character.json` → `characters`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `movementId` | → `MovementBlueprint` | ✓ | `"movement.default"` | |
| `maxHealth` | float | ✓ | `100` | |
| `maxShield` | float | ✓ | `100` | |
| `cameraHeight` | float | ✓ | `1.65` | Eye height when standing |
| `hitboxes` | `HitboxDefinition[]` | ✓ | seven entries | Head/body/limb, with damage scales |

**Validation:** `maxHealth > 0`; exactly one hitbox flagged `isHead`;
`cameraHeight < movement.standHeight` — checked against the *referenced*
movement Blueprint, not a constant.

---

## World

### `HarvestableBlueprint`

`web/data/world.json` → `harvestables`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `materialId` | → `BuildMaterialBlueprint` | ✓ | `"material.wood"` | What it yields |
| `totalHealth` | float | ✓ | `300` | |
| `yieldPerHit` | int | ✓ | `12` | |
| `bonusYieldOnWeakPoint` | int | ✓ | `12` | Extra for hitting the marker |
| `yieldOnDestroy` | int | ✓ | `30` | |
| `respawnSeconds` | float | ✓ | `-1` | −1 = never (the match-long default) |

**Validation:** `totalHealth > 0`; not both yields zero (a harvestable that
yields nothing is scenery); `materialId` resolves.

### `PoiBlueprint`

`web/data/world.json` → `pois`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `tier` | enum | ✓ | `"minor"` | `major`, `minor`, `landmark` |
| `chestSpawnPoints` | int | ✓ | `6` | |
| `chestSpawnChance` | float | ✓ | `1` | Per point, per match; within [0, 1] |
| `floorLootCount` | `IntRange` | ✓ | `{min: 6, max: 10}` | |
| `chestTableId` | → `LootTableBlueprint` | ✓ | `"loot.chest"` | |
| `floorTableId` | → `LootTableBlueprint` | ✓ | `"loot.floor"` | |

POIs carry no scene reference: their geometry comes from the Blender map layout
(`blender/lib/tonight/map_layout.py`), placed by the same ids.

### `MapBlueprint`

`web/data/world.json` → `maps`

| Field | Type | Req | Example | Notes |
| --- | --- | --- | --- | --- |
| `poiIds` | → `PoiBlueprint`[] | ✓ | fourteen ids | |
| `sizeMetres` | float | ✓ | `800` | Rescoped from 1400; see ADR-0007 |
| `maxPoiSeparation` | float | ✓ | `260` | Checked by the map validator. GDD §8 |
| `maxBuildableSlope` | float | ✓ | `40` | Degrees |
| `minOpenTerrainFraction` | float | ✓ | `0.3` | |
| `busPathSeed` | int | ✓ | `0` | 0 = random per match |

**Validation:** non-empty `poiIds`, all resolving; `sizeMetres > 0`; warns below
three `major` POIs, which would give the bus too few interesting drops.

The last three fields are asserted against the generated terrain by the map
constraints job in CI, not judged by eye — see GDD §8 and the M5 exit criteria.

---

## Shared value types

| Type | Definition |
| --- | --- |
| `IntRange` | `{ "min": int, "max": int }`, inclusive. `min <= max`. |
| `HitboxDefinition` | `{ "name": string, "isHead": bool, "damageScale": float }` |
| `LightingKeyframe` | `{ "phaseIndex": int, "sunColour": "#rrggbb", "sunIntensity": float, "fogColour": "#rrggbb", "fogDensity": float, "sunElevationDegrees": float }` |

`sunElevationDegrees` is per-keyframe and interpolated between them, rather than
a curve asset: a curve cannot be diffed in review, and the night clock only ever
needs one value per phase.

## Adding a new Blueprint type

A new *type* is a code change — that is expected (see "When the contract does
not apply" in [README.md](README.md)). The checklist:

1. Add the interface in `web/src/blueprints/types.ts`, extending
   `BlueprintBase` (or `ItemBlueprintBase` if it goes in an inventory slot).
2. Add its array to `BlueprintLibrary` in the same file.
3. Create or extend the matching `web/data/*.json` file, and wire the array into
   `library.ts`.
4. Add an accessor to `BlueprintRegistry` so call sites get the narrow type.
5. Add its checks to `validateLibrary()`, including any cross-asset rule — that
   is the part a per-field check cannot do and the part most worth writing.
6. Add it to this document, in the matching category.
7. Add a case to `web/tests/blueprints.test.ts` proving the new validation
   rejects what it should, not only that the shipped content passes.
