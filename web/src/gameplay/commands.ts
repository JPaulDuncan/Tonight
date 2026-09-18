/**
 * The command layer.
 *
 * Every simulation state change goes through a command (ADR-0003). Nothing
 * mutates gameplay state inline, no simulation code reads input, and no
 * simulation code reads a wall clock -- `deltaTime` travels in the command.
 *
 * At single-player a local executor applies commands directly; when networking
 * lands the same commands become the wire format and `validate` is the method
 * the server calls. Most multiplayer retrofits fail because validation gets
 * written twice and the copies drift; sharing one implementation is the
 * structural guard against that.
 */

import type { Vec2 } from "@/core/math";
import { clampMagnitude2 } from "@/core/math";
import type { BuildSlot, GridCell } from "@/core/grid";

export const MoveFlags = {
  None: 0,
  Jump: 1 << 0,
  Sprint: 1 << 1,
  Crouch: 1 << 2,
  Interact: 1 << 3,
} as const;

export type MoveFlag = number;

export interface MoveCommand {
  readonly tick: number;
  readonly moveInput: Vec2;
  readonly lookDelta: Vec2;
  readonly flags: MoveFlag;
  readonly deltaTime: number;
}

export function moveCommand(
  tick: number,
  moveInput: Vec2,
  lookDelta: Vec2,
  flags: MoveFlag,
  deltaTime: number,
): MoveCommand {
  return {
    tick,
    // Clamped at the edge so a malformed or hostile client cannot ask for a
    // movement magnitude above 1, and so diagonals are not faster.
    moveInput: clampMagnitude2(moveInput, 1),
    lookDelta,
    flags,
    deltaTime,
  };
}

export function hasFlag(command: MoveCommand, flag: number): boolean {
  return (command.flags & flag) !== 0;
}

/**
 * Server-side sanity check on the command itself, before simulating it.
 * A deltaTime outside the plausible band is either a broken client or an
 * attempt to simulate extra movement in one tick.
 */
export function isPlausible(command: MoveCommand, expectedDt: number): boolean {
  return (
    command.deltaTime > 0 &&
    command.deltaTime <= expectedDt * 2 &&
    Number.isFinite(command.moveInput.x) &&
    Number.isFinite(command.moveInput.y)
  );
}

/** Why a placement was refused. Drives both rollback and telemetry. */
export enum PlacementRejection {
  None = "none",
  Unaffordable = "unaffordable",
  SlotOccupied = "slotOccupied",
  Unsupported = "unsupported",
  OutOfRange = "outOfRange",
  IntersectsPlayer = "intersectsPlayer",
  RateLimited = "rateLimited",
  OutOfWireRange = "outOfWireRange",
  Malformed = "malformed",
}

export interface PlaceBuildCommand {
  readonly playerId: number;
  readonly tick: number;
  readonly cell: GridCell;
  readonly slot: BuildSlot;
  readonly pieceId: string;
  readonly materialId: string;
}

/**
 * Server-side placement budget, far above any achievable human input rate.
 * A sanity check against automation, not a gameplay throttle -- a real throttle
 * here would violate the rule that editing must never be rate-limited.
 */
export const MAX_PLACEMENTS_PER_SECOND = 12;
