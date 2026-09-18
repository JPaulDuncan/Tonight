using System.Collections.Generic;
using NUnit.Framework;
using Tonight.Blueprints.Match;
using Tonight.Gameplay.Match;
using UnityEngine;

namespace Tonight.Tests.EditMode
{
    public sealed class SquadStateTests
    {
        private MatchLightingBlueprint _lighting;
        private List<StormPhaseBlueprint> _phases;

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
        }

        [TearDown]
        public void TearDown()
        {
            Object.DestroyImmediate(_lighting);
            StormFixture.Destroy(_phases);
        }

        private MatchRulesBlueprint Rules(int squadSize, bool dbno) =>
            TestBlueprints.Create<MatchRulesBlueprint>(new Dictionary<string, object>
            {
                { "_squadSize", squadSize },
                { "_maxPlayers", 100 },
                { "_allowDbno", dbno },
                { "_dbnoHealth", 100f },
                { "_dbnoBleedPerSecond", 2f },
                { "_reviveSeconds", 8f },
                { "_stormPhases", _phases },
                { "_lighting", _lighting },
            });

        [Test]
        public void SoloModeEliminatesDirectly()
        {
            // No code branch for solo: the rules asset simply has DBNO off.
            MatchRulesBlueprint rules = Rules(1, dbno: false);
            var squad = new SquadState(rules, new[] { 1 });

            Assert.AreEqual(PlayerLifeState.Eliminated, squad.ApplyLethalDamage(1));
            Assert.IsTrue(squad.IsWiped);

            Object.DestroyImmediate(rules);
        }

        [Test]
        public void SquadModeDownsRatherThanEliminates()
        {
            MatchRulesBlueprint rules = Rules(4, dbno: true);
            var squad = new SquadState(rules, new[] { 1, 2, 3, 4 });

            Assert.AreEqual(PlayerLifeState.Downed, squad.ApplyLethalDamage(1));
            Assert.AreEqual(3, squad.AliveCount);
            Assert.AreEqual(1, squad.DownedCount);
            Assert.IsFalse(squad.IsWiped);

            Object.DestroyImmediate(rules);
        }

        [Test]
        public void TheLastLivingMemberCannotBeDowned()
        {
            // With nobody left to revive them, downing would just be a delay.
            MatchRulesBlueprint rules = Rules(2, dbno: true);
            var squad = new SquadState(rules, new[] { 1, 2 });

            squad.ApplyLethalDamage(1);
            Assert.AreEqual(PlayerLifeState.Eliminated, squad.ApplyLethalDamage(2));
            Assert.IsTrue(squad.IsWiped);

            Object.DestroyImmediate(rules);
        }

        [Test]
        public void TheLastLivingMemberFallingTakesDownedSquadmates()
        {
            MatchRulesBlueprint rules = Rules(4, dbno: true);
            var squad = new SquadState(rules, new[] { 1, 2, 3, 4 });

            squad.ApplyLethalDamage(1);
            squad.ApplyLethalDamage(2);
            squad.ApplyLethalDamage(3);
            Assert.AreEqual(1, squad.AliveCount);

            squad.ApplyLethalDamage(4);

            Assert.IsTrue(squad.IsWiped, "Nobody remains who could revive them");
            Assert.AreEqual(0, squad.DownedCount);

            Object.DestroyImmediate(rules);
        }

        [Test]
        public void BleedingOutEliminatesAfterTheAuthoredTime()
        {
            // 100 DBNO health at 2/s is 50 seconds.
            MatchRulesBlueprint rules = Rules(4, dbno: true);
            var squad = new SquadState(rules, new[] { 1, 2, 3, 4 });
            squad.ApplyLethalDamage(1);

            var eliminated = new List<int>();
            for (int i = 0; i < 49; i++)
            {
                squad.Tick(1f, eliminated);
            }

            Assert.AreEqual(1, squad.DownedCount, "Should still be bleeding at 49 s");

            squad.Tick(2f, eliminated);
            Assert.Contains(1, eliminated);
            Assert.AreEqual(0, squad.DownedCount);

            Object.DestroyImmediate(rules);
        }

        [Test]
        public void ReviveTakesTheAuthoredTimeAndRestoresTheMember()
        {
            MatchRulesBlueprint rules = Rules(4, dbno: true);
            var squad = new SquadState(rules, new[] { 1, 2, 3, 4 });
            squad.ApplyLethalDamage(1);

            for (int i = 0; i < 7; i++)
            {
                Assert.IsFalse(squad.TryRevive(1, 2, 1f), $"Revived early at {i + 1} s");
            }

            Assert.IsTrue(squad.TryRevive(1, 2, 1f));
            Assert.AreEqual(4, squad.AliveCount);

            Object.DestroyImmediate(rules);
        }

        [Test]
        public void InterruptingAReviveLosesProgressRatherThanBankingIt()
        {
            MatchRulesBlueprint rules = Rules(4, dbno: true);
            var squad = new SquadState(rules, new[] { 1, 2, 3, 4 });
            squad.ApplyLethalDamage(1);

            squad.TryRevive(1, 2, 7f);
            squad.CancelRevive(1);

            Assert.IsFalse(squad.TryRevive(1, 2, 7f),
                "Progress should have restarted, not resumed at 7 s");
            Assert.IsTrue(squad.TryRevive(1, 2, 1.1f));

            Object.DestroyImmediate(rules);
        }

        [Test]
        public void ADownedPlayerCannotReviveAnother()
        {
            MatchRulesBlueprint rules = Rules(4, dbno: true);
            var squad = new SquadState(rules, new[] { 1, 2, 3, 4 });
            squad.ApplyLethalDamage(1);
            squad.ApplyLethalDamage(2);

            Assert.IsFalse(squad.TryRevive(1, 2, 999f));

            Object.DestroyImmediate(rules);
        }

        [Test]
        public void APlayerCannotReviveThemselves()
        {
            MatchRulesBlueprint rules = Rules(4, dbno: true);
            var squad = new SquadState(rules, new[] { 1, 2, 3, 4 });
            squad.ApplyLethalDamage(1);

            Assert.IsFalse(squad.TryRevive(1, 1, 999f));

            Object.DestroyImmediate(rules);
        }

        [Test]
        public void NoBleedingHappensWhenDbnoIsOff()
        {
            MatchRulesBlueprint rules = Rules(1, dbno: false);
            var squad = new SquadState(rules, new[] { 1 });

            var eliminated = new List<int>();
            squad.Tick(1000f, eliminated);

            Assert.AreEqual(0, eliminated.Count);

            Object.DestroyImmediate(rules);
        }
    }
}
