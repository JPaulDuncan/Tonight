using Tonight.Blueprints.Building;
using Tonight.Core;
using UnityEngine;

namespace Tonight.Gameplay.Building
{
    /// <summary>Where a piece would go, and whether anywhere was found.</summary>
    public readonly struct PlacementTarget
    {
        public readonly GridCell Cell;
        public readonly BuildSlot Slot;
        public readonly bool Found;

        public PlacementTarget(GridCell cell, BuildSlot slot, bool found)
        {
            Cell = cell;
            Slot = slot;
            Found = found;
        }

        public static readonly PlacementTarget None = new PlacementTarget(default, default, false);
    }

    /// <summary>
    /// Turns where a player is looking into a (cell, slot) to build at.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Pure, so the placement rules can be tested exhaustively without a
    /// camera, a scene, or Play mode. Pillar 1 requires that a player can
    /// predict exactly where a piece will land without looking at the preview,
    /// and "predictable" is a property worth having tests for.
    /// </para>
    /// <para>
    /// Resolution works from the camera rather than from the crosshair hitting
    /// geometry: raycasting to find a surface fails in open air, and building
    /// in open air is normal.
    /// </para>
    /// </remarks>
    public static class BuildPlacementResolver
    {
        /// <summary>
        /// How many cells to step along the view direction looking for a free
        /// slot. Two is what makes building against an existing wall feel right
        /// rather than silently failing; more would place pieces surprisingly
        /// far from where the player aimed.
        /// </summary>
        public const int MaxOccupancySteps = 2;

        /// <summary>
        /// Resolve a placement target.
        /// </summary>
        /// <param name="cameraOrigin">Eye position.</param>
        /// <param name="viewDirection">Normalised look direction.</param>
        /// <param name="surfaceDistance">
        /// Distance to the first solid surface, or a negative value when the ray
        /// hits nothing. Building in open air is normal, so "no hit" is not a
        /// failure.
        /// </param>
        /// <param name="piece">What is being placed.</param>
        /// <param name="structure">The current world, for occupancy checks.</param>
        /// <param name="playerFeetY">Used to pick the cell height for floors.</param>
        public static PlacementTarget Resolve(
            Vector3 cameraOrigin,
            Vector3 viewDirection,
            float surfaceDistance,
            BuildPieceBlueprint piece,
            BuildStructure structure,
            float playerFeetY)
        {
            if (piece == null || structure == null)
            {
                return PlacementTarget.None;
            }

            Vector3 direction = viewDirection.sqrMagnitude > 1e-6f
                ? viewDirection.normalized
                : Vector3.forward;

            float distance = surfaceDistance >= 0f
                ? Mathf.Min(surfaceDistance, BuildGrid.MaxPlaceDistance)
                : BuildGrid.MaxPlaceDistance;

            Vector3 aimPoint = cameraOrigin + direction * distance;

            // Floors are placed at the player's own height, not at whatever
            // height they happen to be looking at -- building a floor under
            // yourself is the common case and must not depend on pitch.
            if (piece.Placement == BuildPlacementKind.Floor)
            {
                aimPoint.y = playerFeetY;
            }

            GridCell cell = BuildGrid.WorldToCell(aimPoint);
            BuildSlot slot = piece.SlotFor(direction);

            // Walk along the view direction if the chosen slot is taken.
            for (int step = 0; step <= MaxOccupancySteps; step++)
            {
                if (!structure.IsOccupied(cell, slot))
                {
                    return new PlacementTarget(cell, slot, true);
                }

                cell = StepCell(cell, direction, piece.Placement);
            }

            return PlacementTarget.None;
        }

        /// <summary>
        /// Advance one cell along the dominant axis of the view direction.
        /// </summary>
        /// <remarks>
        /// Stepping along the dominant axis rather than the raw vector keeps the
        /// walk on the grid: a diagonal view would otherwise skip cells.
        /// Vertical pieces step horizontally and floors step vertically, because
        /// the alternative in each case is a piece appearing somewhere the
        /// player was not looking.
        /// </remarks>
        public static GridCell StepCell(
            GridCell cell, Vector3 direction, BuildPlacementKind placement)
        {
            if (placement == BuildPlacementKind.Floor)
            {
                return cell.Offset(0, direction.y >= 0f ? 1 : -1, 0);
            }

            return Mathf.Abs(direction.x) >= Mathf.Abs(direction.z)
                ? cell.Offset(direction.x >= 0f ? 1 : -1, 0, 0)
                : cell.Offset(0, 0, direction.z >= 0f ? 1 : -1);
        }

        /// <summary>
        /// World transform for a resolved target, for the preview ghost and the
        /// placed piece alike.
        /// </summary>
        /// <remarks>
        /// Both must use this. A preview computed differently from the placed
        /// result is the specific failure pillar 1 forbids: the ghost would
        /// disagree with where the piece lands.
        /// </remarks>
        public static void GetTransform(
            in PlacementTarget target, out Vector3 position, out Quaternion rotation)
        {
            position = BuildGrid.SlotAnchor(target.Cell, target.Slot);
            rotation = BuildGrid.SlotRotation(target.Slot);
        }
    }
}
