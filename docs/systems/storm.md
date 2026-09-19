# System: Storm

**Owner:** design + engineering · **Status:** running in the sandbox; the map overlay and the audio are still specification only · **Milestone:** M4

The storm is the match clock, the pacing mechanism, and — via the night arc —
the game's visual identity. See [vision](../00-vision.md) pillar 2.

## 1. Phases

Seven phases, ordered by `phaseIndex`. Shipped defaults are in GDD §7 and in
`web/data/match.json`; they total **11:30**, which the match-length check in
`web/tests/blueprints.test.ts` re-derives rather than trusts.

Each phase runs:

```
WAIT (WaitSeconds)   next circle announced and drawn on the map; storm stationary
CLOSE (closeSeconds) radius lerps startRadius → endRadius toward the new centre
```

Damage is applied to any player outside the current boundary at
`damagePerSecond`, ticked every second, ignoring shield. Storm damage is a clock,
not a combat interaction; letting shields absorb it would blunt the pacing.

### 1.1 Two storms, one system

`rules.sandbox` differs from `rules.solo` in exactly one field: the phase list.
Solo's first circle is 800 m across a map that does not exist yet; the sandbox
island is 200 m, so the same storm would never touch anybody. `storm.sandbox0`
through `storm.sandbox6` are the same seven phases at a fifth of the radius and
a little over a third of the clock — a whole night in six and a half minutes.

That is what §5 has always promised a faster mode is, and building it found the
one thing standing in the way: **continuity and phase-index uniqueness were
being checked across the entire library** rather than per phase list. A second
storm restarting at `phaseIndex` 0 read as a duplicate, and its first radius as
a teleport. Both checks now run over each mode's own ordered list, which is the
only scope in which either statement means anything.

## 2. Circle placement

The next centre is chosen inside the current circle, biased toward the surviving
players' centroid:

```
centroid   = mean position of living players
candidate  = lerp(randomPointInCircle(current), centroid, centreBiasToPlayers)
nextCentre = clampIntoCircle(candidate, current, nextRadius)
```

Then the fairness clamp, which is the part that matters:

```
maxDist = MaxRotationDistance
          (if < 0: SprintSpeed * CloseSeconds * 1.1)

for each living player:
    d = distance(player, nextCircleEdge)
    if d > maxDist:  pull nextCentre toward that player until d <= maxDist
```

No player is ever more than a full sprint plus 10% from safety at the moment the
circle is announced. Without this clamp, a player looted into a corner can die to
a rotation they could not physically make — which reads as the game cheating,
not as a mistake.

The clamp can fail to satisfy every player simultaneously when the survivor
spread exceeds the circle diameter. In that case it satisfies the **furthest**
player and logs a telemetry event, because that situation is a map-design
problem, not a runtime one.

## 3. The night clock

Storm phase drives time of day via `MatchLightingBlueprint`. GDD §1.2.

| Phase | Sky | Sun elevation |
| --- | --- | --- |
| 0 | Dusk | +8° |
| 1–2 | Blue hour | −4° |
| 3–4 | Deep night | −22° |
| 5 | False dawn | −10° |
| 6 | Dawn | +2° |
| 7 | Sunrise | +12° |

Lighting interpolates continuously across phase progress, never snapping.

**The hard constraint:** ambient light level never affects gameplay. There is no
stealth-in-darkness mechanic, and `minPlayerRimIntensity` (0.4 in the shipped
set) puts a
floor under character visibility at every phase. This is enforced by a test, not
by intention — see §6.

The reason is practical rather than aesthetic: display gamma varies enormously
between players, and any mechanic keyed to perceived darkness silently advantages
whoever has the better monitor.

## 4. Feedback

| Signal | Requirement |
| --- | --- |
| Map overlay | Current circle solid, next circle outlined, both always visible |
| HUD timer | Phase state (`WAITING` / `CLOSING`) plus countdown |
| Compass marker | Direction to the nearest safe point when outside |
| Audio | Continuous, volume scales with proximity to the edge |
| Screen effect | Desaturation plus edge vignette when outside; must not obscure aim |
| Damage | Standard damage numbers, distinct colour |

### 4.1 What is built

| Signal | Built | Notes |
| --- | --- | --- |
| Map overlay | Partly | No map screen exists, so both circles are drawn in the world: the boundary as a line laid over the terrain, the next circle as a second, dimmer one |
| The wall | Yes | An open cylinder at the current radius, drawn from the inside, not writing depth |
| HUD timer | Yes | Phase number, `WAITING` / `CLOSING` / `PAUSED`, and the countdown |
| Compass marker | Yes | An arrow, in degrees from straight ahead rather than from north — the question is "which way do I run" |
| Screen effect | Partly | The purple edge vignette, yes; the middle of the screen stays clear, because the fight is still happening. Not the desaturation: a full-screen backdrop filter costs more frame time than the effect is worth |
| Damage | Yes | Its own number colour. No hit marker: a marker confirms that *your* shot landed |
| Audio | No | Nothing in the project makes a sound yet |

**The line on the ground is not a substitute for the map, it is a better
answer to a different question.** From outside, a 150 m cylinder seen from eight
metres away fills the screen with an even haze that says nothing about which way
out is. The line says exactly where safety starts.

**Damage ticks once a second, not once a tick.** Thirty events a second would
be arithmetically identical and unreadable: each number would be a thirtieth of
a point, and the feedback pool would turn over completely every second.

**Bots are exempt.** They do not move ([bots.md](bots.md)), so a storm that
damaged them would spend the late phases reciting the same three names into the
kill feed. Nothing in the code stops it — `damageHealthDirectly` takes any
combatant — it is a sandbox decision, and it goes away when bots do.

**The sandbox storm loops.** Nothing ends a sandbox, so when the last circle
closes the night starts over rather than leaving a zero-radius storm quietly
killing whoever is left. `P` pauses it, because a sandbox is also for iterating
on building without a clock running.

### 4.2 The night clock, as rendered

`web/src/gameplay/nightclock.ts` interpolates the keyframes across
`StormDirector.phaseFraction` — how far through *this phase*, which is distinct
from match progress because phases differ in length. The boundary case is the
one that matters and is pinned by a test: the last frame of one phase and the
first frame of the next describe the same sky, or the night flickers six times.

Two rendering decisions the spec does not dictate:

- **The sun never actually goes below the horizon**, whatever the keyframe
  says. A directional light under the ground lights the undersides of
  everything and reads as a rendering bug rather than as night. The elevation
  still drives where shadows point; darkness comes from the keyframe's colour
  and intensity.
- **Ambient does not move at all.** The keyframes take the sun from 1.1 to 0.18
  and back, but the hemisphere light stays where it is, at the Blueprint's
  `minPlayerRimIntensity`. The moment ambient tracks the clock, how well you can
  see another player depends on the hour — which is the stealth mechanic §3
  forbids. Keeping it constant makes that guarantee arithmetic rather than
  aspirational.

What is *not* yet built is the measurement. Driven to phase 3 in a browser, a
bot at 19 m is a legible silhouette against the hillside — but that is a
judgement, made by looking. The 150 m luminance-contrast test in §6 is still
unwritten, and until it exists "readable at every phase" is an intention backed
by a constant rather than a measured property of the rendered frame.

## 5. Blueprint surface

| Blueprint | Governs |
| --- | --- |
| `StormPhaseBlueprint` | Timings, radii, damage, centre bias, rotation clamp |
| `MatchLightingBlueprint` | Per-phase lighting keyframes, sky gradient, sun curve, rim floor |
| `MatchRulesBlueprint` | The ordered phase list |

Retuning the whole storm — a faster mode, a slower one — is editing assets.
Adding an eighth phase is adding a JSON entry.

## 6. Test plan

| Test | Level | Asserts |
| --- | --- | --- |
| Phase continuity | Unit | Each phase's `startRadius` equals the previous `endRadius` — no silent jumps |
| Radius curve | Unit | Monotonic decreasing; exact at wait start and close end |
| Damage tick | Browser | DPS matches; ignores shield; stops on re-entry |
| Rotation clamp | Unit | Randomised survivor spreads; no player exceeds `maxDist` unless the spread is geometrically impossible |
| Clamp failure logging | Unit | The impossible case is detected and reported, not silently accepted |
| Lighting continuity | Browser | No discontinuity in sun elevation or fog across a phase boundary |
| **Visibility floor** | Browser | A character silhouette at 150 m stays above a measured luminance-contrast threshold in every phase, including deep night |
| Total match length | Integration | Sum of phases lands in the 16–18 minute window |
| Per-mode continuity | Unit | Each mode's own list is continuous; two modes may ship different storms |
| Damage tick | Smoke | One point a second outside, in its own colour, stopping on re-entry |
| Night clock continuity | Unit | No jump in sun, fog or elevation across a phase boundary |
| Visibility floor | Unit | The rim floor is constant at every phase and fraction |

The visibility test is the one that keeps pillar 2 honest. It measures rendered
contrast rather than trusting the art.

## 7. Open questions

| Question | Owner | Decide by |
| --- | --- | --- |
| Should `centreBiasToPlayers` scale up in late phases to force fights? | design | M4 |
| Does storm damage break healing, or only interrupt it? | design | M4 |
