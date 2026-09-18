# The Blueprint authoring contract

**Read this before writing any gameplay code.**

A *Blueprint* in Tonight is a piece of game content authored as **data** — an
entry in one of the JSON files under `web/data/`. Blueprints are the project's
answer to Unreal's Blueprints; see
[ADR-0001](../adr/0001-blueprint-data-layer.md) for why, and
[ADR-0007](../adr/0007-threejs-instead-of-unity.md) for why they are JSON rather
than the ScriptableObject assets ADR-0001 originally described.

## The contract, in one sentence

> Adding content to a finished system must require **zero code changes**.

If adding a weapon, a build piece, a loot entry, a storm phase, or a rarity tier
requires editing a `.ts` file, the system is not finished.

## What this means in practice

### For a designer

1. Open `web/data/combat.json`.
2. Copy an entry in the `weapons` array and change the fields.
3. Add its `id` to a loot table in `web/data/loot.json`.
4. Reload the page. It is in the game.

No code, no build step, no programmer. `npm test` tells you if you got a field
wrong, and `npm run dev` hot-reloads the JSON.

### For a programmer

You are writing a **runtime**, not a game. Systems are generic over Blueprints.

```ts
// WRONG -- the system knows what a shotgun is.
if (weapon.id === "weapon.shotgun") {
  for (let i = 0; i < 8; i++) firePellet(spread(1.5));
} else {
  firePellet(spread(0));
}

// RIGHT -- the system knows what a weapon is.
for (let i = 0; i < weapon.pelletCount; i++) {
  firePellet(spread(weapon.spreadDegrees));
}
```

The first version means a new shotgun-like weapon needs a code change. The second
means it needs a JSON entry. That difference, compounded across a project's
content, is the whole argument.

## Rules

### 1. Blueprints are immutable at runtime

A Blueprint is shared, loaded-once, read-only data. **Never write to a Blueprint
field at runtime** — every field on every Blueprint type is declared `readonly`,
so TypeScript enforces this, and the whole library is one shared object graph:
a mutation would leak across matches and across players.

Per-instance mutable state lives in a runtime object that *references* its
Blueprint by id:

```ts
interface WeaponInstance {
  readonly blueprintId: string;  // shared, read-only
  ammoInMagazine: number;        // per-instance, mutable
  readonly rarityId: string;
}
```

### 2. Identity is a stable `id`, never a name or an array position

Every Blueprint carries an `id` — a dotted string authored once at creation and
never changed (`weapon.assaultRifle`, `piece.wall`). All references, save data,
replays, and wire messages use it.

`displayName` is for humans. Renaming *Assault Rifle* to *Ranger* must not break
anything, and neither must reordering an array.

### 3. Blueprints hold data, not behaviour

No functions, no closures, no object references. A Blueprint may hold:

- Value fields (numbers, booleans, enums-as-string-literals, strings).
- The `id` of *another* Blueprint.
- Asset paths (meshes, textures, audio), as strings resolved by the loader.

A Blueprint may **not** hold a live object, because it is parsed from JSON before
any of them exist. This is stricter than the ScriptableObject version, which
could hold direct asset references — and that strictness is the point: an id is
serialisable, diffable, and sendable over the wire.

[ADR-0001](../adr/0001-blueprint-data-layer.md) permitted one escape hatch, a
visual-scripting graph reference for designer-authored ability logic. That hatch
does not exist here; abilities are not implemented yet, and when they are they
will need a data-expressible form rather than an embedded graph.

### 4. Validate in one place, and run it in CI

Data-driven content fails at runtime rather than compile time, so validation has
to be deliberate. Every check lives in `validateLibrary()` in
`web/src/blueprints/registry.ts`:

```ts
for (const w of library.weapons) {
  if (w.fireRateRpm <= 0) error("fireRateRpm must be positive.", w.id);
  if (w.magazineSize <= 0) error("magazineSize must be positive.", w.id);
  requireRef(w.damageProfileId, w.id, "damageProfileId");
  if (w.rangeMetres > 200) warn("Range above 200 m exceeds the design band.", w.id);
}
```

`error` fails the build; `warn` reports without failing.
`web/tests/blueprints.test.ts` runs the whole thing over the shipped content on
every push, and asserts there are zero errors.

Validation is deliberately *cross-asset*, not just per-field: duplicate ids,
dangling references, loot-table cycles, storm radii that do not shrink
monotonically, lighting keyframes that do not cover the match, and
`maxPlayers % squadSize` are all things no single entry can catch about itself.

### 5. Composition over inheritance

Deep Blueprint hierarchies get unmanageable fast. Prefer a Blueprint *referencing*
another over nesting:

```
weapons[]
  ├── damageProfileId  →  damageProfiles[]   (shared across weapons)
  ├── recoilProfileId  →  recoilProfiles[]   (shared across a class)
  └── ammoType         →  a string literal, not a Blueprint
```

Three weapons sharing a recoil profile means tuning it once. A field-per-weapon
copy would have forced re-tuning three times and drifting twice.

Shared structure is expressed by `extends BlueprintBase` in `types.ts` — one
level, for the fields genuinely common to everything (`id`, `displayName`,
`description`, `tags`).

### 6. Defaults must be playable

A newly copied Blueprint should produce something that works, even if badly
balanced. A designer adding a weapon and reloading should get a firing weapon,
not a crash. Where a field is genuinely optional it is declared optional and the
runtime supplies a sane default; where it is not, the validator says so by name.

## Blueprint categories

| File | Arrays | Spec |
| --- | --- | --- |
| `combat.json` | `damageProfiles`, `recoilProfiles`, `rarities`, `weapons` | [systems/combat.md](../systems/combat.md) |
| `building.json` | `buildMaterials`, `buildPieces` (with nested `editVariants`) | [systems/building.md](../systems/building.md) |
| `loot.json` | `consumables`, `lootTables` | [systems/loot.md](../systems/loot.md) |
| `match.json` | `stormPhases`, `lighting`, `matchRules` | [systems/storm.md](../systems/storm.md), [systems/match-flow.md](../systems/match-flow.md) |
| `character.json` | `movement`, `characters` | [systems/movement.md](../systems/movement.md) |
| `world.json` | `harvestables`, `pois`, `maps` | [systems/harvesting.md](../systems/harvesting.md) |

Full field-by-field detail: [schema-reference.md](schema-reference.md).

## Layout

```
web/
├── data/                      the content set -- 71 blueprints, six files
│   ├── building.json
│   ├── character.json
│   ├── combat.json
│   ├── loot.json
│   ├── match.json
│   └── world.json
└── src/blueprints/
    ├── types.ts               the schema (interfaces only, no behaviour)
    ├── library.ts             loads and types the JSON; exposes the registry
    └── registry.ts            id lookup + validateLibrary()
```

One file per category, one array per type, ids namespaced by type
(`weapon.*`, `piece.*`, `loot.*`, `storm.*`). Files are grouped for review
convenience only — the registry flattens them into one id space, so an id must
be unique across *all* six files, and the validator checks that.

## Anti-patterns

| Smell | Why it is wrong | Fix |
| --- | --- | --- |
| `switch` on a Blueprint id | Behaviour keyed to content | Add a field to the Blueprint |
| A tuning number in a `.ts` file | Unshared, unreviewable as content, needs a rebuild | Move it to a Blueprint |
| Blueprint field written at runtime | Corrupts data shared by every player | Move to a runtime instance object |
| `library.weapons[0]` | Position-based identity; breaks on reorder | `registry.get("weapon.…")` |
| A union type listing content (`type WeaponId = "shotgun" \| …`) | Adding content edits code | A plain `string` id, validated by reference |
| A Blueprint per rarity *variant* of one weapon | Combinatorial explosion | Rarity is a runtime modifier over one Blueprint |

The last one is worth stating outright: five weapon classes × five rarities is
**five** Blueprints and a rarity modifier, not twenty-five Blueprints.

## When the contract does not apply

Honesty about the boundary, so the rule stays credible:

- **Engine plumbing.** Netcode transport, input binding, and rendering setup are
  not content and do not need a Blueprint.
- **One-of-a-kind systems.** The storm is one system with a phase list; it needs
  `stormPhases`, not a `storms` array abstracting over hypothetical alternative
  storms.
- **Genuinely novel mechanics.** A mechanic no existing Blueprint field can
  express needs code. That is expected. The rule is that *after* it ships,
  *variants* of it must not need code.

The test is not "did this need code?" — new systems always do. It is: **once the
system exists, can a designer add the tenth one without me?**
