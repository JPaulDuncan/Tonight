using System.Collections.Generic;
using Tonight.Blueprints.Building;
using Tonight.Core;
using Tonight.Gameplay.Commands;
using Tonight.Gameplay.Inventory;
using UnityEngine;

namespace Tonight.Gameplay.Building
{
    /// <summary>What happened to a piece this tick.</summary>
    public readonly struct StructureEvent
    {
        public enum Kind
        {
            Placed,
            Damaged,
            Destroyed,
            Collapsed,
            Edited,
        }

        public readonly Kind Type;
        public readonly GridCell Cell;
        public readonly BuildSlot Slot;

        public StructureEvent(Kind type, GridCell cell, BuildSlot slot)
        {
            Type = type;
            Cell = cell;
            Slot = slot;
        }
    }

    /// <summary>
    /// Owns the build structure and the rules that change it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The authoritative build state on the server and the predicted state on
    /// the client -- the same class, running the same validation, because
    /// ADR-0003 rule 4 requires prediction and authority to share one
    /// implementation rather than two that can drift.
    /// </para>
    /// <para>
    /// Implements <see cref="IPlacementWorld"/> so
    /// <see cref="PlaceBuildCommand.Validate"/> can interrogate it.
    /// </para>
    /// </remarks>
    public sealed class BuildWorld : IPlacementWorld
    {
        /// <summary>
        /// Delay between losing support and being destroyed, in seconds.
        /// </summary>
        /// <remarks>
        /// Both a design choice -- the player sees the tower fall, so it reads
        /// as a consequence -- and a performance one: it lets a large cascade be
        /// spread across ticks inside the server's build budget instead of
        /// landing in one.
        /// </remarks>
        public const float CollapseDelaySeconds = 0.4f;

        /// <summary>Maximum collapses processed per tick, so a mega-build's
        /// collapse cannot spike a single tick past the budget.</summary>
        public const int MaxCollapsesPerTick = 32;

        private readonly BuildStructure _structure = new BuildStructure();
        private readonly Dictionary<BuildStructure.PieceKey, int> _collapseAt =
            new Dictionary<BuildStructure.PieceKey, int>();

        private readonly List<BuildStructure.PieceKey> _scratchCollapsed =
            new List<BuildStructure.PieceKey>(64);
        private readonly List<BuildStructure.PieceKey> _scratchDue =
            new List<BuildStructure.PieceKey>(64);

        private readonly Dictionary<int, MaterialWallet> _wallets =
            new Dictionary<int, MaterialWallet>();
        private readonly Dictionary<int, Vector3> _playerPositions =
            new Dictionary<int, Vector3>();
        private readonly Dictionary<int, List<int>> _recentPlacements =
            new Dictionary<int, List<int>>();

        private readonly int _tickRate;

        public BuildWorld(int tickRate = 30)
        {
            _tickRate = Mathf.Max(1, tickRate);
        }

        public BuildStructure Structure => _structure;

        /// <summary>Raised for every structural change. The renderer and the
        /// replication layer both listen; neither drives the simulation.</summary>
        public event System.Action<StructureEvent> Changed;

        /// <summary>Terrain test, injected so the world is testable without a scene.</summary>
        public System.Func<GridCell, bool> TouchesGround
        {
            get => _structure.TouchesGround;
            set => _structure.TouchesGround = value;
        }

        /// <summary>Overlap test for the player-intersection rule. Defaults to
        /// "nothing is in the way", which is correct for tests and for a world
        /// with no other players yet.</summary>
        public System.Func<GridCell, BuildSlot, int, bool> PlayerOverlapTest { get; set; }
            = (_, _, _) => false;

        // ---------------------------------------------------------------
        // IPlacementWorld
        // ---------------------------------------------------------------

        public int GetMaterialCount(int playerId, BuildMaterialBlueprint material) =>
            _wallets.TryGetValue(playerId, out MaterialWallet wallet) ? wallet.Get(material) : 0;

        public float DistanceFromPlayer(int playerId, GridCell cell)
        {
            if (!_playerPositions.TryGetValue(playerId, out Vector3 position))
            {
                // Unknown player: report out of range rather than in range, so a
                // missing registration fails closed.
                return float.MaxValue;
            }

            return Vector3.Distance(position, BuildGrid.CellCentre(cell));
        }

        public bool WouldIntersectLivingPlayer(GridCell cell, BuildSlot slot, int placingPlayerId) =>
            PlayerOverlapTest(cell, slot, placingPlayerId);

        public int RecentPlacementCount(int playerId)
        {
            if (!_recentPlacements.TryGetValue(playerId, out List<int> ticks))
            {
                return 0;
            }

            return ticks.Count;
        }

        // ---------------------------------------------------------------
        // Registration
        // ---------------------------------------------------------------

        public void SetPlayerPosition(int playerId, Vector3 position) =>
            _playerPositions[playerId] = position;

        public MaterialWallet GetWallet(int playerId) =>
            _wallets.TryGetValue(playerId, out MaterialWallet wallet) ? wallet : default;

        public void SetWallet(int playerId, MaterialWallet wallet) => _wallets[playerId] = wallet;

        // ---------------------------------------------------------------
        // Placement
        // ---------------------------------------------------------------

        /// <summary>
        /// Validate and apply a placement.
        /// </summary>
        /// <param name="enforceRateLimit">
        /// True on the server only. The rate limit is a sanity check against
        /// automation, and applying it client-side would make a legitimately
        /// fast builder mispredict.
        /// </param>
        public PlacementRejection TryPlace(
            in PlaceBuildCommand command, int tick, bool enforceRateLimit)
        {
            PlacementRejection rejection = command.Validate(this, enforceRateLimit);
            if (rejection != PlacementRejection.None)
            {
                return rejection;
            }

            MaterialWallet wallet = GetWallet(command.PlayerId);
            if (!wallet.TrySpend(command.Material, command.Cost))
            {
                // Validate already checked affordability; reaching here means
                // the wallet changed between check and apply.
                return PlacementRejection.Unaffordable;
            }

            SetWallet(command.PlayerId, wallet);

            PlacedPiece piece = command.ToPlacedPiece(tick);
            piece.DamageTaken = 0f;

            if (!_structure.TryAdd(piece))
            {
                // Slot was taken between check and apply. Refund exactly.
                wallet.Refund(command.Material, command.Cost);
                SetWallet(command.PlayerId, wallet);
                return PlacementRejection.SlotOccupied;
            }

            RecordPlacement(command.PlayerId, tick);
            Changed?.Invoke(new StructureEvent(
                StructureEvent.Kind.Placed, piece.Cell, piece.Slot));

            // A new piece can restore support to an orphaned stack above it.
            ClearRescuedCollapses();
            return PlacementRejection.None;
        }

        /// <summary>Roll back a predicted placement the server rejected.</summary>
        public void RollbackPrediction(in PlaceBuildCommand command)
        {
            _scratchCollapsed.Clear();
            _structure.TryRemove(command.Cell, command.Slot, _scratchCollapsed);

            MaterialWallet wallet = GetWallet(command.PlayerId);
            wallet.Refund(command.Material, command.Cost);
            SetWallet(command.PlayerId, wallet);
        }

        // ---------------------------------------------------------------
        // Health
        // ---------------------------------------------------------------

        /// <summary>Current health of a piece, accounting for the build ramp.</summary>
        public float HealthOf(in PlacedPiece piece, int currentTick)
        {
            if (piece.Material == null)
            {
                return 0f;
            }

            float age = Mathf.Max(0, currentTick - piece.PlacedTick) / (float)_tickRate;
            return piece.Material.HealthAtAge(age) - piece.DamageTaken;
        }

        public bool TryGetHealth(
            GridCell cell, BuildSlot slot, int currentTick, out float health)
        {
            if (!_structure.TryGet(cell, slot, out PlacedPiece piece))
            {
                health = 0f;
                return false;
            }

            health = HealthOf(piece, currentTick);
            return true;
        }

        /// <summary>
        /// Damage a piece. Returns true when it was destroyed.
        /// </summary>
        public bool ApplyDamage(GridCell cell, BuildSlot slot, float amount, int tick)
        {
            if (amount <= 0f || !_structure.TryGet(cell, slot, out PlacedPiece piece))
            {
                return false;
            }

            piece.DamageTaken += amount;
            _structure.Replace(piece);

            if (HealthOf(piece, tick) > 0f)
            {
                Changed?.Invoke(new StructureEvent(StructureEvent.Kind.Damaged, cell, slot));
                return false;
            }

            Destroy(cell, slot, tick, StructureEvent.Kind.Destroyed);
            return true;
        }

        private void Destroy(GridCell cell, BuildSlot slot, int tick, StructureEvent.Kind kind)
        {
            _scratchCollapsed.Clear();
            if (!_structure.TryRemove(cell, slot, _scratchCollapsed))
            {
                return;
            }

            Changed?.Invoke(new StructureEvent(kind, cell, slot));

            int collapseTick = tick + Mathf.CeilToInt(CollapseDelaySeconds * _tickRate);
            for (int i = 0; i < _scratchCollapsed.Count; i++)
            {
                BuildStructure.PieceKey key = _scratchCollapsed[i];
                // Keep the earliest scheduled time: a piece already falling
                // should not have its collapse postponed by a later event.
                if (!_collapseAt.TryGetValue(key, out int existing) || collapseTick < existing)
                {
                    _collapseAt[key] = collapseTick;
                }
            }
        }

        // ---------------------------------------------------------------
        // Per-tick
        // ---------------------------------------------------------------

        /// <summary>
        /// Advance the world one tick: expire placement-rate history and process
        /// due collapses within the per-tick budget.
        /// </summary>
        public void Tick(int tick)
        {
            ExpirePlacementHistory(tick);
            ProcessCollapses(tick);
        }

        private void ProcessCollapses(int tick)
        {
            if (_collapseAt.Count == 0)
            {
                return;
            }

            _scratchDue.Clear();
            foreach (KeyValuePair<BuildStructure.PieceKey, int> entry in _collapseAt)
            {
                if (entry.Value <= tick)
                {
                    _scratchDue.Add(entry.Key);
                    if (_scratchDue.Count >= MaxCollapsesPerTick)
                    {
                        // The rest wait for the next tick. A mega-build's
                        // collapse is allowed to take several ticks; spiking one
                        // tick past the budget is not.
                        break;
                    }
                }
            }

            for (int i = 0; i < _scratchDue.Count; i++)
            {
                BuildStructure.PieceKey key = _scratchDue[i];
                _collapseAt.Remove(key);

                if (_structure.IsOccupied(key.Cell, key.Slot))
                {
                    Destroy(key.Cell, key.Slot, tick, StructureEvent.Kind.Collapsed);
                }
            }
        }

        /// <summary>
        /// Drop scheduled collapses for pieces that have regained support.
        /// </summary>
        /// <remarks>
        /// Building a leg back under an orphaned stack within the delay window
        /// should save it. Without this the stack would fall anyway, which would
        /// read as the game ignoring what the player just did.
        /// </remarks>
        private void ClearRescuedCollapses()
        {
            if (_collapseAt.Count == 0)
            {
                return;
            }

            _scratchDue.Clear();
            foreach (KeyValuePair<BuildStructure.PieceKey, int> entry in _collapseAt)
            {
                if (_structure.TryGet(entry.Key.Cell, entry.Key.Slot, out PlacedPiece piece) &&
                    piece.SupportDistance != BuildStructure.Unsupported)
                {
                    _scratchDue.Add(entry.Key);
                }
            }

            for (int i = 0; i < _scratchDue.Count; i++)
            {
                _collapseAt.Remove(_scratchDue[i]);
            }
        }

        public int PendingCollapseCount => _collapseAt.Count;

        private void RecordPlacement(int playerId, int tick)
        {
            if (!_recentPlacements.TryGetValue(playerId, out List<int> ticks))
            {
                ticks = new List<int>(16);
                _recentPlacements[playerId] = ticks;
            }

            ticks.Add(tick);
        }

        private void ExpirePlacementHistory(int tick)
        {
            int cutoff = tick - _tickRate;
            foreach (KeyValuePair<int, List<int>> entry in _recentPlacements)
            {
                List<int> ticks = entry.Value;
                int keepFrom = 0;
                while (keepFrom < ticks.Count && ticks[keepFrom] < cutoff)
                {
                    keepFrom++;
                }

                if (keepFrom > 0)
                {
                    ticks.RemoveRange(0, keepFrom);
                }
            }
        }

        public void Clear()
        {
            _structure.Clear();
            _collapseAt.Clear();
            _wallets.Clear();
            _playerPositions.Clear();
            _recentPlacements.Clear();
        }
    }
}
