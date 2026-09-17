using UnityEngine;

namespace Tonight.Blueprints.Building
{
    public enum BuildMaterialKind
    {
        Wood,
        Stone,
        Metal,
    }

    /// <summary>
    /// A build material: wood, stone, or metal.
    /// </summary>
    /// <remarks>
    /// The build-HP ramp defined here is the single most important balance
    /// lever in the game. A piece spawns at <see cref="BuildHealth"/> and
    /// reaches <see cref="FullHealth"/> over <see cref="BuildTimeSeconds"/>,
    /// which is what makes a freshly placed wall killable and rewards the
    /// player who shoots first. See docs/systems/building.md section 4.
    /// </remarks>
    [CreateAssetMenu(
        fileName = "BP_BuildMat_New",
        menuName = "Tonight/Blueprints/Building/Build Material",
        order = 10)]
    public sealed class BuildMaterialBlueprint : TonightBlueprint
    {
        [SerializeField]
        [Tooltip("Must be unique across all build material assets.")]
        private BuildMaterialKind _materialKind = BuildMaterialKind.Wood;

        [Header("Health ramp")]
        [SerializeField, Min(1f)]
        [Tooltip("HP at the instant of placement.")]
        private float _buildHealth = 90f;

        [SerializeField, Min(1f)]
        [Tooltip("HP once the ramp completes.")]
        private float _fullHealth = 150f;

        [SerializeField, Min(0.01f)]
        private float _buildTimeSeconds = 3f;

        [Header("Economy")]
        [SerializeField, Min(1)]
        private int _costPerPiece = 10;

        [SerializeField, Min(1)]
        private int _maxCarried = 500;

        [Header("Presentation")]
        [SerializeField]
        private Material _surfaceMaterial;

        [SerializeField]
        private Color _uiColour = Color.white;

        [SerializeField] private AudioClip _harvestSound;
        [SerializeField] private AudioClip _buildSound;
        [SerializeField] private AudioClip _destroySound;

        public BuildMaterialKind MaterialKind => _materialKind;

        public float BuildHealth => _buildHealth;

        public float FullHealth => _fullHealth;

        public float BuildTimeSeconds => _buildTimeSeconds;

        public int CostPerPiece => _costPerPiece;

        public int MaxCarried => _maxCarried;

        public Material SurfaceMaterial => _surfaceMaterial;

        public Color UiColour => _uiColour;

        public AudioClip HarvestSound => _harvestSound;

        public AudioClip BuildSound => _buildSound;

        public AudioClip DestroySound => _destroySound;

        /// <summary>
        /// Health of a piece <paramref name="ageSeconds"/> after placement.
        /// </summary>
        public float HealthAtAge(float ageSeconds)
        {
            if (ageSeconds <= 0f)
            {
                return _buildHealth;
            }

            if (ageSeconds >= _buildTimeSeconds)
            {
                return _fullHealth;
            }

            return Mathf.Lerp(_buildHealth, _fullHealth, ageSeconds / _buildTimeSeconds);
        }

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);
            ctx.Require(_fullHealth >= _buildHealth,
                "FullHealth must be at least BuildHealth, or the piece weakens as it matures.");
            ctx.Require(_buildTimeSeconds > 0f, "BuildTimeSeconds must be positive.");
            ctx.Require(_costPerPiece > 0, "CostPerPiece must be positive.");
            ctx.Require(_maxCarried >= _costPerPiece,
                "MaxCarried below CostPerPiece makes the material unusable.");
            ctx.Warn(_surfaceMaterial != null, "No surface material; pieces will render untextured.");
        }
    }
}
