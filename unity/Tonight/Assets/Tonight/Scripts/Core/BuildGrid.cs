using UnityEngine;

namespace Tonight.Core
{
    /// <summary>
    /// Conversion between world space and the absolute build grid (ADR-0006).
    /// </summary>
    /// <remarks>
    /// Every quantisation in the project goes through here. Duplicating the
    /// rounding rule elsewhere is how client and server end up disagreeing
    /// about which cell a player pointed at.
    /// </remarks>
    public static class BuildGrid
    {
        /// <summary>Cell size in metres. A wall is one cell face; a ramp rises exactly one cell.</summary>
        public const float CellSize = 4f;

        /// <summary>Maximum distance from the player at which a piece may be placed.</summary>
        public const float MaxPlaceDistance = 10f;

        /// <summary>
        /// World position of a cell's minimum corner.
        /// </summary>
        public static Vector3 CellToWorld(GridCell cell) => new Vector3(
            cell.X * CellSize,
            cell.Y * CellSize,
            cell.Z * CellSize);

        /// <summary>World position of a cell's centre.</summary>
        public static Vector3 CellCentre(GridCell cell) =>
            CellToWorld(cell) + new Vector3(CellSize, CellSize, CellSize) * 0.5f;

        /// <summary>
        /// The cell containing a world position.
        /// </summary>
        /// <remarks>
        /// Uses <see cref="Mathf.FloorToInt"/> rather than truncation so that
        /// negative coordinates quantise consistently. Truncation would make
        /// the cell straddling the origin twice as wide as every other cell,
        /// which is the kind of bug that only shows up on one corner of the map.
        /// </remarks>
        public static GridCell WorldToCell(Vector3 world) => new GridCell(
            Mathf.FloorToInt(world.x / CellSize),
            Mathf.FloorToInt(world.y / CellSize),
            Mathf.FloorToInt(world.z / CellSize));

        /// <summary>
        /// World position of the anchor point of a (cell, slot) pair: the centre
        /// of a face for face slots, the cell centre for interior slots.
        /// </summary>
        public static Vector3 SlotAnchor(GridCell cell, BuildSlot slot)
        {
            Vector3 centre = CellCentre(cell);
            float half = CellSize * 0.5f;

            return slot switch
            {
                BuildSlot.NorthFace => centre + new Vector3(0f, 0f, half),
                BuildSlot.EastFace => centre + new Vector3(half, 0f, 0f),
                BuildSlot.SouthFace => centre + new Vector3(0f, 0f, -half),
                BuildSlot.WestFace => centre + new Vector3(-half, 0f, 0f),
                BuildSlot.FloorFace => centre + new Vector3(0f, -half, 0f),
                _ => centre,
            };
        }

        /// <summary>
        /// Rotation a piece should take in a given slot, so that a single mesh
        /// authored facing +Z serves all four wall faces.
        /// </summary>
        public static Quaternion SlotRotation(BuildSlot slot) => slot switch
        {
            BuildSlot.NorthFace => Quaternion.Euler(0f, 0f, 0f),
            BuildSlot.EastFace => Quaternion.Euler(0f, 90f, 0f),
            BuildSlot.SouthFace => Quaternion.Euler(0f, 180f, 0f),
            BuildSlot.WestFace => Quaternion.Euler(0f, 270f, 0f),
            _ => Quaternion.identity,
        };

        /// <summary>
        /// The cell on the far side of a face slot. Two cells share a face, so a
        /// wall on the north face of cell C is the same physical wall as one on
        /// the south face of C's north neighbour. Placement canonicalises to the
        /// lower-coordinate cell via <see cref="Canonicalise"/>.
        /// </summary>
        public static GridCell NeighbourAcross(GridCell cell, BuildSlot slot) => slot switch
        {
            BuildSlot.NorthFace => cell.Offset(0, 0, 1),
            BuildSlot.EastFace => cell.Offset(1, 0, 0),
            BuildSlot.SouthFace => cell.Offset(0, 0, -1),
            BuildSlot.WestFace => cell.Offset(-1, 0, 0),
            BuildSlot.FloorFace => cell.Offset(0, -1, 0),
            _ => cell,
        };

        /// <summary>
        /// Maps a (cell, slot) to its canonical representation, so that the two
        /// equivalent ways of naming a shared face resolve to one key.
        /// </summary>
        /// <remarks>
        /// Without this, two players placing a wall on opposite sides of the
        /// same boundary would each succeed and produce two coincident walls.
        /// The canonical form keeps North, East, and Floor; South, West, and any
        /// other inbound naming is rewritten onto the neighbouring cell.
        /// </remarks>
        public static void Canonicalise(ref GridCell cell, ref BuildSlot slot)
        {
            switch (slot)
            {
                case BuildSlot.SouthFace:
                    cell = cell.Offset(0, 0, -1);
                    slot = BuildSlot.NorthFace;
                    break;
                case BuildSlot.WestFace:
                    cell = cell.Offset(-1, 0, 0);
                    slot = BuildSlot.EastFace;
                    break;
            }
        }
    }
}
