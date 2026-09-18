using System.Collections.Generic;
using Tonight.Blueprints.Match;
using UnityEngine;

namespace Tonight.Gameplay.Match
{
    public enum PlayerLifeState
    {
        Alive,
        Downed,
        Eliminated,
    }

    /// <summary>One player's life state within a squad.</summary>
    public struct SquadMember
    {
        public int PlayerId;
        public PlayerLifeState State;

        /// <summary>Remaining DBNO health. Bleeds down while downed.</summary>
        public float DownedHealth;

        /// <summary>Progress toward being revived, in seconds.</summary>
        public float ReviveProgress;
    }

    /// <summary>
    /// Squad life state: downed-but-not-out, bleeding, revives, and wipes.
    /// </summary>
    /// <remarks>
    /// DBNO is enabled by <see cref="MatchRulesBlueprint.AllowDbno"/>, not by a
    /// code branch. Solo, Duos and Squads are three assets, so this class runs
    /// unchanged in all three -- in Solo the flag is simply off and lethal
    /// damage eliminates directly.
    /// </remarks>
    public sealed class SquadState
    {
        private readonly MatchRulesBlueprint _rules;
        private readonly List<SquadMember> _members = new List<SquadMember>();

        public SquadState(MatchRulesBlueprint rules, IReadOnlyList<int> playerIds)
        {
            _rules = rules;

            for (int i = 0; i < playerIds.Count; i++)
            {
                _members.Add(new SquadMember
                {
                    PlayerId = playerIds[i],
                    State = PlayerLifeState.Alive,
                });
            }
        }

        public IReadOnlyList<SquadMember> Members => _members;

        public bool IsWiped
        {
            get
            {
                for (int i = 0; i < _members.Count; i++)
                {
                    if (_members[i].State != PlayerLifeState.Eliminated)
                    {
                        return false;
                    }
                }

                return true;
            }
        }

        public int AliveCount => CountIn(PlayerLifeState.Alive);

        public int DownedCount => CountIn(PlayerLifeState.Downed);

        private int CountIn(PlayerLifeState state)
        {
            int count = 0;
            for (int i = 0; i < _members.Count; i++)
            {
                if (_members[i].State == state)
                {
                    count++;
                }
            }

            return count;
        }

        /// <summary>
        /// Apply lethal damage to a member.
        /// </summary>
        /// <returns>The member's resulting state.</returns>
        public PlayerLifeState ApplyLethalDamage(int playerId)
        {
            int index = IndexOf(playerId);
            if (index < 0)
            {
                return PlayerLifeState.Eliminated;
            }

            SquadMember member = _members[index];

            // Downing requires a living teammate to revive you. Without one it
            // is elimination, which is also why solo mode needs no special case.
            bool canBeDowned = _rules != null &&
                               _rules.AllowDbno &&
                               member.State == PlayerLifeState.Alive &&
                               HasOtherLivingMember(playerId);

            if (canBeDowned)
            {
                member.State = PlayerLifeState.Downed;
                member.DownedHealth = _rules.DbnoHealth;
                member.ReviveProgress = 0f;
            }
            else
            {
                member.State = PlayerLifeState.Eliminated;
            }

            _members[index] = member;

            // The last living member falling takes any downed squadmates with
            // them: nobody is left who could revive them.
            if (AliveCount == 0)
            {
                EliminateAllDowned();
            }

            return _members[index].State;
        }

        /// <summary>Advance bleed-out. Returns the ids eliminated this tick.</summary>
        public void Tick(float deltaTime, List<int> eliminated)
        {
            eliminated?.Clear();

            if (_rules == null || !_rules.AllowDbno)
            {
                return;
            }

            for (int i = 0; i < _members.Count; i++)
            {
                SquadMember member = _members[i];
                if (member.State != PlayerLifeState.Downed)
                {
                    continue;
                }

                member.DownedHealth -= _rules.DbnoBleedPerSecond * deltaTime;
                if (member.DownedHealth <= 0f)
                {
                    member.DownedHealth = 0f;
                    member.State = PlayerLifeState.Eliminated;
                    eliminated?.Add(member.PlayerId);
                }

                _members[i] = member;
            }

            if (AliveCount == 0)
            {
                EliminateAllDowned(eliminated);
            }
        }

        /// <summary>
        /// Progress a revive. Returns true when the member is back up.
        /// </summary>
        public bool TryRevive(int downedPlayerId, int reviverId, float deltaTime)
        {
            if (_rules == null || !_rules.AllowDbno)
            {
                return false;
            }

            int downedIndex = IndexOf(downedPlayerId);
            int reviverIndex = IndexOf(reviverId);

            if (downedIndex < 0 || reviverIndex < 0 || downedIndex == reviverIndex)
            {
                return false;
            }

            if (_members[downedIndex].State != PlayerLifeState.Downed ||
                _members[reviverIndex].State != PlayerLifeState.Alive)
            {
                return false;
            }

            SquadMember downed = _members[downedIndex];
            downed.ReviveProgress += deltaTime;

            if (downed.ReviveProgress >= _rules.ReviveSeconds)
            {
                downed.State = PlayerLifeState.Alive;
                downed.ReviveProgress = 0f;
                downed.DownedHealth = 0f;
                _members[downedIndex] = downed;
                return true;
            }

            _members[downedIndex] = downed;
            return false;
        }

        /// <summary>Interrupt a revive. Progress is lost, not banked.</summary>
        public void CancelRevive(int downedPlayerId)
        {
            int index = IndexOf(downedPlayerId);
            if (index < 0)
            {
                return;
            }

            SquadMember member = _members[index];
            member.ReviveProgress = 0f;
            _members[index] = member;
        }

        /// <summary>Health a revived player comes back on. Deliberately low, so a
        /// revive under fire is a risk rather than a reset.</summary>
        public const float ReviveHealth = 30f;

        private bool HasOtherLivingMember(int exceptPlayerId)
        {
            for (int i = 0; i < _members.Count; i++)
            {
                if (_members[i].PlayerId != exceptPlayerId &&
                    _members[i].State == PlayerLifeState.Alive)
                {
                    return true;
                }
            }

            return false;
        }

        private void EliminateAllDowned(List<int> eliminated = null)
        {
            for (int i = 0; i < _members.Count; i++)
            {
                SquadMember member = _members[i];
                if (member.State != PlayerLifeState.Downed)
                {
                    continue;
                }

                member.State = PlayerLifeState.Eliminated;
                _members[i] = member;
                eliminated?.Add(member.PlayerId);
            }
        }

        private int IndexOf(int playerId)
        {
            for (int i = 0; i < _members.Count; i++)
            {
                if (_members[i].PlayerId == playerId)
                {
                    return i;
                }
            }

            return -1;
        }
    }
}
