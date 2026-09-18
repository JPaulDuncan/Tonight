using System.Collections.Generic;
using NUnit.Framework;
using Tonight.Blueprints.Combat;
using Tonight.Gameplay.Combat;
using UnityEngine;

namespace Tonight.Tests.EditMode
{
    public sealed class WeaponFireControllerTests
    {
        private const int TickRate = 30;

        private WeaponBlueprint _auto;
        private WeaponBlueprint _semi;
        private WeaponBlueprint _burst;
        private WeaponBlueprint _bolt;
        private DamageProfileBlueprint _profile;

        [SetUp]
        public void SetUp()
        {
            _profile = TestBlueprints.Create<DamageProfileBlueprint>(new Dictionary<string, object>
            {
                { "_baseDamage", 30f },
            });

            _auto = Weapon(FireMode.Auto, 600f, 30);
            _semi = Weapon(FireMode.Semi, 300f, 16);
            _burst = Weapon(FireMode.Burst, 600f, 30, burst: 3);
            _bolt = Weapon(FireMode.BoltAction, 40f, 1);
        }

        [TearDown]
        public void TearDown()
        {
            foreach (Object asset in new Object[] { _auto, _semi, _burst, _bolt, _profile })
            {
                Object.DestroyImmediate(asset);
            }
        }

        private WeaponBlueprint Weapon(FireMode mode, float rpm, int magazine, int burst = 3) =>
            TestBlueprints.Create<WeaponBlueprint>(new Dictionary<string, object>
            {
                { "_fireMode", mode },
                { "_fireRateRpm", rpm },
                { "_magazineSize", magazine },
                { "_burstCount", burst },
                { "_reloadSeconds", 2f },
                { "_equipSeconds", 0.5f },
                { "_damageProfile", _profile },
                { "_bloomPerShot", 0.15f },
                { "_bloomMaxDegrees", 3f },
                { "_bloomRecoveryPerSecond", 4f },
            });

        [Test]
        public void AutoFiresAtTheAuthoredRate()
        {
            // 600 rpm at 30 Hz is one shot every 3 ticks.
            Assert.AreEqual(3, WeaponFireController.IntervalTicks(_auto, TickRate));

            var state = WeaponState.Fresh(_auto);
            int fired = 0;
            for (int tick = 0; tick < 30; tick++)
            {
                if (WeaponFireController.TryFire(ref state, _auto, tick, TickRate, true)
                    == FireRejection.None)
                {
                    fired++;
                }
            }

            Assert.AreEqual(10, fired, "One second of 600 rpm is 10 shots");
        }

        [Test]
        public void FireRateIsNeverExceeded()
        {
            // Rounding up the interval means the authored RPM is a ceiling.
            var state = WeaponState.Fresh(_auto);
            var shotTicks = new List<int>();

            for (int tick = 0; tick < 120; tick++)
            {
                if (WeaponFireController.TryFire(ref state, _auto, tick, TickRate, true)
                    == FireRejection.None)
                {
                    shotTicks.Add(tick);
                }
            }

            for (int i = 1; i < shotTicks.Count; i++)
            {
                Assert.GreaterOrEqual(shotTicks[i] - shotTicks[i - 1], 3);
            }
        }

        [Test]
        public void SemiAutoNeedsAFreshPressPerShot()
        {
            var state = WeaponState.Fresh(_semi);

            Assert.AreEqual(FireRejection.None,
                WeaponFireController.TryFire(ref state, _semi, 0, TickRate, true));
            int afterFirst = state.AmmoInMagazine;

            // Holding for a full second must not fire again.
            for (int tick = 1; tick < 30; tick++)
            {
                Assert.AreEqual(FireRejection.RequiresTriggerRelease,
                    WeaponFireController.TryFire(ref state, _semi, tick, TickRate, true));
            }

            Assert.AreEqual(afterFirst, state.AmmoInMagazine);

            // Release, then press again.
            WeaponFireController.TryFire(ref state, _semi, 31, TickRate, false);
            Assert.AreEqual(FireRejection.None,
                WeaponFireController.TryFire(ref state, _semi, 32, TickRate, true));
            Assert.AreEqual(afterFirst - 1, state.AmmoInMagazine);
        }

        [Test]
        public void BurstFiresExactlyItsCountThenStops()
        {
            var state = WeaponState.Fresh(_burst);
            int start = state.AmmoInMagazine;

            for (int tick = 0; tick < 60; tick++)
            {
                WeaponFireController.TryFire(ref state, _burst, tick, TickRate, true);
            }

            Assert.AreEqual(start - 3, state.AmmoInMagazine, "One press is one burst of 3");
        }

        [Test]
        public void ReleasingAndPressingFiresAnotherBurst()
        {
            var state = WeaponState.Fresh(_burst);
            int start = state.AmmoInMagazine;

            for (int tick = 0; tick < 30; tick++)
            {
                WeaponFireController.TryFire(ref state, _burst, tick, TickRate, true);
            }

            WeaponFireController.TryFire(ref state, _burst, 31, TickRate, false);

            for (int tick = 32; tick < 62; tick++)
            {
                WeaponFireController.TryFire(ref state, _burst, tick, TickRate, true);
            }

            Assert.AreEqual(start - 6, state.AmmoInMagazine);
        }

        [Test]
        public void AnEmptyMagazineRefusesToFire()
        {
            var state = WeaponState.Fresh(_bolt);
            WeaponFireController.TryFire(ref state, _bolt, 0, TickRate, true);
            Assert.AreEqual(0, state.AmmoInMagazine);

            WeaponFireController.TryFire(ref state, _bolt, 100, TickRate, false);
            Assert.AreEqual(FireRejection.MagazineEmpty,
                WeaponFireController.TryFire(ref state, _bolt, 200, TickRate, true));
        }

        [Test]
        public void ReloadTakesTheAuthoredTimeAndRefillsTheMagazine()
        {
            var state = WeaponState.Fresh(_auto);
            state.AmmoInMagazine = 3;

            Assert.IsTrue(WeaponFireController.TryBeginReload(ref state, _auto, 0, TickRate, 100));
            Assert.IsTrue(state.IsReloading);

            // 2 s at 30 Hz.
            int done = Mathf.CeilToInt(2f * TickRate);
            WeaponFireController.Tick(ref state, _auto, done - 1, 1f / TickRate);
            Assert.IsTrue(state.IsReloading, "Should still be reloading one tick early");

            WeaponFireController.Tick(ref state, _auto, done, 1f / TickRate);
            Assert.IsFalse(state.IsReloading);
            Assert.AreEqual(_auto.MagazineSize, state.AmmoInMagazine);
        }

        [Test]
        public void ReloadingAFullMagazineIsRefused()
        {
            var state = WeaponState.Fresh(_auto);
            Assert.IsFalse(WeaponFireController.TryBeginReload(ref state, _auto, 0, TickRate, 100));
        }

        [Test]
        public void ReloadingWithNoReserveAmmoIsRefused()
        {
            var state = WeaponState.Fresh(_auto);
            state.AmmoInMagazine = 0;
            Assert.IsFalse(WeaponFireController.TryBeginReload(ref state, _auto, 0, TickRate, 0));
        }

        [Test]
        public void SwappingCancelsAReloadRatherThanBankingIt()
        {
            // Shotgun-AR-shotgun to cancel a reload is deliberate skill
            // expression, not an exploit -- but it must actually cancel, or it
            // would be a free instant reload instead.
            var state = WeaponState.Fresh(_auto);
            state.AmmoInMagazine = 3;
            WeaponFireController.TryBeginReload(ref state, _auto, 0, TickRate, 100);

            WeaponFireController.BeginEquip(ref state, _auto, 5, TickRate);

            Assert.IsFalse(state.IsReloading);
            Assert.AreEqual(3, state.AmmoInMagazine, "The magazine must not have been refilled");
        }

        [Test]
        public void EquippingBlocksFiringForTheAuthoredTime()
        {
            var state = WeaponState.Fresh(_auto);
            WeaponFireController.BeginEquip(ref state, _auto, 0, TickRate);

            Assert.AreEqual(FireRejection.Equipping,
                WeaponFireController.TryFire(ref state, _auto, 5, TickRate, true));

            int ready = Mathf.CeilToInt(0.5f * TickRate);
            Assert.AreEqual(FireRejection.None,
                WeaponFireController.TryFire(ref state, _auto, ready, TickRate, true));
        }

        [Test]
        public void BloomAccumulatesWhileFiringAndRecoversWhenIdle()
        {
            var state = WeaponState.Fresh(_auto);

            for (int tick = 0; tick < 30; tick++)
            {
                WeaponFireController.TryFire(ref state, _auto, tick, TickRate, true);
            }

            Assert.Greater(state.Bloom.CurrentDegrees, 0f);
            float peak = state.Bloom.CurrentDegrees;
            Assert.LessOrEqual(peak, _auto.BloomMaxDegrees);

            for (int tick = 30; tick < 120; tick++)
            {
                WeaponFireController.Tick(ref state, _auto, tick, 1f / TickRate);
            }

            Assert.AreEqual(0f, state.Bloom.CurrentDegrees, 0.001f);
        }

        [Test]
        public void FirstShotIsAccurateAtRestForASingleProjectileWeapon()
        {
            var state = WeaponState.Fresh(_auto);
            Assert.AreEqual(0f, state.Bloom.EffectiveSpread(_auto), 0.0001f);

            WeaponFireController.TryFire(ref state, _auto, 0, TickRate, true);
            Assert.Greater(state.Bloom.EffectiveSpread(_auto), 0f);
        }

        [Test]
        public void PelletDirectionsAreDeterministicAndInsideTheCone()
        {
            // A predicted shotgun blast must match the authoritative one without
            // replicating anything per pellet.
            const float spread = 4.2f;
            for (int pellet = 0; pellet < 10; pellet++)
            {
                Vector3 a = BloomState.PelletDirection(Vector3.forward, spread, 1234, pellet);
                Vector3 b = BloomState.PelletDirection(Vector3.forward, spread, 1234, pellet);
                Assert.AreEqual(a, b);

                float angle = Vector3.Angle(Vector3.forward, a);
                Assert.LessOrEqual(angle, spread + 0.001f, $"Pellet {pellet} escaped the cone");
                Assert.AreEqual(1f, a.magnitude, 0.001f);
            }
        }

        [Test]
        public void DifferentShotsProduceDifferentPatterns()
        {
            Vector3 first = BloomState.PelletDirection(Vector3.forward, 4.2f, 1, 0);
            Vector3 second = BloomState.PelletDirection(Vector3.forward, 4.2f, 2, 0);
            Assert.AreNotEqual(first, second);
        }

        [Test]
        public void ZeroSpreadFiresDeadStraight()
        {
            Vector3 direction = BloomState.PelletDirection(Vector3.forward, 0f, 7, 0);
            Assert.AreEqual(Vector3.forward, direction);
        }
    }

    public sealed class HealthPoolTests
    {
        [Test]
        public void ShieldStartsEmptyBecauseItIsLootedNotGranted()
        {
            HealthPool pool = HealthPool.Full(100f, 100f);
            Assert.AreEqual(100f, pool.Health);
            Assert.AreEqual(0f, pool.Shield);
        }

        [Test]
        public void ApplyingDamageDrainsShieldThenHealth()
        {
            HealthPool pool = HealthPool.Full(100f, 100f);
            pool.AddShield(50f);

            bool died = pool.Apply(DamageCalculator.Split(80f, pool.Shield, pool.Health, 0f));

            Assert.IsFalse(died);
            Assert.AreEqual(0f, pool.Shield, 0.01f);
            Assert.AreEqual(70f, pool.Health, 0.01f);
        }

        [Test]
        public void PoolsNeverGoNegative()
        {
            HealthPool pool = HealthPool.Full(100f, 100f);
            pool.Apply(DamageCalculator.Split(99999f, pool.Shield, pool.Health, 0f));

            Assert.AreEqual(0f, pool.Health);
            Assert.AreEqual(0f, pool.Shield);
            Assert.IsFalse(pool.IsAlive);
        }

        [Test]
        public void HealingRespectsThePerItemCap()
        {
            // A bandage heals to 75 and no further; that cap is what makes the
            // bandage-versus-medkit choice a decision rather than a duration.
            HealthPool pool = HealthPool.Full(100f, 100f);
            pool.Health = 20f;

            Assert.AreEqual(15f, pool.Heal(15f, 75f), 0.01f);
            Assert.AreEqual(35f, pool.Health, 0.01f);

            pool.Health = 70f;
            Assert.AreEqual(5f, pool.Heal(15f, 75f), 0.01f);
            Assert.AreEqual(75f, pool.Health, 0.01f);

            Assert.AreEqual(0f, pool.Heal(15f, 75f), 0.01f, "Already at the cap");
        }

        [Test]
        public void HealingNeverExceedsMaxHealthEvenWithAHighCap()
        {
            HealthPool pool = HealthPool.Full(100f, 100f);
            pool.Health = 90f;
            pool.Heal(500f, 999f);
            Assert.AreEqual(100f, pool.Health);
        }

        [Test]
        public void ShieldIsCappedAtItsMaximum()
        {
            HealthPool pool = HealthPool.Full(100f, 100f);
            Assert.AreEqual(100f, pool.AddShield(250f), 0.01f);
            Assert.AreEqual(100f, pool.Shield);
            Assert.AreEqual(0f, pool.AddShield(50f), 0.01f);
        }

        [Test]
        public void StormDamageIgnoresShield()
        {
            // The storm is a clock, not a combat interaction; letting shields
            // absorb it would blunt the pacing it exists to create.
            HealthPool pool = HealthPool.Full(100f, 100f);
            pool.AddShield(100f);

            pool.ApplyDirectHealthDamage(10f);

            Assert.AreEqual(100f, pool.Shield, "Storm damage must bypass shield");
            Assert.AreEqual(90f, pool.Health, 0.01f);
        }
    }
}
