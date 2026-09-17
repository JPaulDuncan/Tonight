using Tonight.Blueprints.Building;
using Tonight.Core;
using Tonight.Gameplay.Building;

namespace Tonight.Gameplay.Commands
{
    /// <summary>Why a command was rejected. Drives both rollback and telemetry.</summary>
    public enum PlacementRejection
    {
        None = 0,
        Unaffordable,
        SlotOccupied,
        Unsupported,
        OutOfRange,
        IntersectsPlayer,
        RateLimited,
        OutOfWireRange,
        MalformedCommand,
    }

    /// <summary>
    /// State the placement validator needs. An interface so the same validation
    /// runs against the server's authoritative world and the client's predicted
    /// one without either knowing about the other.
    /// </summary>
    public interface IPlacementWorld
    {
        BuildStructure Structure { get; }

        int GetMaterialCount(int playerId, BuildMaterialBlueprint material);

        float DistanceFromPlayer(int playerId, GridCell cell);

        bool WouldIntersectLivingPlayer(GridCell cell, BuildSlot slot, int placingPlayerId);

        /// <summary>Placements this player has made in the last second. Server-side only.</summary>
        int RecentPlacementCount(int playerId);
    }

    /// <summary>
    /// A request to place a build piece.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The command is the wire format and the local action, both. Per ADR-0003
    /// rule 4, <see cref="Validate"/> is pure and side-effect free, and the
    /// client's prediction and the server's authority call the identical
    /// method. Most networking retrofits fail because validation gets written
    /// twice and the two copies drift; this is the structural guard against
    /// that.
    /// </para>
    /// </remarks>
    public readonly struct PlaceBuildCommand
    {
        /// <summary>Server-side placement budget. Far above any human input rate.</summary>
        public const int MaxPlacementsPerSecond = 12;

        public readonly int PlayerId;
        public readonly int ClientTick;
        public readonly GridCell Cell;
        public readonly BuildSlot Slot;
        public readonly BuildPieceBlueprint Piece;
        public readonly BuildMaterialBlueprint Material;

        public PlaceBuildCommand(
            int playerId,
            int clientTick,
            GridCell cell,
            BuildSlot slot,
            BuildPieceBlueprint piece,
            BuildMaterialBlueprint material)
        {
            PlayerId = playerId;
            ClientTick = clientTick;
            Cell = cell;
            Slot = slot;
            Piece = piece;
            Material = material;
        }

        public int Cost => Piece != null ? Piece.CostFor(Material) : 0;

        /// <summary>
        /// Pure validation. Runs identically on client and server.
        /// </summary>
        /// <param name="world">The world to validate against.</param>
        /// <param name="enforceRateLimit">
        /// True on the server only. The rate limit is a sanity check against
        /// automation, not a gameplay throttle, and applying it client-side
        /// would make a legitimate fast builder mispredict.
        /// </param>
        public PlacementRejection Validate(IPlacementWorld world, bool enforceRateLimit)
        {
            if (Piece == null || Material == null || world == null)
            {
                return PlacementRejection.MalformedCommand;
            }

            if (!Cell.IsWireRepresentable)
            {
                return PlacementRejection.OutOfWireRange;
            }

            if (world.GetMaterialCount(PlayerId, Material) < Cost)
            {
                return PlacementRejection.Unaffordable;
            }

            if (world.Structure.IsOccupied(Cell, Slot))
            {
                return PlacementRejection.SlotOccupied;
            }

            if (world.DistanceFromPlayer(PlayerId, Cell) > BuildGrid.MaxPlaceDistance)
            {
                return PlacementRejection.OutOfRange;
            }

            if (!world.Structure.WouldBeSupported(Cell, Slot))
            {
                return PlacementRejection.Unsupported;
            }

            // The placing player is excluded: building a floor under yourself is
            // legal and common. Other players are not, so nobody can be trapped
            // inside geometry.
            if (world.WouldIntersectLivingPlayer(Cell, Slot, PlayerId))
            {
                return PlacementRejection.IntersectsPlayer;
            }

            if (enforceRateLimit &&
                world.RecentPlacementCount(PlayerId) >= MaxPlacementsPerSecond)
            {
                return PlacementRejection.RateLimited;
            }

            return PlacementRejection.None;
        }

        /// <summary>
        /// Builds the piece record this command produces. Applying it is the
        /// caller's job, so that validation stays free of side effects.
        /// </summary>
        public PlacedPiece ToPlacedPiece(int tick) => new PlacedPiece
        {
            Cell = Cell,
            Slot = Slot,
            Piece = Piece,
            Material = Material,
            OwnerId = PlayerId,
            PlacedTick = tick,
            Health = Material != null ? Material.BuildHealth : 0f,
            EditMask = BuildStructure.SolidMask,
        };
    }
}
