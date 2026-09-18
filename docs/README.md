# Tonight — documentation index

Read in this order if you are new.

## 1. What we are building

| Doc | Purpose |
| --- | --- |
| [00-vision.md](00-vision.md) | The pitch, the pillars, and an explicit list of what Tonight is **not**. |
| [01-game-design-document.md](01-game-design-document.md) | The GDD. Match structure, core loop, combat, building, progression. |
| [03-roadmap.md](03-roadmap.md) | Milestones M0–M6, each with hard exit criteria. |

## 2. How we are building it

| Doc | Purpose |
| --- | --- |
| [02-technical-architecture.md](02-technical-architecture.md) | Engine choice, module graph, netcode model, data flow. |
| [blueprints/README.md](blueprints/README.md) | **The Blueprint authoring contract.** Read before writing any gameplay code. |
| [blueprints/schema-reference.md](blueprints/schema-reference.md) | Every Blueprint type, field by field. |
| [adr/](adr/) | Architecture Decision Records — why things are the way they are. |

## 3. System specifications

One document per gameplay system. Each states the design intent, the Blueprint
surface, the server-authoritative rules, and the test plan.

| Doc | System |
| --- | --- |
| [systems/movement.md](systems/movement.md) | Locomotion, sprint, mantle, fall damage |
| [systems/building.md](systems/building.md) | Grid, piece placement, structural integrity, editing |
| [systems/combat.md](systems/combat.md) | Weapons, hitreg, damage, bloom/spread, headshots |
| [systems/bots.md](systems/bots.md) | Stand-in opponents: engage rules, aim, trigger discipline |
| [systems/harvesting.md](systems/harvesting.md) | Resource gathering from world props |
| [systems/loot.md](systems/loot.md) | Rarity, loot tables, chests, floor spawns |
| [systems/storm.md](systems/storm.md) | Zone phases, damage curve, circle placement |
| [systems/inventory.md](systems/inventory.md) | Slots, stacking, pickup/drop rules |
| [systems/netcode.md](systems/netcode.md) | Authority, replication, lag compensation |
| [systems/match-flow.md](systems/match-flow.md) | Lobby → bus → match → victory |

## 4. Content pipeline

| Doc | Purpose |
| --- | --- |
| [pipeline/README.md](pipeline/README.md) | How art gets from a Python generator into the browser. |
| [pipeline/units-and-naming.md](pipeline/units-and-naming.md) | Metric scale, axis conventions, asset prefixes. |
| [pipeline/blender-generators.md](pipeline/blender-generators.md) | Writing a new procedural asset generator. |
| [pipeline/loading-art.md](pipeline/loading-art.md) | How the client finds and loads the generated meshes. |

## 5. MCP operations

| Doc | Purpose |
| --- | --- |
| [mcp/README.md](mcp/README.md) | What Blender MCP is for, and the rule that keeps it optional. |
| [mcp/setup-blender-mcp.md](mcp/setup-blender-mcp.md) | Installing and connecting Blender MCP. |
| [mcp/runbooks.md](mcp/runbooks.md) | Step-by-step agent recipes for common tasks. |
| [mcp/troubleshooting.md](mcp/troubleshooting.md) | When the bridge goes quiet. |

## Documentation rules

- A change to a system's behaviour is not complete until its spec is updated in
  the same commit.
- Specs describe **intent and contract**, not line-by-line implementation. If a
  spec reads like a code listing, it is too detailed.
- Decisions with long-term consequences get an ADR. Superseded ADRs are marked
  `Superseded by ADR-NNNN`, never deleted.
