/**
 * The storm: the match clock, the pacing mechanism, and the night arc.
 */

import type { StormPhaseBlueprint } from "@/blueprints/types";
import { Rng } from "@/core/rng";
import { clamp01, distance2, lerp, lerp2, vec2, type Vec2 } from "@/core/math";

export interface StormState {
  readonly phaseIndex: number;
  readonly centre: Vec2;
  readonly radius: number;
  readonly nextCentre: Vec2;
  readonly nextRadius: number;
  readonly isClosing: boolean;
  readonly secondsRemainingInStage: number;
}

export function stormContains(state: StormState, position: Vec2): boolean {
  return distance2(position, state.centre) <= state.radius;
}

/** Radius at a time offset into a phase: flat through the wait, then linear. */
export function radiusAt(phase: StormPhaseBlueprint, secondsIntoPhase: number): number {
  if (secondsIntoPhase <= phase.waitSeconds) return phase.startRadius;
  const closeElapsed = secondsIntoPhase - phase.waitSeconds;
  if (closeElapsed >= phase.closeSeconds) return phase.endRadius;
  return lerp(phase.startRadius, phase.endRadius, closeElapsed / phase.closeSeconds);
}

/** The effective rotation clamp, resolving the -1 sentinel. */
export function resolveMaxRotation(phase: StormPhaseBlueprint, sprintSpeed: number): number {
  if (phase.maxRotationDistance >= 0) return phase.maxRotationDistance;
  return sprintSpeed * phase.closeSeconds * 1.1;
}

export function phaseTotalSeconds(phase: StormPhaseBlueprint): number {
  return phase.waitSeconds + phase.closeSeconds;
}

function centroid(points: readonly Vec2[]): Vec2 {
  if (points.length === 0) return vec2();
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return vec2(x / points.length, y / points.length);
}

function clampInsideCircle(point: Vec2, centre: Vec2, maxRadius: number): Vec2 {
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  const length = Math.hypot(dx, dy);
  if (length <= maxRadius || length < 1e-9) return point;
  return vec2(centre.x + (dx / length) * maxRadius, centre.y + (dy / length) * maxRadius);
}

/**
 * Choose the next circle centre: biased toward survivors, then clamped so
 * nobody is stranded.
 *
 * The clamp is the part that matters. Without it a player looted into a corner
 * can die to a rotation they could not physically make, which reads as the game
 * cheating rather than as a mistake.
 */
export function chooseNextCentre(
  phase: StormPhaseBlueprint,
  currentCentre: Vec2,
  currentRadius: number,
  nextRadius: number,
  livingPlayers: readonly Vec2[],
  sprintSpeed: number,
  rng: Rng,
): { centre: Vec2; clampImpossible: boolean } {
  // sqrt on the radius keeps the distribution uniform by area rather than
  // clustering candidates toward the centre.
  const angle = rng.nextFloat() * Math.PI * 2;
  const maxOffset = Math.max(0, currentRadius - nextRadius);
  const distance = Math.sqrt(rng.nextFloat()) * maxOffset;

  let candidate = vec2(
    currentCentre.x + Math.cos(angle) * distance,
    currentCentre.y + Math.sin(angle) * distance,
  );

  if (livingPlayers.length === 0) return { centre: candidate, clampImpossible: false };

  candidate = lerp2(candidate, centroid(livingPlayers), phase.centreBiasToPlayers);
  candidate = clampInsideCircle(candidate, currentCentre, maxOffset);

  const maxDistance = resolveMaxRotation(phase, sprintSpeed);

  // A handful of relaxation passes converges well and is bounded, which matters
  // because this runs on the server between phases.
  for (let pass = 0; pass < 8; pass++) {
    let worstIndex = -1;
    let worstExcess = 0;

    for (let i = 0; i < livingPlayers.length; i++) {
      const toEdge = distance2(livingPlayers[i]!, candidate) - nextRadius;
      const excess = toEdge - maxDistance;
      if (excess > worstExcess) {
        worstExcess = excess;
        worstIndex = i;
      }
    }

    if (worstIndex < 0) return { centre: candidate, clampImpossible: false };

    const player = livingPlayers[worstIndex]!;
    const dx = player.x - candidate.x;
    const dy = player.y - candidate.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) return { centre: candidate, clampImpossible: false };

    const pulled = vec2(candidate.x + (dx / length) * worstExcess, candidate.y + (dy / length) * worstExcess);
    const clamped = clampInsideCircle(pulled, currentCentre, maxOffset);

    // If clamping back inside the previous circle undid the pull, no centre can
    // satisfy this player. That is a map-design problem, so it is reported.
    if (distance2(clamped, candidate) < 1e-4) return { centre: clamped, clampImpossible: true };
    candidate = clamped;
  }

  return { centre: candidate, clampImpossible: true };
}

/** Runs the storm across a match. */
export class StormDirector {
  private rng: Rng;
  private phaseIndexValue = 0;
  private phaseElapsed = 0;
  private centre: Vec2;
  private nextCentreValue: Vec2;
  private finishedValue = false;

  readonly onClampImpossible: ((phaseIndex: number) => void)[] = [];

  constructor(
    private readonly phases: readonly StormPhaseBlueprint[],
    matchSeed: number,
    private readonly sprintSpeed: number,
    mapCentre: Vec2 = vec2(),
  ) {
    this.rng = new Rng(matchSeed);
    this.centre = mapCentre;
    this.nextCentreValue = mapCentre;
    this.chooseNext([]);
  }

  get phaseIndex(): number {
    return this.phaseIndexValue;
  }

  get finished(): boolean {
    return this.finishedValue;
  }

  get currentPhase(): StormPhaseBlueprint | undefined {
    return this.phases[this.phaseIndexValue];
  }

  get totalSeconds(): number {
    return this.phases.reduce((sum, p) => sum + phaseTotalSeconds(p), 0);
  }

  /**
   * How far through the current phase, 0..1.
   *
   * The night clock's hand: lighting keyframes are per phase, so this is what
   * says where between two of them the sky currently is. Distinct from
   * {@link progress}, which is the whole match and moves at a different rate
   * because phases differ in length.
   */
  get phaseFraction(): number {
    const phase = this.currentPhase;
    if (!phase) return 1;
    const total = phaseTotalSeconds(phase);
    return total <= 0 ? 1 : clamp01(this.phaseElapsed / total);
  }

  /** Normalised match progress, which drives the night-clock lighting. */
  get progress(): number {
    if (this.phases.length === 0) return 0;
    let elapsed = this.phaseElapsed;
    for (let i = 0; i < this.phaseIndexValue && i < this.phases.length; i++) {
      elapsed += phaseTotalSeconds(this.phases[i]!);
    }
    const total = this.totalSeconds;
    return total <= 0 ? 0 : clamp01(elapsed / total);
  }

  get current(): StormState {
    const phase = this.currentPhase;
    if (!phase) {
      return {
        phaseIndex: this.phaseIndexValue, centre: this.centre, radius: 0,
        nextCentre: this.centre, nextRadius: 0, isClosing: false, secondsRemainingInStage: 0,
      };
    }

    const isClosing = this.phaseElapsed > phase.waitSeconds;
    // The circle drifts toward its new centre while closing, so the boundary
    // sweeps rather than shrinking in place.
    const centre = isClosing
      ? lerp2(this.centre, this.nextCentreValue,
          clamp01((this.phaseElapsed - phase.waitSeconds) / phase.closeSeconds))
      : this.centre;

    const remaining = isClosing
      ? phase.waitSeconds + phase.closeSeconds - this.phaseElapsed
      : phase.waitSeconds - this.phaseElapsed;

    return {
      phaseIndex: this.phaseIndexValue,
      centre,
      radius: radiusAt(phase, this.phaseElapsed),
      nextCentre: this.nextCentreValue,
      nextRadius: phase.endRadius,
      isClosing,
      secondsRemainingInStage: Math.max(0, remaining),
    };
  }

  advance(deltaTime: number, livingPlayers: readonly Vec2[]): void {
    const phase = this.currentPhase;
    if (this.finishedValue || !phase) return;

    this.phaseElapsed += deltaTime;
    if (this.phaseElapsed < phaseTotalSeconds(phase)) return;

    // The phase completed: the circle is now where it was closing to.
    this.centre = this.nextCentreValue;
    this.phaseIndexValue++;
    this.phaseElapsed = 0;

    if (this.phaseIndexValue >= this.phases.length) {
      this.finishedValue = true;
      return;
    }

    this.chooseNext(livingPlayers);
  }

  private chooseNext(livingPlayers: readonly Vec2[]): void {
    const phase = this.currentPhase;
    if (!phase) return;

    const { centre, clampImpossible } = chooseNextCentre(
      phase, this.centre, phase.startRadius, phase.endRadius,
      livingPlayers, this.sprintSpeed, this.rng,
    );
    this.nextCentreValue = centre;
    if (clampImpossible) {
      for (const listener of this.onClampImpossible) listener(this.phaseIndexValue);
    }
  }

  /** Storm damage for one interval. Applied directly to health. */
  damageFor(position: Vec2, deltaTime: number): number {
    const phase = this.currentPhase;
    if (!phase) {
      const last = this.phases[this.phases.length - 1];
      return this.finishedValue && last ? last.damagePerSecond * deltaTime : 0;
    }
    return stormContains(this.current, position) ? 0 : phase.damagePerSecond * Math.max(0, deltaTime);
  }
}
