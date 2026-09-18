using UnityEngine;

namespace Tonight.Gameplay.Movement
{
    /// <summary>
    /// The complete mutable state of one character's locomotion.
    /// </summary>
    /// <remarks>
    /// A struct, and deliberately everything the simulation needs: reconciliation
    /// snapshots and replays this wholesale, so a piece of locomotion state
    /// living anywhere else would silently fail to roll back
    /// (ADR-0003).
    /// </remarks>
    public struct MotorState
    {
        public Vector3 Position;
        public Vector3 Velocity;

        public float Yaw;
        public float Pitch;

        public bool Grounded;
        public bool Crouched;

        /// <summary>
        /// Highest Y reached since the character was last grounded. Fall damage
        /// is measured from here, not from where the fall was "intended" to
        /// start, so a player who builds a ramp under themselves mid-fall is
        /// correctly spared.
        /// </summary>
        public float PeakY;

        /// <summary>Seconds left in a mantle. Zero means not mantling.</summary>
        public float MantleRemaining;

        public Vector3 MantleStart;
        public Vector3 MantleTarget;
        public float MantleDuration;

        public bool IsMantling => MantleRemaining > 0f;

        public static MotorState AtRest(Vector3 position) => new MotorState
        {
            Position = position,
            Velocity = Vector3.zero,
            Grounded = true,
            PeakY = position.y,
        };
    }

    /// <summary>What a single simulation step produced, beyond the new state.</summary>
    public readonly struct MotorStepResult
    {
        /// <summary>Fall damage to apply this tick. Zero on most ticks.</summary>
        public readonly float FallDamage;

        public readonly bool Landed;
        public readonly bool Jumped;
        public readonly bool StartedMantle;

        public MotorStepResult(float fallDamage, bool landed, bool jumped, bool startedMantle)
        {
            FallDamage = fallDamage;
            Landed = landed;
            Jumped = jumped;
            StartedMantle = startedMantle;
        }

        public static readonly MotorStepResult None = new MotorStepResult(0f, false, false, false);
    }

    /// <summary>Outcome of one collision-resolved move.</summary>
    public readonly struct MotorCollisionResult
    {
        public readonly Vector3 Position;
        public readonly bool Grounded;
        public readonly bool HitCeiling;
        public readonly bool HitWall;

        public MotorCollisionResult(Vector3 position, bool grounded, bool hitCeiling, bool hitWall)
        {
            Position = position;
            Grounded = grounded;
            HitCeiling = hitCeiling;
            HitWall = hitWall;
        }
    }

    /// <summary>
    /// The collision world the motor moves through.
    /// </summary>
    /// <remarks>
    /// An interface so the motor can be stepped in an EditMode test against a
    /// flat plane, with no scene, no physics, and no Play mode. The motor is
    /// the piece most likely to hide a determinism bug, so being able to run it
    /// ten thousand times in a unit test is worth the indirection.
    /// </remarks>
    public interface IMotorCollision
    {
        /// <summary>Sweep a capsule from <paramref name="position"/> by <paramref name="delta"/>.</summary>
        MotorCollisionResult Move(Vector3 position, Vector3 delta, float capsuleHeight, float capsuleRadius);

        /// <summary>
        /// Find a ledge the character could mantle onto, if any.
        /// </summary>
        bool TryFindLedge(
            Vector3 position,
            Vector3 forward,
            float maxHeight,
            float capsuleRadius,
            out Vector3 ledgePosition);

        /// <summary>True when there is room to stand up from a crouch.</summary>
        bool HasHeadroom(Vector3 position, float standHeight, float capsuleRadius);
    }

    /// <summary>
    /// An infinite flat plane at a fixed height.
    /// </summary>
    /// <remarks>
    /// The reference implementation, used by the motor's tests and by the
    /// earliest practice-range setup. Keeping a trivial collision world in the
    /// runtime assembly means a determinism regression can be reproduced
    /// without a scene at all.
    /// </remarks>
    public sealed class FlatGroundCollision : IMotorCollision
    {
        private readonly float _groundY;

        public FlatGroundCollision(float groundY = 0f)
        {
            _groundY = groundY;
        }

        public MotorCollisionResult Move(
            Vector3 position, Vector3 delta, float capsuleHeight, float capsuleRadius)
        {
            Vector3 target = position + delta;

            if (target.y <= _groundY)
            {
                return new MotorCollisionResult(
                    new Vector3(target.x, _groundY, target.z),
                    grounded: true,
                    hitCeiling: false,
                    hitWall: false);
            }

            // Airborne but only just: treat resting exactly on the plane as
            // grounded so a character standing still does not oscillate between
            // grounded and airborne on alternate ticks.
            bool grounded = Mathf.Approximately(target.y, _groundY);
            return new MotorCollisionResult(target, grounded, false, false);
        }

        public bool TryFindLedge(
            Vector3 position, Vector3 forward, float maxHeight, float capsuleRadius,
            out Vector3 ledgePosition)
        {
            ledgePosition = default;
            return false;
        }

        public bool HasHeadroom(Vector3 position, float standHeight, float capsuleRadius) => true;
    }
}
