using System.Collections.Generic;
using Tonight.Blueprints.Character;
using Tonight.Gameplay.Commands;
using Tonight.Gameplay.Movement;
using UnityEngine;

namespace Tonight.Net
{
    /// <summary>What reconciling against a server state did.</summary>
    public readonly struct ReconcileResult
    {
        public readonly bool Corrected;
        public readonly int ReplayedCommands;
        public readonly float PositionError;

        public ReconcileResult(bool corrected, int replayedCommands, float positionError)
        {
            Corrected = corrected;
            ReplayedCommands = replayedCommands;
            PositionError = positionError;
        }
    }

    /// <summary>
    /// Client-side movement prediction with server reconciliation.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The client applies its own input immediately and stores each
    /// (command, resulting state) pair. When the server acknowledges a tick,
    /// the stored prediction for that tick is compared against the
    /// authoritative state: if they agree the history is simply pruned, and if
    /// they do not the client snaps to the server's answer and replays every
    /// command since.
    /// </para>
    /// <para>
    /// Replay must be exact, which is the entire reason
    /// <see cref="CharacterMotor"/> reads neither input nor
    /// <c>Time.deltaTime</c> and contains no randomness (ADR-0003). A single
    /// non-deterministic term makes reconciliation jitter permanently, and the
    /// symptom looks nothing like its cause.
    /// </para>
    /// </remarks>
    public sealed class MovementPredictionBuffer
    {
        /// <summary>
        /// Below this, a correction would be visible jitter rather than a fix.
        /// </summary>
        public const float PositionEpsilon = 0.01f;

        public const float AngleEpsilon = 0.5f;

        /// <summary>
        /// How many ticks of history to keep. Two seconds at 30 Hz comfortably
        /// covers the 250 ms compensation bound plus a bad connection.
        /// </summary>
        public const int Capacity = 64;

        private readonly struct Entry
        {
            public readonly int Tick;
            public readonly MoveCommand Command;
            public readonly MotorState Result;

            public Entry(int tick, in MoveCommand command, in MotorState result)
            {
                Tick = tick;
                Command = command;
                Result = result;
            }
        }

        private readonly List<Entry> _history = new List<Entry>(Capacity);

        public int PendingCount => _history.Count;

        public int OldestTick => _history.Count > 0 ? _history[0].Tick : -1;

        public int NewestTick => _history.Count > 0 ? _history[^1].Tick : -1;

        /// <summary>Record a locally applied command and the state it produced.</summary>
        public void Record(int tick, in MoveCommand command, in MotorState result)
        {
            _history.Add(new Entry(tick, command, result));

            // Dropping the oldest rather than growing without bound: if the
            // server has not acknowledged in two seconds, the connection has
            // bigger problems than a lost prediction.
            if (_history.Count > Capacity)
            {
                _history.RemoveAt(0);
            }
        }

        /// <summary>
        /// Reconcile against an authoritative state.
        /// </summary>
        /// <param name="ackTick">The tick the server simulated.</param>
        /// <param name="authoritative">The server's answer for that tick.</param>
        /// <param name="current">
        /// The client's current state, replaced when a correction is needed.
        /// </param>
        public ReconcileResult Reconcile(
            int ackTick,
            in MotorState authoritative,
            ref MotorState current,
            MovementBlueprint blueprint,
            IMotorCollision collision)
        {
            int index = IndexOfTick(ackTick);
            if (index < 0)
            {
                // The acknowledged tick is outside our history: either an old
                // duplicate, or we fell so far behind that replay is pointless.
                // Accepting the server's state outright is the safe answer.
                if (ackTick > NewestTick)
                {
                    current = authoritative;
                    _history.Clear();
                    return new ReconcileResult(true, 0, 0f);
                }

                return new ReconcileResult(false, 0, 0f);
            }

            MotorState predicted = _history[index].Result;
            float error = Vector3.Distance(predicted.Position, authoritative.Position);
            float yawError = Mathf.Abs(Mathf.DeltaAngle(predicted.Yaw, authoritative.Yaw));

            if (error <= PositionEpsilon && yawError <= AngleEpsilon)
            {
                // Agreement: prune everything up to and including the acked tick.
                _history.RemoveRange(0, index + 1);
                return new ReconcileResult(false, 0, error);
            }

            // Disagreement: snap and replay.
            MotorState replayed = authoritative;
            int replayCount = 0;

            for (int i = index + 1; i < _history.Count; i++)
            {
                Entry entry = _history[i];
                replayed = CharacterMotor.Step(
                    replayed, entry.Command, blueprint, collision, out _);
                _history[i] = new Entry(entry.Tick, entry.Command, replayed);
                replayCount++;
            }

            current = replayed;
            _history.RemoveRange(0, index + 1);
            return new ReconcileResult(true, replayCount, error);
        }

        private int IndexOfTick(int tick)
        {
            // Linear rather than binary: the list is at most 64 entries and is
            // usually pruned to a handful, so the branch-free scan wins.
            for (int i = 0; i < _history.Count; i++)
            {
                if (_history[i].Tick == tick)
                {
                    return i;
                }
            }

            return -1;
        }

        public void Clear() => _history.Clear();
    }
}
