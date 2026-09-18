/**
 * Using a consumable: the channel, and what it restores.
 *
 * `inventory.md` section 3 is the spec, and two of its rules are the whole
 * reason this is a state machine rather than a function call:
 *
 * - The item is consumed **on completion, not on start**. An interrupted heal
 *   costs time and nothing else. Being punished twice for being caught
 *   mid-heal felt bad in every game that has tried it.
 * - Taking damage interrupts, when the Blueprint says `cancelOnDamage`.
 *
 * Pure, tick-driven, and it knows nothing about which item exists -- a new
 * consumable is a Blueprint entry, never a branch here.
 */

import type { ConsumableBlueprint } from "@/blueprints/types";
import { addShield, heal, type HealthPool } from "./combat";

export interface ChannelState {
  /** The item being used. Empty while idle. */
  itemId: string;
  active: boolean;
  startedTick: number;
  endsTick: number;
}

export function freshChannel(): ChannelState {
  return { itemId: "", active: false, startedTick: 0, endsTick: 0 };
}

/**
 * Would this item actually do anything right now?
 *
 * A bandage at 100 health is not a heal, it is a three-second animation ending
 * in one fewer bandage. Refusing the use is kinder than performing it.
 */
export function wouldRestore(item: ConsumableBlueprint, pool: HealthPool): boolean {
  if (item.healthRestored > 0 && pool.health < Math.min(item.healthCap, pool.maxHealth)) {
    return true;
  }
  return item.shieldRestored > 0 && pool.shield < pool.maxShield;
}

export function canBeginUse(
  state: ChannelState, item: ConsumableBlueprint, pool: HealthPool, available: number,
): boolean {
  if (state.active) return false;
  if (available <= 0) return false;
  return wouldRestore(item, pool);
}

/** Start channelling. Returns false when there was nothing to start. */
export function beginUse(
  state: ChannelState,
  item: ConsumableBlueprint,
  pool: HealthPool,
  available: number,
  tick: number,
  tickRate: number,
): boolean {
  if (!canBeginUse(state, item, pool, available)) return false;

  state.itemId = item.id;
  state.active = true;
  state.startedTick = tick;
  // Rounded up, so the authored use time is a floor rather than a suggestion.
  state.endsTick = tick + Math.max(1, Math.ceil(item.useSeconds * tickRate));
  return true;
}

/** Abandon a channel. The item is untouched: it is spent on completion. */
export function cancelUse(state: ChannelState): void {
  state.active = false;
  state.itemId = "";
}

/**
 * Damage arrived mid-channel.
 *
 * Returns true when it interrupted, so the caller can say so. An item whose
 * Blueprint clears `cancelOnDamage` heals through a fight, which is a
 * legitimate thing to author even though nothing in the shipped set does it.
 */
export function interruptOnDamage(state: ChannelState, item: ConsumableBlueprint): boolean {
  if (!state.active || !item.cancelOnDamage) return false;
  cancelUse(state);
  return true;
}

export interface UseResult {
  readonly healed: number;
  readonly shielded: number;
  /** Whether the item should now leave the inventory. */
  readonly consumed: boolean;
}

/**
 * Finish the channel if its time is up, applying what the item restores.
 *
 * Returns undefined while it is still running, so a caller can poll this every
 * tick without asking twice whether the channel is over.
 */
export function completeUse(
  state: ChannelState, item: ConsumableBlueprint, pool: HealthPool, tick: number,
): UseResult | undefined {
  if (!state.active || state.itemId !== item.id) return undefined;
  if (tick < state.endsTick) return undefined;

  const healed = heal(pool, item.healthRestored, item.healthCap);
  const shielded = addShield(pool, item.shieldRestored);
  cancelUse(state);
  return { healed, shielded, consumed: item.consumedOnUse };
}

/** How far through the channel is, 0..1. Zero when idle. */
export function channelFraction(state: ChannelState, tick: number): number {
  if (!state.active) return 0;
  const span = state.endsTick - state.startedTick;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (tick - state.startedTick) / span));
}
