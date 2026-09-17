# The Blueprint authoring contract

**Read this before writing any gameplay C#.**

A *Blueprint* in Tonight is a `ScriptableObject` asset that defines a piece of
game content. Blueprints are the project's answer to Unreal's Blueprints — see
[ADR-0001](../adr/0001-blueprint-data-layer.md) for why.

## The contract, in one sentence

> Adding content to a finished system must require **zero C# changes**.

If adding a weapon, a build piece, a loot entry, a storm phase, or a rarity tier
requires editing a `.cs` file, the system is not finished.

## What this means in practice

### For a designer

1. Right-click in `Assets/Tonight/Blueprints/<Category>/`.
2. *Create → Tonight → Blueprints → Weapon*.
3. Fill in the Inspector fields.
4. Drag the new asset into a `LootTableBlueprint`.
5. Press Play. It is in the game.

No code, no recompile, no programmer.

### For a programmer

You are writing a **runtime**, not a game. Systems are generic over Blueprints.

```csharp
// WRONG — the system knows what a shotgun is.
if (weapon.id == "shotgun")
    for (int i = 0; i < 8; i++) FirePellet(Spread(1.5f));
else
    FireBullet();

// RIGHT — the system knows what a weapon is.
for (int i = 0; i < weapon.PelletCount; i++)
    FirePellet(Spread(weapon.SpreadDegrees));
```

The first version means a new shotgun-like weapon needs a code change. The second
means it needs an asset. That difference, compounded across a project's content,
is the whole argument.

## Rules

### 1. Blueprints are immutable at runtime

A Blueprint is shared, loaded-once, read-only data. **Never write to a Blueprint
field at runtime.** In the Editor a change to a `ScriptableObject` persists to
disk and silently rewrites your game's balance; in a build it leaks state across
matches.

Per-instance mutable state lives in a runtime struct that *references* its
Blueprint:

```csharp
public struct WeaponInstance {
    public BlueprintRef<WeaponBlueprint> Blueprint;  // shared, read-only
    public int AmmoInMagazine;                       // per-instance, mutable
    public RarityId Rarity;
}
```

### 2. Identity is a stable `BlueprintId`, never a name or path

Every Blueprint carries a `BlueprintId` — a GUID string authored once at creation
and never changed. All references, save data, replays, and wire messages use it.

Asset names and file paths are for humans. Renaming `BP_Weapon_AR` to
`BP_Weapon_AssaultRifle` must not break anything.

### 3. Blueprints hold data, not behaviour

No `Update()`, no coroutines, no scene references. A Blueprint may hold:

- Value fields (numbers, enums, strings, curves).
- References to *other* Blueprints.
- References to assets: prefabs, meshes, materials, audio clips, visual scripting
  graphs.

A Blueprint may **not** hold a reference to a scene object, because a
`ScriptableObject` outlives the scene.

The one permitted escape hatch is a reference to a Unity Visual Scripting graph
for designer-authored ability logic — scoped, per [ADR-0001](../adr/0001-blueprint-data-layer.md),
to abilities and events, and excluded from movement, building, netcode, and
damage paths.

### 4. Validate in `OnValidate`, and again in CI

Data-driven content fails at runtime rather than compile time, so validation has
to be deliberate. Every Blueprint implements `IValidatableBlueprint`:

```csharp
public void Validate(BlueprintValidationContext ctx) {
    ctx.Require(FireRateRpm > 0, "Fire rate must be positive");
    ctx.Require(MagazineSize > 0, "Magazine size must be positive");
    ctx.Require(Prefab != null, "Weapon needs a prefab");
    ctx.Warn(RangeMetres <= 200f, "Range above 200 m exceeds the design band");
}
```

`ctx.Require` fails the build. `ctx.Warn` reports without failing.
`tools/validate_blueprints.py` runs this over every asset in CI.

### 5. Composition over inheritance

Deep Blueprint hierarchies get unmanageable fast. Prefer a Blueprint *referencing*
another over subclassing:

```
WeaponBlueprint
  ├── DamageProfile  →  DamageProfileBlueprint   (shared across weapons)
  ├── Recoil         →  RecoilProfileBlueprint   (shared across a class)
  └── Audio          →  WeaponAudioBlueprint
```

Three weapons sharing a recoil profile means tuning it once. Inheritance would
have forced a class-per-combination.

Inheritance is permitted exactly one level deep, for genuine kind-of
relationships (`ItemBlueprint` → `WeaponBlueprint`).

### 6. Defaults must be playable

A freshly created Blueprint should produce something that works, even if badly
balanced. A designer creating a weapon and pressing Play should get a firing
weapon, not a null-reference exception.

## Blueprint categories

| Category | Types | Spec |
| --- | --- | --- |
| Combat | `WeaponBlueprint`, `DamageProfileBlueprint`, `RecoilProfileBlueprint`, `RarityBlueprint` | [systems/combat.md](../systems/combat.md) |
| Building | `BuildPieceBlueprint`, `BuildMaterialBlueprint`, `EditVariant` | [systems/building.md](../systems/building.md) |
| Loot | `LootTableBlueprint`, `LootEntry`, `ConsumableBlueprint` | [systems/loot.md](../systems/loot.md) |
| Match | `MatchRulesBlueprint`, `StormPhaseBlueprint`, `MatchLightingBlueprint` | [systems/storm.md](../systems/storm.md), [systems/match-flow.md](../systems/match-flow.md) |
| Character | `MovementBlueprint`, `CharacterBlueprint` | [systems/movement.md](../systems/movement.md) |
| World | `HarvestableBlueprint`, `PoiBlueprint`, `MapBlueprint` | [systems/harvesting.md](../systems/harvesting.md) |

Full field-by-field detail: [schema-reference.md](schema-reference.md).

## Folder layout

```
Assets/Tonight/Blueprints/
├── Combat/
│   ├── Weapons/          BP_Weapon_*.asset
│   ├── DamageProfiles/   BP_Damage_*.asset
│   ├── Recoil/           BP_Recoil_*.asset
│   └── Rarities/         BP_Rarity_*.asset
├── Building/
│   ├── Pieces/           BP_Piece_*.asset
│   └── Materials/        BP_BuildMat_*.asset
├── Loot/
│   ├── Tables/           BP_Loot_*.asset
│   └── Consumables/      BP_Consumable_*.asset
├── Match/
│   ├── Rules/            BP_Rules_*.asset
│   ├── Storm/            BP_Storm_Phase*.asset
│   └── Lighting/         BP_Lighting_*.asset
├── Character/            BP_Movement_*.asset, BP_Character_*.asset
└── World/
    ├── Harvestables/     BP_Harvest_*.asset
    └── Map/              BP_Poi_*.asset, BP_Map_*.asset
```

Prefix is always `BP_`. Folder mirrors category. This layout is what
`BlueprintRegistry`'s import-time scan expects.

## Anti-patterns

| Smell | Why it is wrong | Fix |
| --- | --- | --- |
| `switch` on a Blueprint id or name | Behaviour keyed to content | Add a field to the Blueprint |
| `[SerializeField] float damage` on a MonoBehaviour | Tuning lives on a scene object, unshared and unversioned | Move it to a Blueprint |
| Blueprint field written at runtime | Corrupts shared data; persists in Editor | Move to a runtime instance struct |
| `Resources.Load("Weapons/Shotgun")` | Path-based identity | Look up by `BlueprintId` in the registry |
| Enum listing content (`enum WeaponId { Shotgun, … }`) | Adding content edits code | Blueprint reference, or a data-defined id |
| A Blueprint per rarity *variant* of one weapon | Combinatorial explosion | Rarity is a runtime modifier over one Blueprint |

The last one is worth stating outright: five weapon classes × five rarities is
**five** Blueprints and a rarity modifier, not twenty-five Blueprints.

## When the contract does not apply

Honesty about the boundary, so the rule stays credible:

- **Engine plumbing.** Netcode transport, input binding, and rendering setup are
  not content and do not need a Blueprint.
- **One-of-a-kind systems.** The storm is one system with a phase list; it needs
  `StormPhaseBlueprint`, not a `StormBlueprint` abstraction over hypothetical
  alternative storms.
- **Genuinely novel mechanics.** A mechanic no existing Blueprint field can
  express needs code. That is expected. The rule is that *after* it ships,
  *variants* of it must not need code.

The test is not "did this need code?" — new systems always do. It is: **once the
system exists, can a designer add the tenth one without me?**
