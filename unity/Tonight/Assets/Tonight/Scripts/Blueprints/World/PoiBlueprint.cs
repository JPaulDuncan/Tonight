using Tonight.Blueprints.Loot;
using Tonight.Core;
using UnityEngine;

namespace Tonight.Blueprints.World
{
    public enum PoiTier
    {
        Major,
        Minor,
        Landmark,
    }

    /// <summary>A point of interest: a town, a farm, a landmark.</summary>
    [CreateAssetMenu(
        fileName = "BP_Poi_New",
        menuName = "Tonight/Blueprints/World/POI",
        order = 10)]
    public sealed class PoiBlueprint : TonightBlueprint
    {
        [SerializeField] private PoiTier _tier = PoiTier.Minor;

        [Header("Loot")]
        [SerializeField, Min(0)] private int _chestSpawnPoints = 4;

        [SerializeField, Range(0f, 1f)]
        [Tooltip("Rolled per spawn point, once per match.")]
        private float _chestSpawnChance = 0.7f;

        [SerializeField] private IntRange _floorLootCount = new IntRange(3, 6);
        [SerializeField] private LootTableBlueprint _chestTable;
        [SerializeField] private LootTableBlueprint _floorTable;

        [Header("Scene")]
        [SerializeField]
        [Tooltip("Additively loaded sub-scene holding this POI's geometry.")]
        private string _sceneName;

        public PoiTier Tier => _tier;
        public int ChestSpawnPoints => _chestSpawnPoints;
        public float ChestSpawnChance => _chestSpawnChance;
        public IntRange FloorLootCount => _floorLootCount;
        public LootTableBlueprint ChestTable => _chestTable;
        public LootTableBlueprint FloorTable => _floorTable;
        public string SceneName => _sceneName;

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);
            ctx.Require(_floorLootCount.IsValid, "FloorLootCount max must be at least min.");
            ctx.Require(!string.IsNullOrEmpty(_sceneName), "POI needs a scene name.");
            ctx.Require(_chestSpawnPoints == 0 || _chestTable != null,
                "POI has chest spawn points but no chest table.");
            ctx.Require(_floorLootCount.Max == 0 || _floorTable != null,
                "POI spawns floor loot but has no floor table.");
        }
    }
}
