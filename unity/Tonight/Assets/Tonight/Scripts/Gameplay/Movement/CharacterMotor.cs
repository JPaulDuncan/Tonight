using Tonight.Blueprints.Character;
using Tonight.Gameplay.Commands;
using UnityEngine;

namespace Tonight.Gameplay.Movement
{
    /// <summary>
    /// The locomotion simulation. One pure step function.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>This class reads no input and no <c>Time.deltaTime</c>.</b> Both
    /// arrive in the <see cref="MoveCommand"/>. That is ADR-0003 rules 2 and 3,
    /// and it is what makes reconciliation replay exact at M4: replaying a
    /// stored command sequence must reproduce the original result bit for bit,
    /// and a single frame-rate-dependent term makes that drift. The symptom is
    /// permanent jitter that is very hard to trace back to its cause, so the
    /// discipline is cheap now and expensive to retrofit.
    /// </para>
    /// <para>
    /// There is also no randomness here at all, deliberately.
    /// </para>
    /// </remarks>
    public static class CharacterMotor
    {
        /// <summary>Capsule radius. Not a Blueprint field: it is a collision
        /// detail rather than a tuning knob, and changing it changes level
        /// geometry fit rather than game feel.</summary>
        public const float CapsuleRadius = 0.4f;

        /// <summary>
        /// Advance one fixed tick.
        /// </summary>
        public static MotorState Step(
            in MotorState state,
            in MoveCommand command,
            MovementBlueprint blueprint,
            IMotorCollision collision,
            out MotorStepResult result)
        {
            if (blueprint == null || collision == null)
            {
                result = MotorStepResult.None;
                return state;
            }

            MotorState next = state;
            float dt = command.DeltaTime;

            ApplyLook(ref next, command);

            if (next.IsMantling)
            {
                result = StepMantle(ref next, dt);
                return next;
            }

            bool startedMantle = TryStartMantle(ref next, command, blueprint, collision);
            if (startedMantle)
            {
                result = new MotorStepResult(0f, false, false, true);
                return next;
            }

            UpdateCrouch(ref next, command, blueprint, collision);

            bool jumped = ApplyJump(ref next, command, blueprint);
            ApplyHorizontal(ref next, command, blueprint, dt);
            ApplyGravity(ref next, blueprint, dt);

            bool wasGrounded = next.Grounded;
            MotorCollisionResult moved = collision.Move(
                next.Position,
                next.Velocity * dt,
                CurrentHeight(next, blueprint),
                CapsuleRadius);

            next.Position = moved.Position;

            if (moved.HitCeiling && next.Velocity.y > 0f)
            {
                next.Velocity.y = 0f;
            }

            float fallDamage = 0f;
            bool landed = false;

            if (moved.Grounded)
            {
                if (!wasGrounded)
                {
                    landed = true;
                    fallDamage = blueprint.FallDamageFor(next.PeakY - next.Position.y);
                }

                next.Grounded = true;
                if (next.Velocity.y < 0f)
                {
                    next.Velocity.y = 0f;
                }

                // Reset the fall origin on every grounded tick. This is what
                // makes building a ramp under yourself a reliable save rather
                // than an unpredictable one.
                next.PeakY = next.Position.y;
            }
            else
            {
                next.Grounded = false;
                if (next.Position.y > next.PeakY)
                {
                    next.PeakY = next.Position.y;
                }
            }

            result = new MotorStepResult(fallDamage, landed, jumped, false);
            return next;
        }

        private static void ApplyLook(ref MotorState state, in MoveCommand command)
        {
            state.Yaw = Mathf.Repeat(state.Yaw + command.LookDelta.x, 360f);
            // Clamped rather than wrapped: a player who over-pitches should stop
            // at vertical, not flip upside down.
            state.Pitch = Mathf.Clamp(state.Pitch + command.LookDelta.y, -89f, 89f);
        }

        private static void UpdateCrouch(
            ref MotorState state,
            in MoveCommand command,
            MovementBlueprint blueprint,
            IMotorCollision collision)
        {
            bool wants = command.Has(MoveFlags.Crouch);

            if (wants)
            {
                state.Crouched = true;
                return;
            }

            // Standing up is refused when something is overhead, so a player
            // cannot clip through a floor they built above themselves.
            if (state.Crouched &&
                collision.HasHeadroom(state.Position, blueprint.StandHeight, CapsuleRadius))
            {
                state.Crouched = false;
            }
        }

        private static bool ApplyJump(
            ref MotorState state, in MoveCommand command, MovementBlueprint blueprint)
        {
            if (!command.Has(MoveFlags.Jump) || !state.Grounded)
            {
                return false;
            }

            // Tick-rate corrected, so the apex matches the authored JumpHeight
            // rather than undershooting it by ~10% at 30 Hz.
            state.Velocity.y = blueprint.JumpVelocityForTick(command.DeltaTime);
            state.Grounded = false;
            state.PeakY = state.Position.y;
            return true;
        }

        private static void ApplyHorizontal(
            ref MotorState state,
            in MoveCommand command,
            MovementBlueprint blueprint,
            float dt)
        {
            float speed = SpeedFor(command, blueprint, state.Crouched);

            // Input is in local space; rotate it by yaw so "forward" means the
            // direction the character faces.
            Vector3 wish = YawRotate(
                new Vector3(command.MoveInput.x, 0f, command.MoveInput.y), state.Yaw);
            Vector3 desired = wish * speed;

            var current = new Vector3(state.Velocity.x, 0f, state.Velocity.z);

            // Decelerating uses a different rate from accelerating, which is
            // most of what makes stopping feel crisp rather than sliding.
            float rate = desired.sqrMagnitude > current.sqrMagnitude
                ? blueprint.Acceleration
                : blueprint.Deceleration;

            if (!state.Grounded)
            {
                rate *= blueprint.AirControl;
            }

            Vector3 changed = Vector3.MoveTowards(current, desired, rate * dt);
            state.Velocity.x = changed.x;
            state.Velocity.z = changed.z;
        }

        private static void ApplyGravity(
            ref MotorState state, MovementBlueprint blueprint, float dt)
        {
            if (state.Grounded && state.Velocity.y <= 0f)
            {
                // A small downward bias keeps the character pinned to the ground
                // across a step rather than skipping off crests.
                state.Velocity.y = -2f;
                return;
            }

            state.Velocity.y += blueprint.Gravity * dt;
            if (state.Velocity.y < -blueprint.TerminalVelocity)
            {
                state.Velocity.y = -blueprint.TerminalVelocity;
            }
        }

        private static bool TryStartMantle(
            ref MotorState state,
            in MoveCommand command,
            MovementBlueprint blueprint,
            IMotorCollision collision)
        {
            // Mantling requires forward intent. Without this a player pressed
            // against a ledge would mantle it by standing still.
            if (command.MoveInput.y <= 0.1f)
            {
                return false;
            }

            Vector3 forward = YawRotate(Vector3.forward, state.Yaw);

            if (!collision.TryFindLedge(
                    state.Position, forward, blueprint.MantleMaxHeight, CapsuleRadius,
                    out Vector3 ledge))
            {
                return false;
            }

            state.MantleStart = state.Position;
            state.MantleTarget = ledge;
            state.MantleDuration = blueprint.MantleSeconds;
            state.MantleRemaining = blueprint.MantleSeconds;
            state.Velocity = Vector3.zero;
            return true;
        }

        private static MotorStepResult StepMantle(ref MotorState state, float dt)
        {
            state.MantleRemaining -= dt;

            if (state.MantleRemaining <= 0f)
            {
                state.Position = state.MantleTarget;
                state.MantleRemaining = 0f;
                state.Grounded = true;
                state.PeakY = state.Position.y;
                return new MotorStepResult(0f, true, false, false);
            }

            float elapsed = state.MantleDuration - state.MantleRemaining;
            float t = state.MantleDuration <= 0f ? 1f : elapsed / state.MantleDuration;
            state.Position = Vector3.Lerp(state.MantleStart, state.MantleTarget, t);
            return MotorStepResult.None;
        }

        public static float SpeedFor(
            in MoveCommand command, MovementBlueprint blueprint, bool crouched)
        {
            if (crouched)
            {
                return blueprint.CrouchSpeed;
            }

            // Sprint only applies to genuine forward movement, so strafing away
            // from a fight is not as fast as running into one.
            bool sprinting = command.Has(MoveFlags.Sprint) && command.MoveInput.y > 0.1f;
            return sprinting ? blueprint.SprintSpeed : blueprint.WalkSpeed;
        }

        public static float CurrentHeight(in MotorState state, MovementBlueprint blueprint) =>
            state.Crouched ? blueprint.CrouchHeight : blueprint.StandHeight;

        /// <summary>
        /// Rotate a vector about Y by <paramref name="yawDegrees"/>.
        /// </summary>
        /// <remarks>
        /// Written out rather than using <c>Quaternion.Euler</c> because this
        /// runs inside the reconciliation replay loop, where the cost of
        /// building a quaternion per tick per replayed command is real.
        /// </remarks>
        public static Vector3 YawRotate(Vector3 v, float yawDegrees)
        {
            float radians = yawDegrees * Mathf.Deg2Rad;
            float cos = Mathf.Cos(radians);
            float sin = Mathf.Sin(radians);
            return new Vector3(v.x * cos + v.z * sin, v.y, -v.x * sin + v.z * cos);
        }
    }
}
