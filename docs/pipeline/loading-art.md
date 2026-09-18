# Loading art in the client

How a mesh gets from a Python generator onto the screen. The half before this is
[README.md](README.md); this is the half after export.

## The path

```
blender/lib/tonight/*.py     generators build MeshData (pure Python, no bpy)
        │
        ▼  tonight.gltf.write_glb()          ADR-0008
web/public/art/Build/SM_Build_Wall_Wood.glb  + manifest.json
        │
        ▼  ArtLibrary.load()                 web/src/render/assets.ts
three.js BufferGeometry, keyed by what a piece *is*
```

Run it with `npm run art`. `npm run dev` and `npm run build` do it for you as a
pre-step, so a fresh checkout needs no separate command — and no Blender.

`web/public/art/` is gitignored. It is build output, same as `blender/exports/`
([ADR-0004](../adr/0004-procedural-art-pipeline.md) rule 4).

## Nothing fails soft

An asset that quietly fails to load leaves an **invisible but solid wall**: the
collision grid is authoritative and does not care whether a mesh arrived, so the
player is blocked by nothing they can see. That is the worst failure mode this
project has.

So the loader has no fallback and no placeholder. A missing manifest, a missing
file, or a mesh with no geometry rejects the whole boot, and `main.ts` shows the
reason with the command that fixes it. The procedural geometry the sandbox used
before this landed was deleted rather than kept as a fallback, because a
fallback is how you ship a build where half the art silently never loaded.

## Lookup is by Blueprint fields, never by asset name

The renderer never sees an asset name it typed itself. It asks for a piece by
what the Blueprints say it is:

```ts
const placement = registry.buildPiece(pieceId).placement;       // "wall"
const materialKind = registry.buildMaterial(materialId).materialKind;  // "wood"
const name = art.nameForKey(buildPieceKey(placement, materialKind));   // "wall/wood"
```

The key on the other side is derived from the manifest by stripping each asset's
prefix and category: `SM_Build_Wall_Wood` becomes `wall/wood`. Both sides derive
their key, so a renamed generator output fails loudly at boot instead of quietly
missing, and adding a build material stays a JSON change plus a generator.

This replaced a `switch (pieceId)` in the renderer — the first anti-pattern
`CLAUDE.md` names.

`web/tests/assets.test.ts` asserts that **every** piece × material pair in the
Blueprints has a mesh, so adding a material without a generator fails in Node in
under a second rather than in a browser on someone else's machine.

## Two conventions the meshes must honour

These are the ones where being wrong still looks plausible.

### Origin: centred in X and Z, base on the cell floor

Every build piece is authored spanning its cell with its base at the cell floor,
not centred on its own origin. The renderer places them with `meshOrigin()`,
which takes X and Z from the slot anchor and Y from the cell floor:

```ts
const anchor = slotAnchor(cell, slot);
return { x: anchor.x, y: cellCentre(cell).y - CELL_SIZE / 2, z: anchor.z };
```

Placing a piece at the raw slot anchor floats a wall half a cell high. Pinned by
`test_pieces_are_authored_with_their_base_at_the_cell_floor`.

Pieces may hang below the cell floor by `units.SKIRT_DEPTH` (0.35 m) so they meet
sloped terrain without a gap, which is why a wall's height reads as 4.35 m.

### Ramps rise toward +Z

`surfaceHeight()` in `web/src/render/collision.ts` returns
`base.y + localZ / CELL_SIZE * CELL_SIZE` for a ramp, so the walkable surface is
highest at the **+Z** edge of the cell. Blender −Y maps to glTF +Z, so `wedge()`
rises toward −Y.

A ramp authored the other way looks entirely correct in isolation and is walkable
from the end it visibly descends to — the preview-disagrees-with-reality failure
[vision pillar 1](../00-vision.md) forbids. It is pinned twice, once in each
language, because the two things that must agree live in two languages:
`test_ramp_rises_towards_positive_gltf_z` and the matching case in
`web/tests/assets.test.ts`.

## Materials come from Blueprints, not from the files

The exported meshes carry no materials — the generators never assigned any. The
client supplies them:

- **Build pieces** take one colour from `BuildMaterialBlueprint.colour`, and
  their primitives are merged into one geometry so a piece is one draw call.
- **Props** keep their parts separate. Each primitive carries its part role in
  `extras.group` (`Trunk`, `Canopy`, `Wheel`), so a tree keeps its two-tone read.
  Repeated parts coalesce by role, so a wall's sixteen relief panels are one
  primitive rather than sixteen.

Part roles are the generator's own part names with the instance suffix stripped:
`Canopy_3` and `Canopy_0` are both `Canopy`.

## The player character

`blender/lib/tonight/character.py` generates a blocky humanoid proxy, which
[ADR-0004](../adr/0004-procedural-art-pipeline.md) explicitly accepted as the
weakest case for a generated-art pipeline. Third person means the player looks at
it for the whole match, so two things about it are load-bearing:

- **It faces Blender −Y, which is glTF +Z**, because the motor's yaw of zero
  points at +Z. Authored any other way it runs backwards and the camera behind
  the player stares at its face.
- **Its parts are named for the hitboxes in `CharacterBlueprint`** (`Head`,
  `Chest`, `ArmLeft`, …), so the client colours a limb without a second list of
  what a limb is.

It is also narrower than a third of a cell, so it fits through the doorway it can
cut. Nothing animates it yet: it slides.

## Edit variants

A wall's `editMask` selects its mesh through the same blueprint the simulation
validated against:

```ts
const variant = variantForMask(piece, editMask);   // undefined when solid
const key = buildPieceKey(placement, materialKind, variant?.variantName.toLowerCase());
```

`SM_Build_Wall_Wood_Doorway` keys as `wall/wood/doorway`, so the edit path is the
same lookup as the solid path with one more segment. A mask no variant matches is
a solid piece, which is exactly how `tryEdit` treats it — so the mesh and the
simulation cannot disagree about what an unrecognised mask means.

The generated variants are cheap to tell apart, which is what makes the browser
test meaningful: a solid wall is 408 vertices and a doorway is 168, so the smoke
test can assert the *variant* mesh loaded rather than just that something did.

## What is not loaded yet

- **Terrain.** The client generates its heightfield in the browser, because
  collision samples that same field. Loading `SM_Terrain_TestIsland` would put
  two different surfaces in one scene.
- **Weapons.** Nothing renders a held weapon yet. When that lands,
  `wantedInSandbox()` in `sandbox.ts` is the one place that changes.

## When something does not appear

| Symptom | Cause |
| --- | --- |
| "Could not load the art" at boot | `npm run art` has not run, or Python is missing |
| A piece throws `No mesh for build piece 'x/y'` | A Blueprint material or piece with no generator. `npm test` says which. |
| A wall floats half a cell up | Placed at the slot anchor instead of through `meshOrigin()` |
| A ramp is walkable from the wrong end | The wedge's rise direction; see above |
| A prop is one flat colour | Its parts share a name, so they coalesced into one primitive |
| Everything is inside-out | Winding. `test_asset_has_positive_signed_volume` should have caught it. |
