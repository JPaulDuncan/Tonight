using System;
using UnityEngine;

namespace Tonight.Gameplay.Commands
{
    [Flags]
    public enum MoveFlags : byte
    {
        None = 0,
        Jump = 1 << 0,
        Sprint = 1 << 1,
        Crouch = 1 << 2,
        Interact = 1 << 3,
    }

    /// <summary>
    /// One tick of movement intent.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Note that <see cref="DeltaTime"/> travels in the command rather than
    /// being read from <c>Time.deltaTime</c>. Reconciliation replays a stored
    /// command sequence and must reproduce the original result exactly; a
    /// single frame-rate-dependent term makes that replay drift, and the
    /// symptom is permanent jitter that is very hard to trace back to its
    /// cause. Same reason simulation never reads input directly.
    /// </para>
    /// </remarks>
    public readonly struct MoveCommand
    {
        public readonly int Tick;
        public readonly Vector2 MoveInput;
        public readonly Vector2 LookDelta;
        public readonly MoveFlags Flags;
        public readonly float DeltaTime;

        public MoveCommand(
            int tick,
            Vector2 moveInput,
            Vector2 lookDelta,
            MoveFlags flags,
            float deltaTime)
        {
            Tick = tick;
            // Clamped at the edge so a malformed or hostile client cannot ask
            // for a movement magnitude above 1.
            MoveInput = Vector2.ClampMagnitude(moveInput, 1f);
            LookDelta = lookDelta;
            Flags = flags;
            DeltaTime = deltaTime;
        }

        public bool Has(MoveFlags flag) => (Flags & flag) != 0;

        /// <summary>
        /// Server-side sanity check on the command itself, before simulating it.
        /// A dt outside the plausible band is either a broken client or an
        /// attempt to simulate extra movement in one tick.
        /// </summary>
        public bool IsPlausible(float expectedDt) =>
            DeltaTime > 0f &&
            DeltaTime <= expectedDt * 2f &&
            !float.IsNaN(MoveInput.x) &&
            !float.IsNaN(MoveInput.y);
    }
}
