using System.Collections.Generic;
using UnityEngine;

namespace Tonight.Blueprints.Match
{
    /// <summary>
    /// A game mode. Solo, Duos, and Squads are three assets, not three code
    /// paths -- DBNO is a toggle here, never an <c>if</c> in a combat system.
    /// </summary>
    [CreateAssetMenu(
        fileName = "BP_Rules_New",
        menuName = "Tonight/Blueprints/Match/Match Rules",
        order = 0)]
    public sealed class MatchRulesBlueprint : TonightBlueprint
    {
        [Header("Squad")]
        [SerializeField, Min(1)] private int _squadSize = 1;
        [SerializeField, Min(2)] private int _maxPlayers = 100;

        [Header("Downed but not out")]
        [SerializeField] private bool _allowDbno;
        [SerializeField, Min(1f)] private float _dbnoHealth = 100f;
        [SerializeField, Min(0f)] private float _dbnoBleedPerSecond = 2f;
        [SerializeField, Min(0.1f)] private float _reviveSeconds = 8f;

        [Header("Match")]
        [SerializeField] private List<StormPhaseBlueprint> _stormPhases = new List<StormPhaseBlueprint>();
        [SerializeField] private MatchLightingBlueprint _lighting;
        [SerializeField, Min(1f)] private float _busSeconds = 45f;

        [SerializeField, Min(1f)]
        [Tooltip("Metres above ground. Automatic, so landing is a rotation " +
                 "decision rather than an execution test.")]
        private float _gliderDeployAltitude = 35f;

        [SerializeField] private List<ItemBlueprint> _startingLoadout = new List<ItemBlueprint>();
        [SerializeField] private bool _friendlyFire;

        public int SquadSize => _squadSize;
        public int MaxPlayers => _maxPlayers;
        public bool AllowDbno => _allowDbno;
        public float DbnoHealth => _dbnoHealth;
        public float DbnoBleedPerSecond => _dbnoBleedPerSecond;
        public float ReviveSeconds => _reviveSeconds;
        public IReadOnlyList<StormPhaseBlueprint> StormPhases => _stormPhases;
        public MatchLightingBlueprint Lighting => _lighting;
        public float BusSeconds => _busSeconds;
        public float GliderDeployAltitude => _gliderDeployAltitude;
        public IReadOnlyList<ItemBlueprint> StartingLoadout => _startingLoadout;
        public bool FriendlyFire => _friendlyFire;

        /// <summary>Total storm duration, used to sanity-check match length.</summary>
        public float TotalStormSeconds
        {
            get
            {
                float total = 0f;
                for (int i = 0; i < _stormPhases.Count; i++)
                {
                    if (_stormPhases[i] != null)
                    {
                        total += _stormPhases[i].TotalSeconds;
                    }
                }

                return total;
            }
        }

        public override void Validate(BlueprintValidationContext ctx)
        {
            base.Validate(ctx);

            ctx.Require(_squadSize >= 1, "SquadSize must be at least 1.");
            ctx.Require(_maxPlayers >= _squadSize, "MaxPlayers must be at least SquadSize.");
            ctx.Require(_maxPlayers % _squadSize == 0,
                "MaxPlayers must divide evenly by SquadSize, or the last squad is short.");
            ctx.Require(_stormPhases.Count > 0, "Match rules need at least one storm phase.");
            ctx.Require(_lighting != null, "Match rules need a MatchLightingBlueprint.");

            for (int i = 0; i < _stormPhases.Count; i++)
            {
                ctx.Require(_stormPhases[i] != null, $"Storm phase {i} is unassigned.");
            }

            ctx.Warn(!_allowDbno || _squadSize > 1,
                "DBNO is enabled on a solo mode. Legal, but nobody can revive anyone.");

            float minutes = TotalStormSeconds / 60f;
            ctx.Warn(minutes >= 12f && minutes <= 22f,
                $"Storm phases total {minutes:F1} minutes; the design target is a " +
                "16-18 minute match, and over 22 is a tuning bug.");
        }
    }
}
