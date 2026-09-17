using System.Collections.Generic;
using NUnit.Framework;
using Tonight.Blueprints.Combat;
using Tonight.Gameplay.Combat;
using UnityEngine;

namespace Tonight.Tests.EditMode
{
    public sealed class DamageCalculatorTests
    {
        private DamageProfileBlueprint _profile;

        [SetUp]
        public void SetUp()
        {
            _profile = TestBlueprints.Create<DamageProfileBlueprint>(new Dictionary<string, object>
            {
                { "_baseDamage", 30f },
                { "_headshotMultiplier", 2f },
                { "_structureMultiplier", 1.6f },
                { "_falloffStartMetres", 40f },
                { "_falloffEndMetres", 80f },
                { "_falloffEndDamageScale", 0.5f },
                { "_shieldPenetration", 0f },
            });
        }

        [TearDown]
        public void TearDown() => Object.DestroyImmediate(_profile);

        [Test]
        public void Falloff_IsFlatThenLinearThenFlat()
        {
            Assert.AreEqual(1f, _profile.FalloffAt(0f), 1e-4f);
            Assert.AreEqual(1f, _profile.FalloffAt(40f), 1e-4f);
            Assert.AreEqual(0.75f, _profile.FalloffAt(60f), 1e-4f);
            Assert.AreEqual(0.5f, _profile.FalloffAt(80f), 1e-4f);
            Assert.AreEqual(0.5f, _profile.FalloffAt(500f), 1e-4f);
        }

        [Test]
        public void Falloff_IsMonotonicThroughTheBand()
        {
            float previous = float.MaxValue;
            for (float d = 0f; d <= 120f; d += 1f)
            {
                float current = _profile.FalloffAt(d);
                Assert.LessOrEqual(current, previous + 1e-5f,
                    $"Falloff increased with distance at {d} m");
                previous = current;
            }
        }

        [Test]
        public void StructureMultiplier_AppliesOnlyToStructures()
        {
            var atPlayer = new HitContext(_profile, null, null, HitTargetKind.Player, 0f);
            var atStructure = new HitContext(_profile, null, null, HitTargetKind.Structure, 0f);

            Assert.AreEqual(30f, DamageCalculator.Compute(atPlayer), 1e-3f);
            Assert.AreEqual(48f, DamageCalculator.Compute(atStructure), 1e-3f);
        }

        [Test]
        public void Split_ShieldAbsorbsFirstAndOverflowsToHealth()
        {
            DamageResult result = DamageCalculator.Split(50f, 30f, 100f, 0f);
            Assert.AreEqual(30f, result.ToShield, 1e-4f);
            Assert.AreEqual(20f, result.ToHealth, 1e-4f);
        }

        [Test]
        public void Split_NeverExceedsEitherPool()
        {
            // A caller subtracting these must never be able to drive a pool
            // negative, whatever the incoming damage.
            DamageResult result = DamageCalculator.Split(10000f, 30f, 40f, 0f);
            Assert.AreEqual(30f, result.ToShield, 1e-4f);
            Assert.AreEqual(40f, result.ToHealth, 1e-4f);
        }

        [Test]
        public void Split_PenetrationBypassesShield()
        {
            DamageResult full = DamageCalculator.Split(50f, 100f, 100f, 1f);
            Assert.AreEqual(0f, full.ToShield, 1e-4f);
            Assert.AreEqual(50f, full.ToHealth, 1e-4f);

            DamageResult half = DamageCalculator.Split(50f, 100f, 100f, 0.5f);
            Assert.AreEqual(25f, half.ToShield, 1e-4f);
            Assert.AreEqual(25f, half.ToHealth, 1e-4f);
        }

        [Test]
        public void Split_ZeroAndNegativeDamageAreNoOps()
        {
            Assert.AreEqual(0f, DamageCalculator.Split(0f, 50f, 50f, 0f).Total, 1e-6f);
            Assert.AreEqual(0f, DamageCalculator.Split(-10f, 50f, 50f, 0f).Total, 1e-6f);
        }
    }
}
