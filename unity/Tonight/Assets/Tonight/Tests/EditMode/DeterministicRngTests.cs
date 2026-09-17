using NUnit.Framework;
using Tonight.Core;

namespace Tonight.Tests.EditMode
{
    public sealed class DeterministicRngTests
    {
        [Test]
        public void SameSeedProducesTheSameSequence()
        {
            var a = new DeterministicRng(12345);
            var b = new DeterministicRng(12345);

            for (int i = 0; i < 1000; i++)
            {
                Assert.AreEqual(a.NextUInt(), b.NextUInt(), $"Diverged at draw {i}");
            }
        }

        [Test]
        public void DifferentSeedsDiverge()
        {
            var a = new DeterministicRng(1);
            var b = new DeterministicRng(2);

            bool differed = false;
            for (int i = 0; i < 100 && !differed; i++)
            {
                differed = a.NextUInt() != b.NextUInt();
            }

            Assert.IsTrue(differed, "Two different seeds produced identical output");
        }

        [Test]
        public void ZeroSeedDoesNotDegenerate()
        {
            // xorshift collapses to a permanent zero if every state word is zero.
            var rng = new DeterministicRng(0);
            bool sawNonZero = false;

            for (int i = 0; i < 50; i++)
            {
                if (rng.NextUInt() != 0u)
                {
                    sawNonZero = true;
                    break;
                }
            }

            Assert.IsTrue(sawNonZero, "Seed 0 degenerated to an all-zero state");
        }

        [Test]
        public void NextFloatStaysInRange()
        {
            var rng = new DeterministicRng(99);
            for (int i = 0; i < 10000; i++)
            {
                float value = rng.NextFloat();
                Assert.GreaterOrEqual(value, 0f);
                Assert.Less(value, 1f);
            }
        }

        [Test]
        public void StreamsAreIndependentAndReproducible()
        {
            // Shotgun pellets and harvest weak points rely on this: both sides
            // derive the same stream from values they already share.
            var shotA = DeterministicRng.ForStream(seed: 7, streamA: 3);
            var shotB = DeterministicRng.ForStream(seed: 7, streamA: 3);
            var other = DeterministicRng.ForStream(seed: 7, streamA: 4);

            Assert.AreEqual(shotA.NextUInt(), shotB.NextUInt());
            Assert.AreNotEqual(shotA.NextUInt(), other.NextUInt());
        }

        [Test]
        public void WeightedPick_MatchesTheAuthoredDistribution()
        {
            var rng = new DeterministicRng(4242);
            float[] weights = { 50f, 30f, 14f, 5f, 1f };
            var counts = new int[weights.Length];

            const int samples = 200000;
            for (int i = 0; i < samples; i++)
            {
                counts[rng.WeightedPick(weights)]++;
            }

            // A loot table that is subtly wrong still produces plausible
            // individual rolls, so this has to be checked in aggregate.
            float total = 0f;
            foreach (float w in weights)
            {
                total += w;
            }

            for (int i = 0; i < weights.Length; i++)
            {
                float expected = weights[i] / total;
                float actual = counts[i] / (float)samples;
                Assert.AreEqual(expected, actual, expected * 0.05f + 0.002f,
                    $"Entry {i} drew {actual:P2}, expected {expected:P2}");
            }
        }

        [Test]
        public void WeightedPick_SkipsZeroWeightEntries()
        {
            var rng = new DeterministicRng(5);
            float[] weights = { 0f, 1f, 0f };

            for (int i = 0; i < 1000; i++)
            {
                Assert.AreEqual(1, rng.WeightedPick(weights));
            }
        }

        [Test]
        public void WeightedPick_ReturnsMinusOneWhenNothingIsSelectable()
        {
            // The caller must treat this as a validation failure rather than
            // silently picking entry zero.
            var rng = new DeterministicRng(5);
            float[] weights = { 0f, 0f, 0f };
            Assert.AreEqual(-1, rng.WeightedPick(weights));
        }

        [Test]
        public void IntRangeIsInclusiveAtBothEnds()
        {
            var rng = new DeterministicRng(11);
            bool sawMin = false;
            bool sawMax = false;

            for (int i = 0; i < 5000; i++)
            {
                int value = rng.Range(new IntRange(3, 6));
                Assert.GreaterOrEqual(value, 3);
                Assert.LessOrEqual(value, 6);
                sawMin |= value == 3;
                sawMax |= value == 6;
            }

            Assert.IsTrue(sawMin && sawMax, "Inclusive range never produced an endpoint");
        }
    }
}
