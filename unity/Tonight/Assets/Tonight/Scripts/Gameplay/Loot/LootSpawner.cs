using System.Collections.Generic;
using Tonight.Blueprints.Combat;
using Tonight.Blueprints.Loot;
using Tonight.Blueprints.World;
using Tonight.Core;
using UnityEngine;

namespace Tonight.Gameplay.Loot
{
    /// <summary>A container or floor pile placed at match start.</summary>
    public readonly struct LootPlacement
    {
        public enum Kind
        {
            Chest,
            FloorLoot,
            SupplyDrop,
        }

        public readonly Kind Type;
        public readonly int SpawnPointIndex;
        public readonly IReadOnlyList<RolledItem> Contents;

        public LootPlacement(Kind type, int spawnPointIndex, IReadOnlyList<RolledItem> contents)
        {
            Type = type;
            SpawnPointIndex = spawnPointIndex;
            Contents = contents;
        }
    }

    /// <summary>
    /// Populates a POI at match start.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Everything is rolled once, at match start, on the server. Opening a
    /// chest is therefore a pure reveal of contents that already exist rather
    /// than a request for new ones -- no round trip, and nothing a client can
    /// influence.
    /// </para>
    /// <para>
    /// The RNG is seeded from the match seed and the POI, so a whole match's
    /// loot is reproducible from its seed. That is worth more than it sounds
    /// when chasing a report about one specific match.
    /// </para>
    /// </remarks>
    public static class LootSpawner
    {
        public static void SpawnPoi(
            PoiBlueprint poi,
            IReadOnlyList<RarityBlueprint> rarities,
            int matchSeed,
            int poiIndex,
            List<LootPlacement> into)
        {
            if (poi == null || into == null)
            {
                return;
            }

            into.Clear();
            var rng = DeterministicRng.ForStream(matchSeed, poiIndex);

            for (int point = 0; point < poi.ChestSpawnPoints; point++)
            {
                if (rng.NextFloat() > poi.ChestSpawnChance)
                {
                    continue;
                }

                var contents = new List<RolledItem>();
                LootRoller.Roll(poi.ChestTable, rarities, ref rng, contents);
                into.Add(new LootPlacement(LootPlacement.Kind.Chest, point, contents));
            }

            int floorCount = rng.Range(poi.FloorLootCount);
            for (int i = 0; i < floorCount; i++)
            {
                var contents = new List<RolledItem>();
                LootRoller.Roll(poi.FloorTable, rarities, ref rng, contents);
                if (contents.Count > 0)
                {
                    into.Add(new LootPlacement(LootPlacement.Kind.FloorLoot, i, contents));
                }
            }
        }

        /// <summary>
        /// Total items a POI produced, for the density checks the map validator
        /// runs at M5.
        /// </summary>
        public static int CountItems(IReadOnlyList<LootPlacement> placements)
        {
            int total = 0;
            for (int i = 0; i < placements.Count; i++)
            {
                total += placements[i].Contents.Count;
            }

            return total;
        }

        /// <summary>
        /// Ammo granted alongside a rolled weapon.
        /// </summary>
        /// <remarks>
        /// A weapon with no ammo is a disappointment rather than a decision, so
        /// picking one up always comes with enough to use it.
        /// </remarks>
        public static int StartingAmmoFor(WeaponBlueprint weapon) => weapon switch
        {
            null => 0,
            _ => weapon.AmmoType switch
            {
                AmmoType.Shell => Mathf.Max(8, weapon.MagazineSize * 2),
                AmmoType.Heavy => Mathf.Max(6, weapon.MagazineSize * 4),
                AmmoType.None => 0,
                _ => Mathf.Max(30, weapon.MagazineSize * 2),
            },
        };
    }
}
