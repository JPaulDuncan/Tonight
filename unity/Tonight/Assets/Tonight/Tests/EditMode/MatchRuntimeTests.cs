using System.Collections.Generic;
using NUnit.Framework;
using Tonight.Blueprints.Match;
using Tonight.Gameplay.Match;
using Tonight.Gameplay.Storm;
using UnityEngine;

namespace Tonight.Tests.EditMode
{
    /// <summary>The GDD section 7 schedule, which the seed assets also carry.</summary>
    internal static class StormFixture
    {
        internal static readonly (int Index, float Wait, float Close, float Start, float End,
            float Dps, float Bias)[] Schedule =
        {
            (0, 165f, 120f, 1400f, 900f, 1f, 0.15f),
            (1, 90f, 90f, 900f, 600f, 1f, 0.20f),
            (2, 75f, 70f, 600f, 400f, 2f, 0.25f),
            (3, 60f, 55f, 400f, 250f, 5f, 0.30f),
            (4, 45f, 45f, 250f, 150f, 7f, 0.35f),
            (5, 35f, 35f, 150f, 80f, 10f, 0.40f),
            (6, 30f, 30f, 80f, 30f, 10f, 0.45f),
            (7, 20f, 35f, 30f, 0f, 10f, 0.50f),
        };

        internal static List<StormPhaseBlueprint> Create()
        {
            var phases = new List<StormPhaseBlueprint>();
            foreach ((int index, float wait, float close, float start, float end, float dps,
                      float bias) in Schedule)
            {
                phases.Add(TestBlueprints.Create<StormPhaseBlueprint>(
                    new Dictionary<string, object>
                    {
                        { "_phaseIndex", index },
                        { "_waitSeconds", wait },
                        { "_closeSeconds", close },
                        { "_startRadius", start },
                        { "_endRadius", end },
                        { "_damagePerSecond", dps },
                        { "_centreBiasToPlayers", bias },
                        { "_maxRotationDistance", -1f },
                    }));
            }

            return phases;
        }

        internal static void Destroy(List<StormPhaseBlueprint> phases)
        {
            foreach (StormPhaseBlueprint phase in phases)
            {
                Object.DestroyImmediate(phase);
            }

            phases.Clear();
        }
    }

    public sealed class StormDirectorTests
    {
        private List<StormPhaseBlueprint> _phases;

        [SetUp]
        public void SetUp() => _phases = StormFixture.Create();

        [TearDown]
        public void TearDown() => StormFixture.Destroy(_phases);

        private StormDirector Director(int seed = 1234) =>
            new StormDirector(_phases, seed, sprintSpeed: 7.4f, mapCentre: Vector2.zero);

        [Test]
        public void TotalMatchLengthMatchesTheGddSchedule()
        {
            // 16:40 of storm. The GDD table, the seed assets and this test all
            // have to agree, so all three are derived from the same numbers.
            Assert.AreEqual(1000f, Director().TotalSeconds, 0.01f);
        }

        [Test]
        public void PhasesAdvanceInOrderAndThenFinish()
        {
            StormDirector director = Director();
            var players = new List<Vector2> { Vector2.zero };

            for (int phase = 0; phase < StormFixture.Schedule.Length; phase++)
            {
                Assert.AreEqual(phase, director.PhaseIndex);
                director.Advance(StormFixture.Schedule[phase].Wait +
                                 StormFixture.Schedule[phase].Close + 0.001f, players);
            }

            Assert.IsTrue(director.Finished);
        }

        [Test]
        public void RadiusShrinksMonotonicallyAcrossTheWholeMatch()
        {
            StormDirector director = Director();
            var players = new List<Vector2> { Vector2.zero };
            float previous = float.MaxValue;

            for (float elapsed = 0f; elapsed < 1100f; elapsed += 1f)
            {
                float radius = director.Current.Radius;
                if (!director.Finished)
                {
                    Assert.LessOrEqual(radius, previous + 0.01f,
                        $"Radius grew at {elapsed:F0}s");
                    previous = radius;
                }

                director.Advance(1f, players);
            }

            Assert.IsTrue(director.Finished);
        }

        [Test]
        public void TheStormWaitsBeforeItCloses()
        {
            StormDirector director = Director();
            var players = new List<Vector2> { Vector2.zero };

            Assert.IsFalse(director.Current.IsClosing);
            Assert.AreEqual(1400f, director.Current.Radius, 0.01f);

            director.Advance(164f, players);
            Assert.IsFalse(director.Current.IsClosing, "Still waiting one second before the close");
            Assert.AreEqual(1400f, director.Current.Radius, 0.01f);

            director.Advance(2f, players);
            Assert.IsTrue(director.Current.IsClosing);
        }

        [Test]
        public void DamageOnlyAppliesOutsideTheCircle()
        {
            StormDirector director = Director();
            director.Advance(1f, new List<Vector2> { Vector2.zero });

            Assert.AreEqual(0f, director.DamageFor(Vector2.zero, 1f), 0.001f);
            Assert.Greater(director.DamageFor(new Vector2(5000f, 0f), 1f), 0f);
        }

        [Test]
        public void DamageScalesWithTheAuthoredRate()
        {
            StormDirector director = Director();
            var far = new Vector2(9000f, 0f);

            // Phase 0 is 1 DPS.
            Assert.AreEqual(2f, director.DamageFor(far, 2f), 0.001f);
        }

        [Test]
        public void ProgressRunsFromZeroToOne()
        {
            StormDirector director = Director();
            var players = new List<Vector2> { Vector2.zero };

            Assert.AreEqual(0f, director.Progress, 0.001f);

            for (int i = 0; i < 500; i++)
            {
                director.Advance(1f, players);
            }

            Assert.Greater(director.Progress, 0.4f);
            Assert.Less(director.Progress, 0.6f);

            for (int i = 0; i < 600; i++)
            {
                director.Advance(1f, players);
            }

            Assert.AreEqual(1f, director.Progress, 0.01f);
        }

        [Test]
        public void TheSameSeedProducesTheSameCircles()
        {
            var players = new List<Vector2> { new Vector2(200f, -150f), new Vector2(-90f, 40f) };

            StormDirector a = Director(999);
            StormDirector b = Director(999);

            for (int i = 0; i < 400; i++)
            {
                a.Advance(1f, players);
                b.Advance(1f, players);
                Assert.AreEqual(a.Current.Centre, b.Current.Centre, $"Diverged at {i}s");
            }
        }

        [Test]
        public void NoPlayerIsEverStrandedBeyondTheRotationClamp()
        {
            // The clamp is the difference between a tense rotation and the game
            // appearing to cheat.
            var rng = new Tonight.Core.DeterministicRng(4242);

            for (int trial = 0; trial < 20; trial++)
            {
                StormDirector director = Director(trial);
                var players = new List<Vector2>();
                for (int p = 0; p < 10; p++)
                {
                    float angle = rng.NextFloat() * Mathf.PI * 2f;
                    float radius = Mathf.Sqrt(rng.NextFloat()) * 900f;
                    players.Add(new Vector2(Mathf.Cos(angle) * radius, Mathf.Sin(angle) * radius));
                }

                bool impossible = false;
                director.RotationClampImpossible += _ => impossible = true;

                director.Advance(286f, players);

                if (impossible)
                {
                    // Reported rather than hidden; a spread that wide is a
                    // map-design problem, not a runtime one.
                    continue;
                }

                StormState state = director.Current;
                float maxDistance = _phases[director.PhaseIndex]
                    .ResolveMaxRotationDistance(7.4f);

                foreach (Vector2 player in players)
                {
                    float toEdge = Vector2.Distance(player, state.NextCentre) - state.NextRadius;
                    Assert.LessOrEqual(toEdge, maxDistance + 1f,
                        $"Trial {trial}: a player was stranded {toEdge:F1} m from safety");
                }
            }
        }
    }

    public sealed class MatchFlowTests
    {
        private List<StormPhaseBlueprint> _phases;
        private MatchLightingBlueprint _lighting;
        private MatchRulesBlueprint _rules;

        [SetUp]
        public void SetUp()
        {
            _phases = StormFixture.Create();
            _lighting = TestBlueprints.Create<MatchLightingBlueprint>(
                new Dictionary<string, object>
                {
                    { "_minPlayerRimIntensity", 0.4f },
                    { "_keyframesByPhase", new List<LightingKeyframe> { new LightingKeyframe() } },
                });

            _rules = TestBlueprints.Create<MatchRulesBlueprint>(new Dictionary<string, object>
            {
                { "_squadSize", 1 },
                { "_maxPlayers", 100 },
                { "_stormPhases", _phases },
                { "_lighting", _lighting },
                { "_busSeconds", 45f },
                { "_gliderDeployAltitude", 35f },
            });
        }

        [TearDown]
        public void TearDown()
        {
            Object.DestroyImmediate(_rules);
            Object.DestroyImmediate(_lighting);
            StormFixture.Destroy(_phases);
        }

        [Test]
        public void AFullLobbyStartsImmediately()
        {
            var flow = new MatchFlow(_rules, 1);
            flow.SetPlayersConnected(100);

            Assert.IsTrue(flow.Tick(0.1f));
            Assert.AreEqual(MatchPhase.Bus, flow.Phase);
        }

        [Test]
        public void APartialLobbyStartsOnTheTimeout()
        {
            var flow = new MatchFlow(_rules, 1);
            flow.SetPlayersConnected(37);

            flow.Tick(MatchFlow.LobbyTimeoutSeconds - 1f);
            Assert.AreEqual(MatchPhase.Lobby, flow.Phase);

            flow.Tick(2f);
            Assert.AreEqual(MatchPhase.Bus, flow.Phase);
        }

        [Test]
        public void ALobbyBelowTheMinimumNeverStarts()
        {
            var flow = new MatchFlow(_rules, 1);
            flow.SetPlayersConnected(1);

            flow.Tick(MatchFlow.LobbyTimeoutSeconds * 10f);
            Assert.AreEqual(MatchPhase.Lobby, flow.Phase);
        }

        [Test]
        public void TheFullHappyPathRunsEndToEnd()
        {
            var flow = new MatchFlow(_rules, 1);
            var seen = new List<MatchPhase>();
            flow.PhaseChanged += (_, to) => seen.Add(to);

            flow.SetPlayersConnected(100);
            flow.SetSquadsAlive(100);
            flow.Tick(0.1f);

            flow.Tick(46f);
            Assert.AreEqual(MatchPhase.Freefall, flow.Phase);

            Assert.IsTrue(flow.NotifyAllLanded());
            Assert.AreEqual(MatchPhase.InMatch, flow.Phase);

            flow.SetSquadsAlive(1);
            flow.Tick(0.1f);

            Assert.AreEqual(MatchPhase.Victory, flow.Phase);
            CollectionAssert.AreEqual(
                new[]
                {
                    MatchPhase.Bus, MatchPhase.Freefall, MatchPhase.InMatch, MatchPhase.Victory,
                },
                seen);
        }

        [Test]
        public void EjectingIsOnlyLegalOnTheBus()
        {
            var flow = new MatchFlow(_rules, 1);
            Assert.IsFalse(flow.RequestEject(), "Cannot eject from the lobby");

            flow.SetPlayersConnected(100);
            flow.Tick(0.1f);
            Assert.IsTrue(flow.RequestEject());
        }

        [Test]
        public void OnlyDocumentedTransitionsAreLegal()
        {
            Assert.IsTrue(MatchFlow.IsLegalTransition(MatchPhase.Lobby, MatchPhase.Bus));
            Assert.IsTrue(MatchFlow.IsLegalTransition(MatchPhase.InMatch, MatchPhase.Victory));

            // A client cannot ask for victory, and the machine cannot skip ahead.
            Assert.IsFalse(MatchFlow.IsLegalTransition(MatchPhase.Lobby, MatchPhase.Victory));
            Assert.IsFalse(MatchFlow.IsLegalTransition(MatchPhase.Bus, MatchPhase.InMatch));
            Assert.IsFalse(MatchFlow.IsLegalTransition(MatchPhase.Victory, MatchPhase.Lobby));
        }

        [Test]
        public void LandingOutsideFreefallIsRefused()
        {
            var flow = new MatchFlow(_rules, 1);
            Assert.IsFalse(flow.NotifyAllLanded());
            Assert.AreEqual(MatchPhase.Lobby, flow.Phase);
        }
    }
}
