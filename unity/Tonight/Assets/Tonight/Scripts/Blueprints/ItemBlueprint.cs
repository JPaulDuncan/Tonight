using UnityEngine;

namespace Tonight.Blueprints
{
    /// <summary>
    /// Anything that can occupy an inventory slot. One level of inheritance is
    /// permitted for genuine kind-of relationships (ADR-0001); weapons and
    /// consumables are both items.
    /// </summary>
    public abstract class ItemBlueprint : TonightBlueprint
    {
        [Header("Item")]
        [SerializeField]
        private Sprite _icon;

        [SerializeField]
        [Tooltip("World pickup prefab. PF_ prefixed.")]
        private GameObject _pickupPrefab;

        [SerializeField, Min(1)]
        [Tooltip("1 means the item occupies a slot on its own.")]
        private int _maxStack = 1;

        public Sprite Icon => _icon;

        public GameObject PickupPrefab => _pickupPrefab;

        public int MaxStack => _maxStack;

        public bool IsStackable => _maxStack > 1;

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);
            ctx.Require(_maxStack >= 1, "MaxStack must be at least 1.");
            ctx.Warn(_icon != null, "Item has no icon; it will be invisible in the inventory bar.");
        }
    }
}
