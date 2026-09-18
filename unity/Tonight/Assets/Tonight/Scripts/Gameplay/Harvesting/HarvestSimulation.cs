using Tonight.Blueprints.World;
using Tonight.Core;
using UnityEngine;

namespace Tonight.Gameplay.Harvesting
{
    /// <summary>Mutable per-object harvest state.</summary>
    public struct HarvestState
    {
        /// <summary>Stable id, used to seed the weak-point position.</summary>
        public int ObjectId;

        public float Health;
        public int HitCount;
        public bool Destroyed;

        public static HarvestState For(int objectId, HarvestableBlueprint blueprint) =>
            new HarvestState
            {
                ObjectId = objectId,
                Health = blueprint != null ? blueprint.TotalHealth : 0f,
                HitCount = 0,
                Destroyed = false,
            };
    }

    /// <summary>The outcome of one pickaxe swing.</summary>
    public readonly struct HarvestHitResult
    {
        public readonly int Yield;
        public readonly bool HitWeakPoint;
        public readonly bool Destroyed;

        public HarvestHitResult(int yield, bool hitWeakPoint, bool destroyed)
        {
            Yield = yield;
            HitWeakPoint = hitWeakPoint;
            Destroyed = destroyed;
        }
    }

    /// <summary>
    /// Harvesting: the pump that feeds building.
    /// </summary>
    /// <remarks>
    /// The weak point is the skill expression, and it is why harvesting is an
    /// activity rather than a hold-to-fill bar. Its position is derived from
    /// <c>(objectId, hitCount)</c>, which both the client and the server already
    /// know, so client and server agree on where it is without replicating
    /// anything per swing.
    /// </remarks>
    public static class HarvestSimulation
    {
        /// <summary>
        /// How close a hit must be to the marker to count, in normalised
        /// surface units. Generous on purpose: this is a feel mechanic, not an
        /// accuracy test.
        /// </summary>
        public const float WeakPointRadius = 0.25f;

        /// <summary>
        /// The weak point for the next swing, as a normalised position in
        /// [0,1]^2 over the object's facing surface.
        /// </summary>
        public static Vector2 WeakPointFor(int objectId, int hitCount)
        {
            var rng = DeterministicRng.ForStream(objectId, hitCount);
            // Inset from the edges so the marker never lands half off the mesh.
            return new Vector2(rng.Range(0.15f, 0.85f), rng.Range(0.15f, 0.85f));
        }

        public static bool IsWeakPointHit(int objectId, int hitCount, Vector2 hitPoint) =>
            Vector2.Distance(WeakPointFor(objectId, hitCount), hitPoint) <= WeakPointRadius;

        /// <summary>
        /// Apply one swing.
        /// </summary>
        /// <param name="state">Mutated in place.</param>
        /// <param name="blueprint">The harvestable's definition.</param>
        /// <param name="damage">Pickaxe damage for this swing.</param>
        /// <param name="hitPoint">Normalised surface position of the hit.</param>
        public static HarvestHitResult Hit(
            ref HarvestState state,
            HarvestableBlueprint blueprint,
            float damage,
            Vector2 hitPoint)
        {
            if (blueprint == null || state.Destroyed)
            {
                return new HarvestHitResult(0, false, false);
            }

            bool weakPoint = IsWeakPointHit(state.ObjectId, state.HitCount, hitPoint);

            int yield = blueprint.YieldPerHit;
            if (weakPoint)
            {
                yield += blueprint.BonusYieldOnWeakPoint;
            }

            state.Health -= Mathf.Max(0f, damage);
            state.HitCount++;

            bool destroyed = state.Health <= 0f;
            if (destroyed)
            {
                state.Destroyed = true;
                state.Health = 0f;
                yield += blueprint.YieldOnDestroy;
            }

            return new HarvestHitResult(yield, weakPoint, destroyed);
        }

        /// <summary>
        /// Total materials a full harvest yields, assuming every weak point is
        /// hit. Used by the harvest-rate tests that back the GDD's 4.5 second
        /// wall target.
        /// </summary>
        public static int MaxTotalYield(HarvestableBlueprint blueprint, float damagePerHit)
        {
            if (blueprint == null || damagePerHit <= 0f)
            {
                return 0;
            }

            int hits = Mathf.CeilToInt(blueprint.TotalHealth / damagePerHit);
            int perHit = blueprint.YieldPerHit + blueprint.BonusYieldOnWeakPoint;
            return hits * perHit + blueprint.YieldOnDestroy;
        }
    }
}
