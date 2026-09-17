# ADR-0001: Blueprint data layer instead of hardcoded content

**Status:** Accepted · **Date:** 2026-09-17 · **Deciders:** engineering, design

## Context

The project brief asks to "prefer Blueprints". Blueprints are an Unreal Engine
feature; the brief also specifies Unity. These are incompatible as stated, so the
decision is what to do about it.

Unreal's Blueprints provide two distinct things:

1. **Visual scripting** — logic as a node graph.
2. **Data-driven content authoring** — a designer creating a new item as an asset
   in the editor, without touching C++ or triggering a recompile.

Of the two, (2) is what actually determines how fast a content-heavy game like a
battle royale can be built. (1) is a means to it. A battle royale lives or dies on
content iteration speed: dozens of weapons, build pieces, loot tables, and storm
configurations, each needing many tuning passes.

Unity's genuine equivalents:

| Unreal | Unity |
| --- | --- |
| Blueprint Class | `ScriptableObject` asset |
| Blueprint Actor | Prefab + Prefab Variant |
| Blueprint graph | Unity Visual Scripting (formerly Bolt) |
| Data Table | `ScriptableObject` collection |

Unity Visual Scripting exists but is a poor fit for the simulation-critical,
allocation-sensitive, server-authoritative paths this game needs. It is a good fit
for designer-owned one-off logic: an ability's effect sequence, a POI's scripted
event.

## Decision

Implement the *intent* of Blueprints as a **data layer**, and call it that
explicitly so the vocabulary carries across.

1. Every piece of game content is a `ScriptableObject` subclass named
   `*Blueprint`, stored under `Assets/Tonight/Blueprints/`.
2. C# systems are **generic over Blueprints**. A system consumes
   `WeaponBlueprint`; it never knows a shotgun exists.
3. Content additions must require **zero C# changes**. This is a milestone exit
   criterion at M2 and M3, not a guideline.
4. Unity Visual Scripting is permitted, scoped to designer-authored ability and
   event graphs referenced *from* a Blueprint field. It is excluded from
   movement, building, netcode, and damage paths.
5. Prefab Variants carry the visual/collision side of a Blueprint; the Blueprint
   asset references its prefab, not the other way round.

## Consequences

**We accept:**

- More upfront engineering. Building a generic weapon system takes longer than
  building a shotgun.
- A validation burden: data-driven content fails at runtime, not compile time.
  Mitigated by `tools/validate_blueprints.py` in CI and `OnValidate` in-Editor.
- An indirection cost when reading code. `weapon.pelletCount` requires opening an
  asset to know it is 8. Mitigated by keeping GDD tables in sync with shipped
  defaults.
- Blueprint fields still need programmer time to add. If designers end up
  routinely blocked on new *fields*, this decision has partly failed — it is
  tracked as a risk in the architecture doc.

**We gain:**

- Content iteration without recompiles — the thing that actually sets project pace.
- Balance changes as asset diffs, reviewable and revertable independently of code.
- A natural MCP surface: an agent creating a `.asset` file is adding real content,
  which is far more tractable than an agent writing correct gameplay C#.
- Testability. A loot table is data, so its distribution can be tested directly.

## Alternatives considered

**Switch the engine to Unreal and use real Blueprints.** Rejected: the brief
specifies Unity, and Unity's C# tooling and headless server story suit a
server-authoritative BR well. The brief's intent is served by this ADR.

**Unity Visual Scripting everywhere.** Rejected: it allocates, it is hard to
diff meaningfully in review, and it does not suit prediction/reconciliation code
where exact determinism between client and server matters.

**Hardcode content in C#, extract data later.** Rejected as the classic trap. The
extraction never happens, and by the time it is painful the content volume makes
it unaffordable.

**Author content in JSON/YAML outside Unity.** Rejected: loses the Inspector,
loses asset references (meshes, prefabs, audio), loses drag-and-drop. The Editor
*is* the content tool; fighting that costs more than it returns.
