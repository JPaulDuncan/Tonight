using System.Collections.Generic;
using NUnit.Framework;
using Tonight.Blueprints;
using Tonight.Blueprints.Building;
using Tonight.Blueprints.Character;
using Tonight.Blueprints.Match;
using UnityEngine;

namespace Tonight.Tests.EditMode
{
    /// <summary>
    /// Validation is the safety net that replaces compile-time checking when
    /// content moves out of code and into assets. These tests check the net.
    /// </summary>
    public sealed class BlueprintValidationTests
    {
        private static bool HasError(BlueprintValidationContext ctx) => ctx.HasErrors;

        [Test]
        public void BuildMaterial_RejectsAHealthRampThatWeakensOverTime()
        {
            var material = TestBlueprints.Create<BuildMaterialBlueprint>(new Dictionary<string, object>
            {
                { "_buildHealth", 150f },
                { "_fullHealth", 90f },
                { "_buildTimeSeconds", 3f },
                { "_costPerPiece", 10 },
                { "_maxCarried", 500 },
            });

            Assert.IsTrue(HasError(TestBlueprints.Validate(material)));
            Object.DestroyImmediate(material);
        }

        [Test]
        public void BuildMaterial_HealthRampIsExactAtBothEndsAndMonotonic()
        {
            var material = TestBlueprints.Create<BuildMaterialBlueprint>(new Dictionary<string, object>
            {
                { "_buildHealth", 90f },
                { "_fullHealth", 150f },
                { "_buildTimeSeconds", 3f },
            });

            Assert.AreEqual(90f, material.HealthAtAge(0f), 1e-3f);
            Assert.AreEqual(150f, material.HealthAtAge(3f), 1e-3f);
            Assert.AreEqual(150f, material.HealthAtAge(99f), 1e-3f);
            Assert.AreEqual(120f, material.HealthAtAge(1.5f), 1e-3f);

            float previous = -1f;
            for (float t = 0f; t <= 3f; t += 0.1f)
            {
                float hp = material.HealthAtAge(t);
                Assert.GreaterOrEqual(hp, previous, $"Health ramp decreased at t={t}");
                previous = hp;
            }

            Object.DestroyImmediate(material);
        }

        [Test]
        public void Movement_RejectsPositiveGravityAndInvertedSpeeds()
        {
            var movement = TestBlueprints.Create<MovementBlueprint>(new Dictionary<string, object>
            {
                { "_walkSpeed", 4.6f },
                { "_sprintSpeed", 2f },
                { "_gravity", 9.81f },
            });

            BlueprintValidationContext ctx = TestBlueprints.Validate(movement);
            Assert.IsTrue(ctx.HasErrors);
            Assert.GreaterOrEqual(ctx.Messages.Count, 2);
            Object.DestroyImmediate(movement);
        }

        [Test]
        public void Movement_ContinuousJumpVelocityMatchesTheTextbookFormula()
        {
            var movement = TestBlueprints.Create<MovementBlueprint>(new Dictionary<string, object>
            {
                { "_jumpHeight", 1.1f },
                { "_gravity", -22f },
            });

            float apex = movement.JumpVelocityContinuous * movement.JumpVelocityContinuous
                         / (2f * 22f);
            Assert.AreEqual(1.1f, apex, 1e-4f);
            Object.DestroyImmediate(movement);
        }

        [Test]
        public void Movement_TickCorrectedJumpActuallyReachesTheAuthoredHeight()
        {
            // The continuous formula undershoots in a discrete simulation: at
            // 30 Hz an authored 1.1 m jump peaks at 0.99 m. A Blueprint field
            // that does not mean what it says defeats the point of authoring
            // values as data, so the correction is verified at three tick rates.
            var movement = TestBlueprints.Create<MovementBlueprint>(new Dictionary<string, object>
            {
                { "_jumpHeight", 1.1f },
                { "_gravity", -22f },
                { "_terminalVelocity", 55f },
            });

            foreach (float dt in new[] { 1f / 20f, 1f / 30f, 1f / 60f })
            {
                float y = 0f;
                float vy = movement.JumpVelocityForTick(dt);
                float apex = 0f;

                for (int i = 0; i < 1000; i++)
                {
                    vy += movement.Gravity * dt;
                    y += vy * dt;
                    if (y <= 0f)
                    {
                        break;
                    }

                    apex = Mathf.Max(apex, y);
                }

                Assert.AreEqual(1.1f, apex, 0.01f,
                    $"Jump apex at {1f / dt:F0} Hz was {apex:F4} m");
            }

            Object.DestroyImmediate(movement);
        }

        [Test]
        public void Movement_FallDamageIsZeroAtThresholdAndLinearAbove()
        {
            var movement = TestBlueprints.Create<MovementBlueprint>(new Dictionary<string, object>
            {
                { "_fallDamageThreshold", 3.5f },
                { "_fallDamagePerMetre", 10f },
            });

            Assert.AreEqual(0f, movement.FallDamageFor(0f), 1e-4f);
            Assert.AreEqual(0f, movement.FallDamageFor(3.5f), 1e-4f);
            Assert.AreEqual(15f, movement.FallDamageFor(5f), 1e-4f);
            Assert.AreEqual(100f, movement.FallDamageFor(13.5f), 1e-4f);
            Object.DestroyImmediate(movement);
        }

        [Test]
        public void MatchLighting_RejectsAZeroVisibilityFloor()
        {
            // A zero here is what would turn deep night into an accidental
            // stealth mechanic, which the GDD forbids outright.
            var lighting = TestBlueprints.Create<MatchLightingBlueprint>(new Dictionary<string, object>
            {
                { "_minPlayerRimIntensity", 0f },
                { "_keyframesByPhase", new List<LightingKeyframe> { new LightingKeyframe() } },
            });

            Assert.IsTrue(HasError(TestBlueprints.Validate(lighting)));
            Object.DestroyImmediate(lighting);
        }

        [Test]
        public void MatchRules_RejectAPlayerCountThatLeavesAShortSquad()
        {
            var rules = TestBlueprints.Create<MatchRulesBlueprint>(new Dictionary<string, object>
            {
                { "_squadSize", 3 },
                { "_maxPlayers", 100 },
            });

            Assert.IsTrue(HasError(TestBlueprints.Validate(rules)));
            Object.DestroyImmediate(rules);
        }

        [Test]
        public void EditVariant_MaskPacksToAStableKey()
        {
            // A doorway: the middle and bottom-middle cells cut away.
            var doorway = new[] { true, true, true, true, false, true, true, false, true };
            var window = new[] { true, true, true, true, false, true, true, true, true };

            int doorwayKey = EditVariant.PackMask(doorway);
            int windowKey = EditVariant.PackMask(window);

            Assert.AreNotEqual(doorwayKey, windowKey);
            Assert.AreEqual(doorwayKey, EditVariant.PackMask(doorway), "Packing is not stable");
            Assert.AreEqual(0b111_111_111, EditVariant.PackMask(
                new[] { true, true, true, true, true, true, true, true, true }));
        }
    }
}
