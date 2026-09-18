# Contributing to Tonight

## The one rule

**Content goes in JSON, not TypeScript.**

Adding a weapon, a build piece, a loot entry, a storm phase, or a rarity tier
must be doable by editing `web/data/*.json`. If a pull request adds content
*and* touches a `.ts` file, that is the thing to discuss in review before
anything else.

The full contract is in [docs/blueprints/README.md](docs/blueprints/README.md),
and the reasoning is in
[ADR-0001](docs/adr/0001-blueprint-data-layer.md).

Note for anyone arriving from the Unreal world: neither Unity nor three.js has
Blueprints. Tonight implements the *idea* — designer-authored data rather than
hardcoded content — and keeps the vocabulary.

## Before you start

```bash
cd web && npm install
npm run verify        # typecheck + 248 tests + production build
npm run dev           # the playable sandbox

cd ..
python3 -m pip install -r tools/requirements.txt
python3 -m pytest blender/tests -q                 # 304 art tests
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
| New weapon | `weapons.py` + a JSON entry + a mesh. **No `.ts`.** |
| New build piece | `build_pieces.py` + a JSON entry + a mesh. **No `.ts`.** |
| Balance pass | JSON only |
| New edit shape | A mask constant + a mesh + an `editVariants` entry |
| New Blueprint *field* | `types.ts` + schema-reference.md + a validation test |
| New system | `.ts` + a spec in `docs/systems/` + tests |

The first four needing no TypeScript is the project working as designed. The
last two needing TypeScript is expected — new systems always do. The rule is
that once a system
exists, *variants* of it must not need code.

## Code standards

### TypeScript

- **The simulation never imports the renderer.** `src/gameplay` may not import
  `three` or touch the DOM. This is the load-bearing rule: it is what keeps the
  tests headless and the server possible.
- **No allocation in hot paths.** No array churn per frame in the simulation.
- **No content in code.** No `switch` on a Blueprint id, no union listing
  weapons. If you are writing `if (weapon.id === "weapon.shotgun")`, the answer
  is a Blueprint field.
- **Simulation reads neither input nor `Time.deltaTime`.** Both arrive in a
  command ([ADR-0003](docs/adr/0003-defer-networking-to-m4.md)). This is what
  makes reconciliation replay exact at M4, and it is far cheaper to maintain now
  than to retrofit later.
- **Validation is separate from application.** `Validate(state)` is pure; the
  server calls the identical method the client predicted with.
- **Strict mode is not negotiable.** `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` are on; do not weaken them to make code compile.

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
| Anything in `web/src` | `npm run verify` |
| Anything in `web/src/render` | also `npm run smoke` — the browser catches what unit tests cannot |
| `web/data/*.json` | `npm test` (the validator runs there) |
| `blender/lib/` | `pytest blender/tests -q` |
| A generator | the above, plus `python3 blender/scripts/build_all.py`, and commit the manifest |

Prefer asserting properties over exact values. "A wall spans exactly one cell"
survives a refactor; "vertex 7 is at (2, 0.1, 4)" does not, and a test that
breaks on every harmless change stops being read.

Two deliberate exceptions where an exact value is correct: the content-hash
regression tests, which are hard-coded so they cannot be self-fulfilling, and
the loot distribution tests, which must be statistical because a weighted table
that is subtly wrong still produces individually plausible rolls.

**If CI cannot run it, it is not done.** That rule came out of spending a phase
on a Unity codebase that never compiled, carrying two real bugs and a test for
one of them that never ran. See
[ADR-0007](docs/adr/0007-threejs-instead-of-unity.md).

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
- **Prefer data authoring over code authoring.** An agent adding a weapon to
  `combat.json` is doing verifiable work. An agent writing prediction code is
  not, and a plausible-looking wrong fix in the netcode path costs more than the
  time it saved.
- **Review the diff.** Agent-authored JSON reads perfectly well in a pull
  request. Read it.

## Scope

Check [docs/00-vision.md](docs/00-vision.md) §"What Tonight is not" before
proposing a feature. Vehicles, mobile, console, voice chat, cosmetics economy,
and progression systems are all deliberate non-goals, not oversights.

If you think a non-goal is wrong, the way to change it is an ADR arguing the
case — not a pull request implementing it.
