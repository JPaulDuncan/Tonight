using System;
using System.Collections.Generic;
using UnityEngine;

namespace Tonight.Blueprints.Character
{
    /// <summary>
    /// One hitbox on a character, with its damage scale.
    /// </summary>
    [Serializable]
    public sealed class HitboxDefinition
    {
        [SerializeField] private string _name = "Body";

        [SerializeField]
        [Tooltip("Exactly one hitbox per character must be the head.")]
        private bool _isHead;

        [SerializeField, Min(0f)]
        [Tooltip("Ignored for the head, which uses the weapon's HeadshotMultiplier.")]
        private float _damageScale = 1f;

        [SerializeField]
        [Tooltip("Bone path within the character prefab, e.g. 'Root/Spine/Head'.")]
        private string _bonePath;

        public string Name => _name;

        public bool IsHead => _isHead;

        public float DamageScale => _damageScale;

        public string BonePath => _bonePath;
    }

    [CreateAssetMenu(
        fileName = "BP_Character_New",
        menuName = "Tonight/Blueprints/Character/Character",
        order = 10)]
    public sealed class CharacterBlueprint : TonightBlueprint
    {
        [SerializeField] private MovementBlueprint _movement;

        [Header("Pools")]
        [SerializeField, Min(1f)] private float _maxHealth = 100f;
        [SerializeField, Min(0f)] private float _maxShield = 100f;

        [Header("Presentation")]
        [SerializeField] private GameObject _prefab;

        [SerializeField]
        [Tooltip("Cosmetic variant swap. Exists as a pipeline test only -- there " +
                 "is no cosmetics economy (see docs/00-vision.md).")]
        private Material _cosmeticMaterial;

        [SerializeField, Min(0.1f)] private float _cameraHeight = 1.65f;

        [Header("Hitboxes")]
        [SerializeField] private List<HitboxDefinition> _hitboxes = new List<HitboxDefinition>();

        public MovementBlueprint Movement => _movement;
        public float MaxHealth => _maxHealth;
        public float MaxShield => _maxShield;
        public GameObject Prefab => _prefab;
        public Material CosmeticMaterial => _cosmeticMaterial;
        public float CameraHeight => _cameraHeight;
        public IReadOnlyList<HitboxDefinition> Hitboxes => _hitboxes;

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);

            ctx.Require(_movement != null, "Character needs a MovementBlueprint.");
            ctx.Require(_prefab != null, "Character needs a prefab.");
            ctx.Require(_maxHealth > 0f, "MaxHealth must be positive.");

            int headCount = 0;
            for (int i = 0; i < _hitboxes.Count; i++)
            {
                if (_hitboxes[i] != null && _hitboxes[i].IsHead)
                {
                    headCount++;
                }
            }

            ctx.Require(headCount == 1,
                $"Character must have exactly one head hitbox; found {headCount}.");

            if (_movement != null)
            {
                ctx.Require(_cameraHeight < _movement.StandHeight,
                    "CameraHeight must be below the standing capsule height.");
            }
        }
    }
}
