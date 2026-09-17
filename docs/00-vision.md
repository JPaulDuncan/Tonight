# Vision

## The pitch

**Tonight** is a 100-player battle royale where the round runs from dusk to dawn.
You land with nothing, harvest the world for materials, build cover faster than
your opponent can shoot through it, and survive a storm that closes in as the
night gets darker. The last player standing sees the sunrise.

The building-under-fire loop is the game. Everything else serves it.

## Design pillars

Four pillars. When a feature conflicts with a pillar, the pillar wins.

### 1. Build-fight is the skill ceiling

The defining expression of mastery is placing structures under pressure. This
demands, in priority order:

- **Sub-frame responsiveness.** A build piece appears the instant the input is
  read, client-predicted, before the server confirms. Perceived build latency
  above ~50 ms makes the game feel broken regardless of the true ping.
- **Legible geometry.** Pieces snap to a strict grid. A player must be able to
  predict exactly where a piece will land without looking at the preview.
- **Destructibility with consequence.** Every structure can be shot down. Cover
  is temporary by design; it buys seconds, not safety.

### 2. The night is a clock, not a gimmick

The match's visual arc — dusk, deep night, false dawn, sunrise — is synchronised
to storm phases. Lighting is a readable timer. A player who glances at the sky
should know roughly how much match is left without opening the UI.

Practically: the storm phase schedule drives a directional-light rig and a sky
gradient, both authored as a single `MatchLightingBlueprint`. Gameplay never
depends on ambient light level (no stealth-in-darkness mechanic) because that
would punish players with poor displays.

### 3. Readable over realistic

Stylised, high-contrast, low-ish poly. This is a pillar rather than an art
preference for three concrete reasons:

- Silhouettes must be identifiable at 150 m on a 1080p display.
- The art must be *generatable* — every asset in this repo comes out of a Python
  script, and scripts make clean geometry, not sculpted realism.
- Low material complexity keeps 100 players + thousands of build pieces inside
  frame budget.

### 4. Server-authoritative, always

The server owns the simulation. Clients predict and reconcile. There is no
gameplay decision a client makes that the server accepts on trust — not damage,
not position, not build placement, not loot rolls.

This costs development speed and it is worth it. A battle royale with a trusted
client has a cheating problem on day one that it never recovers from.

## What Tonight is not

An explicit non-goals list, because scope is the main risk on a project like this.

| Not building | Why |
| --- | --- |
| A live-service content treadmill | No battle pass, no seasons, no shop. The repo is a game, not an operation. |
| A cosmetics economy | No monetisation surface at all. Skins exist only as Blueprint variants for testing the pipeline. |
| Fortnite's *Save the World* PvE | Different game, 10× the scope. |
| Vehicles | Deferred past M6. They interact badly with building and with netcode; they are a sequel feature. |
| Mobile / console ports | PC first. Input abstraction exists so a port is *possible*, not so it is *planned*. |
| Voice chat | Use Discord. Building it means moderation, which means staffing. |
| An anti-cheat product | Server authority + basic sanity checks. No kernel driver, no third-party integration. |
| Photorealistic art | See pillar 3. |
| Recreating Fortnite's map, characters, weapons, or names | Legal non-starter, and creatively pointless. Tonight is its own thing in the same genre. |

## Success criteria

Tonight is a success when:

1. Two players on ordinary home connections (40–90 ms) can build-fight each other
   and neither can point to a moment that felt unfair or unresponsive.
2. A designer can add a new weapon to the game, end to end, in under ten minutes
   without writing code or asking a programmer.
3. `blender --background --python blender/scripts/build_all.py` regenerates every
   art asset in the game from scratch on a clean checkout.
4. A full 100-player match completes on a single 8-core server instance holding
   30 Hz tick with 60+ simultaneous build events per second.

Criterion 2 is the one most projects fail. It is why the Blueprint layer exists.

## Audience and reference points

Players who bounced off the genre's steepest mechanical demands but want the
building loop. The reference frame is the genre's mid-2018 state — before the
mechanic count exploded — plus the night/dawn arc as Tonight's own identity.

## Next

- [01-game-design-document.md](01-game-design-document.md) — the mechanics in detail.
- [02-technical-architecture.md](02-technical-architecture.md) — how it is built.
