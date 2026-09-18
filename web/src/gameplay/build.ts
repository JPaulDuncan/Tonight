/**
 * The build system. The pillar.
 *
 * Owns the structure graph, placement validation, the build-HP ramp, and
 * structural collapse. The same class is the authoritative state on a server
 * and the predicted state on a client, running the same validation, because
 * ADR-0003 rule 4 requires prediction and authority to share one implementation
 * rather than two that can drift.
 */

import type {
  BuildMaterialBlueprint,
  BuildPieceBlueprint,
  EditVariant,
} from "@/blueprints/types";
import type { BlueprintRegistry } from "@/blueprints/registry";
import { packMask, SOLID_MASK } from "@/blueprints/registry";
import {
  ALL_SLOTS,
  BuildSlot,
  CELL_SIZE,
  MAX_PLACE_DISTANCE,
  canonicalise,
  cellCentre,
  isWireRepresentable,
  offsetCell,
  parsePieceKey,
  pieceKey,
  slotAnchor,
  slotRotationY,
  worldToCell,
  type GridCell,
} from "@/core/grid";
import { clamp01, distance3, lerp, normalise3, vec3, type Vec3 } from "@/core/math";
import { MAX_PLACEMENTS_PER_SECOND, PlacementRejection, type PlaceBuildCommand } from "./commands";

/** Sentinel support distance meaning "no path to ground". */
export const UNSUPPORTED = Number.MAX_SAFE_INTEGER;

/**
 * Delay between losing support and being destroyed.
 *
 * Both a design choice -- the player sees the tower fall, so it reads as a
 * consequence -- and a performance one: it lets a large cascade be spread
 * across ticks instead of landing in one.
 */
export const COLLAPSE_DELAY_SECONDS = 0.4;

/** Cap so a mega-build's collapse cannot spike a single tick past budget. */
export const MAX_COLLAPSES_PER_TICK = 32;

export interface PlacedPiece {
  cell: GridCell;
  slot: BuildSlot;
  pieceId: string;
  materialId: string;
  ownerId: number;
  placedTick: number;
  /**
   * Accumulated damage rather than current health.
   *
   * Storing damage is what lets the build-HP ramp keep running after a piece is
   * shot: a wall that survives a burst goes on maturing toward full health
   * rather than freezing at what it had left.
   */
  damageTaken: number;
  editMask: number;
}

export type StructureEventKind = "placed" | "damaged" | "destroyed" | "collapsed" | "edited";

export interface StructureEvent {
  readonly kind: StructureEventKind;
  readonly key: string;
  readonly cell: GridCell;
  readonly slot: BuildSlot;
}

/** Does this cell intersect terrain? Injected so the graph is testable. */
export type GroundTest = (cell: GridCell) => boolean;

/**
 * The structure graph: every placed piece and the support relation between them.
 */
export class BuildStructure {
  private readonly pieces = new Map<string, PlacedPiece>();
  private readonly support = new Map<string, number>();

  constructor(public touchesGround: GroundTest = () => false) {}

  get count(): number {
    return this.pieces.size;
  }

  keys(): IterableIterator<string> {
    return this.pieces.keys();
  }

  all(): IterableIterator<PlacedPiece> {
    return this.pieces.values();
  }

  isOccupied(cell: GridCell, slot: BuildSlot): boolean {
    return this.pieces.has(pieceKey(cell, slot));
  }

  get(cell: GridCell, slot: BuildSlot): PlacedPiece | undefined {
    return this.pieces.get(pieceKey(cell, slot));
  }

  getByKey(key: string): PlacedPiece | undefined {
    return this.pieces.get(key);
  }

  supportDistance(cell: GridCell, slot: BuildSlot): number {
    return this.support.get(pieceKey(cell, slot)) ?? UNSUPPORTED;
  }

  /** Add a piece. The caller must have validated placement first. */
  tryAdd(piece: PlacedPiece): boolean {
    const canon = canonicalise(piece.cell, piece.slot);
    const key = pieceKey(piece.cell, piece.slot);
    if (this.pieces.has(key)) return false;

    const stored: PlacedPiece = {
      ...piece,
      cell: canon.cell,
      slot: canon.slot,
      editMask: piece.editMask === 0 ? SOLID_MASK : piece.editMask,
    };
    this.pieces.set(key, stored);
    this.support.set(key, this.computeSupport(key));

    // A new piece can shorten its neighbours' path to ground, so they need
    // re-evaluating. Without this, a piece placed beneath an unsupported stack
    // would not rescue it.
    this.refreshNeighbourhood(key);
    return true;
  }

  /** Overwrite a piece in place, keeping its cached support distance. */
  replace(piece: PlacedPiece): boolean {
    const key = pieceKey(piece.cell, piece.slot);
    if (!this.pieces.has(key)) return false;
    const canon = canonicalise(piece.cell, piece.slot);
    this.pieces.set(key, { ...piece, cell: canon.cell, slot: canon.slot });
    return true;
  }

  /** Remove a piece and return every piece that lost its support as a result. */
  tryRemove(cell: GridCell, slot: BuildSlot): { removed: boolean; collapsed: string[] } {
    const key = pieceKey(cell, slot);
    if (!this.pieces.delete(key)) return { removed: false, collapsed: [] };
    this.support.delete(key);

    this.recomputeSupport();
    const collapsed: string[] = [];
    for (const [otherKey, distance] of this.support) {
      if (distance === UNSUPPORTED) collapsed.push(otherKey);
    }
    return { removed: true, collapsed };
  }

  /** True when a piece placed here would have something to attach to. */
  wouldBeSupported(cell: GridCell, slot: BuildSlot): boolean {
    return this.computeSupport(pieceKey(cell, slot)) !== UNSUPPORTED;
  }

  /** Multi-source BFS outward from every ground-touching piece. */
  recomputeSupport(): void {
    const queue: string[] = [];

    for (const key of this.pieces.keys()) {
      const { cell } = parsePieceKey(key);
      if (this.touchesGround(cell)) {
        this.support.set(key, 0);
        queue.push(key);
      } else {
        this.support.set(key, UNSUPPORTED);
      }
    }

    let head = 0;
    while (head < queue.length) {
      const current = queue[head++]!;
      const next = (this.support.get(current) ?? UNSUPPORTED) + 1;
      for (const neighbour of this.neighbours(current)) {
        if ((this.support.get(neighbour) ?? UNSUPPORTED) <= next) continue;
        this.support.set(neighbour, next);
        queue.push(neighbour);
      }
    }
  }

  private computeSupport(key: string): number {
    const { cell } = parsePieceKey(key);
    if (this.touchesGround(cell)) return 0;

    let best = UNSUPPORTED;
    for (const neighbour of this.neighbours(key)) {
      const distance = this.support.get(neighbour) ?? UNSUPPORTED;
      if (distance !== UNSUPPORTED && distance + 1 < best) best = distance + 1;
    }
    return best;
  }

  /**
   * Propagate a newly improved support distance outward from `origin`.
   *
   * The queue is seeded with the origin's NEIGHBOURS, not the origin itself.
   * The origin's own distance was already computed by the caller, so
   * re-examining it would find no improvement and the loop would exit before
   * reaching anything -- which left a rebuilt leg failing to rescue the stack
   * above it. Each dequeued node is re-evaluated, and only an actual
   * improvement enqueues its neighbours, so the walk still terminates.
   */
  private refreshNeighbourhood(origin: string): void {
    const queue: string[] = [];
    const queued = new Set<string>([origin]);

    for (const neighbour of this.neighbours(origin)) {
      if (!queued.has(neighbour)) {
        queued.add(neighbour);
        queue.push(neighbour);
      }
    }

    let head = 0;
    while (head < queue.length) {
      const current = queue[head++]!;
      queued.delete(current);
      if (!this.pieces.has(current)) continue;

      const recomputed = this.computeSupport(current);
      if (recomputed >= (this.support.get(current) ?? UNSUPPORTED)) continue;

      this.support.set(current, recomputed);
      for (const neighbour of this.neighbours(current)) {
        if (this.pieces.has(neighbour) && !queued.has(neighbour)) {
          queued.add(neighbour);
          queue.push(neighbour);
        }
      }
    }
  }

  /**
   * Every placed piece that could structurally connect to this one.
   *
   * The relation is deliberately generous: any piece in the same cell, and any
   * piece in the six orthogonally adjacent cells. Being generous means
   * structures collapse less eagerly than a strict geometric adjacency test
   * would produce, which reads better than a tower falling on a technicality.
   */
  private *neighbours(key: string): Generator<string> {
    const { cell, slot } = parsePieceKey(key);

    for (const other of ALL_SLOTS) {
      if (other === slot) continue;
      const candidate = pieceKey(cell, other);
      if (this.pieces.has(candidate)) yield candidate;
    }

    const offsets: readonly (readonly [number, number, number])[] = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ];
    for (const [dx, dy, dz] of offsets) {
      const neighbourCell = offsetCell(cell, dx, dy, dz);
      for (const other of ALL_SLOTS) {
        const candidate = pieceKey(neighbourCell, other);
        if (candidate !== key && this.pieces.has(candidate)) yield candidate;
      }
    }
  }

  clear(): void {
    this.pieces.clear();
    this.support.clear();
  }
}

/** A player's wood/stone/metal counts. */
export class MaterialWallet {
  private readonly counts = new Map<string, number>();

  get(materialId: string): number {
    return this.counts.get(materialId) ?? 0;
  }

  /**
   * Add materials, clamped to the carry cap. Returns how much was actually
   * gained: harvesting at cap still damages the object, so the yield and the
   * gain are genuinely different numbers.
   */
  add(material: BuildMaterialBlueprint, amount: number): number {
    if (amount <= 0) return 0;
    const current = this.get(material.id);
    const gained = Math.min(amount, Math.max(0, material.maxCarried - current));
    this.counts.set(material.id, current + gained);
    return gained;
  }

  canAfford(materialId: string, cost: number): boolean {
    return this.get(materialId) >= cost;
  }

  trySpend(materialId: string, cost: number): boolean {
    if (cost <= 0) return true;
    if (!this.canAfford(materialId, cost)) return false;
    this.counts.set(materialId, this.get(materialId) - cost);
    return true;
  }

  /**
   * Return materials after a rejected placement.
   *
   * Deliberately not clamped to the cap: a refund restores exactly what was
   * deducted, or a player at cap would lose materials by having a placement
   * rejected.
   */
  refund(materialId: string, amount: number): void {
    if (amount <= 0) return;
    this.counts.set(materialId, this.get(materialId) + amount);
  }

  isAtCap(material: BuildMaterialBlueprint): boolean {
    return this.get(material.id) >= material.maxCarried;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  clear(): void {
    this.counts.clear();
  }
}

export interface PlacementTarget {
  readonly cell: GridCell;
  readonly slot: BuildSlot;
  readonly found: boolean;
}

const NO_TARGET: PlacementTarget = { cell: { x: 0, y: 0, z: 0 }, slot: BuildSlot.Interior, found: false };

/**
 * How many cells to step along the view direction looking for a free slot.
 *
 * Two is what makes building against an existing wall feel right rather than
 * silently failing; more would place pieces surprisingly far from the aim point.
 */
export const MAX_OCCUPANCY_STEPS = 2;

/** The slot a piece would occupy, given a view direction. */
export function slotForPiece(piece: BuildPieceBlueprint, direction: Vec3): BuildSlot {
  switch (piece.placement) {
    case "wall": {
      const dir = normalise3(direction);
      return Math.abs(dir.x) >= Math.abs(dir.z)
        ? dir.x >= 0 ? BuildSlot.WestFace : BuildSlot.EastFace
        : dir.z >= 0 ? BuildSlot.SouthFace : BuildSlot.NorthFace;
    }
    case "floor":
      return BuildSlot.FloorFace;
    default:
      return BuildSlot.Interior;
  }
}

/** Advance one cell along the dominant axis of the view direction. */
export function stepCell(
  cell: GridCell, direction: Vec3, placement: BuildPieceBlueprint["placement"],
): GridCell {
  if (placement === "floor") return offsetCell(cell, 0, direction.y >= 0 ? 1 : -1, 0);
  return Math.abs(direction.x) >= Math.abs(direction.z)
    ? offsetCell(cell, direction.x >= 0 ? 1 : -1, 0, 0)
    : offsetCell(cell, 0, 0, direction.z >= 0 ? 1 : -1);
}

/**
 * Turn where a player is looking into a (cell, slot) to build at.
 *
 * Pure, so the placement rules can be tested exhaustively without a camera.
 * Pillar 1 requires a player to predict where a piece will land without looking
 * at the preview, and "predictable" is a property worth testing.
 *
 * Works from the camera rather than the crosshair hitting geometry: raycasting
 * to find a surface fails in open air, and building in open air is normal.
 */
export function resolvePlacement(
  cameraOrigin: Vec3,
  viewDirection: Vec3,
  surfaceDistance: number,
  piece: BuildPieceBlueprint | undefined,
  structure: BuildStructure,
  playerFeetY: number,
): PlacementTarget {
  if (!piece) return NO_TARGET;

  const direction = normalise3(viewDirection);
  if (direction.x === 0 && direction.y === 0 && direction.z === 0) return NO_TARGET;

  const distance = surfaceDistance >= 0
    ? Math.min(surfaceDistance, MAX_PLACE_DISTANCE)
    : MAX_PLACE_DISTANCE;

  const aim = {
    x: cameraOrigin.x + direction.x * distance,
    // Floors go at the player's own height, not wherever they are looking:
    // building a floor under yourself is the common case and must not depend
    // on pitch.
    y: piece.placement === "floor" ? playerFeetY : cameraOrigin.y + direction.y * distance,
    z: cameraOrigin.z + direction.z * distance,
  };

  let cell = worldToCell(aim.x, aim.y, aim.z);
  const slot = slotForPiece(piece, direction);

  for (let step = 0; step <= MAX_OCCUPANCY_STEPS; step++) {
    if (!structure.isOccupied(cell, slot)) return { cell, slot, found: true };
    cell = stepCell(cell, direction, piece.placement);
  }

  return NO_TARGET;
}

/**
 * World transform for a resolved target.
 *
 * Both the preview ghost and the placed piece must use this. A preview computed
 * differently from the placed result is the specific failure pillar 1 forbids.
 */
export function placementTransform(target: PlacementTarget): { position: Vec3; rotationY: number } {
  return { position: slotAnchor(target.cell, target.slot), rotationY: slotRotationY(target.slot) };
}

/** Which of the 3x3 sub-cells a point on a piece's face falls in. */
export function subCellIndex(localX: number, localY: number): number {
  const column = Math.min(2, Math.max(0, Math.floor(localX * 3)));
  const rowFromBottom = Math.min(2, Math.max(0, Math.floor(localY * 3)));
  // Index 0 is TOP-left, matching how a designer reads the grid. Inverting this
  // produces upside-down doorways that look almost right.
  return (2 - rowFromBottom) * 3 + column;
}

export function toggleMaskBit(mask: number, index: number): number {
  if (index < 0 || index > 8) return mask;
  return mask ^ (1 << index);
}

export function isMaskBitSet(mask: number, index: number): boolean {
  return index >= 0 && index <= 8 && (mask & (1 << index)) !== 0;
}

/** Find the authored variant matching a mask, or undefined when it should revert. */
export function variantForMask(
  piece: BuildPieceBlueprint, mask: number,
): EditVariant | undefined {
  if (mask === SOLID_MASK) return undefined;
  return piece.editVariants.find((v) => packMask(v.gridMask) === mask);
}

/** The world a placement is validated against. */
export interface PlacementWorld {
  readonly structure: BuildStructure;
  materialCount(playerId: number, materialId: string): number;
  distanceFromPlayer(playerId: number, cell: GridCell): number;
  wouldIntersectLivingPlayer(cell: GridCell, slot: BuildSlot, placingPlayerId: number): boolean;
  recentPlacementCount(playerId: number): number;
}

/**
 * Pure placement validation. Runs identically on client and server.
 *
 * `enforceRateLimit` is true on the server only: the limit is a sanity check
 * against automation, and applying it client-side would make a legitimately
 * fast builder mispredict.
 */
export function validatePlacement(
  command: PlaceBuildCommand,
  world: PlacementWorld,
  registry: BlueprintRegistry,
  enforceRateLimit: boolean,
): PlacementRejection {
  const piece = registry.tryGet<BuildPieceBlueprint>(command.pieceId);
  const material = registry.tryGet<BuildMaterialBlueprint>(command.materialId);
  if (!piece || !material) return PlacementRejection.Malformed;
  if (!isWireRepresentable(command.cell)) return PlacementRejection.OutOfWireRange;

  const cost = placementCost(piece, material);
  if (world.materialCount(command.playerId, command.materialId) < cost) {
    return PlacementRejection.Unaffordable;
  }
  if (world.structure.isOccupied(command.cell, command.slot)) {
    return PlacementRejection.SlotOccupied;
  }
  if (world.distanceFromPlayer(command.playerId, command.cell) > MAX_PLACE_DISTANCE) {
    return PlacementRejection.OutOfRange;
  }
  if (!world.structure.wouldBeSupported(command.cell, command.slot)) {
    return PlacementRejection.Unsupported;
  }
  // The placing player is excluded: building a floor under yourself is legal.
  // Other players are not, so nobody can be trapped inside geometry.
  if (world.wouldIntersectLivingPlayer(command.cell, command.slot, command.playerId)) {
    return PlacementRejection.IntersectsPlayer;
  }
  if (enforceRateLimit && world.recentPlacementCount(command.playerId) >= MAX_PLACEMENTS_PER_SECOND) {
    return PlacementRejection.RateLimited;
  }
  return PlacementRejection.None;
}

export function placementCost(
  piece: BuildPieceBlueprint, material: BuildMaterialBlueprint,
): number {
  return piece.costOverride >= 0 ? piece.costOverride : material.costPerPiece;
}

/** Health of a material at a given age, following the build ramp. */
export function healthAtAge(material: BuildMaterialBlueprint, ageSeconds: number): number {
  if (ageSeconds <= 0) return material.buildHealth;
  if (ageSeconds >= material.buildTimeSeconds) return material.fullHealth;
  return lerp(material.buildHealth, material.fullHealth, ageSeconds / material.buildTimeSeconds);
}

/** Owns the structure and the rules that change it. */
export class BuildWorld implements PlacementWorld {
  readonly structure: BuildStructure;

  private readonly collapseAt = new Map<string, number>();
  private readonly wallets = new Map<number, MaterialWallet>();
  private readonly playerPositions = new Map<number, Vec3>();
  private readonly recentPlacements = new Map<number, number[]>();
  private readonly listeners: ((event: StructureEvent) => void)[] = [];

  constructor(
    private readonly registry: BlueprintRegistry,
    private readonly tickRate = 30,
    groundTest: GroundTest = (cell) => cell.y === 0,
  ) {
    this.structure = new BuildStructure(groundTest);
  }

  /** Overlap test for the player-intersection rule. Defaults to "nothing in the way". */
  playerOverlapTest: (cell: GridCell, slot: BuildSlot, placingPlayerId: number) => boolean =
    () => false;

  onChanged(listener: (event: StructureEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(kind: StructureEventKind, cell: GridCell, slot: BuildSlot): void {
    const event: StructureEvent = { kind, key: pieceKey(cell, slot), cell, slot };
    for (const listener of this.listeners) listener(event);
  }

  wallet(playerId: number): MaterialWallet {
    let found = this.wallets.get(playerId);
    if (!found) {
      found = new MaterialWallet();
      this.wallets.set(playerId, found);
    }
    return found;
  }

  setPlayerPosition(playerId: number, position: Vec3): void {
    this.playerPositions.set(playerId, { ...position });
  }

  materialCount(playerId: number, materialId: string): number {
    return this.wallet(playerId).get(materialId);
  }

  distanceFromPlayer(playerId: number, cell: GridCell): number {
    const position = this.playerPositions.get(playerId);
    // Unknown player: report out of range, so a missing registration fails closed.
    if (!position) return Number.MAX_VALUE;
    return distance3(position, cellCentre(cell));
  }

  wouldIntersectLivingPlayer(cell: GridCell, slot: BuildSlot, placingPlayerId: number): boolean {
    return this.playerOverlapTest(cell, slot, placingPlayerId);
  }

  recentPlacementCount(playerId: number): number {
    return this.recentPlacements.get(playerId)?.length ?? 0;
  }

  /** Validate and apply a placement. */
  tryPlace(
    command: PlaceBuildCommand, tick: number, enforceRateLimit: boolean,
  ): PlacementRejection {
    const rejection = validatePlacement(command, this, this.registry, enforceRateLimit);
    if (rejection !== PlacementRejection.None) return rejection;

    const piece = this.registry.buildPiece(command.pieceId);
    const material = this.registry.buildMaterial(command.materialId);
    const cost = placementCost(piece, material);

    const wallet = this.wallet(command.playerId);
    if (!wallet.trySpend(command.materialId, cost)) return PlacementRejection.Unaffordable;

    const added = this.structure.tryAdd({
      cell: command.cell,
      slot: command.slot,
      pieceId: command.pieceId,
      materialId: command.materialId,
      ownerId: command.playerId,
      placedTick: tick,
      damageTaken: 0,
      editMask: SOLID_MASK,
    });

    if (!added) {
      // Slot was taken between check and apply. Refund exactly.
      wallet.refund(command.materialId, cost);
      return PlacementRejection.SlotOccupied;
    }

    this.recordPlacement(command.playerId, tick);
    this.emit("placed", command.cell, command.slot);
    // A new piece can restore support to an orphaned stack above it.
    this.clearRescuedCollapses();
    return PlacementRejection.None;
  }

  /** Roll back a predicted placement the server rejected. */
  rollback(command: PlaceBuildCommand): void {
    this.structure.tryRemove(command.cell, command.slot);
    const piece = this.registry.tryGet<BuildPieceBlueprint>(command.pieceId);
    const material = this.registry.tryGet<BuildMaterialBlueprint>(command.materialId);
    if (piece && material) {
      this.wallet(command.playerId).refund(command.materialId, placementCost(piece, material));
    }
  }

  /** Current health of a piece, accounting for the build ramp and any edit. */
  healthOf(piece: PlacedPiece, currentTick: number): number {
    const material = this.registry.tryGet<BuildMaterialBlueprint>(piece.materialId);
    if (!material) return 0;

    const age = Math.max(0, currentTick - piece.placedTick) / this.tickRate;
    const pieceBlueprint = this.registry.tryGet<BuildPieceBlueprint>(piece.pieceId);
    const scale = pieceBlueprint
      ? (variantForMask(pieceBlueprint, piece.editMask)?.healthScale ?? 1)
      : 1;

    return healthAtAge(material, age) * scale - piece.damageTaken;
  }

  healthAt(cell: GridCell, slot: BuildSlot, tick: number): number | undefined {
    const piece = this.structure.get(cell, slot);
    return piece ? this.healthOf(piece, tick) : undefined;
  }

  /** Damage a piece. Returns true when it was destroyed. */
  applyDamage(cell: GridCell, slot: BuildSlot, amount: number, tick: number): boolean {
    if (amount <= 0) return false;
    const piece = this.structure.get(cell, slot);
    if (!piece) return false;

    piece.damageTaken += amount;
    this.structure.replace(piece);

    if (this.healthOf(piece, tick) > 0) {
      this.emit("damaged", cell, slot);
      return false;
    }

    this.destroy(cell, slot, tick, "destroyed");
    return true;
  }

  private destroy(cell: GridCell, slot: BuildSlot, tick: number, kind: StructureEventKind): void {
    const { removed, collapsed } = this.structure.tryRemove(cell, slot);
    if (!removed) return;

    this.emit(kind, cell, slot);

    const collapseTick = tick + Math.ceil(COLLAPSE_DELAY_SECONDS * this.tickRate);
    for (const key of collapsed) {
      // Keep the earliest scheduled time: a piece already falling should not
      // have its collapse postponed by a later event.
      const existing = this.collapseAt.get(key);
      if (existing === undefined || collapseTick < existing) this.collapseAt.set(key, collapseTick);
    }
  }

  /** Apply an edit, keeping the piece's accumulated damage. */
  tryEdit(cell: GridCell, slot: BuildSlot, mask: number, editingPlayerId: number): boolean {
    const piece = this.structure.get(cell, slot);
    if (!piece) return false;
    // Only the owner may edit. A captured structure stays enemy-owned and must
    // be destroyed, not repurposed.
    if (piece.ownerId !== editingPlayerId) return false;
    if (mask === piece.editMask) return false;

    const blueprint = this.registry.tryGet<BuildPieceBlueprint>(piece.pieceId);
    if (!blueprint) return false;
    if (mask !== SOLID_MASK && !variantForMask(blueprint, mask)) return false;

    // Damage carries across an edit rather than resetting. Otherwise editing a
    // wall would be a free repair and players under fire would edit-spam.
    piece.editMask = mask;
    const ok = this.structure.replace(piece);
    if (ok) this.emit("edited", cell, slot);
    return ok;
  }

  /** Advance one tick: expire rate history and process due collapses. */
  tick(tick: number): void {
    this.expirePlacementHistory(tick);
    this.processCollapses(tick);
  }

  get pendingCollapseCount(): number {
    return this.collapseAt.size;
  }

  private processCollapses(tick: number): void {
    if (this.collapseAt.size === 0) return;

    const due: string[] = [];
    for (const [key, at] of this.collapseAt) {
      if (at <= tick) {
        due.push(key);
        // The rest wait for the next tick. A mega-build's collapse may take
        // several ticks; spiking one tick past the budget is not allowed.
        if (due.length >= MAX_COLLAPSES_PER_TICK) break;
      }
    }

    for (const key of due) {
      this.collapseAt.delete(key);
      const { cell, slot } = parsePieceKey(key);
      if (this.structure.isOccupied(cell, slot)) this.destroy(cell, slot, tick, "collapsed");
    }
  }

  /**
   * Drop scheduled collapses for pieces that have regained support.
   *
   * Building a leg back under an orphaned stack within the delay window should
   * save it, or the game would be ignoring what the player just did.
   */
  private clearRescuedCollapses(): void {
    if (this.collapseAt.size === 0) return;
    for (const key of [...this.collapseAt.keys()]) {
      const { cell, slot } = parsePieceKey(key);
      if (this.structure.isOccupied(cell, slot) &&
          this.structure.supportDistance(cell, slot) !== UNSUPPORTED) {
        this.collapseAt.delete(key);
      }
    }
  }

  private recordPlacement(playerId: number, tick: number): void {
    const ticks = this.recentPlacements.get(playerId) ?? [];
    ticks.push(tick);
    this.recentPlacements.set(playerId, ticks);
  }

  private expirePlacementHistory(tick: number): void {
    const cutoff = tick - this.tickRate;
    for (const [playerId, ticks] of this.recentPlacements) {
      this.recentPlacements.set(playerId, ticks.filter((t) => t >= cutoff));
    }
  }

  clear(): void {
    this.structure.clear();
    this.collapseAt.clear();
    this.wallets.clear();
    this.playerPositions.clear();
    this.recentPlacements.clear();
  }
}

export { CELL_SIZE, SOLID_MASK, clamp01, vec3 };
