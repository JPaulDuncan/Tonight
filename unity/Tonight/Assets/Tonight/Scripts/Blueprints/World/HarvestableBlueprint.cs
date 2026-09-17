using Tonight.Blueprints.Building;
using UnityEngine;

namespace Tonight.Blueprints.World
{
    /// <summary>
    /// A harvestable world prop: tree, rock, vehicle.
    /// </summary>
    /// <remarks>
    /// The weak-point bonus is what makes harvesting an activity rather than a
    /// hold-to-fill bar. The marker position is seeded from (objectId, hitCount)
    /// so client and server agree without any extra replication.
    /// </remarks>
    [CreateAssetMenu(
        fileName = "BP_Harvest_New",
        menuName = "Tonight/Blueprints/World/Harvestable",
        order = 0)]
    public sealed class HarvestableBlueprint : TonightBlueprint
    {
        [SerializeField] private BuildMaterialBlueprint _material;

        [Header("Health and yield")]
        [SerializeField, Min(1f)] private float _totalHealth = 100f;
        [SerializeField, Min(0)] private int _yieldPerHit = 10;
        [SerializeField, Min(0)] private int _bonusYieldOnWeakPoint = 10;
        [SerializeField, Min(0)] private int _yieldOnDestroy = 20;

        [Header("Presentation")]
        [SerializeField] private GameObject _prefab;
        [SerializeField] private GameObject _destroyedVfx;

        [SerializeField]
        [Tooltip("-1 = never respawns, which is the match-long default. " +
                 "Positive values exist for the practice range.")]
        private float _respawnSeconds = -1f;

        public BuildMaterialBlueprint Material => _material;
        public float TotalHealth => _totalHealth;
        public int YieldPerHit => _yieldPerHit;
        public int BonusYieldOnWeakPoint => _bonusYieldOnWeakPoint;
        public int YieldOnDestroy => _yieldOnDestroy;
        public GameObject Prefab => _prefab;
        public GameObject DestroyedVfx => _destroyedVfx;
        public float RespawnSeconds => _respawnSeconds;

        public bool Respawns => _respawnSeconds >= 0f;

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);
            ctx.Require(_material != null, "Harvestable needs a build material to yield.");
            ctx.Require(_prefab != null, "Harvestable needs a prefab.");
            ctx.Require(_totalHealth > 0f, "TotalHealth must be positive.");
            ctx.Require(_yieldPerHit > 0 || _yieldOnDestroy > 0,
                "A harvestable that yields nothing per hit and nothing on destroy is just scenery.");
        }
    }
}
