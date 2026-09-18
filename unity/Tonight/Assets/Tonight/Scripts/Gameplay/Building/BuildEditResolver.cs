using System.Collections.Generic;
using Tonight.Blueprints.Building;
using Tonight.Core;
using UnityEngine;

namespace Tonight.Gameplay.Building
{
    /// <summary>
    /// Edit mode: turning a 3x3 drag into a piece variant.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Editing a piece under fire is core skill expression (GDD 4.5), so this
    /// is deliberately cheap and deliberately never rate-limited.
    /// </para>
    /// <para>
    /// Adding a new edit shape is a new mask plus a new mesh -- no C# change.
    /// That is one of the M2 exit criteria, and the reason the mask is data
    /// rather than an enum of known shapes.
    /// </para>
    /// </remarks>
    public static class BuildEditResolver
    {
        /// <summary>The unedited, fully solid mask.</summary>
        public const int SolidMask = BuildStructure.SolidMask;

        /// <summary>
        /// Which of the 3x3 sub-cells a point on a piece's face falls in.
        /// </summary>
        /// <param name="local">
        /// Position on the face, normalised to [0,1] with (0,0) at the
        /// bottom-left as seen by the editing player.
        /// </param>
        /// <returns>Index 0..8, row-major with index 0 at the TOP-left.</returns>
        public static int SubCellIndex(Vector2 local)
        {
            int column = Mathf.Clamp(Mathf.FloorToInt(local.x * 3f), 0, 2);
            int rowFromBottom = Mathf.Clamp(Mathf.FloorToInt(local.y * 3f), 0, 2);

            // Mask index 0 is top-left, matching how a designer reads the grid
            // in the Inspector. Getting this inverted produces upside-down
            // doorways that look almost right, which is worse than obviously
            // wrong.
            int rowFromTop = 2 - rowFromBottom;
            return rowFromTop * 3 + column;
        }

        /// <summary>Toggle one sub-cell in a packed mask.</summary>
        public static int Toggle(int mask, int index)
        {
            if (index < 0 || index > 8)
            {
                return mask;
            }

            return mask ^ (1 << index);
        }

        public static bool IsSet(int mask, int index) =>
            index >= 0 && index <= 8 && (mask & (1 << index)) != 0;

        /// <summary>
        /// Resolve a dragged mask to a variant.
        /// </summary>
        /// <returns>
        /// The matching variant, or null when the mask is the solid default or
        /// is not an authored shape. A null result means the edit reverts,
        /// which is the correct outcome for an unrecognised scribble.
        /// </returns>
        public static EditVariant Resolve(BuildPieceBlueprint piece, int mask)
        {
            if (piece == null || mask == SolidMask)
            {
                return null;
            }

            return piece.VariantForMask(mask);
        }

        /// <summary>
        /// Apply an edit, keeping the piece's accumulated damage.
        /// </summary>
        /// <remarks>
        /// Damage carries across an edit rather than resetting. Otherwise
        /// editing a wall would be a free repair, and a player under fire would
        /// edit-spam instead of fighting.
        /// </remarks>
        public static bool TryApplyEdit(
            BuildWorld world,
            GridCell cell,
            BuildSlot slot,
            int mask,
            int editingPlayerId)
        {
            if (world == null)
            {
                return false;
            }

            if (!world.Structure.TryGet(cell, slot, out PlacedPiece piece))
            {
                return false;
            }

            // Only the owner may edit. A captured structure stays enemy-owned
            // and must be destroyed, not repurposed.
            if (piece.OwnerId != editingPlayerId)
            {
                return false;
            }

            if (mask == piece.EditMask)
            {
                return false;
            }

            if (mask != SolidMask && Resolve(piece.Piece, mask) == null)
            {
                return false;
            }

            piece.EditMask = mask;
            return world.Structure.Replace(piece);
        }

        /// <summary>
        /// Effective health scale for a piece's current edit state.
        /// </summary>
        public static float HealthScaleFor(BuildPieceBlueprint piece, int mask)
        {
            if (piece == null || mask == SolidMask)
            {
                return 1f;
            }

            EditVariant variant = piece.VariantForMask(mask);
            return variant?.HealthScale ?? 1f;
        }

        /// <summary>Every authored mask on a piece, for the edit UI.</summary>
        public static void CollectMasks(BuildPieceBlueprint piece, List<int> into)
        {
            into.Clear();
            if (piece == null)
            {
                return;
            }

            into.Add(SolidMask);
            IReadOnlyList<EditVariant> variants = piece.EditVariants;
            for (int i = 0; i < variants.Count; i++)
            {
                if (variants[i] != null)
                {
                    into.Add(variants[i].MaskKey);
                }
            }
        }
    }
}
