using System;
using System.Collections.Generic;
using Tonight.Core;
using UnityEngine;

namespace Tonight.Blueprints.Building
{
    public enum BuildPlacementKind
    {
        Wall,
        Floor,
        Ramp,
        Cone,
    }

    public enum SlotOccupancy
    {
        /// <summary>Attaches to a cell face: walls and floors.</summary>
        Face,

        /// <summary>Occupies the cell volume: ramps and cones.</summary>
        Interior,
    }

    /// <summary>
    /// One mesh for one build material. A serialisable pair, because Unity does
    /// not serialise dictionaries.
    /// </summary>
    [Serializable]
    public struct MaterialMesh
    {
        public BuildMaterialBlueprint Material;
        public Mesh Mesh;
    }

    /// <summary>
    /// A variant produced by editing a placed piece: doorway, window, trapdoor.
    /// </summary>
    /// <remarks>
    /// The 3x3 <see cref="GridMask"/> is why new edit shapes are asset work and
    /// not programming work. A doorway is [1,1,1, 1,0,1, 1,0,1]; a window is
    /// [1,1,1, 1,0,1, 1,1,1]. Adding a shape means a new mask and a new mesh.
    /// </remarks>
    [Serializable]
    public sealed class EditVariant
    {
        [SerializeField] private string _variantName = "Variant";

        [SerializeField]
        [Tooltip("Nine entries, row-major, top-left first. False = that cell is cut away.")]
        private bool[] _gridMask = new bool[9] { true, true, true, true, true, true, true, true, true };

        [SerializeField] private List<MaterialMesh> _meshByMaterial = new List<MaterialMesh>();

        [SerializeField, Min(0.01f)]
        [Tooltip("Variants with holes in them may be weaker than the solid piece.")]
        private float _healthScale = 1f;

        public string VariantName => _variantName;

        public IReadOnlyList<bool> GridMask => _gridMask;

        public float HealthScale => _healthScale;

        public Mesh MeshFor(BuildMaterialBlueprint material)
        {
            for (int i = 0; i < _meshByMaterial.Count; i++)
            {
                if (_meshByMaterial[i].Material == material)
                {
                    return _meshByMaterial[i].Mesh;
                }
            }

            return null;
        }

        /// <summary>
        /// Packs the mask into the low 9 bits of an int, so a placed piece's
        /// current edit state is one small value to compare and replicate.
        /// </summary>
        public int MaskKey => PackMask(_gridMask);

        public static int PackMask(IReadOnlyList<bool> mask)
        {
            if (mask == null)
            {
                return 0;
            }

            int key = 0;
            int count = Mathf.Min(9, mask.Count);
            for (int i = 0; i < count; i++)
            {
                if (mask[i])
                {
                    key |= 1 << i;
                }
            }

            return key;
        }

        public bool IsValidMask => _gridMask != null && _gridMask.Length == 9;
    }

    /// <summary>
    /// A placeable build piece. Adding a fifth piece type -- a half-wall, say --
    /// is creating one of these assets plus a mesh. Zero C# changes; that is an
    /// M2 exit criterion.
    /// </summary>
    [CreateAssetMenu(
        fileName = "BP_Piece_New",
        menuName = "Tonight/Blueprints/Building/Build Piece",
        order = 0)]
    public sealed class BuildPieceBlueprint : TonightBlueprint
    {
        [Header("Placement")]
        [SerializeField]
        private BuildPlacementKind _placement = BuildPlacementKind.Wall;

        [SerializeField]
        private SlotOccupancy _occupancy = SlotOccupancy.Face;

        [Header("Meshes")]
        [SerializeField]
        [Tooltip("One entry per build material in the project. Validation checks coverage.")]
        private List<MaterialMesh> _meshByMaterial = new List<MaterialMesh>();

        [SerializeField]
        [Tooltip("Ghost material shown during placement.")]
        private Material _previewMaterial;

        [Header("Economy")]
        [SerializeField]
        [Tooltip("-1 uses the material's CostPerPiece. Set a value to override.")]
        private int _costOverride = -1;

        [Header("Editing")]
        [SerializeField]
        private List<EditVariant> _editVariants = new List<EditVariant>();

        [Header("Physics")]
        [SerializeField]
        private LayerMask _collisionLayer;

        [SerializeField]
        [Tooltip("Optional. Falls back to the material's build sound.")]
        private AudioClip _buildSound;

        public BuildPlacementKind Placement => _placement;

        public SlotOccupancy Occupancy => _occupancy;

        public Material PreviewMaterial => _previewMaterial;

        public IReadOnlyList<EditVariant> EditVariants => _editVariants;

        public LayerMask CollisionLayer => _collisionLayer;

        public AudioClip BuildSound => _buildSound;

        public Mesh MeshFor(BuildMaterialBlueprint material)
        {
            for (int i = 0; i < _meshByMaterial.Count; i++)
            {
                if (_meshByMaterial[i].Material == material)
                {
                    return _meshByMaterial[i].Mesh;
                }
            }

            return null;
        }

        public int CostFor(BuildMaterialBlueprint material)
        {
            if (_costOverride >= 0)
            {
                return _costOverride;
            }

            return material != null ? material.CostPerPiece : 0;
        }

        /// <summary>
        /// The slot this piece would occupy in a cell, given a view direction.
        /// Walls pick the face most opposed to the view; floors take the floor
        /// face; ramps and cones share the interior slot.
        /// </summary>
        public BuildSlot SlotFor(Vector3 viewDirection) => _placement switch
        {
            BuildPlacementKind.Wall => BuildSlotExtensions.FaceFacing(viewDirection),
            BuildPlacementKind.Floor => BuildSlot.FloorFace,
            _ => BuildSlot.Interior,
        };

        /// <summary>
        /// Finds the edit variant matching a mask, or null when the mask is not
        /// an authored shape (in which case the edit reverts).
        /// </summary>
        public EditVariant VariantForMask(int maskKey)
        {
            for (int i = 0; i < _editVariants.Count; i++)
            {
                if (_editVariants[i] != null && _editVariants[i].MaskKey == maskKey)
                {
                    return _editVariants[i];
                }
            }

            return null;
        }

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);

            ctx.Require(_previewMaterial != null,
                "BuildPiece needs a PreviewMaterial for the placement ghost.");
            ctx.Require(_meshByMaterial.Count > 0, "BuildPiece has no meshes.");

            bool needsInterior = _placement == BuildPlacementKind.Ramp ||
                                 _placement == BuildPlacementKind.Cone;
            ctx.Require(!needsInterior || _occupancy == SlotOccupancy.Interior,
                "Ramps and cones must use Interior occupancy.");
            ctx.Require(needsInterior || _occupancy == SlotOccupancy.Face,
                "Walls and floors must use Face occupancy.");

            for (int i = 0; i < _meshByMaterial.Count; i++)
            {
                ctx.Require(_meshByMaterial[i].Material != null,
                    $"Mesh entry {i} has no material assigned.");
                ctx.Require(_meshByMaterial[i].Mesh != null,
                    $"Mesh entry {i} has no mesh assigned.");
            }

            var seenMasks = new HashSet<int>();
            for (int i = 0; i < _editVariants.Count; i++)
            {
                EditVariant variant = _editVariants[i];
                if (variant == null)
                {
                    ctx.Require(false, $"Edit variant {i} is null.");
                    continue;
                }

                ctx.Require(variant.IsValidMask,
                    $"Edit variant '{variant.VariantName}' needs a 9-entry grid mask.");
                ctx.Require(seenMasks.Add(variant.MaskKey),
                    $"Edit variant '{variant.VariantName}' duplicates another variant's mask; " +
                    "only the first would ever be reachable.");
            }

            // Full per-material coverage is a cross-asset check: a single piece
            // cannot enumerate every BuildMaterialBlueprint in the project.
            // tools/validate_blueprints.py does that.
        }
    }
}
