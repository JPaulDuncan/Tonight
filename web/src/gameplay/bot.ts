/**
 * What a bot decides to do this tick.
 *
 * Deliberately thin. The bot does not own a fire rate, a magazine or a
 * cooldown -- `tryFire` already does, and a bot that skipped it would be a
 * second firing state machine drifting away from the first. This decides one
 * thing: whether the trigger is down right now.
 *
 * Every threshold comes from a {@link BotBlueprint}. There is no "hard bot"
 * code path, only a Blueprint with a shorter reaction and a tighter cone.
 */

import type { BotBlueprint } from "@/blueprints/types";

export interface BotState {
  /**
   * Tick it first saw its target, or -1 when it sees nothing.
   *
   * Reset on losing sight, so stepping behind a wall and back out costs the
   * reaction time again -- peeking has to be worth something.
   */
  acquiredTick: number;
  /** Earliest tick it may pull the trigger again. */
  nextShotTick: number;
  /** Somebody hit it. A retaliating bot fights back regardless of range. */
  provoked: boolean;
}

export function freshBotState(): BotState {
  return { acquiredTick: -1, nextShotTick: 0, provoked: false };
}

/** What the bot can tell about its target, computed by whoever owns the world. */
export interface BotSenses {
  readonly targetAlive: boolean;
  readonly distanceMetres: number;
  /**
   * Nothing solid between the two. A wall the player built breaks this.
   *
   * A function, not a value, because it is by far the most expensive question
   * asked here -- it marches a ray through the structure grid -- and most ticks
   * do not need the answer. Five bots each tracing 30 m of empty air thirty
   * times a second cost more frame time than everything else in the sandbox put
   * together. It is called at most once per decision.
   */
  readonly hasLineOfSight: () => boolean;
}

export type BotAction =
  /** Nothing to shoot at. */
  | "idle"
  /** Target seen, trigger not pulled yet: reacting, or between shots. */
  | "aiming"
  /** Pull the trigger this tick. */
  | "fire";

/**
 * Should this bot be shooting?
 *
 * Mutates `state`: acquisition and the shot clock live there, because both are
 * per-bot and neither belongs to the Blueprint, which is shared.
 */
export function decideBot(
  state: BotState,
  blueprint: BotBlueprint,
  senses: BotSenses,
  tick: number,
  tickRate: number,
  selfAlive = true,
): BotAction {
  const wants = selfAlive && senses.targetAlive
    && (
      (blueprint.engageRangeMetres > 0 && senses.distanceMetres <= blueprint.engageRangeMetres)
      || (blueprint.retaliates && state.provoked)
    );

  // Sight is required even when provoked: a bot shooting through the wall it
  // was shot through would make building pointless, and building is the pillar.
  // Asked last, because it is the expensive one.
  const engaged = wants && senses.hasLineOfSight();

  if (!engaged) {
    state.acquiredTick = -1;
    return "idle";
  }

  if (state.acquiredTick < 0) {
    state.acquiredTick = tick;
    return "aiming";
  }

  const reactionTicks = Math.max(0, Math.round(blueprint.reactionSeconds * tickRate));
  if (tick - state.acquiredTick < reactionTicks) return "aiming";
  if (tick < state.nextShotTick) return "aiming";

  // Trigger discipline is the bot's, the cooldown is the weapon's. Both apply:
  // whichever is slower wins, which is why a bot cannot out-shoot its gun.
  state.nextShotTick = tick + Math.max(1, Math.round(blueprint.secondsBetweenShots * tickRate));
  return "fire";
}

/** Somebody shot it. Sticks until it respawns. */
export function provoke(state: BotState): void {
  state.provoked = true;
}

export function resetBotState(state: BotState): void {
  state.acquiredTick = -1;
  state.nextShotTick = 0;
  state.provoked = false;
}
