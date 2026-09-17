# System: Combat

**Owner:** engineering · **Status:** specified, unimplemented · **Milestone:** M3

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

## 2. The damage formula

One formula, applied to everything. No special cases anywhere in code.

```
damage = profile.BaseDamage
       * rarity.DamageMultiplier
       * (hitbox.IsHead ? profile.HeadshotMultiplier : hitbox.DamageScale)
       * falloff(distance)
       * (target.IsStructure ? profile.StructureMultiplier : 1)

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

`Auto`, `Semi`, `Burst`, `BoltAction` — all driven from `WeaponBlueprint.FireMode`.
The shot scheduler is one generic state machine:

```
interval = 60 / FireRateRpm
on trigger: if (now - lastShot >= interval && ammo > 0) Shoot()
Burst:      fires BurstCount shots at interval, then requires a re-press
BoltAction: forced cycle time after each shot, cancellable into a weapon swap
```

Bolt-action cycling being swap-cancellable is a deliberate skill expression:
sniper-then-shotgun is a legitimate combo.

### 3.2 Spread and bloom

```
effectiveSpread = SpreadDegrees + currentBloom
currentBloom   += BloomPerShot per shot, capped at BloomMaxDegrees
currentBloom   -= BloomRecoveryPerSecond * dt while not firing
FirstShotAccurate: when currentBloom == 0, the shot is dead centre
```

Shotguns express through `PelletCount > 1` plus a wide `SpreadDegrees`. There is
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

`IsProjectile` weapons (sniper) simulate server-side with gravity
`Gravity * ProjectileGravityScale`. The client simulates a **visual-only** tracer
using identical parameters so the two agree closely; the server's result is
authoritative and the client's tracer is never used for hit resolution.

### 4.3 Structure hits

Bullets hit build pieces on the `Structure` layer. Structure damage applies
`StructureMultiplier` (GDD §5.5) and bypasses hitbox scaling entirely. A bullet
that hits a structure **stops** — no penetration in the M3 set.

## 5. Feedback

Feedback is information, not decoration. A player must know, without looking
away from the fight:

| Signal | Player hit | Structure hit |
| --- | --- | --- |
| Hit marker | Sharp X, white | Chevron, cyan |
| Sound | Short high tick | Duller thud |
| Damage number | White; yellow on headshot | Cyan |
| Elimination | Distinct chime + kill feed | — |

Damage numbers are world-space at the hit point and pooled — no allocation per
hit, per the zero-steady-state-allocation rule.

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

## 8. Test plan

| Test | Level | Asserts |
| --- | --- | --- |
| Damage formula | EditMode | Table-driven across class × rarity × hitbox × distance |
| Falloff boundaries | EditMode | Exact values at start, end, and beyond; monotonic between |
| Shield ordering | EditMode | Shield absorbs first; penetration splits correctly; no negative pools |
| Bloom | EditMode | Accumulates to cap, recovers to zero, first shot accurate at rest |
| Pellet determinism | EditMode | Same seed and shot index ⇒ identical pellet directions |
| Fire scheduling | EditMode | Rate honoured for each mode; burst requires re-press |
| Lag compensation | PlayMode (M4) | A hit on a rewound position registers; a 300 ms-late shot compensates only 250 ms |
| Structure multiplier | EditMode | SMG out-damages AR against structures, under-damages against players |
| DBNO | PlayMode (M5) | Bleed, revive, last-member wipe |
| **No-code content test** | Manual, M3 gate | A new weapon added via one Blueprint + one mesh, zero C# diff |

## 9. Open questions

| Question | Owner | Decide by |
| --- | --- | --- |
| Does the pickaxe damage players? Proposal: 20, no build ramp interaction | design | M3 |
| Sniper drop: simple curve or full ballistics? Leaning curve | design | M3 |
| Should bullets penetrate a destroyed-that-frame piece, or stop? | engineering | M3 |
