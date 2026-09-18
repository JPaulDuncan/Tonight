# UI

HUD and menu code belongs here, in a `Tonight.UI` assembly.

Nothing is implemented yet — the HUD is an open M1 exit criterion, because it
needs prefabs and a scene and therefore the Unity Editor.

The assembly rule from [the architecture doc](../../../../../../docs/02-technical-architecture.md):
**`Tonight.UI` may read gameplay state and raise input intents. It may never
mutate simulation state directly.** The HUD reflects the simulation; it does not
participate in it.

What is specified and waiting to be built, per GDD §10:

| Element | Position |
| --- | --- |
| Health / shield bars | Bottom-centre, shield above health |
| Material counts | Bottom-right, above the inventory bar |
| Inventory bar | Bottom-right, 5 slots plus the pickaxe |
| Build palette | Same screen space as the inventory bar, so the eye never moves |
| Minimap with storm circles | Top-right |
| Storm timer | Under the minimap |

`MaterialWallet` and `PlayerInventory` already expose everything the first HUD
needs.

This file also keeps the folder present after a `git clone`, which git would
otherwise drop for being empty, orphaning `UI.meta`.
