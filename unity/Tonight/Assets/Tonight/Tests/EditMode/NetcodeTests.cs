using System;
using System.Collections.Generic;
using NUnit.Framework;
using Tonight.Blueprints.Character;
using Tonight.Core;
using Tonight.Gameplay.Commands;
using Tonight.Gameplay.Movement;
using Tonight.Net;
using UnityEngine;

namespace Tonight.Tests.EditMode
{
    public sealed class StructureRecordTests
    {
        [Test]
        public void RecordIsExactlyNineBytes()
        {
            // The bandwidth budget in docs/systems/netcode.md 6 is computed from
            // this number. If the record grows, the budget is wrong.
            Assert.AreEqual(9, StructureRecord.SizeBytes);
        }

        [Test]
        public void RoundTripsAcrossTheFullCellRange()
        {
            Span<byte> buffer = stackalloc byte[StructureRecord.SizeBytes];

            foreach (int x in new[] { short.MinValue, -1000, -1, 0, 1, 1000, short.MaxValue })
            {
                foreach (int y in new[] { short.MinValue, -5, 0, 5, short.MaxValue })
                {
                    foreach (int z in new[] { short.MinValue, -1, 0, 1, short.MaxValue })
                    {
                        var original = new StructureRecord(
                            new GridCell(x, y, z), BuildSlot.EastFace, 3, 1, 9);

                        original.Write(buffer);
                        StructureRecord decoded = StructureRecord.Read(buffer);

                        Assert.AreEqual(original, decoded, $"Failed for ({x},{y},{z})");
                    }
                }
            }
        }

        [Test]
        public void EverySlotSurvivesThePackedByte()
        {
            // Slot shares a byte with the health bucket, so a slot value that
            // overflowed its three bits would silently corrupt health.
            Span<byte> buffer = stackalloc byte[StructureRecord.SizeBytes];

            foreach (BuildSlot slot in Enum.GetValues(typeof(BuildSlot)))
            {
                var original = new StructureRecord(new GridCell(1, 2, 3), slot, 7, 2, 15);
                original.Write(buffer);
                StructureRecord decoded = StructureRecord.Read(buffer);

                Assert.AreEqual(slot, decoded.Slot);
                Assert.AreEqual(15, decoded.HealthBucket, "Health was corrupted by the slot");
            }
        }

        [Test]
        public void EveryHealthBucketSurvivesThePackedByte()
        {
            Span<byte> buffer = stackalloc byte[StructureRecord.SizeBytes];

            for (byte bucket = 0; bucket < StructureRecord.HealthBuckets; bucket++)
            {
                var original = new StructureRecord(
                    new GridCell(-4, 0, 9), BuildSlot.Interior, 200, 250, bucket);
                original.Write(buffer);
                StructureRecord decoded = StructureRecord.Read(buffer);

                Assert.AreEqual(bucket, decoded.HealthBucket);
                Assert.AreEqual(BuildSlot.Interior, decoded.Slot);
                Assert.AreEqual(200, decoded.PieceId);
                Assert.AreEqual(250, decoded.MaterialId);
            }
        }

        [Test]
        public void EncodingIsLittleEndianRegardlessOfHost()
        {
            // BitConverter is host-endian and would silently disagree between a
            // big-endian server and a little-endian client.
            Span<byte> buffer = stackalloc byte[StructureRecord.SizeBytes];
            new StructureRecord(new GridCell(0x0102, 0, 0), BuildSlot.NorthFace, 0, 0, 0)
                .Write(buffer);

            Assert.AreEqual(0x02, buffer[0], "Low byte should come first");
            Assert.AreEqual(0x01, buffer[1]);
        }

        [Test]
        public void ALivingPieceNeverQuantisesToZero()
        {
            // A wall on 1% health is still cover. Showing it as destroyed would
            // be worse than showing it as slightly damaged.
            Assert.AreEqual(0, StructureRecord.QuantiseHealth(0f, 150f));
            Assert.Greater(StructureRecord.QuantiseHealth(0.01f, 150f), 0);
            Assert.Greater(StructureRecord.QuantiseHealth(1f, 150f), 0);
        }

        [Test]
        public void FullHealthQuantisesToTheTopBucket()
        {
            Assert.AreEqual(
                StructureRecord.HealthBuckets - 1, StructureRecord.QuantiseHealth(150f, 150f));
        }

        [Test]
        public void QuantisationIsMonotonic()
        {
            int previous = -1;
            for (float health = 0f; health <= 150f; health += 1f)
            {
                int bucket = StructureRecord.QuantiseHealth(health, 150f);
                Assert.GreaterOrEqual(bucket, previous, $"Bucket fell at {health} HP");
                previous = bucket;
            }
        }

        [Test]
        public void QuantisationRemovesMostChipDamageUpdates()
        {
            // The point of bucketing: ordinary chip damage should not generate a
            // network update per hit.
            int changes = 0;
            int lastBucket = StructureRecord.QuantiseHealth(150f, 150f);

            for (float damage = 1f; damage <= 150f; damage += 1f)
            {
                int bucket = StructureRecord.QuantiseHealth(150f - damage, 150f);
                if (bucket != lastBucket)
                {
                    changes++;
                    lastBucket = bucket;
                }
            }

            Assert.LessOrEqual(changes, StructureRecord.HealthBuckets,
                "150 points of damage should produce at most one update per bucket");
        }

        [Test]
        public void WritingToASmallBufferThrowsRatherThanCorrupting()
        {
            Assert.Throws<ArgumentException>(() =>
            {
                var buffer = new byte[StructureRecord.SizeBytes - 1];
                new StructureRecord(default, BuildSlot.NorthFace, 0, 0, 0).Write(buffer);
            });
        }

        [Test]
        public void EndGameFightFitsTheBandwidthBudget()
        {
            // netcode.md 6 budgets 12 kbit/s for structure deltas at 60
            // placements per second. Verify the arithmetic rather than trusting
            // the table.
            const int placementsPerSecond = 60;
            int bitsPerSecond = placementsPerSecond * StructureRecord.SizeBytes * 8;

            Assert.LessOrEqual(bitsPerSecond, 12000,
                $"60 placements/s costs {bitsPerSecond} bit/s against a 12 kbit/s budget");
        }
    }

    public sealed class MovementPredictionTests
    {
        private const int TickRate = 30;
        private const float Tick = 1f / TickRate;

        private MovementBlueprint _movement;
        private FlatGroundCollision _ground;
        private MovementPredictionBuffer _buffer;

        [SetUp]
        public void SetUp()
        {
            _movement = TestBlueprints.Create<MovementBlueprint>(new Dictionary<string, object>
            {
                { "_walkSpeed", 4.6f },
                { "_sprintSpeed", 7.4f },
                { "_crouchSpeed", 2.3f },
                { "_acceleration", 60f },
                { "_deceleration", 45f },
                { "_airControl", 0.35f },
                { "_jumpHeight", 1.1f },
                { "_gravity", -22f },
                { "_terminalVelocity", 55f },
                { "_standHeight", 1.8f },
                { "_crouchHeight", 0.9f },
            });
            _ground = new FlatGroundCollision(0f);
            _buffer = new MovementPredictionBuffer();
        }

        [TearDown]
        public void TearDown() => Object.DestroyImmediate(_movement);

        private MotorState SimulateAndRecord(MotorState state, int fromTick, int count)
        {
            for (int i = 0; i < count; i++)
            {
                int tick = fromTick + i;
                var command = new MoveCommand(
                    tick, new Vector2(0f, 1f), Vector2.zero, MoveFlags.None, Tick);
                state = CharacterMotor.Step(state, command, _movement, _ground, out _);
                _buffer.Record(tick, command, state);
            }

            return state;
        }

        [Test]
        public void AgreementPrunesHistoryWithoutCorrecting()
        {
            MotorState state = MotorState.AtRest(Vector3.zero);
            state = SimulateAndRecord(state, 0, 10);

            // The server agrees exactly with the prediction for tick 4.
            MotorState authoritative = ReplayTo(4);
            MotorState current = state;

            ReconcileResult result = _buffer.Reconcile(
                4, authoritative, ref current, _movement, _ground);

            Assert.IsFalse(result.Corrected, "An exact match should not correct");
            Assert.AreEqual(0, result.ReplayedCommands);
            Assert.AreEqual(5, _buffer.PendingCount, "Ticks 0-4 should have been pruned");
        }

        [Test]
        public void ASmallDisagreementIsToleratedRatherThanCorrected()
        {
            // Below the epsilon a correction would be visible jitter, not a fix.
            MotorState state = MotorState.AtRest(Vector3.zero);
            SimulateAndRecord(state, 0, 10);

            MotorState authoritative = ReplayTo(4);
            authoritative.Position += new Vector3(0.005f, 0f, 0f);

            MotorState current = state;
            ReconcileResult result = _buffer.Reconcile(
                4, authoritative, ref current, _movement, _ground);

            Assert.IsFalse(result.Corrected);
        }

        [Test]
        public void ALargeDisagreementSnapsAndReplays()
        {
            MotorState state = MotorState.AtRest(Vector3.zero);
            state = SimulateAndRecord(state, 0, 10);

            MotorState authoritative = ReplayTo(4);
            authoritative.Position += new Vector3(2f, 0f, 0f);

            MotorState current = state;
            ReconcileResult result = _buffer.Reconcile(
                4, authoritative, ref current, _movement, _ground);

            Assert.IsTrue(result.Corrected);
            Assert.AreEqual(5, result.ReplayedCommands, "Ticks 5-9 should have replayed");

            // The correction should carry through: the replayed result keeps the
            // server's 2 m offset rather than snapping back to the prediction.
            Assert.AreEqual(2f, current.Position.x, 0.01f);
        }

        [Test]
        public void ReplayIsExactSoReconcilingTwiceChangesNothing()
        {
            // The property that makes reconciliation stable: replaying the same
            // commands from the same state must reproduce the same answer.
            MotorState state = MotorState.AtRest(Vector3.zero);
            state = SimulateAndRecord(state, 0, 20);

            MotorState authoritative = ReplayTo(9);
            authoritative.Position += new Vector3(1f, 0f, 0f);

            MotorState first = state;
            _buffer.Reconcile(9, authoritative, ref first, _movement, _ground);

            // Rebuild an identical buffer and reconcile again.
            var second = new MovementPredictionBuffer();
            MotorState rebuilt = MotorState.AtRest(Vector3.zero);
            for (int tick = 0; tick < 20; tick++)
            {
                var command = new MoveCommand(
                    tick, new Vector2(0f, 1f), Vector2.zero, MoveFlags.None, Tick);
                rebuilt = CharacterMotor.Step(rebuilt, command, _movement, _ground, out _);
                second.Record(tick, command, rebuilt);
            }

            MotorState secondResult = rebuilt;
            second.Reconcile(9, authoritative, ref secondResult, _movement, _ground);

            Assert.AreEqual(first.Position.x, secondResult.Position.x, 0f);
            Assert.AreEqual(first.Position.z, secondResult.Position.z, 0f);
        }

        [Test]
        public void AnAckBeyondHistoryAcceptsTheServerOutright()
        {
            MotorState state = MotorState.AtRest(Vector3.zero);
            SimulateAndRecord(state, 0, 5);

            MotorState authoritative = MotorState.AtRest(new Vector3(50f, 0f, 50f));
            MotorState current = state;

            ReconcileResult result = _buffer.Reconcile(
                999, authoritative, ref current, _movement, _ground);

            Assert.IsTrue(result.Corrected);
            Assert.AreEqual(50f, current.Position.x, 0.01f);
            Assert.AreEqual(0, _buffer.PendingCount);
        }

        [Test]
        public void AStaleAckIsIgnored()
        {
            MotorState state = MotorState.AtRest(Vector3.zero);
            state = SimulateAndRecord(state, 10, 5);

            MotorState current = state;
            ReconcileResult result = _buffer.Reconcile(
                3, MotorState.AtRest(Vector3.zero), ref current, _movement, _ground);

            Assert.IsFalse(result.Corrected);
            Assert.AreEqual(5, _buffer.PendingCount, "A stale ack must not prune history");
        }

        [Test]
        public void HistoryIsBoundedSoALostConnectionCannotGrowItForever()
        {
            MotorState state = MotorState.AtRest(Vector3.zero);
            SimulateAndRecord(state, 0, MovementPredictionBuffer.Capacity * 3);

            Assert.LessOrEqual(_buffer.PendingCount, MovementPredictionBuffer.Capacity);
        }

        private MotorState ReplayTo(int tick)
        {
            MotorState state = MotorState.AtRest(Vector3.zero);
            for (int i = 0; i <= tick; i++)
            {
                var command = new MoveCommand(
                    i, new Vector2(0f, 1f), Vector2.zero, MoveFlags.None, Tick);
                state = CharacterMotor.Step(state, command, _movement, _ground, out _);
            }

            return state;
        }
    }

    public sealed class LagCompensationTests
    {
        private const int TickRate = 30;

        [Test]
        public void RewindIsCappedAtTheFairnessBound()
        {
            // Beyond 250 ms a high-latency shooter would be killing people who
            // have been behind cover for a quarter second on their own screen.
            var buffer = new HitboxRewindBuffer(TickRate);

            // A 400 ms-late shot compensates exactly 250 ms.
            int serverTick = 100;
            int clientTick = serverTick - Mathf.CeilToInt(0.4f * TickRate);
            int rewound = buffer.ClampRewindTick(serverTick, clientTick);

            Assert.AreEqual(serverTick - buffer.MaxRewindTicks, rewound);
        }

        [Test]
        public void ARewindInsideTheBoundIsHonouredExactly()
        {
            var buffer = new HitboxRewindBuffer(TickRate);
            int serverTick = 100;
            int clientTick = serverTick - 3;

            Assert.AreEqual(clientTick, buffer.ClampRewindTick(serverTick, clientTick));
        }

        [Test]
        public void AClientClaimingAFutureTickGetsNoCompensation()
        {
            var buffer = new HitboxRewindBuffer(TickRate);
            Assert.AreEqual(100, buffer.ClampRewindTick(100, 150));
        }

        [Test]
        public void PositionsAreRecoveredFromHistory()
        {
            var buffer = new HitboxRewindBuffer(TickRate);
            for (int tick = 0; tick < 10; tick++)
            {
                buffer.Capture(7, tick, new Vector3(tick, 0f, 0f), tick * 10f);
            }

            Assert.IsTrue(buffer.TryGetAt(7, 5, out Vector3 position, out float yaw));
            Assert.AreEqual(5f, position.x, 0.001f);
            Assert.AreEqual(50f, yaw, 0.001f);
        }

        [Test]
        public void PositionsBetweenSamplesAreInterpolated()
        {
            var buffer = new HitboxRewindBuffer(TickRate);
            buffer.Capture(7, 0, Vector3.zero, 0f);
            buffer.Capture(7, 10, new Vector3(10f, 0f, 0f), 0f);

            Assert.IsTrue(buffer.TryGetAt(7, 5, out Vector3 position, out _));
            Assert.AreEqual(5f, position.x, 0.001f);
        }

        [Test]
        public void HistoryIsTrimmedToTheRetentionWindow()
        {
            var buffer = new HitboxRewindBuffer(TickRate);
            for (int tick = 0; tick < 200; tick++)
            {
                buffer.Capture(7, tick, new Vector3(tick, 0f, 0f), 0f);
            }

            // 500 ms at 30 Hz is 15 ticks, plus the current one.
            Assert.LessOrEqual(buffer.SnapshotCount(7), 20);
            Assert.Greater(buffer.SnapshotCount(7), buffer.MaxRewindTicks,
                "Must retain more than the maximum rewind, or a capped rewind has no sample");
        }

        [Test]
        public void AnUnknownPlayerIsNotFound()
        {
            var buffer = new HitboxRewindBuffer(TickRate);
            Assert.IsFalse(buffer.TryGetAt(999, 0, out _, out _));
        }
    }

    public sealed class CommandSanityTests
    {
        [Test]
        public void NormalMovementIsPlausible()
        {
            Assert.IsTrue(CommandSanity.IsSpeedPlausible(
                Vector3.zero, new Vector3(0.24f, 0f, 0f), 1f / 30f, 7.4f));
        }

        [Test]
        public void SpeedHackingIsRejected()
        {
            Assert.IsFalse(CommandSanity.IsSpeedPlausible(
                Vector3.zero, new Vector3(5f, 0f, 0f), 1f / 30f, 7.4f));
        }

        [Test]
        public void ASmallOverageIsToleratedSoHonestClientsAreNotPunished()
        {
            // 10% tolerance absorbs floating-point drift and tick jitter.
            float perTick = 7.4f / 30f;
            Assert.IsTrue(CommandSanity.IsSpeedPlausible(
                Vector3.zero, new Vector3(perTick * 1.05f, 0f, 0f), 1f / 30f, 7.4f));
        }

        [Test]
        public void TeleportsAreRejected()
        {
            Assert.IsFalse(CommandSanity.IsNotATeleport(Vector3.zero, new Vector3(100f, 0f, 0f)));
            Assert.IsTrue(CommandSanity.IsNotATeleport(Vector3.zero, new Vector3(5f, 0f, 0f)));
        }

        [Test]
        public void OutOfBandTimestampsAreRejected()
        {
            Assert.IsTrue(CommandSanity.IsTimestampPlausible(100, 95, 30));
            Assert.IsFalse(CommandSanity.IsTimestampPlausible(100, 0, 30));
            Assert.IsFalse(CommandSanity.IsTimestampPlausible(100, 500, 30));
        }

        [Test]
        public void FiringFasterThanTheWeaponAllowsIsRejected()
        {
            Assert.IsTrue(CommandSanity.IsFireRatePlausible(3, 3));
            Assert.IsFalse(CommandSanity.IsFireRatePlausible(1, 6));
        }
    }
}
