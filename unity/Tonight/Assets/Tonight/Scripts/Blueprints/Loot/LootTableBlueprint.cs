using System;
using System.Collections.Generic;
using Tonight.Blueprints.Combat;
using Tonight.Core;
using UnityEngine;

namespace Tonight.Blueprints.Loot
{
    public enum LootEntryKind
    {
        Item,
        Table,
        Nothing,
    }

    /// <summary>One weighted row in a loot table.</summary>
    [Serializable]
    public sealed class LootEntry
    {
        [SerializeField] private LootEntryKind _kind = LootEntryKind.Item;

        [SerializeField] private ItemBlueprint _item;

        [SerializeField]
        [Tooltip("A nested table. This is how a Chest table is composed from a " +
                 "Weapons table plus a Consumables table, rather than restated.")]
        private LootTableBlueprint _table;

        [SerializeField, Min(0f)] private float _weight = 1f;

        [SerializeField] private IntRange _countRange = IntRange.Single(1);

        [SerializeField]
        [Tooltip("Forces a rarity tier. Supply drops use this to guarantee a high roll.")]
        private RarityBlueprint _rarityOverride;

        public LootEntryKind Kind => _kind;

        public ItemBlueprint Item => _item;

        public LootTableBlueprint Table => _table;

        public float Weight => _weight;

        public IntRange CountRange => _countRange;

        public RarityBlueprint RarityOverride => _rarityOverride;
    }

    /// <summary>
    /// A weighted, optionally nested loot table.
    /// </summary>
    /// <remarks>
    /// All rolls happen on the server, once, at spawn time -- never on a client
    /// and never re-rolled. See docs/systems/loot.md.
    /// </remarks>
    [CreateAssetMenu(
        fileName = "BP_Loot_New",
        menuName = "Tonight/Blueprints/Loot/Loot Table",
        order = 0)]
    public sealed class LootTableBlueprint : TonightBlueprint
    {
        [SerializeField] private List<LootEntry> _entries = new List<LootEntry>();

        [SerializeField]
        [Tooltip("Inclusive number of rolls taken from this table.")]
        private IntRange _rollCount = IntRange.Single(1);

        [SerializeField] private bool _allowDuplicates = true;

        [SerializeField]
        [Tooltip("Shifts every rolled rarity up by this many tiers. Chests use 1.")]
        private int _rarityBias;

        public IReadOnlyList<LootEntry> Entries => _entries;

        public IntRange RollCount => _rollCount;

        public bool AllowDuplicates => _allowDuplicates;

        public int RarityBias => _rarityBias;

        public float TotalWeight
        {
            get
            {
                float total = 0f;
                for (int i = 0; i < _entries.Count; i++)
                {
                    if (_entries[i] != null && _entries[i].Weight > 0f)
                    {
                        total += _entries[i].Weight;
                    }
                }

                return total;
            }
        }

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);

            ctx.Require(_entries.Count > 0, "Loot table has no entries.");
            ctx.Require(TotalWeight > 0f,
                "Loot table weights sum to zero; it can never produce anything.");
            ctx.Require(_rollCount.IsValid, "RollCount max must be at least min.");

            for (int i = 0; i < _entries.Count; i++)
            {
                LootEntry entry = _entries[i];
                if (entry == null)
                {
                    ctx.Require(false, $"Entry {i} is null.");
                    continue;
                }

                ctx.Require(entry.CountRange.IsValid, $"Entry {i} has an inverted count range.");

                switch (entry.Kind)
                {
                    case LootEntryKind.Item:
                        ctx.Require(entry.Item != null, $"Entry {i} is kind Item but has no item.");
                        break;
                    case LootEntryKind.Table:
                        ctx.Require(entry.Table != null, $"Entry {i} is kind Table but has no table.");
                        ctx.Require(entry.Table != this, $"Entry {i} references its own table.");
                        break;
                }
            }

            // Deeper reference cycles span assets and are detected by
            // tools/validate_blueprints.py, which can see the whole graph.
        }
    }
}
