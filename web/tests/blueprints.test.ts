import { describe, expect, it } from "vitest";

import { blueprints, library, validateShippedContent } from "@/blueprints/library";
import { brokenClone } from "./helpers";
import { packMask, SOLID_MASK, validateLibrary, type Finding } from "@/blueprints/registry";

const errors = (findings: readonly Finding[]) => findings.filter((f) => f.severity === "error");
const warnings = (findings: readonly Finding[]) => findings.filter((f) => f.severity === "warning");

describe("shipped content", () => {
  it("passes every validation check", () => {
    const findings = validateShippedContent();
    const failures = errors(findings);
    expect(failures.map((f) => `${f.subject ?? ""}: ${f.message}`)).toEqual([]);
  });

  it("produces no warnings either", () => {
    expect(warnings(validateShippedContent()).map((f) => f.message)).toEqual([]);
  });

  it("loads every blueprint into the registry", () => {
    const registry = blueprints();
    const total = Object.values(library).reduce((sum, group) => sum + group.length, 0);
    expect(registry.count).toBe(total);
    expect(total).toBeGreaterThan(60);
  });

  it("resolves references across files", () => {
    const registry = blueprints();
    const shotgun = registry.weapon("weapon.shotgun");
    expect(registry.damageProfile(shotgun.damageProfileId).baseDamage).toBe(9);
    // A shotgun is a weapon with pelletCount > 1. There is no shotgun code path.
    expect(shotgun.pelletCount).toBeGreaterThan(1);
  });
});

describe("the rescope to 30 players", () => {
  it("gives every mode a lobby size that divides evenly", () => {
    // Squads of four would leave a short squad at 30, which is why the mode is
    // Trios. The validator enforces this; the test states the intent.
    for (const rules of library.matchRules) {
      expect(rules.maxPlayers % rules.squadSize).toBe(0);
      expect(rules.maxPlayers).toBe(30);
    }
  });

  it("runs a storm of eleven and a half minutes", () => {
    const solo = blueprints().matchRules("rules.solo");
    const total = solo.stormPhaseIds
      .map((id) => blueprints().stormPhase(id))
      .reduce((sum, p) => sum + p.waitSeconds + p.closeSeconds, 0);

    expect(total).toBe(690);
    expect(total / 60).toBeCloseTo(11.5, 1);
  });

  it("keeps storm radii continuous so the circle never teleports", () => {
    const phases = [...library.stormPhases].sort((a, b) => a.phaseIndex - b.phaseIndex);
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i]!.startRadius).toBe(phases[i - 1]!.endRadius);
    }
    expect(phases[0]!.startRadius).toBe(800);
    expect(phases.at(-1)!.endRadius).toBe(0);
  });

  it("starts the storm wide enough to cover the map", () => {
    const map = blueprints().map("map.nightfallIsle");
    const first = blueprints().stormPhase("storm.phase0");
    // The opening circle must reach the corners, or players spawn in the storm.
    expect(first.startRadius).toBeGreaterThanOrEqual((map.sizeMetres / 2) * Math.SQRT2 * 0.7);
  });

  it("has a lighting keyframe for every storm phase", () => {
    const lighting = blueprints().lighting("lighting.nightfall");
    for (const phase of library.stormPhases) {
      expect(lighting.keyframesByPhase.some((k) => k.phaseIndex === phase.phaseIndex)).toBe(true);
    }
  });

  it("dips below the horizon at night and returns by sunrise", () => {
    // The night clock is the game's identity mechanic (vision pillar 2).
    const keys = [...blueprints().lighting("lighting.nightfall").keyframesByPhase]
      .sort((a, b) => a.phaseIndex - b.phaseIndex);
    expect(keys[0]!.sunElevationDegrees).toBeGreaterThan(0);
    expect(Math.min(...keys.map((k) => k.sunElevationDegrees))).toBeLessThan(-15);
    expect(keys.at(-1)!.sunElevationDegrees).toBeGreaterThan(0);
  });
});

describe("validator catches broken content", () => {
  const clone = () => brokenClone(library);

  it("reports a duplicate id", () => {
    const broken = clone();
    broken.rarities[1] = { ...broken.rarities[0]! };
    expect(errors(validateLibrary(broken)).some((f) => f.message.includes("claimed by"))).toBe(true);
  });

  it("reports a duplicate rarity tier", () => {
    const broken = clone();
    broken.rarities[1]!.tier = 0;
    expect(errors(validateLibrary(broken)).some((f) => f.message.includes("tier 0"))).toBe(true);
  });

  it("reports a storm radius discontinuity", () => {
    const broken = clone();
    broken.stormPhases[2]!.startRadius = 999;
    expect(errors(validateLibrary(broken)).some((f) => f.message.includes("teleport"))).toBe(true);
  });

  it("reports a loot table cycle", () => {
    const broken = clone();
    const weapons = broken.lootTables.find((t) => t.id === "loot.weapons")!;
    weapons.entries.push({
      kind: "table", tableId: "loot.chest", weight: 1, countRange: { min: 1, max: 1 },
    });
    expect(errors(validateLibrary(broken)).some((f) => f.message.includes("cycle"))).toBe(true);
  });

  it("reports a dangling reference", () => {
    const broken = clone();
    broken.weapons[0]!.damageProfileId = "damage.nope";
    expect(errors(validateLibrary(broken)).some((f) => f.message.includes("does not exist"))).toBe(true);
  });

  it("reports a zero visibility floor", () => {
    // A zero here would make deep night an accidental stealth mechanic.
    const broken = clone();
    broken.lighting[0]!.minPlayerRimIntensity = 0;
    expect(errors(validateLibrary(broken)).some((f) => f.message.includes("stealth"))).toBe(true);
  });

  it("reports a health ramp that weakens over time", () => {
    const broken = clone();
    broken.buildMaterials[0]!.fullHealth = 10;
    expect(errors(validateLibrary(broken)).some((f) => f.message.includes("weakens"))).toBe(true);
  });

  it("reports a ramp that claims face occupancy", () => {
    const broken = clone();
    const ramp = broken.buildPieces.find((p) => p.placement === "ramp")!;
    ramp.occupancy = "face";
    expect(errors(validateLibrary(broken)).some((f) => f.message.includes("interior"))).toBe(true);
  });

  it("reports a lobby size that leaves a short squad", () => {
    const broken = clone();
    broken.matchRules[0]!.squadSize = 4;
    expect(errors(validateLibrary(broken)).some((f) => f.message.includes("divide evenly"))).toBe(true);
  });

  it("reports a bot carrying more shield than it can hold", () => {
    const broken = clone();
    broken.bots[0]!.startingShield = 500;
    expect(errors(validateLibrary(broken)).some((f) => f.message.includes("maxShield"))).toBe(true);
  });

  it("reports a bot that never comes back", () => {
    const broken = clone();
    broken.bots[0]!.respawnSeconds = 0;
    expect(errors(validateLibrary(broken)).some((f) => f.message.includes("never returns"))).toBe(true);
  });

  it("reports a bot holding a pickaxe", () => {
    // Nothing moves a bot, so a melee bot is a scarecrow that thinks it is
    // fighting -- and it would read as a broken AI rather than as bad content.
    const broken = clone();
    broken.bots[1]!.weaponId = "weapon.pickaxe";
    expect(errors(validateLibrary(broken)).some((f) => f.message.includes("does not move"))).toBe(true);
  });

  it("warns when a bot's trigger discipline is faster than its gun", () => {
    const broken = clone();
    broken.bots[1]!.secondsBetweenShots = 0.01;
    expect(warnings(validateLibrary(broken)).some((f) => f.message.includes("inert"))).toBe(true);
  });
});

describe("edit masks", () => {
  it("packs the doorway and window to different keys", () => {
    const wall = blueprints().buildPiece("piece.wall");
    const doorway = wall.editVariants.find((v) => v.variantName === "Doorway")!;
    const window = wall.editVariants.find((v) => v.variantName === "Window")!;
    expect(packMask(doorway.gridMask)).not.toBe(packMask(window.gridMask));
  });

  it("cuts the doorway through to the floor", () => {
    // Mask index 7 is bottom-middle. A doorway whose opening floats above the
    // floor would be a window with extra steps.
    const wall = blueprints().buildPiece("piece.wall");
    const doorway = wall.editVariants.find((v) => v.variantName === "Doorway")!;
    expect(doorway.gridMask[7]).toBe(false);

    const window = wall.editVariants.find((v) => v.variantName === "Window")!;
    expect(window.gridMask[7]).toBe(true);
  });

  it("packs an unedited mask to the solid key", () => {
    expect(packMask([true, true, true, true, true, true, true, true, true])).toBe(SOLID_MASK);
  });
});
