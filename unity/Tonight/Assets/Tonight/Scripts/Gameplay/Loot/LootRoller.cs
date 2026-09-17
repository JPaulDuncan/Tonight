using System.Collections.Generic;
using Tonight.Blueprints;
using Tonight.Blueprints.Combat;
using Tonight.Blueprints.Loot;
using Tonight.Core;

namespace Tonight.Gameplay.Loot
{
    /// <summary>One item produced by a loot roll.</summary>
    public readonly struct RolledItem
    {
        public readonly ItemBlueprint Item;
        public readonly RarityBlueprint Rarity;
        public readonly int Count;

        public RolledItem(ItemBlueprint item, RarityBlueprint rarity, int count)
        {
            Item = item;
            Rarity = rarity;
            Count = count;
        }
    }

    /// <summary>
    /// Rolls loot tables.
    /// </summary>
    /// <remarks>
    /// <para>
    /// All rolls happen on the server, once, at spawn time. A client never
    /// rolls anything that matters, and nothing is ever re-rolled -- opening a
    /// chest is a reveal of contents that already exist, not a request for new
    /// ones.
    /// </para>
    /// <para>
    /// Every draw comes from <see cref="DeterministicRng"/> seeded by the match
    /// seed, so a whole match's loot is reproducible from its seed. That is
    /// worth more than it sounds when chasing a report about one specific match.
    /// </para>
    /// </remarks>
    public static class LootRoller
    {
        /// <summary>
        /// Guards against a table graph that cycles despite validation. Depth
        /// rather than a visited set, because a table legitimately appearing
        /// twice in one roll is fine; unbounded recursion is not.
        /// </summary>
        private const int MaxNestingDepth = 8;

        public static void Roll(
            LootTableBlueprint table,
            IReadOnlyList<RarityBlueprint> rarities,
            ref DeterministicRng rng,
            List<RolledItem> results)
        {
            RollInternal(table, rarities, ref rng, results, 0);
        }

        private static void RollInternal(
            LootTableBlueprint table,
            IReadOnlyList<RarityBlueprint> rarities,
            ref DeterministicRng rng,
            List<RolledItem> results,
            int depth)
        {
            if (table == null || results == null || depth >= MaxNestingDepth)
            {
                return;
            }

            IReadOnlyList<LootEntry> entries = table.Entries;
            if (entries.Count == 0)
            {
                return;
            }

            // Weights are gathered once per table rather than per roll.
            var weights = new float[entries.Count];
            for (int i = 0; i < entries.Count; i++)
            {
                weights[i] = entries[i] != null ? entries[i].Weight : 0f;
            }

            int rolls = rng.Range(table.RollCount);
            for (int r = 0; r < rolls; r++)
            {
                int index = rng.WeightedPick(weights);
                if (index < 0)
                {
                    // Weights sum to zero. Validation should have caught this;
                    // producing nothing is the safe runtime behaviour.
                    return;
                }

                LootEntry entry = entries[index];
                switch (entry.Kind)
                {
                    case LootEntryKind.Nothing:
                        break;

                    case LootEntryKind.Table:
                        RollInternal(entry.Table, rarities, ref rng, results, depth + 1);
                        break;

                    case LootEntryKind.Item:
                        if (entry.Item == null)
                        {
                            break;
                        }

                        RarityBlueprint rarity = entry.RarityOverride
                            ?? RollRarity(rarities, table.RarityBias, ref rng);

                        int count = rng.Range(entry.CountRange);
                        var rolled = new RolledItem(entry.Item, rarity, count);

                        if (!table.AllowDuplicates && ContainsItem(results, entry.Item))
                        {
                            // Re-roll once rather than looping: a table whose
                            // entries are nearly exhausted would otherwise spin.
                            continue;
                        }

                        results.Add(rolled);
                        break;
                }
            }
        }

        /// <summary>
        /// Rolls a rarity tier, shifted up by <paramref name="bias"/> tiers.
        /// Chests use a bias of 1.
        /// </summary>
        public static RarityBlueprint RollRarity(
            IReadOnlyList<RarityBlueprint> rarities,
            int bias,
            ref DeterministicRng rng)
        {
            if (rarities == null || rarities.Count == 0)
            {
                return null;
            }

            var weights = new float[rarities.Count];
            for (int i = 0; i < rarities.Count; i++)
            {
                weights[i] = rarities[i] != null ? rarities[i].LootWeight : 0f;
            }

            int index = rng.WeightedPick(weights);
            if (index < 0)
            {
                return null;
            }

            if (bias == 0)
            {
                return rarities[index];
            }

            // Bias shifts the rolled TIER, then finds the asset with that tier,
            // so the shift is meaningful regardless of list ordering.
            int targetTier = rarities[index].Tier + bias;
            return FindNearestTier(rarities, targetTier) ?? rarities[index];
        }

        private static RarityBlueprint FindNearestTier(
            IReadOnlyList<RarityBlueprint> rarities,
            int targetTier)
        {
            RarityBlueprint best = null;
            int bestDistance = int.MaxValue;

            for (int i = 0; i < rarities.Count; i++)
            {
                RarityBlueprint candidate = rarities[i];
                if (candidate == null)
                {
                    continue;
                }

                int distance = System.Math.Abs(candidate.Tier - targetTier);
                if (distance < bestDistance)
                {
                    bestDistance = distance;
                    best = candidate;
                }
            }

            return best;
        }

        private static bool ContainsItem(List<RolledItem> results, ItemBlueprint item)
        {
            for (int i = 0; i < results.Count; i++)
            {
                if (results[i].Item == item)
                {
                    return true;
                }
            }

            return false;
        }
    }
}
