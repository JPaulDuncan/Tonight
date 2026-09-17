# Setting up Unity MCP

Connects an agent to a running Unity Editor, so it can create scenes and
GameObjects, author assets, edit scripts, and run tests.

## What you are installing

1. **The Unity package** (`MCPForUnity`) — the bridge, installed into the
   project.
2. **The MCP server** — a local Python process your MCP client launches, which
   talks to the bridge.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Unity 6000.0 LTS | Pinned in `unity/Tonight/ProjectSettings/ProjectVersion.txt`. The package supports 2021.3–6.x; Tonight targets 6. |
| Python 3.10+ with `uv` | Same `uv` as the Blender setup — install once. |
| The project opened at least once | Package resolution and the first import take several minutes. Do this before you need the bridge. |

## Step 1 — install the Unity package

**Package Manager → Add package from git URL:**

```
https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#v10.0.0
```

Pin the tag. Tracking `#main` means the bridge can change under you mid-session,
and a bridge version mismatch presents as tool calls that silently do nothing.

Alternatively, via OpenUPM:

```bash
openupm add com.coplaydev.unity-mcp
```

Commit the resulting `Packages/manifest.json` change. An unpinned dependency is
how two contributors end up on different bridge versions and spend a day
debugging a difference that is not in the game at all.

## Step 2 — the MCP server

The repository's `.mcp.json` expects the server directory in an environment
variable, because its location depends on how you installed the package:

```json
{
  "mcpServers": {
    "unity": {
      "command": "uv",
      "args": ["run", "--directory", "${UNITY_MCP_SERVER_DIR}", "server.py"],
      "env": {
        "UNITY_PROJECT_PATH": "${workspaceFolder}/unity/Tonight"
      }
    }
  }
}
```

Set `UNITY_MCP_SERVER_DIR` to the `UnityMcpServer/src` directory from the
package installation. The package's own setup window (**Window → MCP for Unity**)
reports the path and can write a client configuration for you.

If your setup differs from the repository default, override it in
`.mcp.local.json` rather than editing `.mcp.json` — the local file is gitignored
precisely so machine-specific paths do not land in everyone else's checkout.

## Step 3 — verify

1. Open `unity/Tonight/` in the Editor and wait for the import to finish.
2. Open **Window → MCP for Unity** and confirm the bridge reports connected.
3. Ask the agent to list the scenes in the project.

Then the real check — the command-line path that does not need MCP:

```bash
# Registry rebuild and validation, from inside the Editor
#   Tonight > Blueprints > Rebuild Registry   (Ctrl/Cmd + Shift + B)
#   Tonight > Blueprints > Validate All       (Ctrl/Cmd + Shift + V)

# Blueprint validation without the Editor at all
python3 tools/validate_blueprints.py
```

## Working agreements

These are not the tool's rules; they are Tonight's, and they exist because an
agent with Editor access can do a lot of damage quickly.

- **Never let an agent edit a `.meta` file directly.** A `.meta` file is part of
  its asset. Regenerating a GUID for an already-referenced asset silently breaks
  every reference to it, and the breakage surfaces much later.
- **Never let an agent delete an asset without deleting its `.meta`**, or the
  reverse.
- **Prefer creating Blueprint assets over editing C#.** That is the whole point
  of [ADR-0001](../adr/0001-blueprint-data-layer.md): an agent authoring a
  `WeaponBlueprint` is doing tractable, verifiable work; an agent writing
  server-authoritative prediction code is not.
- **Run the EditMode tests after any agent-driven change.** They are fast, and
  they are the cheapest way to catch a Blueprint wired up wrongly.
- **Review the diff.** Agent-authored `.asset` files are YAML and read perfectly
  well in a pull request. Read them.

## Next

- [runbooks.md](runbooks.md)
- [troubleshooting.md](troubleshooting.md)
