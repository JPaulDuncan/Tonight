/**
 * Tests for the walk cycle.
 *
 * "The character skates" and "the legs are in phase" are the two ways a walk
 * cycle goes wrong, and neither is visible to a test that only checks a mesh
 * exists. Both are arithmetic, so both are checkable here in Node.
 */

import { describe, expect, it } from "vitest";

import { blueprints, library } from "@/blueprints/library";
import type { LocomotionBlueprint } from "@/blueprints/types";
import { cyclePhase, cycleWeight, poseFor } from "@/render/pose";

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
