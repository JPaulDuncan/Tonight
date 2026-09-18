/**
 * Turns motor state into a character pose.
 *
 * Pure arithmetic returning plain numbers: no three.js, no scene graph. That is
 * what lets the walk cycle be tested in Node, which matters because "the legs
 * are out of phase" and "the character skates" are both invisible to a unit
 * test that can only assert a mesh exists.
 *
 * The cycle itself is a Blueprint (`LocomotionBlueprint`), not code here. This
 * module knows how to read one; it does not know what a walk looks like.
 */

import type { LocomotionBlueprint, PoseAxis } from "@/blueprints/types";

/** What the motor is doing, reduced to what a pose depends on. */
export interface PoseInput {
  /** Total ground distance travelled, in metres. Drives the cycle phase. */
  readonly distanceTravelled: number;
  /** Current horizontal speed, in m/s. */
  readonly speed: number;
  readonly airborne: boolean;
  readonly crouched: boolean;
}

/** Euler rotations in radians, per part role. */
export type PartRotations = Readonly<Record<string, { x: number; y: number; z: number }>>;

export interface Pose {
  readonly rotations: PartRotations;
  /** Vertical offset of the whole figure, in metres. */
  readonly bob: number;
  /** Forward lean of the whole figure, in radians. */
  readonly lean: number;
}

const TAU = Math.PI * 2;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

function addRotation(
  into: Record<string, { x: number; y: number; z: number }>,
  part: string,
  axis: PoseAxis,
  radians: number,
): void {
  const current = into[part] ?? { x: 0, y: 0, z: 0 };
  current[axis] += radians;
  into[part] = current;
}

/**
 * The cycle phase, in turns, for a given distance travelled.
 *
 * Distance rather than time is the whole trick: at any speed the feet advance
 * one stride per stride's worth of ground, so they never slide. Driving this
 * from a clock is what makes a character moonwalk when the speed changes.
 */
export function cyclePhase(blueprint: LocomotionBlueprint, distanceTravelled: number): number {
  const stride = blueprint.strideMetres;
  if (stride <= 0) return 0;
  const turns = distanceTravelled / stride;
  return turns - Math.floor(turns);
}

/**
 * How strongly the walk cycle applies at a given speed.
 *
 * A character nudging forward at 0.1 m/s should not swing its arms as hard as
 * one at a sprint, and one standing still should be still.
 */
export function cycleWeight(blueprint: LocomotionBlueprint, speed: number): number {
  const blend = blueprint.blendInMetresPerSecond;
  if (blend <= 0) return speed > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, speed / blend));
}

/** Build the pose for one frame. */
export function poseFor(blueprint: LocomotionBlueprint, input: PoseInput): Pose {
  const rotations: Record<string, { x: number; y: number; z: number }> = {};

  // Airborne overrides the walk entirely rather than blending with it: a
  // half-walking, half-tucked figure in mid-air reads as a bug, not as a blend.
  if (input.airborne) {
    for (const track of blueprint.airborne) {
      addRotation(rotations, track.part, track.axis, toRadians(track.degrees));
    }
    return { rotations, bob: 0, lean: 0 };
  }

  const weight = cycleWeight(blueprint, input.speed);
  const phase = cyclePhase(blueprint, input.distanceTravelled);

  for (const track of blueprint.cycle) {
    const angle = Math.sin((phase + track.phase) * TAU);
    addRotation(
      rotations, track.part, track.axis, toRadians(track.amplitudeDegrees) * angle * weight,
    );
  }

  if (input.crouched) {
    for (const track of blueprint.crouched) {
      addRotation(rotations, track.part, track.axis, toRadians(track.degrees));
    }
  }

  // Two bobs per stride: the body rises on each footfall, not once per cycle.
  const bob = Math.abs(Math.sin(phase * TAU)) * blueprint.bobMetres * weight;

  const lean = Math.min(
    toRadians(blueprint.maxLeanDegrees),
    toRadians(blueprint.leanDegreesPerMetrePerSecond * input.speed),
  );

  return { rotations, bob, lean };
}
