/**
 * The storm as the sandbox runs it, and the night clock it drives.
 *
 * `systems.test.ts` already covers the director's geometry: radius curves, the
 * rotation clamp, the centre choice. What is checked here is the part that had
 * never been run -- a storm sized for the sandbox island, the damage tick, and
 * the lighting that rides on top of it.
 *
 * The lighting assertions are the ones that keep vision pillar 2 honest.
 * "No discontinuity across a phase boundary" is in storm.md's test plan as a
 * browser test; it is arithmetic, so it is here instead, where it can fail in
 * under a second rather than in a screenshot nobody compares.
 */

import { describe, expect, it } from "vitest";

import { blueprints } from "@/blueprints/library";
import type { MatchLightingBlueprint, MatchRulesBlueprint } from "@/blueprints/types";
import { vec2 } from "@/core/math";
import { StormDirector, phaseTotalSeconds, radiusAt, stormContains } from "@/gameplay/storm";
import { mixRgb, parseHex, skyAt, sunPosition, toHex } from "@/gameplay/nightclock";

const registry = () => blueprints();
const sandboxRules = () => registry().matchRules("rules.sandbox");
const sandboxPhases = () =>
  sandboxRules().stormPhaseIds.map((id) => registry().stormPhase(id));
const lighting = () => registry().lighting("lighting.nightfall");

const director = (seed = 7) =>
  new StormDirector(sandboxPhases(), seed, 7.4, vec2(0, 0));

describe("the sandbox storm", () => {
  it("is a different asset from the match storm, not a different code path", () => {
    const solo = registry().matchRules("rules.solo");
    const sandbox = sandboxRules();
    const differing = (Object.keys(sandbox) as (keyof MatchRulesBlueprint)[]).filter(
      (key) => JSON.stringify(sandbox[key]) !== JSON.stringify(solo[key]),
    );
    // Id, name and description aside, the only field that differs is the phase
    // list. That is what storm.md section 5 promises a faster mode is.
    expect(differing.sort()).toEqual(["description", "displayName", "id", "stormPhaseIds"]);
  });

  it("fits inside the island it closes on", () => {
    // The terrain is 200 m across and falls away to shore well before the edge,
    // so a first circle wider than the land would never touch anybody.
    const first = sandboxPhases()[0]!;
    expect(first.startRadius).toBeLessThan(100);
    expect(first.startRadius).toBeGreaterThan(40);
  });

  it("closes to nothing", () => {
    const last = sandboxPhases().at(-1)!;
    expect(last.endRadius).toBe(0);
  });

  it("runs a whole night in a testing session", () => {
    const seconds = sandboxPhases().reduce((sum, p) => sum + phaseTotalSeconds(p), 0);
    expect(seconds).toBeGreaterThan(6 * 60);
    expect(seconds).toBeLessThan(9 * 60);
  });

  it("holds its radius through the wait and then closes", () => {
    const phase = sandboxPhases()[0]!;
    expect(radiusAt(phase, 0)).toBe(phase.startRadius);
    expect(radiusAt(phase, phase.waitSeconds)).toBe(phase.startRadius);
    expect(radiusAt(phase, phase.waitSeconds + phase.closeSeconds)).toBe(phase.endRadius);
    expect(radiusAt(phase, phase.waitSeconds + phase.closeSeconds / 2))
      .toBeCloseTo((phase.startRadius + phase.endRadius) / 2, 5);
  });
});

describe("standing in it", () => {
  it("costs nothing inside and health outside", () => {
    const storm = director();
    const dps = sandboxPhases()[0]!.damagePerSecond;

    expect(storm.damageFor(vec2(0, 0), 1)).toBe(0);
    expect(storm.damageFor(vec2(0, 500), 1)).toBeCloseTo(dps, 6);
  });

  it("stops the moment you step back in", () => {
    const storm = director();
    expect(storm.damageFor(vec2(0, 500), 1)).toBeGreaterThan(0);
    expect(storm.damageFor(vec2(0, 0), 1)).toBe(0);
  });

  it("scales with the interval, so a slow frame is not a free second", () => {
    const storm = director();
    const full = storm.damageFor(vec2(0, 500), 1);
    expect(storm.damageFor(vec2(0, 500), 0.5)).toBeCloseTo(full / 2, 6);
  });

  it("hurts more in later phases", () => {
    const phases = sandboxPhases();
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i]!.damagePerSecond).toBeGreaterThanOrEqual(phases[i - 1]!.damagePerSecond);
    }
    expect(phases.at(-1)!.damagePerSecond).toBeGreaterThan(phases[0]!.damagePerSecond);
  });

  it("keeps hurting after the last phase closes", () => {
    // The circle reaches zero and the match should be over. Nothing in a
    // sandbox ends it, so the storm must not quietly become harmless.
    const storm = director();
    let elapsed = 0;
    const total = sandboxPhases().reduce((sum, p) => sum + phaseTotalSeconds(p), 0);
    while (elapsed < total + 5) {
      storm.advance(1, []);
      elapsed += 1;
    }
    expect(storm.finished).toBe(true);
    expect(storm.damageFor(vec2(0, 0), 1)).toBeGreaterThan(0);
  });
});

describe("the circle over time", () => {
  it("shrinks monotonically across the whole night", () => {
    const storm = director();
    let previous = storm.current.radius;
    for (let second = 0; second < 400; second++) {
      storm.advance(1, [vec2(0, 0)]);
      const radius = storm.current.radius;
      // Within a hair: the boundary between phases is exact by validation.
      expect(radius).toBeLessThanOrEqual(previous + 1e-6);
      previous = radius;
    }
    expect(previous).toBeLessThan(sandboxPhases()[0]!.startRadius);
  });

  it("sweeps toward the next centre while closing rather than shrinking in place", () => {
    // A seed whose first circle actually moves, so the assertion has something
    // to measure. Picking one rather than trusting the default keeps this from
    // passing by accident on a rotation of nearly zero.
    let storm = director();
    for (let seed = 1; seed < 40; seed++) {
      storm = director(seed);
      const from = storm.current.centre;
      const to = storm.current.nextCentre;
      if (Math.hypot(to.x - from.x, to.y - from.y) > 5) break;
    }

    const phase = sandboxPhases()[0]!;
    const start = storm.current.centre;
    const target = storm.current.nextCentre;
    const distanceToTarget = (p: { x: number; y: number }) =>
      Math.hypot(target.x - p.x, target.y - p.y);

    expect(distanceToTarget(start)).toBeGreaterThan(5);

    storm.advance(phase.waitSeconds, [vec2(0, 0)]);
    expect(storm.current.isClosing).toBe(false);
    expect(distanceToTarget(storm.current.centre)).toBeCloseTo(distanceToTarget(start), 6);

    storm.advance(phase.closeSeconds * 0.5, [vec2(0, 0)]);
    expect(storm.current.isClosing).toBe(true);
    // Halfway through the close, halfway to the new centre.
    expect(distanceToTarget(storm.current.centre))
      .toBeCloseTo(distanceToTarget(start) / 2, 4);
  });

  it("reports the countdown to the next change of state", () => {
    const storm = director();
    const phase = sandboxPhases()[0]!;
    expect(storm.current.isClosing).toBe(false);
    expect(storm.current.secondsRemainingInStage).toBeCloseTo(phase.waitSeconds, 6);

    storm.advance(phase.waitSeconds + 1, [vec2(0, 0)]);
    expect(storm.current.isClosing).toBe(true);
    expect(storm.current.secondsRemainingInStage).toBeCloseTo(phase.closeSeconds - 1, 6);
  });

  it("reports the hand of the night clock separately from match progress", () => {
    // Phases differ in length, so "how far through this phase" and "how far
    // through the night" move at different rates. The lighting keyframes are
    // per phase, so it is the first that drives the sky.
    const storm = director();
    const phase = sandboxPhases()[0]!;
    expect(storm.phaseFraction).toBe(0);

    storm.advance(phaseTotalSeconds(phase) / 2, [vec2(0, 0)]);
    expect(storm.phaseFraction).toBeCloseTo(0.5, 6);
    expect(storm.progress).toBeLessThan(0.5);

    storm.advance(phaseTotalSeconds(phase) / 2, [vec2(0, 0)]);
    expect(storm.phaseIndex).toBe(1);
    expect(storm.phaseFraction).toBe(0);
  });

  it("puts the safe point inside the circle it is closing to", () => {
    const storm = director();
    const state = storm.current;
    expect(stormContains(state, state.centre)).toBe(true);
  });
});

describe("the night clock", () => {
  const sky = (phase: number, fraction: number) => skyAt(lighting(), phase, fraction);

  it("reads colours the way they were authored", () => {
    expect(parseHex("#ff8000")).toEqual({ r: 1, g: 128 / 255, b: 0 });
    expect(toHex(parseHex("#3a7fbd"))).toBe("#3a7fbd");
  });

  it("falls back to grey rather than black on a colour it cannot read", () => {
    // Black would read as "the sun went out", which is a harder bug to spot
    // than a flat grey sky.
    expect(parseHex("not a colour")).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
  });

  it("mixes toward the far end and clamps outside 0..1", () => {
    const a = { r: 0, g: 0, b: 0 };
    const b = { r: 1, g: 1, b: 1 };
    expect(mixRgb(a, b, 0.5).r).toBeCloseTo(0.5, 6);
    expect(mixRgb(a, b, 5).r).toBe(1);
    expect(mixRgb(a, b, -5).r).toBe(0);
  });

  it("has no discontinuity at a phase boundary", () => {
    // storm.md section 6 asks for this as a browser test. It is arithmetic:
    // the end of one phase and the start of the next must describe one sky,
    // or the whole night flickers six times.
    for (let phase = 0; phase < 6; phase++) {
      const before = sky(phase, 1);
      const after = sky(phase + 1, 0);
      expect(after.sunElevationDegrees).toBeCloseTo(before.sunElevationDegrees, 6);
      expect(after.sunIntensity).toBeCloseTo(before.sunIntensity, 6);
      expect(after.fogDensity).toBeCloseTo(before.fogDensity, 6);
      expect(toHex(after.sun)).toBe(toHex(before.sun));
      expect(toHex(after.fog)).toBe(toHex(before.fog));
    }
  });

  it("moves continuously within a phase", () => {
    const start = sky(0, 0);
    const middle = sky(0, 0.5);
    const end = sky(0, 1);
    expect(middle.sunElevationDegrees).toBeLessThan(start.sunElevationDegrees);
    expect(middle.sunElevationDegrees).toBeGreaterThan(end.sunElevationDegrees);
  });

  it("goes dark in the middle of the night and comes back", () => {
    const dusk = sky(0, 0);
    const deep = sky(3, 0);
    const dawn = sky(6, 0);

    expect(deep.sunElevationDegrees).toBeLessThan(0);
    expect(deep.sunIntensity).toBeLessThan(dusk.sunIntensity);
    expect(dawn.sunElevationDegrees).toBeGreaterThan(0);
    expect(dawn.sunIntensity).toBeGreaterThan(deep.sunIntensity);
  });

  it("never drops the visibility floor, however dark the sky gets", () => {
    // The hard constraint from storm.md section 3: ambient level never affects
    // gameplay, so the rim floor is a constant of the Blueprint and not
    // something the clock is allowed to interpolate away.
    const floor = lighting().minPlayerRimIntensity;
    for (let phase = 0; phase <= 7; phase++) {
      for (const fraction of [0, 0.37, 1]) {
        expect(sky(phase, fraction).rimIntensity).toBe(floor);
      }
    }
  });

  it("holds the last keyframe past the end rather than extrapolating", () => {
    const last = sky(6, 0);
    expect(sky(9, 0.5).sunElevationDegrees).toBe(last.sunElevationDegrees);
  });

  it("survives a blueprint with no keyframes at all", () => {
    const empty = { ...lighting(), keyframesByPhase: [] } as MatchLightingBlueprint;
    expect(skyAt(empty, 2, 0.5).rimIntensity).toBe(empty.minPlayerRimIntensity);
  });

  it("puts the sun below the horizon when the elevation is negative", () => {
    expect(sunPosition(-22, 100).y).toBeLessThan(0);
    expect(sunPosition(8, 100).y).toBeGreaterThan(0);
    const level = sunPosition(0, 100);
    expect(Math.hypot(level.x, level.z)).toBeCloseTo(100, 6);
  });
});
