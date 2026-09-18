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

import type {
  LocomotionBlueprint, PoseAxis, PoseKeyframe, UpperBodyBlueprint,
} from "@/blueprints/types";

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

/**
 * Sample an upper-body clip at a point in its play.
 *
 * `elapsed` is seconds since the clip started. A clip with no duration is a
 * static pose and holds its first keyframe; a non-looping clip holds its last
 * once it is over, which is what makes "carry" the natural resting state after
 * a swing finishes rather than a snap back to the walk.
 */
export function sampleUpperBody(
  blueprint: UpperBodyBlueprint, elapsed: number,
): PartRotations {
  const frames = blueprint.keyframes;
  if (frames.length === 0) return {};

  let time: number;
  if (blueprint.durationSeconds <= 0) {
    time = 0;
  } else {
    const turns = elapsed / blueprint.durationSeconds;
    time = blueprint.loop ? turns - Math.floor(turns) : Math.min(1, Math.max(0, turns));
  }

  // Find the pair of keyframes this time falls between.
  let before: PoseKeyframe = frames[0]!;
  let after: PoseKeyframe = frames[frames.length - 1]!;
  for (let i = 0; i < frames.length - 1; i++) {
    if (time >= frames[i]!.time && time <= frames[i + 1]!.time) {
      before = frames[i]!;
      after = frames[i + 1]!;
      break;
    }
  }
  if (time <= frames[0]!.time) {
    before = after = frames[0]!;
  } else if (time >= frames[frames.length - 1]!.time) {
    before = after = frames[frames.length - 1]!;
  }

  const span = after.time - before.time;
  const blend = span > 0 ? (time - before.time) / span : 0;

  const rotations: Record<string, { x: number; y: number; z: number }> = {};
  const write = (frame: PoseKeyframe, weight: number) => {
    for (const track of frame.pose) {
      addRotation(rotations, track.part, track.axis, toRadians(track.degrees) * weight);
    }
  };
  write(before, 1 - blend);
  write(after, blend);
  return rotations;
}

/** What the upper body is doing, if anything. */
export interface UpperBodyInput {
  readonly blueprint: UpperBodyBlueprint;
  /** Seconds since the clip started. */
  readonly elapsed: number;
}

/** Build the pose for one frame. */
export function poseFor(
  blueprint: LocomotionBlueprint, input: PoseInput, upper?: UpperBodyInput,
): Pose {
  const rotations: Record<string, { x: number; y: number; z: number }> = {};

  // The mask decides ownership, and it is exclusive: a masked part takes the
  // clip's rotation *instead of* the walk's, not on top of it. Adding the two
  // would have the arms swinging while they hold a pickaxe overhead.
  const masked = new Set(upper?.blueprint.mask ?? []);
  const applyUpper = () => {
    if (!upper) return;
    for (const [part, rotation] of Object.entries(sampleUpperBody(upper.blueprint, upper.elapsed))) {
      rotations[part] = { ...rotation };
    }
  };

  // Airborne overrides the walk entirely rather than blending with it: a
  // half-walking, half-tucked figure in mid-air reads as a bug, not as a blend.
  if (input.airborne) {
    for (const track of blueprint.airborne) {
      if (masked.has(track.part)) continue;
      addRotation(rotations, track.part, track.axis, toRadians(track.degrees));
    }
    applyUpper();
    return { rotations, bob: 0, lean: 0 };
  }

  const weight = cycleWeight(blueprint, input.speed);
  const phase = cyclePhase(blueprint, input.distanceTravelled);

  for (const track of blueprint.cycle) {
    if (masked.has(track.part)) continue;
    const angle = Math.sin((phase + track.phase) * TAU);
    addRotation(
      rotations, track.part, track.axis, toRadians(track.amplitudeDegrees) * angle * weight,
    );
  }

  if (input.crouched) {
    for (const track of blueprint.crouched) {
      if (masked.has(track.part)) continue;
      addRotation(rotations, track.part, track.axis, toRadians(track.degrees));
    }
  }

  applyUpper();

  // Two bobs per stride: the body rises on each footfall, not once per cycle.
  const bob = Math.abs(Math.sin(phase * TAU)) * blueprint.bobMetres * weight;

  const lean = Math.min(
    toRadians(blueprint.maxLeanDegrees),
    toRadians(blueprint.leanDegreesPerMetrePerSecond * input.speed),
  );

  return { rotations, bob, lean };
}
