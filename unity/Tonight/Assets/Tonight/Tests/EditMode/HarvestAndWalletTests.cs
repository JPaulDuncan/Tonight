using System.Collections.Generic;
using NUnit.Framework;
using Tonight.Blueprints.Building;
using Tonight.Blueprints.World;
using Tonight.Gameplay.Harvesting;
using Tonight.Gameplay.Inventory;
using UnityEngine;

namespace Tonight.Tests.EditMode
{
    public sealed class HarvestAndWalletTests
    {
        private BuildMaterialBlueprint _wood;
        private HarvestableBlueprint _tree;

        [SetUp]
        public void SetUp()
        {
            _wood = TestBlueprints.Create<BuildMaterialBlueprint>(new Dictionary<string, object>
            {
                { "_materialKind", BuildMaterialKind.Wood },
                { "_buildHealth", 90f },
                { "_fullHealth", 150f },
                { "_buildTimeSeconds", 3f },
                { "_costPerPiece", 10 },
                { "_maxCarried", 500 },
            });

            // docs/systems/harvesting.md section 3.
            _tree = TestBlueprints.Create<HarvestableBlueprint>(new Dictionary<string, object>
            {
                { "_material", _wood },
                { "_totalHealth", 300f },
                { "_yieldPerHit", 12 },
                { "_bonusYieldOnWeakPoint", 12 },
                { "_yieldOnDestroy", 30 },
                { "_respawnSeconds", -1f },
            });
        }

        [TearDown]
        public void TearDown()
        {
            Object.DestroyImmediate(_tree);
            Object.DestroyImmediate(_wood);
        }

        [Test]
        public void WeakPointIsDeterministicForTheSameObjectAndHit()
        {
            // Client and server must agree on the marker without replicating it.
            Assert.AreEqual(
                HarvestSimulation.WeakPointFor(77, 3),
                HarvestSimulation.WeakPointFor(77, 3));
        }

        [Test]
        public void WeakPointMovesBetweenHits()
        {
            Assert.AreNotEqual(
                HarvestSimulation.WeakPointFor(77, 3),
                HarvestSimulation.WeakPointFor(77, 4));
        }

        [Test]
        public void WeakPointDiffersBetweenObjects()
        {
            Assert.AreNotEqual(
                HarvestSimulation.WeakPointFor(1, 0),
                HarvestSimulation.WeakPointFor(2, 0));
        }

        [Test]
        public void WeakPointStaysInsetFromTheSurfaceEdges()
        {
            // A marker half off the mesh would be unhittable.
            for (int objectId = 0; objectId < 50; objectId++)
            {
                for (int hit = 0; hit < 10; hit++)
                {
                    Vector2 point = HarvestSimulation.WeakPointFor(objectId, hit);
                    Assert.GreaterOrEqual(point.x, 0.15f);
                    Assert.LessOrEqual(point.x, 0.85f);
                    Assert.GreaterOrEqual(point.y, 0.15f);
                    Assert.LessOrEqual(point.y, 0.85f);
                }
            }
        }

        [Test]
        public void HittingTheWeakPointYieldsTheBonus()
        {
            var state = HarvestState.For(5, _tree);
            Vector2 marker = HarvestSimulation.WeakPointFor(5, 0);

            HarvestHitResult result = HarvestSimulation.Hit(ref state, _tree, 30f, marker);

            Assert.IsTrue(result.HitWeakPoint);
            Assert.AreEqual(24, result.Yield, "12 base + 12 bonus");
        }

        [Test]
        public void MissingTheWeakPointYieldsOnlyTheBase()
        {
            var state = HarvestState.For(5, _tree);
            Vector2 marker = HarvestSimulation.WeakPointFor(5, 0);
            // Far corner from the marker, guaranteed outside the radius.
            var miss = new Vector2(marker.x > 0.5f ? 0.0f : 1.0f, marker.y > 0.5f ? 0.0f : 1.0f);

            HarvestHitResult result = HarvestSimulation.Hit(ref state, _tree, 30f, miss);

            Assert.IsFalse(result.HitWeakPoint);
            Assert.AreEqual(12, result.Yield);
        }

        [Test]
        public void DestroyingTheObjectAddsTheDestroyBonusOnce()
        {
            var state = HarvestState.For(5, _tree);
            int destroyEvents = 0;

            for (int i = 0; i < 40 && !state.Destroyed; i++)
            {
                HarvestHitResult result = HarvestSimulation.Hit(ref state, _tree, 30f, Vector2.zero);
                if (result.Destroyed)
                {
                    destroyEvents++;
                }
            }

            Assert.IsTrue(state.Destroyed);
            Assert.AreEqual(1, destroyEvents);

            // Further swings on a destroyed object yield nothing.
            HarvestHitResult after = HarvestSimulation.Hit(ref state, _tree, 30f, Vector2.zero);
            Assert.AreEqual(0, after.Yield);
        }

        [Test]
        public void HealthNeverGoesNegative()
        {
            var state = HarvestState.For(5, _tree);
            HarvestSimulation.Hit(ref state, _tree, 99999f, Vector2.zero);
            Assert.AreEqual(0f, state.Health);
        }

        private const float SwingsPerSecond = 1.4f;
        private const float PickaxeDamage = 30f;

        [Test]
        public void GatheringABoxWorthOfWoodMatchesTheGddLoopTimings()
        {
            // GDD 2.1: 40 wood (a 1x1 box) in 1.4-2.9 s depending on weak points.
            float withMarkers = SecondsToGather(40, hitWeakPoints: true);
            float withoutMarkers = SecondsToGather(40, hitWeakPoints: false);

            Assert.AreEqual(1.43f, withMarkers, 0.05f);
            Assert.AreEqual(2.86f, withoutMarkers, 0.05f);
        }

        [Test]
        public void AFullTreeYieldsTheDocumentedRangeInTheDocumentedTime()
        {
            // GDD 2.1 and harvesting.md 3: 10 swings, 7.1 s, 150-270 wood.
            var best = HarvestState.For(9, _tree);
            var worst = HarvestState.For(9, _tree);
            int bestTotal = 0;
            int worstTotal = 0;
            int swings = 0;

            while (!best.Destroyed && swings < 100)
            {
                Vector2 marker = HarvestSimulation.WeakPointFor(9, best.HitCount);
                bestTotal += HarvestSimulation.Hit(ref best, _tree, PickaxeDamage, marker).Yield;

                Vector2 far = HarvestSimulation.WeakPointFor(9, worst.HitCount);
                var miss = new Vector2(far.x > 0.5f ? 0f : 1f, far.y > 0.5f ? 0f : 1f);
                worstTotal += HarvestSimulation.Hit(ref worst, _tree, PickaxeDamage, miss).Yield;

                swings++;
            }

            Assert.AreEqual(10, swings, "300 HP at 30 damage is 10 swings");
            Assert.AreEqual(7.14f, swings / SwingsPerSecond, 0.05f);
            Assert.AreEqual(150, worstTotal, "Every weak point missed");
            Assert.AreEqual(270, bestTotal, "Every weak point hit");
        }

        private float SecondsToGather(int needed, bool hitWeakPoints)
        {
            var state = HarvestState.For(9, _tree);
            int total = 0;
            int swings = 0;

            while (total < needed && swings < 200)
            {
                Vector2 marker = HarvestSimulation.WeakPointFor(9, state.HitCount);
                Vector2 point = hitWeakPoints
                    ? marker
                    : new Vector2(marker.x > 0.5f ? 0f : 1f, marker.y > 0.5f ? 0f : 1f);

                total += HarvestSimulation.Hit(ref state, _tree, PickaxeDamage, point).Yield;
                swings++;
            }

            return swings / SwingsPerSecond;
        }

        [Test]
        public void MissingEveryWeakPointIsMeaningfullySlower()
        {
            // The weak point must be worth aiming for, or harvesting is a
            // hold-to-fill bar with extra steps.
            var hitting = HarvestState.For(9, _tree);
            var missing = HarvestState.For(9, _tree);

            int hitTotal = 0;
            int missTotal = 0;
            for (int i = 0; i < 5; i++)
            {
                Vector2 marker = HarvestSimulation.WeakPointFor(9, hitting.HitCount);
                hitTotal += HarvestSimulation.Hit(ref hitting, _tree, 30f, marker).Yield;

                Vector2 far = HarvestSimulation.WeakPointFor(9, missing.HitCount);
                var miss = new Vector2(far.x > 0.5f ? 0f : 1f, far.y > 0.5f ? 0f : 1f);
                missTotal += HarvestSimulation.Hit(ref missing, _tree, 30f, miss).Yield;
            }

            Assert.AreEqual(hitTotal, missTotal * 2, "Weak point should double the yield");
        }
    }

    public sealed class MaterialWalletTests
    {
        private BuildMaterialBlueprint _wood;

        [SetUp]
        public void SetUp()
        {
            _wood = TestBlueprints.Create<BuildMaterialBlueprint>(new Dictionary<string, object>
            {
                { "_materialKind", BuildMaterialKind.Wood },
                { "_costPerPiece", 10 },
                { "_maxCarried", 500 },
            });
        }

        [TearDown]
        public void TearDown() => Object.DestroyImmediate(_wood);

        [Test]
        public void AddRespectsTheCarryCap()
        {
            var wallet = new MaterialWallet();
            Assert.AreEqual(500, wallet.Add(_wood, 900));
            Assert.AreEqual(500, wallet.Wood);
            Assert.AreEqual(0, wallet.Add(_wood, 100), "At cap, nothing more is gained");
        }

        [Test]
        public void SpendingRequiresAffordability()
        {
            var wallet = new MaterialWallet();
            wallet.Add(_wood, 15);

            Assert.IsTrue(wallet.TrySpend(_wood, 10));
            Assert.AreEqual(5, wallet.Wood);
            Assert.IsFalse(wallet.TrySpend(_wood, 10));
            Assert.AreEqual(5, wallet.Wood, "A failed spend must change nothing");
        }

        [Test]
        public void RefundRestoresExactlyWhatWasDeducted()
        {
            var wallet = new MaterialWallet();
            wallet.Add(_wood, 500);
            wallet.TrySpend(_wood, 10);
            wallet.Refund(_wood, 10);

            // Deliberately not clamped to the cap: a player at cap would
            // otherwise lose materials by having a placement rejected.
            Assert.AreEqual(500, wallet.Wood);
        }

        [Test]
        public void MaterialsAreTrackedIndependently()
        {
            var stone = TestBlueprints.Create<BuildMaterialBlueprint>(new Dictionary<string, object>
            {
                { "_materialKind", BuildMaterialKind.Stone },
                { "_maxCarried", 500 },
            });

            var wallet = new MaterialWallet();
            wallet.Add(_wood, 100);
            wallet.Add(stone, 50);

            Assert.AreEqual(100, wallet.Wood);
            Assert.AreEqual(50, wallet.Stone);
            Assert.AreEqual(0, wallet.Metal);

            Object.DestroyImmediate(stone);
        }
    }
}
