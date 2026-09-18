using System.Collections.Generic;
using NUnit.Framework;
using Tonight.Blueprints.Building;
using Tonight.Core;
using Tonight.Gameplay.Building;
using Tonight.Gameplay.Commands;
using Tonight.Gameplay.Inventory;
using UnityEngine;

namespace Tonight.Tests.EditMode
{
    public sealed class BuildWorldTests
    {
        private const int TickRate = 30;
        private const int PlayerId = 1;

        private BuildMaterialBlueprint _wood;
        private BuildPieceBlueprint _wall;
        private BuildWorld _world;

        [SetUp]
        public void SetUp()
        {
            _wood = TestBlueprints.Create<BuildMaterialBlueprint>(new Dictionary<string, object>
            {
                { "_materialKind", BuildMaterialKind.Wood },
                { "_buildHealth", 90f },
                { "_fullHealth", 150f },
                { "_buildTimeSeconds", 3f },
                { "_costPerPiece", 10 },
                { "_maxCarried", 500 },
            });

            _wall = TestBlueprints.Create<BuildPieceBlueprint>(new Dictionary<string, object>
            {
                { "_placement", BuildPlacementKind.Wall },
                { "_occupancy", SlotOccupancy.Face },
                { "_costOverride", -1 },
            });

            _world = new BuildWorld(TickRate)
            {
                TouchesGround = cell => cell.Y == 0,
            };

            var wallet = new MaterialWallet();
            wallet.Add(_wood, 500);
            _world.SetWallet(PlayerId, wallet);
            _world.SetPlayerPosition(PlayerId, BuildGrid.CellCentre(new GridCell(0, 0, 0)));
        }

        [TearDown]
        public void TearDown()
        {
            Object.DestroyImmediate(_wall);
            Object.DestroyImmediate(_wood);
        }

        private PlaceBuildCommand Place(int x, int y, int z, BuildSlot slot, int tick = 0) =>
            new PlaceBuildCommand(PlayerId, tick, new GridCell(x, y, z), slot, _wall, _wood);

        [Test]
        public void PlacingDeductsExactlyTheCost()
        {
            Assert.AreEqual(PlacementRejection.None,
                _world.TryPlace(Place(0, 0, 0, BuildSlot.NorthFace), 0, false));
            Assert.AreEqual(490, _world.GetWallet(PlayerId).Wood);
        }

        [Test]
        public void AnUnaffordablePlacementIsRejectedAndCostsNothing()
        {
            var broke = new MaterialWallet();
            broke.Add(_wood, 5);
            _world.SetWallet(PlayerId, broke);

            Assert.AreEqual(PlacementRejection.Unaffordable,
                _world.TryPlace(Place(0, 0, 0, BuildSlot.NorthFace), 0, false));
            Assert.AreEqual(5, _world.GetWallet(PlayerId).Wood);
            Assert.AreEqual(0, _world.Structure.Count);
        }

        [Test]
        public void PlacingInMidAirIsRejectedAsUnsupported()
        {
            _world.SetPlayerPosition(PlayerId, BuildGrid.CellCentre(new GridCell(0, 5, 0)));
            Assert.AreEqual(PlacementRejection.Unsupported,
                _world.TryPlace(Place(0, 5, 0, BuildSlot.NorthFace), 0, false));
        }

        [Test]
        public void PlacingTooFarAwayIsRejected()
        {
            // The cell is grounded and free, so range is the only thing failing.
            Assert.AreEqual(PlacementRejection.OutOfRange,
                _world.TryPlace(Place(20, 0, 20, BuildSlot.NorthFace), 0, false));
        }

        [Test]
        public void RollbackRefundsExactlyWhatWasDeducted()
        {
            PlaceBuildCommand command = Place(0, 0, 0, BuildSlot.NorthFace);
            _world.TryPlace(command, 0, false);
            Assert.AreEqual(490, _world.GetWallet(PlayerId).Wood);

            _world.RollbackPrediction(command);

            Assert.AreEqual(500, _world.GetWallet(PlayerId).Wood);
            Assert.AreEqual(0, _world.Structure.Count);
        }

        /// <summary>
        /// Twelve distinct slots, all within the 10 m build range of a player
        /// standing in cell (0,0,0), so rate-limit tests fail on the rate limit
        /// rather than on range.
        /// </summary>
        private static readonly (int X, int Y, int Z, BuildSlot Slot)[] NearbySlots =
        {
            (0, 0, 0, BuildSlot.NorthFace), (0, 0, 0, BuildSlot.EastFace),
            (0, 0, 0, BuildSlot.SouthFace), (0, 0, 0, BuildSlot.WestFace),
            (0, 0, 0, BuildSlot.FloorFace), (0, 0, 0, BuildSlot.Interior),
            (1, 0, 0, BuildSlot.NorthFace), (1, 0, 0, BuildSlot.EastFace),
            (1, 0, 0, BuildSlot.FloorFace), (1, 0, 0, BuildSlot.Interior),
            (0, 0, 1, BuildSlot.EastFace), (0, 0, 1, BuildSlot.Interior),
        };

        private void FillPlacementBudget()
        {
            Assert.AreEqual(PlaceBuildCommand.MaxPlacementsPerSecond, NearbySlots.Length,
                "The fixture must place exactly a full second's budget");

            for (int i = 0; i < NearbySlots.Length; i++)
            {
                (int x, int y, int z, BuildSlot slot) = NearbySlots[i];
                Assert.AreEqual(PlacementRejection.None,
                    _world.TryPlace(Place(x, y, z, slot, i), i, true),
                    $"Fixture placement {i} at ({x},{y},{z})/{slot} was rejected");
            }
        }

        [Test]
        public void RateLimitOnlyAppliesWhenEnforced()
        {
            // The limit is a server-side sanity check against automation. A
            // client applying it would make a legitimately fast builder
            // mispredict, so it must be off unless enforced.
            FillPlacementBudget();

            Assert.AreEqual(PlacementRejection.RateLimited,
                _world.TryPlace(Place(1, 0, 1, BuildSlot.Interior, 12), 12, true));

            Assert.AreEqual(PlacementRejection.None,
                _world.TryPlace(Place(1, 0, 1, BuildSlot.Interior, 12), 12, false));
        }

        [Test]
        public void PlacementHistoryExpiresAfterASecond()
        {
            FillPlacementBudget();
            Assert.AreEqual(
                PlaceBuildCommand.MaxPlacementsPerSecond,
                _world.RecentPlacementCount(PlayerId));

            for (int tick = 0; tick <= TickRate * 2; tick++)
            {
                _world.Tick(tick);
            }

            Assert.AreEqual(0, _world.RecentPlacementCount(PlayerId));
        }

        [Test]
        public void HealthRampsFromBuildHealthToFullHealth()
        {
            _world.TryPlace(Place(0, 0, 0, BuildSlot.NorthFace), 0, false);
            var cell = new GridCell(0, 0, 0);

            Assert.IsTrue(_world.TryGetHealth(cell, BuildSlot.NorthFace, 0, out float atPlacement));
            Assert.AreEqual(90f, atPlacement, 0.01f);

            // Halfway through the 3 s ramp.
            _world.TryGetHealth(cell, BuildSlot.NorthFace, TickRate * 3 / 2, out float midway);
            Assert.AreEqual(120f, midway, 0.5f);

            _world.TryGetHealth(cell, BuildSlot.NorthFace, TickRate * 3, out float matured);
            Assert.AreEqual(150f, matured, 0.01f);

            _world.TryGetHealth(cell, BuildSlot.NorthFace, TickRate * 30, out float later);
            Assert.AreEqual(150f, later, 0.01f, "Health should not keep growing past full");
        }

        [Test]
        public void AFreshWallDiesToDamageAMaturedWallSurvives()
        {
            // The single most important balance relationship in the game: it is
            // what rewards the player who shoots first.
            _world.TryPlace(Place(0, 0, 0, BuildSlot.NorthFace), 0, false);
            var cell = new GridCell(0, 0, 0);

            Assert.IsTrue(_world.ApplyDamage(cell, BuildSlot.NorthFace, 95f, 0),
                "95 damage should destroy a 90 HP fresh wall");

            _world.TryPlace(Place(0, 0, 0, BuildSlot.NorthFace, 1), 1, false);
            Assert.IsFalse(_world.ApplyDamage(cell, BuildSlot.NorthFace, 95f, 1 + TickRate * 3),
                "95 damage should not destroy a matured 150 HP wall");
        }

        [Test]
        public void DamageDoesNotFreezeTheBuildRamp()
        {
            // A wall that survives a burst goes on maturing. Storing damage
            // rather than current health is what makes that true.
            _world.TryPlace(Place(0, 0, 0, BuildSlot.NorthFace), 0, false);
            var cell = new GridCell(0, 0, 0);

            _world.ApplyDamage(cell, BuildSlot.NorthFace, 40f, 0);
            _world.TryGetHealth(cell, BuildSlot.NorthFace, 0, out float justAfter);
            Assert.AreEqual(50f, justAfter, 0.01f);

            _world.TryGetHealth(cell, BuildSlot.NorthFace, TickRate * 3, out float matured);
            Assert.AreEqual(110f, matured, 0.01f, "150 full health minus 40 damage");
        }

        [Test]
        public void DestroyingASupportSchedulesACollapseRatherThanDoingItInstantly()
        {
            for (int y = 0; y < 4; y++)
            {
                _world.SetPlayerPosition(PlayerId, BuildGrid.CellCentre(new GridCell(0, y, 0)));
                Assert.AreEqual(PlacementRejection.None,
                    _world.TryPlace(Place(0, y, 0, BuildSlot.Interior), 0, false),
                    $"Failed to place at height {y}");
            }

            _world.ApplyDamage(new GridCell(0, 0, 0), BuildSlot.Interior, 1000f, 0);

            // The tower is still standing: the player gets to see it fall.
            Assert.AreEqual(3, _world.Structure.Count);
            Assert.AreEqual(3, _world.PendingCollapseCount);

            // 0.4 s later it is gone.
            int collapseTick = Mathf.CeilToInt(BuildWorld.CollapseDelaySeconds * TickRate);
            for (int tick = 0; tick <= collapseTick + 2; tick++)
            {
                _world.Tick(tick);
            }

            Assert.AreEqual(0, _world.Structure.Count);
        }

        [Test]
        public void RebuildingSupportWithinTheDelayRescuesTheStack()
        {
            // Building a leg back under an orphaned stack should save it, or the
            // game would be ignoring what the player just did.
            for (int y = 0; y < 4; y++)
            {
                _world.SetPlayerPosition(PlayerId, BuildGrid.CellCentre(new GridCell(0, y, 0)));
                _world.TryPlace(Place(0, y, 0, BuildSlot.Interior), 0, false);
            }

            _world.ApplyDamage(new GridCell(0, 0, 0), BuildSlot.Interior, 1000f, 0);
            Assert.AreEqual(3, _world.PendingCollapseCount);

            _world.SetPlayerPosition(PlayerId, BuildGrid.CellCentre(new GridCell(0, 0, 0)));
            Assert.AreEqual(PlacementRejection.None,
                _world.TryPlace(Place(0, 0, 0, BuildSlot.Interior, 1), 1, false));

            Assert.AreEqual(0, _world.PendingCollapseCount, "The rebuilt leg should rescue the stack");

            int collapseTick = Mathf.CeilToInt(BuildWorld.CollapseDelaySeconds * TickRate);
            for (int tick = 0; tick <= collapseTick + 2; tick++)
            {
                _world.Tick(tick);
            }

            Assert.AreEqual(4, _world.Structure.Count, "Nothing should have fallen");
        }

        [Test]
        public void CollapseIsBudgetedPerTick()
        {
            // A mega-build's collapse may take several ticks; it may not spike
            // one tick past the budget.
            var world = new BuildWorld(TickRate) { TouchesGround = cell => cell.Y == 0 };
            var wallet = new MaterialWallet();
            wallet.Add(_wood, 500);
            world.SetWallet(PlayerId, wallet);

            int height = BuildWorld.MaxCollapsesPerTick + 10;
            for (int y = 0; y < height; y++)
            {
                world.SetPlayerPosition(PlayerId, BuildGrid.CellCentre(new GridCell(0, y, 0)));
                world.TryPlace(
                    new PlaceBuildCommand(
                        PlayerId, 0, new GridCell(0, y, 0), BuildSlot.Interior, _wall, _wood),
                    0, false);
            }

            world.ApplyDamage(new GridCell(0, 0, 0), BuildSlot.Interior, 1000f, 0);

            int collapseTick = Mathf.CeilToInt(BuildWorld.CollapseDelaySeconds * TickRate);
            int before = world.Structure.Count;
            world.Tick(collapseTick);
            int removed = before - world.Structure.Count;

            Assert.LessOrEqual(removed, BuildWorld.MaxCollapsesPerTick,
                $"One tick removed {removed} pieces, over the {BuildWorld.MaxCollapsesPerTick} budget");
            Assert.Greater(removed, 0, "The collapse should have started");
        }

        [Test]
        public void ABoxIsBuiltWithinTheGddInputBudget()
        {
            // GDD 2.1: a full 1x1 box in 0.7 s of input, which at 30 Hz is 21
            // ticks for four placements.
            var cell = new GridCell(0, 0, 0);
            BuildSlot[] faces =
            {
                BuildSlot.NorthFace, BuildSlot.EastFace,
                BuildSlot.SouthFace, BuildSlot.WestFace,
            };

            int tick = 0;
            foreach (BuildSlot face in faces)
            {
                Assert.AreEqual(PlacementRejection.None,
                    _world.TryPlace(
                        new PlaceBuildCommand(PlayerId, tick, cell, face, _wall, _wood),
                        tick, true),
                    $"Failed to place {face}");
                tick += 5;
            }

            Assert.AreEqual(4, _world.Structure.Count);
            Assert.LessOrEqual(tick / (float)TickRate, 0.7f);
        }
    }
}
