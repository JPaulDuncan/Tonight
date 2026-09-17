using UnityEngine;

namespace Tonight.Blueprints.Combat
{
    public enum WeaponClass
    {
        AssaultRifle,
        Shotgun,
        Smg,
        Sniper,
        Pistol,
        Melee,
    }

    public enum FireMode
    {
        Auto,
        Semi,
        Burst,
        BoltAction,
    }

    public enum AmmoType
    {
        None,
        Light,
        Medium,
        Heavy,
        Shell,
    }

    /// <summary>
    /// A weapon. Note what is absent: there is no rarity field, and no field
    /// that names a specific weapon. A shotgun is a weapon with
    /// <see cref="PelletCount"/> above 1 -- there is no shotgun code path
    /// anywhere in the project.
    /// </summary>
    [CreateAssetMenu(
        fileName = "BP_Weapon_New",
        menuName = "Tonight/Blueprints/Combat/Weapon",
        order = 0)]
    public sealed class WeaponBlueprint : ItemBlueprint
    {
        [Header("Identity")]
        [SerializeField]
        private WeaponClass _class = WeaponClass.AssaultRifle;

        [SerializeField]
        [Tooltip("Held-weapon prefab, PF_ prefixed.")]
        private GameObject _prefab;

        [Header("Composition")]
        [SerializeField]
        private DamageProfileBlueprint _damageProfile;

        [SerializeField]
        [Tooltip("Optional. Leave empty to inherit the class default.")]
        private RecoilProfileBlueprint _recoil;

        [Header("Firing")]
        [SerializeField]
        private FireMode _fireMode = FireMode.Auto;

        [SerializeField, Min(2)]
        [Tooltip("Only read when FireMode is Burst.")]
        private int _burstCount = 3;

        [SerializeField, Min(1f)]
        private float _fireRateRpm = 600f;

        [SerializeField, Min(1)]
        private int _magazineSize = 30;

        [SerializeField, Min(0.01f)]
        private float _reloadSeconds = 2.2f;

        [SerializeField, Min(0f)]
        private float _equipSeconds = 0.5f;

        [Header("Spread")]
        [SerializeField, Min(1)]
        [Tooltip("Above 1 makes this a shotgun. No special-casing in code.")]
        private int _pelletCount = 1;

        [SerializeField, Min(0f)]
        [Tooltip("Cone half-angle, degrees.")]
        private float _spreadDegrees;

        [SerializeField, Min(0f)]
        private float _bloomPerShot = 0.15f;

        [SerializeField, Min(0f)]
        private float _bloomMaxDegrees = 3f;

        [SerializeField, Min(0.01f)]
        private float _bloomRecoveryPerSecond = 4f;

        [SerializeField]
        [Tooltip("When bloom is at rest, the shot goes dead centre.")]
        private bool _firstShotAccurate = true;

        [Header("Projectile")]
        [SerializeField]
        [Tooltip("False means hitscan. Snipers use projectile so drop is real.")]
        private bool _isProjectile;

        [SerializeField, Min(1f)]
        private float _projectileSpeed = 250f;

        [SerializeField, Min(0f)]
        private float _projectileGravityScale = 0.4f;

        [Header("Ammo and ADS")]
        [SerializeField]
        private AmmoType _ammoType = AmmoType.Medium;

        [SerializeField, Range(0.1f, 1f)]
        private float _adsFovMultiplier = 0.8f;

        [SerializeField, Min(0f)]
        private float _adsTimeSeconds = 0.25f;

        public WeaponClass Class => _class;

        public GameObject Prefab => _prefab;

        public DamageProfileBlueprint DamageProfile => _damageProfile;

        public RecoilProfileBlueprint Recoil => _recoil;

        public FireMode FireMode => _fireMode;

        public int BurstCount => _burstCount;

        public float FireRateRpm => _fireRateRpm;

        public int MagazineSize => _magazineSize;

        public float ReloadSeconds => _reloadSeconds;

        public float EquipSeconds => _equipSeconds;

        public int PelletCount => _pelletCount;

        public float SpreadDegrees => _spreadDegrees;

        public float BloomPerShot => _bloomPerShot;

        public float BloomMaxDegrees => _bloomMaxDegrees;

        public float BloomRecoveryPerSecond => _bloomRecoveryPerSecond;

        public bool FirstShotAccurate => _firstShotAccurate;

        public bool IsProjectile => _isProjectile;

        public float ProjectileSpeed => _projectileSpeed;

        public float ProjectileGravityScale => _projectileGravityScale;

        public AmmoType AmmoType => _ammoType;

        public float AdsFovMultiplier => _adsFovMultiplier;

        public float AdsTimeSeconds => _adsTimeSeconds;

        /// <summary>Seconds between shots, derived from the authored RPM.</summary>
        public float ShotInterval => 60f / Mathf.Max(1f, _fireRateRpm);

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);

            ctx.Require(_fireRateRpm > 0f, "FireRateRpm must be positive.");
            ctx.Require(_magazineSize > 0, "MagazineSize must be positive.");
            ctx.Require(_prefab != null, "Weapon needs a prefab.");
            ctx.Require(_damageProfile != null, "Weapon needs a DamageProfile.");
            ctx.Require(_pelletCount >= 1, "PelletCount must be at least 1.");
            ctx.Require(_reloadSeconds > 0f, "ReloadSeconds must be positive.");

            if (_fireMode == FireMode.Burst)
            {
                ctx.Require(_burstCount >= 2, "Burst weapons need a BurstCount of at least 2.");
            }

            if (_isProjectile)
            {
                ctx.Require(_projectileSpeed > 0f, "Projectile weapons need a positive ProjectileSpeed.");
            }

            if (_class != WeaponClass.Melee)
            {
                ctx.Warn(_ammoType != AmmoType.None,
                    "A non-melee weapon with AmmoType None can never be reloaded.");
            }

            ctx.Require(_bloomMaxDegrees >= 0f, "BloomMaxDegrees cannot be negative.");
            ctx.Warn(_spreadDegrees <= 10f,
                "SpreadDegrees above 10 is outside the design band; verify this is intentional.");
            ctx.Warn(_pelletCount == 1 || _spreadDegrees > 0f,
                "A multi-pellet weapon with zero spread fires every pellet along one line.");
        }
    }
}
