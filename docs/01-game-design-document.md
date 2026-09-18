# Game Design Document

Version 0.1 · Pre-production · Owner: design

This document specifies mechanics. It does not specify implementation — see
[02-technical-architecture.md](02-technical-architecture.md) and the per-system
docs in [systems/](systems/).

Every numeric value in this document is a **starting value**, and every one of
them lives on a Blueprint asset, not in code. Values here are the shipped
defaults; tuning happens in the Editor.

---

## 1. Match structure

### 1.1 Shape of a match

| Phase | Duration | What happens |
| --- | --- | --- |
| Lobby | until 30 players or 90 s timeout | Players join, load, idle in a pre-match island |
| Bus | 30 s | Transport crosses the map on a random chord; players eject at will |
| Freefall | ~10 s | Dive control, glider auto-deploys at 35 m above ground |
| Early game | 0:00–3:30 | Storm 0 covers the map. Looting phase. |
| Mid game | 3:30–7:30 | Storm phases 1–2. Rotations and fights. |
| End game | 7:30–11:30 | Storm phases 3–6. Small circles, heavy building. |
| Victory | — | Last player standing |

The match clock starts when the first player lands. The storm schedule in §7
totals **11:30**, so a full match runs about **12:10** door to door including
the bus and freefall.

**The game targets 30 players, not 100.** That is a consequence of running in a
browser: WebGL rendering of many players plus thousands of build pieces is the
project's top technical risk ([ADR-0007](adr/0007-threejs-instead-of-unity.md)),
and a smaller lobby on a smaller map keeps the build-fight loop intact while
that risk is worked down. A shorter match follows from a smaller lobby — the
same number of fights happens in less time.

These numbers are the sum of the §7 table, not an aspiration written beside it —
`web/tests/blueprints.test.ts` re-adds them in CI and warns if the shipped storm
data drifts outside the design band.

### 1.2 The night clock

Storm phase drives time-of-day. This is the game's identity mechanic.

| Storm phase | Sky state | Sun elevation |
| --- | --- | --- |
| 0 | Dusk | +8° |
| 1 | Blue hour | −4° |
| 2 | Nightfall | −14° |
| 3 | Deep night | −22° |
| 4 | False dawn | −10° |
| 5 | Dawn | +2° |
| 6 | Sunrise | +12° |

Seven phases rather than eight, so the arc still runs dusk to sunrise across a
shorter match. `lighting.nightfall` in `web/data/match.json` carries these, and
validation requires a keyframe for every storm phase — a missing one would stall
the night clock partway.

Ambient light level **never affects gameplay**. Player and structure visibility
is maintained by rim lighting and emissive trim on characters at all phases —
verified by the visibility test in `docs/systems/storm.md`.

### 1.3 Modes

| Mode | Squad size | Lobby | Ships in |
| --- | --- | --- | --- |
| Solo | 1 | 30 | M4 |
| Duos | 2 | 30 (15 teams) | M5 |
| Trios | 3 | 30 (10 teams) | M5 |
| Practice range | 1 | — | M2 |

Squads are **three**, not four: 30 does not divide by 4, and one lobby size
across every mode matters for matchmaking at this scale. Validation enforces
`maxPlayers % squadSize === 0`, so this cannot silently drift.

Duos and Trios add downed-but-not-out (DBNO) and revives. DBNO is specified in
[systems/combat.md](systems/combat.md) and is a Blueprint toggle
(`MatchRulesBlueprint.allowDbno`), not a code branch.

---

## 2. Core loop

```
        ┌──────────────────────────────────────────────┐
        │                                              │
   LAND ──► LOOT ──► HARVEST ──► ROTATE ──► FIGHT ──────┤
        │             ▲                        │       │
        │             └────── build ───────────┘       │
        │                                              │
        └──────── storm closes, repeat, faster ────────┘
```

The loop tightens as the storm shrinks: early-game cycles are minutes long and
loot-dominated; end-game cycles are seconds long and build-dominated.

### 2.1 Loop timings (design targets)

| Action | Target time | Derivation |
| --- | --- | --- |
| Harvest one wall's worth of wood (10) | 0.7 s | 1 swing at 1.4 swings/s |
| Harvest a 1×1 box's worth of wood (40) | 1.4–2.9 s | 2 swings with weak points, 4 without |
| Harvest a full tree (150–270 wood) | 7.1 s | 10 swings at 30 pickaxe damage vs 300 HP |
| Place a wall | 0.15 s | input → confirmed |
| Build a full 1×1 box (4 walls) | 0.7 s | 4 placements |
| Ramp-rush 20 m of elevation (5 ramps) | 2.1–3.6 s harvest + ~2 s build | |
| Open a chest and evaluate loot | 3 s | |

The harvest rows are **derived** from the rates in
[systems/harvesting.md](systems/harvesting.md) §3 and the piece cost in §4.3,
not set independently — an earlier draft of this table asserted 4.5 s to gather
"one wall's worth (30)", which contradicted both the 10-material wall cost in
§4.3 and the documented swing rate by a factor of five.
The `harvesting` and `material wallet` suites in `web/tests/systems.test.ts`
re-derive these, so the two cannot drift apart again.

The weak-point bonus is what makes the spread between the two harvest columns
matter: missing every marker doubles the time to a box.

---

## 3. Movement

Full spec: [systems/movement.md](systems/movement.md).

**The camera is third person, over the shoulder.** A build fight is fought around
your own structure, and first person hides the ramp under you, the wall behind
you and the cone above you. Editing a wall you are standing against needs to be
possible without your own face being inside it.

| Property | Value |
| --- | --- |
| Walk speed | 4.6 m/s |
| Sprint speed | 7.4 m/s |
| Crouch speed | 2.3 m/s |
| Jump height | 1.1 m |
| Gravity | −22 m/s² (exaggerated for snappier arcs) |
| Terminal velocity | 55 m/s |
| Fall damage threshold | 3.5 m |
| Fall damage | 10 HP per metre above threshold |
| Mantle max height | 1.6 m |

No sliding, no dashes, no double jump. The movement verb set is deliberately
small so that building remains the mechanical skill expression (pillar 1).

---

## 4. Building

Full spec: [systems/building.md](systems/building.md). This is the most important
system in the game.

### 4.1 Grid

Building is quantised to a **4 m × 4 m × 4 m** cell aligned to world origin.
Pieces occupy a face, an interior diagonal, or a floor of that cell. Quantisation
is absolute: two players building in the same area produce interlocking
structures, never overlapping ones.

### 4.2 Piece types (M2 set)

| Piece | Occupies | Materials |
| --- | --- | --- |
| Wall | one vertical cell face | 10 |
| Floor | one horizontal cell face | 10 |
| Ramp | cell interior, 45° | 10 |
| Cone / pyramid | cell interior | 10 |

Each is a `BuildPieceBlueprint` asset. Adding a fifth piece type (e.g. a half-wall)
is an asset-authoring task, not a programming task.

### 4.3 Materials

| Material | Source | Build HP | Full HP | Build time |
| --- | --- | --- | --- | --- |
| Wood | Trees, wooden props | 90 | 150 | 3.0 s |
| Stone | Rocks, masonry | 90 | 300 | 4.0 s |
| Metal | Vehicles, machinery | 90 | 500 | 5.0 s |

A piece spawns at **build HP** and ramps to **full HP** over its build time. This
is the single most important balance lever in the game: it is what makes a freshly
placed wall killable and rewards the player who shoots first.

Material cap: 500 of each. Harvest rates are in [systems/harvesting.md](systems/harvesting.md).

### 4.4 Structural integrity

Structures are not free-floating. Each piece tracks **support**: a path of
connected pieces back to the terrain. When a piece is destroyed, unsupported
pieces above it are destroyed after a 0.4 s delay, cascading outward.

This is what makes shooting the bottom of a tower worthwhile, and it is a
simulation cost the netcode budget explicitly accounts for.

### 4.5 Editing

A placed piece owned by the player can be edited into a variant — wall → doorway,
wall → window, floor → trapdoor. Edit variants are listed on the
`BuildPieceBlueprint` as a set of `EditVariant` entries with a grid mask, so new
edit shapes are, again, asset work.

Edit is committed on release. Editing a piece an enemy is shooting is a core
skill expression and must not be rate-limited.

---

## 5. Combat

Full spec: [systems/combat.md](systems/combat.md).

### 5.1 Health

| Pool | Max | Notes |
| --- | --- | --- |
| Health | 100 | Does not regenerate passively |
| Shield | 100 | Consumable only |

### 5.2 Weapon classes (M3 set)

| Class | Role | Range band | Notes |
| --- | --- | --- | --- |
| Assault Rifle | Generalist | 10–60 m | First-shot accuracy, bloom on sustained fire |
| Shotgun | Close burst | 0–8 m | High single-hit, punishes exposed players |
| SMG | Close sustained | 0–15 m | Shreds freshly placed builds |
| Sniper | Long precision | 60 m+ | Bullet drop, one-shot headshot |
| Pistol | Fallback | 0–25 m | Floor loot filler |

### 5.3 Rarity

| Rarity | Colour | Damage multiplier |
| --- | --- | --- |
| Common | Grey | 1.00 |
| Uncommon | Green | 1.05 |
| Rare | Blue | 1.10 |
| Epic | Purple | 1.15 |
| Legendary | Gold | 1.21 |

Rarity multiplies damage only. It does not change fire rate, magazine, or
handling — a deliberate simplification so that a Common AR remains a viable
weapon and the loot loop does not become a hard gate.

Headshot multiplier: **×2.0** for all classes except Sniper (**×2.5**).

### 5.4 Hit registration

Server-authoritative hitscan with lag compensation: the server rewinds player
colliders to the shooter's view at the time of fire, bounded to 250 ms. Full
model in [systems/netcode.md](systems/netcode.md).

Projectile weapons (sniper) simulate on the server and are visually predicted on
the client.

### 5.5 Damage to structures

Bullets damage build pieces. Structure damage uses a separate multiplier per
weapon class so SMGs can be build-shredders without being player-shredders:

| Class | Structure multiplier |
| --- | --- |
| SMG | 1.6 |
| Assault Rifle | 1.0 |
| Shotgun | 0.8 |
| Sniper | 1.2 |
| Pickaxe | 1.0 (but ignores build-HP ramp) |

---

## 6. Loot

Full spec: [systems/loot.md](systems/loot.md).

Sources: floor spawns, chests, supply drops, player death piles.

Loot rolls happen **on the server**, once, at spawn time — never on a client, and
never re-rolled. Loot tables are `LootTableBlueprint` assets composed of weighted
entries, and tables can reference other tables, so a "Chest" table is built from a
"Weapon" table plus a "Consumable" table rather than being a flat list.

### 6.1 Rarity distribution (floor loot)

| Rarity | Weight |
| --- | --- |
| Common | 50 |
| Uncommon | 30 |
| Rare | 14 |
| Epic | 5 |
| Legendary | 1 |

Chests shift this distribution up one band. Supply drops roll Epic or Legendary
only.

---

## 7. The storm

Full spec: [systems/storm.md](systems/storm.md).

| Phase | Wait (s) | Close (s) | Radius (m) | DPS | Ends at |
| --- | --- | --- | --- | --- | --- |
| 0 | 120 | 90 | 800 → 520 | 1 | 3:30 |
| 1 | 70 | 65 | 520 → 340 | 1 | 5:45 |
| 2 | 55 | 50 | 340 → 210 | 2 | 7:30 |
| 3 | 40 | 40 | 210 → 120 | 5 | 8:50 |
| 4 | 30 | 30 | 120 → 60 | 7 | 9:50 |
| 5 | 25 | 25 | 60 → 25 | 10 | 10:40 |
| 6 | 20 | 30 | 25 → 0 | 10 | 11:30 |

Each phase's start radius equals the previous phase's end radius. A gap there is
a circle that silently teleports mid-match, so it is a cross-asset validation
error rather than a matter of care.

Each phase's next centre is chosen inside the current circle with a bias toward
the centroid of surviving players, clamped so that no player is ever more than
one full sprint-plus-10% away from safety at the moment the circle is announced.
That clamp is the difference between a tense rotation and an unfair death.

---

## 8. Map

Working title: **Nightfall Isle**. 800 m × 800 m island, scaled from the
original 1.4 km design along with the player count.

| Zone type | Count | Loot density | Purpose |
| --- | --- | --- | --- |
| Major POI (town) | 3 | High | Hot drops, early fights |
| Minor POI (farm, camp) | 7 | Medium | Safe-ish landings |
| Landmark (bridge, tower) | 4 | Low | Rotation anchors, sightlines |
| Open terrain | — | Very low | Build-fight space |

Design constraints:

- No POI is more than 260 m from another — a player who lands badly can reach
  loot before the first storm close. (450 m at the old map size, scaled.)
- Terrain has no slope above 40° outside of designed cliffs, so building is
  always viable.
- At least 30% of the map is open terrain. Build-fights need room.

The map is assembled from Blender-generated modules — see
[pipeline/README.md](pipeline/README.md).

---

## 9. Progression

There is none, and that is a design decision.

No XP, no unlocks, no battle pass, no account level. Every player enters every
match with identical capability. The only progression is the player's own skill.

This follows directly from the non-goals in [00-vision.md](00-vision.md): a
progression system implies a content treadmill, which implies an operation.

Cosmetic variants exist solely as a pipeline test — they are Blueprint-swapped
materials on the same mesh, selectable in the practice range.

---

## 10. UI

| Element | Position | Notes |
| --- | --- | --- |
| Health / shield bars | Bottom-centre | Shield above health, always visible |
| Material counts | Bottom-right, above inventory | Wood/stone/metal with icons |
| Inventory bar | Bottom-right | 5 slots + pickaxe |
| Build palette | Bottom-right, replaces inventory in build mode | 4 pieces + material selector |
| Minimap | Top-right | Storm circles overlaid |
| Storm timer | Under minimap | Phase state + countdown |
| Players remaining | Top-right corner | |
| Damage numbers | World-space at hit point | Distinct colour for structure hits |
| Hit markers | Crosshair | Separate sound + shape for player vs structure |

The build palette and inventory bar occupy the same screen space, so the player's
eye never has to move when switching modes. Build mode is a hold or a toggle,
player preference.

---

## 11. Audio

Audio in a battle royale is information, not decoration.

| Sound | Design requirement |
| --- | --- |
| Footsteps | Directional, material-dependent, audible through one floor |
| Build placement | Distinct per material, audible at 40 m |
| Structure destruction | Loud, distinct from placement, carries further |
| Chest hum | Loops, ~20 m radius, audible through walls |
| Storm | Continuous, volume scales with proximity to edge |
| Gunfire | Distance-attenuated with a separate distant-crack layer beyond 80 m |

Sound occlusion is deliberately weak — players must be able to hear an enemy
building above them. Full sound-propagation realism would hurt readability.

---

## 12. Open design questions

Tracked here rather than decided prematurely.

| Question | Status | Decide by |
| --- | --- | --- |
| Is build mode hold or toggle by default? | Open — needs playtest | M2 |
| Does the pickaxe do player damage? (proposal: 20, unrampable) | Open | M3 |
| Turbo building: hold-to-place with a cooldown, or off? | Open — big balance lever | M3 |
| Do supply drops exist, or is the loot ceiling chests only? | Leaning yes, small count | M4 |
| Sniper bullet drop: real ballistics or a simple curve? | Leaning simple curve | M3 |

---

## Appendix A — Blueprint coverage of this document

Every table above maps to a Blueprint asset type. If a value in this GDD is not
reachable from a Blueprint field, that is a bug in the implementation.

| GDD section | Blueprint type |
| --- | --- |
| 1.1 Match structure | `MatchRulesBlueprint` (`web/data/match.json`) |
| 1.2 Night clock | `MatchLightingBlueprint` |
| 3 Movement | `MovementBlueprint` |
| 4.2–4.4 Building | `BuildPieceBlueprint`, `BuildMaterialBlueprint` |
| 5.2–5.5 Combat | `WeaponBlueprint`, `RarityBlueprint`, `DamageProfileBlueprint` |
| 6 Loot | `LootTableBlueprint` |
| 7 Storm | `StormPhaseBlueprint` |
| 8 Map | `PoiBlueprint`, `MapBlueprint` |

Field-by-field detail: [blueprints/schema-reference.md](blueprints/schema-reference.md).
The shipped values live in `web/data/`, and `web/tests/blueprints.test.ts`
re-derives the match length, radius continuity and lobby arithmetic above, so
this document and the game cannot drift apart.
