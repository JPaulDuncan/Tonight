# Blueprint schema reference

Every Blueprint type, field by field. This document is the contract between
design and engineering; the C# in
`unity/Tonight/Assets/Tonight/Scripts/Blueprints/` implements it.

Conventions used below:

- **Units** are metres, seconds, and degrees unless stated.
- `→ X` means the field is a reference to Blueprint type `X`.
- *Required* fields fail validation when unset. *Optional* fields have a safe
  default (rule 6 in [README.md](README.md): defaults must be playable).

---

## Base: `TonightBlueprint`

Every Blueprint inherits these.

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `BlueprintId` | string (GUID) | ✓ | auto-generated | Stable identity. **Never edit.** Rule 2. |
| `DisplayName` | string | ✓ | asset name | Shown in UI |
| `Description` | string | — | "" | Designer notes; may surface in tooltips |
| `Tags` | string[] | — | [] | Free-form, used by loot table filters |

---

## Combat

### `WeaponBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `Class` | enum | ✓ | `AssaultRifle` | `AssaultRifle`, `Shotgun`, `Smg`, `Sniper`, `Pistol`, `Melee` |
| `Prefab` | GameObject | ✓ | — | Held-weapon prefab, `PF_` prefixed |
| `DamageProfile` | → `DamageProfileBlueprint` | ✓ | — | Damage, falloff, multipliers |
| `Recoil` | → `RecoilProfileBlueprint` | — | shared default | Omit to inherit the class default |
| `Audio` | → `WeaponAudioBlueprint` | — | — | Fire, reload, equip |
| `FireMode` | enum | ✓ | `Auto` | `Auto`, `Semi`, `Burst`, `BoltAction` |
| `BurstCount` | int | — | 3 | Only read when `FireMode == Burst` |
| `FireRateRpm` | float | ✓ | 600 | Rounds per minute. Must be > 0 |
| `MagazineSize` | int | ✓ | 30 | Must be > 0 |
| `ReloadSeconds` | float | ✓ | 2.2 | |
| `EquipSeconds` | float | — | 0.5 | |
| `PelletCount` | int | — | 1 | > 1 makes it a shotgun. No special-casing in code. |
| `SpreadDegrees` | float | — | 0 | Cone half-angle per shot |
| `BloomPerShot` | float | — | 0.15 | Degrees added per shot while firing |
| `BloomMaxDegrees` | float | — | 3.0 | Cap |
| `BloomRecoveryPerSecond` | float | — | 4.0 | |
| `FirstShotAccurate` | bool | — | true | Zero spread when bloom is at rest |
| `IsProjectile` | bool | — | false | False = hitscan. Snipers use projectile. |
| `ProjectileSpeed` | float | — | 250 | m/s, read when `IsProjectile` |
| `ProjectileGravityScale` | float | — | 0.4 | Bullet drop multiplier |
| `AmmoType` | enum | ✓ | `Medium` | `Light`, `Medium`, `Heavy`, `Shell`, `None` |
| `AdsFovMultiplier` | float | — | 0.8 | |
| `AdsTimeSeconds` | float | — | 0.25 | |

**Validation:** `FireRateRpm > 0`; `MagazineSize > 0`; `Prefab != null`;
`DamageProfile != null`; `BurstCount >= 2` when `FireMode == Burst`;
warn if `SpreadDegrees > 10`.

> Note there is no `Rarity` field. Rarity is a runtime modifier applied over a
> single Blueprint — see the last anti-pattern in [README.md](README.md).

### `DamageProfileBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `BaseDamage` | float | ✓ | 30 | Per bullet or pellet, before multipliers |
| `HeadshotMultiplier` | float | ✓ | 2.0 | 2.5 for snipers |
| `StructureMultiplier` | float | ✓ | 1.0 | GDD §5.5 |
| `FalloffStartMetres` | float | — | 40 | Full damage up to here |
| `FalloffEndMetres` | float | — | 80 | `FalloffEndDamageScale` at and beyond |
| `FalloffEndDamageScale` | float | — | 0.5 | |
| `ShieldPenetration` | float | — | 0 | 0 = shield absorbs first, 1 = ignores shield |

**Validation:** `BaseDamage > 0`; `FalloffEndMetres >= FalloffStartMetres`;
`FalloffEndDamageScale` in [0, 1]; `ShieldPenetration` in [0, 1].

### `RecoilProfileBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `VerticalKickDegrees` | float | ✓ | 0.6 | Per shot |
| `HorizontalKickDegrees` | float | — | 0.2 | Randomised ± |
| `Pattern` | Vector2[] | — | [] | Fixed pattern; when non-empty it overrides random kick |
| `RecoveryPerSecond` | float | ✓ | 8 | Degrees returned per second |
| `RecoveryDelaySeconds` | float | — | 0.12 | Delay before recovery begins |

**Validation:** `RecoveryPerSecond > 0`; warn if `VerticalKickDegrees > 3`.

### `RarityBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `Tier` | int | ✓ | 0 | 0 = Common … 4 = Legendary. Unique across assets. |
| `Colour` | Color | ✓ | grey | UI tint and world-drop glow |
| `DamageMultiplier` | float | ✓ | 1.0 | GDD §5.3 |
| `LootWeight` | float | ✓ | 50 | Default weight in floor loot |

**Validation:** `DamageMultiplier > 0`; `LootWeight >= 0`; `Tier` unique across
all `RarityBlueprint` assets (a cross-asset check, run by
`tools/validate_blueprints.py`).

---

## Building

### `BuildPieceBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `Placement` | enum | ✓ | `Wall` | `Wall`, `Floor`, `Ramp`, `Cone` |
| `Occupancy` | enum | ✓ | `Face` | `Face` (wall/floor) or `Interior` (ramp/cone) |
| `MeshByMaterial` | dict `BuildMaterialBlueprint` → Mesh | ✓ | — | One mesh per material |
| `PreviewMaterial` | Material | ✓ | — | Ghost shown during placement |
| `CostOverride` | int | — | −1 | −1 means use the material's default cost |
| `EditVariants` | `EditVariant`[] | — | [] | See below |
| `SupportsAttachment` | flags | — | all | Which faces other pieces may attach to |
| `CollisionLayer` | LayerMask | ✓ | `Structure` | |
| `BuildSound` | AudioClip | — | — | Falls back to the material's sound |

**Validation:** `MeshByMaterial` has an entry for every `BuildMaterialBlueprint`
in the project; `PreviewMaterial != null`; `Occupancy` is `Interior` when
`Placement` is `Ramp` or `Cone`.

### `EditVariant` (nested, not a standalone asset)

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `VariantName` | string | ✓ | — | "Doorway", "Window", "Trapdoor" |
| `GridMask` | bool[9] | ✓ | all true | 3×3 mask over the piece face; false = removed |
| `MeshByMaterial` | dict | ✓ | — | As above |
| `HealthScale` | float | — | 1.0 | Variants with holes may be weaker |

The 3×3 mask is why new edit shapes are asset work: a doorway is
`[1,1,1, 1,0,1, 1,0,1]`, a window is `[1,1,1, 1,0,1, 1,1,1]`. Adding a new shape
means a new mask and a new mesh, not new code.

### `BuildMaterialBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `MaterialKind` | enum | ✓ | `Wood` | `Wood`, `Stone`, `Metal` |
| `BuildHealth` | float | ✓ | 90 | HP at the instant of placement |
| `FullHealth` | float | ✓ | 150 | HP after the ramp completes |
| `BuildTimeSeconds` | float | ✓ | 3.0 | Ramp duration. GDD §4.3 |
| `CostPerPiece` | int | ✓ | 10 | |
| `MaxCarried` | int | ✓ | 500 | |
| `SurfaceMaterial` | Material | ✓ | — | Rendering material |
| `HarvestSound` / `BuildSound` / `DestroySound` | AudioClip | — | — | |
| `UiColour` | Color | ✓ | — | HUD tint |

**Validation:** `FullHealth >= BuildHealth`; `BuildTimeSeconds > 0`;
`CostPerPiece > 0`; `MaterialKind` unique across assets.

---

## Loot

### `LootTableBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `Entries` | `LootEntry`[] | ✓ | [] | Weighted |
| `RollCount` | IntRange | ✓ | 1..1 | Inclusive number of rolls |
| `AllowDuplicates` | bool | — | true | |
| `RarityBias` | int | — | 0 | Shifts rolled rarity by N tiers; chests use 1 |

### `LootEntry` (nested)

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `Kind` | enum | ✓ | `Item` | `Item`, `Table`, `Nothing` |
| `Item` | → `ItemBlueprint` | ✓ if `Item` | — | Weapon or consumable |
| `Table` | → `LootTableBlueprint` | ✓ if `Table` | — | Nested table |
| `Weight` | float | ✓ | 1 | Relative within the table |
| `CountRange` | IntRange | — | 1..1 | Stack size for stackables |
| `RarityOverride` | → `RarityBlueprint` | — | — | Forces a tier; supply drops use this |

Nesting is how a "Chest" table is composed from a "Weapon" table and a
"Consumable" table rather than restated as a flat list.

**Validation:** weights sum > 0; no reference cycle among nested tables (checked
by `tools/validate_blueprints.py`); the reference matching `Kind` is set.

### `ConsumableBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `HealthRestored` | float | — | 0 | |
| `ShieldRestored` | float | — | 0 | |
| `HealthCap` | float | — | 100 | Bandages cap below max; GDD §5.1 |
| `UseSeconds` | float | ✓ | 3.0 | |
| `MaxStack` | int | ✓ | 5 | |
| `ConsumedOnUse` | bool | — | true | |
| `CancelOnDamage` | bool | — | true | |

---

## Match

### `MatchRulesBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `SquadSize` | int | ✓ | 1 | 1 solo, 2 duos, 4 squads |
| `MaxPlayers` | int | ✓ | 100 | |
| `AllowDbno` | bool | ✓ | false | True for squad modes. GDD §1.3 |
| `DbnoHealth` | float | — | 100 | |
| `DbnoBleedPerSecond` | float | — | 2 | |
| `ReviveSeconds` | float | — | 8 | |
| `StormPhases` | → `StormPhaseBlueprint`[] | ✓ | — | Ordered |
| `Lighting` | → `MatchLightingBlueprint` | ✓ | — | |
| `BusSeconds` | float | ✓ | 45 | |
| `GliderDeployAltitude` | float | ✓ | 35 | Metres above ground |
| `StartingLoadout` | → `ItemBlueprint`[] | — | [pickaxe] | |
| `FriendlyFire` | bool | — | false | |

**Validation:** `SquadSize >= 1`; `MaxPlayers % SquadSize == 0`;
`StormPhases` non-empty; `AllowDbno` false implies `SquadSize == 1` (warn only —
a solo mode with DBNO is odd but legal).

### `StormPhaseBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `PhaseIndex` | int | ✓ | 0 | Ordering; unique |
| `WaitSeconds` | float | ✓ | 120 | Time before closing begins |
| `CloseSeconds` | float | ✓ | 120 | Duration of the shrink |
| `StartRadius` | float | ✓ | 900 | |
| `EndRadius` | float | ✓ | 600 | |
| `DamagePerSecond` | float | ✓ | 1 | |
| `CentreBiasToPlayers` | float | — | 0.3 | 0 = purely random inside previous circle, 1 = player centroid |
| `MaxRotationDistance` | float | — | −1 | −1 auto-computes from sprint speed × `CloseSeconds` × 1.1 |

**Validation:** `EndRadius <= StartRadius`; both > 0; `CloseSeconds > 0`;
`PhaseIndex` unique; `StartRadius` equals the previous phase's `EndRadius`
(cross-asset check — a gap here is a silent teleporting circle).

### `MatchLightingBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `KeyframesByPhase` | `LightingKeyframe`[] | ✓ | — | One per storm phase |
| `SkyGradient` | Gradient | ✓ | — | Sampled by phase progress |
| `SunElevationCurve` | AnimationCurve | ✓ | — | Degrees vs normalised match time |
| `MinPlayerRimIntensity` | float | ✓ | 0.4 | Floor that keeps players visible. Pillar 2 |

**Validation:** one keyframe per phase in the referenced `MatchRulesBlueprint`;
`MinPlayerRimIntensity > 0` — a zero here is what would make deep night a stealth
mechanic, which the GDD forbids.

---

## Character

### `MovementBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `WalkSpeed` | float | ✓ | 4.6 | GDD §3 |
| `SprintSpeed` | float | ✓ | 7.4 | |
| `CrouchSpeed` | float | ✓ | 2.3 | |
| `AirControl` | float | — | 0.35 | 0..1 |
| `JumpHeight` | float | ✓ | 1.1 | Metres apex |
| `Gravity` | float | ✓ | −22 | m/s²; negative |
| `TerminalVelocity` | float | ✓ | 55 | |
| `FallDamageThreshold` | float | ✓ | 3.5 | Metres of drop before damage |
| `FallDamagePerMetre` | float | ✓ | 10 | |
| `MantleMaxHeight` | float | — | 1.6 | |
| `MantleSeconds` | float | — | 0.4 | |
| `CrouchHeight` / `StandHeight` | float | ✓ | 0.9 / 1.8 | Capsule heights |
| `Acceleration` / `Deceleration` | float | ✓ | 60 / 45 | m/s² |

**Validation:** `SprintSpeed >= WalkSpeed >= CrouchSpeed`; `Gravity < 0`;
`JumpHeight > 0`; `CrouchHeight < StandHeight`.

### `CharacterBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `Movement` | → `MovementBlueprint` | ✓ | — | |
| `MaxHealth` | float | ✓ | 100 | |
| `MaxShield` | float | ✓ | 100 | |
| `Prefab` | GameObject | ✓ | — | `PF_Character_*` |
| `CosmeticMaterial` | Material | — | — | Variant swap; pipeline test only |
| `CameraHeight` | float | ✓ | 1.65 | Eye height when standing |
| `Hitboxes` | `HitboxDefinition`[] | ✓ | — | Head/body/limb, with damage scales |

**Validation:** `MaxHealth > 0`; exactly one hitbox flagged `IsHead`;
`CameraHeight < Movement.StandHeight`.

---

## World

### `HarvestableBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `Material` | → `BuildMaterialBlueprint` | ✓ | — | What it yields |
| `TotalHealth` | float | ✓ | 100 | |
| `YieldPerHit` | int | ✓ | 10 | |
| `BonusYieldOnWeakPoint` | int | — | 10 | Extra for hitting the marker |
| `YieldOnDestroy` | int | — | 20 | |
| `Prefab` | GameObject | ✓ | — | |
| `DestroyedVfx` | GameObject | — | — | |
| `RespawnSeconds` | float | — | −1 | −1 = never (the match-long default) |

### `PoiBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `Tier` | enum | ✓ | `Minor` | `Major`, `Minor`, `Landmark` |
| `ChestSpawnPoints` | int | ✓ | 4 | |
| `ChestSpawnChance` | float | ✓ | 0.7 | Per point, per match |
| `FloorLootCount` | IntRange | ✓ | 3..6 | |
| `ChestTable` | → `LootTableBlueprint` | ✓ | — | |
| `FloorTable` | → `LootTableBlueprint` | ✓ | — | |
| `SceneName` | string | ✓ | — | Additively loaded sub-scene |

### `MapBlueprint`

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `Pois` | → `PoiBlueprint`[] | ✓ | — | |
| `SizeMetres` | float | ✓ | 1400 | |
| `MaxPoiSeparation` | float | ✓ | 450 | Checked by the map validator. GDD §8 |
| `MaxBuildableSlope` | float | ✓ | 40 | Degrees |
| `MinOpenTerrainFraction` | float | ✓ | 0.30 | |
| `BusPathSeed` | int | — | 0 | 0 = random per match |

**Validation:** these last three are asserted by a tooling check over the built
terrain, not by eye — see GDD §8 and the M5 exit criteria.

---

## Shared value types

| Type | Definition |
| --- | --- |
| `IntRange` | `{ int Min; int Max; }`, inclusive. `Min <= Max`. |
| `BlueprintRef<T>` | Serialised `BlueprintId` resolved through `BlueprintRegistry`. |
| `HitboxDefinition` | `{ string Name; bool IsHead; float DamageScale; Collider Collider; }` |
| `LightingKeyframe` | `{ int PhaseIndex; Color SunColour; float SunIntensity; Color FogColour; float FogDensity; }` |

## Adding a new Blueprint type

A new *type* is a code change — that is expected (see "When the contract does not
apply"). The checklist:

1. Add the C# class in `Scripts/Blueprints/<Category>/`, inheriting
   `TonightBlueprint`, with a `[CreateAssetMenu(menuName = "Tonight/Blueprints/…")]`.
2. Implement `Validate(BlueprintValidationContext)`.
3. Give every field a playable default (rule 6).
4. Add it to this document, in the matching category.
5. Add a folder under `Assets/Tonight/Blueprints/<Category>/`.
6. Add validation coverage in `tools/validate_blueprints.py` if it needs a
   cross-asset check.
7. Write the EditMode test for its validation rules.
