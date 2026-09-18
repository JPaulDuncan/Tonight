using System.Collections.Generic;
using Tonight.Blueprints.Match;
using Tonight.Core;
using UnityEngine;

namespace Tonight.Gameplay.Storm
{
    /// <summary>
    /// Runs the storm across a match: phase progression, circle placement, and
    /// the damage that makes it a clock.
    /// </summary>
    /// <remarks>
    /// Server-authoritative. The client receives the resulting
    /// <see cref="StormState"/>, which is a handful of floats and is therefore
    /// exempt from interest management -- everyone always needs it.
    /// </remarks>
    public sealed class StormDirector
    {
        private readonly IReadOnlyList<StormPhaseBlueprint> _phases;
        private readonly float _sprintSpeed;

        private DeterministicRng _rng;
        private int _phaseIndex;
        private float _phaseElapsed;
        private Vector2 _centre;
        private Vector2 _nextCentre;
        private bool _finished;

        public StormDirector(
            IReadOnlyList<StormPhaseBlueprint> phases,
            int matchSeed,
            float sprintSpeed,
            Vector2 mapCentre = default)
        {
            _phases = phases;
            _sprintSpeed = sprintSpeed;
            _rng = new DeterministicRng(matchSeed);
            _centre = mapCentre;
            _nextCentre = mapCentre;
            _phaseIndex = 0;
            _phaseElapsed = 0f;

            ChooseNextCentre(System.Array.Empty<Vector2>());
        }

        public int PhaseIndex => _phaseIndex;

        public bool Finished => _finished;

        /// <summary>Raised when the rotation clamp could not satisfy every
        /// player. That is a map-design problem, so it is reported rather than
        /// silently accepted.</summary>
        public event System.Action<int> RotationClampImpossible;

        public StormPhaseBlueprint CurrentPhase =>
            _phases != null && _phaseIndex < _phases.Count ? _phases[_phaseIndex] : null;

        public StormState Current
        {
            get
            {
                StormPhaseBlueprint phase = CurrentPhase;
                if (phase == null)
                {
                    return new StormState(_phaseIndex, _centre, 0f, _centre, 0f, false, 0f);
                }

                bool closing = _phaseElapsed > phase.WaitSeconds;
                float radius = phase.RadiusAt(_phaseElapsed);

                // The circle drifts toward its new centre while closing, so the
                // boundary sweeps rather than shrinking in place.
                Vector2 centre = closing
                    ? Vector2.Lerp(
                        _centre,
                        _nextCentre,
                        Mathf.Clamp01((_phaseElapsed - phase.WaitSeconds) / phase.CloseSeconds))
                    : _centre;

                float remaining = closing
                    ? phase.WaitSeconds + phase.CloseSeconds - _phaseElapsed
                    : phase.WaitSeconds - _phaseElapsed;

                return new StormState(
                    _phaseIndex, centre, radius, _nextCentre, phase.EndRadius,
                    closing, Mathf.Max(0f, remaining));
            }
        }

        /// <summary>
        /// Advance the storm.
        /// </summary>
        /// <param name="deltaTime">Seconds elapsed.</param>
        /// <param name="livingPlayers">
        /// Positions on the XZ plane, used to bias and clamp the next circle.
        /// </param>
        public void Advance(float deltaTime, IReadOnlyList<Vector2> livingPlayers)
        {
            if (_finished || CurrentPhase == null)
            {
                return;
            }

            _phaseElapsed += deltaTime;
            StormPhaseBlueprint phase = CurrentPhase;

            if (_phaseElapsed < phase.TotalSeconds)
            {
                return;
            }

            // The phase completed: the circle is now where it was closing to.
            _centre = _nextCentre;
            _phaseIndex++;
            _phaseElapsed = 0f;

            if (_phaseIndex >= _phases.Count)
            {
                _finished = true;
                return;
            }

            ChooseNextCentre(livingPlayers);
        }

        private void ChooseNextCentre(IReadOnlyList<Vector2> livingPlayers)
        {
            StormPhaseBlueprint phase = CurrentPhase;
            if (phase == null)
            {
                return;
            }

            _nextCentre = StormSimulation.ChooseNextCentre(
                phase,
                _centre,
                phase.StartRadius,
                phase.EndRadius,
                livingPlayers,
                _sprintSpeed,
                ref _rng,
                out bool impossible);

            if (impossible)
            {
                RotationClampImpossible?.Invoke(_phaseIndex);
            }
        }

        /// <summary>
        /// Storm damage for one interval, for a player at a position.
        /// </summary>
        /// <remarks>
        /// Returns raw damage that the caller applies directly to health. The
        /// storm bypasses shield by design: it is a clock, not a combat
        /// interaction.
        /// </remarks>
        public float DamageFor(Vector2 position, float deltaTime)
        {
            StormPhaseBlueprint phase = CurrentPhase;
            if (phase == null)
            {
                // Past the last phase the whole map is storm.
                return _finished ? _phases[^1].DamagePerSecond * deltaTime : 0f;
            }

            return Current.Contains(position)
                ? 0f
                : StormSimulation.DamageForInterval(phase, deltaTime);
        }

        /// <summary>Total match length implied by the phase list, in seconds.</summary>
        public float TotalSeconds
        {
            get
            {
                float total = 0f;
                for (int i = 0; i < _phases.Count; i++)
                {
                    total += _phases[i].TotalSeconds;
                }

                return total;
            }
        }

        /// <summary>
        /// Normalised match progress, which drives the night-clock lighting.
        /// </summary>
        public float Progress
        {
            get
            {
                if (_phases == null || _phases.Count == 0)
                {
                    return 0f;
                }

                float elapsed = _phaseElapsed;
                for (int i = 0; i < _phaseIndex && i < _phases.Count; i++)
                {
                    elapsed += _phases[i].TotalSeconds;
                }

                float total = TotalSeconds;
                return total <= 0f ? 0f : Mathf.Clamp01(elapsed / total);
            }
        }
    }
}
