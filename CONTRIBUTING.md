# Contributing to Tonight

## The one rule

**Content goes in Blueprints, not C#.**

Adding a weapon, a build piece, a loot entry, a storm phase, or a rarity tier
must be doable by creating a `ScriptableObject` asset in the Unity Editor. If a
pull request adds content *and* touches a `.cs` file, that is the thing to
discuss in review before anything else.

The full contract is in [docs/blueprints/README.md](docs/blueprints/README.md),
and the reasoning is in
[ADR-0001](docs/adr/0001-blueprint-data-layer.md).

Note for anyone arriving from the Unreal world: Unity has no Blueprints. Tonight
implements the *idea* — designer-authored data assets rather than hardcoded
content — and keeps the vocabulary.

## Before you start

```bash
python3 -m pip install -r tools/requirements.txt
python3 -m pytest blender/tests tools/tests -q     # should be all green
python3 tools/validate_blueprints.py
```

Reading order for a new contributor:

1. [docs/00-vision.md](docs/00-vision.md) — what this is, and the explicit
   non-goals.
2. [docs/02-technical-architecture.md](docs/02-technical-architecture.md) — how
   it is built.
3. [docs/blueprints/README.md](docs/blueprints/README.md) — the authoring
   contract.
4. The spec for whatever system you are touching, in
   [docs/systems/](docs/systems/).

## What a good change looks like

| Change | What it touches |
| --- | --- |
| New weapon | `weapons.py` + a `.asset` + an FBX. **No `.cs`.** |
| New build piece | `build_pieces.py` + a `.asset` + an FBX. **No `.cs`.** |
| Balance pass | `.asset` files only |
| New edit shape | A mask constant + a mesh + an `EditVariant` entry |
| New Blueprint *field* | `.cs` + schema-reference.md + a validation test |
| New system | `.cs` + a spec in `docs/systems/` + tests |

The first four needing no C# is the project working as designed. The last two
needing C# is expected — new systems always do. The rule is that once a system
exists, *variants* of it must not need code.

## Code standards

### C#

- **No allocation in steady state.** No LINQ in per-frame paths, no `foreach`
  over interfaces in hot loops, pooled events and previews.
- **No content in code.** No `switch` on a Blueprint id, no enum listing
  weapons. If you are writing `if (weapon.name == ...)`, the answer is a
  Blueprint field.
- **Simulation reads neither input nor `Time.deltaTime`.** Both arrive in a
  command ([ADR-0003](docs/adr/0003-defer-networking-to-m4.md)). This is what
  makes reconciliation replay exact at M4, and it is far cheaper to maintain now
  than to retrofit later.
- **Validation is separate from application.** `Validate(state)` is pure; the
  server calls the identical method the client predicted with.
- **Assembly boundaries are real.** Runtime assemblies never reference
  `Tonight.Editor`. The `.asmdef` graph enforces this as a compile error.

### Python

- **`blender/lib/tonight/` must import without `bpy`.** Only
  `tonight.blender_adapter` may import it.
- **Generators are deterministic.** Every random draw from
  `tonight.rng.seeded()`. Never module-level `random`, never `hash()`.
- **Dimensions come from `tonight.units`**, never literals.
- Type hints on public functions. Docstrings explaining *why*, not *what*.

## Testing

| You changed | You must run |
| --- | --- |
| `blender/lib/` | `pytest blender/tests -q` |
| `tools/` | `pytest tools/tests -q` |
| A generator | the above, plus `build_all.py -- --dry-run`, and commit the manifest |
| C# | Unity EditMode tests |
| A Blueprint asset | `tools/validate_blueprints.py` and `Tonight → Blueprints → Validate All` |

Prefer asserting properties over exact values. "A wall spans exactly one cell"
survives a refactor; "vertex 7 is at (2, 0.1, 4)" does not, and a test that
breaks on every harmless change stops being read.

Two deliberate exceptions where an exact value is correct: the content-hash
regression tests, which are hard-coded so they cannot be self-fulfilling, and
the loot distribution tests, which must be statistical because a weighted table
that is subtly wrong still produces individually plausible rolls.

## Documentation

**A behaviour change is not complete until its spec is updated in the same
commit.** Specs live in `docs/systems/`, one per system.

Decisions with long-term consequences get an ADR. ADRs are immutable once
accepted — if a decision changes, write a new one and mark the old
`Superseded by ADR-NNNN`. Never delete one; the reasoning is the point.

## Commits and pull requests

- Present tense, imperative subject: "Add structural integrity cascade".
- Explain **why** in the body. The diff shows what.
- One logical change per commit.
- If you found and fixed an unrelated bug along the way, say so explicitly —
  reviewers should not have to discover it.

## Working with agents

This project is designed to be driven by agents over MCP
([ADR-0005](docs/adr/0005-mcp-as-build-tooling.md)). Three working agreements:

- **Follow the runbooks** in [docs/mcp/runbooks.md](docs/mcp/runbooks.md).
  Ad-hoc prompting against a live Editor leaves state nobody designed.
- **Prefer asset authoring over code authoring.** An agent creating a
  `WeaponBlueprint` is doing verifiable work. An agent writing prediction code
  is not, and a plausible-looking wrong fix in the netcode path costs more than
  the time it saved.
- **Review the diff.** Agent-authored `.asset` files are YAML and read perfectly
  well in a pull request. Read them.

## Scope

Check [docs/00-vision.md](docs/00-vision.md) §"What Tonight is not" before
proposing a feature. Vehicles, mobile, console, voice chat, cosmetics economy,
and progression systems are all deliberate non-goals, not oversights.

If you think a non-goal is wrong, the way to change it is an ADR arguing the
case — not a pull request implementing it.
