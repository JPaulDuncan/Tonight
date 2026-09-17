using System.Collections.Generic;
using UnityEngine;

namespace Tonight.Blueprints.World
{
    /// <summary>
    /// The map, and the constraints a valid map must satisfy.
    /// </summary>
    /// <remarks>
    /// The three constraint fields are asserted by a tooling check over the
    /// built terrain, not by eye -- see the M5 exit criteria. They exist here
    /// rather than as constants so a future map can declare different ones.
    /// </remarks>
    [CreateAssetMenu(
        fileName = "BP_Map_New",
        menuName = "Tonight/Blueprints/World/Map",
        order = 20)]
    public sealed class MapBlueprint : TonightBlueprint
    {
        [SerializeField] private List<PoiBlueprint> _pois = new List<PoiBlueprint>();

        [SerializeField, Min(100f)] private float _sizeMetres = 1400f;

        [Header("Design constraints (validated by tooling)")]
        [SerializeField, Min(1f)]
        [Tooltip("No POI may be further than this from its nearest neighbour, so " +
                 "a player who lands badly can still reach loot before the first close.")]
        private float _maxPoiSeparation = 450f;

        [SerializeField, Range(1f, 89f)]
        [Tooltip("Terrain above this slope is unbuildable, and building must " +
                 "always be viable outside designed cliffs.")]
        private float _maxBuildableSlope = 40f;

        [SerializeField, Range(0f, 1f)]
        [Tooltip("Build-fights need room.")]
        private float _minOpenTerrainFraction = 0.3f;

        [SerializeField]
        [Tooltip("0 = a fresh random bus path each match.")]
        private int _busPathSeed;

        public IReadOnlyList<PoiBlueprint> Pois => _pois;
        public float SizeMetres => _sizeMetres;
        public float MaxPoiSeparation => _maxPoiSeparation;
        public float MaxBuildableSlope => _maxBuildableSlope;
        public float MinOpenTerrainFraction => _minOpenTerrainFraction;
        public int BusPathSeed => _busPathSeed;

        public int CountOfTier(PoiTier tier)
        {
            int count = 0;
            for (int i = 0; i < _pois.Count; i++)
            {
                if (_pois[i] != null && _pois[i].Tier == tier)
                {
                    count++;
                }
            }

            return count;
        }

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);
            ctx.Require(_pois.Count > 0, "Map has no POIs.");
            ctx.Require(_sizeMetres > 0f, "SizeMetres must be positive.");

            for (int i = 0; i < _pois.Count; i++)
            {
                ctx.Require(_pois[i] != null, $"POI slot {i} is unassigned.");
            }

            ctx.Warn(CountOfTier(PoiTier.Major) >= 3,
                "Fewer than three major POIs gives the bus too few interesting drops.");
        }
    }
}
