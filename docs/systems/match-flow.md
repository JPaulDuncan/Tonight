# System: Match flow

**Owner:** engineering · **Status:** specified, unimplemented · **Milestone:** M4

## 1. States

```
                ┌──────────┐
                │ Frontend │
                └────┬─────┘
                     │ queue
                ┌────▼─────┐
                │  Lobby   │ ← fills to MaxPlayers, or 90 s timeout
                └────┬─────┘
                     │ all loaded
                ┌────▼─────┐
                │   Bus    │ ← BusSeconds along a random chord
                └────┬─────┘
                     │ eject (voluntary, or forced at path end)
                ┌────▼─────┐
                │ Freefall │ ← skydive, glider auto-deploys at 35 m AGL
                └────┬─────┘
                     │ land
                ┌────▼─────┐
                │  Match   │ ← storm phases 0..7
                └────┬─────┘
                     │ one squad remains
                ┌────▼─────┐
                │ Victory  │ → Frontend
                └──────────┘
```

Every transition is server-driven. A client can request `eject`; it cannot
request `Victory`.

## 2. Lobby

- Fills to `MatchRulesBlueprint.MaxPlayers`, or starts at 90 s with whoever is
  present, down to a floor of 2.
- Players spawn on a pre-match island with weapons that do no damage, so people
  can warm up on build mechanics while waiting.
- The match seed is generated here and broadcast, so loot spawns and the bus path
  are reproducible for debugging.

## 3. Bus

A straight chord across the map at a random angle through a random offset from
centre, seeded from `MapBlueprint.BusPathSeed` (0 = random per match).

Ejection is voluntary at any point along the path, and forced at the end. The
path is drawn on the map for every player, because a hidden bus path makes
landing a guess instead of a decision.

## 4. Freefall

Covered in [movement.md](movement.md) §6. The glider deploys automatically on
altitude, so landing is a rotation decision rather than an execution test.

## 5. Match

Storm phases drive everything — see [storm.md](storm.md). The match ends when one
squad (or player, in solo) remains alive.

Elimination order is recorded for the results screen. In squad modes, a squad is
eliminated when its last living member is eliminated, which also finishes off any
DBNO squadmates.

## 6. Reconnection

A disconnected player's character **remains in the world** for 90 s, standing
still and vulnerable. Reconnecting restores control, including a chunked full
structure snapshot ([netcode.md](netcode.md) §4.2).

Leaving the body in the world is deliberate: removing it would make disconnecting
a way to escape a lost fight.

## 7. Blueprint surface

`MatchRulesBlueprint` governs squad size, player count, DBNO, bus duration,
glider altitude, starting loadout, friendly fire, and the storm phase list.

Solo, Duos, and Squads are **three assets**, not three code paths.

## 8. Test plan

| Test | Level | Asserts |
| --- | --- | --- |
| State machine | EditMode | Every legal transition; illegal ones rejected |
| Lobby timeout | Integration | Starts at 90 s with a partial lobby |
| Seed reproducibility | Integration | Same seed ⇒ same bus path and loot spawns |
| Forced ejection | PlayMode | Every remaining player ejects at path end |
| Squad elimination | PlayMode (M5) | Last member's death eliminates DBNO squadmates |
| Reconnect | Integration | Within 90 s restores control and world state; after 90 s does not |
| Full match | Integration, M5 gate | 18 minutes end to end, no desync, no server error |
