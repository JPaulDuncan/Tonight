# ADR-0008: Export glTF from Python, not from Blender

**Status:** Accepted · **Date:** 2026-09-18 · **Deciders:** engineering

Amends [ADR-0004](0004-procedural-art-pipeline.md) rules 1 and 6.

## Context

ADR-0004 built the art pipeline on the split that makes it testable: geometry is
assembled as a `bpy`-free `MeshData` in `blender/lib/tonight/`, and only the
final hand-off touches Blender. Rule 6 then required every export to go through
`bpy.ops.export_scene.*`, owned by one adapter function.

Wiring the web client to load the generated meshes made the cost of that rule
visible. Neither CI nor a fresh checkout has Blender installed — that is the
point of the library split — so **no automated check had ever seen an exported
file**. The client would have shipped able to load assets in theory, against
assets nothing could produce. Two bugs were sitting in that gap:

- `build_all.py` called `export_fbx()` with a path `export_path()` had already
  suffixed `.glb`, so a real export would have written FBX bytes into a `.glb`.
- The `wedge` primitive rose along +Y, which becomes glTF −Z, while the
  simulation's walkable-surface query rises with +Z. Every ramp would have been
  walkable from the end it visibly descends to.

Both are exactly the class of bug ADR-0004's determinism and hashing were meant
to catch, and neither could be caught while the export step was unreachable.

Checking *why* Blender was needed settled it: the generators use no Blender
modelling operator. No bevel, no solidify, no boolean, no UV unwrap. `MeshData`
carries complete geometry — vertices, polygon faces and per-corner UVs — and
`create_object` copies it into Blender verbatim. Blender's only remaining job was
serialising a file format with a published spec.

## Decision

**Export is a pure-Python function.** `tonight.gltf.write_glb()` serialises a
`MeshData` to binary glTF directly, and `build_all.py` calls it.

1. A full art build runs with `python3 blender/scripts/build_all.py`. No Blender.
   This supersedes ADR-0004 rule 1's "generators run headless *in Blender*".
2. The writer owns the three conversions, each in one place: Blender Z-up to
   glTF Y-up, flat shading by splitting vertices per face, and the V flip.
   This replaces ADR-0004 rule 6's `export_fbx()` with the same rule pointed at
   a different function; calling `bpy.ops.export_scene.*` is still prohibited.
3. The writer is covered by round-trip tests that decode the bytes back — a
   writer checked only against itself is not checked. Winding is pinned by
   signed volume over every shipped asset, and the ramp's rise direction is
   pinned in both languages, against the collision code it has to agree with.
4. `blender_adapter.export_gltf()` stays, for prototyping in a live Blender over
   MCP. It is no longer on the build path.
5. Everything else in ADR-0004 stands: generators are the source of truth,
   `.blend` files are not committed, exports are gitignored build output, and
   the library still imports without `bpy`.

## Consequences

**We accept:**

- A glTF writer to maintain. Bounded: it emits one mesh, one buffer and four
  accessors per primitive, and the spec for that subset is stable. The tests
  decode what it writes, so a regression is a failure rather than a surprise
  in a browser.
- No Blender modifiers on the build path. If an asset ever genuinely needs
  bevel or boolean, that asset cannot use this writer and this ADR needs
  revisiting. Nothing needs it today, and ADR-0004 already accepted a hard
  ceiling on art quality.
- No materials in the exported files. The generators never assigned any, so
  this changes nothing — the client supplies materials, and part roles ride
  along in each primitive's `extras` so a tree's trunk and canopy can differ.
- Hand-rolled serialisation could drift from the spec in ways a permissive
  loader tolerates. Mitigated by decoding in the tests rather than trusting
  three.js to be forgiving.

**We gain:**

- CI exports the real files and the web job loads them, so the pipeline is
  covered end to end for the first time.
- A fresh checkout can run the whole project — `npm run dev` generates art as a
  pre-step — with no 500 MB install and no GUI.
- Export is ~0.2 s for 34 assets instead of a Blender launch per asset.
- Deterministic bytes. `json.dumps(sort_keys=True)` and `struct.pack` make a
  generator change the only thing that can change an output, which is what
  ADR-0004 wanted the manifest hashes to mean.

## Alternatives considered

**Keep Blender on the build path and install it in CI.** Honest, and it would
have caught both bugs. Rejected on cost: a Blender install is minutes of CI per
run and a large local dependency for contributors who only touch the client, to
serialise geometry that is already fully determined.

**Commit the `.glb` files.** Would let the client load assets with no pipeline
run at all. Rejected: it contradicts ADR-0004 rule 4 and makes a generator
change un-reviewable, which is the whole reason the manifest exists.

**Have the client load `MeshData` as JSON and build geometry itself.** Removes
the writer entirely. Rejected: it puts a second geometry assembler in a second
language, which is precisely the duplication ADR-0004's single-source rule
exists to avoid, and it forfeits glTF tooling for inspecting an asset.
