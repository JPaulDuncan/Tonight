using Tonight.Blueprints.Character;
using Tonight.Blueprints.Combat;
using UnityEngine;

namespace Tonight.Gameplay.Combat
{
    /// <summary>What a shot hit.</summary>
    public enum HitTargetKind
    {
        Player,
        Structure,
        Harvestable,
    }

    /// <summary>Everything the damage formula needs about one hit.</summary>
    public readonly struct HitContext
    {
        public readonly DamageProfileBlueprint Profile;
        public readonly RarityBlueprint Rarity;
        public readonly HitboxDefinition Hitbox;
        public readonly HitTargetKind TargetKind;
        public readonly float DistanceMetres;

        public HitContext(
            DamageProfileBlueprint profile,
            RarityBlueprint rarity,
            HitboxDefinition hitbox,
            HitTargetKind targetKind,
            float distanceMetres)
        {
            Profile = profile;
            Rarity = rarity;
            Hitbox = hitbox;
            TargetKind = targetKind;
            DistanceMetres = distanceMetres;
        }
    }

    /// <summary>How a damage amount splits across shield and health.</summary>
    public readonly struct DamageResult
    {
        public readonly float ToShield;
        public readonly float ToHealth;

        public DamageResult(float toShield, float toHealth)
        {
            ToShield = toShield;
            ToHealth = toHealth;
        }

        public float Total => ToShield + ToHealth;
    }

    /// <summary>
    /// The one damage formula. There are no weapon-specific branches anywhere
    /// in this class, and adding one would be a contract violation -- a weapon
    /// that behaves differently does so because a Blueprint field says so.
    /// </summary>
    public static class DamageCalculator
    {
        /// <summary>
        /// Raw damage for a hit, before shield splitting.
        /// </summary>
        public static float Compute(in HitContext hit)
        {
            if (hit.Profile == null)
            {
                return 0f;
            }

            float damage = hit.Profile.BaseDamage;

            if (hit.Rarity != null)
            {
                damage *= hit.Rarity.DamageMultiplier;
            }

            // Hitbox scaling applies to players only. A bullet striking a wall
            // does not have a "head" to hit.
            if (hit.TargetKind == HitTargetKind.Player)
            {
                if (hit.Hitbox != null)
                {
                    damage *= hit.Hitbox.IsHead
                        ? hit.Profile.HeadshotMultiplier
                        : hit.Hitbox.DamageScale;
                }
            }
            else if (hit.TargetKind == HitTargetKind.Structure)
            {
                damage *= hit.Profile.StructureMultiplier;
            }

            damage *= hit.Profile.FalloffAt(hit.DistanceMetres);

            return Mathf.Max(0f, damage);
        }

        /// <summary>
        /// Splits damage across shield and health.
        /// </summary>
        /// <remarks>
        /// Shield absorbs first unless the profile has shield penetration, in
        /// which case that fraction goes straight to health. Neither output can
        /// exceed the pool it targets, so a caller subtracting these values can
        /// never drive a pool negative.
        /// </remarks>
        public static DamageResult Split(
            float damage,
            float currentShield,
            float currentHealth,
            float shieldPenetration)
        {
            if (damage <= 0f)
            {
                return new DamageResult(0f, 0f);
            }

            float penetration = Mathf.Clamp01(shieldPenetration);
            float direct = damage * penetration;
            float absorbable = damage - direct;

            float toShield = Mathf.Min(absorbable, Mathf.Max(0f, currentShield));

            // Damage the shield could not absorb carries through to health.
            float overflow = absorbable - toShield;
            float toHealth = Mathf.Min(direct + overflow, Mathf.Max(0f, currentHealth));

            return new DamageResult(toShield, toHealth);
        }

        /// <summary>
        /// Convenience: computes and splits in one call.
        /// </summary>
        public static DamageResult Apply(
            in HitContext hit,
            float currentShield,
            float currentHealth)
        {
            float damage = Compute(in hit);
            float penetration = hit.Profile != null ? hit.Profile.ShieldPenetration : 0f;
            return Split(damage, currentShield, currentHealth, penetration);
        }
    }
}
