using System.Collections.Generic;
using NUnit.Framework;
using Tonight.Core;
using Tonight.Gameplay.Building;

namespace Tonight.Tests.EditMode
{
    public sealed class BuildStructureTests
    {
        private BuildStructure _structure;

        [SetUp]
        public void SetUp()
        {
            _structure = new BuildStructure
            {
                // Terrain is the y == 0 plane for these tests.
                TouchesGround = cell => cell.Y == 0,
            };
        }

        private static PlacedPiece PieceAt(int x, int y, int z, BuildSlot slot) => new PlacedPiece
        {
            Cell = new GridCell(x, y, z),
            Slot = slot,
            OwnerId = 1,
            Health = 90f,
        };

        [Test]
        public void OneSlotHoldsOnePiece()
        {
            Assert.IsTrue(_structure.TryAdd(PieceAt(0, 0, 0, BuildSlot.NorthFace)));
            Assert.IsFalse(_structure.TryAdd(PieceAt(0, 0, 0, BuildSlot.NorthFace)));
            Assert.AreEqual(1, _structure.Count);
        }

        [Test]
        public void ACellHoldsFourWallsAFloorAndOneInterior()
        {
            // Exactly a 1x1 box with a ramp inside it.
            Assert.IsTrue(_structure.TryAdd(PieceAt(0, 0, 0, BuildSlot.NorthFace)));
            Assert.IsTrue(_structure.TryAdd(PieceAt(0, 0, 0, BuildSlot.EastFace)));
            Assert.IsTrue(_structure.TryAdd(PieceAt(0, 0, 0, BuildSlot.SouthFace)));
            Assert.IsTrue(_structure.TryAdd(PieceAt(0, 0, 0, BuildSlot.WestFace)));
            Assert.IsTrue(_structure.TryAdd(PieceAt(0, 0, 0, BuildSlot.FloorFace)));
            Assert.IsTrue(_structure.TryAdd(PieceAt(0, 0, 0, BuildSlot.Interior)));
            Assert.AreEqual(6, _structure.Count);
        }

        [Test]
        public void SharedFaceIsOnePieceFromEitherSide()
        {
            Assert.IsTrue(_structure.TryAdd(PieceAt(0, 0, 0, BuildSlot.NorthFace)));

            // The same physical wall, named from the neighbouring cell.
            Assert.IsTrue(_structure.IsOccupied(new GridCell(0, 0, 1), BuildSlot.SouthFace));
            Assert.IsFalse(_structure.TryAdd(PieceAt(0, 0, 1, BuildSlot.SouthFace)));
            Assert.AreEqual(1, _structure.Count);
        }

        [Test]
        public void GroundPieceIsSupportedAtDistanceZero()
        {
            _structure.TryAdd(PieceAt(0, 0, 0, BuildSlot.Interior));
            Assert.IsTrue(_structure.TryGet(new GridCell(0, 0, 0), BuildSlot.Interior, out PlacedPiece piece));
            Assert.AreEqual(0, piece.SupportDistance);
        }

        [Test]
        public void SupportDistanceGrowsWithHeight()
        {
            for (int y = 0; y < 5; y++)
            {
                Assert.IsTrue(_structure.TryAdd(PieceAt(0, y, 0, BuildSlot.Interior)),
                    $"Failed to add piece at height {y}");
            }

            _structure.RecomputeSupport();

            for (int y = 0; y < 5; y++)
            {
                Assert.IsTrue(_structure.TryGet(new GridCell(0, y, 0), BuildSlot.Interior, out PlacedPiece piece));
                Assert.AreEqual(y, piece.SupportDistance, $"Wrong support distance at height {y}");
            }
        }

        [Test]
        public void DestroyingTheBaseCollapsesEverythingAbove()
        {
            for (int y = 0; y < 5; y++)
            {
                _structure.TryAdd(PieceAt(0, y, 0, BuildSlot.Interior));
            }

            var collapsed = new List<BuildStructure.PieceKey>();
            Assert.IsTrue(_structure.TryRemove(new GridCell(0, 0, 0), BuildSlot.Interior, collapsed));

            // Four pieces lose their path to ground: this is what makes shooting
            // the bottom of a tower worthwhile.
            Assert.AreEqual(4, collapsed.Count);
        }

        [Test]
        public void DestroyingTheTopCollapsesNothing()
        {
            for (int y = 0; y < 5; y++)
            {
                _structure.TryAdd(PieceAt(0, y, 0, BuildSlot.Interior));
            }

            var collapsed = new List<BuildStructure.PieceKey>();
            Assert.IsTrue(_structure.TryRemove(new GridCell(0, 4, 0), BuildSlot.Interior, collapsed));
            Assert.AreEqual(0, collapsed.Count);
        }

        [Test]
        public void CollapseDoesNotTakeAnAdjacentIndependentTower()
        {
            for (int y = 0; y < 4; y++)
            {
                _structure.TryAdd(PieceAt(0, y, 0, BuildSlot.Interior));
                // Far enough away that the neighbour relation does not connect them.
                _structure.TryAdd(PieceAt(10, y, 10, BuildSlot.Interior));
            }

            var collapsed = new List<BuildStructure.PieceKey>();
            _structure.TryRemove(new GridCell(0, 0, 0), BuildSlot.Interior, collapsed);

            foreach (BuildStructure.PieceKey key in collapsed)
            {
                Assert.AreEqual(0, key.Cell.X, "The independent tower should not have collapsed");
            }

            Assert.AreEqual(3, collapsed.Count);
        }

        [Test]
        public void PlacingBeneathAnOrphanRestoresItsSupport()
        {
            // An orphaned stack, floating with no path to ground.
            for (int y = 2; y < 5; y++)
            {
                _structure.TryAdd(PieceAt(0, y, 0, BuildSlot.Interior));
            }

            _structure.RecomputeSupport();
            Assert.IsTrue(_structure.TryGet(new GridCell(0, 4, 0), BuildSlot.Interior, out PlacedPiece before));
            Assert.AreEqual(BuildStructure.Unsupported, before.SupportDistance);

            // Building the missing legs should rescue the whole stack.
            _structure.TryAdd(PieceAt(0, 0, 0, BuildSlot.Interior));
            _structure.TryAdd(PieceAt(0, 1, 0, BuildSlot.Interior));

            Assert.IsTrue(_structure.TryGet(new GridCell(0, 4, 0), BuildSlot.Interior, out PlacedPiece after));
            Assert.AreNotEqual(BuildStructure.Unsupported, after.SupportDistance);
            Assert.AreEqual(4, after.SupportDistance);
        }

        [Test]
        public void WouldBeSupported_RejectsPlacementInMidAir()
        {
            Assert.IsFalse(_structure.WouldBeSupported(new GridCell(0, 6, 0), BuildSlot.Interior));
            Assert.IsTrue(_structure.WouldBeSupported(new GridCell(0, 0, 0), BuildSlot.Interior));
        }
    }
}
