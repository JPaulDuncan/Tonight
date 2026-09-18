/**
 * Health, shields, elimination, and the bots that make them matter.
 *
 * The damage arithmetic itself is covered in systems.test.ts. What is checked
 * here is everything around it: that a shield is spent before health, that a
 * hit which finishes somebody reports so exactly once, that an eliminated
 * combatant comes back when its Blueprint says and not before, that an
 * interrupted heal costs time but not the item, and that a bot's difficulty is
 * entirely a matter of the numbers it was authored with.
 */

import { describe, expect, it } from "vitest";

import { blueprints } from "@/blueprints/library";
import type { BotBlueprint, ConsumableBlueprint } from "@/blueprints/types";
import { applyHit, fullHealth } from "@/gameplay/combat";
import {
  EliminationFeed, FEED_CAPACITY, damageCombatant, damageHealthDirectly, effectiveHealth,
  makeCombatant, readyToRespawn, respawnCombatant,
} from "@/gameplay/combatant";
import {
  beginUse, canBeginUse, cancelUse, channelFraction, completeUse, freshChannel,
  interruptOnDamage, wouldRestore,
} from "@/gameplay/consumable";
import { decideBot, freshBotState, provoke, resetBotState } from "@/gameplay/bot";

const TICK_RATE = 30;
const character = () => blueprints().character("character.default");
const consumable = (id: string) => blueprints().get<ConsumableBlueprint>(id);
const bot = (id: string) => blueprints().get<BotBlueprint>(id);

const hit = (amount: number) => ({ toShield: 0, toHealth: amount });

describe("a combatant's pools", () => {
  it("spawns with the character's health and the Blueprint's shield", () => {
    const target = makeCombatant(2, "Skirmisher", character(), 50);
    expect(target.pool.health).toBe(100);
    expect(target.pool.shield).toBe(50);
    expect(effectiveHealth(target)).toBe(150);
  });

  it("cannot be authored with more shield than it can hold", () => {
    const target = makeCombatant(2, "Overshielded", character(), 500);
    expect(target.pool.shield).toBe(character().maxShield);
  });

  it("spends shield before health", () => {
    const target = makeCombatant(2, "Skirmisher", character(), 50);
    const split = applyHit(
      {
        profile: blueprints().damageProfile("damage.pistol"),
        targetKind: "player",
        distanceMetres: 5,
      },
      target.pool.shield, target.pool.health,
    );
    damageCombatant(target, split, 1, 0, 30);

    expect(target.pool.shield).toBeLessThan(50);
    expect(target.pool.health).toBe(100);
  });

  it("carries damage past an empty shield into health", () => {
    const target = makeCombatant(2, "Skirmisher", character(), 10);
    damageCombatant(target, { toShield: 10, toHealth: 15 }, 1, 0, 30);
    expect(target.pool.shield).toBe(0);
    expect(target.pool.health).toBe(85);
  });

  it("reports the killing blow once and only once", () => {
    // Two pellets of one shell both land on a combatant with 5 health left.
    // Only the first of them eliminated anybody.
    const target = makeCombatant(2, "Skirmisher", character(), 0);
    target.pool.health = 5;

    expect(damageCombatant(target, hit(20), 1, 10, 30).eliminated).toBe(true);
    expect(damageCombatant(target, hit(20), 1, 10, 30).eliminated).toBe(false);
    expect(target.alive).toBe(false);
  });

  it("leaves the dead alone", () => {
    const target = makeCombatant(2, "Skirmisher", character(), 0);
    damageCombatant(target, hit(200), 1, 0, 30);
    const after = damageCombatant(target, hit(50), 1, 5, 30);
    expect(after).toEqual({ toShield: 0, toHealth: 0, eliminated: false });
  });

  it("remembers who did it", () => {
    const target = makeCombatant(2, "Skirmisher", character(), 0);
    damageCombatant(target, hit(10), 7, 12, 30);
    expect(target.lastAttackerId).toBe(7);
    expect(target.lastDamagedTick).toBe(12);
  });
});

describe("fall and storm damage", () => {
  it("ignores shield entirely", () => {
    // movement.md section 5 and combat.md section 1: both bypass the shield by
    // design. A fall that a shield potion could absorb would make building
    // under yourself pointless.
    const target = makeCombatant(1, "Player", character(), 100);
    damageHealthDirectly(target, 40, 0, 30);
    expect(target.pool.shield).toBe(100);
    expect(target.pool.health).toBe(60);
  });

  it("can eliminate", () => {
    const target = makeCombatant(1, "Player", character(), 100);
    expect(damageHealthDirectly(target, 250, 0, 30).eliminated).toBe(true);
    expect(target.pool.health).toBe(0);
  });

  it("never takes health below zero", () => {
    const target = makeCombatant(1, "Player", character(), 0);
    damageHealthDirectly(target, 1e6, 0, 30);
    expect(target.pool.health).toBe(0);
  });
});

describe("elimination and respawn", () => {
  it("stays down until its respawn tick", () => {
    const target = makeCombatant(2, "Skirmisher", character(), 0);
    damageCombatant(target, hit(200), 1, 100, 12 * TICK_RATE);

    expect(readyToRespawn(target, 100)).toBe(false);
    expect(readyToRespawn(target, 100 + 12 * TICK_RATE - 1)).toBe(false);
    expect(readyToRespawn(target, 100 + 12 * TICK_RATE)).toBe(true);
  });

  it("comes back at full health and its authored shield", () => {
    const target = makeCombatant(2, "Skirmisher", character(), 50);
    damageCombatant(target, hit(200), 1, 0, 30);
    respawnCombatant(target);

    expect(target.alive).toBe(true);
    expect(target.pool.health).toBe(100);
    expect(target.pool.shield).toBe(50);
    expect(target.lastAttackerId).toBe(-1);
  });

  it("never schedules a respawn in the same tick it died", () => {
    // A zero delay would resurrect it inside the same shot, and the shell's
    // remaining pellets would find it alive again.
    const target = makeCombatant(2, "Skirmisher", character(), 0);
    damageCombatant(target, hit(200), 1, 40, 0);
    expect(readyToRespawn(target, 40)).toBe(false);
  });
});

describe("the kill feed", () => {
  it("shows the newest first", () => {
    const feed = new EliminationFeed();
    feed.record("Player", "Target Bot", "Pistol", false, 0);
    feed.record("Player", "Skirmisher", "Assault Rifle", true, 1);

    const shown = [...feed.visible(1, 300)];
    expect(shown.map((e) => e.victimName)).toEqual(["Skirmisher", "Target Bot"]);
    expect(shown[0]!.headshot).toBe(true);
  });

  it("drops entries older than the window", () => {
    const feed = new EliminationFeed();
    feed.record("Player", "Target Bot", "Pistol", false, 0);
    expect([...feed.visible(10, 300)]).toHaveLength(1);
    expect([...feed.visible(400, 300)]).toHaveLength(0);
  });

  it("keeps the most recent when it overflows, without allocating", () => {
    const feed = new EliminationFeed();
    const identities = feed.entries.map((e) => e);
    for (let i = 0; i < FEED_CAPACITY + 3; i++) {
      feed.record("Player", `Bot ${i}`, "Pistol", false, i);
    }

    expect(feed.entries.map((e) => e)).toEqual(identities);
    const shown = [...feed.visible(FEED_CAPACITY + 3, 300)];
    expect(shown).toHaveLength(FEED_CAPACITY);
    expect(shown[0]!.victimName).toBe(`Bot ${FEED_CAPACITY + 2}`);
  });
});

describe("using a consumable", () => {
  const pool = () => {
    const p = fullHealth(100, 100);
    p.health = 40;
    return p;
  };

  it("refuses an item that would do nothing", () => {
    // A bandage at full health is not a heal, it is three seconds and one
    // fewer bandage.
    const bandage = consumable("consumable.bandage");
    const full = fullHealth(100, 100);
    expect(wouldRestore(bandage, full)).toBe(false);
    expect(canBeginUse(freshChannel(), bandage, full, 5)).toBe(false);
  });

  it("refuses a bandage above its cap even below full health", () => {
    const bandage = consumable("consumable.bandage");
    const p = fullHealth(100, 100);
    p.health = 80;                       // the bandage caps at 75
    expect(wouldRestore(bandage, p)).toBe(false);
  });

  it("refuses when there are none left", () => {
    expect(canBeginUse(freshChannel(), consumable("consumable.bandage"), pool(), 0)).toBe(false);
  });

  it("channels for the authored time", () => {
    const state = freshChannel();
    const medkit = consumable("consumable.medkit");      // 10 seconds
    const p = pool();

    expect(beginUse(state, medkit, p, 1, 0, TICK_RATE)).toBe(true);
    expect(completeUse(state, medkit, p, 10 * TICK_RATE - 1)).toBeUndefined();
    expect(p.health).toBe(40);                            // nothing yet

    const done = completeUse(state, medkit, p, 10 * TICK_RATE);
    expect(done?.healed).toBe(60);
    expect(p.health).toBe(100);
    expect(state.active).toBe(false);
  });

  it("caps a bandage below maximum", () => {
    const state = freshChannel();
    const bandage = consumable("consumable.bandage");     // 15 health, caps at 75
    const p = fullHealth(100, 100);
    p.health = 70;

    beginUse(state, bandage, p, 5, 0, TICK_RATE);
    expect(completeUse(state, bandage, p, 3 * TICK_RATE)?.healed).toBe(5);
    expect(p.health).toBe(75);
  });

  it("restores shield without touching health", () => {
    const state = freshChannel();
    const mini = consumable("consumable.miniShield");
    const p = pool();

    beginUse(state, mini, p, 3, 0, TICK_RATE);
    const done = completeUse(state, mini, p, 2 * TICK_RATE);
    expect(done?.shielded).toBe(25);
    expect(done?.healed).toBe(0);
    expect(p.health).toBe(40);
  });

  it("spends the item on completion, not on start", () => {
    // An interrupted heal wastes time but not the item. Being punished twice
    // for being caught mid-heal felt bad in every game that has tried it.
    const state = freshChannel();
    const medkit = consumable("consumable.medkit");
    const p = pool();

    beginUse(state, medkit, p, 1, 0, TICK_RATE);
    expect(interruptOnDamage(state, medkit)).toBe(true);
    expect(state.active).toBe(false);
    expect(p.health).toBe(40);
    expect(completeUse(state, medkit, p, 10 * TICK_RATE)).toBeUndefined();
  });

  it("does not interrupt an item authored to heal through damage", () => {
    const state = freshChannel();
    const medkit = consumable("consumable.medkit");
    const stubborn = { ...medkit, cancelOnDamage: false };
    const p = pool();

    beginUse(state, stubborn, p, 1, 0, TICK_RATE);
    expect(interruptOnDamage(state, stubborn)).toBe(false);
    expect(state.active).toBe(true);
  });

  it("will not start a second channel over the first", () => {
    const state = freshChannel();
    const medkit = consumable("consumable.medkit");
    const mini = consumable("consumable.miniShield");
    const p = pool();

    expect(beginUse(state, medkit, p, 1, 0, TICK_RATE)).toBe(true);
    expect(beginUse(state, mini, p, 3, 5, TICK_RATE)).toBe(false);
    expect(state.itemId).toBe(medkit.id);
  });

  it("reports progress across the channel", () => {
    const state = freshChannel();
    const medkit = consumable("consumable.medkit");
    const p = pool();

    expect(channelFraction(state, 0)).toBe(0);
    beginUse(state, medkit, p, 1, 0, TICK_RATE);
    expect(channelFraction(state, 5 * TICK_RATE)).toBeCloseTo(0.5, 3);
    expect(channelFraction(state, 99 * TICK_RATE)).toBe(1);
    cancelUse(state);
    expect(channelFraction(state, 5 * TICK_RATE)).toBe(0);
  });
});

describe("a bot's decisions", () => {
  const seeing = (distance: number) => ({
    targetAlive: true, distanceMetres: distance, hasLineOfSight: () => true,
  });
  const blocked = (distance: number) => ({
    targetAlive: true, distanceMetres: distance, hasLineOfSight: () => false,
  });

  it("ignores a target beyond its engage range", () => {
    const state = freshBotState();
    const blueprint = bot("bot.skirmisher");
    expect(decideBot(state, blueprint, seeing(blueprint.engageRangeMetres + 1), 0, TICK_RATE))
      .toBe("idle");
  });

  it("waits out its reaction time before the first shot", () => {
    const state = freshBotState();
    const blueprint = bot("bot.skirmisher");
    const reaction = Math.round(blueprint.reactionSeconds * TICK_RATE);

    expect(decideBot(state, blueprint, seeing(10), 0, TICK_RATE)).toBe("aiming");
    expect(decideBot(state, blueprint, seeing(10), reaction - 1, TICK_RATE)).toBe("aiming");
    expect(decideBot(state, blueprint, seeing(10), reaction, TICK_RATE)).toBe("fire");
  });

  it("pays the reaction again after losing sight", () => {
    // Peeking has to be worth something: stepping behind a wall and back out
    // cannot be free.
    const state = freshBotState();
    const blueprint = bot("bot.skirmisher");
    const reaction = Math.round(blueprint.reactionSeconds * TICK_RATE);

    decideBot(state, blueprint, seeing(10), 0, TICK_RATE);
    decideBot(state, blueprint, blocked(10), 1, TICK_RATE);
    expect(decideBot(state, blueprint, seeing(10), 2, TICK_RATE)).toBe("aiming");
    expect(decideBot(state, blueprint, seeing(10), 2 + reaction - 1, TICK_RATE)).toBe("aiming");
    expect(decideBot(state, blueprint, seeing(10), 2 + reaction, TICK_RATE)).toBe("fire");
  });

  it("keeps its own time between shots", () => {
    const state = freshBotState();
    const blueprint = bot("bot.skirmisher");
    const reaction = Math.round(blueprint.reactionSeconds * TICK_RATE);
    const gap = Math.round(blueprint.secondsBetweenShots * TICK_RATE);

    decideBot(state, blueprint, seeing(10), 0, TICK_RATE);
    expect(decideBot(state, blueprint, seeing(10), reaction, TICK_RATE)).toBe("fire");
    expect(decideBot(state, blueprint, seeing(10), reaction + gap - 1, TICK_RATE)).toBe("aiming");
    expect(decideBot(state, blueprint, seeing(10), reaction + gap, TICK_RATE)).toBe("fire");
  });

  it("never shoots through a wall", () => {
    // Building is the pillar. A bot that fires through cover makes it decorative.
    const state = freshBotState();
    const blueprint = bot("bot.skirmisher");
    provoke(state);
    expect(decideBot(state, blueprint, blocked(4), 50, TICK_RATE)).toBe("idle");
  });

  it("shoots back from outside its engage range once provoked", () => {
    const state = freshBotState();
    const blueprint = bot("bot.skirmisher");
    const far = seeing(blueprint.engageRangeMetres * 3);

    expect(decideBot(state, blueprint, far, 0, TICK_RATE)).toBe("idle");
    provoke(state);
    expect(decideBot(state, blueprint, far, 1, TICK_RATE)).toBe("aiming");
  });

  it("does not shoot back when its Blueprint says it does not", () => {
    // The target dummy and the skirmisher differ only in JSON.
    const state = freshBotState();
    const dummy = bot("bot.target");
    provoke(state);
    expect(decideBot(state, dummy, seeing(2), 100, TICK_RATE)).toBe("idle");
  });

  it("stops when it is dead, and when its target is", () => {
    const state = freshBotState();
    const blueprint = bot("bot.skirmisher");
    expect(decideBot(
      state, blueprint, { ...seeing(5), targetAlive: false }, 0, TICK_RATE,
    )).toBe("idle");
    expect(decideBot(state, blueprint, seeing(5), 0, TICK_RATE, false)).toBe("idle");
  });

  it("does not ask for line of sight when nobody is in range", () => {
    // The expensive question, asked last: a bot with nothing to shoot at must
    // not march a ray through the world thirty times a second for the privilege
    // of deciding it has nothing to shoot at.
    const state = freshBotState();
    let asked = 0;
    decideBot(
      state, bot("bot.skirmisher"),
      { targetAlive: true, distanceMetres: 400, hasLineOfSight: () => { asked++; return true; } },
      0, TICK_RATE,
    );
    expect(asked).toBe(0);
  });

  it("forgets it was provoked when it comes back", () => {
    const state = freshBotState();
    provoke(state);
    resetBotState(state);
    expect(state.provoked).toBe(false);
    expect(decideBot(state, bot("bot.skirmisher"), seeing(100), 0, TICK_RATE)).toBe("idle");
  });
});
