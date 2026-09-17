using UnityEngine;

namespace Tonight.Blueprints.Loot
{
    /// <summary>
    /// A healing or shielding consumable.
    /// </summary>
    /// <remarks>
    /// <see cref="HealthCap"/> below max is what makes the bandage-versus-medkit
    /// decision interesting: a bandage heals quickly but only to 75, a medkit
    /// heals to full but takes far longer.
    /// </remarks>
    [CreateAssetMenu(
        fileName = "BP_Consumable_New",
        menuName = "Tonight/Blueprints/Loot/Consumable",
        order = 10)]
    public sealed class ConsumableBlueprint : ItemBlueprint
    {
        [Header("Restores")]
        [SerializeField, Min(0f)] private float _healthRestored;
        [SerializeField, Min(0f)] private float _shieldRestored;

        [SerializeField, Min(0f)]
        [Tooltip("Health cannot be raised above this by this item. Bandages cap below max.")]
        private float _healthCap = 100f;

        [Header("Use")]
        [SerializeField, Min(0.01f)] private float _useSeconds = 3f;

        [SerializeField]
        [Tooltip("Consumed on COMPLETION, not on start -- an interrupted heal " +
                 "wastes time but not the item.")]
        private bool _consumedOnUse = true;

        [SerializeField] private bool _cancelOnDamage = true;

        public float HealthRestored => _healthRestored;

        public float ShieldRestored => _shieldRestored;

        public float HealthCap => _healthCap;

        public float UseSeconds => _useSeconds;

        public bool ConsumedOnUse => _consumedOnUse;

        public bool CancelOnDamage => _cancelOnDamage;

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);
            ctx.Require(_useSeconds > 0f, "UseSeconds must be positive.");
            ctx.Require(_healthRestored > 0f || _shieldRestored > 0f,
                "A consumable that restores nothing has no effect.");
            ctx.Warn(_healthRestored <= 0f || _healthCap > 0f,
                "HealthCap of zero means this item can never heal anyone.");
        }
    }
}
