using UnityEngine;

namespace Tonight.Gameplay.Movement
{
    /// <summary>
    /// <see cref="IMotorCollision"/> backed by Unity's <see cref="CharacterController"/>.
    /// </summary>
    /// <remarks>
    /// The real collision world. It is deliberately the only part of locomotion
    /// that touches the scene: everything else is in <see cref="CharacterMotor"/>,
    /// which is why the motor can be tested exhaustively without Play mode.
    /// </remarks>
    public sealed class UnityCapsuleCollision : IMotorCollision
    {
        private readonly CharacterController _controller;
        private readonly LayerMask _obstacles;

        // Reused so the ledge probe does not allocate per tick.
        private readonly RaycastHit[] _hits = new RaycastHit[4];

        public UnityCapsuleCollision(CharacterController controller, LayerMask obstacles)
        {
            _controller = controller;
            _obstacles = obstacles;
        }

        public MotorCollisionResult Move(
            Vector3 position, Vector3 delta, float capsuleHeight, float capsuleRadius)
        {
            _controller.height = capsuleHeight;
            _controller.radius = capsuleRadius;
            // The controller's origin is its centre, while the motor works from
            // the character's feet.
            _controller.center = new Vector3(0f, capsuleHeight * 0.5f, 0f);

            _controller.transform.position = position;
            CollisionFlags flags = _controller.Move(delta);

            return new MotorCollisionResult(
                _controller.transform.position,
                grounded: _controller.isGrounded || (flags & CollisionFlags.Below) != 0,
                hitCeiling: (flags & CollisionFlags.Above) != 0,
                hitWall: (flags & CollisionFlags.Sides) != 0);
        }

        public bool TryFindLedge(
            Vector3 position,
            Vector3 forward,
            float maxHeight,
            float capsuleRadius,
            out Vector3 ledgePosition)
        {
            ledgePosition = default;

            // Probe forward at knee height to find the face of an obstacle.
            Vector3 kneeOrigin = position + Vector3.up * 0.3f;
            if (!Physics.Raycast(kneeOrigin, forward, out RaycastHit wall, 0.6f, _obstacles))
            {
                return false;
            }

            // Then probe down from above the obstacle to find its top surface.
            Vector3 aboveOrigin = position
                                  + forward * (capsuleRadius + 0.2f)
                                  + Vector3.up * (maxHeight + 0.3f);

            if (!Physics.Raycast(
                    aboveOrigin, Vector3.down, out RaycastHit top, maxHeight + 0.3f, _obstacles))
            {
                return false;
            }

            float rise = top.point.y - position.y;
            if (rise < 0.3f || rise > maxHeight)
            {
                return false;
            }

            // Refuse if there is no room to stand on the ledge, so a player
            // cannot mantle into a crawlspace and become stuck.
            if (Physics.CheckCapsule(
                    top.point + Vector3.up * (capsuleRadius + 0.05f),
                    top.point + Vector3.up * (1.8f - capsuleRadius),
                    capsuleRadius * 0.9f,
                    _obstacles))
            {
                return false;
            }

            ledgePosition = top.point;
            return true;
        }

        public bool HasHeadroom(Vector3 position, float standHeight, float capsuleRadius)
        {
            Vector3 bottom = position + Vector3.up * (capsuleRadius + 0.05f);
            Vector3 top = position + Vector3.up * (standHeight - capsuleRadius);
            return !Physics.CheckCapsule(bottom, top, capsuleRadius * 0.95f, _obstacles);
        }
    }
}
