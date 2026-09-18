/**
 * Tests for the parts of WorldCollision that are pure enough to run in Node.
 *
 * The Heightfield is generated arithmetic with no WebGL and no DOM, so the
 * collision model is testable here even though it lives in the render layer.
 * `isInsideSolid` is what the third-person camera boom is steered by, and a
 * camera that ends up on the far side of a wall shows the player the inside of
 * their own base -- a bug that a screenshot of an empty field never reveals.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { SOLID_MASK } from "@/blueprints/registry";
import { BuildSlot, CELL_SIZE, cell } from "@/core/grid";
import { BuildStructure } from "@/gameplay/build";
import { WorldCollision } from "@/render/collision";
import { Heightfield, SANDBOX_TERRAIN } from "@/render/terrain";

describe("isInsideSolid", () => {
  let field: Heightfield;
  let structure: BuildStructure;
  let collision: WorldCollision;

  // The sandbox terrain sits on a baseHeight of 6 m, so cell y=0 is buried.
  // Everything here is anchored to a cell comfortably above ground, because a
  // fixture underground reports solid for reasons that have nothing to do with
  // the piece under test.
  let cellY: number;
  let groundY: number;

  beforeEach(() => {
    field = new Heightfield(SANDBOX_TERRAIN);
    structure = new BuildStructure(() => true);
    collision = new WorldCollision(field, structure);

    cellY = Math.ceil((field.sample(CELL_SIZE / 2, CELL_SIZE / 2) + 1) / CELL_SIZE);
    groundY = cellY * CELL_SIZE;
  });

  const wall = (x: number, y: number, z: number, slot: BuildSlot) => ({
    cell: cell(x, y, z), slot, pieceId: "piece.wall", materialId: "material.wood",
    ownerId: 1, placedTick: 0, damageTaken: 0, editMask: SOLID_MASK,
  });

  it("reports open air as clear", () => {
    expect(collision.isInsideSolid(0, field.sample(0, 0) + 20, 0)).toBe(false);
  });

  it("reports underground as solid", () => {
    // A boom that swings below a hillside must be pulled in, or the camera
    // looks up through the terrain.
    expect(collision.isInsideSolid(0, field.sample(0, 0) - 2, 0)).toBe(true);
  });

  it("reports the inside of a wall slab as solid", () => {
    structure.tryAdd(wall(0, cellY, 0, BuildSlot.NorthFace));
    // The north face of cell (0, cellY, 0) is the plane z = CELL_SIZE.
    expect(collision.isInsideSolid(CELL_SIZE / 2, groundY + 1, CELL_SIZE)).toBe(true);
  });

  it("reports a point just off the wall as clear", () => {
    structure.tryAdd(wall(0, cellY, 0, BuildSlot.NorthFace));
    expect(collision.isInsideSolid(CELL_SIZE / 2, groundY + 1, CELL_SIZE - 1)).toBe(false);
  });

  it("does not report a point beside the wall as solid", () => {
    // Outside the cell's x range: a wall must not block a camera that is past
    // its edge, or the boom collapses in open ground next to any structure.
    structure.tryAdd(wall(0, cellY, 0, BuildSlot.NorthFace));
    expect(collision.isInsideSolid(CELL_SIZE + 2, groundY + 1, CELL_SIZE)).toBe(false);
  });

  it("does not report a point above the wall as solid", () => {
    structure.tryAdd(wall(0, cellY, 0, BuildSlot.NorthFace));
    expect(collision.isInsideSolid(CELL_SIZE / 2, groundY + CELL_SIZE + 1, CELL_SIZE)).toBe(false);
  });

  it("reports under a floor slab as solid and above it as clear", () => {
    // Floors are height queries rather than boxes, so they need their own case;
    // treating them as clear would let the boom drop through a platform.
    structure.tryAdd(wall(0, cellY, 0, BuildSlot.FloorFace));
    expect(collision.isInsideSolid(CELL_SIZE / 2, groundY - 0.05, CELL_SIZE / 2)).toBe(true);
    expect(collision.isInsideSolid(CELL_SIZE / 2, groundY + 1, CELL_SIZE / 2)).toBe(false);
  });
});

describe("collision at height", () => {
  // The neighbourhood search used to centre on cell y=0 regardless of where the
  // player was, so nothing above about 12 m existed as far as collision was
  // concerned: a tower taller than three cells could be walked through and
  // fallen out of. Building tall is the pillar, so these pin it at an altitude
  // well past the old window.
  const HIGH_CELL_Y = 30; // 120 m up

  let field: Heightfield;
  let structure: BuildStructure;
  let collision: WorldCollision;

  beforeEach(() => {
    field = new Heightfield(SANDBOX_TERRAIN);
    structure = new BuildStructure(() => true);
    collision = new WorldCollision(field, structure);
  });

  const piece = (slot: BuildSlot) => ({
    cell: cell(0, HIGH_CELL_Y, 0), slot, pieceId: "piece.wall",
    materialId: "material.wood", ownerId: 1, placedTick: 0, damageTaken: 0,
    editMask: SOLID_MASK,
  });

  it("stands on a floor 120 m up", () => {
    structure.tryAdd(piece(BuildSlot.FloorFace));
    const floorY = HIGH_CELL_Y * CELL_SIZE;
    const ground = collision.groundHeightAt(CELL_SIZE / 2, CELL_SIZE / 2, floorY + 0.2);
    expect(ground).toBeGreaterThan(floorY - 1);
  });

  it("is stopped by a wall 120 m up", () => {
    structure.tryAdd(piece(BuildSlot.NorthFace));
    const y = HIGH_CELL_Y * CELL_SIZE + 1;

    // Steps of one tick at sprint speed (7.4 m/s at 30 Hz). The resolve is a
    // position test rather than a sweep, so a single huge step would tunnel
    // through the slab -- that is a property of the model, not of altitude, and
    // testing it with an unrealistic delta would prove nothing about either.
    const STEP = 7.4 / 30;
    let position = { x: CELL_SIZE / 2, y, z: CELL_SIZE - 1.5 };
    for (let i = 0; i < 20; i++) {
      position = collision.move(position, { x: 0, y: 0, z: STEP }, 1.8, 0.35).position;
    }
    // Twenty ticks of sprinting is 4.9 m, far past the face at z = 4.
    expect(position.z).toBeLessThan(CELL_SIZE);
  });

  it("sees a wall 120 m up as solid", () => {
    structure.tryAdd(piece(BuildSlot.NorthFace));
    expect(
      collision.isInsideSolid(CELL_SIZE / 2, HIGH_CELL_Y * CELL_SIZE + 1, CELL_SIZE),
    ).toBe(true);
  });
});

describe("shot trace", () => {
  let field: Heightfield;
  let structure: BuildStructure;
  let collision: WorldCollision;
  let cellY: number;
  let groundY: number;

  beforeEach(() => {
    field = new Heightfield(SANDBOX_TERRAIN);
    structure = new BuildStructure(() => true);
    collision = new WorldCollision(field, structure);
    cellY = Math.ceil((field.sample(CELL_SIZE / 2, CELL_SIZE / 2) + 1) / CELL_SIZE);
    groundY = cellY * CELL_SIZE;
  });

  const wall = (x: number, y: number, z: number, slot: BuildSlot) => ({
    cell: cell(x, y, z), slot, pieceId: "piece.wall", materialId: "material.wood",
    ownerId: 1, placedTick: 0, damageTaken: 0, editMask: SOLID_MASK,
  });

  it("reports the wall it hits, and which one", () => {
    structure.tryAdd(wall(0, cellY, 0, BuildSlot.NorthFace));
    const hit = collision.trace(
      { x: CELL_SIZE / 2, y: groundY + 2, z: CELL_SIZE - 3 }, { x: 0, y: 0, z: 1 }, 50,
    );
    expect(hit.kind).toBe("structure");
    expect(hit.cell).toEqual(cell(0, cellY, 0));
    expect(hit.slot).toBe(BuildSlot.NorthFace);
    // The face is at z = CELL_SIZE, three metres ahead of the origin.
    expect(hit.distance).toBeCloseTo(3, 0);
  });

  it("stops at the nearest wall, not one behind it", () => {
    structure.tryAdd(wall(0, cellY, 0, BuildSlot.NorthFace)); // z = 4
    structure.tryAdd(wall(0, cellY, 1, BuildSlot.NorthFace)); // z = 8
    const hit = collision.trace(
      { x: CELL_SIZE / 2, y: groundY + 2, z: 1 }, { x: 0, y: 0, z: 1 }, 50,
    );
    expect(hit.cell?.z).toBe(0);
  });

  it("hits terrain when nothing is built", () => {
    // Fired downward into the ground.
    const hit = collision.trace(
      { x: 0, y: field.sample(0, 0) + 5, z: 0 }, { x: 0, y: -1, z: 0 }, 50,
    );
    expect(hit.kind).toBe("terrain");
    expect(hit.distance).toBeLessThan(6);
  });

  it("reports nothing when the shot flies off into the sky", () => {
    const hit = collision.trace(
      { x: 0, y: field.sample(0, 0) + 5, z: 0 }, { x: 0, y: 1, z: 0 }, 50,
    );
    expect(hit.kind).toBe("none");
    expect(hit.distance).toBe(50);
  });

  it("respects the maximum distance", () => {
    structure.tryAdd(wall(0, cellY, 4, BuildSlot.NorthFace)); // z = 20
    const near = collision.trace(
      { x: CELL_SIZE / 2, y: groundY + 2, z: 1 }, { x: 0, y: 0, z: 1 }, 10,
    );
    expect(near.kind).toBe("none");
  });

  it("does not step through a slab", () => {
    // A slab is 0.24 m thick. A trace whose step exceeded that would pass
    // straight through a wall and hit whatever was behind it -- bullets that
    // ignore cover would make building pointless.
    structure.tryAdd(wall(0, cellY, 0, BuildSlot.NorthFace));
    for (let offset = -1.5; offset <= 1.5; offset += 0.17) {
      const hit = collision.trace(
        { x: CELL_SIZE / 2 + offset * 0.4, y: groundY + 2 + offset * 0.3, z: 0.5 },
        { x: 0, y: 0, z: 1 },
        30,
      );
      expect(hit.kind, `offset ${offset.toFixed(2)}`).toBe("structure");
    }
  });

  it("normalises the direction it is given", () => {
    // A caller passing an unnormalised aim vector must not get a trace that
    // runs at the wrong speed and reports a distance in the wrong units.
    structure.tryAdd(wall(0, cellY, 0, BuildSlot.NorthFace));
    const origin = { x: CELL_SIZE / 2, y: groundY + 2, z: CELL_SIZE - 3 };
    const unit = collision.trace(origin, { x: 0, y: 0, z: 1 }, 50);
    const long = collision.trace(origin, { x: 0, y: 0, z: 7 }, 50);
    expect(long.distance).toBeCloseTo(unit.distance, 6);
  });
});
