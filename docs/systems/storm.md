# System: Storm

**Owner:** design + engineering · **Status:** specified, unimplemented · **Milestone:** M4

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

The visibility test is the one that keeps pillar 2 honest. It measures rendered
contrast rather than trusting the art.

## 7. Open questions

| Question | Owner | Decide by |
| --- | --- | --- |
| Should `centreBiasToPlayers` scale up in late phases to force fights? | design | M4 |
| Does storm damage break healing, or only interrupt it? | design | M4 |
