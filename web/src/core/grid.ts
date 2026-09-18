/**
 * The absolute build grid (ADR-0006).
 *
 * Aligned to world origin and shared by every player, so two people building in
 * the same area produce interlocking geometry rather than overlapping geometry.
 * Cell coordinates are also the network wire format for build pieces
 * (ADR-0002), which is why they are int16-ranged.
 */

/** Cell size in metres. A wall is one cell face; a ramp rises exactly one cell. */
export const CELL_SIZE = 4;

/** Maximum distance from the player at which a piece may be placed. */
export const MAX_PLACE_DISTANCE = 10;

/** An integer coordinate in the build grid. */
export interface GridCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function cell(x: number, y: number, z: number): GridCell {
  return { x, y, z };
}

export function cellEquals(a: GridCell, b: GridCell): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

export function offsetCell(c: GridCell, dx: number, dy: number, dz: number): GridCell {
  return { x: c.x + dx, y: c.y + dy, z: c.z + dz };
}

export function cellToString(c: GridCell): string {
  return `(${c.x},${c.y},${c.z})`;
}

/**
 * True when the cell fits the int16 wire format. Cells outside this range
 * cannot be replicated, so placement must reject them.
 */
export function isWireRepresentable(c: GridCell): boolean {
  const ok = (v: number) => Number.isInteger(v) && v >= -32768 && v <= 32767;
  return ok(c.x) && ok(c.y) && ok(c.z);
}

/**
 * Which part of a cell a build piece occupies.
 *
 * At most one piece per (cell, slot), so a single cell can hold four walls, a
 * floor, and one interior piece: exactly a 1x1 box with a ramp inside it.
 * Ramps and cones share `Interior`, so placing one replaces the other.
 */
export enum BuildSlot {
  NorthFace = 0,
  EastFace = 1,
  SouthFace = 2,
  WestFace = 3,
  FloorFace = 4,
  Interior = 5,
}

export const ALL_SLOTS: readonly BuildSlot[] = [
  BuildSlot.NorthFace,
  BuildSlot.EastFace,
  BuildSlot.SouthFace,
  BuildSlot.WestFace,
  BuildSlot.FloorFace,
  BuildSlot.Interior,
];

export function isVerticalFace(slot: BuildSlot): boolean {
  return (
    slot === BuildSlot.NorthFace ||
    slot === BuildSlot.EastFace ||
    slot === BuildSlot.SouthFace ||
    slot === BuildSlot.WestFace
  );
}

/**
 * The cardinal face whose normal most opposes a view direction.
 *
 * Only the horizontal component matters, so a player looking down at a wall
 * still gets the wall they are facing.
 */
export function faceFacing(dirX: number, dirZ: number): BuildSlot {
  if (Math.abs(dirX) >= Math.abs(dirZ)) {
    return dirX >= 0 ? BuildSlot.WestFace : BuildSlot.EastFace;
  }
  return dirZ >= 0 ? BuildSlot.SouthFace : BuildSlot.NorthFace;
}

/** World position of a cell's minimum corner. */
export function cellToWorld(c: GridCell): { x: number; y: number; z: number } {
  return { x: c.x * CELL_SIZE, y: c.y * CELL_SIZE, z: c.z * CELL_SIZE };
}

/** World position of a cell's centre. */
export function cellCentre(c: GridCell): { x: number; y: number; z: number } {
  const half = CELL_SIZE / 2;
  return { x: c.x * CELL_SIZE + half, y: c.y * CELL_SIZE + half, z: c.z * CELL_SIZE + half };
}

/**
 * The cell containing a world position.
 *
 * Uses floor rather than truncation so that negative coordinates quantise
 * consistently. Truncation would make the cell straddling the origin twice as
 * wide as every other cell, which is the kind of bug that only shows up on one
 * corner of the map.
 */
export function worldToCell(x: number, y: number, z: number): GridCell {
  return {
    x: Math.floor(x / CELL_SIZE),
    y: Math.floor(y / CELL_SIZE),
    z: Math.floor(z / CELL_SIZE),
  };
}

/**
 * World position of the anchor point of a (cell, slot) pair: the centre of a
 * face for face slots, the cell centre for interior slots.
 */
export function slotAnchor(c: GridCell, slot: BuildSlot): { x: number; y: number; z: number } {
  const centre = cellCentre(c);
  const half = CELL_SIZE / 2;

  switch (slot) {
    case BuildSlot.NorthFace:
      return { ...centre, z: centre.z + half };
    case BuildSlot.EastFace:
      return { ...centre, x: centre.x + half };
    case BuildSlot.SouthFace:
      return { ...centre, z: centre.z - half };
    case BuildSlot.WestFace:
      return { ...centre, x: centre.x - half };
    case BuildSlot.FloorFace:
      return { ...centre, y: centre.y - half };
    default:
      return centre;
  }
}

/**
 * Y rotation in radians for a piece in a given slot, so a single mesh authored
 * facing +Z serves all four wall faces.
 */
export function slotRotationY(slot: BuildSlot): number {
  switch (slot) {
    case BuildSlot.NorthFace:
      return 0;
    case BuildSlot.EastFace:
      return Math.PI / 2;
    case BuildSlot.SouthFace:
      return Math.PI;
    case BuildSlot.WestFace:
      return (3 * Math.PI) / 2;
    default:
      return 0;
  }
}

/** The cell on the far side of a face slot. */
export function neighbourAcross(c: GridCell, slot: BuildSlot): GridCell {
  switch (slot) {
    case BuildSlot.NorthFace:
      return offsetCell(c, 0, 0, 1);
    case BuildSlot.EastFace:
      return offsetCell(c, 1, 0, 0);
    case BuildSlot.SouthFace:
      return offsetCell(c, 0, 0, -1);
    case BuildSlot.WestFace:
      return offsetCell(c, -1, 0, 0);
    case BuildSlot.FloorFace:
      return offsetCell(c, 0, -1, 0);
    default:
      return c;
  }
}

/**
 * Maps a (cell, slot) to its canonical representation, so the two equivalent
 * ways of naming a shared face resolve to one key.
 *
 * Two adjacent cells share a face: a wall on the north face of cell C is the
 * same physical wall as one on the south face of C's north neighbour. Without
 * this, two players building on opposite sides of the same boundary would each
 * succeed and produce coincident, double-health geometry.
 */
export function canonicalise(c: GridCell, slot: BuildSlot): { cell: GridCell; slot: BuildSlot } {
  switch (slot) {
    case BuildSlot.SouthFace:
      return { cell: offsetCell(c, 0, 0, -1), slot: BuildSlot.NorthFace };
    case BuildSlot.WestFace:
      return { cell: offsetCell(c, -1, 0, 0), slot: BuildSlot.EastFace };
    default:
      return { cell: c, slot };
  }
}

/** A stable string key for a canonicalised (cell, slot) pair. */
export function pieceKey(c: GridCell, slot: BuildSlot): string {
  const canon = canonicalise(c, slot);
  return `${canon.cell.x},${canon.cell.y},${canon.cell.z}:${canon.slot}`;
}

/** Recover a (cell, slot) from a key produced by {@link pieceKey}. */
export function parsePieceKey(key: string): { cell: GridCell; slot: BuildSlot } {
  const [coords, slot] = key.split(":");
  const parts = (coords ?? "").split(",").map(Number);
  return {
    cell: { x: parts[0] ?? 0, y: parts[1] ?? 0, z: parts[2] ?? 0 },
    slot: Number(slot ?? 0) as BuildSlot,
  };
}
