using System;
using UnityEngine;

namespace Tonight.Blueprints.Combat
{
    /// <summary>
    /// Camera kick. Deliberately separate from spread: recoil moves the camera,
    /// spread moves the bullet. Keeping them apart lets a weapon kick hard and
    /// shoot straight (sniper) or barely kick and spray (SMG).
    /// </summary>
    [CreateAssetMenu(
        fileName = "BP_Recoil_New",
        menuName = "Tonight/Blueprints/Combat/Recoil Profile",
        order = 20)]
    public sealed class RecoilProfileBlueprint : TonightBlueprint
    {
        [Header("Per shot")]
        [SerializeField, Min(0f)]
        private float _verticalKickDegrees = 0.6f;

        [SerializeField, Min(0f)]
        [Tooltip("Applied as a random value in +/- this range.")]
        private float _horizontalKickDegrees = 0.2f;

        [SerializeField]
        [Tooltip("Fixed pattern as (horizontal, vertical) per shot. When non-empty " +
                 "this REPLACES the random kick above, making the weapon learnable.")]
        private Vector2[] _pattern = Array.Empty<Vector2>();

        [Header("Recovery")]
        [SerializeField, Min(0.01f)]
        private float _recoveryPerSecond = 8f;

        [SerializeField, Min(0f)]
        private float _recoveryDelaySeconds = 0.12f;

        public float VerticalKickDegrees => _verticalKickDegrees;

        public float HorizontalKickDegrees => _horizontalKickDegrees;

        public bool HasPattern => _pattern != null && _pattern.Length > 0;

        public float RecoveryPerSecond => _recoveryPerSecond;

        public float RecoveryDelaySeconds => _recoveryDelaySeconds;

        /// <summary>
        /// Kick for a given shot index. Wraps the authored pattern, or falls
        /// back to the random model using the supplied roll in [-1, 1].
        /// </summary>
        public Vector2 KickForShot(int shotIndex, float horizontalRoll)
        {
            if (HasPattern)
            {
                int index = shotIndex % _pattern.Length;
                if (index < 0)
                {
                    index += _pattern.Length;
                }

                return _pattern[index];
            }

            return new Vector2(horizontalRoll * _horizontalKickDegrees, _verticalKickDegrees);
        }

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);
            ctx.Require(_recoveryPerSecond > 0f,
                "RecoveryPerSecond must be positive, or recoil never returns.");
            ctx.Warn(_verticalKickDegrees <= 3f,
                "VerticalKickDegrees above 3 is likely uncontrollable.");
        }
    }
}
