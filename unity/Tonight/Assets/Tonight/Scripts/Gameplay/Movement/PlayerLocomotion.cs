using Tonight.Blueprints.Character;
using Tonight.Gameplay.Commands;
using UnityEngine;

namespace Tonight.Gameplay.Movement
{
    /// <summary>
    /// Drives one character: samples input at the edge, turns it into commands,
    /// and steps the motor on a fixed tick.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the boundary ADR-0003 rule 2 draws. Input is read <b>here</b> and
    /// nowhere deeper: everything below this class sees only
    /// <see cref="MoveCommand"/>. At M4 the same commands become the wire
    /// format and this class stops applying them directly.
    /// </para>
    /// <para>
    /// The accumulator pattern below decouples the render frame rate from the
    /// simulation tick, so a 144 fps client and a 30 fps client simulate
    /// identically.
    /// </para>
    /// </remarks>
    [RequireComponent(typeof(CharacterController))]
    public sealed class PlayerLocomotion : MonoBehaviour
    {
        /// <summary>Fixed simulation rate. Matches the server tick (netcode.md §1).</summary>
        public const int TickRate = 30;

        public const float TickDelta = 1f / TickRate;

        [SerializeField] private CharacterBlueprint _character;
        [SerializeField] private LayerMask _obstacles = ~0;
        [SerializeField] private Transform _cameraPivot;
        [SerializeField] private float _lookSensitivity = 0.12f;

        private IMotorCollision _collision;
        private MotorState _state;
        private float _accumulator;
        private int _tick;

        private Vector2 _moveInput;
        private Vector2 _lookInput;
        private bool _jumpQueued;
        private bool _sprintHeld;
        private bool _crouchHeld;

        public MotorState State => _state;

        public CharacterBlueprint Character => _character;

        /// <summary>Raised when a tick produces fall damage. Health lives elsewhere.</summary>
        public event System.Action<float> FallDamageTaken;

        private void Awake()
        {
            var controller = GetComponent<CharacterController>();
            _collision = new UnityCapsuleCollision(controller, _obstacles);
            _state = MotorState.AtRest(transform.position);
        }

        /// <summary>Called by the input layer. The only entry point for intent.</summary>
        public void SetInput(Vector2 move, Vector2 look, bool sprint, bool crouch)
        {
            _moveInput = move;
            _lookInput += look * _lookSensitivity;
            _sprintHeld = sprint;
            _crouchHeld = crouch;
        }

        /// <summary>Queues a jump. Latched rather than sampled, so a jump pressed
        /// between ticks is never dropped.</summary>
        public void QueueJump() => _jumpQueued = true;

        private void Update()
        {
            if (_character == null || _character.Movement == null)
            {
                return;
            }

            _accumulator += Time.deltaTime;

            // Bounded so a long hitch does not spiral into hundreds of catch-up
            // ticks, which would look like a teleport and cost a frame anyway.
            int maxTicksThisFrame = 8;

            while (_accumulator >= TickDelta && maxTicksThisFrame-- > 0)
            {
                _accumulator -= TickDelta;
                StepOnce();
            }

            ApplyToTransform();
        }

        private void StepOnce()
        {
            var flags = MoveFlags.None;
            if (_jumpQueued) flags |= MoveFlags.Jump;
            if (_sprintHeld) flags |= MoveFlags.Sprint;
            if (_crouchHeld) flags |= MoveFlags.Crouch;

            var command = new MoveCommand(_tick++, _moveInput, _lookInput, flags, TickDelta);

            // Look delta is consumed, not held: it is a per-tick increment.
            _lookInput = Vector2.zero;
            _jumpQueued = false;

            _state = CharacterMotor.Step(
                _state, command, _character.Movement, _collision, out MotorStepResult result);

            if (result.FallDamage > 0f)
            {
                FallDamageTaken?.Invoke(result.FallDamage);
            }
        }

        private void ApplyToTransform()
        {
            transform.position = _state.Position;
            transform.rotation = Quaternion.Euler(0f, _state.Yaw, 0f);

            if (_cameraPivot == null)
            {
                return;
            }

            float height = _state.Crouched
                ? _character.Movement.CrouchHeight * (_character.CameraHeight /
                                                      _character.Movement.StandHeight)
                : _character.CameraHeight;

            _cameraPivot.localPosition = new Vector3(0f, height, 0f);
            _cameraPivot.localRotation = Quaternion.Euler(_state.Pitch, 0f, 0f);
        }

        /// <summary>Place the character without simulating a move. Used on spawn and respawn.</summary>
        public void Teleport(Vector3 position)
        {
            _state = MotorState.AtRest(position);
            transform.position = position;
        }
    }
}
