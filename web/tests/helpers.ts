/**
 * Test helpers.
 *
 * Blueprints are `readonly` throughout, which is the point: they are shared,
 * load-once data and nothing may mutate them at runtime. Tests that need a
 * deliberately broken library therefore clone first and edit the clone, and
 * `mutable` is the single sanctioned place that cast happens.
 */

/** Strip `readonly` for a deep-cloned fixture the test owns. */
export type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Mutable<U>[] : T[K];
};

export function mutable<T>(value: T): Mutable<T> {
  return value as Mutable<T>;
}

/** A deep clone that tests may safely break. */
export function brokenClone<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}
