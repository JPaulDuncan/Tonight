/**
 * Anything that can be shot: the player, and every bot.
 *
 * One type for both, because the moment the player is a special case the
 * damage path forks and the two halves drift. `combat.ts` already owns the
 * arithmetic -- the formula, the shield split, the pools. This owns what
 * happens around it: who is alive, who eliminated whom, and when the
 * eliminated stand back up.
 *
 * Pure: no three.js, no DOM, no clock. Time is ticks, handed in by the caller.
 */

import type { CharacterBlueprint } from "@/blueprints/types";
import {
  applyDamageToPool, fullHealth, isAlive, type DamageResult, type HealthPool,
} from "./combat";

export interface Combatant {
  readonly id: number;
  readonly displayName: string;
  readonly characterId: string;
  readonly pool: HealthPool;
  alive: boolean;
  /** Tick it may stand back up on. Meaningless while alive. */
  respawnAtTick: number;
  /** Who hit it last, for the feed. -1 when nothing has. */
  lastAttackerId: number;
  /** Tick of the last hit taken, which is what interrupts a heal. */
  lastDamagedTick: number;
  /** How many others it has put down. */
  eliminations: number;
  /** Shield it comes back with, from its Blueprint. */
  readonly spawnShield: number;
}

export function makeCombatant(
  id: number, displayName: string, character: CharacterBlueprint, spawnShield = 0,
): Combatant {
  const pool = fullHealth(character.maxHealth, character.maxShield);
  pool.shield = Math.min(character.maxShield, Math.max(0, spawnShield));
  return {
    id,
    displayName,
    characterId: character.id,
    pool,
    alive: true,
    respawnAtTick: 0,
    lastAttackerId: -1,
    lastDamagedTick: Number.MIN_SAFE_INTEGER / 2,
    eliminations: 0,
    spawnShield: pool.shield,
  };
}

export interface DamageOutcome {
  readonly toShield: number;
  readonly toHealth: number;
  /** This hit took the last of its health. True exactly once per life. */
  readonly eliminated: boolean;
}

const NOTHING: DamageOutcome = { toShield: 0, toHealth: 0, eliminated: false };

/**
 * Apply an already-computed split to a combatant.
 *
 * The split comes from `applyHit`, which knows the weapon and the hitbox. This
 * knows neither, which is what keeps one damage formula rather than two.
 *
 * `eliminated` is returned rather than inferred from `alive` afterwards: two
 * pellets of one shotgun shell both land on a combatant with 5 health left, and
 * only the first of them eliminated anybody.
 */
export function damageCombatant(
  target: Combatant,
  result: DamageResult,
  attackerId: number,
  tick: number,
  respawnDelayTicks: number,
): DamageOutcome {
  if (!target.alive) return NOTHING;
  if (result.toShield <= 0 && result.toHealth <= 0) return NOTHING;

  const eliminated = applyDamageToPool(target.pool, result);
  target.lastAttackerId = attackerId;
  target.lastDamagedTick = tick;

  if (eliminated) {
    target.alive = false;
    target.respawnAtTick = tick + Math.max(1, Math.round(respawnDelayTicks));
  }

  return { toShield: result.toShield, toHealth: result.toHealth, eliminated };
}

/** Direct health damage -- a fall, or the storm. Both ignore shield by design. */
export function damageHealthDirectly(
  target: Combatant, amount: number, tick: number, respawnDelayTicks: number,
): DamageOutcome {
  if (!target.alive || amount <= 0) return NOTHING;
  const dealt = Math.min(amount, target.pool.health);
  return damageCombatant(
    target, { toShield: 0, toHealth: dealt }, -1, tick, respawnDelayTicks,
  );
}

export function readyToRespawn(target: Combatant, tick: number): boolean {
  return !target.alive && tick >= target.respawnAtTick;
}

/** Stand a combatant back up at full health and its Blueprint's shield. */
export function respawnCombatant(target: Combatant): void {
  target.pool.health = target.pool.maxHealth;
  target.pool.shield = target.spawnShield;
  target.alive = true;
  target.lastAttackerId = -1;
  target.respawnAtTick = 0;
}

/** Total effective health, which is what a player reads the two bars as. */
export function effectiveHealth(target: Combatant): number {
  return target.pool.health + target.pool.shield;
}

export { isAlive };

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

/** How many eliminations the feed remembers. Older ones scroll off. */
export const FEED_CAPACITY = 5;

export interface FeedEntry {
  used: boolean;
  attackerName: string;
  victimName: string;
  weaponName: string;
  headshot: boolean;
  /** Tick it was recorded, which decides when it fades. */
  tick: number;
}

/**
 * The kill feed.
 *
 * A ring of pre-allocated entries, oldest overwritten first, so a busy endgame
 * does not allocate. Combat feedback is the one place in this project where
 * that rule is written down (combat.md section 5), and a feed is feedback.
 */
export class EliminationFeed {
  readonly entries: FeedEntry[] = [];
  private cursor = 0;

  constructor(capacity = FEED_CAPACITY) {
    for (let i = 0; i < capacity; i++) {
      this.entries.push({
        used: false, attackerName: "", victimName: "", weaponName: "",
        headshot: false, tick: 0,
      });
    }
  }

  record(
    attackerName: string, victimName: string, weaponName: string,
    headshot: boolean, tick: number,
  ): void {
    const entry = this.entries[this.cursor]!;
    entry.used = true;
    entry.attackerName = attackerName;
    entry.victimName = victimName;
    entry.weaponName = weaponName;
    entry.headshot = headshot;
    entry.tick = tick;
    this.cursor = (this.cursor + 1) % this.entries.length;
  }

  /** Entries younger than `lifetimeTicks`, newest first. */
  *visible(tick: number, lifetimeTicks: number): Generator<FeedEntry> {
    for (let i = 0; i < this.entries.length; i++) {
      // Walk backward from the cursor: the most recently written comes first.
      const index = (this.cursor - 1 - i + this.entries.length * 2) % this.entries.length;
      const entry = this.entries[index]!;
      if (!entry.used) continue;
      if (tick - entry.tick > lifetimeTicks) continue;
      yield entry;
    }
  }

  clear(): void {
    for (const entry of this.entries) entry.used = false;
    this.cursor = 0;
  }
}
