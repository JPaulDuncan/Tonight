import { beforeEach, describe, expect, it } from "vitest";

import { blueprints } from "@/blueprints/library";
import type { MovementBlueprint } from "@/blueprints/types";
import { Rng } from "@/core/rng";
import { vec2, vec3 } from "@/core/math";
import { MoveFlags, isPlausible, moveCommand, type MoveCommand } from "@/gameplay/commands";
import {
  FlatGroundCollision,
  TICK_DELTA,
  fallDamageFor,
  jumpVelocityContinuous,
  jumpVelocityForTick,
  motorAtRest,
  stepMotor,
  yawRotate,
  type MotorState,
} from "@/gameplay/motor";

const DT = TICK_DELTA;

describe("character motor", () => {
  let movement: MovementBlueprint;
  let ground: FlatGroundCollision;

  beforeEach(() => {
    movement = blueprints().movement("movement.default");
    ground = new FlatGroundCollision(0);
  });

  const cmd = (tick: number, x = 0, y = 0, flags: number = MoveFlags.None): MoveCommand =>
    moveCommand(tick, vec2(x, y), vec2(0, 0), flags, DT);

  const run = (
    state: MotorState, ticks: number, x: number, y: number, flags: number = MoveFlags.None,
  ) => {
    let current = state;
    for (let i = 0; i < ticks; i++) {
      current = stepMotor(current, cmd(i, x, y, flags), movement, ground).state;
    }
    return current;
  };

  const horizontalSpeed = (s: MotorState) => Math.hypot(s.velocity.x, s.velocity.z);

  it("reaches the authored walk speed", () => {
    expect(horizontalSpeed(run(motorAtRest(vec3()), 60, 0, 1))).toBeCloseTo(4.6, 2);
  });

  it("reaches the authored sprint speed", () => {
    const state = run(motorAtRest(vec3()), 60, 0, 1, MoveFlags.Sprint);
    expect(horizontalSpeed(state)).toBeCloseTo(7.4, 2);
  });

  it("does not sprint sideways", () => {
    // Retreating from a fight should not be as fast as advancing into one.
    const state = run(motorAtRest(vec3()), 60, 1, 0, MoveFlags.Sprint);
    expect(horizontalSpeed(state)).toBeCloseTo(4.6, 2);
  });

  it("uses the crouch speed when crouched", () => {
    const state = run(motorAtRest(vec3()), 60, 0, 1, MoveFlags.Crouch);
    expect(horizontalSpeed(state)).toBeCloseTo(2.3, 2);
  });

  it("clamps diagonal input so it is not faster", () => {
    expect(horizontalSpeed(run(motorAtRest(vec3()), 60, 1, 1))).toBeLessThanOrEqual(4.61);
  });

  it("jumps to exactly the authored height", () => {
    // Tight on purpose: the motor uses the tick-corrected jump velocity. A loose
    // tolerance would hide the 10% undershoot the naive sqrt(2gh) produces.
    let state = motorAtRest(vec3());
    const first = stepMotor(state, cmd(0, 0, 0, MoveFlags.Jump), movement, ground);
    expect(first.result.jumped).toBe(true);

    state = first.state;
    let apex = state.position.y;
    for (let i = 1; i < 120; i++) {
      state = stepMotor(state, cmd(i), movement, ground).state;
      apex = Math.max(apex, state.position.y);
      if (state.grounded) break;
    }

    expect(apex).toBeCloseTo(1.1, 2);
  });

  it("reaches the authored height at 20, 30 and 60 Hz alike", () => {
    for (const rate of [20, 30, 60]) {
      const dt = 1 / rate;
      let y = 0;
      let vy = jumpVelocityForTick(movement, dt);
      let apex = 0;
      for (let i = 0; i < 1000; i++) {
        vy = Math.max(vy + movement.gravity * dt, -movement.terminalVelocity);
        y += vy * dt;
        if (y <= 0) break;
        apex = Math.max(apex, y);
      }
      expect(apex, `at ${rate} Hz`).toBeCloseTo(1.1, 1);
    }
  });

  it("would undershoot with the continuous formula", () => {
    // Documents why the correction exists, so nobody "simplifies" it away.
    let y = 0;
    let vy = jumpVelocityContinuous(movement);
    let apex = 0;
    for (let i = 0; i < 1000; i++) {
      vy += movement.gravity * DT;
      y += vy * DT;
      if (y <= 0) break;
      apex = Math.max(apex, y);
    }
    expect(apex).toBeLessThan(1.0);
  });

  it("cannot double jump", () => {
    let state = motorAtRest(vec3());
    state = stepMotor(state, cmd(0, 0, 0, MoveFlags.Jump), movement, ground).state;
    const second = stepMotor(state, cmd(1, 0, 0, MoveFlags.Jump), movement, ground);
    expect(second.result.jumped).toBe(false);
  });

  it("never exceeds terminal velocity", () => {
    let state = motorAtRest(vec3(0, 500, 0));
    state.grounded = false;
    const sky = new FlatGroundCollision(-10000);

    for (let i = 0; i < 600; i++) {
      state = stepMotor(state, cmd(i), movement, sky).state;
      expect(state.velocity.y).toBeGreaterThanOrEqual(-movement.terminalVelocity - 0.001);
    }
    expect(state.velocity.y).toBeCloseTo(-55, 2);
  });

  const dropFrom = (height: number): number => {
    let state = motorAtRest(vec3(0, height, 0));
    state.grounded = false;
    state.peakY = height;
    for (let i = 0; i < 400; i++) {
      const step = stepMotor(state, cmd(i), movement, ground);
      state = step.state;
      if (step.result.landed) return step.result.fallDamage;
    }
    throw new Error(`never landed from ${height} m`);
  };

  it("takes no fall damage below the threshold", () => {
    expect(dropFrom(3)).toBe(0);
  });

  it("scales fall damage with height above the threshold", () => {
    expect(dropFrom(13.5)).toBeCloseTo(100, 0);
  });

  it("cancels an accumulated fall on landing", () => {
    // Building a ramp under yourself mid-fall must be a reliable save.
    let state = motorAtRest(vec3(0, 40, 0));
    state.grounded = false;
    for (let i = 0; i < 20; i++) state = stepMotor(state, cmd(i), movement, ground).state;
    expect(state.grounded).toBe(false);

    const rescue = new FlatGroundCollision(state.position.y - 0.5);
    const caught = stepMotor(state, cmd(100), movement, rescue);
    expect(caught.result.landed).toBe(true);

    state = caught.state;
    state.grounded = false;
    const after = stepMotor(state, cmd(101), movement, ground);
    expect(after.result.fallDamage).toBe(0);
  });

  it("clamps pitch rather than wrapping it", () => {
    let state = motorAtRest(vec3());
    for (let i = 0; i < 100; i++) {
      state = stepMotor(state, moveCommand(i, vec2(), vec2(0, 10), MoveFlags.None, DT), movement, ground).state;
    }
    expect(state.pitch).toBeCloseTo(89, 5);
  });

  it("wraps yaw without growing unbounded", () => {
    let state = motorAtRest(vec3());
    for (let i = 0; i < 100; i++) {
      state = stepMotor(state, moveCommand(i, vec2(), vec2(20, 0), MoveFlags.None, DT), movement, ground).state;
    }
    expect(state.yaw).toBeGreaterThanOrEqual(0);
    expect(state.yaw).toBeLessThan(360);
  });

  it("rotates forward into world space", () => {
    const east = yawRotate(vec3(0, 0, 1), 90);
    expect(east.x).toBeCloseTo(1, 5);
    expect(east.z).toBeCloseTo(0, 5);
  });

  it("is bit-identical across replays", () => {
    // The property that makes reconciliation stable. A single frame-rate
    // dependent or random term makes replay drift, and the symptom is permanent
    // jitter that looks nothing like its cause.
    const rng = new Rng(4242);
    const commands: MoveCommand[] = [];
    for (let i = 0; i < 1000; i++) {
      let flags: number = MoveFlags.None;
      if (rng.nextFloat() < 0.05) flags |= MoveFlags.Jump;
      if (rng.nextFloat() < 0.3) flags |= MoveFlags.Sprint;
      if (rng.nextFloat() < 0.1) flags |= MoveFlags.Crouch;
      commands.push(
        moveCommand(i, vec2(rng.range(-1, 1), rng.range(-1, 1)),
          vec2(rng.range(-4, 4), rng.range(-2, 2)), flags, DT),
      );
    }

    const play = () => {
      let state = motorAtRest(vec3());
      for (const command of commands) state = stepMotor(state, command, movement, ground).state;
      return state;
    };

    const first = play();
    const second = play();
    expect(second.position).toEqual(first.position);
    expect(second.velocity).toEqual(first.velocity);
    expect(second.yaw).toBe(first.yaw);
    expect(second.pitch).toBe(first.pitch);
  });

  it("does not mutate the state it was given", () => {
    const original = motorAtRest(vec3());
    const before = structuredClone(original);
    stepMotor(original, cmd(0, 0, 1, MoveFlags.Jump), movement, ground);
    expect(original).toEqual(before);
  });

  it("rejects an inflated timestep", () => {
    expect(isPlausible(moveCommand(0, vec2(0, 1), vec2(), MoveFlags.None, DT), DT)).toBe(true);
    expect(isPlausible(moveCommand(0, vec2(0, 1), vec2(), MoveFlags.None, DT * 10), DT)).toBe(false);
  });

  it("computes fall damage from the blueprint", () => {
    expect(fallDamageFor(movement, 0)).toBe(0);
    expect(fallDamageFor(movement, 3.5)).toBe(0);
    expect(fallDamageFor(movement, 5)).toBeCloseTo(15, 5);
    expect(fallDamageFor(movement, 13.5)).toBeCloseTo(100, 5);
  });
});
