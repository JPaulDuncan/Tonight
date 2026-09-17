using UnityEngine;

namespace Tonight.Blueprints.Combat
{
    /// <summary>
    /// Damage numbers, shared across weapons. Separated from
    /// <see cref="WeaponBlueprint"/> so several weapons can share one profile
    /// and be retuned together (composition over inheritance, ADR-0001).
    /// </summary>
    [CreateAssetMenu(
        fileName = "BP_Damage_New",
        menuName = "Tonight/Blueprints/Combat/Damage Profile",
        order = 10)]
    public sealed class DamageProfileBlueprint : TonightBlueprint
    {
        [Header("Base")]
        [SerializeField, Min(0.01f)]
        [Tooltip("Damage per bullet OR per pellet, before any multiplier.")]
        private float _baseDamage = 30f;

        [Header("Multipliers")]
        [SerializeField, Min(1f)]
        private float _headshotMultiplier = 2f;

        [SerializeField, Min(0f)]
        [Tooltip("Applied to build pieces. This is what lets an SMG shred builds " +
                 "without shredding players. See GDD 5.5.")]
        private float _structureMultiplier = 1f;

        [Header("Falloff")]
        [SerializeField, Min(0f)]
        [Tooltip("Full damage out to this distance.")]
        private float _falloffStartMetres = 40f;

        [SerializeField, Min(0f)]
        [Tooltip("At and beyond this distance, damage is scaled by FalloffEndDamageScale.")]
        private float _falloffEndMetres = 80f;

        [SerializeField, Range(0f, 1f)]
        private float _falloffEndDamageScale = 0.5f;

        [Header("Shield")]
        [SerializeField, Range(0f, 1f)]
        [Tooltip("0 = shield absorbs first (normal). 1 = damage bypasses shield entirely.")]
        private float _shieldPenetration;

        public float BaseDamage => _baseDamage;

        public float HeadshotMultiplier => _headshotMultiplier;

        public float StructureMultiplier => _structureMultiplier;

        public float FalloffStartMetres => _falloffStartMetres;

        public float FalloffEndMetres => _falloffEndMetres;

        public float FalloffEndDamageScale => _falloffEndDamageScale;

        public float ShieldPenetration => _shieldPenetration;

        /// <summary>
        /// Distance falloff scalar. Flat inside the start distance, linear
        /// through the band, flat again beyond the end.
        /// </summary>
        public float FalloffAt(float distanceMetres)
        {
            if (distanceMetres <= _falloffStartMetres)
            {
                return 1f;
            }

            if (distanceMetres >= _falloffEndMetres)
            {
                return _falloffEndDamageScale;
            }

            // Guarded by validation, but a zero-width band would divide by zero
            // in a shipped build, so clamp defensively.
            float band = _falloffEndMetres - _falloffStartMetres;
            if (band <= Mathf.Epsilon)
            {
                return _falloffEndDamageScale;
            }

            float t = (distanceMetres - _falloffStartMetres) / band;
            return Mathf.Lerp(1f, _falloffEndDamageScale, t);
        }

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);
            ctx.Require(_baseDamage > 0f, "BaseDamage must be positive.");
            ctx.Require(_headshotMultiplier >= 1f, "HeadshotMultiplier below 1 makes headshots worse than body shots.");
            ctx.Require(_falloffEndMetres >= _falloffStartMetres,
                "FalloffEndMetres must be at least FalloffStartMetres.");
            ctx.Require(_falloffEndDamageScale >= 0f && _falloffEndDamageScale <= 1f,
                "FalloffEndDamageScale must be within [0, 1].");
            ctx.Warn(_structureMultiplier <= 3f,
                "StructureMultiplier above 3 will trivialise building.");
        }
    }
}
