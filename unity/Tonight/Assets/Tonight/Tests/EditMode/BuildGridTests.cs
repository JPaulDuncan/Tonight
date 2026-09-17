using NUnit.Framework;
using Tonight.Core;
using UnityEngine;

namespace Tonight.Tests.EditMode
{
    public sealed class BuildGridTests
    {
        [Test]
        public void CellToWorldToCell_RoundTripsAcrossMapRange()
        {
            // Covers negatives explicitly: FloorToInt versus truncation is the
            // difference between a uniform grid and one cell straddling the
            // origin at twice the width of every other cell.
            for (int x = -400; x <= 400; x += 7)
            {
                for (int z = -400; z <= 400; z += 11)
                {
                    var cell = new GridCell(x, -3, z);
                    Vector3 world = BuildGrid.CellCentre(cell);
                    Assert.AreEqual(cell, BuildGrid.WorldToCell(world),
                        $"Round trip failed for {cell}");
                }
            }
        }

        [Test]
        public void WorldToCell_IsUniformAcrossTheOrigin()
        {
            Assert.AreEqual(new GridCell(0, 0, 0), BuildGrid.WorldToCell(new Vector3(0.1f, 0.1f, 0.1f)));
            Assert.AreEqual(new GridCell(-1, -1, -1), BuildGrid.WorldToCell(new Vector3(-0.1f, -0.1f, -0.1f)));
            Assert.AreEqual(new GridCell(-1, 0, 0), BuildGrid.WorldToCell(new Vector3(-3.9f, 0f, 0f)));
            Assert.AreEqual(new GridCell(-2, 0, 0), BuildGrid.WorldToCell(new Vector3(-4.1f, 0f, 0f)));
        }

        [Test]
        public void Canonicalise_ResolvesASharedFaceToOneKey()
        {
            // A wall on the north face of cell C is physically the same wall as
            // one on the south face of C's north neighbour. Without this, two
            // players could each place a wall and produce coincident geometry.
            var cell = new GridCell(5, 0, 5);
            BuildSlot slot = BuildSlot.NorthFace;
            BuildGrid.Canonicalise(ref cell, ref slot);

            var otherCell = new GridCell(5, 0, 6);
            BuildSlot otherSlot = BuildSlot.SouthFace;
            BuildGrid.Canonicalise(ref otherCell, ref otherSlot);

            Assert.AreEqual(cell, otherCell);
            Assert.AreEqual(slot, otherSlot);
        }

        [Test]
        public void FaceFacing_PicksTheFaceOpposingTheView()
        {
            Assert.AreEqual(BuildSlot.NorthFace, BuildSlotExtensions.FaceFacing(new Vector3(0f, 0f, -1f)));
            Assert.AreEqual(BuildSlot.SouthFace, BuildSlotExtensions.FaceFacing(new Vector3(0f, 0f, 1f)));
            Assert.AreEqual(BuildSlot.EastFace, BuildSlotExtensions.FaceFacing(new Vector3(-1f, 0f, 0f)));
            Assert.AreEqual(BuildSlot.WestFace, BuildSlotExtensions.FaceFacing(new Vector3(1f, 0f, 0f)));
        }

        [Test]
        public void FaceFacing_IgnoresPitch()
        {
            // A player looking down at a wall still gets the wall they face.
            BuildSlot flat = BuildSlotExtensions.FaceFacing(new Vector3(0f, 0f, -1f));
            BuildSlot steep = BuildSlotExtensions.FaceFacing(new Vector3(0f, -0.9f, -0.4f));
            Assert.AreEqual(flat, steep);
        }

        [Test]
        public void MapExtents_FitTheWireFormat()
        {
            // The 1400 m map must sit comfortably inside the int16 cell range
            // the structure channel uses (ADR-0002).
            var corner = BuildGrid.WorldToCell(new Vector3(1400f, 500f, 1400f));
            Assert.IsTrue(corner.IsWireRepresentable);
        }
    }
}
