# System: Bots

**Owner:** engineering · **Status:** implemented in the sandbox · **Milestone:** M3

## 1. Why they exist

Health, shields and elimination were all specified long before anything could
use them, because nothing in the world could hurt the player. The two damage
sources that did exist — a fall and the storm — both **bypass shield by
design**, so a shield potion was decoration: there was no way to spend one and
no way to tell whether it had worked.

A bot is the smallest thing that makes those systems real. It is not an attempt
at an opponent and it is not the netcode stand-in; it is a target that shoots
back, so that "shield absorbs first", "a hit interrupts a heal" and "eliminated,
then respawned" are things that happen in play rather than only in a test.

## 2. What a bot is

A `CharacterBlueprint` wearing a `WeaponBlueprint`, with a `BotBlueprint` giving
the numbers it fights by:

| Field | Governs |
| --- | --- |
| `characterId` | Health, hitboxes and mesh |
| `weaponId` | What it shoots, including magazine and reload |
| `startingShield` | What it respawns with; health comes from the character |
| `engageRangeMetres` | How close a player must be before it opens fire. `0` never does |
| `reactionSeconds` | Delay between seeing a target and firing |
| `secondsBetweenShots` | Trigger discipline — see §4 |
| `aimErrorDegrees` | The cone its aim wanders inside: its only inaccuracy |
| `respawnSeconds` | Elimination to standing back up |
| `retaliates` | Shoots back at whoever hit it, whatever the range says |

The shipped set is two entries that differ only in JSON:

- `bot.target` — `engageRangeMetres: 0`, `retaliates: false`. A pure target.
- `bot.skirmisher` — engages inside 22 m and fights back once hit.

**A harder bot is an edited Blueprint.** There is no difficulty code path, and
adding one would be the same contract violation as `if (weapon.id === ...)`.

## 3. The decision

`decideBot` returns one of `idle`, `aiming` or `fire`, and that is the whole
brain. Bots do not move: movement is where an AI stops being cheap, and a
stationary opponent still exercises every system this exists to exercise.

```
engaged = alive and target alive and line of sight
          and (within engageRange or (retaliates and provoked))
no sight            → idle, and acquisition resets
acquired this tick  → aiming
within reaction     → aiming
before next shot    → aiming
otherwise           → fire
```

Two rules are worth stating outright:

**Line of sight is required even when provoked.** A bot that fired through the
wall it was shot through would make cover decorative, and building is the
pillar. Terrain, structures and props all break the line — so a wall you throw
up mid-fight stops the shooting, and the bot then puts its rounds into the wall.

**Losing sight costs the reaction time again.** Stepping behind cover and back
out is worth something, or peeking would be free.

## 4. Trigger discipline

`secondsBetweenShots` is the bot's own, separate from the weapon's fire rate,
and both apply — whichever is slower wins. A bot holding the trigger of a
600 rpm rifle is not a difficulty setting, it is a wood chipper. The shot still
goes through `tryFire`, so magazine, cooldown, fire mode and reload are the same
state machine the player uses; a second one would have drifted from the first
within a week.

The validator warns when `secondsBetweenShots` is *shorter* than the weapon's
own interval, because then the field does nothing and the author has misread
what it means.

## 5. Aim

A bot's shot is `pelletDirection(aim, weaponSpread + aimErrorDegrees, seed, n)` —
the same seeded cone the player's shotgun uses. Nothing else about the shot is
special: same damage formula, same hitboxes, same structure multiplier when it
misses and hits your build instead.

Seeded from the bot's id and the tick, so a shot is reproducible from values a
server and client would both have.

## 6. Where they stand

In the sandbox: two targets ahead of the spawn, three skirmishers further out —
deliberately beyond their own engage range, so the spawn point is safe and
walking toward one is a decision rather than an ambush.

## 7. What this is not

Bots are not the multiplayer stand-in. They do not move, take cover, build, or
push — which is also why the storm leaves them alone
([storm.md](storm.md) §4.1). The pickaxe does not damage them either, because §9 of
[combat.md](combat.md) has not yet decided whether it damages players at all,
and guessing here would make the answer harder to change.

When netcode lands (M4) the player they shoot at becomes one of several, and the
parts worth keeping are the ones that are already shared: `Combatant`, the
damage formula, and `tryFire`.

## 8. Test plan

| Test | Level | Asserts |
| --- | --- | --- |
| Engage range | Unit | Silent beyond it; fires inside it |
| Reaction | Unit | No shot before `reactionSeconds`; paid again after losing sight |
| Trigger discipline | Unit | One shot per `secondsBetweenShots`, never faster |
| Cover | Unit | No fire without line of sight, provoked or not |
| Retaliation | Unit | Fires back from outside engage range once hit; `bot.target` never does |
| Blueprint checks | Unit | Dangling refs, a shield above the character's max, a melee bot, an inert fire interval |
| The loop | Smoke | A bot is shot down, counts down to respawn, returns fire, and a built wall stops it |
