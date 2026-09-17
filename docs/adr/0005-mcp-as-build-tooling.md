# ADR-0005: MCP servers are first-class build tooling

**Status:** Accepted · **Date:** 2026-09-17 · **Deciders:** engineering

## Context

The brief calls for Unity and Blender to be driven through their respective MCP
servers. MCP lets an agent call tools inside a running application: create a
GameObject, run a Python snippet in Blender, edit a script, run tests.

The question is what role this plays. Two framings:

- **A convenience** — a chat interface bolted onto normal development, nice when
  it works, ignored when it does not.
- **Real tooling** — a supported path that the repository is deliberately shaped
  to accommodate.

The second framing has consequences for how the repo is structured, so it needs
to be an explicit decision rather than a drift.

## Decision

Treat MCP as **first-class build tooling**, and shape the repository so agent
control is practical.

1. `.mcp.json` at the repository root wires both servers, version-controlled so
   every contributor gets the same setup. Machine-specific overrides go in
   `.mcp.local.json`, which is gitignored.
2. **Blender MCP** (`ahujasid/blender-mcp`) — the addon runs a socket server
   inside Blender on port 9876; the `blender-mcp` package is the MCP server the
   client launches and which relays into that socket.
3. **Unity MCP** (`CoplayDev/unity-mcp`) — a Unity package bridge plus a local
   Python server, giving scene, asset, script, and test-running tools.
4. Every repeatable agent task gets a **runbook** in `docs/mcp/runbooks.md`:
   preconditions, ordered tool calls, verification step. Runbooks are the
   interface, not ad-hoc prompting.
5. **MCP is never the only path.** Everything an agent can do via MCP must also
   be doable from the command line or the GUI. No build step may *require* a
   running Editor with a live bridge.

Rule 5 is the guard rail. MCP bridges depend on a running GUI application and
fail in ways that are hard to diagnose; a repository that cannot be built without
one is a repository that cannot be built in CI, by a new contributor, or on a
bad day.

## Consequences

**We accept:**

- Setup burden. Two servers, two apps that must be running and connected, and a
  `uv` dependency. Documented across three setup guides in `docs/mcp/`.
- Fragility. Bridges disconnect. Tool calls fail unhelpfully when the app is
  closed. `docs/mcp/troubleshooting.md` exists because this is expected, not
  exceptional.
- Version coupling to two third-party projects that move quickly. Versions are
  pinned in the setup docs and updated deliberately.
- Maintaining runbooks alongside the code they drive.

**We gain:**

- An agent can take a task end to end: generate a mesh in Blender, export it,
  import it in Unity, create the Blueprint asset, wire the prefab, run the tests.
- Runbooks double as human documentation — they are just precise procedures.
- The rule-5 constraint keeps the project buildable without any of this, which is
  worth having on its own merits.

## Alternatives considered

**GUI-only, no MCP.** Rejected: the brief asks for MCP, and it forfeits the
agent-driven-content goal that the Blueprint layer (ADR-0001) and procedural art
(ADR-0004) are both shaped around.

**MCP as the required build path.** Rejected on rule 5's reasoning. A build that
requires a live GUI bridge cannot run in CI and cannot be reproduced by a
contributor who has not set up the bridge.

**Write a bespoke MCP server for Tonight.** Rejected for now as unnecessary: the
existing servers cover scene, asset, script, and mesh operations. Revisit if
project-specific operations (e.g. "validate every Blueprint and report") become
frequent enough to deserve first-class tools — that would be a new ADR.
