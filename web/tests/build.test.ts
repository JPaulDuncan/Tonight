import { beforeEach, describe, expect, it } from "vitest";

import { blueprints } from "@/blueprints/library";
import { BuildSlot, cell, cellCentre } from "@/core/grid";
import { vec3 } from "@/core/math";
import { MAX_PLACEMENTS_PER_SECOND, PlacementRejection, type PlaceBuildCommand } from "@/gameplay/commands";
import {
  BuildStructure,
  BuildWorld,
  COLLAPSE_DELAY_SECONDS,
  MAX_COLLAPSES_PER_TICK,
  MAX_OCCUPANCY_STEPS,
  MaterialWallet,
  UNSUPPORTED,
  healthAtAge,
  placementTransform,
  resolvePlacement,
  stepCell,
  subCellIndex,
  toggleMaskBit,
  variantForMask,
} from "@/gameplay/build";
import { SOLID_MASK, packMask } from "@/blueprints/registry";

const TICK_RATE = 30;
const PLAYER = 1;

describe("build structure", () => {
  let structure: BuildStructure;

  beforeEach(() => {
    structure = new BuildStructure((c) => c.y === 0);
  });

  const piece = (x: number, y: number, z: number, slot: BuildSlot) => ({
    cell: cell(x, y, z), slot, pieceId: "piece.wall", materialId: "material.wood",
    ownerId: PLAYER, placedTick: 0, damageTaken: 0, editMask: SOLID_MASK,
  });

  it("holds one piece per slot", () => {
    expect(structure.tryAdd(piece(0, 0, 0, BuildSlot.NorthFace))).toBe(true);
    expect(structure.tryAdd(piece(0, 0, 0, BuildSlot.NorthFace))).toBe(false);
    expect(structure.count).toBe(1);
  });

  it("holds four walls, a floor and one interior in one cell", () => {
    // Exactly a 1x1 box with a ramp inside it.
    for (const slot of [BuildSlot.NorthFace, BuildSlot.EastFace, BuildSlot.SouthFace,
                        BuildSlot.WestFace, BuildSlot.FloorFace, BuildSlot.Interior]) {
      expect(structure.tryAdd(piece(0, 0, 0, slot))).toBe(true);
    }
    expect(structure.count).toBe(6);
  });

  it("treats a shared face as one piece from either side", () => {
    structure.tryAdd(piece(0, 0, 0, BuildSlot.NorthFace));
    expect(structure.isOccupied(cell(0, 0, 1), BuildSlot.SouthFace)).toBe(true);
    expect(structure.tryAdd(piece(0, 0, 1, BuildSlot.SouthFace))).toBe(false);
    expect(structure.count).toBe(1);
  });

  it("grows support distance with height", () => {
    for (let y = 0; y < 5; y++) structure.tryAdd(piece(0, y, 0, BuildSlot.Interior));
    structure.recomputeSupport();
    for (let y = 0; y < 5; y++) {
      expect(structure.supportDistance(cell(0, y, 0), BuildSlot.Interior)).toBe(y);
    }
  });

  it("collapses everything above a destroyed base", () => {
    for (let y = 0; y < 5; y++) structure.tryAdd(piece(0, y, 0, BuildSlot.Interior));
    const { collapsed } = structure.tryRemove(cell(0, 0, 0), BuildSlot.Interior);
    expect(collapsed).toHaveLength(4);
  });

  it("collapses nothing when the top is destroyed", () => {
    for (let y = 0; y < 5; y++) structure.tryAdd(piece(0, y, 0, BuildSlot.Interior));
    expect(structure.tryRemove(cell(0, 4, 0), BuildSlot.Interior).collapsed).toHaveLength(0);
  });

  it("does not take an adjacent independent tower down", () => {
    for (let y = 0; y < 4; y++) {
      structure.tryAdd(piece(0, y, 0, BuildSlot.Interior));
      structure.tryAdd(piece(10, y, 10, BuildSlot.Interior));
    }
    const { collapsed } = structure.tryRemove(cell(0, 0, 0), BuildSlot.Interior);
    expect(collapsed).toHaveLength(3);
    for (const key of collapsed) expect(key.startsWith("0,")).toBe(true);
  });

  it("restores support when a leg is rebuilt under an orphan", () => {
    for (let y = 2; y < 5; y++) structure.tryAdd(piece(0, y, 0, BuildSlot.Interior));
    structure.recomputeSupport();
    expect(structure.supportDistance(cell(0, 4, 0), BuildSlot.Interior)).toBe(UNSUPPORTED);

    structure.tryAdd(piece(0, 0, 0, BuildSlot.Interior));
    structure.tryAdd(piece(0, 1, 0, BuildSlot.Interior));
    expect(structure.supportDistance(cell(0, 4, 0), BuildSlot.Interior)).toBe(4);
  });

  it("refuses to consider mid-air placement supported", () => {
    expect(structure.wouldBeSupported(cell(0, 6, 0), BuildSlot.Interior)).toBe(false);
    expect(structure.wouldBeSupported(cell(0, 0, 0), BuildSlot.Interior)).toBe(true);
  });
});

describe("build world", () => {
  let world: BuildWorld;

  beforeEach(() => {
    world = new BuildWorld(blueprints(), TICK_RATE, (c) => c.y === 0);
    world.wallet(PLAYER).add(blueprints().buildMaterial("material.wood"), 500);
    world.setPlayerPosition(PLAYER, cellCentre(cell(0, 0, 0)));
  });

  const place = (
    x: number, y: number, z: number, slot: BuildSlot, tick = 0,
  ): PlaceBuildCommand => ({
    playerId: PLAYER, tick, cell: cell(x, y, z), slot,
    pieceId: "piece.wall", materialId: "material.wood",
  });

  it("deducts exactly the cost", () => {
    expect(world.tryPlace(place(0, 0, 0, BuildSlot.NorthFace), 0, false))
      .toBe(PlacementRejection.None);
    expect(world.wallet(PLAYER).get("material.wood")).toBe(490);
  });

  it("refuses an unaffordable placement at no cost", () => {
    const empty = new BuildWorld(blueprints(), TICK_RATE, (c) => c.y === 0);
    empty.setPlayerPosition(PLAYER, cellCentre(cell(0, 0, 0)));
    empty.wallet(PLAYER).add(blueprints().buildMaterial("material.wood"), 5);

    expect(empty.tryPlace(place(0, 0, 0, BuildSlot.NorthFace), 0, false))
      .toBe(PlacementRejection.Unaffordable);
    expect(empty.wallet(PLAYER).get("material.wood")).toBe(5);
    expect(empty.structure.count).toBe(0);
  });

  it("refuses mid-air placement as unsupported", () => {
    world.setPlayerPosition(PLAYER, cellCentre(cell(0, 5, 0)));
    expect(world.tryPlace(place(0, 5, 0, BuildSlot.NorthFace), 0, false))
      .toBe(PlacementRejection.Unsupported);
  });

  it("refuses placement beyond build range", () => {
    expect(world.tryPlace(place(20, 0, 20, BuildSlot.NorthFace), 0, false))
      .toBe(PlacementRejection.OutOfRange);
  });

  it("refunds exactly what a rollback deducted", () => {
    const command = place(0, 0, 0, BuildSlot.NorthFace);
    world.tryPlace(command, 0, false);
    expect(world.wallet(PLAYER).get("material.wood")).toBe(490);

    world.rollback(command);
    expect(world.wallet(PLAYER).get("material.wood")).toBe(500);
    expect(world.structure.count).toBe(0);
  });

  // Twelve distinct slots within build range, so rate-limit tests fail on the
  // rate limit rather than on range.
  const nearby: readonly (readonly [number, number, number, BuildSlot])[] = [
    [0, 0, 0, BuildSlot.NorthFace], [0, 0, 0, BuildSlot.EastFace],
    [0, 0, 0, BuildSlot.SouthFace], [0, 0, 0, BuildSlot.WestFace],
    [0, 0, 0, BuildSlot.FloorFace], [0, 0, 0, BuildSlot.Interior],
    [1, 0, 0, BuildSlot.NorthFace], [1, 0, 0, BuildSlot.EastFace],
    [1, 0, 0, BuildSlot.FloorFace], [1, 0, 0, BuildSlot.Interior],
    [0, 0, 1, BuildSlot.EastFace], [0, 0, 1, BuildSlot.Interior],
  ];

  const fillBudget = () => {
    expect(nearby).toHaveLength(MAX_PLACEMENTS_PER_SECOND);
    nearby.forEach(([x, y, z, slot], i) => {
      expect(world.tryPlace(place(x, y, z, slot, i), i, true), `fixture ${i}`)
        .toBe(PlacementRejection.None);
    });
  };

  it("applies the rate limit only when enforced", () => {
    fillBudget();
    expect(world.tryPlace(place(1, 0, 1, BuildSlot.Interior, 12), 12, true))
      .toBe(PlacementRejection.RateLimited);
    expect(world.tryPlace(place(1, 0, 1, BuildSlot.Interior, 12), 12, false))
      .toBe(PlacementRejection.None);
  });

  it("expires placement history after a second", () => {
    fillBudget();
    expect(world.recentPlacementCount(PLAYER)).toBe(MAX_PLACEMENTS_PER_SECOND);
    for (let t = 0; t <= TICK_RATE * 2; t++) world.tick(t);
    expect(world.recentPlacementCount(PLAYER)).toBe(0);
  });

  it("ramps health from build to full", () => {
    world.tryPlace(place(0, 0, 0, BuildSlot.NorthFace), 0, false);
    const at = (tick: number) => world.healthAt(cell(0, 0, 0), BuildSlot.NorthFace, tick);

    expect(at(0)).toBeCloseTo(90, 2);
    expect(at(TICK_RATE * 1.5)).toBeCloseTo(120, 1);
    expect(at(TICK_RATE * 3)).toBeCloseTo(150, 2);
    expect(at(TICK_RATE * 30)).toBeCloseTo(150, 2);
  });

  it("kills a fresh wall but not a matured one", () => {
    // The single most important balance relationship in the game: it rewards
    // the player who shoots first.
    world.tryPlace(place(0, 0, 0, BuildSlot.NorthFace), 0, false);
    expect(world.applyDamage(cell(0, 0, 0), BuildSlot.NorthFace, 95, 0)).toBe(true);

    world.tryPlace(place(0, 0, 0, BuildSlot.NorthFace, 1), 1, false);
    expect(world.applyDamage(cell(0, 0, 0), BuildSlot.NorthFace, 95, 1 + TICK_RATE * 3)).toBe(false);
  });

  it("keeps the build ramp running after damage", () => {
    world.tryPlace(place(0, 0, 0, BuildSlot.NorthFace), 0, false);
    world.applyDamage(cell(0, 0, 0), BuildSlot.NorthFace, 40, 0);

    expect(world.healthAt(cell(0, 0, 0), BuildSlot.NorthFace, 0)).toBeCloseTo(50, 2);
    expect(world.healthAt(cell(0, 0, 0), BuildSlot.NorthFace, TICK_RATE * 3)).toBeCloseTo(110, 2);
  });

  it("schedules a collapse rather than doing it instantly", () => {
    for (let y = 0; y < 4; y++) {
      world.setPlayerPosition(PLAYER, cellCentre(cell(0, y, 0)));
      expect(world.tryPlace(place(0, y, 0, BuildSlot.Interior), 0, false))
        .toBe(PlacementRejection.None);
    }

    world.applyDamage(cell(0, 0, 0), BuildSlot.Interior, 1000, 0);
    expect(world.structure.count).toBe(3);
    expect(world.pendingCollapseCount).toBe(3);

    const at = Math.ceil(COLLAPSE_DELAY_SECONDS * TICK_RATE);
    for (let t = 0; t <= at + 2; t++) world.tick(t);
    expect(world.structure.count).toBe(0);
  });

  it("rescues a stack when the leg is rebuilt in time", () => {
    for (let y = 0; y < 4; y++) {
      world.setPlayerPosition(PLAYER, cellCentre(cell(0, y, 0)));
      world.tryPlace(place(0, y, 0, BuildSlot.Interior), 0, false);
    }
    world.applyDamage(cell(0, 0, 0), BuildSlot.Interior, 1000, 0);
    expect(world.pendingCollapseCount).toBe(3);

    world.setPlayerPosition(PLAYER, cellCentre(cell(0, 0, 0)));
    expect(world.tryPlace(place(0, 0, 0, BuildSlot.Interior, 1), 1, false))
      .toBe(PlacementRejection.None);
    expect(world.pendingCollapseCount).toBe(0);

    const at = Math.ceil(COLLAPSE_DELAY_SECONDS * TICK_RATE);
    for (let t = 0; t <= at + 2; t++) world.tick(t);
    expect(world.structure.count).toBe(4);
  });

  it("budgets collapses per tick", () => {
    const tall = new BuildWorld(blueprints(), TICK_RATE, (c) => c.y === 0);
    tall.wallet(PLAYER).add(blueprints().buildMaterial("material.wood"), 500);

    const height = MAX_COLLAPSES_PER_TICK + 10;
    for (let y = 0; y < height; y++) {
      tall.setPlayerPosition(PLAYER, cellCentre(cell(0, y, 0)));
      tall.tryPlace(
        { playerId: PLAYER, tick: 0, cell: cell(0, y, 0), slot: BuildSlot.Interior,
          pieceId: "piece.wall", materialId: "material.wood" }, 0, false);
    }

    tall.applyDamage(cell(0, 0, 0), BuildSlot.Interior, 1000, 0);
    const before = tall.structure.count;
    tall.tick(Math.ceil(COLLAPSE_DELAY_SECONDS * TICK_RATE));
    const removed = before - tall.structure.count;

    expect(removed).toBeGreaterThan(0);
    expect(removed).toBeLessThanOrEqual(MAX_COLLAPSES_PER_TICK);
  });

  it("builds a box inside the GDD input budget", () => {
    // GDD 2.1: a 1x1 box in 0.7 s of input, which at 30 Hz is 21 ticks.
    let tick = 0;
    for (const slot of [BuildSlot.NorthFace, BuildSlot.EastFace,
                        BuildSlot.SouthFace, BuildSlot.WestFace]) {
      expect(world.tryPlace(place(0, 0, 0, slot, tick), tick, true)).toBe(PlacementRejection.None);
      tick += 5;
    }
    expect(world.structure.count).toBe(4);
    expect(tick / TICK_RATE).toBeLessThanOrEqual(0.7);
  });

  it("lets only the owner edit", () => {
    world.tryPlace(place(0, 0, 0, BuildSlot.NorthFace), 0, false);
    const doorway = packMask(
      blueprints().buildPiece("piece.wall").editVariants[0]!.gridMask);

    expect(world.tryEdit(cell(0, 0, 0), BuildSlot.NorthFace, doorway, PLAYER + 99)).toBe(false);
    expect(world.tryEdit(cell(0, 0, 0), BuildSlot.NorthFace, doorway, PLAYER)).toBe(true);
  });

  it("refuses an unauthored mask so the edit reverts", () => {
    world.tryPlace(place(0, 0, 0, BuildSlot.NorthFace), 0, false);
    expect(world.tryEdit(cell(0, 0, 0), BuildSlot.NorthFace, 0b101010101, PLAYER)).toBe(false);
  });

  it("carries damage across an edit rather than repairing", () => {
    world.tryPlace(place(0, 0, 0, BuildSlot.NorthFace), 0, false);
    world.applyDamage(cell(0, 0, 0), BuildSlot.NorthFace, 30, 0);
    const before = world.healthAt(cell(0, 0, 0), BuildSlot.NorthFace, 0)!;

    const doorway = packMask(blueprints().buildPiece("piece.wall").editVariants[0]!.gridMask);
    world.tryEdit(cell(0, 0, 0), BuildSlot.NorthFace, doorway, PLAYER);

    // Health drops further because the doorway variant scales it down; it must
    // not go UP, which is what a free repair would look like.
    expect(world.healthAt(cell(0, 0, 0), BuildSlot.NorthFace, 0)!).toBeLessThanOrEqual(before);
  });
});

describe("placement resolver", () => {
  let structure: BuildStructure;
  const wall = () => blueprints().buildPiece("piece.wall");
  const floor = () => blueprints().buildPiece("piece.floor");
  const ramp = () => blueprints().buildPiece("piece.ramp");

  beforeEach(() => {
    structure = new BuildStructure((c) => c.y === 0);
  });

  it("resolves a target in open air", () => {
    // Building in open air is normal, so "the ray hit nothing" is not a failure.
    expect(resolvePlacement(vec3(2, 2, 2), vec3(0, 0, 1), -1, wall(), structure, 0).found).toBe(true);
  });

  it("caps the target at the maximum place distance", () => {
    const far = resolvePlacement(vec3(), vec3(0, 0, 1), 100, wall(), structure, 0);
    expect(placementTransform(far).position.z).toBeLessThanOrEqual(14);
  });

  it("uses a close surface instead of the maximum distance", () => {
    const near = resolvePlacement(vec3(), vec3(0, 0, 1), 2, wall(), structure, 0);
    const far = resolvePlacement(vec3(), vec3(0, 0, 1), -1, wall(), structure, 0);
    expect(near.cell).not.toEqual(far.cell);
  });

  it("picks the face turned toward the viewer", () => {
    // Looking north (+Z), the player meets the SOUTH face of the cell ahead.
    expect(resolvePlacement(vec3(), vec3(0, 0, 1), -1, wall(), structure, 0).slot)
      .toBe(BuildSlot.SouthFace);
    expect(resolvePlacement(vec3(), vec3(0, 0, -1), -1, wall(), structure, 0).slot)
      .toBe(BuildSlot.NorthFace);
    expect(resolvePlacement(vec3(), vec3(1, 0, 0), -1, wall(), structure, 0).slot)
      .toBe(BuildSlot.WestFace);
  });

  it("always puts a ramp in the interior slot", () => {
    for (const dir of [vec3(0, 0, 1), vec3(0, 0, -1), vec3(1, 0, 0), vec3(-1, 0, 0)]) {
      expect(resolvePlacement(vec3(), dir, -1, ramp(), structure, 0).slot).toBe(BuildSlot.Interior);
    }
  });

  it("puts a floor at the player's height regardless of pitch", () => {
    const up = resolvePlacement(vec3(2, 6, 2), vec3(0, 0.9, 0.4), -1, floor(), structure, 6);
    const down = resolvePlacement(vec3(2, 6, 2), vec3(0, -0.9, 0.4), -1, floor(), structure, 6);
    expect(up.cell.y).toBe(down.cell.y);
    expect(up.slot).toBe(BuildSlot.FloorFace);
  });

  it("steps forward when the slot is occupied", () => {
    const first = resolvePlacement(vec3(), vec3(0, 0, 1), -1, wall(), structure, 0);
    structure.tryAdd({
      cell: first.cell, slot: first.slot, pieceId: "piece.wall", materialId: "material.wood",
      ownerId: 1, placedTick: 0, damageTaken: 0, editMask: SOLID_MASK,
    });
    const second = resolvePlacement(vec3(), vec3(0, 0, 1), -1, wall(), structure, 0);
    expect(second.found).toBe(true);
    expect(second.cell).not.toEqual(first.cell);
  });

  it("gives up after the step limit", () => {
    const direction = vec3(0, 0, 1);
    const target = resolvePlacement(vec3(), direction, -1, wall(), structure, 0);
    let c = target.cell;
    for (let step = 0; step <= MAX_OCCUPANCY_STEPS; step++) {
      structure.tryAdd({
        cell: c, slot: target.slot, pieceId: "piece.wall", materialId: "material.wood",
        ownerId: 1, placedTick: 0, damageTaken: 0, editMask: SOLID_MASK,
      });
      c = stepCell(c, direction, "wall");
    }
    expect(resolvePlacement(vec3(), direction, -1, wall(), structure, 0).found).toBe(false);
  });

  it("is stable for identical input", () => {
    for (let i = 0; i < 20; i++) {
      const target = resolvePlacement(
        vec3(1.3, 2.7, -4.1), vec3(0.4, -0.2, 0.9), 7.5, wall(), structure, 2.7);
      expect(target.found).toBe(true);
      expect(target.cell).toEqual(cell(1, 0, 0));
      expect(target.slot).toBe(BuildSlot.SouthFace);
    }
  });

  it("resolves nothing for a missing piece", () => {
    expect(resolvePlacement(vec3(), vec3(0, 0, 1), -1, undefined, structure, 0).found).toBe(false);
  });
});

describe("edit masks", () => {
  it("indexes sub-cell zero at the top-left", () => {
    expect(subCellIndex(0.1, 0.9)).toBe(0);
    expect(subCellIndex(0.9, 0.9)).toBe(2);
    expect(subCellIndex(0.1, 0.1)).toBe(6);
    expect(subCellIndex(0.9, 0.1)).toBe(8);
    expect(subCellIndex(0.5, 0.5)).toBe(4);
  });

  it("clamps an out-of-range point", () => {
    for (const [x, y] of [[-5, 0.5], [5, 0.5], [0.5, -5], [0.5, 5]] as const) {
      const index = subCellIndex(x, y);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThanOrEqual(8);
    }
  });

  it("toggles one sub-cell", () => {
    let mask = SOLID_MASK;
    mask = toggleMaskBit(mask, 4);
    expect((mask & (1 << 4)) !== 0).toBe(false);
    mask = toggleMaskBit(mask, 4);
    expect((mask & (1 << 4)) !== 0).toBe(true);
  });

  it("ignores an out-of-range toggle", () => {
    expect(toggleMaskBit(SOLID_MASK, -1)).toBe(SOLID_MASK);
    expect(toggleMaskBit(SOLID_MASK, 9)).toBe(SOLID_MASK);
  });

  it("resolves an authored mask and rejects the solid one", () => {
    const wall = blueprints().buildPiece("piece.wall");
    const doorway = wall.editVariants.find((v) => v.variantName === "Doorway")!;
    expect(variantForMask(wall, packMask(doorway.gridMask))?.variantName).toBe("Doorway");
    expect(variantForMask(wall, SOLID_MASK)).toBeUndefined();
  });
});

describe("material wallet", () => {
  it("respects the carry cap", () => {
    const wallet = new MaterialWallet();
    const wood = blueprints().buildMaterial("material.wood");
    expect(wallet.add(wood, 900)).toBe(500);
    expect(wallet.add(wood, 100)).toBe(0);
  });

  it("changes nothing on a failed spend", () => {
    const wallet = new MaterialWallet();
    wallet.add(blueprints().buildMaterial("material.wood"), 15);
    expect(wallet.trySpend("material.wood", 10)).toBe(true);
    expect(wallet.trySpend("material.wood", 10)).toBe(false);
    expect(wallet.get("material.wood")).toBe(5);
  });

  it("refunds past the cap so a rejection never costs materials", () => {
    const wallet = new MaterialWallet();
    const wood = blueprints().buildMaterial("material.wood");
    wallet.add(wood, 500);
    wallet.trySpend("material.wood", 10);
    wallet.refund("material.wood", 10);
    expect(wallet.get("material.wood")).toBe(500);
  });

  it("tracks materials independently", () => {
    const wallet = new MaterialWallet();
    wallet.add(blueprints().buildMaterial("material.wood"), 100);
    wallet.add(blueprints().buildMaterial("material.stone"), 50);
    expect(wallet.get("material.wood")).toBe(100);
    expect(wallet.get("material.stone")).toBe(50);
    expect(wallet.get("material.metal")).toBe(0);
  });
});

describe("health ramp", () => {
  it("is exact at both ends and monotonic between", () => {
    const wood = blueprints().buildMaterial("material.wood");
    expect(healthAtAge(wood, 0)).toBe(90);
    expect(healthAtAge(wood, 3)).toBe(150);
    expect(healthAtAge(wood, 99)).toBe(150);

    let previous = -1;
    for (let t = 0; t <= 3; t += 0.1) {
      const hp = healthAtAge(wood, t);
      expect(hp).toBeGreaterThanOrEqual(previous);
      previous = hp;
    }
  });

  it("makes metal the strongest and slowest", () => {
    const wood = blueprints().buildMaterial("material.wood");
    const metal = blueprints().buildMaterial("material.metal");
    expect(metal.fullHealth).toBeGreaterThan(wood.fullHealth);
    expect(metal.buildTimeSeconds).toBeGreaterThan(wood.buildTimeSeconds);
    // But they start equal, so a fresh piece is equally killable whatever it is.
    expect(metal.buildHealth).toBe(wood.buildHealth);
  });
});
