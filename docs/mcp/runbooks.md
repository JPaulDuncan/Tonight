# MCP runbooks

Step-by-step recipes for the repeatable agent tasks in this project.

Each runbook has **preconditions**, **steps**, and a **verification**. The
verification is not optional: agent tool calls against a live Editor are
stateful, and a half-completed runbook leaves the project in a state nobody
designed.

Every runbook also names its **manual equivalent**, per
[ADR-0005](../adr/0005-mcp-as-build-tooling.md) rule 5. If the bridge is down,
you are not blocked.

---

## RB-01 — Add a new weapon

The canonical test of the Blueprint contract. If this runbook ever needs a C#
step, the combat system has regressed.

**Preconditions**
- Unity Editor open on `unity/Tonight/`, bridge connected.
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
4. **Import.** Copy or symlink the FBX from `blender/exports/Weapons/` into
   `unity/Tonight/Assets/Tonight/Art/Weapons/`. Let Unity import it.
5. **Create the prefab.** Agent: create a prefab `PF_Weapon_<Name>` with the
   mesh, a `MeshRenderer`, and a muzzle transform.
6. **Create the Blueprint.** Agent: create a `WeaponBlueprint` asset at
   `Assets/Tonight/Blueprints/Combat/Weapons/BP_Weapon_<Name>.asset`. Fill in
   class, prefab, damage profile, fire mode, rate, magazine, spread.
   Reuse an existing `DamageProfileBlueprint` unless the weapon genuinely needs
   new numbers — composition over inheritance.
7. **Add to loot.** Agent: add a `LootEntry` referencing the new Blueprint to
   the appropriate `LootTableBlueprint`.
8. **Rebuild the registry.** `Tonight → Blueprints → Rebuild Registry`.

**Verification**
```bash
python3 tools/validate_blueprints.py     # schema + cross-asset checks
```
Then in the Editor: `Tonight → Blueprints → Validate All`, run the EditMode
tests, and confirm the weapon appears in the practice range.

**The real check:** `git diff --stat` shows changes to `.py`, `.asset`, and
`.fbx` files — and **no** `.cs` files. A `.cs` file in this diff means the
contract was broken and the system needs fixing, not the weapon.

**Manual equivalent:** every step above is a normal Editor operation.

---

## RB-02 — Add a new build piece

**Preconditions**: as RB-01.

**Steps**

1. Add a generator function in `blender/lib/tonight/build_pieces.py`, sized from
   `units.CELL_SIZE` — never a literal `4.0`.
2. Add it to `generate_all()`.
3. Run the tests. The cell-size assertions will catch a piece that does not fit
   the grid, which is the mistake that matters most here.
4. Export, import, create the prefab.
5. Create a `BuildPieceBlueprint` with a `MeshByMaterial` entry **for every
   build material** — validation fails on partial coverage.
6. Set `Placement` and `Occupancy` correctly. Ramps and cones must use
   `Interior`; walls and floors must use `Face`. Validation enforces this.
7. Rebuild the registry.

**Verification**: validators clean, EditMode tests pass, the piece places on the
grid in the practice range and interlocks with existing pieces.

**The real check:** no `.cs` files in the diff. This is an M2 exit criterion.

---

## RB-03 — Add an edit variant (doorway, window, …)

**Steps**

1. Add the 3×3 mask constant to `build_pieces.py`, row-major, top-left first.
   Mask index 0 is the **top**-left; getting this inverted produces upside-down
   doorways that look almost right.
2. Add it to the variant loop in `generate_all()`.
3. Generate, export, import.
4. On the `BuildPieceBlueprint`, add an `EditVariant` with the **same** mask and
   the new mesh. The Python constant and the Blueprint mask must agree — they
   are duplicated on purpose, and validation checks the Blueprint side for
   duplicate masks.

**Verification**: the new shape appears in edit mode; the mask resolves to the
variant rather than reverting.

---

## RB-04 — Retune the storm

Pure asset work. No code, no meshes.

**Steps**

1. Agent: edit the `StormPhaseBlueprint` assets under
   `Assets/Tonight/Blueprints/Match/Storm/`.
2. Keep radius continuity: each phase's `StartRadius` must equal the previous
   phase's `EndRadius`. A gap here is a circle that silently teleports.
3. Check the total against the 16–18 minute target. `MatchRulesBlueprint`
   warns outside 12–22 minutes.

**Verification**: `python3 tools/validate_blueprints.py` — the cross-asset
continuity check is the one that matters, and no single asset can perform it.

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
vehicle hash changing, something is sharing state that should not be — most
likely an RNG stream, which `test_generators_do_not_share_rng_state` exists to
catch.

**Verification**: only the intended assets changed hash.

---

## RB-06 — Investigate a failing test with an agent

**Steps**

1. Agent: run the EditMode tests via Unity MCP, or `pytest blender/tests` via
   the shell.
2. Agent: read the failure and the relevant source.
3. **Agent proposes a fix; a human reviews before it is applied to gameplay
   code.**

Step 3 is a working agreement rather than a technical constraint. Asset fixes
are cheap to review and cheap to revert. Gameplay fixes in the prediction and
netcode paths are neither, and a plausible-looking wrong fix there costs more
than the time it saved.

---

## RB-07 — Bind art to the seed Blueprints

The first task on a fresh checkout. The 57 seed Blueprints carry every authored
number from the GDD but no art references: prefabs, meshes, materials and audio
need Unity and Blender, and the generator that authored them had neither.

**Preconditions**
- `unity/Tonight/` opens and compiles.
- `blender --background --python blender/scripts/build_all.py` has run, so
  `blender/exports/` holds the FBX.

**Steps**

1. Copy `blender/exports/**` into `unity/Tonight/Assets/Tonight/Art/`, keeping
   the folder split (`Build/`, `Weapons/`, `Harvestables/`, `Terrain/`).
2. Run `Tonight → Blueprints → Validate All`. The Console now lists every
   unbound reference. **That list is the checklist.**
3. Work it in dependency order, because later bindings reference earlier ones:
   materials → meshes → prefabs → Blueprint slots.
4. For each `BuildPieceBlueprint`, fill the `MeshByMaterial` entry for **every**
   build material. The entries already exist with empty mesh slots, so the
   Console says "assign this mesh" rather than "this piece is missing a
   material".
5. Re-run validation until the Console is clean.

**Verification**

```bash
python3 tools/validate_blueprints.py     # cross-asset checks still pass
```
Plus `Tonight → Blueprints → Validate All` reporting zero errors, and the
EditMode tests still green.

**Do not** hand-edit the generated `.asset` files to add references — CI checks
them against `tools/seed_blueprints.py` and a hand-edit would be overwritten on
the next run. Bind through the Inspector, then decide whether the binding
belongs in the generator.

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
