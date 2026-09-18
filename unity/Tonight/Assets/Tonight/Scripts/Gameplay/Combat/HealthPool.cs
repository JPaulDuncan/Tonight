using UnityEngine;

namespace Tonight.Gameplay.Combat
{
    /// <summary>
    /// A character's health and shield.
    /// </summary>
    /// <remarks>
    /// Neither pool regenerates (GDD 5.1). Healing is consumable-only, which is
    /// what makes disengaging after a fight a real decision rather than a wait.
    /// </remarks>
    public struct HealthPool
    {
        public float Health;
        public float Shield;
        public float MaxHealth;
        public float MaxShield;

        public bool IsAlive => Health > 0f;

        public float Total => Health + Shield;

        public static HealthPool Full(float maxHealth, float maxShield) => new HealthPool
        {
            Health = maxHealth,
            // Shield starts empty: it is looted, not granted.
            Shield = 0f,
            MaxHealth = maxHealth,
            MaxShield = maxShield,
        };

        /// <summary>
        /// Apply a split damage result. Returns true when this killed the character.
        /// </summary>
        public bool Apply(in DamageResult damage)
        {
            Shield = Mathf.Max(0f, Shield - damage.ToShield);
            Health = Mathf.Max(0f, Health - damage.ToHealth);
            return !IsAlive;
        }

        /// <summary>
        /// Restore health, capped both by <paramref name="cap"/> and by the
        /// maximum. The per-item cap is what makes a bandage and a medkit
        /// different decisions rather than different durations.
        /// </summary>
        public float Heal(float amount, float cap)
        {
            if (amount <= 0f)
            {
                return 0f;
            }

            float ceiling = Mathf.Min(cap, MaxHealth);
            if (Health >= ceiling)
            {
                return 0f;
            }

            float before = Health;
            Health = Mathf.Min(ceiling, Health + amount);
            return Health - before;
        }

        public float AddShield(float amount)
        {
            if (amount <= 0f || Shield >= MaxShield)
            {
                return 0f;
            }

            float before = Shield;
            Shield = Mathf.Min(MaxShield, Shield + amount);
            return Shield - before;
        }

        /// <summary>Storm damage: ignores shield by design (systems/storm.md 1).</summary>
        public bool ApplyDirectHealthDamage(float amount)
        {
            if (amount <= 0f)
            {
                return false;
            }

            Health = Mathf.Max(0f, Health - amount);
            return !IsAlive;
        }
    }
}
