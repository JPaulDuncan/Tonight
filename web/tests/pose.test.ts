/**
 * Tests for the walk cycle.
 *
 * "The character skates" and "the legs are in phase" are the two ways a walk
 * cycle goes wrong, and neither is visible to a test that only checks a mesh
 * exists. Both are arithmetic, so both are checkable here in Node.
 */

import { describe, expect, it } from "vitest";

import { blueprints, library } from "@/blueprints/library";
import type { LocomotionBlueprint, UpperBodyBlueprint } from "@/blueprints/types";
import { cyclePhase, cycleWeight, poseFor, sampleUpperBody } from "@/render/pose";

const locomotion = (): LocomotionBlueprint => blueprints().locomotion("locomotion.default");

const standing = { distanceTravelled: 0, speed: 0, airborne: false, crouched: false };

describe("cycle phase", () => {
  it("advances one full turn per stride", () => {
    const l = locomotion();
    expect(cyclePhase(l, 0)).toBeCloseTo(0, 6);
    expect(cyclePhase(l, l.strideMetres)).toBeCloseTo(0, 6);
    expect(cyclePhase(l, l.strideMetres / 2)).toBeCloseTo(0.5, 6);
  });

  it("depends on distance, not on speed", () => {
    // The anti-skate property. Two players who have walked the same distance
    // have their feet in the same place, however fast either got there.
    const l = locomotion();
    expect(cyclePhase(l, 3.4)).toBe(cyclePhase(l, 3.4));
    expect(cyclePhase(l, 3.4)).not.toBe(cyclePhase(l, 3.4 + l.strideMetres / 4));
  });

  it("wraps rather than growing without bound", () => {
    const l = locomotion();
    for (const distance of [0.1, 50, 1000, 123456.75]) {
      const phase = cyclePhase(l, distance);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
    }
  });
});

describe("cycle weight", () => {
  it("is zero standing still", () => {
    expect(cycleWeight(locomotion(), 0)).toBe(0);
  });

  it("reaches full by the blend-in speed", () => {
    const l = locomotion();
    expect(cycleWeight(l, l.blendInMetresPerSecond)).toBe(1);
    expect(cycleWeight(l, 99)).toBe(1);
  });

  it("is partial below it", () => {
    const l = locomotion();
    const half = cycleWeight(l, l.blendInMetresPerSecond / 2);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
  });
});

describe("pose", () => {
  it("is completely still when standing", () => {
    const pose = poseFor(locomotion(), standing);
    for (const [part, rotation] of Object.entries(pose.rotations)) {
      expect(Math.abs(rotation.x) + Math.abs(rotation.y) + Math.abs(rotation.z), part)
        .toBeCloseTo(0, 9);
    }
    expect(pose.bob).toBeCloseTo(0, 9);
  });

  it("swings the legs in opposition", () => {
    // Legs moving together is a hop. Half a stride in, one leg is forward and
    // the other is back, so their rotations must have opposite signs.
    const l = locomotion();
    const pose = poseFor(l, {
      distanceTravelled: l.strideMetres * 0.25, speed: 5, airborne: false, crouched: false,
    });
    const left = pose.rotations["LegLeft"]!.x;
    const right = pose.rotations["LegRight"]!.x;
    expect(Math.sign(left)).toBe(-Math.sign(right));
    expect(Math.abs(left)).toBeGreaterThan(0.05);
  });

  it("swings each arm against the opposite leg", () => {
    // The thing that makes a walk read as a walk rather than as a shamble.
    const l = locomotion();
    const pose = poseFor(l, {
      distanceTravelled: l.strideMetres * 0.25, speed: 5, airborne: false, crouched: false,
    });
    expect(Math.sign(pose.rotations["ArmLeft"]!.x)).toBe(
      Math.sign(pose.rotations["LegRight"]!.x),
    );
    expect(Math.sign(pose.rotations["ArmRight"]!.x)).toBe(
      Math.sign(pose.rotations["LegLeft"]!.x),
    );
  });

  it("returns to the same pose after a whole stride", () => {
    const l = locomotion();
    const at = (d: number) =>
      poseFor(l, { distanceTravelled: d, speed: 5, airborne: false, crouched: false });
    const a = at(2);
    const b = at(2 + l.strideMetres);
    for (const part of Object.keys(a.rotations)) {
      expect(b.rotations[part]!.x).toBeCloseTo(a.rotations[part]!.x, 9);
    }
  });

  it("bobs twice per stride, never below zero", () => {
    // The body rises on each footfall. One bob per cycle limps.
    const l = locomotion();
    const bobAt = (fraction: number) =>
      poseFor(l, {
        distanceTravelled: l.strideMetres * fraction, speed: 5,
        airborne: false, crouched: false,
      }).bob;

    expect(bobAt(0)).toBeCloseTo(0, 6);
    expect(bobAt(0.25)).toBeGreaterThan(0);
    expect(bobAt(0.5)).toBeCloseTo(0, 6);
    expect(bobAt(0.75)).toBeGreaterThan(0);
    for (let i = 0; i <= 20; i++) expect(bobAt(i / 20)).toBeGreaterThanOrEqual(0);
  });

  it("uses the airborne pose instead of the cycle, not as well as it", () => {
    const l = locomotion();
    const pose = poseFor(l, {
      distanceTravelled: l.strideMetres * 0.3, speed: 7, airborne: true, crouched: false,
    });
    expect(pose.bob).toBe(0);
    // Both arms go up together in the air; the cycle would have them opposed.
    expect(Math.sign(pose.rotations["ArmLeft"]!.x)).toBe(
      Math.sign(pose.rotations["ArmRight"]!.x),
    );
  });

  it("adds the crouch on top of the walk", () => {
    const l = locomotion();
    const input = {
      distanceTravelled: l.strideMetres * 0.3, speed: 2, airborne: false,
    };
    const upright = poseFor(l, { ...input, crouched: false });
    const crouched = poseFor(l, { ...input, crouched: true });
    expect(crouched.rotations["Chest"]!.x).not.toBeCloseTo(upright.rotations["Chest"]!.x, 6);
  });

  it("leans further the faster you go, up to the cap", () => {
    const l = locomotion();
    const leanAt = (speed: number) => poseFor(l, { ...standing, speed }).lean;
    expect(leanAt(0)).toBeCloseTo(0, 9);
    expect(leanAt(7.4)).toBeGreaterThan(leanAt(4.6));
    expect(leanAt(1000)).toBeCloseTo((l.maxLeanDegrees * Math.PI) / 180, 9);
  });
});

describe("the shipped locomotion blueprint", () => {
  it("drives only parts the character actually has", () => {
    // The validator enforces this too; asserting it here means a bad edit fails
    // with a message about limbs rather than as a character that stands rigid.
    const character = blueprints().character("character.default");
    const parts = new Set(character.hitboxes.map((h) => h.name));
    const l = locomotion();
    for (const track of [...l.cycle, ...l.airborne, ...l.crouched]) {
      expect(parts.has(track.part), track.part).toBe(true);
    }
  });

  it("is referenced by every character", () => {
    for (const character of library.characters) {
      expect(() => blueprints().locomotion(character.locomotionId)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Upper body
// ---------------------------------------------------------------------------

const carry = (): UpperBodyBlueprint => blueprints().upperBody("upper.carry");
const swing = (): UpperBodyBlueprint => blueprints().upperBody("upper.swing");

const walking = {
  distanceTravelled: 3.1, speed: 5, airborne: false, crouched: false,
};

describe("upper-body clips", () => {
  it("holds a static pose regardless of elapsed time", () => {
    const c = carry();
    const a = sampleUpperBody(c, 0);
    const b = sampleUpperBody(c, 99);
    expect(b["ArmRight"]!.x).toBeCloseTo(a["ArmRight"]!.x, 9);
    expect(a["ArmRight"]!.x).not.toBeCloseTo(0, 3);
  });

  it("interpolates between keyframes", () => {
    // Halfway between two keyframes must be between their two values, not
    // snapped to either. A clip that snaps reads as a stutter.
    const s = swing();
    const first = s.keyframes[0]!.pose.find((t) => t.part === "ArmRight")!.degrees;
    const second = s.keyframes[1]!.pose.find((t) => t.part === "ArmRight")!.degrees;
    const midTime = ((s.keyframes[0]!.time + s.keyframes[1]!.time) / 2) * s.durationSeconds;

    const mid = (sampleUpperBody(s, midTime)["ArmRight"]!.x * 180) / Math.PI;
    const low = Math.min(first, second);
    const high = Math.max(first, second);
    expect(mid).toBeGreaterThan(low + 1);
    expect(mid).toBeLessThan(high - 1);
  });

  it("holds its last keyframe once a one-shot is over", () => {
    // So a finished swing rests in the carry pose rather than snapping back
    // into the walk mid-frame.
    const s = swing();
    const end = sampleUpperBody(s, s.durationSeconds);
    const after = sampleUpperBody(s, s.durationSeconds * 5);
    expect(after["ArmRight"]!.x).toBeCloseTo(end["ArmRight"]!.x, 9);
  });

  it("actually moves the arm through the swing", () => {
    const s = swing();
    const samples = [0, 0.25, 0.5, 0.75, 1].map(
      (f) => sampleUpperBody(s, f * s.durationSeconds)["ArmRight"]!.x,
    );
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(1.0);
  });
});

describe("layering", () => {
  it("gives masked parts to the clip and leaves the rest walking", () => {
    const pose = poseFor(locomotion(), walking, { blueprint: carry(), elapsed: 0 });
    // Arms are masked, so they hold the carry pose.
    const carried = sampleUpperBody(carry(), 0);
    expect(pose.rotations["ArmRight"]!.x).toBeCloseTo(carried["ArmRight"]!.x, 9);
    // Legs are not, so they still swing.
    expect(Math.abs(pose.rotations["LegLeft"]!.x)).toBeGreaterThan(0.05);
  });

  it("replaces the walk on a masked part rather than adding to it", () => {
    // The property that matters. Adding the layers would have the arms
    // swinging while they hold a pickaxe overhead.
    const withUpper = poseFor(locomotion(), walking, { blueprint: carry(), elapsed: 0 });
    const laterInStride = poseFor(
      locomotion(), { ...walking, distanceTravelled: walking.distanceTravelled + 0.9 },
      { blueprint: carry(), elapsed: 0 },
    );
    // The arm is identical at two different points of the walk cycle, which is
    // only true if the cycle is not contributing to it at all.
    expect(laterInStride.rotations["ArmRight"]!.x).toBeCloseTo(
      withUpper.rotations["ArmRight"]!.x, 9,
    );
    // ...while an unmasked part did change.
    expect(laterInStride.rotations["LegLeft"]!.x).not.toBeCloseTo(
      withUpper.rotations["LegLeft"]!.x, 3,
    );
  });

  it("keeps the arms on the clip in mid-air", () => {
    // Otherwise jumping mid-swing throws the pickaxe behind your head.
    const airborne = poseFor(
      locomotion(), { ...walking, airborne: true }, { blueprint: carry(), elapsed: 0 },
    );
    const carried = sampleUpperBody(carry(), 0);
    expect(airborne.rotations["ArmRight"]!.x).toBeCloseTo(carried["ArmRight"]!.x, 9);
    // The legs still take the airborne tuck.
    expect(airborne.rotations["LegLeft"]!.x).not.toBeCloseTo(0, 3);
  });

  it("keeps the crouch off masked parts", () => {
    const upright = poseFor(locomotion(), walking, { blueprint: carry(), elapsed: 0 });
    const crouched = poseFor(
      locomotion(), { ...walking, crouched: true }, { blueprint: carry(), elapsed: 0 },
    );
    // Chest is masked by the carry clip, so the crouch must not reach it.
    expect(crouched.rotations["Chest"]!.x).toBeCloseTo(upright.rotations["Chest"]!.x, 9);
  });

  it("walks normally with no clip at all", () => {
    const bare = poseFor(locomotion(), walking);
    expect(Math.abs(bare.rotations["ArmRight"]!.x)).toBeGreaterThan(0.05);
  });
});

describe("the shipped upper-body clips", () => {
  it("drive only parts inside their own mask", () => {
    for (const clip of library.upperBody) {
      for (const frame of clip.keyframes) {
        for (const track of frame.pose) {
          expect(clip.mask, `${clip.id} -> ${track.part}`).toContain(track.part);
        }
      }
    }
  });

  it("gives every weapon a carry and a use pose that resolve", () => {
    for (const weapon of library.weapons) {
      expect(() => blueprints().upperBody(weapon.carryPoseId!), weapon.id).not.toThrow();
      expect(() => blueprints().upperBody(weapon.usePoseId!), weapon.id).not.toThrow();
    }
  });

  it("makes the pickaxe swing and the guns not", () => {
    // A rifle that swings like a pickaxe is the sort of content mix-up the
    // Blueprint layer is supposed to make obvious.
    const registry = blueprints();
    expect(registry.weapon("weapon.pickaxe").usePoseId).toBe("upper.swing");
    expect(registry.weapon("weapon.assaultRifle").usePoseId).not.toBe("upper.swing");
  });
});
