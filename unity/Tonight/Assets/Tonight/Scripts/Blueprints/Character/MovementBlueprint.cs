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
        /// Continuous-time jump velocity: the textbook sqrt(2gh).
        /// </summary>
        /// <remarks>
        /// Exposed for reference and validation. <b>The simulation does not use
        /// this</b> -- see <see cref="JumpVelocityForTick"/>.
        /// </remarks>
        public float JumpVelocityContinuous => Mathf.Sqrt(2f * Mathf.Abs(_gravity) * _jumpHeight);

        /// <summary>
        /// Initial upward velocity that reaches <see cref="JumpHeight"/> when
        /// integrated at a fixed timestep of <paramref name="deltaTime"/>.
        /// </summary>
        /// <remarks>
        /// <para>
        /// The textbook sqrt(2gh) is the answer for continuous time, and using
        /// it in a discrete simulation undershoots: at the project's 30 Hz tick
        /// an authored 1.1 m jump actually peaks at 0.99 m. A 10% error would
        /// make the Blueprint field a lie, which undermines the point of
        /// authoring values as data at all.
        /// </para>
        /// <para>
        /// The simulation uses semi-implicit Euler with gravity applied before
        /// the position update, so with g = |gravity|:
        /// </para>
        /// <code>
        ///   v_k   = v0 - g*k*dt
        ///   y_n   = dt * sum(v_k, k=1..n) = dt*(n*v0 - g*dt*n*(n+1)/2)
        ///   y_max ~= v0^2/(2g) - v0*dt/2        (apex where v reaches zero)
        /// </code>
        /// <para>
        /// Setting y_max = h and solving the quadratic for v0 gives the value
        /// below, which lands within a millimetre of the authored height at 20,
        /// 30 and 60 Hz alike.
        /// </para>
        /// </remarks>
        public float JumpVelocityForTick(float deltaTime)
        {
            float g = Mathf.Abs(_gravity);
            if (deltaTime <= 0f)
            {
                return JumpVelocityContinuous;
            }

            float gdt = g * deltaTime;
            return (gdt + Mathf.Sqrt(gdt * gdt + 8f * g * _jumpHeight)) * 0.5f;
        }

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
