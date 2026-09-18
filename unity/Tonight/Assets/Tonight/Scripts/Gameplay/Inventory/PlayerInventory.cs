using System.Collections.Generic;
using Tonight.Blueprints;
using Tonight.Blueprints.Combat;
using Tonight.Blueprints.Loot;
using UnityEngine;

namespace Tonight.Gameplay.Inventory
{
    /// <summary>One occupied inventory slot.</summary>
    public struct InventorySlot
    {
        public ItemBlueprint Item;
        public RarityBlueprint Rarity;
        public int Count;

        /// <summary>Magazine contents for a weapon. Preserved across drop and pickup.</summary>
        public int AmmoInMagazine;

        public bool IsEmpty => Item == null || Count <= 0;

        public static readonly InventorySlot Empty = default;
    }

    /// <summary>
    /// Five usable slots plus a permanent pickaxe.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Materials and ammo are deliberately <b>not</b> slots: materials are three
    /// counters and ammo is four, because making either compete for slots turns
    /// every loot decision into an accounting exercise
    /// (docs/systems/inventory.md 1).
    /// </para>
    /// <para>
    /// Five is chosen so the loadout decision stays real.
    /// </para>
    /// </remarks>
    public sealed class PlayerInventory
    {
        public const int SlotCount = 5;

        /// <summary>The pickaxe's virtual index. Permanent and undroppable.</summary>
        public const int PickaxeSlot = -1;

        private readonly InventorySlot[] _slots = new InventorySlot[SlotCount];
        private readonly Dictionary<AmmoType, int> _ammo = new Dictionary<AmmoType, int>();

        private int _selected = PickaxeSlot;

        public IReadOnlyList<InventorySlot> Slots => _slots;

        public int SelectedIndex => _selected;

        public InventorySlot Selected =>
            _selected >= 0 && _selected < SlotCount ? _slots[_selected] : InventorySlot.Empty;

        public bool PickaxeSelected => _selected == PickaxeSlot;

        // ---------------------------------------------------------------
        // Ammo
        // ---------------------------------------------------------------

        public int GetAmmo(AmmoType type)
        {
            // TryGetValue rather than GetValueOrDefault: the latter is a
            // netstandard2.1 extension and this must build on the widest
            // scripting backend Unity offers.
            if (type == AmmoType.None)
            {
                return int.MaxValue;
            }

            return _ammo.TryGetValue(type, out int amount) ? amount : 0;
        }

        public void AddAmmo(AmmoType type, int amount)
        {
            if (type == AmmoType.None || amount <= 0)
            {
                return;
            }

            _ammo[type] = GetAmmo(type) + amount;
        }

        public bool TryConsumeAmmo(AmmoType type, int amount)
        {
            if (type == AmmoType.None)
            {
                return true;
            }

            int available = GetAmmo(type);
            if (available < amount)
            {
                return false;
            }

            _ammo[type] = available - amount;
            return true;
        }

        // ---------------------------------------------------------------
        // Slots
        // ---------------------------------------------------------------

        public int FirstFreeSlot()
        {
            for (int i = 0; i < SlotCount; i++)
            {
                if (_slots[i].IsEmpty)
                {
                    return i;
                }
            }

            return -1;
        }

        /// <summary>
        /// Pick an item up.
        /// </summary>
        /// <param name="displaced">
        /// What was pushed out to make room, if anything. When every slot is
        /// full the held item drops at the player's feet rather than the pickup
        /// being refused, which is what makes swapping mid-fight fast.
        /// </param>
        /// <returns>The slot the item landed in, or -1 when it could not be taken.</returns>
        public int Pickup(
            ItemBlueprint item, RarityBlueprint rarity, int count, int ammoInMagazine,
            out InventorySlot displaced)
        {
            displaced = InventorySlot.Empty;

            if (item == null || count <= 0)
            {
                return -1;
            }

            // Stackables merge into an existing stack first.
            if (item.IsStackable)
            {
                int remaining = count;
                for (int i = 0; i < SlotCount && remaining > 0; i++)
                {
                    if (_slots[i].Item != item || _slots[i].Count >= item.MaxStack)
                    {
                        continue;
                    }

                    int room = item.MaxStack - _slots[i].Count;
                    int moved = Mathf.Min(room, remaining);
                    _slots[i].Count += moved;
                    remaining -= moved;

                    if (remaining <= 0)
                    {
                        return i;
                    }
                }

                count = remaining;
            }

            int free = FirstFreeSlot();
            if (free >= 0)
            {
                _slots[free] = new InventorySlot
                {
                    Item = item,
                    Rarity = rarity,
                    Count = Mathf.Min(count, item.MaxStack),
                    AmmoInMagazine = ammoInMagazine,
                };
                return free;
            }

            // Full: swap with what is held. The pickaxe slot cannot be swapped
            // out, so an inventory-full pickup while holding it is refused.
            if (_selected < 0)
            {
                return -1;
            }

            displaced = _slots[_selected];
            _slots[_selected] = new InventorySlot
            {
                Item = item,
                Rarity = rarity,
                Count = Mathf.Min(count, item.MaxStack),
                AmmoInMagazine = ammoInMagazine,
            };
            return _selected;
        }

        /// <summary>Drop a slot's contents, preserving exact state.</summary>
        public bool TryDrop(int index, out InventorySlot dropped)
        {
            dropped = InventorySlot.Empty;

            if (index < 0 || index >= SlotCount || _slots[index].IsEmpty)
            {
                return false;
            }

            dropped = _slots[index];
            _slots[index] = InventorySlot.Empty;
            return true;
        }

        public void Select(int index)
        {
            if (index == PickaxeSlot || (index >= 0 && index < SlotCount))
            {
                _selected = index;
            }
        }

        /// <summary>Swap two slots. Free and instant: no animation lock.</summary>
        public bool TrySwap(int a, int b)
        {
            if (a == b || a < 0 || b < 0 || a >= SlotCount || b >= SlotCount)
            {
                return false;
            }

            (_slots[a], _slots[b]) = (_slots[b], _slots[a]);
            return true;
        }

        /// <summary>Consume one from a stack, clearing the slot when it empties.</summary>
        public bool TryConsume(int index)
        {
            if (index < 0 || index >= SlotCount || _slots[index].IsEmpty)
            {
                return false;
            }

            _slots[index].Count--;
            if (_slots[index].Count <= 0)
            {
                _slots[index] = InventorySlot.Empty;
            }

            return true;
        }

        public void SetMagazine(int index, int ammoInMagazine)
        {
            if (index >= 0 && index < SlotCount)
            {
                _slots[index].AmmoInMagazine = ammoInMagazine;
            }
        }

        /// <summary>
        /// Everything that drops on death, in inventory order.
        /// </summary>
        /// <remarks>
        /// The full inventory drops with exact state. Materials drop at 50% and
        /// ammo in full, but those are counters the caller handles -- a kill is
        /// a windfall, not a full transfer.
        /// </remarks>
        public void CollectDeathDrop(List<InventorySlot> into)
        {
            into.Clear();
            for (int i = 0; i < SlotCount; i++)
            {
                if (!_slots[i].IsEmpty)
                {
                    into.Add(_slots[i]);
                }
            }
        }

        public void Clear()
        {
            for (int i = 0; i < SlotCount; i++)
            {
                _slots[i] = InventorySlot.Empty;
            }

            _ammo.Clear();
            _selected = PickaxeSlot;
        }

        /// <summary>Consumable in a slot, or null when it holds something else.</summary>
        public ConsumableBlueprint ConsumableAt(int index) =>
            index >= 0 && index < SlotCount ? _slots[index].Item as ConsumableBlueprint : null;

        public WeaponBlueprint WeaponAt(int index) =>
            index >= 0 && index < SlotCount ? _slots[index].Item as WeaponBlueprint : null;
    }
}
