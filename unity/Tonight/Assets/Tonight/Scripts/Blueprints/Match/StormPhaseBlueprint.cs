using UnityEngine;

namespace Tonight.Blueprints.Match
{
    /// <summary>
    /// One storm phase: a stationary wait, then a shrink to the next circle.
    /// </summary>
    /// <remarks>
    /// <see cref="MaxRotationDistance"/> is the fairness clamp. No player may
    /// ever be further from safety than a full sprint plus 10% at the moment a
    /// circle is announced -- without it, a player looted into a corner can die
    /// to a rotation they could not physically make, which reads as the game
    /// cheating rather than as a mistake. See docs/systems/storm.md section 2.
    /// </remarks>
    [CreateAssetMenu(
        fileName = "BP_Storm_Phase",
        menuName = "Tonight/Blueprints/Match/Storm Phase",
        order = 10)]
    public sealed class StormPhaseBlueprint : TonightBlueprint
    {
        [SerializeField, Min(0)]
        [Tooltip("Ordering key. Must be unique and contiguous from 0.")]
        private int _phaseIndex;

        [Header("Timing (seconds)")]
        [SerializeField, Min(0f)] private float _waitSeconds = 120f;
        [SerializeField, Min(1f)] private float _closeSeconds = 120f;

        [Header("Radius (metres)")]
        [SerializeField, Min(0f)] private float _startRadius = 900f;
        [SerializeField, Min(0f)] private float _endRadius = 600f;

        [Header("Damage")]
        [SerializeField, Min(0f)]
        [Tooltip("Applied every second to players outside the boundary. Ignores " +
                 "shield: the storm is a clock, not a combat interaction.")]
        private float _damagePerSecond = 1f;

        [Header("Placement")]
        [SerializeField, Range(0f, 1f)]
        [Tooltip("0 = purely random inside the previous circle. 1 = the surviving players' centroid.")]
        private float _centreBiasToPlayers = 0.3f;

        [SerializeField]
        [Tooltip("-1 auto-computes from sprint speed * CloseSeconds * 1.1.")]
        private float _maxRotationDistance = -1f;

        public int PhaseIndex => _phaseIndex;
        public float WaitSeconds => _waitSeconds;
        public float CloseSeconds => _closeSeconds;
        public float StartRadius => _startRadius;
        public float EndRadius => _endRadius;
        public float DamagePerSecond => _damagePerSecond;
        public float CentreBiasToPlayers => _centreBiasToPlayers;
        public float MaxRotationDistance => _maxRotationDistance;

        public float TotalSeconds => _waitSeconds + _closeSeconds;

        /// <summary>
        /// The effective rotation clamp, resolving the -1 sentinel against the
        /// character's sprint speed.
        /// </summary>
        public float ResolveMaxRotationDistance(float sprintSpeed)
        {
            if (_maxRotationDistance >= 0f)
            {
                return _maxRotationDistance;
            }

            return sprintSpeed * _closeSeconds * 1.1f;
        }

        /// <summary>
        /// Radius at a time offset from the start of this phase.
        /// Flat through the wait, then linear through the close.
        /// </summary>
        public float RadiusAt(float secondsIntoPhase)
        {
            if (secondsIntoPhase <= _waitSeconds)
            {
                return _startRadius;
            }

            float closeElapsed = secondsIntoPhase - _waitSeconds;
            if (closeElapsed >= _closeSeconds)
            {
                return _endRadius;
            }

            return Mathf.Lerp(_startRadius, _endRadius, closeElapsed / _closeSeconds);
        }

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);
            ctx.Require(_endRadius <= _startRadius, "EndRadius must not exceed StartRadius.");
            ctx.Require(_startRadius > 0f, "StartRadius must be positive.");
            ctx.Require(_closeSeconds > 0f, "CloseSeconds must be positive.");
            ctx.Require(_phaseIndex >= 0, "PhaseIndex cannot be negative.");
            // Phase-to-phase radius continuity is a cross-asset check; a gap
            // there is a silently teleporting circle. See validate_blueprints.py.
        }
    }
}
