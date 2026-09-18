# System: Combat

**Owner:** engineering · **Status:** implemented in the sandbox; lag compensation and DBNO still specification only · **Milestone:** M3

## 1. Health model

| Pool | Max | Regenerates | Consumed first |
| --- | --- | --- | --- |
| Shield | 100 | No | Yes |
| Health | 100 | No | No |

Damage applies to shield, then health, unless the weapon's
`DamageProfile.ShieldPenetration` is above 0, in which case that fraction goes
straight to health.

Neither pool regenerates. Healing is consumable-only, which is what makes
disengaging after a fight a real decision rather than a wait.

Shield starts empty and is looted, never granted: a player who has not found a
potion is a player with 100 effective health. Two damage sources bypass the
shield entirely — a fall ([movement.md](movement.md) §5) and the storm
([storm.md](storm.md)) — which is why neither of them can stand in for an
opponent when the question is whether shields work. That is what
[bots.md](bots.md) exists for.

### 1.1 Combatants

The player and every bot are one type, `Combatant`: a pool, an alive flag, a
respawn tick and who hit it last. The moment the player is a special case the
damage path forks and the two halves drift, so there is one path and the only
difference between a player and a bot is what decides its inputs.

`damageCombatant` returns whether *this* hit eliminated the target, rather than
leaving the caller to check `alive` afterwards. Two pellets of one shotgun shell
both land on somebody with 5 health left, and only the first of them eliminated
anybody — a caller reading `alive` after the fact would post two kill-feed lines
and count two eliminations.

Elimination is not deletion: the body stays where it fell, the feed records
attacker, weapon and whether it was a headshot, and the combatant stands back up
on its own timer (four seconds for the player in the sandbox,
`BotBlueprint.respawnSeconds` for a bot). A match will replace the respawn with
spectating; everything above it stays.

## 2. The damage formula

One formula, applied to everything. No special cases anywhere in code.

```
damage = profile.BaseDamage
       * rarity.DamageMultiplier
       * (hitbox.IsHead ? profile.HeadshotMultiplier : hitbox.DamageScale)
       * falloff(distance)
       * (target.isStructure ? profile.structureMultiplier : 1)

falloff(d) = 1                            when d <= FalloffStartMetres
           = lerp(1, FalloffEndDamageScale,
                  (d - Start) / (End - Start))   between
           = FalloffEndDamageScale        when d >= FalloffEndMetres
```

Every term is a Blueprint field. Adding a weapon that behaves unlike anything
existing means finding the field that expresses it — or, rarely, adding a field.
It never means adding a branch.

## 3. Firing

### 3.1 Fire modes

`auto`, `semi`, `burst`, `boltAction` — all driven from `WeaponBlueprint.fireMode`.
The shot scheduler is one generic state machine:

```
interval = 60 / FireRateRpm
on trigger: if (now - lastShot >= interval && ammo > 0) Shoot()
Burst:      fires BurstCount shots at interval, then requires a re-press
boltAction: forced cycle time after each shot, cancellable into a weapon swap
```

Bolt-action cycling being swap-cancellable is a deliberate skill expression:
sniper-then-shotgun is a legitimate combo.

### 3.2 Spread and bloom

```
effectiveSpread = spreadDegrees + currentBloom
currentBloom   += BloomPerShot per shot, capped at BloomMaxDegrees
currentBloom   -= BloomRecoveryPerSecond * dt while not firing
FirstShotAccurate: when currentBloom == 0, the shot is dead centre
```

**Recovery is a flat rate, not a proportion**, which makes the two numbers
fight rather than settle: bloom either outruns recovery and pins at the cap, or
recovery outruns it and bloom never leaves zero. There is no equilibrium in
between, so a weapon's `bloomPerShot x fireRateRpm / 60` must exceed its
`bloomRecoveryPerSecond` or the mechanic is inert.

Every bloom weapon shipped inert until the weapons were first fired: the
assault rifle gained 1.47 deg/s while firing and lost 4. The code applied bloom
correctly and a unit test covered it — what nothing checked was the two rates
against each other. `validateLibrary` now does, and rejects the combination with
the arithmetic in the message.

The numbers are tuned so sustained fire reaches the cap in roughly the time a
magazine lasts, and stopping clears it in about a second:

| Weapon | Gained | Recovered | To cap | Clears in |
| --- | --- | --- | --- | --- |
| Assault rifle | 6.0 deg/s | 4 deg/s | 1.5 s | 0.8 s |
| SMG | 7.8 deg/s | 4 deg/s | 1.2 s | 1.1 s |
| Pistol | 5.8 deg/s | 4 deg/s | 2.0 s | 0.9 s |

Shotguns express through `pelletCount > 1` plus a wide `spreadDegrees`. There is
no shotgun code path — pellet count is a loop bound.

Pellet directions are drawn from a **seeded, shot-indexed** RNG shared by client
and server, so a predicted shotgun blast matches the authoritative one.

### 3.3 Recoil

Recoil moves the camera; spread moves the bullet. Keeping them separate lets a
weapon kick hard but shoot straight (sniper) or barely kick and spray (SMG).

```
per shot: pitch += VerticalKickDegrees; yaw += random(±HorizontalKickDegrees)
          or, when Pattern is non-empty, apply Pattern[shotIndex % length]
after RecoveryDelaySeconds of no fire: return toward origin at RecoveryPerSecond
```

Recovery returns to the pre-fire aim point, not to a fixed angle, so a player who
pulls down during a spray is not fighting the recovery afterwards.

## 4. Hit registration

### 4.1 Hitscan

Server-authoritative with lag compensation.

```
1. Client fires, sends FireCommand(origin, direction, clientTick, shotIndex).
2. Server computes rewind = clamp(now - clientTick, 0, 250 ms).
3. Server rewinds every other player's hitboxes to their position at that time.
4. Server raycasts. Hits resolve against rewound colliders.
5. Server restores present-time positions and applies damage.
```

The 250 ms cap is the fairness boundary: beyond it, a high-latency shooter would
be killing people who have been behind cover for a quarter of a second on their
own screen. Players above the cap are compensated to 250 ms and no further.

The rewind buffer stores 500 ms of hitbox transforms at tick rate — 15 snapshots
per player.

### 4.2 Projectiles

`isProjectile` weapons (sniper) simulate server-side with gravity
`Gravity * ProjectileGravityScale`. The client simulates a **visual-only** tracer
using identical parameters so the two agree closely; the server's result is
authoritative and the client's tracer is never used for hit resolution.

### 4.3 Structure hits

Bullets hit build pieces on the `Structure` layer. Structure damage applies
`structureMultiplier` (GDD §5.5) and bypasses hitbox scaling entirely. A bullet
that hits a structure **stops** — no penetration in the M3 set.

## 5. Feedback

Feedback is information, not decoration. A player must know, without looking
away from the fight:

| Signal | Player hit | Structure hit | Harvestable hit |
| --- | --- | --- | --- |
| Hit marker | Sharp X, white | Chevron, cyan | Chevron, cyan |
| Sound | Short high tick | Duller thud | Duller thud |
| Damage number | White; yellow on headshot | Cyan | Green |
| Elimination | Distinct chime + kill feed | Marker strokes thicken and brighten on the hit that destroys the piece | — |

Damage numbers are world-space at the hit point and pooled — no allocation per
hit, per the zero-steady-state-allocation rule.

### 5.1 How it is built

Everything in the table above is built except the sounds, which are still
specification only: the sandbox is silent.

The policy lives in `web/src/render/feedback.ts` and is pure arithmetic —
aggregation, lifetime, rise and fade — so it is tested in Node. The only part
that touches the browser is `FeedbackLayer`, which the sandbox constructs.

**One shot, one number per target.** A shotgun puts ten pellets into one wall;
ten numbers on one pixel is noise, and the player wants to know what the *shell*
did. Pellets accumulate into `ShotAccumulator` during the shot and are flushed
once, so a shell reads as one total and raises one marker. A spread that
straddles two pieces correctly gives two numbers — the aggregation is per
target, not per shot.

A hit that lands for a fraction of a point still shows `1`. Rounding it to `0`
would read as a miss, which is the opposite of what happened.

**The numbers are DOM, not sprites.** The HUD is already DOM, text stays crisp
at any distance with no glyph atlas, and the browser composites it. They are
still world-anchored as specified: each is projected from its hit point every
frame, so it stays on the thing it describes while the camera moves, and one
behind the camera is hidden rather than retired — turning back finds it still
counting down.

**The destroy flag comes from `applyDamage`'s return, not from asking the
structure afterwards.** By then another pellet of the same shot may have removed
the piece, or nothing may have, and neither answers "did *this* hit kill it".

The marker lives 0.18 s rather than the 0.12 s that reads best, because at
0.12 s it can be raised and cleared between two frames of a slow renderer, and a
hit that confirms itself to nobody is worse than one that lingers. The tracer
lifetime fell into exactly this trap first.

## 6. Downed-but-not-out (squad modes)

Enabled by `MatchRulesBlueprint.AllowDbno`, not by a code branch.

```
lethal damage with living teammates → DBNO at DbnoHealth
DBNO: crawl at CrouchSpeed * 0.5, cannot shoot or build
      bleeds DbnoBleedPerSecond
teammate holds revive for ReviveSeconds within 2 m → revive at 30 HP, 0 shield
further lethal damage while DBNO, or bleed-out → eliminated
last living squad member eliminated → all DBNO squadmates eliminated
```

## 7. Blueprint surface

| Blueprint | Governs |
| --- | --- |
| `WeaponBlueprint` | Fire mode, rate, magazine, pellets, spread, bloom, ADS, projectile |
| `DamageProfileBlueprint` | Base damage, headshot/structure multipliers, falloff, shield penetration |
| `RecoilProfileBlueprint` | Kick, pattern, recovery |
| `RarityBlueprint` | Damage multiplier, colour, loot weight |
| `CharacterBlueprint` | Health, shield, hitbox definitions |
| `ConsumableBlueprint` | Heal and shield amounts, the cap, the channel time, cancel rules |
| `BotBlueprint` | Everything a stand-in opponent fights by ([bots.md](bots.md)) |

## 8. Test plan

| Test | Level | Asserts |
| --- | --- | --- |
| Damage formula | Unit | Table-driven across class × rarity × hitbox × distance |
| Falloff boundaries | Unit | Exact values at start, end, and beyond; monotonic between |
| Shield ordering | Unit | Shield absorbs first; penetration splits correctly; no negative pools |
| Bloom | Unit | Accumulates to cap, recovers to zero, first shot accurate at rest |
| Bloom is not inert | Unit | Gain rate exceeds recovery, so sustained fire actually costs accuracy |
| A shot is a shot | Unit | `tryFire` returns `None` only when a round was spent |
| Pellet determinism | Unit | Same seed and shot index ⇒ identical pellet directions |
| Fire scheduling | Unit | Rate honoured for each mode; burst requires re-press |
| Lag compensation | Integration (M4) | A hit on a rewound position registers; a 300 ms-late shot compensates only 250 ms |
| Structure multiplier | Unit | SMG out-damages AR against structures, under-damages against players |
| Damage as shown | Unit | Rounds to whole numbers; a sub-1 hit shows 1, a miss shows nothing |
| Shot aggregation | Unit | Ten pellets into one target is one number; separate targets stay separate; overflow past the bucket count keeps the total honest |
| Number life | Unit | Opaque before it fades, monotonic rise, never transparent early |
| Feedback in the browser | Smoke | The pool is allocated up front; a shell raises one number and a chevron; both clear on time |
| Shield ordering, in play | Smoke | A bot's shield falls to zero before its health moves |
| Elimination | Unit | The killing blow is reported once; the dead take no further damage |
| Respawn | Unit | Not before the authored delay; full health and the authored shield after |
| Kill feed | Unit | Newest first, bounded, pooled, and entries expire |
| Survival loop | Smoke | Shoot a bot down, take return fire through a shield, build cover, be eliminated, respawn |
| DBNO | Integration (M5) | Bleed, revive, last-member wipe |
| **No-code content test** | Manual, M3 gate | A new weapon added via one Blueprint + one mesh, zero `.ts` diff |

## 9. Open questions

| Question | Owner | Decide by |
| --- | --- | --- |
| Does the pickaxe damage players? Proposal: 20, no build ramp interaction. Until this is settled it damages neither players nor bots | design | M3 |
| Sniper drop: simple curve or full ballistics? Leaning curve | design | M3 |
| Should bullets penetrate a destroyed-that-frame piece, or stop? | engineering | M3 |
