/**
 * Combat: one damage formula, one firing state machine.
 *
 * There are no weapon-specific branches here and adding one would be a contract
 * violation. A weapon that behaves differently does so because a Blueprint
 * field says so.
 */

import type {
  DamageProfileBlueprint,
  HitboxDefinition,
  RarityBlueprint,
  WeaponBlueprint,
} from "@/blueprints/types";
import { Rng } from "@/core/rng";
import { clamp, clamp01, cross3, lerp, normalise3, vec3, type Vec3 } from "@/core/math";

export type HitTargetKind = "player" | "structure" | "harvestable";

export interface HitContext {
  readonly profile: DamageProfileBlueprint;
  readonly rarity?: RarityBlueprint | undefined;
  readonly hitbox?: HitboxDefinition | undefined;
  readonly targetKind: HitTargetKind;
  readonly distanceMetres: number;
}

export interface DamageResult {
  readonly toShield: number;
  readonly toHealth: number;
}

/** Distance falloff: flat, then linear through the band, then flat again. */
export function falloffAt(profile: DamageProfileBlueprint, distance: number): number {
  if (distance <= profile.falloffStartMetres) return 1;
  if (distance >= profile.falloffEndMetres) return profile.falloffEndDamageScale;

  const band = profile.falloffEndMetres - profile.falloffStartMetres;
  if (band <= Number.EPSILON) return profile.falloffEndDamageScale;
  return lerp(1, profile.falloffEndDamageScale, (distance - profile.falloffStartMetres) / band);
}

/** Raw damage for a hit, before shield splitting. */
export function computeDamage(hit: HitContext): number {
  let damage = hit.profile.baseDamage;
  if (hit.rarity) damage *= hit.rarity.damageMultiplier;

  // Hitbox scaling applies to players only: a bullet striking a wall has no
  // head to hit.
  if (hit.targetKind === "player") {
    if (hit.hitbox) {
      damage *= hit.hitbox.isHead ? hit.profile.headshotMultiplier : hit.hitbox.damageScale;
    }
  } else if (hit.targetKind === "structure") {
    damage *= hit.profile.structureMultiplier;
  }

  return Math.max(0, damage * falloffAt(hit.profile, hit.distanceMetres));
}

/**
 * Split damage across shield and health.
 *
 * Neither output can exceed the pool it targets, so a caller subtracting these
 * can never drive a pool negative.
 */
export function splitDamage(
  damage: number, currentShield: number, currentHealth: number, shieldPenetration: number,
): DamageResult {
  if (damage <= 0) return { toShield: 0, toHealth: 0 };

  const penetration = clamp01(shieldPenetration);
  const direct = damage * penetration;
  const absorbable = damage - direct;

  const toShield = Math.min(absorbable, Math.max(0, currentShield));
  // Damage the shield could not absorb carries through to health.
  const overflow = absorbable - toShield;
  const toHealth = Math.min(direct + overflow, Math.max(0, currentHealth));

  return { toShield, toHealth };
}

export function applyHit(
  hit: HitContext, currentShield: number, currentHealth: number,
): DamageResult {
  return splitDamage(computeDamage(hit), currentShield, currentHealth, hit.profile.shieldPenetration);
}

/** Health and shield. Neither regenerates: healing is consumable-only. */
export interface HealthPool {
  health: number;
  shield: number;
  readonly maxHealth: number;
  readonly maxShield: number;
}

export function fullHealth(maxHealth: number, maxShield: number): HealthPool {
  // Shield starts empty: it is looted, not granted.
  return { health: maxHealth, shield: 0, maxHealth, maxShield };
}

export function isAlive(pool: HealthPool): boolean {
  return pool.health > 0;
}

/** Apply a split damage result. Returns true when this killed the character. */
export function applyDamageToPool(pool: HealthPool, damage: DamageResult): boolean {
  pool.shield = Math.max(0, pool.shield - damage.toShield);
  pool.health = Math.max(0, pool.health - damage.toHealth);
  return !isAlive(pool);
}

/**
 * Restore health, capped both by the item's cap and by the maximum.
 * The per-item cap is what makes bandage-versus-medkit a decision.
 */
export function heal(pool: HealthPool, amount: number, cap: number): number {
  if (amount <= 0) return 0;
  const ceiling = Math.min(cap, pool.maxHealth);
  if (pool.health >= ceiling) return 0;
  const before = pool.health;
  pool.health = Math.min(ceiling, pool.health + amount);
  return pool.health - before;
}

export function addShield(pool: HealthPool, amount: number): number {
  if (amount <= 0 || pool.shield >= pool.maxShield) return 0;
  const before = pool.shield;
  pool.shield = Math.min(pool.maxShield, pool.shield + amount);
  return pool.shield - before;
}

/** Storm damage: bypasses shield by design. The storm is a clock. */
export function applyDirectHealthDamage(pool: HealthPool, amount: number): boolean {
  if (amount <= 0) return false;
  pool.health = Math.max(0, pool.health - amount);
  return !isAlive(pool);
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

export enum FireRejection {
  None = "none",
  OnCooldown = "onCooldown",
  MagazineEmpty = "magazineEmpty",
  Reloading = "reloading",
  Equipping = "equipping",
  /** Semi-auto, bolt-action, or a spent burst: the trigger must be released. */
  RequiresTriggerRelease = "requiresTriggerRelease",
  NoWeapon = "noWeapon",
  /**
   * The trigger is not down, so there was nothing to do.
   *
   * Distinct from `None` on purpose. This used to return `None`, which made
   * "a shot happened" and "no input this tick" indistinguishable to a caller:
   * the sandbox counted every idle tick as a shot, played the fire animation
   * and drew a tracer, all without consuming a round. A caller must be able to
   * tell the two apart, so `None` now means exactly one thing -- a shot.
   */
  TriggerReleased = "triggerReleased",
}

/**
 * Per-instance weapon state.
 *
 * Separate from the Blueprint, because two players holding the same weapon must
 * not share a magazine (authoring contract rule 1).
 */
export interface WeaponState {
  ammoInMagazine: number;
  lastShotTick: number;
  busyUntilTick: number;
  isReloading: boolean;
  shotsThisTrigger: number;
  triggerHeld: boolean;
  bloomDegrees: number;
}

export function freshWeaponState(weapon: WeaponBlueprint): WeaponState {
  return {
    ammoInMagazine: weapon.magazineSize,
    lastShotTick: Number.MIN_SAFE_INTEGER / 2,
    busyUntilTick: 0,
    isReloading: false,
    shotsThisTrigger: 0,
    triggerHeld: false,
    bloomDegrees: 0,
  };
}

/** Ticks between shots, rounded up so the authored RPM is a ceiling. */
export function intervalTicks(weapon: WeaponBlueprint, tickRate: number): number {
  if (weapon.fireRateRpm <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.ceil((60 / weapon.fireRateRpm) * tickRate));
}

function modeAllowsShot(
  state: WeaponState, weapon: WeaponBlueprint, pressedThisTick: boolean,
): boolean {
  switch (weapon.fireMode) {
    case "auto":
      return true;
    // Semi and bolt-action need a fresh press per shot. Bolt-action pays its
    // cycle time through the fire interval.
    case "semi":
    case "boltAction":
      return pressedThisTick;
    case "burst":
      // A burst runs to completion on one press, then needs another.
      return state.shotsThisTrigger < weapon.burstCount;
    default:
      return true;
  }
}

function completeReload(state: WeaponState, weapon: WeaponBlueprint): void {
  state.isReloading = false;
  state.ammoInMagazine = weapon.magazineSize;
}

/**
 * Attempt to fire. Mutates `state` on a successful shot.
 *
 * Returns `FireRejection.None` **only** when a round was actually fired. Every
 * other outcome, including "the trigger is not down", has its own value.
 */
export function tryFire(
  state: WeaponState,
  weapon: WeaponBlueprint | undefined,
  tick: number,
  tickRate: number,
  triggerDown: boolean,
): FireRejection {
  if (!weapon) return FireRejection.NoWeapon;

  const pressedThisTick = triggerDown && !state.triggerHeld;
  if (!triggerDown) {
    // Releasing ends a burst and re-arms semi-auto.
    state.triggerHeld = false;
    state.shotsThisTrigger = 0;
    return FireRejection.TriggerReleased;
  }

  state.triggerHeld = true;

  if (tick < state.busyUntilTick) {
    return state.isReloading ? FireRejection.Reloading : FireRejection.Equipping;
  }
  if (state.isReloading) completeReload(state, weapon);
  if (state.ammoInMagazine <= 0) return FireRejection.MagazineEmpty;
  if (!modeAllowsShot(state, weapon, pressedThisTick)) return FireRejection.RequiresTriggerRelease;
  if (tick - state.lastShotTick < intervalTicks(weapon, tickRate)) return FireRejection.OnCooldown;

  state.ammoInMagazine--;
  state.lastShotTick = tick;
  state.shotsThisTrigger++;
  state.bloomDegrees = Math.min(weapon.bloomMaxDegrees, state.bloomDegrees + weapon.bloomPerShot);
  return FireRejection.None;
}

/** Begin a reload. Returns false when there is nothing to do. */
export function tryBeginReload(
  state: WeaponState, weapon: WeaponBlueprint, tick: number, tickRate: number, reserveAmmo: number,
): boolean {
  if (state.isReloading) return false;
  if (state.ammoInMagazine >= weapon.magazineSize || reserveAmmo <= 0) return false;

  state.isReloading = true;
  state.busyUntilTick = tick + Math.ceil(weapon.reloadSeconds * tickRate);
  return true;
}

/**
 * Begin an equip.
 *
 * Cancelling one by swapping again is intended: a shotgun-AR-shotgun swap to
 * cancel a reload is skill expression. But it must actually cancel the reload
 * rather than bank it, or it would be a free instant reload instead.
 */
export function beginEquip(
  state: WeaponState, weapon: WeaponBlueprint, tick: number, tickRate: number,
): void {
  state.isReloading = false;
  state.busyUntilTick = tick + Math.ceil(weapon.equipSeconds * tickRate);
  state.shotsThisTrigger = 0;
  state.bloomDegrees = 0;
}

/** Advance weapon timers. Call once per tick. */
export function tickWeapon(
  state: WeaponState, weapon: WeaponBlueprint | undefined, tick: number, deltaTime: number,
): void {
  if (!weapon) return;
  state.bloomDegrees = Math.max(0, state.bloomDegrees - weapon.bloomRecoveryPerSecond * deltaTime);
  if (state.isReloading && tick >= state.busyUntilTick) completeReload(state, weapon);
}

/** Effective cone half-angle for the next shot. */
export function effectiveSpread(state: WeaponState, weapon: WeaponBlueprint): number {
  // First-shot accuracy: at rest the shot goes dead centre. Multi-pellet
  // weapons are exempt -- a shotgun firing every pellet along one line would be
  // a sniper rifle.
  if (weapon.firstShotAccurate && state.bloomDegrees <= 0 && weapon.pelletCount === 1) return 0;
  return weapon.spreadDegrees + state.bloomDegrees;
}

/**
 * Deterministic direction for one pellet of one shot.
 *
 * Seeded from values the client and server both already know, so a predicted
 * shotgun blast matches the authoritative one without replicating per-pellet
 * data.
 */
export function pelletDirection(
  aimDirection: Vec3, spreadDegrees: number, shotSeed: number, pelletIndex: number,
): Vec3 {
  const forward = normalise3(aimDirection);
  if (spreadDegrees <= 0) return forward;

  const rng = Rng.forStream(shotSeed, pelletIndex);

  // Uniform over the cone's solid angle rather than over the angle itself, or
  // pellets bunch toward the centre.
  const cosMax = Math.cos((spreadDegrees * Math.PI) / 180);
  const cosTheta = lerp(cosMax, 1, rng.nextFloat());
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const phi = rng.nextFloat() * Math.PI * 2;

  const reference = Math.abs(forward.y) > 0.99 ? vec3(1, 0, 0) : vec3(0, 1, 0);
  const right = normalise3(cross3(reference, forward));
  const up = cross3(forward, right);

  return {
    x: forward.x * cosTheta + right.x * sinTheta * Math.cos(phi) + up.x * sinTheta * Math.sin(phi),
    y: forward.y * cosTheta + right.y * sinTheta * Math.cos(phi) + up.y * sinTheta * Math.sin(phi),
    z: forward.z * cosTheta + right.z * sinTheta * Math.cos(phi) + up.z * sinTheta * Math.sin(phi),
  };
}

export { clamp };
