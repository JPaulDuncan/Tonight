# MCP integration

Tonight is driven end to end by agents over MCP: an agent can generate a mesh in
Blender, export it, import it in Unity, create the Blueprint asset, wire the
prefab, and run the tests without a human touching either GUI.

Two servers, two applications, one rule.

## The rule

**MCP is never the only path.** Everything an agent can do over MCP must also be
doable from the command line or the GUI. No build step may *require* a running
Editor with a live bridge.

This is [ADR-0005](../adr/0005-mcp-as-build-tooling.md)'s guard rail, and it
exists because MCP bridges depend on a running GUI application and fail in ways
that are hard to diagnose. A repository that cannot be built without one is a
repository that cannot be built in CI, by a new contributor, or on a bad day.

## The two servers

```
┌──────────────────┐         ┌─────────────────────┐
│  Claude / agent  │◄───────►│  blender-mcp        │  uvx blender-mcp
└──────────────────┘   MCP   │  (Python process)   │
         ▲                   └──────────┬──────────┘
         │                              │ TCP socket, localhost:9876
         │                   ┌──────────▼──────────┐
         │                   │  Blender 4.2+       │  addon must be enabled
         │                   │  "Blender MCP" addon│  AND "Connect" pressed
         │                   └─────────────────────┘
         │
         │                   ┌─────────────────────┐
         └──────────────────►│  unity-mcp server   │  uv run server.py
                       MCP   │  (Python process)   │
                             └──────────┬──────────┘
                                        │ local bridge
                             ┌──────────▼──────────┐
                             │  Unity Editor 6     │  MCPForUnity package
                             │  (project open)     │
                             └─────────────────────┘
```

| | Blender MCP | Unity MCP |
| --- | --- | --- |
| Project | [`ahujasid/blender-mcp`](https://github.com/ahujasid/blender-mcp) | [`CoplayDev/unity-mcp`](https://github.com/CoplayDev/unity-mcp) |
| Launched as | `uvx blender-mcp` | `uv run --directory <server-dir> server.py` |
| App-side piece | A Blender addon serving a socket on **port 9876** | The `MCPForUnity` Unity package |
| Requires | Blender 3.0+ (Tonight targets 4.2+), Python 3.10+ | Unity 2021.3–6.x (Tonight targets 6000.0), Python 3.10+ |
| Typical use here | Generate and tweak meshes, run generator scripts, export | Create scenes and prefabs, author Blueprint assets, run tests |

Both are wired in the repository's [`.mcp.json`](../../.mcp.json), so every
contributor gets the same configuration. Machine-specific overrides belong in
`.mcp.local.json`, which is gitignored.

## Setup

Do these in order — the Unity one takes longest, so start it first if you are
setting up both.

1. [setup-blender-mcp.md](setup-blender-mcp.md)
2. [setup-unity-mcp.md](setup-unity-mcp.md)

Then read [runbooks.md](runbooks.md) for the recipes, and keep
[troubleshooting.md](troubleshooting.md) to hand — you will need it.

## Why runbooks rather than ad-hoc prompting

Every repeatable agent task in this project has a runbook: preconditions, an
ordered sequence of tool calls, and a verification step. The runbook is the
interface.

Two reasons. First, agent tool calls against a live Editor are stateful and
partially irreversible — half a runbook leaves the project in a state nobody
designed. Second, a runbook is just a precise procedure, so it doubles as
documentation a human can follow when the bridge is down.

## What MCP is good at here, and what it is not

Being specific, because "AI does the art" oversells it.

**Good:**

- Creating and wiring Blueprint assets. This is the big one. An agent creating a
  `.asset` file with correct fields is adding real content, and it is exactly
  what [ADR-0001](../adr/0001-blueprint-data-layer.md)'s data layer was shaped to
  make tractable.
- Editing generator *parameters* and re-running a build.
- Scene assembly: placing prefabs, building a POI layout from a spec.
- Running tests and reading back failures.

**Not good:**

- Judging whether art looks right. An agent can confirm a mesh is 4 m wide and
  manifold; it cannot tell you the wall reads as stone.
- Anything needing sustained state across a disconnect.
- Bulk operations. Thousands of tool calls is slower and more fragile than one
  script; write the script and have the agent run it.

That last point is worth repeating: when a task is "do this 500 times", the
right MCP call is the one that runs `build_all.py`.
