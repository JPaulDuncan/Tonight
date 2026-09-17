using System;
using System.Collections.Generic;
using System.Reflection;
using Tonight.Blueprints;
using UnityEngine;

namespace Tonight.Tests.EditMode
{
    /// <summary>
    /// Builds Blueprint instances for tests.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Blueprint fields are private and serialised, exposed through read-only
    /// properties, because a Blueprint is shared read-only data and a public
    /// setter would invite exactly the runtime mutation the authoring contract
    /// forbids. Tests still need to construct specific values, so they go
    /// through reflection here rather than the schema being weakened for their
    /// benefit.
    /// </para>
    /// <para>
    /// The trade is that a renamed field breaks these helpers at run time
    /// rather than compile time, which is why <see cref="SetPrivateFields"/>
    /// throws loudly on an unknown field name instead of silently doing
    /// nothing.
    /// </para>
    /// </remarks>
    public static class TestBlueprints
    {
        private const BindingFlags Flags =
            BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;

        public static void SetPrivateFields(object target, Dictionary<string, object> values)
        {
            if (target == null)
            {
                throw new ArgumentNullException(nameof(target));
            }

            foreach (KeyValuePair<string, object> pair in values)
            {
                FieldInfo field = FindField(target.GetType(), pair.Key);
                if (field == null)
                {
                    throw new ArgumentException(
                        $"{target.GetType().Name} has no field '{pair.Key}'. " +
                        "The field was probably renamed; update the test helper.");
                }

                field.SetValue(target, pair.Value);
            }
        }

        private static FieldInfo FindField(Type type, string name)
        {
            // Walk the hierarchy: fields declared on TonightBlueprint are not
            // returned by GetField on a derived type with NonPublic.
            for (Type current = type; current != null; current = current.BaseType)
            {
                FieldInfo field = current.GetField(name, Flags);
                if (field != null)
                {
                    return field;
                }
            }

            return null;
        }

        /// <summary>
        /// Creates a Blueprint with an id already assigned, so base validation
        /// does not fail on every test asset.
        /// </summary>
        public static T Create<T>(Dictionary<string, object> values = null)
            where T : TonightBlueprint
        {
            var instance = ScriptableObject.CreateInstance<T>();
            instance.name = typeof(T).Name + "_Test";

            MethodInfo ensureId = typeof(TonightBlueprint)
                .GetMethod("EnsureId", BindingFlags.Instance | BindingFlags.NonPublic);
            ensureId?.Invoke(instance, null);

            if (values != null)
            {
                SetPrivateFields(instance, values);
            }

            return instance;
        }

        /// <summary>Runs validation and returns the collected context.</summary>
        public static BlueprintValidationContext Validate(TonightBlueprint blueprint)
        {
            var ctx = new BlueprintValidationContext(blueprint.name);
            blueprint.Validate(ctx);
            return ctx;
        }
    }
}
