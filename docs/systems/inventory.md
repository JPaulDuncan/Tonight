# System: Inventory

**Owner:** design + engineering · **Status:** specified, unimplemented · **Milestone:** M3

## 1. Shape

| Slot | Contents |
| --- | --- |
| 0 | Pickaxe — permanent, undroppable |
| 1–5 | Weapons and consumables |

Five usable slots, chosen so the loadout decision stays real. Materials are
**not** inventory slots; they are three separate counters.

Ammo is also not a slot. It is four counters (`Light`, `Medium`, `Heavy`,
`Shell`) matching `WeaponBlueprint.AmmoType`. Ammo occupying slots would turn
every loot decision into an accounting exercise.

## 2. Rules

| Action | Behaviour |
| --- | --- |
| Pick up with a free slot | Goes to the lowest free slot |
| Pick up with no free slot | Swaps with the currently held item, which drops at the player's feet |
| Drop | Spawns a pickup with the item's exact state, including current magazine |
| Swap slots | Free, instant, no animation lock |
| Equip | Takes `WeaponBlueprint.EquipSeconds`; cancellable by swapping again |
| Stack | Consumables stack to `ConsumableBlueprint.MaxStack` |
| Auto-pickup | Ammo and materials, and consumables that stack onto a held item |

Equip being cancellable matters: swapping shotgun → AR → shotgun to cancel a
reload is deliberate skill expression, not an exploit.

## 3. Consumables

```
hold use → channel for UseSeconds
         → CancelOnDamage: taking damage interrupts and refunds nothing
                            (the item is consumed on completion, not on start)
         → on completion: apply HealthRestored / ShieldRestored,
                          clamped by HealthCap
```

`HealthCap` below max is what makes a bandage-vs-medkit decision interesting: a
bandage heals to 75, a medkit to 100 and takes far longer.

Consumption on completion rather than on start means an interrupted heal wastes
time but not the item — being punished twice for being caught mid-heal felt bad
in every game that has tried it.

## 4. Death

The full inventory drops as a pile at the death position, preserving exact state.
Materials drop at 50% of carried, so a kill is a material windfall but not a
full transfer. Ammo drops in full.

## 5. Networking

The inventory is server-authoritative and replicated only to its owner (and, in
squad modes, a reduced view to teammates). Other clients see only the equipped
item's visual.

Pickup, drop, and use are commands the server validates against proximity and
slot state.

## 6. Blueprint surface

| Blueprint | Governs |
| --- | --- |
| `ItemBlueprint` (base) | Icon, pickup prefab, stackability |
| `WeaponBlueprint` | Equip time, ammo type |
| `ConsumableBlueprint` | Heal amounts, cap, use time, stack size, cancel rules |
| `MatchRulesBlueprint` | `StartingLoadout` |

## 7. Test plan

| Test | Level | Asserts |
| --- | --- | --- |
| Slot assignment | EditMode | Lowest free slot; correct swap when full |
| State preservation | EditMode | Dropping and re-picking preserves magazine contents exactly |
| Stacking | EditMode | Respects `MaxStack`; overflow spawns a second stack |
| Heal cap | EditMode | `HealthCap` respected; never exceeds `MaxHealth` |
| Interrupt | PlayMode | Damage cancels the channel; the item is not consumed |
| Equip cancel | PlayMode | Swap during equip cancels cleanly with no stuck state |
| Death drop | PlayMode | Full inventory, 50% materials, 100% ammo |
| Authority | PlayMode (M4) | Out-of-range pickup rejected |
