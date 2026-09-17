using System.Collections.Generic;
using UnityEngine;

namespace Tonight.Blueprints
{
    /// <summary>
    /// Runtime lookup of Blueprints by their stable <see cref="TonightBlueprint.BlueprintId"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Lookup is by id, never by asset name or path. Renaming
    /// <c>BP_Weapon_AR</c> to <c>BP_Weapon_AssaultRifle</c> must not break a
    /// save, a replay, or a wire message, and a path-based lookup would break
    /// all three silently.
    /// </para>
    /// <para>
    /// The asset is built at import time by the Editor tool in
    /// Tonight.Editor, which scans Assets/Tonight/Blueprints/. It is not
    /// hand-edited.
    /// </para>
    /// </remarks>
    [CreateAssetMenu(
        fileName = "BlueprintRegistry",
        menuName = "Tonight/Blueprint Registry",
        order = 100)]
    public sealed class BlueprintRegistry : ScriptableObject
    {
        [SerializeField]
        [Tooltip("Generated. Rebuild via Tonight > Blueprints > Rebuild Registry.")]
        private List<TonightBlueprint> _all = new List<TonightBlueprint>();

        private Dictionary<string, TonightBlueprint> _byId;

        public IReadOnlyList<TonightBlueprint> All => _all;

        public int Count => _all.Count;

        private void OnEnable() => _byId = null;

        private Dictionary<string, TonightBlueprint> Index
        {
            get
            {
                if (_byId != null)
                {
                    return _byId;
                }

                _byId = new Dictionary<string, TonightBlueprint>(_all.Count);
                for (int i = 0; i < _all.Count; i++)
                {
                    TonightBlueprint blueprint = _all[i];
                    if (blueprint == null || string.IsNullOrEmpty(blueprint.BlueprintId))
                    {
                        continue;
                    }

                    // A duplicate id means two assets claim one identity, which
                    // makes every reference to it ambiguous. Validation reports
                    // this; at runtime the first wins deterministically rather
                    // than depending on scan order.
                    if (!_byId.ContainsKey(blueprint.BlueprintId))
                    {
                        _byId.Add(blueprint.BlueprintId, blueprint);
                    }
                    else
                    {
                        Debug.LogError(
                            $"Duplicate BlueprintId '{blueprint.BlueprintId}' on " +
                            $"'{blueprint.name}'. Ids must be unique.", blueprint);
                    }
                }

                return _byId;
            }
        }

        public bool TryGet(string blueprintId, out TonightBlueprint blueprint)
        {
            if (string.IsNullOrEmpty(blueprintId))
            {
                blueprint = null;
                return false;
            }

            return Index.TryGetValue(blueprintId, out blueprint);
        }

        public T Get<T>(string blueprintId) where T : TonightBlueprint =>
            TryGet(blueprintId, out TonightBlueprint blueprint) ? blueprint as T : null;

        /// <summary>Collects every Blueprint of a type into the supplied list.</summary>
        public void CollectAll<T>(List<T> into) where T : TonightBlueprint
        {
            if (into == null)
            {
                return;
            }

            into.Clear();
            for (int i = 0; i < _all.Count; i++)
            {
                if (_all[i] is T typed)
                {
                    into.Add(typed);
                }
            }
        }

#if UNITY_EDITOR
        /// <summary>Editor-only: replaces the contents. Called by the rebuild tool.</summary>
        internal void SetContents(List<TonightBlueprint> blueprints)
        {
            _all = blueprints;
            _byId = null;
        }
#endif
    }
}
