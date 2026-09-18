using System.Collections.Generic;
using UnityEngine;

namespace Tonight.Net
{
    /// <summary>
    /// Server-side hitbox rewind for lag-compensated hit registration.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The server rewinds every other player's hitboxes to where the shooter
    /// saw them, bounded to 250 ms. That bound is the fairness boundary:
    /// beyond it a high-latency shooter would be killing people who have been
    /// behind cover for a quarter of a second on their own screen. Players
    /// above the cap are compensated to 250 ms and no further.
    /// </para>
    /// <para>
    /// The buffer stores 500 ms of history so a rewind at the cap still has a
    /// sample either side to interpolate between.
    /// </para>
    /// </remarks>
    public sealed class HitboxRewindBuffer
    {
        /// <summary>The fairness bound, in seconds.</summary>
        public const float MaxRewindSeconds = 0.25f;

        /// <summary>History retained, in seconds.</summary>
        public const float HistorySeconds = 0.5f;

        private readonly struct Snapshot
        {
            public readonly int Tick;
            public readonly Vector3 Position;
            public readonly float Yaw;

            public Snapshot(int tick, Vector3 position, float yaw)
            {
                Tick = tick;
                Position = position;
                Yaw = yaw;
            }
        }

        private readonly Dictionary<int, List<Snapshot>> _byPlayer =
            new Dictionary<int, List<Snapshot>>();

        private readonly int _tickRate;

        public HitboxRewindBuffer(int tickRate = 30)
        {
            _tickRate = Mathf.Max(1, tickRate);
        }

        public int MaxRewindTicks => Mathf.CeilToInt(MaxRewindSeconds * _tickRate);

        private int HistoryTicks => Mathf.CeilToInt(HistorySeconds * _tickRate);

        /// <summary>Record a player's position for this tick.</summary>
        public void Capture(int playerId, int tick, Vector3 position, float yaw)
        {
            if (!_byPlayer.TryGetValue(playerId, out List<Snapshot> history))
            {
                history = new List<Snapshot>(HistoryTicks + 4);
                _byPlayer[playerId] = history;
            }

            history.Add(new Snapshot(tick, position, yaw));

            int cutoff = tick - HistoryTicks;
            int drop = 0;
            while (drop < history.Count && history[drop].Tick < cutoff)
            {
                drop++;
            }

            if (drop > 0)
            {
                history.RemoveRange(0, drop);
            }
        }

        /// <summary>
        /// Clamp a requested rewind to the fairness bound.
        /// </summary>
        /// <returns>The tick the server will actually rewind to.</returns>
        public int ClampRewindTick(int serverTick, int clientTick)
        {
            // A client claiming a future tick gets no compensation at all rather
            // than negative compensation.
            if (clientTick >= serverTick)
            {
                return serverTick;
            }

            int requested = serverTick - clientTick;
            int allowed = Mathf.Min(requested, MaxRewindTicks);
            return serverTick - allowed;
        }

        /// <summary>
        /// Where a player was at a given tick, interpolating between samples.
        /// </summary>
        public bool TryGetAt(int playerId, int tick, out Vector3 position, out float yaw)
        {
            position = default;
            yaw = 0f;

            if (!_byPlayer.TryGetValue(playerId, out List<Snapshot> history) || history.Count == 0)
            {
                return false;
            }

            if (tick <= history[0].Tick)
            {
                position = history[0].Position;
                yaw = history[0].Yaw;
                return true;
            }

            if (tick >= history[^1].Tick)
            {
                position = history[^1].Position;
                yaw = history[^1].Yaw;
                return true;
            }

            for (int i = 1; i < history.Count; i++)
            {
                if (history[i].Tick < tick)
                {
                    continue;
                }

                Snapshot before = history[i - 1];
                Snapshot after = history[i];
                int span = after.Tick - before.Tick;
                float t = span <= 0 ? 0f : (tick - before.Tick) / (float)span;

                position = Vector3.Lerp(before.Position, after.Position, t);
                yaw = Mathf.LerpAngle(before.Yaw, after.Yaw, t);
                return true;
            }

            return false;
        }

        public int SnapshotCount(int playerId) =>
            _byPlayer.TryGetValue(playerId, out List<Snapshot> history) ? history.Count : 0;

        public void Forget(int playerId) => _byPlayer.Remove(playerId);

        public void Clear() => _byPlayer.Clear();
    }

    /// <summary>
    /// Server-side sanity checks on client commands.
    /// </summary>
    /// <remarks>
    /// Server authority plus bounds checks, per the vision's explicit non-goal
    /// of building an anti-cheat product. Aim analysis is deliberately absent:
    /// false positives there punish good players, and a wrong ban is worse than
    /// a missed cheater.
    /// </remarks>
    public static class CommandSanity
    {
        public const float SpeedTolerance = 1.1f;
        public const float TeleportLimitMetres = 20f;
        public const float FireRateTolerance = 1.1f;
        public const float TimestampToleranceSeconds = 0.5f;

        public static bool IsSpeedPlausible(
            Vector3 from, Vector3 to, float deltaTime, float maxSpeed)
        {
            if (deltaTime <= 0f)
            {
                return false;
            }

            float travelled = Vector3.Distance(from, to);
            return travelled <= maxSpeed * SpeedTolerance * deltaTime + 0.001f;
        }

        public static bool IsNotATeleport(Vector3 from, Vector3 to) =>
            Vector3.Distance(from, to) <= TeleportLimitMetres;

        public static bool IsTimestampPlausible(int serverTick, int clientTick, int tickRate)
        {
            int allowed = Mathf.CeilToInt(TimestampToleranceSeconds * tickRate);
            return Mathf.Abs(serverTick - clientTick) <= allowed;
        }

        public static bool IsFireRatePlausible(
            int ticksSinceLastShot, int requiredIntervalTicks) =>
            ticksSinceLastShot >= Mathf.FloorToInt(requiredIntervalTicks / FireRateTolerance);
    }
}
