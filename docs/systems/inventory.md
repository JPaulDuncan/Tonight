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
| Stack | Consumables stack to `ConsumableBlueprint.maxStack` |
| Auto-pickup | Ammo and materials, and consumables that stack onto a held item |

Equip being cancellable matters: swapping shotgun → AR → shotgun to cancel a
reload is deliberate skill expression, not an exploit.

## 3. Consumables

```
hold use → channel for UseSeconds
         → CancelOnDamage: taking damage interrupts and refunds nothing
                            (the item is consumed on completion, not on start)
         → on completion: apply HealthRestored / ShieldRestored,
                          clamped by healthCap
```

`healthCap` below max is what makes a bandage-vs-medkit decision interesting: a
bandage heals to 75, a medkit to 100 and takes far longer.

Consumption on completion rather than on start means an interrupted heal wastes
time but not the item — being punished twice for being caught mid-heal felt bad
in every game that has tried it.

### 3.1 What is built

The channel is implemented in `web/src/gameplay/consumable.ts` as a tick-driven
state machine, and it is wired to the sandbox: four keys, a channel bar, and a
stock count per item. Three things fell out of building it that the spec above
only implies:

- **A use that would restore nothing is refused.** A bandage at full health is
  not a heal, it is three seconds and one fewer bandage. So is a bandage at 80
  health, because it caps at 75.
- **`cancelOnDamage` is per item, not a global rule.** Nothing in the shipped
  set heals through damage, but an item that did would need no new code.
- **The interrupt is driven from the damage path**, not polled. Anything that
  hurts the player — a bot, a fall — calls the same function, so there is one
  place that decides a heal has been interrupted.

The rest of the inventory is still unported: slots, stacking and pickup are
Unity-era code. The sandbox hands out a full stack of each consumable, the way
it hands out 500 of each material.

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
| `ItemBlueprintBase` | Icon path, stackability |
| `WeaponBlueprint` | Equip time, ammo type |
| `ConsumableBlueprint` | Heal amounts, cap, use time, stack size, cancel rules |
| `MatchRulesBlueprint` | `startingLoadoutIds` |

## 7. Test plan

| Test | Level | Asserts |
| --- | --- | --- |
| Slot assignment | Unit | Lowest free slot; correct swap when full |
| State preservation | Unit | Dropping and re-picking preserves magazine contents exactly |
| Stacking | Unit | Respects `maxStack`; overflow spawns a second stack |
| Heal cap | Unit | `healthCap` respected; never exceeds `maxHealth` |
| Interrupt | Browser | Damage cancels the channel; the item is not consumed |
| Equip cancel | Browser | Swap during equip cancels cleanly with no stuck state |
| Death drop | Browser | Full inventory, 50% materials, 100% ammo |
| Authority | Integration (M4) | Out-of-range pickup rejected |
