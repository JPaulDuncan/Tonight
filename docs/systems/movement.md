# System: Movement

**Owner:** engineering · **Status:** specified, unimplemented · **Milestone:** M1

## 1. Design intent

The movement verb set is deliberately small. No slide, no dash, no double jump,
no wall-run. Every verb added to movement competes with building for the player's
attention and for the game's skill ceiling, and building is the pillar.

What remains: walk, sprint, crouch, jump, mantle.

## 1a. Camera

**Third person, over the shoulder.** This was never written down and the sandbox
drifted to first person; it is written down now because it is a design decision,
not a rendering detail.

Third person is the genre's, and it is load-bearing for the pillar rather than
cosmetic:

- A build fight is fought around your own structure. You need to see the ramp you
  are standing on, the wall behind you, and the cone over your head, and first
  person hides all three.
- Editing means aiming at a wall you are standing against. In first person your
  own face is inside it.
- Your silhouette is information your opponent is entitled to, and playing in
  first person while they play in third would be an advantage nobody chose.

| Property | Value |
| --- | --- |
| Boom length | 3.4 m behind the eye, along the aim direction |
| Shoulder offset | 0.75 m right, flattened so pitch does not roll the camera |
| Rise | 0.35 m above the eye |
| Convergence | 10 m |
| Minimum boom | 0.6 m, when the boom would otherwise pass through geometry |

**Gameplay reads the eye, not the camera.** Build range, the placement resolver
and the edit raycast all start at the player's eye and travel along the aim
direction; the camera is a view onto that and never an input to it. Feeding the
camera position to the resolver would quietly extend build range by the length of
the boom.

An offset camera and a centre-screen crosshair disagree unless the camera *looks
at* a point on the aim ray rather than merely pointing the same way. Convergence
is set to build range because that is where the crosshair has to be truthful;
there is a little parallax at other distances, which is the accepted cost of the
over-the-shoulder framing.

The boom is shortened when it would sit inside terrain or a build piece.
Without that, backing into a wall puts the camera on the far side of it and the
player sees the inside of their own base.

## 1b. Animation layers

Two layers, combined by a mask.

| Layer | Drives | Timed by |
| --- | --- | --- |
| Locomotion | Legs, and the arms when nothing is held | Distance travelled |
| Upper body | The parts in the active clip's mask | Seconds |

A masked part takes the clip's rotation **instead of** the walk's, not on top of
it. Both are Blueprints (`LocomotionBlueprint`, `UpperBodyBlueprint`), so
retiming a walk or giving a weapon its own hold is content.

The split in timing is deliberate: a stride should track the ground, so it is
driven by metres travelled and never skates; a swing should take the same time
whether its owner is standing still or sprinting.

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
4. Jump: if grounded and Jump flag, v.y = jumpVelocityForTick(blueprint, dt)
5. Sweep the capsule, resolving collisions (WorldCollision, separated-axis)
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
obstacle top between 0.3 m and mantleMaxHeight, clear space above it
  → lock movement for MantleSeconds, interpolate to the ledge
```

Mantle is cancellable by jumping out of it. It cannot be used to climb build
pieces — a 4 m wall is far above `mantleMaxHeight`, which is exactly the point:
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
| Blueprint application | Unit | Every field reaches the controller; no hardcoded constant |
| Jump apex | Unit | Apex within 1 cm of `jumpHeight`, at every tick rate |
| Terminal velocity | Browser | Never exceeded in a long fall |
| Fall damage | Unit | Zero at threshold; linear above; ignores shield |
| Fall reset on build | Browser | Landing on a placed ramp cancels accumulated fall |
| Mantle bounds | Browser | Mantles at 1.5 m, refuses at 1.7 m, never climbs a 4 m wall |
| Determinism | Unit | Same command sequence ⇒ bit-identical end state, 1000 ticks |
| Slope limit | Browser | Walkable to 40°, slides above |

The determinism test is the one that protects M4. It runs from M1.
