using System.Collections.Generic;

namespace Tonight.Blueprints
{
    public enum ValidationSeverity
    {
        Warning,
        Error,
    }

    public readonly struct ValidationMessage
    {
        public readonly ValidationSeverity Severity;
        public readonly string Message;
        public readonly string AssetName;

        public ValidationMessage(ValidationSeverity severity, string message, string assetName)
        {
            Severity = severity;
            Message = message;
            AssetName = assetName;
        }

        public override string ToString() =>
            $"[{Severity}] {AssetName}: {Message}";
    }

    /// <summary>
    /// Collects validation results for one Blueprint.
    /// </summary>
    /// <remarks>
    /// Data-driven content fails at runtime rather than compile time, so
    /// validation has to be deliberate. Every Blueprint implements
    /// <see cref="IValidatableBlueprint"/>; the same code runs from OnValidate
    /// in the Editor and from the CI validator, so a designer sees the error in
    /// the Inspector and a broken asset never reaches main.
    /// </remarks>
    public sealed class BlueprintValidationContext
    {
        private readonly List<ValidationMessage> _messages = new List<ValidationMessage>();

        public BlueprintValidationContext(string assetName)
        {
            AssetName = assetName;
        }

        public string AssetName { get; }

        public IReadOnlyList<ValidationMessage> Messages => _messages;

        public bool HasErrors
        {
            get
            {
                for (int i = 0; i < _messages.Count; i++)
                {
                    if (_messages[i].Severity == ValidationSeverity.Error)
                    {
                        return true;
                    }
                }

                return false;
            }
        }

        /// <summary>Records an error when <paramref name="condition"/> is false. Fails CI.</summary>
        public void Require(bool condition, string message)
        {
            if (!condition)
            {
                _messages.Add(new ValidationMessage(ValidationSeverity.Error, message, AssetName));
            }
        }

        /// <summary>Records a warning when <paramref name="condition"/> is false. Does not fail CI.</summary>
        public void Warn(bool condition, string message)
        {
            if (!condition)
            {
                _messages.Add(new ValidationMessage(ValidationSeverity.Warning, message, AssetName));
            }
        }
    }

    public interface IValidatableBlueprint
    {
        void Validate(BlueprintValidationContext ctx);
    }
}
