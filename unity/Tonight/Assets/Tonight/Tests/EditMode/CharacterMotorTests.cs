using System.Collections.Generic;
using NUnit.Framework;
using Tonight.Blueprints.Character;
using Tonight.Gameplay.Commands;
using Tonight.Gameplay.Movement;
using UnityEngine;

namespace Tonight.Tests.EditMode
{
    public sealed class CharacterMotorTests
    {
        private const float Tick = 1f / 30f;

        private MovementBlueprint _movement;
        private FlatGroundCollision _ground;

        [SetUp]
        public void SetUp()
        {
            // The GDD section 3 defaults, matching BP_Movement_Default.
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
                { "_fallDamageThreshold", 3.5f },
                { "_fallDamagePerMetre", 10f },
                { "_mantleMaxHeight", 1.6f },
                { "_mantleSeconds", 0.4f },
                { "_standHeight", 1.8f },
                { "_crouchHeight", 0.9f },
            });
            _ground = new FlatGroundCollision(0f);
        }

        [TearDown]
        public void TearDown() => Object.DestroyImmediate(_movement);

        private static MoveCommand Cmd(
            int tick, float x = 0f, float y = 0f, MoveFlags flags = MoveFlags.None) =>
            new MoveCommand(tick, new Vector2(x, y), Vector2.zero, flags, Tick);

        private MotorState Run(
            MotorState state, int ticks, float x, float y, MoveFlags flags = MoveFlags.None,
            IMotorCollision collision = null)
        {
            collision ??= _ground;
            for (int i = 0; i < ticks; i++)
            {
                state = CharacterMotor.Step(state, Cmd(i, x, y, flags), _movement, collision, out _);
            }

            return state;
        }

        [Test]
        public void WalkingReachesTheBlueprintSpeed()
        {
            MotorState state = Run(MotorState.AtRest(Vector3.zero), 60, 0f, 1f);
            float speed = new Vector3(state.Velocity.x, 0f, state.Velocity.z).magnitude;
            Assert.AreEqual(4.6f, speed, 0.01f);
        }

        [Test]
        public void SprintingReachesTheSprintSpeed()
        {
            MotorState state = Run(MotorState.AtRest(Vector3.zero), 60, 0f, 1f, MoveFlags.Sprint);
            float speed = new Vector3(state.Velocity.x, 0f, state.Velocity.z).magnitude;
            Assert.AreEqual(7.4f, speed, 0.01f);
        }

        [Test]
        public void SprintingSidewaysDoesNotApply()
        {
            // Sprint is forward intent only, so retreating is not as fast as
            // advancing. Strafing at full input should cap at walk speed.
            MotorState state = Run(MotorState.AtRest(Vector3.zero), 60, 1f, 0f, MoveFlags.Sprint);
            float speed = new Vector3(state.Velocity.x, 0f, state.Velocity.z).magnitude;
            Assert.AreEqual(4.6f, speed, 0.01f);
        }

        [Test]
        public void CrouchingUsesTheCrouchSpeed()
        {
            MotorState state = Run(MotorState.AtRest(Vector3.zero), 60, 0f, 1f, MoveFlags.Crouch);
            float speed = new Vector3(state.Velocity.x, 0f, state.Velocity.z).magnitude;
            Assert.AreEqual(2.3f, speed, 0.01f);
        }

        [Test]
        public void MoveInputIsClampedSoDiagonalsAreNotFaster()
        {
            // A client sending (1,1) must not move at sqrt(2) times walk speed.
            MotorState state = Run(MotorState.AtRest(Vector3.zero), 60, 1f, 1f);
            float speed = new Vector3(state.Velocity.x, 0f, state.Velocity.z).magnitude;
            Assert.LessOrEqual(speed, 4.6f + 0.01f);
        }

        [Test]
        public void JumpApexMatchesTheBlueprintHeight()
        {
            MotorState state = MotorState.AtRest(Vector3.zero);
            state = CharacterMotor.Step(
                state, Cmd(0, flags: MoveFlags.Jump), _movement, _ground, out MotorStepResult jump);
            Assert.IsTrue(jump.Jumped);

            float apex = state.Position.y;
            for (int i = 1; i < 120; i++)
            {
                state = CharacterMotor.Step(state, Cmd(i), _movement, _ground, out _);
                apex = Mathf.Max(apex, state.Position.y);
                if (state.Grounded)
                {
                    break;
                }
            }

            // Tight on purpose. The motor uses JumpVelocityForTick, which
            // corrects for discrete integration, so the sampled apex lands
            // within a millimetre of the authored height at 30 Hz. A loose
            // tolerance here would have hidden the 10% undershoot the naive
            // sqrt(2gh) produces.
            Assert.AreEqual(1.1f, apex, 0.02f, $"Jump apex was {apex:F3} m");
        }

        [Test]
        public void CharacterReturnsToTheGroundAfterAJump()
        {
            MotorState state = MotorState.AtRest(Vector3.zero);
            state = CharacterMotor.Step(
                state, Cmd(0, flags: MoveFlags.Jump), _movement, _ground, out _);
            state = Run(state, 120, 0f, 0f);

            Assert.IsTrue(state.Grounded);
            Assert.AreEqual(0f, state.Position.y, 0.001f);
        }

        [Test]
        public void CannotJumpWhileAirborne()
        {
            MotorState state = MotorState.AtRest(Vector3.zero);
            state = CharacterMotor.Step(
                state, Cmd(0, flags: MoveFlags.Jump), _movement, _ground, out _);

            state = CharacterMotor.Step(
                state, Cmd(1, flags: MoveFlags.Jump), _movement, _ground,
                out MotorStepResult second);

            Assert.IsFalse(second.Jumped, "Double jump is not a movement verb in this game");
        }

        [Test]
        public void TerminalVelocityIsNeverExceeded()
        {
            MotorState state = MotorState.AtRest(new Vector3(0f, 500f, 0f));
            state.Grounded = false;

            var sky = new FlatGroundCollision(-10000f);
            for (int i = 0; i < 600; i++)
            {
                state = CharacterMotor.Step(state, Cmd(i), _movement, sky, out _);
                Assert.GreaterOrEqual(state.Velocity.y, -55f - 0.001f,
                    $"Exceeded terminal velocity on tick {i}");
            }

            // And it should actually get there, or the test proves nothing.
            Assert.AreEqual(-55f, state.Velocity.y, 0.01f);
        }

        [Test]
        public void FallDamageIsZeroBelowTheThreshold()
        {
            float damage = DropFrom(3.0f);
            Assert.AreEqual(0f, damage, 0.001f);
        }

        [Test]
        public void FallDamageScalesWithHeightAboveTheThreshold()
        {
            // 13.5 m drop = 10 m over the 3.5 m threshold = 100 HP.
            float damage = DropFrom(13.5f);
            Assert.AreEqual(100f, damage, 3f, $"Expected ~100 HP, got {damage:F1}");
        }

        [Test]
        public void LandingOnAHigherSurfaceCancelsTheAccumulatedFall()
        {
            // Building a ramp under yourself mid-fall must be a reliable save:
            // PeakY resets on every grounded tick, including on a build piece.
            MotorState state = MotorState.AtRest(new Vector3(0f, 40f, 0f));
            state.Grounded = false;

            var lowGround = new FlatGroundCollision(0f);
            for (int i = 0; i < 20; i++)
            {
                state = CharacterMotor.Step(state, Cmd(i), _movement, lowGround, out _);
            }

            Assert.IsFalse(state.Grounded, "Should still be falling");

            // A floor appears just beneath the player.
            var rescue = new FlatGroundCollision(state.Position.y - 0.5f);
            state = CharacterMotor.Step(state, Cmd(100), _movement, rescue, out MotorStepResult caught);
            Assert.IsTrue(caught.Landed);

            // Now step off that floor: the new fall is measured from here.
            state.Grounded = false;
            state = CharacterMotor.Step(state, Cmd(101), _movement, lowGround, out MotorStepResult after);
            Assert.AreEqual(0f, after.FallDamage, 0.001f,
                "Fall damage carried over across a landing");
        }

        [Test]
        public void PitchIsClampedRatherThanWrapped()
        {
            MotorState state = MotorState.AtRest(Vector3.zero);
            for (int i = 0; i < 100; i++)
            {
                var look = new MoveCommand(
                    i, Vector2.zero, new Vector2(0f, 10f), MoveFlags.None, Tick);
                state = CharacterMotor.Step(state, look, _movement, _ground, out _);
            }

            Assert.AreEqual(89f, state.Pitch, 0.001f, "Over-pitching should stop at vertical");
        }

        [Test]
        public void YawWrapsWithoutGrowingUnbounded()
        {
            MotorState state = MotorState.AtRest(Vector3.zero);
            for (int i = 0; i < 100; i++)
            {
                var look = new MoveCommand(
                    i, Vector2.zero, new Vector2(20f, 0f), MoveFlags.None, Tick);
                state = CharacterMotor.Step(state, look, _movement, _ground, out _);
            }

            Assert.GreaterOrEqual(state.Yaw, 0f);
            Assert.Less(state.Yaw, 360f);
        }

        [Test]
        public void YawRotateMovesForwardIntoWorldSpace()
        {
            Vector3 east = CharacterMotor.YawRotate(Vector3.forward, 90f);
            Assert.AreEqual(1f, east.x, 0.001f);
            Assert.AreEqual(0f, east.z, 0.001f);
        }

        [Test]
        public void MovementIsBitIdenticalAcrossReplays()
        {
            // The test that protects M4. Reconciliation replays a stored command
            // sequence and must reproduce the original result exactly; a single
            // frame-rate-dependent or random term makes it drift, and the
            // symptom is permanent jitter nobody can trace.
            var commands = new List<MoveCommand>();
            var rng = new Tonight.Core.DeterministicRng(4242);
            for (int i = 0; i < 1000; i++)
            {
                var flags = MoveFlags.None;
                if (rng.NextFloat() < 0.05f) flags |= MoveFlags.Jump;
                if (rng.NextFloat() < 0.30f) flags |= MoveFlags.Sprint;
                if (rng.NextFloat() < 0.10f) flags |= MoveFlags.Crouch;

                commands.Add(new MoveCommand(
                    i,
                    new Vector2(rng.Range(-1f, 1f), rng.Range(-1f, 1f)),
                    new Vector2(rng.Range(-4f, 4f), rng.Range(-2f, 2f)),
                    flags,
                    Tick));
            }

            MotorState first = MotorState.AtRest(Vector3.zero);
            MotorState second = MotorState.AtRest(Vector3.zero);

            foreach (MoveCommand command in commands)
            {
                first = CharacterMotor.Step(first, command, _movement, _ground, out _);
            }

            foreach (MoveCommand command in commands)
            {
                second = CharacterMotor.Step(second, command, _movement, _ground, out _);
            }

            Assert.AreEqual(first.Position.x, second.Position.x, 0f, "X drifted");
            Assert.AreEqual(first.Position.y, second.Position.y, 0f, "Y drifted");
            Assert.AreEqual(first.Position.z, second.Position.z, 0f, "Z drifted");
            Assert.AreEqual(first.Yaw, second.Yaw, 0f, "Yaw drifted");
            Assert.AreEqual(first.Pitch, second.Pitch, 0f, "Pitch drifted");
        }

        [Test]
        public void CommandPlausibilityRejectsAnInflatedTimestep()
        {
            // A client claiming a huge dt would simulate extra movement in one
            // tick. The server checks this before simulating.
            var honest = new MoveCommand(0, Vector2.up, Vector2.zero, MoveFlags.None, Tick);
            var cheating = new MoveCommand(0, Vector2.up, Vector2.zero, MoveFlags.None, Tick * 10f);

            Assert.IsTrue(honest.IsPlausible(Tick));
            Assert.IsFalse(cheating.IsPlausible(Tick));
        }

        private float DropFrom(float height)
        {
            MotorState state = MotorState.AtRest(new Vector3(0f, height, 0f));
            state.Grounded = false;
            state.PeakY = height;

            for (int i = 0; i < 300; i++)
            {
                state = CharacterMotor.Step(state, Cmd(i), _movement, _ground, out MotorStepResult result);
                if (result.Landed)
                {
                    return result.FallDamage;
                }
            }

            Assert.Fail($"Never landed from {height} m");
            return 0f;
        }
    }
}
