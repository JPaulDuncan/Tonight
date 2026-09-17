using System;

namespace Tonight.Core
{
    /// <summary>
    /// A small, fast, fully deterministic RNG (xorshift128).
    /// </summary>
    /// <remarks>
    /// <para>
    /// Gameplay never uses <see cref="UnityEngine.Random"/>. Unity's RNG carries
    /// global state that the client and server do not share, and it cannot be
    /// replayed during reconciliation.
    /// </para>
    /// <para>
    /// Every random draw that both sides must agree on -- shotgun pellet
    /// directions, harvest weak-point positions, loot rolls -- is seeded from
    /// values both sides already know, so no extra replication is needed.
    /// </para>
    /// </remarks>
    public struct DeterministicRng
    {
        private uint _x, _y, _z, _w;

        public DeterministicRng(int seed)
        {
            // Seeds must never all be zero, or xorshift degenerates to zero forever.
            unchecked
            {
                uint s = (uint)seed;
                _x = s == 0u ? 0x9E3779B9u : s;
                _y = _x * 1812433253u + 1u;
                _z = _y * 1812433253u + 1u;
                _w = _z * 1812433253u + 1u;
            }
        }

        /// <summary>
        /// Derives a stream from a base seed plus one or two discriminators.
        /// Used for "seed this shot" or "seed this object's Nth hit".
        /// </summary>
        public static DeterministicRng ForStream(int seed, int streamA, int streamB = 0)
        {
            unchecked
            {
                int mixed = seed;
                mixed = mixed * 31 + streamA * 73856093;
                mixed = mixed * 31 + streamB * 19349663;
                return new DeterministicRng(mixed);
            }
        }

        public uint NextUInt()
        {
            unchecked
            {
                uint t = _x ^ (_x << 11);
                _x = _y;
                _y = _z;
                _z = _w;
                _w = _w ^ (_w >> 19) ^ t ^ (t >> 8);
                return _w;
            }
        }

        /// <summary>Uniform float in [0, 1).</summary>
        public float NextFloat() => (NextUInt() >> 8) * (1f / 16777216f);

        /// <summary>Uniform float in [min, max).</summary>
        public float Range(float min, float max) => min + NextFloat() * (max - min);

        /// <summary>Uniform int in [minInclusive, maxExclusive).</summary>
        public int Range(int minInclusive, int maxExclusive)
        {
            if (maxExclusive <= minInclusive)
            {
                return minInclusive;
            }

            uint span = (uint)(maxExclusive - minInclusive);
            return minInclusive + (int)(NextUInt() % span);
        }

        /// <summary>Uniform int in [range.Min, range.Max], inclusive at both ends.</summary>
        public int Range(IntRange range) => Range(range.Min, range.Max + 1);

        /// <summary>
        /// Index into <paramref name="weights"/> chosen proportionally.
        /// Returns -1 when the weights sum to zero, which callers must treat as
        /// a validation failure rather than silently picking entry 0.
        /// </summary>
        public int WeightedPick(ReadOnlySpan<float> weights)
        {
            float total = 0f;
            for (int i = 0; i < weights.Length; i++)
            {
                if (weights[i] > 0f)
                {
                    total += weights[i];
                }
            }

            if (total <= 0f)
            {
                return -1;
            }

            float roll = NextFloat() * total;
            for (int i = 0; i < weights.Length; i++)
            {
                if (weights[i] <= 0f)
                {
                    continue;
                }

                roll -= weights[i];
                if (roll <= 0f)
                {
                    return i;
                }
            }

            // Floating-point drift can leave a residual; the last positive entry
            // is the correct fallback.
            for (int i = weights.Length - 1; i >= 0; i--)
            {
                if (weights[i] > 0f)
                {
                    return i;
                }
            }

            return -1;
        }
    }
}
