/**
 * A small, fast, fully deterministic RNG (xorshift128).
 *
 * Gameplay never uses `Math.random()`: it carries global state the client and
 * server do not share, and it cannot be replayed during reconciliation.
 *
 * Every random draw both sides must agree on -- shotgun pellet directions,
 * harvest weak-point positions, loot rolls -- is seeded from values both sides
 * already know, so no extra replication is needed.
 */
export class Rng {
  private x: number;
  private y: number;
  private z: number;
  private w: number;

  constructor(seed: number) {
    // Seeds must never all be zero, or xorshift degenerates to zero forever.
    const s = seed >>> 0;
    this.x = s === 0 ? 0x9e3779b9 : s;
    this.y = (Math.imul(this.x, 1812433253) + 1) >>> 0;
    this.z = (Math.imul(this.y, 1812433253) + 1) >>> 0;
    this.w = (Math.imul(this.z, 1812433253) + 1) >>> 0;
  }

  /**
   * Derive a stream from a base seed plus one or two discriminators.
   * Used for "seed this shot" or "seed this object's Nth hit".
   */
  static forStream(seed: number, streamA: number, streamB = 0): Rng {
    let mixed = seed | 0;
    mixed = (Math.imul(mixed, 31) + Math.imul(streamA, 73856093)) | 0;
    mixed = (Math.imul(mixed, 31) + Math.imul(streamB, 19349663)) | 0;
    return new Rng(mixed);
  }

  nextUint(): number {
    const t = (this.x ^ (this.x << 11)) >>> 0;
    this.x = this.y;
    this.y = this.z;
    this.z = this.w;
    this.w = (this.w ^ (this.w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return this.w;
  }

  /** Uniform float in [0, 1). */
  nextFloat(): number {
    return (this.nextUint() >>> 8) * (1 / 16777216);
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.nextFloat() * (max - min);
  }

  /** Uniform integer in [minInclusive, maxExclusive). */
  rangeInt(minInclusive: number, maxExclusive: number): number {
    if (maxExclusive <= minInclusive) return minInclusive;
    const span = maxExclusive - minInclusive;
    return minInclusive + (this.nextUint() % span);
  }

  /** Uniform integer in [min, max], inclusive at both ends. */
  rangeInclusive(min: number, max: number): number {
    return this.rangeInt(min, max + 1);
  }

  /**
   * Index into `weights` chosen proportionally.
   *
   * Returns -1 when the weights sum to zero, which callers must treat as a
   * validation failure rather than silently picking entry 0.
   */
  weightedPick(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) if (w > 0) total += w;
    if (total <= 0) return -1;

    let roll = this.nextFloat() * total;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i] ?? 0;
      if (w <= 0) continue;
      roll -= w;
      if (roll <= 0) return i;
    }

    // Floating-point drift can leave a residual; the last positive entry is the
    // correct fallback.
    for (let i = weights.length - 1; i >= 0; i--) {
      if ((weights[i] ?? 0) > 0) return i;
    }
    return -1;
  }
}

/** An inclusive integer range. */
export interface IntRange {
  readonly min: number;
  readonly max: number;
}

export function intRange(min: number, max: number): IntRange {
  return { min, max };
}

export function isValidRange(r: IntRange): boolean {
  return r.max >= r.min;
}
