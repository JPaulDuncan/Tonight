using System.Collections.Generic;
using Tonight.Blueprints.Building;
using Tonight.Core;

namespace Tonight.Gameplay.Building
{
    /// <summary>One placed build piece, keyed by (cell, slot).</summary>
    public struct PlacedPiece
    {
        public GridCell Cell;
        public BuildSlot Slot;
        public BuildPieceBlueprint Piece;
        public BuildMaterialBlueprint Material;
        public int OwnerId;

        /// <summary>Tick at which the piece was placed, for the build-HP ramp.</summary>
        public int PlacedTick;

        /// <summary>
        /// Accumulated damage, rather than a current-HP value.
        /// </summary>
        /// <remarks>
        /// Storing damage instead of health is what lets the build-HP ramp keep
        /// running after a piece is shot: a wall that survives a burst goes on
        /// maturing toward full health rather than being frozen at whatever it
        /// had left. Current health is
        /// <c>material.HealthAtAge(age) - DamageTaken</c>.
        /// </remarks>
        public float DamageTaken;

        /// <summary>
        /// Hops back to ground. 0 means the piece touches terrain.
        /// <see cref="BuildStructure.Unsupported"/> means no path to ground.
        /// </summary>
        public int SupportDistance;

        /// <summary>Packed 3x3 edit mask; 511 is the unedited solid piece.</summary>
        public int EditMask;
    }

    /// <summary>
    /// The structure graph: every placed piece, and the support relation
    /// between them.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the authoritative build state on the server and the predicted
    /// state on the client. It is deliberately not a collection of
    /// NetworkObjects -- pieces never move and are fully described by an
    /// integer cell, so they replicate through a 9-byte-per-piece channel
    /// instead (ADR-0002).
    /// </para>
    /// <para>
    /// Support is cached rather than recomputed per frame. On destruction the
    /// affected neighbourhood is re-flooded and anything left without a path to
    /// ground is queued for collapse. See docs/systems/building.md section 3.
    /// </para>
    /// </remarks>
    public sealed class BuildStructure
    {
        /// <summary>Sentinel support distance meaning "no path to ground".</summary>
        public const int Unsupported = int.MaxValue;

        /// <summary>The unedited full 3x3 mask.</summary>
        public const int SolidMask = 0b111_111_111;

        private readonly Dictionary<PieceKey, PlacedPiece> _pieces =
            new Dictionary<PieceKey, PlacedPiece>(1024);

        // Reused scratch buffers. The structure graph is touched every time a
        // piece is destroyed, and the zero-steady-state-allocation rule means
        // that path cannot allocate.
        private readonly Queue<PieceKey> _floodQueue = new Queue<PieceKey>(256);
        private readonly List<PieceKey> _scratchNeighbours = new List<PieceKey>(8);
        private readonly HashSet<PieceKey> _dirty = new HashSet<PieceKey>();

        /// <summary>
        /// Predicate supplied by the host: does this cell intersect terrain?
        /// Injected so the structure graph stays testable without a scene.
        /// </summary>
        public System.Func<GridCell, bool> TouchesGround { get; set; } = _ => false;

        public int Count => _pieces.Count;

        public readonly struct PieceKey : System.IEquatable<PieceKey>
        {
            public readonly GridCell Cell;
            public readonly BuildSlot Slot;

            public PieceKey(GridCell cell, BuildSlot slot)
            {
                Cell = cell;
                Slot = slot;
            }

            public bool Equals(PieceKey other) => Cell == other.Cell && Slot == other.Slot;

            public override bool Equals(object obj) => obj is PieceKey other && Equals(other);

            public override int GetHashCode() => (Cell.GetHashCode() * 397) ^ (int)Slot;

            public override string ToString() => $"{Cell}/{Slot}";
        }

        /// <summary>
        /// Canonicalises a (cell, slot) pair so the two equivalent ways of
        /// naming a shared face resolve to one key.
        /// </summary>
        public static PieceKey MakeKey(GridCell cell, BuildSlot slot)
        {
            BuildGrid.Canonicalise(ref cell, ref slot);
            return new PieceKey(cell, slot);
        }

        public bool IsOccupied(GridCell cell, BuildSlot slot) =>
            _pieces.ContainsKey(MakeKey(cell, slot));

        public bool TryGet(GridCell cell, BuildSlot slot, out PlacedPiece piece) =>
            _pieces.TryGetValue(MakeKey(cell, slot), out piece);

        /// <summary>
        /// Adds a piece. The caller must have validated placement first --
        /// this method is the mutation, not the decision.
        /// </summary>
        public bool TryAdd(PlacedPiece piece)
        {
            PieceKey key = MakeKey(piece.Cell, piece.Slot);
            if (_pieces.ContainsKey(key))
            {
                return false;
            }

            piece.Cell = key.Cell;
            piece.Slot = key.Slot;
            if (piece.EditMask == 0)
            {
                piece.EditMask = SolidMask;
            }

            piece.SupportDistance = ComputeSupportDistance(key);
            _pieces[key] = piece;

            // A new piece can shorten its neighbours' path to ground, so they
            // need re-evaluating too. Without this, a piece placed beneath an
            // unsupported stack would not rescue it.
            RefreshNeighbourhood(key);
            return true;
        }

        /// <summary>
        /// Overwrite an existing piece in place, keeping its cached support
        /// distance. Used for damage and edits, which change a piece without
        /// changing the structure's topology.
        /// </summary>
        public bool Replace(PlacedPiece piece)
        {
            PieceKey key = MakeKey(piece.Cell, piece.Slot);
            if (!_pieces.TryGetValue(key, out PlacedPiece existing))
            {
                return false;
            }

            piece.Cell = key.Cell;
            piece.Slot = key.Slot;
            // Support is a property of the topology, not of the piece's data, so
            // an edit or a damage event must not silently reset it.
            piece.SupportDistance = existing.SupportDistance;
            _pieces[key] = piece;
            return true;
        }

        /// <summary>
        /// Removes a piece and returns every piece that lost its support as a
        /// result. Callers destroy those after the collapse delay.
        /// </summary>
        public bool TryRemove(GridCell cell, BuildSlot slot, List<PieceKey> collapsed)
        {
            PieceKey key = MakeKey(cell, slot);
            if (!_pieces.Remove(key))
            {
                return false;
            }

            RecomputeSupport();

            if (collapsed != null)
            {
                foreach (KeyValuePair<PieceKey, PlacedPiece> entry in _pieces)
                {
                    if (entry.Value.SupportDistance == Unsupported)
                    {
                        collapsed.Add(entry.Key);
                    }
                }
            }

            return true;
        }

        /// <summary>
        /// Full support recomputation: a multi-source BFS outward from every
        /// ground-touching piece.
        /// </summary>
        /// <remarks>
        /// O(n) in the structure size. The per-tick budget in
        /// docs/systems/netcode.md assumes the incremental path is used for
        /// ordinary destruction; this full pass is for load, join, and tests.
        /// </remarks>
        public void RecomputeSupport()
        {
            _floodQueue.Clear();

            // Reset, seeding the queue with everything already on the ground.
            var keys = new List<PieceKey>(_pieces.Keys);
            for (int i = 0; i < keys.Count; i++)
            {
                PieceKey key = keys[i];
                PlacedPiece piece = _pieces[key];

                if (TouchesGround(key.Cell))
                {
                    piece.SupportDistance = 0;
                    _pieces[key] = piece;
                    _floodQueue.Enqueue(key);
                }
                else
                {
                    piece.SupportDistance = Unsupported;
                    _pieces[key] = piece;
                }
            }

            while (_floodQueue.Count > 0)
            {
                PieceKey current = _floodQueue.Dequeue();
                int nextDistance = _pieces[current].SupportDistance + 1;

                CollectNeighbours(current, _scratchNeighbours);
                for (int i = 0; i < _scratchNeighbours.Count; i++)
                {
                    PieceKey neighbour = _scratchNeighbours[i];
                    if (!_pieces.TryGetValue(neighbour, out PlacedPiece piece))
                    {
                        continue;
                    }

                    if (piece.SupportDistance <= nextDistance)
                    {
                        continue;
                    }

                    piece.SupportDistance = nextDistance;
                    _pieces[neighbour] = piece;
                    _floodQueue.Enqueue(neighbour);
                }
            }
        }

        /// <summary>True when a piece placed here would have something to attach to.</summary>
        public bool WouldBeSupported(GridCell cell, BuildSlot slot)
        {
            PieceKey key = MakeKey(cell, slot);
            return ComputeSupportDistance(key) != Unsupported;
        }

        private int ComputeSupportDistance(PieceKey key)
        {
            if (TouchesGround(key.Cell))
            {
                return 0;
            }

            int best = Unsupported;
            CollectNeighbours(key, _scratchNeighbours);
            for (int i = 0; i < _scratchNeighbours.Count; i++)
            {
                if (_pieces.TryGetValue(_scratchNeighbours[i], out PlacedPiece neighbour) &&
                    neighbour.SupportDistance != Unsupported &&
                    neighbour.SupportDistance + 1 < best)
                {
                    best = neighbour.SupportDistance + 1;
                }
            }

            return best;
        }

        private void RefreshNeighbourhood(PieceKey origin)
        {
            _dirty.Clear();
            _floodQueue.Clear();
            _floodQueue.Enqueue(origin);
            _dirty.Add(origin);

            while (_floodQueue.Count > 0)
            {
                PieceKey current = _floodQueue.Dequeue();
                if (!_pieces.TryGetValue(current, out PlacedPiece piece))
                {
                    continue;
                }

                int recomputed = ComputeSupportDistance(current);
                if (recomputed >= piece.SupportDistance)
                {
                    continue;
                }

                piece.SupportDistance = recomputed;
                _pieces[current] = piece;

                CollectNeighbours(current, _scratchNeighbours);
                for (int i = 0; i < _scratchNeighbours.Count; i++)
                {
                    PieceKey neighbour = _scratchNeighbours[i];
                    if (_pieces.ContainsKey(neighbour) && _dirty.Add(neighbour))
                    {
                        _floodQueue.Enqueue(neighbour);
                    }
                }
            }
        }

        /// <summary>
        /// Every (cell, slot) that could structurally connect to this one.
        /// </summary>
        /// <remarks>
        /// The relation is deliberately generous: any piece in the same cell,
        /// and the equivalent slots in the six adjacent cells. Being generous
        /// means structures collapse less eagerly than a strict geometric
        /// adjacency test would produce, which reads better than a tower
        /// falling because of a technicality.
        /// </remarks>
        private void CollectNeighbours(PieceKey key, List<PieceKey> into)
        {
            into.Clear();
            GridCell cell = key.Cell;

            // Same cell, every other slot.
            for (int slot = 0; slot <= (int)BuildSlot.Interior; slot++)
            {
                var candidate = new PieceKey(cell, (BuildSlot)slot);
                if (!candidate.Equals(key))
                {
                    into.Add(candidate);
                }
            }

            // The six orthogonally adjacent cells, all slots.
            AddCellSlots(cell.Offset(1, 0, 0), into);
            AddCellSlots(cell.Offset(-1, 0, 0), into);
            AddCellSlots(cell.Offset(0, 1, 0), into);
            AddCellSlots(cell.Offset(0, -1, 0), into);
            AddCellSlots(cell.Offset(0, 0, 1), into);
            AddCellSlots(cell.Offset(0, 0, -1), into);
        }

        private void AddCellSlots(GridCell cell, List<PieceKey> into)
        {
            for (int slot = 0; slot <= (int)BuildSlot.Interior; slot++)
            {
                var candidate = new PieceKey(cell, (BuildSlot)slot);
                if (_pieces.ContainsKey(candidate))
                {
                    into.Add(candidate);
                }
            }
        }

        public void Clear() => _pieces.Clear();

        public IEnumerable<KeyValuePair<PieceKey, PlacedPiece>> All => _pieces;
    }
}
