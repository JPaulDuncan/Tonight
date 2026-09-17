using System;
using System.Collections.Generic;
using UnityEngine;

namespace Tonight.Blueprints
{
    /// <summary>
    /// Base class for every Blueprint asset.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A Blueprint is shared, load-once, read-only data. <b>Never write to a
    /// Blueprint field at runtime.</b> In the Editor that change persists to
    /// disk and silently rewrites the game's balance; in a build it leaks state
    /// between matches. Per-instance mutable state belongs in a runtime struct
    /// that references its Blueprint.
    /// </para>
    /// <para>
    /// See docs/blueprints/README.md for the full authoring contract.
    /// </para>
    /// </remarks>
    public abstract class TonightBlueprint : ScriptableObject, IValidatableBlueprint
    {
        [Header("Identity")]
        [SerializeField]
        [Tooltip("Stable identity. Generated once on creation and NEVER edited. " +
                 "All references, saves, replays, and wire messages use this, so " +
                 "changing it breaks every reference silently.")]
        private string _blueprintId;

        [SerializeField]
        [Tooltip("Player-facing name.")]
        private string _displayName;

        [SerializeField]
        [TextArea(2, 5)]
        [Tooltip("Designer notes. May surface in tooltips.")]
        private string _description;

        [SerializeField]
        [Tooltip("Free-form tags, used by loot table filters and tooling queries.")]
        private string[] _tags = Array.Empty<string>();

        public string BlueprintId => _blueprintId;

        public string DisplayName => string.IsNullOrEmpty(_displayName) ? name : _displayName;

        public string Description => _description;

        public IReadOnlyList<string> Tags => _tags;

        public bool HasTag(string tag)
        {
            if (_tags == null)
            {
                return false;
            }

            for (int i = 0; i < _tags.Length; i++)
            {
                if (string.Equals(_tags[i], tag, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Assigns an id if the asset does not have one. Called on creation and
        /// from OnValidate, so an asset authored before this field existed
        /// heals itself rather than failing validation forever.
        /// </summary>
        internal void EnsureId()
        {
            if (string.IsNullOrEmpty(_blueprintId))
            {
                _blueprintId = Guid.NewGuid().ToString("N");
            }
        }

        public virtual void Validate(BlueprintValidationContext ctx)
        {
            ctx.Require(!string.IsNullOrEmpty(_blueprintId),
                "BlueprintId is empty. Re-save the asset to generate one.");
        }

#if UNITY_EDITOR
        protected virtual void OnValidate()
        {
            EnsureId();

            var ctx = new BlueprintValidationContext(name);
            Validate(ctx);

            for (int i = 0; i < ctx.Messages.Count; i++)
            {
                ValidationMessage message = ctx.Messages[i];
                if (message.Severity == ValidationSeverity.Error)
                {
                    Debug.LogError(message.ToString(), this);
                }
                else
                {
                    Debug.LogWarning(message.ToString(), this);
                }
            }
        }
#endif
    }
}
