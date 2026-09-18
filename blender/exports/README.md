# Exports

**This folder is build output. Do not commit exported meshes from it.**

Everything here is regenerated from the Python in `blender/scripts/`, which is
the actual source of truth (ADR-0004):

```bash
blender --background --python blender/scripts/build_all.py
```

`manifest.json` **is** committed. It records every asset's name, dimensions,
triangle count, and content hash, which is what makes a procedural art pipeline
reviewable: a diff of the manifest shows exactly which assets a generator change
altered, instead of leaving a reviewer to trust that "regenerated all art" did
what it claimed.

To see what a change did without running Blender:

```bash
python3 blender/scripts/build_all.py -- --dry-run
git diff blender/exports/manifest.json
```
