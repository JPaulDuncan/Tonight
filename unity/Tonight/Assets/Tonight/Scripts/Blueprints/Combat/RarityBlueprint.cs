using UnityEngine;

namespace Tonight.Blueprints.Combat
{
    /// <summary>
    /// A rarity tier. Rarity is a runtime modifier applied over a single weapon
    /// Blueprint, not a separate asset per variant -- five classes across five
    /// rarities is five Blueprints, not twenty-five.
    /// </summary>
    [CreateAssetMenu(
        fileName = "BP_Rarity_New",
        menuName = "Tonight/Blueprints/Combat/Rarity",
        order = 30)]
    public sealed class RarityBlueprint : TonightBlueprint
    {
        [SerializeField, Min(0)]
        [Tooltip("0 = Common ... 4 = Legendary. Must be unique across all rarity assets.")]
        private int _tier;

        [SerializeField]
        private Color _colour = Color.grey;

        [SerializeField, Min(0.01f)]
        [Tooltip("Rarity multiplies damage ONLY. It deliberately does not change " +
                 "fire rate, magazine, or handling, so a Common AR stays viable.")]
        private float _damageMultiplier = 1f;

        [SerializeField, Min(0f)]
        [Tooltip("Relative weight in floor loot before any table bias.")]
        private float _lootWeight = 50f;

        public int Tier => _tier;

        public Color Colour => _colour;

        public float DamageMultiplier => _damageMultiplier;

        public float LootWeight => _lootWeight;

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);
            ctx.Require(_damageMultiplier > 0f, "DamageMultiplier must be positive.");
            ctx.Require(_lootWeight >= 0f, "LootWeight cannot be negative.");
            ctx.Require(_tier >= 0, "Tier cannot be negative.");
            // Tier uniqueness is a cross-asset check and lives in
            // tools/validate_blueprints.py -- a single asset cannot see its peers.
        }
    }
}
