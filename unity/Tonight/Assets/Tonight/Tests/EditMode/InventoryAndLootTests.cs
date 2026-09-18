using System.Collections.Generic;
using NUnit.Framework;
using Tonight.Blueprints;
using Tonight.Blueprints.Combat;
using Tonight.Blueprints.Loot;
using Tonight.Blueprints.World;
using Tonight.Core;
using Tonight.Gameplay.Inventory;
using Tonight.Gameplay.Loot;
using UnityEngine;

namespace Tonight.Tests.EditMode
{
    public sealed class PlayerInventoryTests
    {
        private WeaponBlueprint _rifle;
        private WeaponBlueprint _shotgun;
        private ConsumableBlueprint _bandage;
        private DamageProfileBlueprint _profile;
        private PlayerInventory _inventory;

        [SetUp]
        public void SetUp()
        {
            _profile = TestBlueprints.Create<DamageProfileBlueprint>(
                new Dictionary<string, object> { { "_baseDamage", 30f } });

            _rifle = Weapon("Rifle", AmmoType.Medium, 30);
            _shotgun = Weapon("Shotgun", AmmoType.Shell, 5);

            _bandage = TestBlueprints.Create<ConsumableBlueprint>(new Dictionary<string, object>
            {
                { "_maxStack", 5 },
                { "_healthRestored", 15f },
                { "_healthCap", 75f },
                { "_useSeconds", 3f },
            });

            _inventory = new PlayerInventory();
        }

        [TearDown]
        public void TearDown()
        {
            foreach (Object asset in new Object[] { _rifle, _shotgun, _bandage, _profile })
            {
                Object.DestroyImmediate(asset);
            }
        }

        private WeaponBlueprint Weapon(string name, AmmoType ammo, int magazine)
        {
            var weapon = TestBlueprints.Create<WeaponBlueprint>(new Dictionary<string, object>
            {
                { "_ammoType", ammo },
                { "_magazineSize", magazine },
                { "_damageProfile", _profile },
                { "_maxStack", 1 },
            });
            weapon.name = name;
            return weapon;
        }

        [Test]
        public void PickupGoesToTheLowestFreeSlot()
        {
            Assert.AreEqual(0, _inventory.Pickup(_rifle, null, 1, 30, out _));
            Assert.AreEqual(1, _inventory.Pickup(_shotgun, null, 1, 5, out _));
        }

        [Test]
        public void MagazineContentsSurviveADropAndPickup()
        {
            _inventory.Pickup(_rifle, null, 1, 17, out _);
            Assert.IsTrue(_inventory.TryDrop(0, out InventorySlot dropped));
            Assert.AreEqual(17, dropped.AmmoInMagazine);

            _inventory.Pickup(dropped.Item, dropped.Rarity, dropped.Count, dropped.AmmoInMagazine, out _);
            Assert.AreEqual(17, _inventory.Slots[0].AmmoInMagazine);
        }

        [Test]
        public void AFullInventorySwapsTheHeldItemOut()
        {
            for (int i = 0; i < PlayerInventory.SlotCount; i++)
            {
                _inventory.Pickup(_rifle, null, 1, 30, out _);
            }

            _inventory.Select(2);
            int landed = _inventory.Pickup(_shotgun, null, 1, 5, out InventorySlot displaced);

            Assert.AreEqual(2, landed);
            Assert.AreEqual(_rifle, displaced.Item, "The held item is what drops");
            Assert.AreEqual(_shotgun, _inventory.Slots[2].Item);
        }

        [Test]
        public void AFullInventoryWhileHoldingThePickaxeRefusesThePickup()
        {
            // The pickaxe is permanent and undroppable, so there is nothing to
            // swap out.
            for (int i = 0; i < PlayerInventory.SlotCount; i++)
            {
                _inventory.Pickup(_rifle, null, 1, 30, out _);
            }

            _inventory.Select(PlayerInventory.PickaxeSlot);
            Assert.AreEqual(-1, _inventory.Pickup(_shotgun, null, 1, 5, out _));
        }

        [Test]
        public void ConsumablesStackUpToTheirLimit()
        {
            _inventory.Pickup(_bandage, null, 3, 0, out _);
            _inventory.Pickup(_bandage, null, 2, 0, out _);

            Assert.AreEqual(5, _inventory.Slots[0].Count);
            Assert.IsTrue(_inventory.Slots[1].IsEmpty, "Five fits in one stack");
        }

        [Test]
        public void OverflowStartsASecondStack()
        {
            _inventory.Pickup(_bandage, null, 5, 0, out _);
            _inventory.Pickup(_bandage, null, 3, 0, out _);

            Assert.AreEqual(5, _inventory.Slots[0].Count);
            Assert.AreEqual(3, _inventory.Slots[1].Count);
        }

        [Test]
        public void ConsumingEmptiesTheSlotOnTheLastItem()
        {
            _inventory.Pickup(_bandage, null, 2, 0, out _);

            Assert.IsTrue(_inventory.TryConsume(0));
            Assert.AreEqual(1, _inventory.Slots[0].Count);

            Assert.IsTrue(_inventory.TryConsume(0));
            Assert.IsTrue(_inventory.Slots[0].IsEmpty);

            Assert.IsFalse(_inventory.TryConsume(0));
        }

        [Test]
        public void SwappingSlotsExchangesTheirContents()
        {
            _inventory.Pickup(_rifle, null, 1, 30, out _);
            _inventory.Pickup(_shotgun, null, 1, 5, out _);

            Assert.IsTrue(_inventory.TrySwap(0, 1));
            Assert.AreEqual(_shotgun, _inventory.Slots[0].Item);
            Assert.AreEqual(_rifle, _inventory.Slots[1].Item);
        }

        [Test]
        public void AmmoIsCountersNotSlots()
        {
            // Ammo occupying slots would turn every loot decision into an
            // accounting exercise.
            _inventory.AddAmmo(AmmoType.Medium, 120);
            _inventory.AddAmmo(AmmoType.Shell, 24);

            Assert.AreEqual(120, _inventory.GetAmmo(AmmoType.Medium));
            Assert.AreEqual(24, _inventory.GetAmmo(AmmoType.Shell));
            Assert.AreEqual(0, _inventory.GetAmmo(AmmoType.Heavy));
            Assert.AreEqual(0, _inventory.FirstFreeSlot(), "Ammo consumed no slots");
        }

        [Test]
        public void ConsumingMoreAmmoThanHeldIsRefused()
        {
            _inventory.AddAmmo(AmmoType.Light, 10);
            Assert.IsFalse(_inventory.TryConsumeAmmo(AmmoType.Light, 11));
            Assert.AreEqual(10, _inventory.GetAmmo(AmmoType.Light));

            Assert.IsTrue(_inventory.TryConsumeAmmo(AmmoType.Light, 10));
            Assert.AreEqual(0, _inventory.GetAmmo(AmmoType.Light));
        }

        [Test]
        public void MeleeWeaponsNeverNeedAmmo()
        {
            Assert.AreEqual(int.MaxValue, _inventory.GetAmmo(AmmoType.None));
            Assert.IsTrue(_inventory.TryConsumeAmmo(AmmoType.None, 9999));
        }

        [Test]
        public void DeathDropsTheWholeInventoryWithExactState()
        {
            _inventory.Pickup(_rifle, null, 1, 13, out _);
            _inventory.Pickup(_bandage, null, 4, 0, out _);

            var drop = new List<InventorySlot>();
            _inventory.CollectDeathDrop(drop);

            Assert.AreEqual(2, drop.Count);
            Assert.AreEqual(13, drop[0].AmmoInMagazine);
            Assert.AreEqual(4, drop[1].Count);
        }
    }

    public sealed class LootSpawnerTests
    {
        private readonly List<RarityBlueprint> _rarities = new List<RarityBlueprint>();
        private WeaponBlueprint _weapon;
        private DamageProfileBlueprint _profile;
        private LootTableBlueprint _table;
        private PoiBlueprint _poi;

        [SetUp]
        public void SetUp()
        {
            // The GDD 6.1 floor distribution.
            (string Name, int Tier, float Weight)[] spec =
            {
                ("Common", 0, 50f), ("Uncommon", 1, 30f), ("Rare", 2, 14f),
                ("Epic", 3, 5f), ("Legendary", 4, 1f),
            };

            foreach ((string name, int tier, float weight) in spec)
            {
                var rarity = TestBlueprints.Create<RarityBlueprint>(new Dictionary<string, object>
                {
                    { "_tier", tier },
                    { "_lootWeight", weight },
                    { "_damageMultiplier", 1f + tier * 0.05f },
                });
                rarity.name = name;
                _rarities.Add(rarity);
            }

            _profile = TestBlueprints.Create<DamageProfileBlueprint>(
                new Dictionary<string, object> { { "_baseDamage", 30f } });

            _weapon = TestBlueprints.Create<WeaponBlueprint>(new Dictionary<string, object>
            {
                { "_damageProfile", _profile },
                { "_ammoType", AmmoType.Medium },
                { "_magazineSize", 30 },
            });

            var entry = new LootEntry();
            TestBlueprints.SetPrivateFields(entry, new Dictionary<string, object>
            {
                { "_kind", LootEntryKind.Item },
                { "_item", _weapon },
                { "_weight", 1f },
                { "_countRange", IntRange.Single(1) },
            });

            _table = TestBlueprints.Create<LootTableBlueprint>(new Dictionary<string, object>
            {
                { "_entries", new List<LootEntry> { entry } },
                { "_rollCount", IntRange.Single(1) },
                { "_allowDuplicates", true },
                { "_rarityBias", 0 },
            });

            _poi = TestBlueprints.Create<PoiBlueprint>(new Dictionary<string, object>
            {
                { "_chestSpawnPoints", 6 },
                { "_chestSpawnChance", 1f },
                { "_floorLootCount", new IntRange(4, 4) },
                { "_chestTable", _table },
                { "_floorTable", _table },
                { "_sceneName", "Test" },
            });
        }

        [TearDown]
        public void TearDown()
        {
            foreach (RarityBlueprint rarity in _rarities)
            {
                Object.DestroyImmediate(rarity);
            }

            _rarities.Clear();
            foreach (Object asset in new Object[] { _poi, _table, _weapon, _profile })
            {
                Object.DestroyImmediate(asset);
            }
        }

        [Test]
        public void SpawningIsReproducibleFromTheMatchSeed()
        {
            // A whole match's loot reproducible from its seed is what makes a
            // report about one specific match investigable.
            var first = new List<LootPlacement>();
            var second = new List<LootPlacement>();

            LootSpawner.SpawnPoi(_poi, _rarities, 1234, 0, first);
            LootSpawner.SpawnPoi(_poi, _rarities, 1234, 0, second);

            Assert.AreEqual(first.Count, second.Count);
            for (int i = 0; i < first.Count; i++)
            {
                Assert.AreEqual(first[i].Type, second[i].Type);
                Assert.AreEqual(first[i].Contents.Count, second[i].Contents.Count);
                for (int c = 0; c < first[i].Contents.Count; c++)
                {
                    Assert.AreEqual(first[i].Contents[c].Rarity, second[i].Contents[c].Rarity);
                }
            }
        }

        [Test]
        public void DifferentSeedsProduceDifferentLoot()
        {
            var a = new List<LootPlacement>();
            var b = new List<LootPlacement>();
            LootSpawner.SpawnPoi(_poi, _rarities, 1, 0, a);
            LootSpawner.SpawnPoi(_poi, _rarities, 999, 0, b);

            bool differs = false;
            for (int i = 0; i < Mathf.Min(a.Count, b.Count) && !differs; i++)
            {
                for (int c = 0; c < Mathf.Min(a[i].Contents.Count, b[i].Contents.Count); c++)
                {
                    if (a[i].Contents[c].Rarity != b[i].Contents[c].Rarity)
                    {
                        differs = true;
                        break;
                    }
                }
            }

            Assert.IsTrue(differs, "Two seeds produced identical loot");
        }

        [Test]
        public void EveryGuaranteedChestSpawns()
        {
            var placements = new List<LootPlacement>();
            LootSpawner.SpawnPoi(_poi, _rarities, 7, 0, placements);

            int chests = 0;
            foreach (LootPlacement placement in placements)
            {
                if (placement.Type == LootPlacement.Kind.Chest)
                {
                    chests++;
                }
            }

            Assert.AreEqual(6, chests, "ChestSpawnChance of 1 should spawn every point");
        }

        [Test]
        public void FloorLootHonoursItsCount()
        {
            var placements = new List<LootPlacement>();
            LootSpawner.SpawnPoi(_poi, _rarities, 7, 0, placements);

            int floor = 0;
            foreach (LootPlacement placement in placements)
            {
                if (placement.Type == LootPlacement.Kind.FloorLoot)
                {
                    floor++;
                }
            }

            Assert.AreEqual(4, floor);
        }

        [Test]
        public void RarityDistributionMatchesTheAuthoredWeights()
        {
            // Statistical rather than example-based on purpose: a weighted table
            // that is subtly wrong still produces individually plausible rolls,
            // so only aggregate testing catches it.
            const int samples = 100000;
            var counts = new Dictionary<int, int>();
            var rng = new DeterministicRng(31337);

            for (int i = 0; i < samples; i++)
            {
                RarityBlueprint rolled = LootRoller.RollRarity(_rarities, 0, ref rng);
                counts[rolled.Tier] = counts.TryGetValue(rolled.Tier, out int n) ? n + 1 : 1;
            }

            float[] expected = { 0.50f, 0.30f, 0.14f, 0.05f, 0.01f };
            for (int tier = 0; tier < expected.Length; tier++)
            {
                float actual = counts[tier] / (float)samples;
                Assert.AreEqual(expected[tier], actual, expected[tier] * 0.06f + 0.002f,
                    $"Tier {tier} rolled {actual:P2}, expected {expected[tier]:P2}");
            }
        }

        [Test]
        public void ChestBiasShiftsRarityUpwards()
        {
            const int samples = 20000;
            var rng = new DeterministicRng(4242);

            float unbiased = 0f;
            float biased = 0f;
            for (int i = 0; i < samples; i++)
            {
                unbiased += LootRoller.RollRarity(_rarities, 0, ref rng).Tier;
                biased += LootRoller.RollRarity(_rarities, 1, ref rng).Tier;
            }

            Assert.Greater(biased / samples, unbiased / samples + 0.5f,
                "A chest's +1 bias should raise the mean tier by close to one");
        }

        [Test]
        public void BiasIsClampedAtTheTopTier()
        {
            var rng = new DeterministicRng(5);
            for (int i = 0; i < 500; i++)
            {
                RarityBlueprint rolled = LootRoller.RollRarity(_rarities, 10, ref rng);
                Assert.AreEqual(4, rolled.Tier, "A huge bias should clamp to Legendary");
            }
        }

        [Test]
        public void WeaponsAlwaysComeWithUsableAmmo()
        {
            // A weapon with no ammo is a disappointment, not a decision.
            Assert.GreaterOrEqual(LootSpawner.StartingAmmoFor(_weapon), _weapon.MagazineSize);
        }

        [Test]
        public void ANullPoiSpawnsNothingRatherThanThrowing()
        {
            var placements = new List<LootPlacement>();
            LootSpawner.SpawnPoi(null, _rarities, 1, 0, placements);
            Assert.AreEqual(0, placements.Count);
        }
    }
}
