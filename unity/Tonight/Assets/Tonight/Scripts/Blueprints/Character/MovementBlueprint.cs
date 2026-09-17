using UnityEngine;

namespace Tonight.Blueprints.Character
{
    /// <summary>
    /// Every movement tunable. The verb set is deliberately small -- no slide,
    /// no dash, no double jump -- because each movement verb competes with
    /// building for the game's skill ceiling, and building is the pillar.
    /// </summary>
    [CreateAssetMenu(
        fileName = "BP_Movement_New",
        menuName = "Tonight/Blueprints/Character/Movement",
        order = 0)]
    public sealed class MovementBlueprint : TonightBlueprint
    {
        [Header("Speeds (m/s)")]
        [SerializeField, Min(0.1f)] private float _walkSpeed = 4.6f;
        [SerializeField, Min(0.1f)] private float _sprintSpeed = 7.4f;
        [SerializeField, Min(0.1f)] private float _crouchSpeed = 2.3f;

        [Header("Acceleration (m/s^2)")]
        [SerializeField, Min(0.1f)] private float _acceleration = 60f;
        [SerializeField, Min(0.1f)] private float _deceleration = 45f;

        [SerializeField, Range(0f, 1f)]
        private float _airControl = 0.35f;

        [Header("Gravity and jump")]
        [SerializeField, Min(0.01f)]
        [Tooltip("Apex height in metres.")]
        private float _jumpHeight = 1.1f;

        [SerializeField]
        [Tooltip("Negative. Exaggerated well past -9.81 because a realistic arc " +
                 "feels floaty, and airborne time is time not building.")]
        private float _gravity = -22f;

        [SerializeField, Min(1f)] private float _terminalVelocity = 55f;

        [Header("Fall damage")]
        [SerializeField, Min(0f)] private float _fallDamageThreshold = 3.5f;
        [SerializeField, Min(0f)] private float _fallDamagePerMetre = 10f;

        [Header("Mantle")]
        [SerializeField, Min(0f)]
        [Tooltip("Far below the 4 m cell size, so build pieces can never be mantled.")]
        private float _mantleMaxHeight = 1.6f;

        [SerializeField, Min(0.01f)] private float _mantleSeconds = 0.4f;

        [Header("Capsule")]
        [SerializeField, Min(0.1f)] private float _standHeight = 1.8f;
        [SerializeField, Min(0.1f)] private float _crouchHeight = 0.9f;

        public float WalkSpeed => _walkSpeed;
        public float SprintSpeed => _sprintSpeed;
        public float CrouchSpeed => _crouchSpeed;
        public float Acceleration => _acceleration;
        public float Deceleration => _deceleration;
        public float AirControl => _airControl;
        public float JumpHeight => _jumpHeight;
        public float Gravity => _gravity;
        public float TerminalVelocity => _terminalVelocity;
        public float FallDamageThreshold => _fallDamageThreshold;
        public float FallDamagePerMetre => _fallDamagePerMetre;
        public float MantleMaxHeight => _mantleMaxHeight;
        public float MantleSeconds => _mantleSeconds;
        public float StandHeight => _standHeight;
        public float CrouchHeight => _crouchHeight;

        /// <summary>
        /// Initial upward velocity that reaches exactly <see cref="JumpHeight"/>
        /// under <see cref="Gravity"/>. Derived rather than authored, so tuning
        /// gravity does not silently change jump height.
        /// </summary>
        public float JumpVelocity => Mathf.Sqrt(2f * Mathf.Abs(_gravity) * _jumpHeight);

        /// <summary>Damage from a fall of the given height. Ignores shield.</summary>
        public float FallDamageFor(float fallDistanceMetres)
        {
            float excess = fallDistanceMetres - _fallDamageThreshold;
            return excess <= 0f ? 0f : excess * _fallDamagePerMetre;
        }

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);
            ctx.Require(_sprintSpeed >= _walkSpeed, "SprintSpeed must be at least WalkSpeed.");
            ctx.Require(_walkSpeed >= _crouchSpeed, "WalkSpeed must be at least CrouchSpeed.");
            ctx.Require(_gravity < 0f, "Gravity must be negative.");
            ctx.Require(_jumpHeight > 0f, "JumpHeight must be positive.");
            ctx.Require(_crouchHeight < _standHeight, "CrouchHeight must be below StandHeight.");
            ctx.Require(_terminalVelocity > 0f, "TerminalVelocity must be positive.");
            ctx.Warn(_mantleMaxHeight < Tonight.Core.BuildGrid.CellSize,
                "MantleMaxHeight at or above the 4 m cell size would let players climb walls.");
        }
    }
}
