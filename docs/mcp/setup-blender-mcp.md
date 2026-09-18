# Setting up Blender MCP

Connects an agent to a running Blender instance, so it can create objects, run
Python, and export.

## What you are installing

Two pieces that are easy to confuse:

1. **The MCP server** — a Python process (`blender-mcp`) that your MCP client
   launches. It speaks MCP to the client and TCP to Blender.
2. **The Blender addon** — runs *inside* Blender and serves a socket on port
   9876.

Both must be running, and the addon must be explicitly connected. Installing one
and forgetting the other is the most common failure.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Blender 4.2 LTS or newer | Tonight's generators target 4.2+. ADR-0004 pins this because operator behaviour can change between releases and would break determinism. |
| Python 3.10+ | |
| `uv` | Install from the official installer, **not** `pip install uv` — the pip route may not create the `uvx` command that MCP clients invoke. |

Install `uv`:

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Verify: `uvx --version` must work in the shell your MCP client launches from.

## Step 1 — install the Blender addon

1. Download `addon.py` from the [blender-mcp repository](https://github.com/ahujasid/blender-mcp).
2. In Blender: **Edit → Preferences → Add-ons → Install…**, select `addon.py`.
3. Tick the checkbox next to **Interface: Blender MCP** to enable it.

## Step 2 — connect from inside Blender

1. Open the 3D viewport sidebar: press **N**.
2. Select the **BlenderMCP** tab.
3. Press **Connect to Claude**.

The sidebar should report that it is listening on port 9876.

**Nothing works until this button is pressed.** The addon does not auto-start
its socket server, so an agent's tool calls against an open Blender with an
enabled-but-unconnected addon fail in a way that looks like a configuration
problem and is not.

## Step 3 — the MCP server

Already wired in the repository's `.mcp.json`:

```json
{
  "mcpServers": {
    "blender": {
      "command": "uvx",
      "args": ["blender-mcp"],
      "env": {
        "BLENDER_HOST": "localhost",
        "BLENDER_PORT": "9876"
      }
    }
  }
}
```

`BLENDER_HOST` and `BLENDER_PORT` override the defaults. Change them only if
9876 is taken; if you do, change it in the addon sidebar too.

## Step 4 — verify

With Blender open and connected, ask the agent to report the current scene
contents. An empty default scene answering at all means the chain works.

Then the real check:

```bash
blender --background --python blender/scripts/build_all.py
```

This needs no MCP at all — it is the command-line path that
[ADR-0005](../adr/0005-mcp-as-build-tooling.md) rule 5 guarantees. If it works
and MCP does not, the problem is the bridge, not the pipeline.

## Important constraints

- **Run only one instance of the MCP server.** Do not have both Cursor and
  Claude Desktop running it against the same Blender; they will contend for the
  socket and produce confusing partial failures.
- **Blender must be open** with the addon connected before any tool call. A
  closed Blender produces an unhelpful error.
- **Agent-driven edits are not the source of truth.** Anything an agent builds
  interactively in Blender is a prototype. Per
  [ADR-0004](../adr/0004-procedural-art-pipeline.md), an asset is only real once
  it is a generator in `blender/scripts/`, and `.blend` files are not committed.
  Prototype in the GUI, then write the generator.

## Next

- [runbooks.md](runbooks.md)
- [troubleshooting.md](troubleshooting.md)
