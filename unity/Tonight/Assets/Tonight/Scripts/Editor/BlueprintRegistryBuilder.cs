using System.Collections.Generic;
using System.Text;
using Tonight.Blueprints;
using UnityEditor;
using UnityEngine;

namespace Tonight.Editor
{
    /// <summary>
    /// Scans the Blueprints folder and rebuilds the runtime registry, then runs
    /// every asset's validation.
    /// </summary>
    /// <remarks>
    /// This is the in-Editor half of the validation story. The other half is
    /// tools/validate_blueprints.py in CI, which catches cross-asset problems a
    /// single asset cannot see: duplicate rarity tiers, storm phase radius
    /// discontinuities, loot table reference cycles.
    /// </remarks>
    public static class BlueprintRegistryBuilder
    {
        private const string RegistryPath =
            "Assets/Tonight/Blueprints/BlueprintRegistry.asset";

        private const string SearchFolder = "Assets/Tonight/Blueprints";

        [MenuItem("Tonight/Blueprints/Rebuild Registry %#b")]
        public static void Rebuild()
        {
            var blueprints = LoadAll();

            BlueprintRegistry registry = AssetDatabase.LoadAssetAtPath<BlueprintRegistry>(RegistryPath);
            if (registry == null)
            {
                registry = ScriptableObject.CreateInstance<BlueprintRegistry>();
                AssetDatabase.CreateAsset(registry, RegistryPath);
            }

            registry.SetContents(blueprints);
            EditorUtility.SetDirty(registry);
            AssetDatabase.SaveAssets();

            Debug.Log($"[Tonight] Blueprint registry rebuilt with {blueprints.Count} assets.");
        }

        [MenuItem("Tonight/Blueprints/Validate All %#v")]
        public static void ValidateAll()
        {
            var blueprints = LoadAll();
            int errors = 0;
            int warnings = 0;

            var duplicateIds = new Dictionary<string, TonightBlueprint>();

            for (int i = 0; i < blueprints.Count; i++)
            {
                TonightBlueprint blueprint = blueprints[i];
                var ctx = new BlueprintValidationContext(blueprint.name);
                blueprint.Validate(ctx);

                for (int m = 0; m < ctx.Messages.Count; m++)
                {
                    ValidationMessage message = ctx.Messages[m];
                    if (message.Severity == ValidationSeverity.Error)
                    {
                        errors++;
                        Debug.LogError(message.ToString(), blueprint);
                    }
                    else
                    {
                        warnings++;
                        Debug.LogWarning(message.ToString(), blueprint);
                    }
                }

                // Cross-asset check the assets themselves cannot perform.
                if (!string.IsNullOrEmpty(blueprint.BlueprintId))
                {
                    if (duplicateIds.TryGetValue(blueprint.BlueprintId, out TonightBlueprint existing))
                    {
                        errors++;
                        Debug.LogError(
                            $"[Error] {blueprint.name}: BlueprintId collides with " +
                            $"'{existing.name}'. Ids must be unique.", blueprint);
                    }
                    else
                    {
                        duplicateIds.Add(blueprint.BlueprintId, blueprint);
                    }
                }
            }

            var summary = new StringBuilder();
            summary.Append("[Tonight] Validated ").Append(blueprints.Count).Append(" Blueprints: ");
            summary.Append(errors).Append(" error(s), ").Append(warnings).Append(" warning(s).");

            if (errors > 0)
            {
                Debug.LogError(summary.ToString());
            }
            else
            {
                Debug.Log(summary.ToString());
            }
        }

        private static List<TonightBlueprint> LoadAll()
        {
            var results = new List<TonightBlueprint>();
            string[] guids = AssetDatabase.FindAssets(
                "t:" + nameof(TonightBlueprint),
                new[] { SearchFolder });

            for (int i = 0; i < guids.Length; i++)
            {
                string path = AssetDatabase.GUIDToAssetPath(guids[i]);
                var blueprint = AssetDatabase.LoadAssetAtPath<TonightBlueprint>(path);
                if (blueprint != null)
                {
                    results.Add(blueprint);
                }
            }

            // Sorted so the generated registry asset has a stable diff rather
            // than reshuffling on every rebuild.
            results.Sort((a, b) => string.CompareOrdinal(a.name, b.name));
            return results;
        }
    }
}
