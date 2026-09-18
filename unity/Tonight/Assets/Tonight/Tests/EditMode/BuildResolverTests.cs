using System.Collections.Generic;
using NUnit.Framework;
using Tonight.Blueprints.Building;
using Tonight.Core;
using Tonight.Gameplay.Building;
using UnityEngine;

namespace Tonight.Tests.EditMode
{
    public sealed class BuildPlacementResolverTests
    {
        private BuildPieceBlueprint _wall;
        private BuildPieceBlueprint _floor;
        private BuildPieceBlueprint _ramp;
        private BuildStructure _structure;

        [SetUp]
        public void SetUp()
        {
            _wall = Piece(BuildPlacementKind.Wall, SlotOccupancy.Face);
            _floor = Piece(BuildPlacementKind.Floor, SlotOccupancy.Face);
            _ramp = Piece(BuildPlacementKind.Ramp, SlotOccupancy.Interior);
            _structure = new BuildStructure { TouchesGround = cell => cell.Y == 0 };
        }

        [TearDown]
        public void TearDown()
        {
            Object.DestroyImmediate(_wall);
            Object.DestroyImmediate(_floor);
            Object.DestroyImmediate(_ramp);
        }

        private static BuildPieceBlueprint Piece(BuildPlacementKind kind, SlotOccupancy occupancy) =>
            TestBlueprints.Create<BuildPieceBlueprint>(new Dictionary<string, object>
            {
                { "_placement", kind },
                { "_occupancy", occupancy },
            });

        [Test]
        public void AimingAtOpenAirStillResolvesATarget()
        {
            // Building in open air is normal, so "the ray hit nothing" must not
            // be a failure. A negative distance signals no hit.
            PlacementTarget target = BuildPlacementResolver.Resolve(
                new Vector3(2f, 2f, 2f), Vector3.forward, -1f, _wall, _structure, 0f);

            Assert.IsTrue(target.Found);
        }

        [Test]
        public void TargetIsCappedAtMaxPlaceDistance()
        {
            // A surface 100 m away must not put the piece 100 m away.
            PlacementTarget target = BuildPlacementResolver.Resolve(
                Vector3.zero, Vector3.forward, 100f, _wall, _structure, 0f);

            Vector3 anchor = BuildGrid.SlotAnchor(target.Cell, target.Slot);
            Assert.LessOrEqual(anchor.z, BuildGrid.MaxPlaceDistance + BuildGrid.CellSize);
        }

        [Test]
        public void ACloseSurfaceIsUsedInsteadOfTheMaxDistance()
        {
            PlacementTarget near = BuildPlacementResolver.Resolve(
                Vector3.zero, Vector3.forward, 2f, _wall, _structure, 0f);
            PlacementTarget far = BuildPlacementResolver.Resolve(
                Vector3.zero, Vector3.forward, -1f, _wall, _structure, 0f);

            Assert.AreNotEqual(far.Cell, near.Cell);
        }

        [Test]
        public void WallPicksTheFaceOpposingTheView()
        {
            // Looking north (+Z), the player meets the SOUTH face of the cell
            // ahead of them -- the face turned toward the viewer.
            PlacementTarget north = BuildPlacementResolver.Resolve(
                Vector3.zero, Vector3.forward, -1f, _wall, _structure, 0f);
            Assert.AreEqual(BuildSlot.SouthFace, north.Slot);

            PlacementTarget south = BuildPlacementResolver.Resolve(
                Vector3.zero, Vector3.back, -1f, _wall, _structure, 0f);
            Assert.AreEqual(BuildSlot.NorthFace, south.Slot);

            PlacementTarget east = BuildPlacementResolver.Resolve(
                Vector3.zero, Vector3.right, -1f, _wall, _structure, 0f);
            Assert.AreEqual(BuildSlot.WestFace, east.Slot);
        }

        [Test]
        public void RampAlwaysTakesTheInteriorSlot()
        {
            foreach (Vector3 direction in new[]
                     { Vector3.forward, Vector3.back, Vector3.left, Vector3.right })
            {
                PlacementTarget target = BuildPlacementResolver.Resolve(
                    Vector3.zero, direction, -1f, _ramp, _structure, 0f);
                Assert.AreEqual(BuildSlot.Interior, target.Slot);
            }
        }

        [Test]
        public void FloorUsesThePlayersOwnHeightNotTheirPitch()
        {
            // Building a floor under yourself is the common case, and it must
            // not depend on where the player happens to be looking.
            var steeplyUp = new Vector3(0f, 0.9f, 0.4f).normalized;
            var steeplyDown = new Vector3(0f, -0.9f, 0.4f).normalized;

            PlacementTarget up = BuildPlacementResolver.Resolve(
                new Vector3(2f, 6f, 2f), steeplyUp, -1f, _floor, _structure, 6f);
            PlacementTarget down = BuildPlacementResolver.Resolve(
                new Vector3(2f, 6f, 2f), steeplyDown, -1f, _floor, _structure, 6f);

            Assert.AreEqual(up.Cell.Y, down.Cell.Y,
                "Floor height should come from the player's feet, not their pitch");
            Assert.AreEqual(BuildSlot.FloorFace, up.Slot);
        }

        [Test]
        public void AnOccupiedSlotStepsForwardRatherThanFailing()
        {
            // Building against an existing wall should feel right, not silently
            // do nothing.
            PlacementTarget first = BuildPlacementResolver.Resolve(
                Vector3.zero, Vector3.forward, -1f, _wall, _structure, 0f);

            _structure.TryAdd(new PlacedPiece
            {
                Cell = first.Cell,
                Slot = first.Slot,
                Piece = _wall,
            });

            PlacementTarget second = BuildPlacementResolver.Resolve(
                Vector3.zero, Vector3.forward, -1f, _wall, _structure, 0f);

            Assert.IsTrue(second.Found);
            Assert.AreNotEqual(first.Cell, second.Cell);
        }

        [Test]
        public void GivesUpAfterTheStepLimitRatherThanPlacingSomewhereSurprising()
        {
            // Walking further than two cells would put the piece somewhere the
            // player was not looking, which pillar 1 forbids.
            var direction = Vector3.forward;
            PlacementTarget target = BuildPlacementResolver.Resolve(
                Vector3.zero, direction, -1f, _wall, _structure, 0f);

            GridCell cell = target.Cell;
            for (int step = 0; step <= BuildPlacementResolver.MaxOccupancySteps; step++)
            {
                _structure.TryAdd(new PlacedPiece
                {
                    Cell = cell,
                    // The resolved slot, not a hardcoded one: the resolver picks
                    // the face turned toward the viewer, and blocking a
                    // different face would prove nothing.
                    Slot = target.Slot,
                    Piece = _wall,
                });
                cell = BuildPlacementResolver.StepCell(
                    cell, direction, BuildPlacementKind.Wall);
            }

            PlacementTarget blocked = BuildPlacementResolver.Resolve(
                Vector3.zero, direction, -1f, _wall, _structure, 0f);

            Assert.IsFalse(blocked.Found);
        }

        [Test]
        public void StepCellMovesAlongTheDominantAxis()
        {
            var origin = new GridCell(0, 0, 0);

            // A mostly-east view steps east, not diagonally.
            GridCell east = BuildPlacementResolver.StepCell(
                origin, new Vector3(0.9f, 0f, 0.3f), BuildPlacementKind.Wall);
            Assert.AreEqual(new GridCell(1, 0, 0), east);

            GridCell north = BuildPlacementResolver.StepCell(
                origin, new Vector3(0.3f, 0f, 0.9f), BuildPlacementKind.Wall);
            Assert.AreEqual(new GridCell(0, 0, 1), north);
        }

        [Test]
        public void FloorStepsVerticallyNotHorizontally()
        {
            var origin = new GridCell(0, 0, 0);
            GridCell up = BuildPlacementResolver.StepCell(
                origin, new Vector3(0.9f, 0.2f, 0f), BuildPlacementKind.Floor);
            Assert.AreEqual(new GridCell(0, 1, 0), up);
        }

        [Test]
        public void PreviewAndPlacementShareOneTransform()
        {
            // Pillar 1: the ghost must never disagree with where the piece
            // lands. Both go through GetTransform for exactly this reason.
            PlacementTarget target = BuildPlacementResolver.Resolve(
                Vector3.zero, Vector3.forward, -1f, _wall, _structure, 0f);

            BuildPlacementResolver.GetTransform(
                target, out Vector3 position, out Quaternion rotation);

            Assert.AreEqual(BuildGrid.SlotAnchor(target.Cell, target.Slot), position);
            Assert.AreEqual(BuildGrid.SlotRotation(target.Slot), rotation);
        }

        [Test]
        public void ResolutionIsStableForTheSameInput()
        {
            // A player must be able to predict where a piece lands without
            // looking at the preview, which requires the answer not to wobble.
            for (int i = 0; i < 50; i++)
            {
                PlacementTarget target = BuildPlacementResolver.Resolve(
                    new Vector3(1.3f, 2.7f, -4.1f),
                    new Vector3(0.4f, -0.2f, 0.9f).normalized,
                    7.5f, _wall, _structure, 2.7f);

                Assert.IsTrue(target.Found);
                Assert.AreEqual(new GridCell(1, 0, 0), target.Cell);
                Assert.AreEqual(BuildSlot.SouthFace, target.Slot);
            }
        }

        [Test]
        public void ANullPieceResolvesToNothingRatherThanThrowing()
        {
            PlacementTarget target = BuildPlacementResolver.Resolve(
                Vector3.zero, Vector3.forward, -1f, null, _structure, 0f);
            Assert.IsFalse(target.Found);
        }
    }

    public sealed class BuildEditResolverTests
    {
        private static readonly bool[] Doorway =
            { true, true, true, true, false, true, true, false, true };

        [Test]
        public void SubCellIndexZeroIsTopLeft()
        {
            // Mask index 0 is the TOP-left, matching how a designer reads the
            // grid in the Inspector. Inverting this produces upside-down
            // doorways that look almost right.
            Assert.AreEqual(0, BuildEditResolver.SubCellIndex(new Vector2(0.1f, 0.9f)));
            Assert.AreEqual(2, BuildEditResolver.SubCellIndex(new Vector2(0.9f, 0.9f)));
            Assert.AreEqual(6, BuildEditResolver.SubCellIndex(new Vector2(0.1f, 0.1f)));
            Assert.AreEqual(8, BuildEditResolver.SubCellIndex(new Vector2(0.9f, 0.1f)));
            Assert.AreEqual(4, BuildEditResolver.SubCellIndex(new Vector2(0.5f, 0.5f)));
        }

        [Test]
        public void SubCellIndexClampsRatherThanGoingOutOfRange()
        {
            foreach (Vector2 point in new[]
                     {
                         new Vector2(-5f, 0.5f), new Vector2(5f, 0.5f),
                         new Vector2(0.5f, -5f), new Vector2(0.5f, 5f),
                     })
            {
                int index = BuildEditResolver.SubCellIndex(point);
                Assert.GreaterOrEqual(index, 0);
                Assert.LessOrEqual(index, 8);
            }
        }

        [Test]
        public void ToggleFlipsOneSubCell()
        {
            int mask = BuildEditResolver.SolidMask;
            Assert.IsTrue(BuildEditResolver.IsSet(mask, 4));

            mask = BuildEditResolver.Toggle(mask, 4);
            Assert.IsFalse(BuildEditResolver.IsSet(mask, 4));

            mask = BuildEditResolver.Toggle(mask, 4);
            Assert.IsTrue(BuildEditResolver.IsSet(mask, 4));
        }

        [Test]
        public void ToggleIgnoresAnOutOfRangeIndex()
        {
            int mask = BuildEditResolver.SolidMask;
            Assert.AreEqual(mask, BuildEditResolver.Toggle(mask, -1));
            Assert.AreEqual(mask, BuildEditResolver.Toggle(mask, 9));
        }

        [Test]
        public void DoorwayMaskPacksToTheSameKeyOnBothSides()
        {
            // The Python generator and the Blueprint author the same shape
            // independently, so the packing must agree or the mesh and the mask
            // silently describe different holes.
            int packed = EditVariant.PackMask(Doorway);
            int built = BuildEditResolver.Toggle(
                BuildEditResolver.Toggle(BuildEditResolver.SolidMask, 4), 7);
            Assert.AreEqual(packed, built);
        }

        [Test]
        public void SolidMaskResolvesToNoVariant()
        {
            Assert.IsNull(BuildEditResolver.Resolve(null, BuildEditResolver.SolidMask));
        }

        [Test]
        public void HealthScaleOfAnUneditedPieceIsOne()
        {
            Assert.AreEqual(1f, BuildEditResolver.HealthScaleFor(null, BuildEditResolver.SolidMask));
        }
    }
}
