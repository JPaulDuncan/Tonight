# MCP troubleshooting

This file exists because bridge failures are expected, not exceptional
([ADR-0005](../adr/0005-mcp-as-build-tooling.md)). Most of them present as "the
tool call did nothing", which is uninformative, so work the table.

## First, the thirty-second check

Before debugging anything specific:

| | Blender | Unity |
| --- | --- | --- |
| Is the app **running**? | | |
| Is the project/file **open**? | | Editor on `unity/Tonight/` |
| Is the bridge **connected**? | Sidebar (**N**) → BlenderMCP → **Connect** pressed | **Window → MCP for Unity** reports connected |
| Is **exactly one** MCP client running the server? | | |

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

### An exported asset is rotated or mis-scaled in Unity

Something called `bpy.ops.export_scene.fbx` directly instead of
`tonight.export.export_fbx()`. That function owns the Blender-Z-up →
Unity-Y-up conversion and the metric scale, and bypassing it is prohibited for
exactly this reason. Find the call and route it through the adapter.

## Unity

### The bridge does not connect

**The project is still importing.** First import takes several minutes; the
bridge cannot attach until it finishes.

**Compile errors.** The bridge needs a successfully compiled project. Check the
Console — a single script error blocks it, and the resulting symptom (silence)
does not suggest that cause.

**Version mismatch** between the `MCPForUnity` package and the Python server.
Both must come from the same release. This is why the setup guide pins a tag
rather than tracking `#main`.

### `UNITY_MCP_SERVER_DIR` is not set

Point it at the `UnityMcpServer/src` directory from the package installation.
**Window → MCP for Unity** reports the path. Put the override in
`.mcp.local.json`, not `.mcp.json` — the latter is shared, and a machine-specific
path there breaks it for everyone else.

### An agent's asset change did not take effect

**The registry is stale.** Run `Tonight → Blueprints → Rebuild Registry`
(Ctrl/Cmd + Shift + B). Lookup is by `BlueprintId` through the registry, so a
new asset that is not in it is invisible at runtime.

**The asset failed validation.** Check the Console for errors from `OnValidate`,
or run `Tonight → Blueprints → Validate All`.

**Unity has not reimported.** Focus the Editor window; Unity reimports on regain
focus. An agent writing files while the Editor is unfocused is a common way to
get a confusing lag between "the file changed" and "the game changed".

### Tests pass in the Editor but `validate_blueprints.py` fails

Expected, and by design. The Python validator performs **cross-asset** checks a
single asset cannot: duplicate rarity tiers, storm phase radius discontinuities,
loot table reference cycles, per-material mesh coverage. An asset can be
individually valid and still wrong in the context of its peers.

Read the validator's output; it names the assets involved.

## Both

### Everything worked yesterday and nothing works today

In likelihood order:

1. The app was restarted and the bridge was not reconnected (Blender especially
   — the Connect button does not persist).
2. A dependency auto-updated. Check whether `uvx blender-mcp` pulled a new
   version, or whether the Unity package tracked a moving ref.
3. A second MCP client is running.
4. The project has a compile error from an unrelated change.

### How to tell whether the problem is the bridge or the project

Run the manual equivalent. Every runbook names one.

```bash
python3 -m pytest blender/tests -q                            # generator library
python3 blender/scripts/build_all.py -- --dry-run             # generators, no Blender
python3 tools/validate_blueprints.py                          # Blueprints, no Unity
blender --background --python blender/scripts/build_all.py    # full art export
```

If these pass, the project is healthy and you are debugging a bridge. That
distinction is worth establishing early — it is easy to spend an hour fixing a
game that was never broken.

## Reporting a bridge bug

Include: the app version, the bridge package version, the MCP server version,
the exact tool call, and whether the manual equivalent works. That last item
localises the fault immediately and is the one people usually leave out.
