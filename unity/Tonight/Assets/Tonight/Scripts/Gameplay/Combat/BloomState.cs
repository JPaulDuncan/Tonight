using Tonight.Blueprints.Combat;
using Tonight.Core;
using UnityEngine;

namespace Tonight.Gameplay.Combat
{
    /// <summary>
    /// Per-weapon-instance spread accumulation.
    /// </summary>
    /// <remarks>
    /// A struct, and deliberately not stored on the Blueprint: bloom is
    /// per-instance mutable state, and writing it to shared data would leak
    /// one player's spray across every other holder of that weapon.
    /// </remarks>
    public struct BloomState
    {
        private float _currentDegrees;
        private float _secondsSinceLastShot;

        public float CurrentDegrees => _currentDegrees;

        /// <summary>Advances recovery. Call once per fixed tick with the tick's dt.</summary>
        public void Tick(WeaponBlueprint weapon, float dt)
        {
            if (weapon == null)
            {
                return;
            }

            _secondsSinceLastShot += dt;
            _currentDegrees = Mathf.Max(
                0f,
                _currentDegrees - weapon.BloomRecoveryPerSecond * dt);
        }

        /// <summary>Records a shot, adding bloom up to the weapon's cap.</summary>
        public void OnShotFired(WeaponBlueprint weapon)
        {
            if (weapon == null)
            {
                return;
            }

            _secondsSinceLastShot = 0f;
            _currentDegrees = Mathf.Min(
                weapon.BloomMaxDegrees,
                _currentDegrees + weapon.BloomPerShot);
        }

        /// <summary>
        /// Effective cone half-angle for the next shot.
        /// </summary>
        public float EffectiveSpread(WeaponBlueprint weapon)
        {
            if (weapon == null)
            {
                return 0f;
            }

            // First-shot accuracy: at rest, the shot goes dead centre regardless
            // of the weapon's base spread. Multi-pellet weapons are exempt --
            // a shotgun whose first shot fired every pellet along one line would
            // be a sniper rifle.
            if (weapon.FirstShotAccurate && _currentDegrees <= 0f && weapon.PelletCount == 1)
            {
                return 0f;
            }

            return weapon.SpreadDegrees + _currentDegrees;
        }

        public void Reset()
        {
            _currentDegrees = 0f;
            _secondsSinceLastShot = 0f;
        }

        /// <summary>
        /// Deterministic direction for one pellet of one shot.
        /// </summary>
        /// <remarks>
        /// Seeded from values the client and server both already know, so a
        /// predicted shotgun blast matches the authoritative one without
        /// replicating any per-pellet data.
        /// </remarks>
        public static Vector3 PelletDirection(
            Vector3 aimDirection,
            float spreadDegrees,
            int shotSeed,
            int pelletIndex)
        {
            if (spreadDegrees <= 0f)
            {
                return aimDirection.normalized;
            }

            var rng = DeterministicRng.ForStream(shotSeed, pelletIndex);

            // Uniform over the cone's solid angle rather than over the angle
            // itself, or pellets bunch toward the centre.
            float cosMax = Mathf.Cos(spreadDegrees * Mathf.Deg2Rad);
            float cosTheta = Mathf.Lerp(cosMax, 1f, rng.NextFloat());
            float sinTheta = Mathf.Sqrt(Mathf.Max(0f, 1f - cosTheta * cosTheta));
            float phi = rng.NextFloat() * Mathf.PI * 2f;

            Vector3 forward = aimDirection.normalized;
            Vector3 reference = Mathf.Abs(forward.y) > 0.99f ? Vector3.right : Vector3.up;
            Vector3 right = Vector3.Normalize(Vector3.Cross(reference, forward));
            Vector3 up = Vector3.Cross(forward, right);

            return forward * cosTheta
                 + right * (sinTheta * Mathf.Cos(phi))
                 + up * (sinTheta * Mathf.Sin(phi));
        }
    }
}
