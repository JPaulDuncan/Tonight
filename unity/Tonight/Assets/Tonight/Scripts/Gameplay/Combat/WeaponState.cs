using Tonight.Blueprints.Combat;
using UnityEngine;

namespace Tonight.Gameplay.Combat
{
    /// <summary>Why a trigger pull produced no shot.</summary>
    public enum FireRejection
    {
        None = 0,
        OnCooldown,
        MagazineEmpty,
        Reloading,
        Equipping,
        /// <summary>The mode needs the trigger released and pressed again.
        /// Covers semi-auto, bolt-action, and a spent burst.</summary>
        RequiresTriggerRelease,
        NoWeapon,
    }

    /// <summary>
    /// Per-instance weapon state: ammo, timers, bloom.
    /// </summary>
    /// <remarks>
    /// Deliberately a struct separate from <see cref="WeaponBlueprint"/>. The
    /// Blueprint is shared, read-only data; two players holding the same
    /// weapon must not share a magazine. See the authoring contract's rule 1.
    /// </remarks>
    public struct WeaponState
    {
        public int AmmoInMagazine;

        /// <summary>Tick of the last shot. Negative means never fired.</summary>
        public int LastShotTick;

        /// <summary>Tick at which a reload or equip completes.</summary>
        public int BusyUntilTick;

        public bool IsReloading;

        /// <summary>Shots fired in the current burst or trigger hold.</summary>
        public int ShotsThisTrigger;

        /// <summary>True while the trigger has been held since the last release.</summary>
        public bool TriggerHeld;

        public BloomState Bloom;

        public static WeaponState Fresh(WeaponBlueprint weapon) => new WeaponState
        {
            AmmoInMagazine = weapon != null ? weapon.MagazineSize : 0,
            LastShotTick = int.MinValue / 2,
            BusyUntilTick = 0,
            IsReloading = false,
            ShotsThisTrigger = 0,
            TriggerHeld = false,
        };
    }

    /// <summary>
    /// The firing state machine. One implementation for every weapon.
    /// </summary>
    /// <remarks>
    /// Fire modes are Blueprint data, so there is no per-weapon branch here --
    /// only per-<i>mode</i> scheduling, which is the generic behaviour the
    /// contract permits. A new weapon that fires unlike any existing one is a
    /// new asset, not a new case.
    /// </remarks>
    public static class WeaponFireController
    {
        /// <summary>
        /// Attempt to fire.
        /// </summary>
        /// <param name="state">Mutated on a successful shot.</param>
        /// <param name="weapon">The weapon's definition.</param>
        /// <param name="tick">Current simulation tick.</param>
        /// <param name="tickRate">Ticks per second.</param>
        /// <param name="triggerDown">Whether the trigger is held this tick.</param>
        public static FireRejection TryFire(
            ref WeaponState state,
            WeaponBlueprint weapon,
            int tick,
            int tickRate,
            bool triggerDown)
        {
            if (weapon == null)
            {
                return FireRejection.NoWeapon;
            }

            bool pressedThisTick = triggerDown && !state.TriggerHeld;
            if (!triggerDown)
            {
                // Releasing the trigger ends a burst and resets semi-auto.
                state.TriggerHeld = false;
                state.ShotsThisTrigger = 0;
                return FireRejection.None;
            }

            state.TriggerHeld = true;

            if (tick < state.BusyUntilTick)
            {
                return state.IsReloading ? FireRejection.Reloading : FireRejection.Equipping;
            }

            if (state.IsReloading)
            {
                // The reload finished; bank the ammo before deciding to fire.
                CompleteReload(ref state, weapon);
            }

            if (state.AmmoInMagazine <= 0)
            {
                return FireRejection.MagazineEmpty;
            }

            if (!ModeAllowsShot(in state, weapon, pressedThisTick))
            {
                return FireRejection.RequiresTriggerRelease;
            }

            int intervalTicks = IntervalTicks(weapon, tickRate);
            if (tick - state.LastShotTick < intervalTicks)
            {
                return FireRejection.OnCooldown;
            }

            state.AmmoInMagazine--;
            state.LastShotTick = tick;
            state.ShotsThisTrigger++;
            state.Bloom.OnShotFired(weapon);
            return FireRejection.None;
        }

        private static bool ModeAllowsShot(
            in WeaponState state, WeaponBlueprint weapon, bool pressedThisTick) =>
            weapon.FireMode switch
            {
                FireMode.Auto => true,

                // Semi and bolt-action need a fresh press per shot. Bolt-action
                // additionally pays its cycle time through the fire interval.
                FireMode.Semi => pressedThisTick,
                FireMode.BoltAction => pressedThisTick,

                // A burst runs to completion on one press, then needs another.
                FireMode.Burst => state.ShotsThisTrigger < weapon.BurstCount,

                _ => true,
            };

        /// <summary>Ticks between shots, rounded up so the authored RPM is never exceeded.</summary>
        public static int IntervalTicks(WeaponBlueprint weapon, int tickRate)
        {
            if (weapon == null || weapon.FireRateRpm <= 0f)
            {
                return int.MaxValue;
            }

            return Mathf.Max(1, Mathf.CeilToInt(weapon.ShotInterval * tickRate));
        }

        /// <summary>Begin a reload. Returns false when there is nothing to do.</summary>
        public static bool TryBeginReload(
            ref WeaponState state, WeaponBlueprint weapon, int tick, int tickRate, int reserveAmmo)
        {
            if (weapon == null || state.IsReloading)
            {
                return false;
            }

            if (state.AmmoInMagazine >= weapon.MagazineSize || reserveAmmo <= 0)
            {
                return false;
            }

            state.IsReloading = true;
            state.BusyUntilTick = tick + Mathf.CeilToInt(weapon.ReloadSeconds * tickRate);
            return true;
        }

        private static void CompleteReload(ref WeaponState state, WeaponBlueprint weapon)
        {
            state.IsReloading = false;
            state.AmmoInMagazine = weapon.MagazineSize;
        }

        /// <summary>
        /// Advance timers. Call once per tick.
        /// </summary>
        public static void Tick(
            ref WeaponState state, WeaponBlueprint weapon, int tick, float deltaTime)
        {
            state.Bloom.Tick(weapon, deltaTime);

            if (state.IsReloading && tick >= state.BusyUntilTick)
            {
                CompleteReload(ref state, weapon);
            }
        }

        /// <summary>
        /// Begin an equip. Cancelling one by swapping again is intended: a
        /// shotgun-AR-shotgun swap to cancel a reload is skill expression, not
        /// an exploit (docs/systems/inventory.md 2).
        /// </summary>
        public static void BeginEquip(
            ref WeaponState state, WeaponBlueprint weapon, int tick, int tickRate)
        {
            if (weapon == null)
            {
                return;
            }

            // Swapping away cancels a reload outright rather than banking it.
            state.IsReloading = false;
            state.BusyUntilTick = tick + Mathf.CeilToInt(weapon.EquipSeconds * tickRate);
            state.ShotsThisTrigger = 0;
            state.Bloom.Reset();
        }

        public static bool IsBusy(in WeaponState state, int tick) => tick < state.BusyUntilTick;
    }
}
