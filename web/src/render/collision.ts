/**
 * Collision against terrain and build pieces.
 *
 * Implements {@link MotorCollision}, so the same motor that runs in the tests
 * against a flat plane runs here against a real world. All the interesting
 * logic stays in the motor; this only answers "where can the capsule go".
 *
 * Deliberately not a physics engine. Build pieces are axis-aligned boxes on a
 * known grid, so a separated-axis resolve is exact for walls and a height query
 * is exact for floors and ramps -- and both are far cheaper and far more
 * predictable than a general solver. Predictability is pillar 1's requirement.
 */

import {
  BuildSlot,
  CELL_SIZE,
  cellToWorld,
  parsePieceKey,
  worldToCell,
  type GridCell,
} from "@/core/grid";
import { clamp, type Vec3 } from "@/core/math";
import type { BuildStructure, PlacedPiece } from "@/gameplay/build";
import type { MotorCollision, MotorCollisionResult } from "@/gameplay/motor";
import type { Heightfield } from "./terrain";

/** What a shot met, and where. */
export interface ShotTrace {
  readonly kind: "structure" | "terrain" | "none";
  readonly distance: number;
  readonly point: Vec3;
  readonly cell?: GridCell;
  readonly slot?: BuildSlot;
}

/** Half-thickness of a wall or floor slab, in metres. */
const SLAB_HALF_THICKNESS = 0.12;

/** How far the capsule may step up without jumping. */
const STEP_HEIGHT = 0.45;

interface Box {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** The solid box a wall piece occupies. Floors and interiors are walkable surfaces. */
function wallBox(cell: GridCell, slot: BuildSlot): Box | undefined {
  const base = cellToWorld(cell);
  const half = CELL_SIZE / 2;
  const cx = base.x + half;
  const cz = base.z + half;

  switch (slot) {
    case BuildSlot.NorthFace:
      return {
        minX: base.x, maxX: base.x + CELL_SIZE,
        minY: base.y, maxY: base.y + CELL_SIZE,
        minZ: base.z + CELL_SIZE - SLAB_HALF_THICKNESS,
        maxZ: base.z + CELL_SIZE + SLAB_HALF_THICKNESS,
      };
    case BuildSlot.EastFace:
      return {
        minX: base.x + CELL_SIZE - SLAB_HALF_THICKNESS,
        maxX: base.x + CELL_SIZE + SLAB_HALF_THICKNESS,
        minY: base.y, maxY: base.y + CELL_SIZE,
        minZ: base.z, maxZ: base.z + CELL_SIZE,
      };
    // South and West never appear: canonicalisation rewrites them onto the
    // neighbouring cell's North and East.
    default:
      void cx;
      void cz;
      return undefined;
  }
}

/**
 * Walkable surface height a piece offers at a world position, or undefined.
 *
 * Floors are flat, ramps rise linearly across the cell, and cones slope toward
 * a peak. Treating these as height queries rather than as solids is what makes
 * walking up a ramp feel smooth instead of catching on box corners.
 */
function surfaceHeight(piece: PlacedPiece, x: number, z: number): number | undefined {
  const base = cellToWorld(piece.cell);
  const localX = x - base.x;
  const localZ = z - base.z;
  if (localX < 0 || localX > CELL_SIZE || localZ < 0 || localZ > CELL_SIZE) return undefined;

  switch (piece.slot) {
    case BuildSlot.FloorFace:
      return base.y + SLAB_HALF_THICKNESS;
    case BuildSlot.Interior: {
      if (piece.pieceId.endsWith("ramp")) {
        // Rises one cell over one cell, so the 45 degrees is exact.
        return base.y + clamp(localZ / CELL_SIZE, 0, 1) * CELL_SIZE;
      }
      if (piece.pieceId.endsWith("cone")) {
        const u = Math.abs(localX / CELL_SIZE - 0.5) * 2;
        const v = Math.abs(localZ / CELL_SIZE - 0.5) * 2;
        return base.y + (1 - Math.max(u, v)) * CELL_SIZE;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

export class WorldCollision implements MotorCollision {
  constructor(
    private readonly field: Heightfield,
    private readonly structure: BuildStructure,
  ) {}

  /** Ground height at a position: terrain, or the highest build surface below the feet. */
  groundHeightAt(x: number, z: number, feetY: number): number {
    let best = this.field.sample(x, z);

    for (const piece of this.piecesNear(x, feetY, z)) {
      const height = surfaceHeight(piece, x, z);
      // Only surfaces at or below the feet (plus a step) can support us, or a
      // floor above the player's head would yank them upward.
      if (height !== undefined && height <= feetY + STEP_HEIGHT && height > best) {
        best = height;
      }
    }

    return best;
  }

  move(
    position: Vec3, delta: Vec3, capsuleHeight: number, capsuleRadius: number,
  ): MotorCollisionResult {
    // Resolve horizontally first, then vertically. Separating the axes keeps
    // the result predictable: a player pressed into a wall slides along it
    // rather than being ejected in an arbitrary direction.
    let x = position.x;
    let z = position.z;
    let hitWall = false;

    const tryAxis = (nextX: number, nextZ: number): boolean => {
      if (this.overlapsWall(nextX, position.y, nextZ, capsuleHeight, capsuleRadius)) return false;
      x = nextX;
      z = nextZ;
      return true;
    };

    if (!tryAxis(position.x + delta.x, z)) hitWall = true;
    if (!tryAxis(x, position.z + delta.z)) hitWall = true;

    let y = position.y + delta.y;
    const ground = this.groundHeightAt(x, z, position.y);
    let grounded = false;

    if (y <= ground) {
      y = ground;
      grounded = true;
    } else if (delta.y <= 0 && position.y - ground <= STEP_HEIGHT && y < ground + STEP_HEIGHT) {
      // Stepping down a small lip should keep the player grounded rather than
      // making them briefly airborne, which would otherwise break sprinting.
      y = ground;
      grounded = true;
    }

    const hitCeiling = this.overlapsWall(x, y + capsuleHeight, z, 0.01, capsuleRadius * 0.5);
    return { position: { x, y, z }, grounded, hitCeiling, hitWall };
  }

  private overlapsWall(
    x: number, y: number, z: number, capsuleHeight: number, capsuleRadius: number,
  ): boolean {
    const minY = y + 0.05;
    const maxY = y + Math.max(0.05, capsuleHeight);

    for (const piece of this.piecesNear(x, y, z)) {
      const box = wallBox(piece.cell, piece.slot);
      if (!box) continue;
      if (maxY <= box.minY || minY >= box.maxY) continue;
      if (
        x + capsuleRadius > box.minX && x - capsuleRadius < box.maxX &&
        z + capsuleRadius > box.minZ && z - capsuleRadius < box.maxZ
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Pieces in the cell neighbourhood of a position.
   *
   * The vertical centre is the caller's `y`. It used to be a hardcoded zero,
   * which silently capped collision at the cells within two of the world
   * origin: build a tower past about 12 m and the player walked through their
   * own walls and fell through their own floors. It never showed up because the
   * sandbox terrain sits at 6-8 m, leaving barely one cell of headroom inside
   * the window.
   */
  private *piecesNear(x: number, y: number, z: number): Generator<PlacedPiece> {
    // 45 cells by 4 slots is 180 lookups, and a shot trace does this at every
    // step along the ray. On a world with nothing built -- which is most of a
    // trace, and all of a fresh sandbox -- the answer is known without asking.
    if (this.structure.count === 0) return;

    const centre = worldToCell(x, y, z);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -2; dy <= 2; dy++) {
          const cell = { x: centre.x + dx, y: centre.y + dy, z: centre.z + dz };
          for (const slot of [
            BuildSlot.NorthFace, BuildSlot.EastFace, BuildSlot.FloorFace, BuildSlot.Interior,
          ]) {
            const piece = this.structure.get(cell, slot);
            if (piece) yield piece;
          }
        }
      }
    }
  }

  tryFindLedge(
    position: Vec3, forward: Vec3, maxHeight: number, capsuleRadius: number,
  ): Vec3 | undefined {
    const ahead = {
      x: position.x + forward.x * (capsuleRadius + 0.35),
      z: position.z + forward.z * (capsuleRadius + 0.35),
    };

    const ledgeY = this.groundHeightAt(ahead.x, ahead.z, position.y + maxHeight);
    const rise = ledgeY - position.y;
    if (rise < 0.3 || rise > maxHeight) return undefined;

    // Refuse if a wall stands between here and there, or the player would
    // mantle straight through it.
    if (this.overlapsWall(ahead.x, ledgeY, ahead.z, 1.8, capsuleRadius)) return undefined;

    return { x: ahead.x, y: ledgeY, z: ahead.z };
  }

  hasHeadroom(position: Vec3, standHeight: number, capsuleRadius: number): boolean {
    return !this.overlapsWall(position.x, position.y, position.z, standHeight, capsuleRadius * 0.95);
  }

  /**
   * The piece occupying a point, if any.
   *
   * Shared by the camera boom and the shot trace so the two cannot disagree
   * about what is solid -- a camera that clips through a wall bullets stop at
   * would be a strange kind of wrong.
   */
  pieceAt(x: number, y: number, z: number): PlacedPiece | undefined {
    for (const piece of this.piecesNear(x, y, z)) {
      const box = wallBox(piece.cell, piece.slot);
      if (box) {
        if (
          x > box.minX && x < box.maxX &&
          y > box.minY && y < box.maxY &&
          z > box.minZ && z < box.maxZ
        ) {
          return piece;
        }
        continue;
      }
      // Floors, ramps and cones are height queries rather than boxes, so
      // "inside" means below the surface they present and within their cell.
      const surface = surfaceHeight(piece, x, z);
      const base = cellToWorld(piece.cell);
      if (surface !== undefined && y < surface && y > base.y - SLAB_HALF_THICKNESS) {
        return piece;
      }
    }
    return undefined;
  }

  /**
   * March a ray until it meets terrain or a build piece.
   *
   * Marched rather than solved: the structure is a sparse map keyed by cell, so
   * stepping and asking "is there anything here" is both simpler and cheaper
   * than intersecting against every piece, and it returns the *nearest* hit by
   * construction. The step is small relative to a slab's thickness, because a
   * step longer than the thing being hit steps straight through it.
   *
   * Props are not traced here: they belong to the sandbox's scatter list rather
   * than to the collision world, and the caller tests them separately.
   */
  trace(origin: Vec3, direction: Vec3, maxDistance: number, step = 0.12): ShotTrace {
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const dx = direction.x / length;
    const dy = direction.y / length;
    const dz = direction.z / length;

    for (let travelled = step; travelled <= maxDistance; travelled += step) {
      const x = origin.x + dx * travelled;
      const y = origin.y + dy * travelled;
      const z = origin.z + dz * travelled;

      const piece = this.pieceAt(x, y, z);
      if (piece) {
        return {
          kind: "structure", distance: travelled,
          point: { x, y, z }, cell: piece.cell, slot: piece.slot,
        };
      }
      if (y <= this.field.sample(x, z)) {
        return { kind: "terrain", distance: travelled, point: { x, y, z } };
      }
    }

    return {
      kind: "none", distance: maxDistance,
      point: {
        x: origin.x + dx * maxDistance,
        y: origin.y + dy * maxDistance,
        z: origin.z + dz * maxDistance,
      },
    };
  }

  /**
   * Is this point inside a wall, a floor slab, or under the terrain?
   *
   * Used by the third-person camera boom, not by movement: the player capsule
   * needs a swept resolve, but a camera only needs to know whether a candidate
   * position is somewhere it must not sit. Cheap enough to sample along a boom
   * every frame.
   */
  isInsideSolid(x: number, y: number, z: number): boolean {
    if (y <= this.field.sample(x, z)) return true;
    return this.pieceAt(x, y, z) !== undefined;
  }

  /** Does this cell intersect terrain? Used as the build system's ground test. */
  groundTest(cell: GridCell): boolean {
    const base = cellToWorld(cell);
    // Sample the cell's corners and centre: a cell counts as grounded if the
    // terrain passes through it anywhere, which is the generous rule ADR-0006
    // specifies for sloped ground.
    const samples: readonly (readonly [number, number])[] = [
      [base.x + 0.1, base.z + 0.1],
      [base.x + CELL_SIZE - 0.1, base.z + 0.1],
      [base.x + 0.1, base.z + CELL_SIZE - 0.1],
      [base.x + CELL_SIZE - 0.1, base.z + CELL_SIZE - 0.1],
      [base.x + CELL_SIZE / 2, base.z + CELL_SIZE / 2],
    ];

    for (const [x, z] of samples) {
      const height = this.field.sample(x, z);
      if (height >= base.y && height <= base.y + CELL_SIZE) return true;
    }
    return false;
  }
}

export { parsePieceKey };
