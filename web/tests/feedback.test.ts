/**
 * Tests for hit feedback policy.
 *
 * The DOM half of this is untestable in Node and the visual half is a judgement
 * call, but the parts that carry information -- what a number says, which
 * signal a target kind gets, and whether a shotgun blast reads as one number or
 * ten -- are arithmetic, and wrong answers there are the ones a player would
 * actually notice.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_SHOT_BUCKETS, NUMBER_LIFETIME, NUMBER_RISE_METRES, ShotAccumulator,
  displayDamage, lifeFraction, markerClass, numberClass, numberOpacity, numberRise,
} from "@/render/feedback";

const at = (x: number, y: number, z: number) => ({ x, y, z });

describe("damage as shown", () => {
  it("rounds to whole numbers", () => {
    expect(displayDamage(30.4)).toBe(30);
    expect(displayDamage(30.6)).toBe(31);
  });

  it("never shows a hit that landed as zero", () => {
    // A bullet at extreme falloff can do a fraction of a point. Showing "0"
    // reads as "you missed", which is the opposite of what happened.
    expect(displayDamage(0.2)).toBe(1);
    expect(displayDamage(0.9)).toBe(1);
  });

  it("shows nothing for no damage at all", () => {
    expect(displayDamage(0)).toBe(0);
    expect(displayDamage(-5)).toBe(0);
  });
});

describe("signals per target kind", () => {
  // Straight from docs/systems/combat.md section 5.
  it("gives a player a sharp X and a structure a chevron", () => {
    expect(markerClass("player", false)).toContain("marker-x");
    expect(markerClass("structure", false)).toContain("marker-chevron");
    expect(markerClass("harvestable", false)).toContain("marker-chevron");
  });

  it("marks a destroy distinctly without losing the base signal", () => {
    const destroyed = markerClass("structure", true);
    expect(destroyed).toContain("marker-chevron");
    expect(destroyed).toContain("marker-destroyed");
  });

  it("colours a headshot differently from a body shot", () => {
    expect(numberClass("player", true)).not.toBe(numberClass("player", false));
  });

  it("colours a structure differently from a player", () => {
    expect(numberClass("structure", false)).not.toBe(numberClass("player", false));
  });
});

describe("a number's life", () => {
  it("runs from zero to one over its lifetime", () => {
    expect(lifeFraction(0)).toBe(0);
    expect(lifeFraction(NUMBER_LIFETIME / 2)).toBeCloseTo(0.5, 6);
    expect(lifeFraction(NUMBER_LIFETIME)).toBe(1);
    expect(lifeFraction(NUMBER_LIFETIME * 5)).toBe(1);
  });

  it("stays fully readable before it starts fading", () => {
    // Fading from the first frame makes a number hardest to read exactly when
    // it appears, which is when the player looks at it.
    expect(numberOpacity(0)).toBe(1);
    expect(numberOpacity(0.3)).toBe(1);
    expect(numberOpacity(0.5)).toBeLessThan(1);
    expect(numberOpacity(1)).toBe(0);
  });

  it("never goes transparent early or negative", () => {
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const opacity = numberOpacity(f);
      expect(opacity).toBeGreaterThanOrEqual(0);
      expect(opacity).toBeLessThanOrEqual(1);
    }
  });

  it("rises monotonically and settles at the full distance", () => {
    let previous = -1;
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const rise = numberRise(f);
      expect(rise).toBeGreaterThanOrEqual(previous);
      previous = rise;
    }
    expect(numberRise(0)).toBeCloseTo(0, 6);
    expect(numberRise(1)).toBeCloseTo(NUMBER_RISE_METRES, 6);
  });

  it("moves most at the start", () => {
    // Eased out: the number leaves the hit point promptly, then slows as it
    // fades, rather than drifting at a constant crawl.
    expect(numberRise(0.5)).toBeGreaterThan(NUMBER_RISE_METRES / 2);
  });
});

describe("aggregating a shot", () => {
  it("sums every pellet that hit one target into one number", () => {
    // The readability point: a shotgun shell is one number, not ten stacked on
    // the same pixel.
    const shot = new ShotAccumulator();
    for (let pellet = 0; pellet < 10; pellet++) {
      shot.add("piece:0,0,0:0", "structure", 7, at(1, 2, 3));
    }
    const entries = [...shot.entries()];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amount).toBe(70);
  });

  it("keeps separate targets separate", () => {
    const shot = new ShotAccumulator();
    shot.add("wall", "structure", 12, at(0, 0, 0));
    shot.add("tree", "harvestable", 8, at(5, 0, 0));
    const entries = [...shot.entries()].sort((a, b) => a.amount - b.amount);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.kind)).toEqual(["harvestable", "structure"]);
  });

  it("ignores pellets that did nothing", () => {
    const shot = new ShotAccumulator();
    shot.add("wall", "structure", 0, at(0, 0, 0));
    expect([...shot.entries()]).toHaveLength(0);
    expect(shot.anyHits).toBe(false);
  });

  it("remembers a headshot even when later pellets are body shots", () => {
    const shot = new ShotAccumulator();
    shot.add("player:3", "player", 40, at(0, 0, 0), true);
    shot.add("player:3", "player", 10, at(0, 0, 0), false);
    const entry = [...shot.entries()][0]!;
    expect(entry.headshot).toBe(true);
    expect(entry.amount).toBe(50);
  });

  it("keeps the total right when a shot hits more targets than it has buckets", () => {
    // Dropping the overflow would show less damage than was dealt, which is
    // worse than merging it: the number would be a lie rather than a summary.
    const shot = new ShotAccumulator(2);
    shot.add("a", "structure", 5, at(0, 0, 0));
    shot.add("b", "structure", 6, at(0, 0, 0));
    shot.add("c", "structure", 7, at(0, 0, 0));
    const total = [...shot.entries()].reduce((sum, e) => sum + e.amount, 0);
    expect(total).toBe(18);
  });

  it("is reusable without allocating new buckets", () => {
    // The pooling rule: the same bucket objects have to survive a clear.
    const shot = new ShotAccumulator();
    const identities = shot.buckets.map((b) => b);
    shot.add("wall", "structure", 10, at(0, 0, 0));
    shot.clear();
    shot.add("other", "harvestable", 4, at(1, 1, 1));

    expect(shot.buckets.map((b) => b)).toEqual(identities);
    const entries = [...shot.entries()];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.targetId).toBe("other");
    expect(entries[0]!.amount).toBe(4);
  });

  it("carries the killing blow through to the marker", () => {
    // The flag comes from applyDamage rather than from asking the structure
    // afterwards: by then another pellet of the same shot may have removed the
    // piece, or nothing may have yet, and neither answers "did this hit kill it".
    const shot = new ShotAccumulator();
    shot.add("wall", "structure", 20, at(0, 0, 0), false, false);
    shot.add("wall", "structure", 20, at(0, 0, 0), false, true);
    expect([...shot.entries()][0]!.destroyed).toBe(true);
  });

  it("does not leak a destroy into the next shot", () => {
    const shot = new ShotAccumulator();
    shot.add("wall", "structure", 20, at(0, 0, 0), false, true);
    shot.clear();
    shot.add("other", "structure", 5, at(0, 0, 0));
    expect([...shot.entries()][0]!.destroyed).toBe(false);
  });

  it("allocates its buckets up front", () => {
    expect(new ShotAccumulator().buckets).toHaveLength(MAX_SHOT_BUCKETS);
  });
});
