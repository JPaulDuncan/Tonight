# ADR-0007: three.js and TypeScript instead of Unity

**Status:** Accepted · **Date:** 2026-09-18 · **Deciders:** engineering
**Supersedes:** the engine choice in [ADR-0001](0001-blueprint-data-layer.md)
and the netcode stack in [ADR-0002](0002-netcode-stack.md)

## Context

The Unity implementation reached a state that looked complete and was not:
~11,500 lines of C#, 215 EditMode tests, 57 Blueprint assets, all of it
**never compiled**. The project had no Unity licence and no Editor, so nothing
could be built, nothing could be run, and none of the tests could execute.

That is a worse position than having less code. Untested code that *looks*
tested invites false confidence, and the longer it grows the more expensive the
first compile becomes. Two concrete bugs make the point:

- `BuildStructure.refreshNeighbourhood` seeded its work queue with a node whose
  value the caller had just computed, so the improvement check short-circuited
  immediately and support never propagated. Rebuilding a leg under an orphaned
  stack failed to rescue it. **A test for exactly this existed and never ran.**
- Build range was measured from the player's feet to a cell's centre while
  placement resolution capped the aim point at 10 m from the eye. The two
  disagree by up to half a cell diagonal, so the preview ghost showed positions
  that placement rejected — the failure vision pillar 1 forbids by name.

Neither is exotic. Both were found within minutes of the code being able to run.

## Decision

Rebuild the client in **TypeScript with three.js**, and delete the Unity
project.

1. `web/` holds the whole game: Vite, TypeScript in strict mode, vitest.
2. The simulation stays engine-independent. `web/src/gameplay` imports no
   three.js at all, so it runs in Node for tests and will run on a server
   unchanged. Only `web/src/render` touches the renderer or the DOM.
3. Blueprints become plain JSON in `web/data/`, loaded and validated at boot.
4. The Unity project is removed rather than kept alongside. Git history
   preserves it; a dead un-compilable port sitting beside a live one rots and
   confuses contributors.

**What does not change:** the design. The GDD, the pillars, the system specs,
the Blueprint authoring contract, and the Blender art pipeline all carry over
essentially untouched, which is the strongest evidence that the documentation
layer was worth writing engine-independently in the first place.

## Consequences

**We gain:**

- Code that runs. 150 tests execute in under a second, and the sandbox is
  playable in a browser with no install.
- A far better Blueprint story than ScriptableObjects gave us. JSON is diffable
  in review, needs no `.meta` sidecar, has no GUID identity to break on rename,
  and needs no generator step: a designer edits the file and it is in the game.
  The 233 generated Unity meta and asset files are gone entirely.
- Distribution by URL. No launcher, no download, no store.
- A single language across client, server and tools.

**We accept:**

- **Rendering at scale is harder than in Unity.** This is the real cost. Unity's
  batching, LOD and culling are mature; in three.js they are ours to build. A
  late-game fight with thousands of build pieces will need instanced rendering
  and aggressive culling that Unity would have given us. This is the top
  technical risk in the project and is why the player count was rescoped.
- No Editor. Scene authoring is code or data, not a viewport. For a
  procedurally generated map this is close to neutral, and for hand-placed set
  dressing it is a real loss.
- No physics engine. The collision layer is bespoke — exact for axis-aligned
  build pieces on a known grid, and deliberately limited beyond that.
- Netcode is ours to write. ADR-0002's Netcode for GameObjects is gone;
  the 9-byte structure channel it specified survives as a design, since it was
  never engine-specific.
- Losing Unity's audio, animation and particle systems.

## Alternatives considered

**Get a Unity licence and keep going.** The honest alternative, and it would
have worked. Rejected because it does not remove the underlying problem for
*this* project: the build could not be verified in the environment the work
happens in, so the feedback loop stays broken and bugs keep accumulating
unseen.

**Keep both ports.** Rejected: two implementations of every system, one of
which cannot be compiled, is strictly worse than one that can.

**Babylon.js instead of three.js.** Closer to an engine, with a built-in physics
layer and scene inspector. Genuinely competitive. three.js was chosen for its
smaller API surface and because the simulation needs almost nothing from the
renderer — the collision layer here is grid-exact and would not have used a
general physics engine anyway.

**Keep Unity for the client, port only the simulation.** Rejected: it keeps
every cost of the Unity dependency while adding a language boundary.
