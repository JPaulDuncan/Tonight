# MCP integration

Tonight's art pipeline is driven by an agent over MCP: an agent can generate a
mesh in Blender, check it, export it to glTF, and refresh the manifest without a
human touching the GUI.

One server, one application, one rule.

## The rule

**MCP is never the only path.** Everything an agent can do over MCP must also be
doable from the command line or the GUI. No build step may *require* a running
application with a live bridge.

This is [ADR-0005](../adr/0005-mcp-as-build-tooling.md)'s guard rail, and it
exists because MCP bridges depend on a running GUI application and fail in ways
that are hard to diagnose. A repository that cannot be built without one is a
repository that cannot be built in CI, by a new contributor, or on a bad day.

The guard rail has already paid: `blender/lib/tonight/` is `bpy`-free, so the
generator tests and the full dry-run build pass in CI with no Blender installed
and no bridge at all.

## The server

```
┌──────────────────┐         ┌─────────────────────┐
│  Claude / agent  │◄───────►│  blender-mcp        │  uvx blender-mcp
└──────────────────┘   MCP   │  (Python process)   │
                             └──────────┬──────────┘
                                        │ TCP socket, localhost:9876
                             ┌──────────▼──────────┐
                             │  Blender 4.2+       │  addon must be enabled
                             │  "Blender MCP" addon│  AND "Connect" pressed
                             └─────────────────────┘
```

| | Blender MCP |
| --- | --- |
| Project | [`ahujasid/blender-mcp`](https://github.com/ahujasid/blender-mcp) |
| Launched as | `uvx blender-mcp` |
| App-side piece | A Blender addon serving a socket on **port 9876** |
| Requires | Blender 3.0+ (Tonight targets 4.2+), Python 3.10+ |
| Typical use here | Generate and tweak meshes, run generator scripts, export |

It is wired in the repository's [`.mcp.json`](../../.mcp.json), so every
contributor gets the same configuration. Machine-specific overrides belong in
`.mcp.local.json`, which is gitignored.

### There used to be two

The Unity MCP server was the other half of this page. It went when the Unity
project did ([ADR-0007](../adr/0007-threejs-instead-of-unity.md)). Nothing
replaced it: the web client has no GUI editor to bridge to, and it does not need
one — content is JSON a text editor can open, and the game is a `npm run dev`
away. That is a simplification, not a loss.

## Setup

1. [setup-blender-mcp.md](setup-blender-mcp.md)

Then read [runbooks.md](runbooks.md) for the recipes, and keep
[troubleshooting.md](troubleshooting.md) to hand — you will need it.

## Why runbooks rather than ad-hoc prompting

Every repeatable agent task in this project has a runbook: preconditions, an
ordered sequence of tool calls, and a verification step. The runbook is the
interface.

Two reasons. First, agent tool calls against a live application are stateful and
partially irreversible — half a runbook leaves the scene in a state nobody
designed. Second, a runbook is just a precise procedure, so it doubles as
documentation a human can follow when the bridge is down.

## What MCP is good at here, and what it is not

Being specific, because "AI does the art" oversells it.

**Good:**

- Editing generator *parameters* and re-running a build, then looking at the
  result in the viewport.
- Prototyping a shape interactively before committing it as a generator.
- Reading back what actually exists in the scene, which is how you catch a
  generator that silently produced nothing.

**Not good:**

- Judging whether art looks right. An agent can confirm a mesh is 4 m wide and
  manifold; it cannot tell you the wall reads as stone.
- Anything needing sustained state across a disconnect.
- Bulk operations. Thousands of tool calls is slower and more fragile than one
  script; write the script and have the agent run it.

That last point is worth repeating: when a task is "do this 500 times", the
right MCP call is the one that runs `build_all.py`.

**And not needed at all:** authoring content. Blueprints are JSON
(`web/data/*.json`) — an agent edits them with an ordinary file write, and
`npm test` validates the result. That was the single biggest MCP use case in the
Unity design, and the move to JSON deleted the need for it rather than
automating it.
