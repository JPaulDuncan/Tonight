/**
 * Harvesting: the pump that feeds building.
 *
 * The weak point is the skill expression, and it is why harvesting is an
 * activity rather than a hold-to-fill bar. Its position derives from
 * (objectId, hitCount), which both sides already know, so client and server
 * agree without replicating anything per swing.
 */

import type { HarvestableBlueprint } from "@/blueprints/types";
import { Rng } from "@/core/rng";
import { distance2, type Vec2 } from "@/core/math";

/**
 * How close a hit must be to the marker, in normalised surface units.
 * Generous on purpose: this is a feel mechanic, not an accuracy test.
 */
export const WEAK_POINT_RADIUS = 0.25;

export interface HarvestState {
  readonly objectId: number;
  health: number;
  hitCount: number;
  destroyed: boolean;
}

export function harvestStateFor(
  objectId: number, blueprint: HarvestableBlueprint,
): HarvestState {
  return { objectId, health: blueprint.totalHealth, hitCount: 0, destroyed: false };
}

/** The weak point for the next swing, normalised over the facing surface. */
export function weakPointFor(objectId: number, hitCount: number): Vec2 {
  const rng = Rng.forStream(objectId, hitCount);
  // Inset from the edges so the marker never lands half off the mesh.
  return { x: rng.range(0.15, 0.85), y: rng.range(0.15, 0.85) };
}

export function isWeakPointHit(objectId: number, hitCount: number, hitPoint: Vec2): boolean {
  return distance2(weakPointFor(objectId, hitCount), hitPoint) <= WEAK_POINT_RADIUS;
}

export interface HarvestHitResult {
  readonly yield: number;
  readonly hitWeakPoint: boolean;
  readonly destroyed: boolean;
}

/** Apply one swing. Mutates `state`. */
export function harvestHit(
  state: HarvestState,
  blueprint: HarvestableBlueprint,
  damage: number,
  hitPoint: Vec2,
): HarvestHitResult {
  if (state.destroyed) return { yield: 0, hitWeakPoint: false, destroyed: false };

  const weakPoint = isWeakPointHit(state.objectId, state.hitCount, hitPoint);
  let gained = blueprint.yieldPerHit + (weakPoint ? blueprint.bonusYieldOnWeakPoint : 0);

  state.health -= Math.max(0, damage);
  state.hitCount++;

  const destroyed = state.health <= 0;
  if (destroyed) {
    state.destroyed = true;
    state.health = 0;
    gained += blueprint.yieldOnDestroy;
  }

  return { yield: gained, hitWeakPoint: weakPoint, destroyed };
}

/** Swings needed to fell an object at a given per-swing damage. */
export function swingsToFell(blueprint: HarvestableBlueprint, damagePerHit: number): number {
  if (damagePerHit <= 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(blueprint.totalHealth / damagePerHit);
}

/** Total yield from a full harvest, with or without weak-point hits. */
export function totalYield(
  blueprint: HarvestableBlueprint, damagePerHit: number, hitWeakPoints: boolean,
): number {
  const swings = swingsToFell(blueprint, damagePerHit);
  const perHit = blueprint.yieldPerHit + (hitWeakPoints ? blueprint.bonusYieldOnWeakPoint : 0);
  return swings * perHit + blueprint.yieldOnDestroy;
}
