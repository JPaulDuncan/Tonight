/**
 * Heightfield terrain for the sandbox.
 *
 * A TypeScript port of the octave-noise field from `blender/lib/tonight/
 * terrain.py`, including the slope limiter. The constraints it satisfies are
 * the same ones GDD section 8 states: building must always be viable, so no
 * slope may exceed the buildable limit.
 */

import { Rng, } from "@/core/rng";
import { clamp, lerp } from "@/core/math";

export interface TerrainSpec {
  readonly name: string;
  readonly sizeMetres: number;
  /** Vertices per side. Resolution, not size. */
  readonly resolution: number;
  readonly amplitude: number;
  readonly featureSize: number;
  readonly seed: number;
  /** Lifts the interior above sea level; noise alone averages around zero. */
  readonly baseHeight: number;
}

/** The sandbox island. Small enough to cross quickly while iterating. */
export const SANDBOX_TERRAIN: TerrainSpec = {
  name: "Sandbox",
  sizeMetres: 200,
  resolution: 65,
  amplitude: 5,
  featureSize: 110,
  seed: 20260918,
  baseHeight: 6,
};

/** How quickly octave amplitude falls off. Lower is gentler terrain. */
const OCTAVE_DECAY = 0.4;
const SHORE_DROP = 3;
const SHORE_EDGE = 0.62;

export class Heightfield {
  private readonly heights: Float32Array;

  constructor(readonly spec: TerrainSpec, maxSlopeDegrees = 40) {
    this.heights = new Float32Array(spec.resolution * spec.resolution);
    this.generate();
    this.applyIslandFalloff();
    this.limitSlope(maxSlopeDegrees);
  }

  get cellSize(): number {
    return this.spec.sizeMetres / (this.spec.resolution - 1);
  }

  private index(row: number, column: number): number {
    return row * this.spec.resolution + column;
  }

  at(row: number, column: number): number {
    const r = clamp(row, 0, this.spec.resolution - 1);
    const c = clamp(column, 0, this.spec.resolution - 1);
    return this.heights[this.index(r, c)] ?? 0;
  }

  private generate(): void {
    const rng = new Rng(this.spec.seed);
    const octaves: { wavelength: number; amplitude: number; px: number; py: number; pd: number }[] = [];
    for (let o = 0; o < 4; o++) {
      octaves.push({
        wavelength: this.spec.featureSize / 2 ** o,
        amplitude: this.spec.amplitude * OCTAVE_DECAY ** o,
        px: rng.range(0, Math.PI * 2),
        py: rng.range(0, Math.PI * 2),
        pd: rng.range(0, Math.PI * 2),
      });
    }

    for (let row = 0; row < this.spec.resolution; row++) {
      const y = row * this.cellSize;
      for (let column = 0; column < this.spec.resolution; column++) {
        const x = column * this.cellSize;
        let height = 0;
        for (const o of octaves) {
          const k = (Math.PI * 2) / o.wavelength;
          height += o.amplitude * (
            0.5 * Math.cos(k * x + o.px) +
            0.5 * Math.cos(k * y + o.py) +
            0.35 * Math.cos(k * (x + y) * 0.7071 + o.pd)
          );
        }
        this.heights[this.index(row, column)] = height;
      }
    }
  }

  /** Pull the edges down so the map reads as an island, not a cliff to fall off. */
  private applyIslandFalloff(): void {
    const half = this.spec.sizeMetres / 2;
    for (let row = 0; row < this.spec.resolution; row++) {
      const y = row * this.cellSize - half;
      for (let column = 0; column < this.spec.resolution; column++) {
        const x = column * this.cellSize - half;
        const distance = Math.max(Math.abs(x), Math.abs(y)) / half;
        const falloff = 1 - smoothstep(SHORE_EDGE, 1, distance);
        const lifted = (this.heights[this.index(row, column)] ?? 0) + this.spec.baseHeight;
        this.heights[this.index(row, column)] = lifted * falloff - (1 - falloff) * SHORE_DROP;
      }
    }
  }

  /**
   * Relax the field until no cell exceeds the buildable slope.
   *
   * Cells relax in place, so a later fix in the same pass can re-break an
   * earlier pair; convergence comes from repeating. Twelve passes was not
   * enough in the Python version and left the field over its own limit.
   */
  private limitSlope(maxDegrees: number, iterations = 40): void {
    const maxDrop = Math.tan((maxDegrees * Math.PI) / 180) * this.cellSize;

    for (let pass = 0; pass < iterations; pass++) {
      let worst = 0;
      for (let row = 0; row < this.spec.resolution; row++) {
        for (let column = 0; column < this.spec.resolution; column++) {
          for (const [dr, dc] of [[0, 1], [1, 0]] as const) {
            const r2 = row + dr;
            const c2 = column + dc;
            if (r2 >= this.spec.resolution || c2 >= this.spec.resolution) continue;

            const a = this.index(row, column);
            const b = this.index(r2, c2);
            const difference = (this.heights[a] ?? 0) - (this.heights[b] ?? 0);
            const excess = Math.abs(difference) - maxDrop;
            if (excess <= 0) continue;

            worst = Math.max(worst, excess);
            const shift = excess * 0.5;
            if (difference > 0) {
              this.heights[a] = (this.heights[a] ?? 0) - shift;
              this.heights[b] = (this.heights[b] ?? 0) + shift;
            } else {
              this.heights[a] = (this.heights[a] ?? 0) + shift;
              this.heights[b] = (this.heights[b] ?? 0) - shift;
            }
          }
        }
      }
      if (worst <= 1e-4) break;
    }
  }

  /** Bilinearly sample the field at a world position. */
  sample(x: number, z: number): number {
    const half = this.spec.sizeMetres / 2;
    const fx = (x + half) / this.cellSize;
    const fz = (z + half) / this.cellSize;

    const column = clamp(Math.floor(fx), 0, this.spec.resolution - 2);
    const row = clamp(Math.floor(fz), 0, this.spec.resolution - 2);
    const tx = clamp(fx - column, 0, 1);
    const tz = clamp(fz - row, 0, 1);

    return lerp(
      lerp(this.at(row, column), this.at(row, column + 1), tx),
      lerp(this.at(row + 1, column), this.at(row + 1, column + 1), tx),
      tz,
    );
  }

  /** Steepest slope anywhere in the field, in degrees. */
  maxSlopeDegrees(): number {
    let steepest = 0;
    for (let row = 0; row < this.spec.resolution; row++) {
      for (let column = 0; column < this.spec.resolution; column++) {
        for (const [dr, dc] of [[0, 1], [1, 0]] as const) {
          const r2 = row + dr;
          const c2 = column + dc;
          if (r2 >= this.spec.resolution || c2 >= this.spec.resolution) continue;
          const drop = Math.abs(this.at(row, column) - this.at(r2, c2));
          steepest = Math.max(steepest, (Math.atan2(drop, this.cellSize) * 180) / Math.PI);
        }
      }
    }
    return steepest;
  }

  /** Fraction gentle enough to count as open build-fight space. */
  openTerrainFraction(flatThresholdDegrees = 12): number {
    let gentle = 0;
    let total = 0;
    for (let row = 0; row < this.spec.resolution - 1; row++) {
      for (let column = 0; column < this.spec.resolution - 1; column++) {
        const drop = Math.max(
          Math.abs(this.at(row, column) - this.at(row, column + 1)),
          Math.abs(this.at(row, column) - this.at(row + 1, column)),
        );
        total++;
        if ((Math.atan2(drop, this.cellSize) * 180) / Math.PI <= flatThresholdDegrees) gentle++;
      }
    }
    return total === 0 ? 0 : gentle / total;
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export interface ScatterPoint {
  readonly kind: "tree" | "rock";
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly yaw: number;
  readonly scale: number;
  readonly objectId: number;
}

/**
 * Place harvestable props.
 *
 * Dart-throwing with a spacing constraint rather than pure random placement,
 * because clumps look like a bug and leave the rest of the map bare.
 */
export function scatterProps(
  field: Heightfield,
  counts: { tree: number; rock: number },
  minSpacing = 6,
): ScatterPoint[] {
  const rng = new Rng(field.spec.seed ^ 0x5ca77e5);
  const half = field.spec.sizeMetres / 2;
  const placed: ScatterPoint[] = [];
  const spacingSq = minSpacing * minSpacing;
  let objectId = 1;

  for (const [kind, count] of Object.entries(counts) as ["tree" | "rock", number][]) {
    let made = 0;
    let attempts = 0;
    while (made < count && attempts < count * 60) {
      attempts++;
      const x = rng.range(-half * 0.88, half * 0.88);
      const z = rng.range(-half * 0.88, half * 0.88);
      const y = field.sample(x, z);
      if (y < 0.5) continue;
      if (placed.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < spacingSq)) continue;

      placed.push({
        kind, x, z, y,
        yaw: rng.range(0, Math.PI * 2),
        scale: rng.range(0.85, 1.25),
        objectId: objectId++,
      });
      made++;
    }
  }

  return placed;
}
