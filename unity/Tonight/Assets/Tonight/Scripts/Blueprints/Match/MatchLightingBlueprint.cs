using System;
using System.Collections.Generic;
using UnityEngine;

namespace Tonight.Blueprints.Match
{
    [Serializable]
    public sealed class LightingKeyframe
    {
        [SerializeField, Min(0)] private int _phaseIndex;
        [SerializeField] private Color _sunColour = Color.white;
        [SerializeField, Min(0f)] private float _sunIntensity = 1f;
        [SerializeField] private Color _fogColour = Color.grey;
        [SerializeField, Min(0f)] private float _fogDensity = 0.01f;

        public int PhaseIndex => _phaseIndex;
        public Color SunColour => _sunColour;
        public float SunIntensity => _sunIntensity;
        public Color FogColour => _fogColour;
        public float FogDensity => _fogDensity;
    }

    /// <summary>
    /// The night clock: storm phase drives time of day.
    /// </summary>
    /// <remarks>
    /// Ambient light level never affects gameplay. There is no
    /// stealth-in-darkness mechanic, and <see cref="MinPlayerRimIntensity"/>
    /// puts a floor under character visibility at every phase. The reason is
    /// practical rather than aesthetic: display gamma varies enormously between
    /// players, so any mechanic keyed to perceived darkness silently advantages
    /// whoever owns the better monitor.
    /// </remarks>
    [CreateAssetMenu(
        fileName = "BP_Lighting_New",
        menuName = "Tonight/Blueprints/Match/Match Lighting",
        order = 20)]
    public sealed class MatchLightingBlueprint : TonightBlueprint
    {
        [SerializeField]
        [Tooltip("One keyframe per storm phase.")]
        private List<LightingKeyframe> _keyframesByPhase = new List<LightingKeyframe>();

        [SerializeField]
        [Tooltip("Sampled by overall match progress, 0..1.")]
        private Gradient _skyGradient = new Gradient();

        [SerializeField]
        [Tooltip("Sun elevation in degrees vs normalised match time. Dusk +8 -> " +
                 "deep night -22 -> sunrise +12.")]
        private AnimationCurve _sunElevationCurve = AnimationCurve.Linear(0f, 8f, 1f, 12f);

        [SerializeField, Range(0.05f, 2f)]
        [Tooltip("Floor under character rim lighting. A zero here is what would " +
                 "turn deep night into an accidental stealth mechanic.")]
        private float _minPlayerRimIntensity = 0.4f;

        public IReadOnlyList<LightingKeyframe> KeyframesByPhase => _keyframesByPhase;
        public Gradient SkyGradient => _skyGradient;
        public AnimationCurve SunElevationCurve => _sunElevationCurve;
        public float MinPlayerRimIntensity => _minPlayerRimIntensity;

        public LightingKeyframe KeyframeFor(int phaseIndex)
        {
            for (int i = 0; i < _keyframesByPhase.Count; i++)
            {
                if (_keyframesByPhase[i] != null && _keyframesByPhase[i].PhaseIndex == phaseIndex)
                {
                    return _keyframesByPhase[i];
                }
            }

            return null;
        }

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);
            ctx.Require(_keyframesByPhase.Count > 0, "Match lighting has no keyframes.");
            ctx.Require(_minPlayerRimIntensity > 0f,
                "MinPlayerRimIntensity must be above zero, or players become " +
                "invisible in deep night and the storm phases become a stealth mechanic.");
            ctx.Require(_sunElevationCurve != null && _sunElevationCurve.length >= 2,
                "SunElevationCurve needs at least two keys.");
        }
    }
}
