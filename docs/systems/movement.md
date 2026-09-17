# System: Movement

**Owner:** engineering · **Status:** specified, unimplemented · **Milestone:** M1

## 1. Design intent

The movement verb set is deliberately small. No slide, no dash, no double jump,
no wall-run. Every verb added to movement competes with building for the player's
attention and for the game's skill ceiling, and building is the pillar.

What remains: walk, sprint, crouch, jump, mantle.

## 2. Values

All from `MovementBlueprint`. GDD §3 holds the shipped defaults.

| Property | Default |
| --- | --- |
| Walk / Sprint / Crouch speed | 4.6 / 7.4 / 2.3 m/s |
| Acceleration / Deceleration | 60 / 45 m/s² |
| Air control | 0.35 |
| Jump height | 1.1 m |
| Gravity | −22 m/s² |
| Terminal velocity | 55 m/s |
| Fall damage threshold / per metre | 3.5 m / 10 HP |
| Mantle max height / duration | 1.6 m / 0.4 s |
| Stand / crouch capsule height | 1.8 / 0.9 m |

Gravity is exaggerated well beyond −9.81 because a realistic jump arc feels
floaty and, more importantly, because time spent airborne is time not building.

## 3. Simulation

Fixed-tick, command-driven ([ADR-0003](../adr/0003-defer-networking-to-m4.md)).

```
MoveCommand { tick, moveInput:Vector2, lookDelta:Vector2, flags, dt }
flags: Jump | Sprint | Crouch | Interact
```

Per tick:

```
1. Desired horizontal velocity = moveInput * speedFor(flags)
2. Accelerate toward it; in air scale the change by AirControl
3. Apply gravity, clamped to TerminalVelocity
4. Jump: if grounded and Jump flag, v.y = sqrt(2 * |Gravity| * JumpHeight)
5. Sweep the capsule, resolving collisions (Unity CharacterController)
6. Ground check: sphere cast down, 0.1 m tolerance
7. On landing, apply fall damage from peak height
8. Mantle check (§4)
```

Determinism requirements: `dt` comes from the command, never `Time.deltaTime`;
no input is read past step 1; no random term anywhere. This is what makes
reconciliation replay exact.

## 4. Mantle

```
grounded-or-falling, moving forward, obstacle ahead within 0.6 m,
obstacle top between 0.3 m and MantleMaxHeight, clear space above it
  → lock movement for MantleSeconds, interpolate to the ledge
```

Mantle is cancellable by jumping out of it. It cannot be used to climb build
pieces — a 4 m wall is far above `MantleMaxHeight`, which is exactly the point:
walls are cover, and beating a wall means building over it or shooting it.

## 5. Fall damage

```
fallDistance = peakY - landY
damage = max(0, fallDistance - FallDamageThreshold) * FallDamagePerMetre
```

Fall damage ignores shield and applies directly to health. Standing on a
just-placed ramp cancels the accumulated fall — `peakY` resets whenever the
player becomes grounded, including on a build piece. Building under yourself to
survive a fall is intended and should feel reliable.

## 6. Freefall and glider

A distinct movement state used between bus ejection and landing.

| State | Behaviour |
| --- | --- |
| Skydive | Terminal velocity ~55 m/s; pitch steers; dive to accelerate |
| Glider | Auto-deploys at `MatchRulesBlueprint.GliderDeployAltitude` (35 m AGL); descent ~12 m/s, horizontal ~18 m/s |
| Landed | Normal movement resumes; no fall damage from a glider landing |

Glider deploy is automatic and altitude-based rather than manual, so a player
cannot fatally misjudge it. Landing is a rotation decision, not an execution test.

## 7. Blueprint surface

`MovementBlueprint` holds every value above. `CharacterBlueprint` references it,
so a future mode with different movement is a Blueprint swap.

## 8. Test plan

| Test | Level | Asserts |
| --- | --- | --- |
| Blueprint application | EditMode | Every field reaches the controller; no hardcoded constant |
| Jump apex | PlayMode | Apex within 1 cm of `JumpHeight` |
| Terminal velocity | PlayMode | Never exceeded in a long fall |
| Fall damage | EditMode | Zero at threshold; linear above; ignores shield |
| Fall reset on build | PlayMode | Landing on a placed ramp cancels accumulated fall |
| Mantle bounds | PlayMode | Mantles at 1.5 m, refuses at 1.7 m, never climbs a 4 m wall |
| Determinism | EditMode | Same command sequence ⇒ bit-identical end state, 1000 ticks |
| Slope limit | PlayMode | Walkable to 40°, slides above |

The determinism test is the one that protects M4. It runs from M1.
