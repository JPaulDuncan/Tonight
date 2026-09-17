using System.Collections.Generic;
using Tonight.Blueprints.Match;
using Tonight.Core;
using UnityEngine;

namespace Tonight.Gameplay.Storm
{
    /// <summary>The storm's state at one instant.</summary>
    public readonly struct StormState
    {
        public readonly int PhaseIndex;
        public readonly Vector2 Centre;
        public readonly float Radius;
        public readonly Vector2 NextCentre;
        public readonly float NextRadius;
        public readonly bool IsClosing;
        public readonly float SecondsRemainingInStage;

        public StormState(
            int phaseIndex,
            Vector2 centre,
            float radius,
            Vector2 nextCentre,
            float nextRadius,
            bool isClosing,
            float secondsRemainingInStage)
        {
            PhaseIndex = phaseIndex;
            Centre = centre;
            Radius = radius;
            NextCentre = nextCentre;
            NextRadius = nextRadius;
            IsClosing = isClosing;
            SecondsRemainingInStage = secondsRemainingInStage;
        }

        public bool Contains(Vector2 position) =>
            (position - Centre).sqrMagnitude <= Radius * Radius;
    }

    /// <summary>
    /// Storm circle placement and progression.
    /// </summary>
    public static class StormSimulation
    {
        /// <summary>
        /// Chooses the next circle centre: biased toward the survivors, then
        /// clamped so nobody is stranded.
        /// </summary>
        /// <remarks>
        /// The clamp is the part that matters. Without it, a player looted into
        /// a corner can die to a rotation they could not physically make, which
        /// reads as the game cheating rather than as a mistake.
        /// </remarks>
        public static Vector2 ChooseNextCentre(
            StormPhaseBlueprint phase,
            Vector2 currentCentre,
            float currentRadius,
            float nextRadius,
            IReadOnlyList<Vector2> livingPlayers,
            float sprintSpeed,
            ref DeterministicRng rng,
            out bool clampWasImpossible)
        {
            clampWasImpossible = false;

            if (phase == null)
            {
                return currentCentre;
            }

            // A uniform point inside the current circle. sqrt on the radius is
            // what keeps the distribution uniform by area rather than clustering
            // candidates toward the centre.
            float angle = rng.NextFloat() * Mathf.PI * 2f;
            float maxOffset = Mathf.Max(0f, currentRadius - nextRadius);
            float distance = Mathf.Sqrt(rng.NextFloat()) * maxOffset;
            var candidate = currentCentre + new Vector2(
                Mathf.Cos(angle) * distance,
                Mathf.Sin(angle) * distance);

            if (livingPlayers != null && livingPlayers.Count > 0)
            {
                Vector2 centroid = Centroid(livingPlayers);
                candidate = Vector2.Lerp(candidate, centroid, phase.CentreBiasToPlayers);
                candidate = ClampInsideCircle(candidate, currentCentre, maxOffset);

                candidate = ApplyRotationClamp(
                    phase,
                    candidate,
                    currentCentre,
                    maxOffset,
                    nextRadius,
                    livingPlayers,
                    sprintSpeed,
                    out clampWasImpossible);
            }

            return candidate;
        }

        /// <summary>
        /// Pulls the candidate centre toward any player who could not reach
        /// safety in time.
        /// </summary>
        /// <remarks>
        /// When survivors are spread wider than the circle can span, no centre
        /// satisfies everyone. In that case this satisfies the furthest player
        /// and reports the situation, because a spread that wide is a
        /// map-design problem rather than a runtime one.
        /// </remarks>
        private static Vector2 ApplyRotationClamp(
            StormPhaseBlueprint phase,
            Vector2 candidate,
            Vector2 currentCentre,
            float maxOffset,
            float nextRadius,
            IReadOnlyList<Vector2> livingPlayers,
            float sprintSpeed,
            out bool impossible)
        {
            float maxDistance = phase.ResolveMaxRotationDistance(sprintSpeed);
            impossible = false;

            // A handful of relaxation passes converges well and is bounded, which
            // matters because this runs on the server between phases.
            const int passes = 8;
            for (int pass = 0; pass < passes; pass++)
            {
                int worstIndex = -1;
                float worstExcess = 0f;

                for (int i = 0; i < livingPlayers.Count; i++)
                {
                    float toEdge = Vector2.Distance(livingPlayers[i], candidate) - nextRadius;
                    float excess = toEdge - maxDistance;
                    if (excess > worstExcess)
                    {
                        worstExcess = excess;
                        worstIndex = i;
                    }
                }

                if (worstIndex < 0)
                {
                    return candidate;
                }

                Vector2 toPlayer = livingPlayers[worstIndex] - candidate;
                if (toPlayer.sqrMagnitude < 1e-6f)
                {
                    return candidate;
                }

                Vector2 pulled = candidate + toPlayer.normalized * worstExcess;
                Vector2 clamped = ClampInsideCircle(pulled, currentCentre, maxOffset);

                // If clamping back inside the previous circle undid the pull, no
                // centre can satisfy this player.
                if (Vector2.Distance(clamped, candidate) < 1e-4f)
                {
                    impossible = true;
                    return clamped;
                }

                candidate = clamped;
            }

            impossible = true;
            return candidate;
        }

        public static Vector2 Centroid(IReadOnlyList<Vector2> points)
        {
            if (points == null || points.Count == 0)
            {
                return Vector2.zero;
            }

            Vector2 sum = Vector2.zero;
            for (int i = 0; i < points.Count; i++)
            {
                sum += points[i];
            }

            return sum / points.Count;
        }

        private static Vector2 ClampInsideCircle(Vector2 point, Vector2 centre, float maxRadius)
        {
            Vector2 offset = point - centre;
            if (offset.magnitude <= maxRadius)
            {
                return point;
            }

            return centre + offset.normalized * maxRadius;
        }

        /// <summary>
        /// Interpolates the boundary during a close. The storm damages anyone
        /// outside this circle.
        /// </summary>
        public static float RadiusAt(StormPhaseBlueprint phase, float secondsIntoPhase) =>
            phase != null ? phase.RadiusAt(secondsIntoPhase) : 0f;

        /// <summary>
        /// Storm damage over a time slice. Ignores shield by design -- the
        /// storm is a clock, not a combat interaction, and letting shields
        /// absorb it would blunt the pacing it exists to create.
        /// </summary>
        public static float DamageForInterval(StormPhaseBlueprint phase, float seconds) =>
            phase != null ? phase.DamagePerSecond * Mathf.Max(0f, seconds) : 0f;
    }
}
