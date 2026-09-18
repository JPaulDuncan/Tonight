import { beforeEach, describe, expect, it } from "vitest";

import { blueprints } from "@/blueprints/library";
import type { HarvestableBlueprint, StormPhaseBlueprint, WeaponBlueprint } from "@/blueprints/types";
import { Rng } from "@/core/rng";
import { vec2, vec3, angleBetween3, length3 } from "@/core/math";
import {
  FireRejection, addShield, applyDamageToPool, applyDirectHealthDamage, applyHit,
  beginEquip, computeDamage, effectiveSpread, falloffAt, freshWeaponState, fullHealth,
  heal, intervalTicks, pelletDirection, splitDamage, tickWeapon, tryBeginReload, tryFire,
} from "@/gameplay/combat";
import { harvestHit, harvestStateFor, isWeakPointHit, swingsToFell, totalYield, weakPointFor } from "@/gameplay/harvest";
import { rollRarity, rollTable, spawnPoi, startingAmmoFor } from "@/gameplay/loot";
import { StormDirector, radiusAt, resolveMaxRotation, stormContains } from "@/gameplay/storm";

const TICK_RATE = 30;

describe("damage formula", () => {
  const profile = () => blueprints().damageProfile("damage.smg");

  it("is flat, then linear, then flat again", () => {
    const p = profile();
    expect(falloffAt(p, 0)).toBe(1);
    expect(falloffAt(p, p.falloffStartMetres)).toBe(1);
    expect(falloffAt(p, p.falloffEndMetres)).toBeCloseTo(p.falloffEndDamageScale, 5);
    expect(falloffAt(p, 500)).toBeCloseTo(p.falloffEndDamageScale, 5);
  });

  it("never increases with distance", () => {
    const p = profile();
    let previous = Number.MAX_VALUE;
    for (let d = 0; d <= 120; d++) {
      const current = falloffAt(p, d);
      expect(current).toBeLessThanOrEqual(previous + 1e-9);
      previous = current;
    }
  });

  it("applies the structure multiplier only to structures", () => {
    const p = profile();
    const atPlayer = computeDamage({ profile: p, targetKind: "player", distanceMetres: 0 });
    const atStructure = computeDamage({ profile: p, targetKind: "structure", distanceMetres: 0 });
    expect(atStructure / atPlayer).toBeCloseTo(p.structureMultiplier, 5);
  });

  it("makes the SMG a build shredder and the shotgun not", () => {
    // GDD 5.5: the SMG shreds builds without shredding players.
    const smg = blueprints().damageProfile("damage.smg");
    const shotgun = blueprints().damageProfile("damage.shotgun");
    expect(smg.structureMultiplier).toBeGreaterThan(1);
    expect(shotgun.structureMultiplier).toBeLessThan(1);
  });

  it("splits shield first, then health", () => {
    expect(splitDamage(50, 30, 100, 0)).toEqual({ toShield: 30, toHealth: 20 });
  });

  it("never exceeds either pool", () => {
    expect(splitDamage(10000, 30, 40, 0)).toEqual({ toShield: 30, toHealth: 40 });
  });

  it("bypasses shield in proportion to penetration", () => {
    expect(splitDamage(50, 100, 100, 1)).toEqual({ toShield: 0, toHealth: 50 });
    expect(splitDamage(50, 100, 100, 0.5)).toEqual({ toShield: 25, toHealth: 25 });
  });

  it("treats zero and negative damage as a no-op", () => {
    expect(splitDamage(0, 50, 50, 0)).toEqual({ toShield: 0, toHealth: 0 });
    expect(splitDamage(-10, 50, 50, 0)).toEqual({ toShield: 0, toHealth: 0 });
  });

  it("lets a sniper headshot kill through full shield", () => {
    const character = blueprints().character("character.default");
    const head = character.hitboxes.find((h) => h.isHead)!;
    const damage = computeDamage({
      profile: blueprints().damageProfile("damage.sniper"),
      hitbox: head, targetKind: "player", distanceMetres: 50,
    });
    expect(damage).toBeGreaterThanOrEqual(character.maxHealth + character.maxShield);
  });

  it("does not let a sniper body shot kill through full shield", () => {
    const character = blueprints().character("character.default");
    const body = character.hitboxes.find((h) => h.name === "Chest")!;
    const damage = computeDamage({
      profile: blueprints().damageProfile("damage.sniper"),
      hitbox: body, targetKind: "player", distanceMetres: 50,
    });
    expect(damage).toBeLessThan(character.maxHealth + character.maxShield);
  });
});

describe("health pool", () => {
  it("starts shield empty because it is looted, not granted", () => {
    const pool = fullHealth(100, 100);
    expect(pool.health).toBe(100);
    expect(pool.shield).toBe(0);
  });

  it("never goes negative", () => {
    const pool = fullHealth(100, 100);
    applyDamageToPool(pool, splitDamage(99999, pool.shield, pool.health, 0));
    expect(pool.health).toBe(0);
    expect(pool.shield).toBe(0);
  });

  it("respects the per-item heal cap", () => {
    const pool = fullHealth(100, 100);
    pool.health = 20;
    expect(heal(pool, 15, 75)).toBe(15);
    pool.health = 70;
    expect(heal(pool, 15, 75)).toBe(5);
    expect(heal(pool, 15, 75)).toBe(0);
  });

  it("never heals past max even with a high cap", () => {
    const pool = fullHealth(100, 100);
    pool.health = 90;
    heal(pool, 500, 999);
    expect(pool.health).toBe(100);
  });

  it("caps shield at its maximum", () => {
    const pool = fullHealth(100, 100);
    expect(addShield(pool, 250)).toBe(100);
    expect(addShield(pool, 50)).toBe(0);
  });

  it("lets storm damage bypass shield", () => {
    const pool = fullHealth(100, 100);
    addShield(pool, 100);
    applyDirectHealthDamage(pool, 10);
    expect(pool.shield).toBe(100);
    expect(pool.health).toBe(90);
  });

  it("applies a real hit end to end", () => {
    const pool = fullHealth(100, 100);
    addShield(pool, 50);
    const died = applyDamageToPool(pool, applyHit({
      profile: blueprints().damageProfile("damage.assaultRifle"),
      targetKind: "player", distanceMetres: 10,
    }, pool.shield, pool.health));
    expect(died).toBe(false);
    expect(pool.shield).toBe(20);
    expect(pool.health).toBe(100);
  });
});

describe("weapon firing", () => {
  const weapon = (id: string) => blueprints().weapon(id);

  it("fires the authored rate", () => {
    const ar = weapon("weapon.assaultRifle");
    const state = freshWeaponState(ar);
    let fired = 0;
    for (let tick = 0; tick < TICK_RATE; tick++) {
      if (tryFire(state, ar, tick, TICK_RATE, true) === FireRejection.None) fired++;
    }
    // 550 rpm at 30 Hz rounds up to one shot every 4 ticks.
    expect(intervalTicks(ar, TICK_RATE)).toBe(4);
    expect(fired).toBe(Math.ceil(TICK_RATE / 4));
  });

  it("never exceeds the authored rate", () => {
    const ar = weapon("weapon.assaultRifle");
    const state = freshWeaponState(ar);
    const shots: number[] = [];
    for (let tick = 0; tick < 120; tick++) {
      if (tryFire(state, ar, tick, TICK_RATE, true) === FireRejection.None) shots.push(tick);
    }
    for (let i = 1; i < shots.length; i++) {
      expect(shots[i]! - shots[i - 1]!).toBeGreaterThanOrEqual(intervalTicks(ar, TICK_RATE));
    }
  });

  it("needs a fresh press for semi-auto", () => {
    const pistol = weapon("weapon.pistol");
    const state = freshWeaponState(pistol);
    expect(tryFire(state, pistol, 0, TICK_RATE, true)).toBe(FireRejection.None);
    const after = state.ammoInMagazine;

    for (let tick = 1; tick < 30; tick++) {
      expect(tryFire(state, pistol, tick, TICK_RATE, true)).toBe(FireRejection.RequiresTriggerRelease);
    }
    expect(state.ammoInMagazine).toBe(after);

    tryFire(state, pistol, 31, TICK_RATE, false);
    expect(tryFire(state, pistol, 32, TICK_RATE, true)).toBe(FireRejection.None);
  });

  it("refuses to fire an empty magazine", () => {
    const sniper = weapon("weapon.sniper");
    const state = freshWeaponState(sniper);
    tryFire(state, sniper, 0, TICK_RATE, true);
    expect(state.ammoInMagazine).toBe(0);
    tryFire(state, sniper, 100, TICK_RATE, false);
    expect(tryFire(state, sniper, 200, TICK_RATE, true)).toBe(FireRejection.MagazineEmpty);
  });

  it("reloads in the authored time", () => {
    const ar = weapon("weapon.assaultRifle");
    const state = freshWeaponState(ar);
    state.ammoInMagazine = 3;

    expect(tryBeginReload(state, ar, 0, TICK_RATE, 100)).toBe(true);
    const done = Math.ceil(ar.reloadSeconds * TICK_RATE);
    tickWeapon(state, ar, done - 1, 1 / TICK_RATE);
    expect(state.isReloading).toBe(true);
    tickWeapon(state, ar, done, 1 / TICK_RATE);
    expect(state.isReloading).toBe(false);
    expect(state.ammoInMagazine).toBe(ar.magazineSize);
  });

  it("refuses a pointless reload", () => {
    const ar = weapon("weapon.assaultRifle");
    const full = freshWeaponState(ar);
    expect(tryBeginReload(full, ar, 0, TICK_RATE, 100)).toBe(false);

    const dry = freshWeaponState(ar);
    dry.ammoInMagazine = 0;
    expect(tryBeginReload(dry, ar, 0, TICK_RATE, 0)).toBe(false);
  });

  it("cancels a reload on swap rather than banking it", () => {
    const ar = weapon("weapon.assaultRifle");
    const state = freshWeaponState(ar);
    state.ammoInMagazine = 3;
    tryBeginReload(state, ar, 0, TICK_RATE, 100);
    beginEquip(state, ar, 5, TICK_RATE);
    expect(state.isReloading).toBe(false);
    expect(state.ammoInMagazine).toBe(3);
  });

  it("blocks firing while equipping", () => {
    const ar = weapon("weapon.assaultRifle");
    const state = freshWeaponState(ar);
    beginEquip(state, ar, 0, TICK_RATE);
    expect(tryFire(state, ar, 2, TICK_RATE, true)).toBe(FireRejection.Equipping);
    const ready = Math.ceil(ar.equipSeconds * TICK_RATE);
    expect(tryFire(state, ar, ready, TICK_RATE, true)).toBe(FireRejection.None);
  });

  it("says nothing happened when the trigger is not down", () => {
    // The distinction this pins: FireRejection.None means a round left the
    // barrel. Conflating it with "no input" had the sandbox counting every idle
    // tick as a shot -- animation, tracer and all -- without spending ammo.
    const ar = blueprints().weapon("weapon.assaultRifle");
    const state = freshWeaponState(ar);

    expect(tryFire(state, ar, 10, TICK_RATE, false)).toBe(FireRejection.TriggerReleased);
    expect(state.ammoInMagazine).toBe(ar.magazineSize);

    expect(tryFire(state, ar, 11, TICK_RATE, true)).toBe(FireRejection.None);
    expect(state.ammoInMagazine).toBe(ar.magazineSize - 1);
  });

  it("never reports None without spending a round", () => {
    // Swept across the fire modes, because each takes a different path through
    // tryFire and only one of them used to be wrong.
    for (const id of ["weapon.assaultRifle", "weapon.pistol", "weapon.shotgun"]) {
      const weapon = blueprints().weapon(id);
      const state = freshWeaponState(weapon);
      let fired = 0;
      for (let tick = 0; tick < 200; tick++) {
        // Trigger down only every third tick, so releases are interleaved.
        const down = tick % 3 !== 0;
        const before = state.ammoInMagazine;
        if (tryFire(state, weapon, tick, TICK_RATE, down) === FireRejection.None) {
          fired++;
          expect(state.ammoInMagazine, `${id} at tick ${tick}`).toBe(before - 1);
        } else {
          expect(state.ammoInMagazine, `${id} at tick ${tick}`).toBe(before);
        }
      }
      expect(fired, id).toBeGreaterThan(0);
    }
  });

  it("accumulates bloom and recovers it", () => {
    const ar = weapon("weapon.assaultRifle");
    const state = freshWeaponState(ar);
    for (let tick = 0; tick < 30; tick++) tryFire(state, ar, tick, TICK_RATE, true);
    expect(state.bloomDegrees).toBeGreaterThan(0);
    expect(state.bloomDegrees).toBeLessThanOrEqual(ar.bloomMaxDegrees);

    for (let tick = 30; tick < 150; tick++) tickWeapon(state, ar, tick, 1 / TICK_RATE);
    expect(state.bloomDegrees).toBeCloseTo(0, 5);
  });

  it("gives a rested single-projectile weapon a dead-centre first shot", () => {
    const ar = weapon("weapon.assaultRifle");
    const state = freshWeaponState(ar);
    expect(effectiveSpread(state, ar)).toBe(0);
    tryFire(state, ar, 0, TICK_RATE, true);
    expect(effectiveSpread(state, ar)).toBeGreaterThan(0);
  });

  it("never gives a shotgun a dead-centre shot", () => {
    // Every pellet along one line would be a sniper rifle.
    const shotgun = weapon("weapon.shotgun");
    expect(effectiveSpread(freshWeaponState(shotgun), shotgun)).toBeGreaterThan(0);
  });
});

describe("pellet spread", () => {
  it("is deterministic and inside the cone", () => {
    const shotgun = blueprints().weapon("weapon.shotgun");
    for (let pellet = 0; pellet < shotgun.pelletCount; pellet++) {
      const a = pelletDirection(vec3(0, 0, 1), shotgun.spreadDegrees, 1234, pellet);
      const b = pelletDirection(vec3(0, 0, 1), shotgun.spreadDegrees, 1234, pellet);
      expect(a).toEqual(b);
      expect(angleBetween3(vec3(0, 0, 1), a)).toBeLessThanOrEqual(shotgun.spreadDegrees + 1e-6);
      expect(length3(a)).toBeCloseTo(1, 6);
    }
  });

  it("differs between shots", () => {
    expect(pelletDirection(vec3(0, 0, 1), 4.2, 1, 0))
      .not.toEqual(pelletDirection(vec3(0, 0, 1), 4.2, 2, 0));
  });

  it("fires dead straight at zero spread", () => {
    expect(pelletDirection(vec3(0, 0, 1), 0, 7, 0)).toEqual(vec3(0, 0, 1));
  });

  it("works when aiming straight up", () => {
    // The basis construction needs a non-parallel reference vector.
    const up = pelletDirection(vec3(0, 1, 0), 5, 3, 0);
    expect(Number.isFinite(up.x) && Number.isFinite(up.y) && Number.isFinite(up.z)).toBe(true);
    expect(length3(up)).toBeCloseTo(1, 6);
  });
});

describe("harvesting", () => {
  const tree = (): HarvestableBlueprint => blueprints().harvestable("harvest.tree");
  const PICKAXE_DAMAGE = 20;
  const SWINGS_PER_SECOND = 1.4;

  it("derives a deterministic weak point", () => {
    expect(weakPointFor(77, 3)).toEqual(weakPointFor(77, 3));
    expect(weakPointFor(77, 3)).not.toEqual(weakPointFor(77, 4));
    expect(weakPointFor(1, 0)).not.toEqual(weakPointFor(2, 0));
  });

  it("keeps the weak point inset from the edges", () => {
    for (let id = 0; id < 40; id++) {
      for (let hit = 0; hit < 8; hit++) {
        const point = weakPointFor(id, hit);
        expect(point.x).toBeGreaterThanOrEqual(0.15);
        expect(point.x).toBeLessThanOrEqual(0.85);
        expect(point.y).toBeGreaterThanOrEqual(0.15);
        expect(point.y).toBeLessThanOrEqual(0.85);
      }
    }
  });

  it("doubles the yield on a weak-point hit", () => {
    const state = harvestStateFor(5, tree());
    const result = harvestHit(state, tree(), PICKAXE_DAMAGE, weakPointFor(5, 0));
    expect(result.hitWeakPoint).toBe(true);
    expect(result.yield).toBe(tree().yieldPerHit + tree().bonusYieldOnWeakPoint);
  });

  it("gives only the base yield on a miss", () => {
    const state = harvestStateFor(5, tree());
    const marker = weakPointFor(5, 0);
    const miss = vec2(marker.x > 0.5 ? 0 : 1, marker.y > 0.5 ? 0 : 1);
    expect(isWeakPointHit(5, 0, miss)).toBe(false);
    expect(harvestHit(state, tree(), PICKAXE_DAMAGE, miss).yield).toBe(tree().yieldPerHit);
  });

  it("awards the destroy bonus exactly once", () => {
    const state = harvestStateFor(5, tree());
    let destroys = 0;
    for (let i = 0; i < 60 && !state.destroyed; i++) {
      if (harvestHit(state, tree(), PICKAXE_DAMAGE, vec2(0, 0)).destroyed) destroys++;
    }
    expect(destroys).toBe(1);
    expect(harvestHit(state, tree(), PICKAXE_DAMAGE, vec2(0, 0)).yield).toBe(0);
  });

  it("never drives health negative", () => {
    const state = harvestStateFor(5, tree());
    harvestHit(state, tree(), 99999, vec2(0, 0));
    expect(state.health).toBe(0);
  });

  it("yields the documented range for a full tree", () => {
    const swings = swingsToFell(tree(), PICKAXE_DAMAGE);
    expect(totalYield(tree(), PICKAXE_DAMAGE, false)).toBe(swings * 12 + 30);
    expect(totalYield(tree(), PICKAXE_DAMAGE, true)).toBe(swings * 24 + 30);
    // The weak point must be worth real time, or it is decoration.
    expect(totalYield(tree(), PICKAXE_DAMAGE, true))
      .toBeGreaterThan(totalYield(tree(), PICKAXE_DAMAGE, false) * 1.5);
  });

  it("gathers a box's worth of wood in a few seconds", () => {
    // 40 wood is a 1x1 box at 10 per piece.
    const state = harvestStateFor(9, tree());
    let total = 0;
    let swings = 0;
    while (total < 40 && swings < 100) {
      total += harvestHit(state, tree(), PICKAXE_DAMAGE, weakPointFor(9, state.hitCount)).yield;
      swings++;
    }
    expect(swings / SWINGS_PER_SECOND).toBeLessThanOrEqual(3);
  });
});

describe("loot", () => {
  it("matches the authored rarity distribution", () => {
    // Statistical rather than example-based: a weighted table that is subtly
    // wrong still produces individually plausible rolls.
    const rarities = blueprints().raritiesByTier;
    const rng = new Rng(31337);
    const counts = new Map<number, number>();
    const samples = 100_000;

    for (let i = 0; i < samples; i++) {
      const tier = rollRarity(rarities, 0, rng)!.tier;
      counts.set(tier, (counts.get(tier) ?? 0) + 1);
    }

    const total = rarities.reduce((sum, r) => sum + r.lootWeight, 0);
    for (const rarity of rarities) {
      const expected = rarity.lootWeight / total;
      const actual = (counts.get(rarity.tier) ?? 0) / samples;
      expect(actual).toBeCloseTo(expected, 2);
    }
  });

  it("shifts chest rarity up by about one tier", () => {
    const rarities = blueprints().raritiesByTier;
    const rng = new Rng(4242);
    const samples = 20_000;
    let unbiased = 0;
    let biased = 0;
    for (let i = 0; i < samples; i++) {
      unbiased += rollRarity(rarities, 0, rng)!.tier;
      biased += rollRarity(rarities, 1, rng)!.tier;
    }
    expect(biased / samples).toBeGreaterThan(unbiased / samples + 0.5);
  });

  it("clamps a huge bias at the top tier", () => {
    const rarities = blueprints().raritiesByTier;
    const rng = new Rng(5);
    for (let i = 0; i < 300; i++) {
      expect(rollRarity(rarities, 10, rng)!.tier).toBe(4);
    }
  });

  it("is reproducible from the match seed", () => {
    const poi = blueprints().poi("poi.practiceRange");
    const a = spawnPoi(poi, blueprints(), 1234, 0);
    const b = spawnPoi(poi, blueprints(), 1234, 0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("differs between seeds", () => {
    const poi = blueprints().poi("poi.practiceRange");
    expect(JSON.stringify(spawnPoi(poi, blueprints(), 1, 0)))
      .not.toBe(JSON.stringify(spawnPoi(poi, blueprints(), 999, 0)));
  });

  it("spawns every guaranteed chest", () => {
    const poi = blueprints().poi("poi.practiceRange");
    const chests = spawnPoi(poi, blueprints(), 7, 0).filter((p) => p.kind === "chest");
    expect(chests).toHaveLength(poi.chestSpawnPoints);
  });

  it("resolves nested tables down to concrete items", () => {
    const rng = new Rng(11);
    const rolled = rollTable(blueprints().lootTable("loot.chest"), blueprints(), rng);
    expect(rolled.length).toBeGreaterThan(0);
    for (const entry of rolled) {
      expect(entry.item.kind === "weapon" || entry.item.kind === "consumable").toBe(true);
    }
  });

  it("always gives a weapon usable ammo", () => {
    for (const weapon of blueprints().library.weapons as WeaponBlueprint[]) {
      if (weapon.ammoType === "none") continue;
      expect(startingAmmoFor(weapon)).toBeGreaterThanOrEqual(weapon.magazineSize);
    }
  });

  it("spawns nothing for a missing POI", () => {
    expect(spawnPoi(undefined, blueprints(), 1, 0)).toEqual([]);
  });
});

describe("storm", () => {
  const phases = () =>
    blueprints().matchRules("rules.solo").stormPhaseIds
      .map((id) => blueprints().stormPhase(id)) as StormPhaseBlueprint[];

  const director = (seed = 1234) => new StormDirector(phases(), seed, 7.4, vec2());

  it("runs the rescoped 11:30 schedule", () => {
    expect(director().totalSeconds).toBe(690);
  });

  it("holds radius through the wait, then shrinks", () => {
    const first = phases()[0]!;
    expect(radiusAt(first, 0)).toBe(first.startRadius);
    expect(radiusAt(first, first.waitSeconds)).toBe(first.startRadius);
    expect(radiusAt(first, first.waitSeconds + first.closeSeconds)).toBe(first.endRadius);
    expect(radiusAt(first, 99999)).toBe(first.endRadius);
  });

  it("shrinks monotonically across the whole match", () => {
    const d = director();
    const players = [vec2()];
    let previous = Number.MAX_VALUE;
    for (let t = 0; t < 800; t++) {
      if (!d.finished) {
        expect(d.current.radius).toBeLessThanOrEqual(previous + 0.01);
        previous = d.current.radius;
      }
      d.advance(1, players);
    }
    expect(d.finished).toBe(true);
  });

  it("only damages players outside the circle", () => {
    const d = director();
    d.advance(1, [vec2()]);
    expect(d.damageFor(vec2(), 1)).toBe(0);
    expect(d.damageFor(vec2(5000, 0), 1)).toBeGreaterThan(0);
  });

  it("runs progress from zero to one", () => {
    const d = director();
    expect(d.progress).toBe(0);
    for (let i = 0; i < 800; i++) d.advance(1, [vec2()]);
    expect(d.progress).toBeCloseTo(1, 2);
  });

  it("is reproducible from its seed", () => {
    const players = [vec2(200, -150), vec2(-90, 40)];
    const a = director(999);
    const b = director(999);
    for (let i = 0; i < 400; i++) {
      a.advance(1, players);
      b.advance(1, players);
      expect(a.current.centre).toEqual(b.current.centre);
    }
  });

  it("never strands a player beyond the rotation clamp", () => {
    // The difference between a tense rotation and the game appearing to cheat.
    const rng = new Rng(4242);
    for (let trial = 0; trial < 20; trial++) {
      const d = director(trial);
      let impossible = false;
      d.onClampImpossible.push(() => { impossible = true; });

      const players: ReturnType<typeof vec2>[] = [];
      for (let p = 0; p < 10; p++) {
        const angle = rng.nextFloat() * Math.PI * 2;
        const radius = Math.sqrt(rng.nextFloat()) * 520;
        players.push(vec2(Math.cos(angle) * radius, Math.sin(angle) * radius));
      }

      d.advance(211, players);
      if (impossible) continue;

      const phase = phases()[d.phaseIndex]!;
      const maxDistance = resolveMaxRotation(phase, 7.4);
      const state = d.current;
      for (const player of players) {
        const toEdge = Math.hypot(player.x - state.nextCentre.x, player.y - state.nextCentre.y)
          - state.nextRadius;
        expect(toEdge).toBeLessThanOrEqual(maxDistance + 1);
      }
    }
  });

  it("keeps the next circle inside the current one", () => {
    const d = director(77);
    for (let i = 0; i < 300; i++) {
      const state = d.current;
      if (!d.finished && state.radius > 0) {
        const drift = Math.hypot(state.nextCentre.x - state.centre.x, state.nextCentre.y - state.centre.y);
        expect(drift).toBeLessThanOrEqual(state.radius + 0.01);
      }
      d.advance(1, [vec2(100, 100)]);
    }
  });

  it("reports containment correctly", () => {
    const state = director().current;
    expect(stormContains(state, vec2())).toBe(true);
    expect(stormContains(state, vec2(100000, 0))).toBe(false);
  });
});
