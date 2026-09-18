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

## Textures

Generated as PNG alongside the meshes and listed in the manifest's `textures`
array. The client loads them with `THREE.TextureLoader`, sets `RepeatWrapping`
(a build piece tiles one 4 m face) and sRGB colour space, and hands them out by
asset name.

Which texture goes where is **Blueprint data**, not code:

| Blueprint | Field |
| --- | --- |
| `BuildMaterialBlueprint` | `texture`, e.g. `T_Build_Wood` |
| `HarvestableBlueprint` | `partTextures`, e.g. `{ "Trunk": "T_Harvest_Bark" }` |
| `CharacterBlueprint` | `partTextures`, keyed by hitbox name |

The material's `colour` stays and tints the map, so the two have to agree: a wood
texture under a stone tint reads as neither. `web/tests/assets.test.ts` checks
every named texture exists, so a typo fails in Node rather than rendering a
flat-colour wall nobody notices.

Unlike a missing *mesh*, a missing texture is allowed: `ArtLibrary.texture()`
returns undefined and the surface falls back to flat colour. An untextured wall
is ugly; an untextured wall is not invisible, which is the distinction that
makes the mesh loader strict and this one lenient.

## Animation

The walk cycle is a Blueprint (`LocomotionBlueprint` in `web/data/character.json`),
not a sine wave hardcoded in TypeScript. Retiming the walk, or giving a future
character a different gait, is a JSON edit.

Two pieces make it work:

**Pivots.** Each articulated primitive carries its joint in `extras.pivot`. The
generator emits it because the generator is what knows where a hip is; deriving
it in the renderer would mean a rule keyed to part names, which is the
behaviour-from-content anti-pattern in miniature. The client hangs each part off
a node at its pivot and offsets the geometry back by the same amount, so a limb
turns about its joint rather than about the character's feet.

**Distance, not time.** The cycle phase advances with metres travelled, not with
seconds. That is what stops the feet skating when the speed changes, and it makes
the animation frame-rate independent for free: `poseFor` is a pure function of
distance, speed and state, tested in Node in `web/tests/pose.test.ts`.

Speed itself comes from the *frame* delta, not the tick rate. `updateAvatar`
runs once per rendered frame and several simulation ticks can happen inside one,
so dividing by the tick interval overstated speed by the ratio of the two --
which pinned the forward lean at its cap at any frame rate below 30.

## The held weapon

A weapon hangs off the hand by matching two sockets, both emitted by the
generators: the character's `GripRight` and the weapon's own `Grip`. The
renderer subtracts one from the other and never needs to know what a pickaxe
looks like or which way round it is.

The hand node is a **child of the arm's joint**, so the weapon inherits the arm's
rotation for free — a swing moves the pickaxe because the pickaxe is parented to
the thing that swings. Attaching it to the avatar root instead would leave it
hanging in the air while the arm swung away from it.

Weapons are assembled along Blender +X and then turned onto −Y, which is glTF
+Z: the direction the character faces. An earlier version of the pipeline docs
claimed +X *was* forward, which is wrong — Blender +X is glTF +X, the
character's right — and a weapon left that way points out sideways from the
hand. `test_weapons_point_the_way_their_holder_faces` pins it.

Any transform on a `MeshData` carries its pivots and sockets with it
(`with_points_mapped`). A mesh whose vertices moved but whose sockets did not is
a weapon held a hand's width from the hand, and nothing about it looks wrong
until you see it in a scene.

## Upper-body clips

The walk is one layer; what the arms are doing is another. An
`UpperBodyBlueprint` carries a **mask** of the parts it owns, a duration, and
keyframes; parts inside the mask take the clip's rotation *instead of* the
walk's, and everything else keeps walking.

That exclusivity is the point. Adding the layers would have the arms swinging
while they hold a pickaxe overhead. Masking is also what lets one locomotion
cycle serve every action, instead of needing a walk-and-swing, a run-and-swing
and a crouch-and-swing.

| Clip | When |
| --- | --- |
| `upper.carry` | Holding a tool. Static, which is most of a match. |
| `upper.swing` | The pickaxe. Timed, 0.55 s: a swing takes as long as it takes however fast you are moving. |
| `upper.build` | Placing a piece. Building is the pillar, so it gets a read of its own. |

A weapon names its own `carryPoseId` and `usePoseId`, so a rifle that should not
swing like a pickaxe is a JSON field rather than a branch. One-shot clips hold
their last keyframe and then hand back to the carry pose, which is why the
character settles into holding its tool rather than snapping back into the walk.

Clips are timed and the walk is distance-driven, deliberately: a stride should
track the ground, and a swing should not speed up because you are sprinting.

## What is not loaded yet

- **Terrain.** The client generates its heightfield in the browser, because
  collision samples that same field. Loading `SM_Terrain_TestIsland` would put
  two different surfaces in one scene.
- **Other weapons.** The pickaxe is held and swung; the five firearms load and
  have grip sockets, carry poses and textures, but nothing equips them yet
  because firing is not bound to input.

## When something does not appear

| Symptom | Cause |
| --- | --- |
| "Could not load the art" at boot | `npm run art` has not run, or Python is missing |
| A piece throws `No mesh for build piece 'x/y'` | A Blueprint material or piece with no generator. `npm test` says which. |
| A wall floats half a cell up | Placed at the slot anchor instead of through `meshOrigin()` |
| A ramp is walkable from the wrong end | The wedge's rise direction; see above |
| A prop is one flat colour | Its parts share a name, so they coalesced into one primitive |
| Everything is inside-out | Winding. `test_asset_has_positive_signed_volume` should have caught it. |
