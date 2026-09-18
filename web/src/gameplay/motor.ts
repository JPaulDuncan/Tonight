/**
 * The locomotion simulation. One pure step function.
 *
 * Reads no input and no wall clock: both arrive in the {@link MoveCommand}.
 * That is ADR-0003 rules 2 and 3, and it is what makes reconciliation replay
 * exact -- replaying a stored command sequence must reproduce the original
 * result bit for bit, and a single frame-rate-dependent term makes that drift.
 * There is also no randomness here at all, deliberately.
 */

import type { MovementBlueprint } from "@/blueprints/types";
import { MoveFlags, hasFlag, type MoveCommand } from "./commands";
import {
  add3,
  clamp,
  distance3,
  lerp3,
  moveTowards,
  repeat,
  scale3,
  vec3,
  type Vec3,
} from "@/core/math";

/** Capsule radius. A collision detail rather than a tuning knob. */
export const CAPSULE_RADIUS = 0.4;

/** Fixed simulation rate. */
export const TICK_RATE = 30;
export const TICK_DELTA = 1 / TICK_RATE;

/**
 * Everything the simulation needs about one character's locomotion.
 *
 * Reconciliation snapshots and replays this wholesale, so locomotion state
 * living anywhere else would silently fail to roll back.
 */
export interface MotorState {
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  crouched: boolean;
  /**
   * Highest Y since last grounded. Fall damage measures from here, so a player
   * who builds a ramp under themselves mid-fall is correctly spared.
   */
  peakY: number;
  mantleRemaining: number;
  mantleStart: Vec3;
  mantleTarget: Vec3;
  mantleDuration: number;
}

export interface MotorStepResult {
  readonly fallDamage: number;
  readonly landed: boolean;
  readonly jumped: boolean;
  readonly startedMantle: boolean;
}

const NO_RESULT: MotorStepResult = {
  fallDamage: 0, landed: false, jumped: false, startedMantle: false,
};

export function motorAtRest(position: Vec3): MotorState {
  return {
    position: { ...position },
    velocity: vec3(),
    yaw: 0,
    pitch: 0,
    grounded: true,
    crouched: false,
    peakY: position.y,
    mantleRemaining: 0,
    mantleStart: vec3(),
    mantleTarget: vec3(),
    mantleDuration: 0,
  };
}

export function cloneMotorState(state: MotorState): MotorState {
  return {
    ...state,
    position: { ...state.position },
    velocity: { ...state.velocity },
    mantleStart: { ...state.mantleStart },
    mantleTarget: { ...state.mantleTarget },
  };
}

export interface MotorCollisionResult {
  readonly position: Vec3;
  readonly grounded: boolean;
  readonly hitCeiling: boolean;
  readonly hitWall: boolean;
}

/**
 * The collision world the motor moves through.
 *
 * An interface so the motor can be stepped in a unit test against a flat plane,
 * with no scene and no physics. The motor is the piece most likely to hide a
 * determinism bug, so being able to run it ten thousand times in a test is
 * worth the indirection.
 */
export interface MotorCollision {
  move(position: Vec3, delta: Vec3, capsuleHeight: number, capsuleRadius: number): MotorCollisionResult;
  tryFindLedge(
    position: Vec3, forward: Vec3, maxHeight: number, capsuleRadius: number,
  ): Vec3 | undefined;
  hasHeadroom(position: Vec3, standHeight: number, capsuleRadius: number): boolean;
}

/** An infinite flat plane. The reference implementation, used by the tests. */
export class FlatGroundCollision implements MotorCollision {
  constructor(private readonly groundY = 0) {}

  move(position: Vec3, delta: Vec3): MotorCollisionResult {
    const target = add3(position, delta);
    if (target.y <= this.groundY) {
      return {
        position: { x: target.x, y: this.groundY, z: target.z },
        grounded: true, hitCeiling: false, hitWall: false,
      };
    }
    return { position: target, grounded: false, hitCeiling: false, hitWall: false };
  }

  tryFindLedge(): Vec3 | undefined {
    return undefined;
  }

  hasHeadroom(): boolean {
    return true;
  }
}

/**
 * Initial upward velocity that reaches `jumpHeight` when integrated at a fixed
 * timestep.
 *
 * The textbook sqrt(2gh) is the continuous-time answer and undershoots in a
 * discrete simulation: at 30 Hz an authored 1.1 m jump peaks at 0.99 m. A 10%
 * error would make the Blueprint field a lie, which defeats the point of
 * authoring values as data.
 *
 * With semi-implicit Euler and gravity applied before the position update:
 *   v_k   = v0 - g*k*dt
 *   y_max ~= v0^2/(2g) - v0*dt/2
 * Setting y_max = h and solving for v0 gives the value below, which lands
 * within a millimetre of the authored height at 20, 30 and 60 Hz alike.
 */
export function jumpVelocityForTick(blueprint: MovementBlueprint, deltaTime: number): number {
  const g = Math.abs(blueprint.gravity);
  if (deltaTime <= 0) return Math.sqrt(2 * g * blueprint.jumpHeight);
  const gdt = g * deltaTime;
  return (gdt + Math.sqrt(gdt * gdt + 8 * g * blueprint.jumpHeight)) * 0.5;
}

/** The continuous-time formula. Exposed for reference; the sim does not use it. */
export function jumpVelocityContinuous(blueprint: MovementBlueprint): number {
  return Math.sqrt(2 * Math.abs(blueprint.gravity) * blueprint.jumpHeight);
}

/** Fall damage for a drop. Ignores shield and applies directly to health. */
export function fallDamageFor(blueprint: MovementBlueprint, fallDistance: number): number {
  const excess = fallDistance - blueprint.fallDamageThreshold;
  return excess <= 0 ? 0 : excess * blueprint.fallDamagePerMetre;
}

/** Rotate a vector about Y. Written out to avoid allocating in the replay loop. */
export function yawRotate(v: Vec3, yawDegrees: number): Vec3 {
  const radians = (yawDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: v.x * cos + v.z * sin, y: v.y, z: -v.x * sin + v.z * cos };
}

export function speedFor(
  command: MoveCommand, blueprint: MovementBlueprint, crouched: boolean,
): number {
  if (crouched) return blueprint.crouchSpeed;
  // Sprint applies only to genuine forward movement, so retreating from a fight
  // is not as fast as advancing into one.
  const sprinting = hasFlag(command, MoveFlags.Sprint) && command.moveInput.y > 0.1;
  return sprinting ? blueprint.sprintSpeed : blueprint.walkSpeed;
}

export function currentHeight(state: MotorState, blueprint: MovementBlueprint): number {
  return state.crouched ? blueprint.crouchHeight : blueprint.standHeight;
}

/** Advance one fixed tick. Returns a new state; the input is not mutated. */
export function stepMotor(
  previous: MotorState,
  command: MoveCommand,
  blueprint: MovementBlueprint,
  collision: MotorCollision,
): { state: MotorState; result: MotorStepResult } {
  const state = cloneMotorState(previous);
  const dt = command.deltaTime;

  state.yaw = repeat(state.yaw + command.lookDelta.x, 360);
  // Clamped rather than wrapped: over-pitching should stop at vertical, not flip.
  state.pitch = clamp(state.pitch + command.lookDelta.y, -89, 89);

  if (state.mantleRemaining > 0) {
    return { state, result: stepMantle(state, dt) };
  }

  if (tryStartMantle(state, command, blueprint, collision)) {
    return { state, result: { ...NO_RESULT, startedMantle: true } };
  }

  updateCrouch(state, command, blueprint, collision);
  const jumped = applyJump(state, command, blueprint);
  applyHorizontal(state, command, blueprint, dt);
  applyGravity(state, blueprint, dt);

  const wasGrounded = state.grounded;
  const moved = collision.move(
    state.position, scale3(state.velocity, dt), currentHeight(state, blueprint), CAPSULE_RADIUS,
  );

  state.position = moved.position;
  if (moved.hitCeiling && state.velocity.y > 0) state.velocity.y = 0;

  let fallDamage = 0;
  let landed = false;

  if (moved.grounded) {
    if (!wasGrounded) {
      landed = true;
      fallDamage = fallDamageFor(blueprint, state.peakY - state.position.y);
    }
    state.grounded = true;
    if (state.velocity.y < 0) state.velocity.y = 0;
    // Reset the fall origin on every grounded tick. This is what makes building
    // a ramp under yourself a reliable save rather than an unpredictable one.
    state.peakY = state.position.y;
  } else {
    state.grounded = false;
    if (state.position.y > state.peakY) state.peakY = state.position.y;
  }

  return { state, result: { fallDamage, landed, jumped, startedMantle: false } };
}

function updateCrouch(
  state: MotorState, command: MoveCommand, blueprint: MovementBlueprint,
  collision: MotorCollision,
): void {
  if (hasFlag(command, MoveFlags.Crouch)) {
    state.crouched = true;
    return;
  }
  // Standing up is refused when something is overhead, so a player cannot clip
  // through a floor they built above themselves.
  if (state.crouched && collision.hasHeadroom(state.position, blueprint.standHeight, CAPSULE_RADIUS)) {
    state.crouched = false;
  }
}

function applyJump(
  state: MotorState, command: MoveCommand, blueprint: MovementBlueprint,
): boolean {
  if (!hasFlag(command, MoveFlags.Jump) || !state.grounded) return false;
  state.velocity.y = jumpVelocityForTick(blueprint, command.deltaTime);
  state.grounded = false;
  state.peakY = state.position.y;
  return true;
}

function applyHorizontal(
  state: MotorState, command: MoveCommand, blueprint: MovementBlueprint, dt: number,
): void {
  const speed = speedFor(command, blueprint, state.crouched);
  const wish = yawRotate(vec3(command.moveInput.x, 0, command.moveInput.y), state.yaw);
  const desired = scale3(wish, speed);

  const currentSq = state.velocity.x ** 2 + state.velocity.z ** 2;
  const desiredSq = desired.x ** 2 + desired.z ** 2;

  // Decelerating uses a different rate from accelerating, which is most of what
  // makes stopping feel crisp rather than sliding.
  let rate = desiredSq > currentSq ? blueprint.acceleration : blueprint.deceleration;
  if (!state.grounded) rate *= blueprint.airControl;

  const maxDelta = rate * dt;
  const dx = desired.x - state.velocity.x;
  const dz = desired.z - state.velocity.z;
  const distance = Math.sqrt(dx * dx + dz * dz);

  if (distance <= maxDelta || distance < 1e-9) {
    state.velocity.x = desired.x;
    state.velocity.z = desired.z;
  } else {
    state.velocity.x += (dx / distance) * maxDelta;
    state.velocity.z += (dz / distance) * maxDelta;
  }
}

function applyGravity(state: MotorState, blueprint: MovementBlueprint, dt: number): void {
  if (state.grounded && state.velocity.y <= 0) {
    // A small downward bias keeps the character pinned across a step rather
    // than skipping off crests.
    state.velocity.y = -2;
    return;
  }
  state.velocity.y += blueprint.gravity * dt;
  if (state.velocity.y < -blueprint.terminalVelocity) {
    state.velocity.y = -blueprint.terminalVelocity;
  }
}

function tryStartMantle(
  state: MotorState, command: MoveCommand, blueprint: MovementBlueprint,
  collision: MotorCollision,
): boolean {
  // Mantling requires forward intent, or a player pressed against a ledge would
  // mantle it by standing still.
  if (command.moveInput.y <= 0.1) return false;

  const forward = yawRotate(vec3(0, 0, 1), state.yaw);
  const ledge = collision.tryFindLedge(
    state.position, forward, blueprint.mantleMaxHeight, CAPSULE_RADIUS,
  );
  if (!ledge) return false;

  state.mantleStart = { ...state.position };
  state.mantleTarget = { ...ledge };
  state.mantleDuration = blueprint.mantleSeconds;
  state.mantleRemaining = blueprint.mantleSeconds;
  state.velocity = vec3();
  return true;
}

function stepMantle(state: MotorState, dt: number): MotorStepResult {
  state.mantleRemaining -= dt;

  if (state.mantleRemaining <= 0) {
    state.position = { ...state.mantleTarget };
    state.mantleRemaining = 0;
    state.grounded = true;
    state.peakY = state.position.y;
    return { ...NO_RESULT, landed: true };
  }

  const elapsed = state.mantleDuration - state.mantleRemaining;
  const t = state.mantleDuration <= 0 ? 1 : elapsed / state.mantleDuration;
  state.position = lerp3(state.mantleStart, state.mantleTarget, t);
  return NO_RESULT;
}

/** Positional difference between two states, for reconciliation. */
export function motorPositionError(a: MotorState, b: MotorState): number {
  return distance3(a.position, b.position);
}
