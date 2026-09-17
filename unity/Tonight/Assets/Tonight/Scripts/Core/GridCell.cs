using System;
using UnityEngine;

namespace Tonight.Core
{
    /// <summary>
    /// An integer coordinate in the absolute build grid (ADR-0006).
    /// </summary>
    /// <remarks>
    /// The grid is aligned to world origin and shared by every player, so two
    /// people building in the same area produce interlocking geometry rather
    /// than overlapping geometry. Cell coordinates are also the network wire
    /// format for build pieces (ADR-0002), which is why they are int16-ranged.
    /// </remarks>
    [Serializable]
    public struct GridCell : IEquatable<GridCell>
    {
        public int X;
        public int Y;
        public int Z;

        public GridCell(int x, int y, int z)
        {
            X = x;
            Y = y;
            Z = z;
        }

        public bool Equals(GridCell other) => X == other.X && Y == other.Y && Z == other.Z;

        public override bool Equals(object obj) => obj is GridCell other && Equals(other);

        /// <summary>
        /// Hash spread over three axes. The multipliers are large primes so that
        /// the spatially-clustered cells a structure produces do not collide.
        /// </summary>
        public override int GetHashCode()
        {
            unchecked
            {
                int hash = X * 73856093;
                hash ^= Y * 19349663;
                hash ^= Z * 83492791;
                return hash;
            }
        }

        public static bool operator ==(GridCell a, GridCell b) => a.Equals(b);

        public static bool operator !=(GridCell a, GridCell b) => !a.Equals(b);

        public GridCell Offset(int dx, int dy, int dz) => new GridCell(X + dx, Y + dy, Z + dz);

        public override string ToString() => $"({X},{Y},{Z})";

        /// <summary>
        /// True when the cell fits the int16 wire format. Cells outside this
        /// range cannot be replicated, so placement must reject them.
        /// </summary>
        public bool IsWireRepresentable =>
            X >= short.MinValue && X <= short.MaxValue &&
            Y >= short.MinValue && Y <= short.MaxValue &&
            Z >= short.MinValue && Z <= short.MaxValue;
    }

    /// <summary>
    /// Which part of a cell a build piece occupies. At most one piece per
    /// (cell, slot), so a single cell can hold four walls, a floor, and one
    /// interior piece: exactly a 1x1 box with a ramp inside it.
    /// </summary>
    public enum BuildSlot : byte
    {
        NorthFace = 0,
        EastFace = 1,
        SouthFace = 2,
        WestFace = 3,
        FloorFace = 4,

        /// <summary>Ramps and cones share this slot, so one replaces the other.</summary>
        Interior = 5,
    }

    public static class BuildSlotExtensions
    {
        /// <summary>Outward normal of a face slot. Interior and FloorFace return up.</summary>
        public static Vector3 Normal(this BuildSlot slot) => slot switch
        {
            BuildSlot.NorthFace => Vector3.forward,
            BuildSlot.EastFace => Vector3.right,
            BuildSlot.SouthFace => Vector3.back,
            BuildSlot.WestFace => Vector3.left,
            _ => Vector3.up,
        };

        public static bool IsVerticalFace(this BuildSlot slot) =>
            slot == BuildSlot.NorthFace || slot == BuildSlot.EastFace ||
            slot == BuildSlot.SouthFace || slot == BuildSlot.WestFace;

        /// <summary>
        /// The cardinal face whose normal most opposes <paramref name="viewDirection"/>.
        /// Used to pick which face of a cell a wall attaches to.
        /// </summary>
        public static BuildSlot FaceFacing(Vector3 viewDirection)
        {
            // Only the horizontal component matters; a player looking down at a
            // wall still gets the wall they are facing.
            float x = viewDirection.x;
            float z = viewDirection.z;

            if (Mathf.Abs(x) >= Mathf.Abs(z))
            {
                return x >= 0f ? BuildSlot.WestFace : BuildSlot.EastFace;
            }

            return z >= 0f ? BuildSlot.SouthFace : BuildSlot.NorthFace;
        }
    }
}
