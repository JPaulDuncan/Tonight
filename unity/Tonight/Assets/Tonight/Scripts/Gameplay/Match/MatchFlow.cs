using Tonight.Blueprints.Match;
using UnityEngine;

namespace Tonight.Gameplay.Match
{
    public enum MatchPhase
    {
        Lobby,
        Bus,
        Freefall,
        InMatch,
        Victory,
    }

    /// <summary>
    /// The match state machine.
    /// </summary>
    /// <remarks>
    /// Every transition is server-driven. A client may request to eject; it may
    /// not request Victory.
    /// </remarks>
    public sealed class MatchFlow
    {
        /// <summary>Lobby starts at this timeout even if not full.</summary>
        public const float LobbyTimeoutSeconds = 90f;

        /// <summary>Below this, there is no match to run.</summary>
        public const int MinimumPlayers = 2;

        private readonly MatchRulesBlueprint _rules;
        private float _elapsedInPhase;

        public MatchFlow(MatchRulesBlueprint rules, int matchSeed)
        {
            _rules = rules;
            MatchSeed = matchSeed;
            Phase = MatchPhase.Lobby;
        }

        public MatchPhase Phase { get; private set; }

        /// <summary>Broadcast in the lobby so loot spawns and the bus path are
        /// reproducible for debugging.</summary>
        public int MatchSeed { get; }

        public float ElapsedInPhase => _elapsedInPhase;

        public int PlayersConnected { get; private set; }

        public int SquadsAlive { get; private set; }

        public event System.Action<MatchPhase, MatchPhase> PhaseChanged;

        public void SetPlayersConnected(int count) => PlayersConnected = Mathf.Max(0, count);

        public void SetSquadsAlive(int count) => SquadsAlive = Mathf.Max(0, count);

        /// <summary>Advance the state machine. Returns true when the phase changed.</summary>
        public bool Tick(float deltaTime)
        {
            _elapsedInPhase += deltaTime;

            MatchPhase next = Phase switch
            {
                MatchPhase.Lobby => TickLobby(),
                MatchPhase.Bus => TickBus(),
                MatchPhase.Freefall => MatchPhase.Freefall,
                MatchPhase.InMatch => TickMatch(),
                _ => Phase,
            };

            return TransitionTo(next);
        }

        private MatchPhase TickLobby()
        {
            if (_rules == null)
            {
                return MatchPhase.Lobby;
            }

            bool full = PlayersConnected >= _rules.MaxPlayers;
            bool timedOut = _elapsedInPhase >= LobbyTimeoutSeconds &&
                            PlayersConnected >= MinimumPlayers;

            return full || timedOut ? MatchPhase.Bus : MatchPhase.Lobby;
        }

        private MatchPhase TickBus()
        {
            float busSeconds = _rules != null ? _rules.BusSeconds : 45f;
            // At the end of the path everyone still aboard is ejected, so nobody
            // can ride the bus to a free placement.
            return _elapsedInPhase >= busSeconds ? MatchPhase.Freefall : MatchPhase.Bus;
        }

        private MatchPhase TickMatch() =>
            SquadsAlive <= 1 ? MatchPhase.Victory : MatchPhase.InMatch;

        /// <summary>A player left the bus. Freefall begins for them individually;
        /// the match-wide phase advances when the path ends.</summary>
        public bool RequestEject() => Phase == MatchPhase.Bus;

        /// <summary>Called when the last player has landed.</summary>
        public bool NotifyAllLanded()
        {
            return Phase == MatchPhase.Freefall && TransitionTo(MatchPhase.InMatch);
        }

        private bool TransitionTo(MatchPhase next)
        {
            if (next == Phase)
            {
                return false;
            }

            if (!IsLegalTransition(Phase, next))
            {
                Debug.LogError($"[Tonight] Illegal match transition {Phase} -> {next}");
                return false;
            }

            MatchPhase previous = Phase;
            Phase = next;
            _elapsedInPhase = 0f;
            PhaseChanged?.Invoke(previous, next);
            return true;
        }

        public static bool IsLegalTransition(MatchPhase from, MatchPhase to) => (from, to) switch
        {
            (MatchPhase.Lobby, MatchPhase.Bus) => true,
            (MatchPhase.Bus, MatchPhase.Freefall) => true,
            (MatchPhase.Freefall, MatchPhase.InMatch) => true,
            (MatchPhase.InMatch, MatchPhase.Victory) => true,
            // Victory returns to the frontend rather than looping in place.
            _ => false,
        };
    }
}
