using System.Collections.Generic;
using NUnit.Framework;
using Tonight.Blueprints.Match;
using Tonight.Core;
using Tonight.Gameplay.Storm;
using UnityEngine;

namespace Tonight.Tests.EditMode
{
    public sealed class StormSimulationTests
    {
        private StormPhaseBlueprint _phase;

        [SetUp]
        public void SetUp()
        {
            _phase = TestBlueprints.Create<StormPhaseBlueprint>(new Dictionary<string, object>
            {
                { "_phaseIndex", 1 },
                { "_waitSeconds", 120f },
                { "_closeSeconds", 120f },
                { "_startRadius", 900f },
                { "_endRadius", 600f },
                { "_damagePerSecond", 1f },
                { "_centreBiasToPlayers", 0.3f },
                { "_maxRotationDistance", -1f },
            });
        }

        [TearDown]
        public void TearDown() => Object.DestroyImmediate(_phase);

        [Test]
        public void RadiusIsFlatThroughTheWaitThenShrinks()
        {
            Assert.AreEqual(900f, _phase.RadiusAt(0f), 1e-3f);
            Assert.AreEqual(900f, _phase.RadiusAt(120f), 1e-3f);
            Assert.AreEqual(750f, _phase.RadiusAt(180f), 1e-3f);
            Assert.AreEqual(600f, _phase.RadiusAt(240f), 1e-3f);
            Assert.AreEqual(600f, _phase.RadiusAt(9999f), 1e-3f);
        }

        [Test]
        public void RadiusIsMonotonicDecreasing()
        {
            float previous = float.MaxValue;
            for (float t = 0f; t <= 300f; t += 1f)
            {
                float radius = _phase.RadiusAt(t);
                Assert.LessOrEqual(radius, previous + 1e-4f, $"Radius grew at t={t}");
                previous = radius;
            }
        }

        [Test]
        public void MaxRotationDistanceResolvesFromSprintSpeed()
        {
            // -1 means "auto": a full sprint through the close, plus 10%.
            Assert.AreEqual(7.4f * 120f * 1.1f, _phase.ResolveMaxRotationDistance(7.4f), 1e-2f);
        }

        [Test]
        public void NextCentreStaysInsideTheCurrentCircle()
        {
            var rng = new DeterministicRng(1234);
            var players = new List<Vector2> { new Vector2(100f, 0f), new Vector2(-50f, 30f) };

            for (int i = 0; i < 200; i++)
            {
                Vector2 centre = StormSimulation.ChooseNextCentre(
                    _phase, Vector2.zero, 900f, 600f, players, 7.4f, ref rng, out _);

                // The next circle must fit entirely inside the current one.
                Assert.LessOrEqual(centre.magnitude, 900f - 600f + 1e-2f,
                    $"Iteration {i}: next circle escaped the current one");
            }
        }

        [Test]
        public void RotationClampKeepsEveryPlayerAbleToReachSafety()
        {
            var rng = new DeterministicRng(77);
            float maxDistance = _phase.ResolveMaxRotationDistance(7.4f);

            for (int i = 0; i < 100; i++)
            {
                // Survivors scattered within the current circle.
                var players = new List<Vector2>();
                for (int p = 0; p < 8; p++)
                {
                    float angle = rng.NextFloat() * Mathf.PI * 2f;
                    float radius = Mathf.Sqrt(rng.NextFloat()) * 900f;
                    players.Add(new Vector2(Mathf.Cos(angle) * radius, Mathf.Sin(angle) * radius));
                }

                Vector2 centre = StormSimulation.ChooseNextCentre(
                    _phase, Vector2.zero, 900f, 600f, players, 7.4f, ref rng, out bool impossible);

                if (impossible)
                {
                    // A spread wider than the circle can span is a map-design
                    // problem; the contract is that it is reported, not hidden.
                    continue;
                }

                foreach (Vector2 player in players)
                {
                    float toEdge = Vector2.Distance(player, centre) - 600f;
                    Assert.LessOrEqual(toEdge, maxDistance + 1f,
                        $"Iteration {i}: a player was stranded {toEdge:F1} m from safety, " +
                        $"beyond the {maxDistance:F1} m clamp");
                }
            }
        }

        [Test]
        public void CentreChoiceIsReproducibleFromItsSeed()
        {
            var players = new List<Vector2> { new Vector2(200f, 100f) };

            var rngA = new DeterministicRng(555);
            Vector2 a = StormSimulation.ChooseNextCentre(
                _phase, Vector2.zero, 900f, 600f, players, 7.4f, ref rngA, out _);

            var rngB = new DeterministicRng(555);
            Vector2 b = StormSimulation.ChooseNextCentre(
                _phase, Vector2.zero, 900f, 600f, players, 7.4f, ref rngB, out _);

            Assert.AreEqual(a.x, b.x, 1e-5f);
            Assert.AreEqual(a.y, b.y, 1e-5f);
        }

        [Test]
        public void StormDamageIgnoresShieldByReturningARawAmount()
        {
            Assert.AreEqual(5f, StormSimulation.DamageForInterval(_phase, 5f), 1e-4f);
            Assert.AreEqual(0f, StormSimulation.DamageForInterval(_phase, -5f), 1e-4f);
        }
    }
}
