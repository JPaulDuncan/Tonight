# MCP runbooks

Step-by-step recipes for the repeatable agent tasks in this project.

Each runbook has **preconditions**, **steps**, and a **verification**. The
verification is not optional: agent tool calls against a live Blender are
stateful, and a half-completed runbook leaves the scene in a state nobody
designed.

Every runbook also names its **manual equivalent**, per
[ADR-0005](../adr/0005-mcp-as-build-tooling.md) rule 5. If the bridge is down,
you are not blocked. Most of what follows needs no bridge at all — that is the
guard rail working, not the runbooks being thin.

---

## RB-01 — Add a new weapon

The canonical test of the Blueprint contract. If this runbook ever needs a step
in a `.ts` file, the combat system has regressed.

**Preconditions**
- Blender open and connected, *or* a willingness to run the generator headless.

**Steps**

1. **Define the proportions.** Add a `WeaponProportions` entry in
   `blender/lib/tonight/weapons.py` and append it to `WEAPONS`.
2. **Generate and check.**
   ```bash
   python3 -m pytest blender/tests -q
   python3 blender/scripts/build_all.py -- --dry-run --only weapon
   ```
   The silhouette tests will fail if the new weapon is indistinguishable from an
   existing class by length — that is the test doing its job, not an obstacle.
3. **Export.**
   ```bash
   blender --background --python blender/scripts/build_all.py -- --only weapon
   ```
4. **Add the Blueprint.** Append an entry to `weapons` in `web/data/combat.json`.
   Copy the nearest existing weapon and change the fields: `weaponClass`,
   `damageProfileId`, `fireMode`, `fireRateRpm`, `magazineSize`, `spreadDegrees`.
   Reuse an existing damage and recoil profile unless the weapon genuinely needs
   new numbers — composition over inheritance.
5. **Add to loot.** Add a `LootEntry` with `"kind": "item"` and the new id to the
   right table in `web/data/loot.json`.

**Verification**
```bash
cd web && npm test          # schema + cross-asset checks, in blueprints.test.ts
```
Then `npm run dev` and confirm the weapon appears.

**The real check:** `git diff --stat` shows changes to `.py` and `.json` files —
and **no** `.ts` files. A `.ts` file in this diff means the contract was broken
and the system needs fixing, not the weapon.

**Manual equivalent:** all of it. There is no GUI step left in this runbook,
which is the single clearest improvement the move off Unity bought.

---

## RB-02 — Add a new build piece

**Preconditions**: as RB-01.

**Steps**

1. Add a generator function in `blender/lib/tonight/build_pieces.py`, sized from
   `units.CELL_SIZE` — never a literal `4.0`.
2. Add it to `generate_all()`.
3. Run the tests. The cell-size assertions will catch a piece that does not fit
   the grid, which is the mistake that matters most here.
4. Export.
5. Append a `buildPieces` entry in `web/data/building.json`.
6. Set `placement` and `occupancy` correctly. Ramps and cones must use
   `interior`; walls and floors must use `face`. Validation enforces this, and
   getting it wrong lets two pieces claim one slot.

**Verification**: `npm test` clean, and the piece places on the grid in the
sandbox and interlocks with existing pieces.

**The real check:** no `.ts` files in the diff. This is an M2 exit criterion.

---

## RB-03 — Add an edit variant (doorway, window, …)

**Steps**

1. Add the 3×3 mask constant to `build_pieces.py`, row-major, top-left first.
   Mask index 0 is the **top**-left; getting this inverted produces upside-down
   doorways that look almost right.
2. Add it to the variant loop in `generate_all()`.
3. Generate and export.
4. On the piece in `web/data/building.json`, add an `editVariants` entry with the
   **same** mask. The Python constant and the Blueprint mask are duplicated on
   purpose; validation checks the Blueprint side for length and for duplicate
   masks, since only the first of two identical masks would ever be reachable.

**Verification**: the new shape appears in edit mode; the mask resolves to the
variant rather than reverting.

---

## RB-04 — Retune the storm

Pure content work. No code, no meshes, no Blender.

**Steps**

1. Edit the `stormPhases` array in `web/data/match.json`.
2. Keep radius continuity: each phase's `startRadius` must equal the previous
   phase's `endRadius`. A gap here is a circle that silently teleports.
3. Check the total against the target in the GDD. The validator warns outside
   6–22 minutes.

**Verification**: `cd web && npm test` — the cross-asset continuity check is the
one that matters, and no single entry can perform it.

---

## RB-05 — Regenerate all art after a library change

**Steps**

```bash
python3 -m pytest blender/tests -q                              # 1. tests first
python3 blender/scripts/build_all.py -- --dry-run               # 2. cheap check
git diff blender/exports/manifest.json                          # 3. what changed?
blender --background --python blender/scripts/build_all.py      # 4. real export
```

Step 3 is the point of the manifest. Content hashes show exactly which assets a
generator change actually altered. If a change to the wall generator shows the
weapon hash changing, something is sharing state that should not be — most
likely an RNG stream, which `test_generators_do_not_share_rng_state` exists to
catch.

**Verification**: only the intended assets changed hash. CI fails if the
committed manifest does not match what the generators produce.

---

## RB-06 — Investigate a failing test with an agent

**Steps**

1. Agent: run `cd web && npm test`, or `pytest blender/tests`, via the shell.
2. Agent: read the failure and the relevant source.
3. **Agent proposes a fix; a human reviews before it is applied to gameplay
   code.**

Step 3 is a working agreement rather than a technical constraint. Content fixes
are cheap to review and cheap to revert. Gameplay fixes in the prediction and
netcode paths are neither, and a plausible-looking wrong fix there costs more
than the time it saved.

---

## RB-07 — Bind generated art to the client

Open work, not yet done. The sandbox draws procedural `BoxGeometry` for build
pieces and terrain; the Blender generators produce the real meshes and a
manifest describing them, but nothing loads them yet.

**Preconditions**
- `blender --background --python blender/scripts/build_all.py` has run, so
  `blender/exports/` holds the `.glb` files.

**Steps**

1. Copy `blender/exports/**` into `web/public/art/`, keeping the folder split
   (`Build/`, `Weapons/`, `Harvestables/`, `Terrain/`). `export.WEB_ART_ROOT`
   already names this path.
2. Load them with three.js's `GLTFLoader`, keyed by the manifest's asset names,
   and swap them in behind the existing geometry functions in
   `web/src/render/meshes.ts`.
3. Keep the collision shapes as they are. Collision reads the *grid*, not the
   mesh — see [ADR-0006](../adr/0006-build-grid-quantisation.md) — and binding it to
   art would reintroduce exactly the preview-versus-placement disagreement that
   pillar 1 forbids.

**Verification**

The smoke test (`web/tools/smoke.mjs`) still passes, the pieces still land on
the same cells, and the screenshot it captures shows the new meshes.

**Do not** let the loader fail soft. An asset that silently does not load leaves
an invisible-but-solid wall, which is the worst failure mode this project has.

---

## Writing a new runbook

Add one whenever a task is done twice. The format:

```markdown
## RB-NN — Title
**Preconditions** — what must be running and in what state
**Steps** — numbered, each one tool call or one command
**Verification** — the objective check that it worked
**Manual equivalent** — how to do it without MCP (ADR-0005 rule 5)
```

Keep steps small enough that a failure halfway through leaves an obvious
recovery point.
