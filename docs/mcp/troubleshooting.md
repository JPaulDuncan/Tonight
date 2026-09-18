# MCP troubleshooting

This file exists because bridge failures are expected, not exceptional
([ADR-0005](../adr/0005-mcp-as-build-tooling.md)). Most of them present as "the
tool call did nothing", which is uninformative, so work the table.

## First, the thirty-second check

Before debugging anything specific:

| Check | Blender |
| --- | --- |
| Is the app **running**? | |
| Is the bridge **connected**? | Sidebar (**N**) → BlenderMCP → **Connect** pressed |
| Is **exactly one** MCP client running the server? | |

That last row catches more failures than any other. Two clients contending for
one socket produces partial, intermittent behaviour that looks like a bug in
whatever you were doing at the time.

## Blender

### Tool calls fail or hang

**The addon is enabled but not connected.** Enabling the addon in Preferences
does *not* start its socket server. You must press **Connect to Claude** in the
sidebar, every time Blender restarts.

**Two MCP servers are running.** Close one client. Do not run Cursor and Claude
Desktop against the same Blender.

**Port 9876 is taken.** Check:

```bash
lsof -i :9876          # macOS / Linux
netstat -ano | findstr 9876   # Windows
```

Change the port in both the addon sidebar and `BLENDER_PORT` in
`.mcp.local.json` — both, or they will not find each other.

### `uvx: command not found`

`uv` was installed via `pip install uv`, which may not create `uvx`. Reinstall
from the official installer:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Then confirm `uvx --version` works **in the shell your MCP client launches
from** — a GUI-launched client may not inherit your interactive shell's `PATH`,
which is a classic source of "it works in my terminal".

### The generators work headless but not over MCP

Good: that means the pipeline is fine and only the bridge is broken. Carry on
with the command-line path:

```bash
blender --background --python blender/scripts/build_all.py
```

This is exactly the situation rule 5 exists for.

### An exported asset is rotated or mis-scaled in the client

Something called `bpy.ops.export_scene.gltf` directly instead of
`tonight.blender_adapter.export_gltf()`. That function owns the Blender-Z-up →
glTF-Y-up conversion and the metric scale, and bypassing it is prohibited for
exactly this reason. Find the call and route it through the adapter.

## Web client

The client has no bridge, so nothing here is an MCP failure. It is included
because the symptoms look similar and the first instinct is to blame the bridge.

### A content change did not take effect

**Vite inlines `web/data/*.json` at build time.** In `npm run dev` a save
hot-reloads; in a `npm run preview` of an old build it does not. Rebuild.

**The entry failed validation.** Run `npm test`. `validateLibrary` reports the
id and the field by name, and a single error fails the suite.

**The id is not referenced.** A weapon that exists but is in no loot table is
valid content that never appears. The validator cannot flag this — an unreferenced
blueprint is legal — so check the loot tables.

### Tests pass individually but `blueprints.test.ts` fails

Expected, and by design. That suite performs **cross-asset** checks a single
entry cannot: duplicate ids and rarity tiers, storm phase radius
discontinuities, loot table reference cycles, lighting keyframe coverage,
`maxPlayers % squadSize`. An entry can be individually valid and still wrong in
the context of its peers.

Read the finding; it names the subject id and the field.

## Both

### Everything worked yesterday and nothing works today

In likelihood order:

1. The app was restarted and the bridge was not reconnected (Blender especially
   — the Connect button does not persist).
2. A dependency auto-updated. Check whether `uvx blender-mcp` pulled a new
   version.
3. A second MCP client is running.
4. Blender itself was updated and the addon needs re-enabling.

### How to tell whether the problem is the bridge or the project

Run the manual equivalent. Every runbook names one.

```bash
python3 -m pytest blender/tests -q                            # generator library
python3 blender/scripts/build_all.py -- --dry-run             # generators, no Blender
(cd web && npm test)                                          # Blueprints + simulation
blender --background --python blender/scripts/build_all.py    # full art export
```

If these pass, the project is healthy and you are debugging a bridge. That
distinction is worth establishing early — it is easy to spend an hour fixing a
game that was never broken.

## Reporting a bridge bug

Include: the app version, the bridge package version, the MCP server version,
the exact tool call, and whether the manual equivalent works. That last item
localises the fault immediately and is the one people usually leave out.
