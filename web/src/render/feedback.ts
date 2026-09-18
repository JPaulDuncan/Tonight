/**
 * Hit markers and damage numbers.
 *
 * `docs/systems/combat.md` section 5 is explicit that feedback here is
 * information rather than decoration, and it specifies the signals: a sharp
 * white X for a player hit and a cyan chevron for a structure, damage numbers
 * white (yellow on a headshot) for players and cyan for structures. It also
 * requires the numbers to be **pooled** -- no allocation per hit, per the
 * zero-steady-state-allocation rule -- which is what shapes this module.
 *
 * The policy is pure and lives here so it can be tested in Node: how hits are
 * aggregated, how long a number lives, how far it rises and how it fades. The
 * DOM is touched only by {@link FeedbackLayer}, which nothing constructs outside
 * a browser.
 */

import type { Vec3 } from "@/core/math";

export type HitKind = "player" | "structure" | "harvestable";

/** Seconds a damage number stays on screen. */
export const NUMBER_LIFETIME = 0.9;

/** Metres it drifts upward over that time. */
export const NUMBER_RISE_METRES = 0.55;

/**
 * Seconds the hit marker is visible.
 *
 * Short, because it is a confirmation rather than a state -- but long enough to
 * survive a frame. At 0.12 s it could be raised and cleared between two frames
 * of a slow renderer, so a hit would confirm itself to nobody. The same trap
 * the tracer lifetime fell into.
 */
export const MARKER_LIFETIME = 0.18;

/**
 * How many numbers can be on screen at once.
 *
 * The pool is allocated up front and reused, so a sustained spray neither
 * allocates nor grows. Twenty-four is more than a magazine of shotgun blasts
 * can have alive at this lifetime.
 */
export const NUMBER_POOL_SIZE = 24;

/** Distinct targets one shot can hit before the rest are merged into the last. */
export const MAX_SHOT_BUCKETS = 8;

/** Fraction of its life a number has lived, clamped to 0..1. */
export function lifeFraction(age: number, lifetime = NUMBER_LIFETIME): number {
  if (lifetime <= 0) return 1;
  return Math.min(1, Math.max(0, age / lifetime));
}

/**
 * Opacity over a number's life.
 *
 * Fully opaque for the first third, then a linear fade. A number that starts
 * fading immediately is hard to read at exactly the moment it matters.
 */
export function numberOpacity(fraction: number): number {
  if (fraction <= 1 / 3) return 1;
  return Math.max(0, 1 - (fraction - 1 / 3) / (2 / 3));
}

/** How far a number has risen, in metres. */
export function numberRise(fraction: number): number {
  // Eased out, so it moves most at the start and settles as it fades.
  return NUMBER_RISE_METRES * (1 - (1 - fraction) * (1 - fraction));
}

/** The CSS class for a damage number, from the spec's table. */
export function numberClass(kind: HitKind, headshot: boolean): string {
  if (kind === "player") return headshot ? "dmg-headshot" : "dmg-player";
  if (kind === "structure") return "dmg-structure";
  return "dmg-harvestable";
}

/** The CSS class for a hit marker: a sharp X for players, a chevron otherwise. */
export function markerClass(kind: HitKind, destroyed: boolean): string {
  const base = kind === "player" ? "marker-x" : "marker-chevron";
  return destroyed ? `${base} marker-destroyed` : base;
}

/** Damage rounded the way it is shown. Sub-1 hits still read as 1, not as 0. */
export function displayDamage(amount: number): number {
  if (amount <= 0) return 0;
  return Math.max(1, Math.round(amount));
}

/** One aggregated target within a single shot. */
export interface ShotBucket {
  used: boolean;
  targetId: string;
  kind: HitKind;
  headshot: boolean;
  /** The hit that finished the target off. */
  destroyed: boolean;
  amount: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Sums a shot's pellets per target.
 *
 * A shotgun puts ten pellets into one wall; ten numbers stacked on one point is
 * noise, and the player wants to know what the *shell* did. Fortnite sums a
 * blast and so does this.
 *
 * The buckets are allocated once and reused, so aggregating costs nothing per
 * pellet.
 */
export class ShotAccumulator {
  readonly buckets: ShotBucket[] = [];

  constructor(size = MAX_SHOT_BUCKETS) {
    for (let i = 0; i < size; i++) {
      this.buckets.push({
        used: false, targetId: "", kind: "structure", headshot: false,
        destroyed: false, amount: 0, x: 0, y: 0, z: 0,
      });
    }
  }

  /** Add one pellet's damage against one target. */
  add(
    targetId: string, kind: HitKind, amount: number, at: Vec3,
    headshot = false, destroyed = false,
  ): void {
    if (amount <= 0) return;

    let free: ShotBucket | undefined;
    for (const bucket of this.buckets) {
      if (bucket.used && bucket.targetId === targetId) {
        bucket.amount += amount;
        // The number sits where the last pellet landed, which reads as the
        // centre of the spread closely enough and costs no averaging.
        bucket.x = at.x;
        bucket.y = at.y;
        bucket.z = at.z;
        bucket.headshot = bucket.headshot || headshot;
        bucket.destroyed = bucket.destroyed || destroyed;
        return;
      }
      if (!bucket.used && !free) free = bucket;
    }

    if (!free) {
      // More distinct targets than buckets: fold into the last rather than drop
      // the damage, so the total shown still matches the total dealt.
      const last = this.buckets[this.buckets.length - 1]!;
      last.amount += amount;
      return;
    }

    free.used = true;
    free.targetId = targetId;
    free.kind = kind;
    free.headshot = headshot;
    free.destroyed = destroyed;
    free.amount = amount;
    free.x = at.x;
    free.y = at.y;
    free.z = at.z;
  }

  /** Every bucket with damage in it. */
  *entries(): Generator<ShotBucket> {
    for (const bucket of this.buckets) {
      if (bucket.used && bucket.amount > 0) yield bucket;
    }
  }

  get anyHits(): boolean {
    for (const bucket of this.buckets) if (bucket.used && bucket.amount > 0) return true;
    return false;
  }

  clear(): void {
    for (const bucket of this.buckets) {
      bucket.used = false;
      bucket.amount = 0;
      bucket.headshot = false;
      bucket.destroyed = false;
      bucket.targetId = "";
    }
  }
}

// ---------------------------------------------------------------------------
// The DOM layer. Constructed only by the sandbox, so importing this module in
// Node for the policy above touches no browser API.
// ---------------------------------------------------------------------------

interface LiveNumber {
  readonly element: HTMLSpanElement;
  active: boolean;
  bornMs: number;
  x: number;
  y: number;
  z: number;
}

/** Projects a world point to viewport pixels. Kept narrow so tests need no three.js. */
export interface ScreenProjector {
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean };
}

/**
 * Pooled damage numbers and a hit marker.
 *
 * Numbers are DOM rather than sprites: the HUD is already DOM, text stays crisp
 * at any distance without a glyph atlas, and the browser composites it for
 * free. They are still world-anchored, as the spec requires -- each is projected
 * from its hit point every frame, so it stays on the thing it describes while
 * the camera moves.
 */
export class FeedbackLayer {
  private readonly pool: LiveNumber[] = [];
  private readonly marker: HTMLDivElement;
  private markerUntilMs = 0;
  private cursor = 0;

  constructor(parent: HTMLElement, poolSize = NUMBER_POOL_SIZE) {
    const root = document.createElement("div");
    root.className = "hud-feedback";

    for (let i = 0; i < poolSize; i++) {
      const element = document.createElement("span");
      element.className = "dmg";
      element.style.display = "none";
      root.appendChild(element);
      this.pool.push({ element, active: false, bornMs: 0, x: 0, y: 0, z: 0 });
    }

    this.marker = document.createElement("div");
    this.marker.className = "hit-marker";
    this.marker.style.display = "none";
    root.appendChild(this.marker);

    parent.appendChild(root);
  }

  /**
   * Show one number at a world point.
   *
   * When the pool is exhausted the oldest is recycled rather than the newest
   * dropped: during a spray the most recent hits are the ones being looked at.
   */
  showNumber(amount: number, at: Vec3, kind: HitKind, headshot: boolean, nowMs: number): void {
    const shown = displayDamage(amount);
    if (shown <= 0) return;

    const slot = this.takeSlot();
    slot.active = true;
    slot.bornMs = nowMs;
    slot.x = at.x;
    slot.y = at.y;
    slot.z = at.z;
    slot.element.textContent = String(shown);
    slot.element.className = `dmg ${numberClass(kind, headshot)}`;
    slot.element.style.display = "block";
  }

  /** Flash the hit marker. */
  showMarker(kind: HitKind, destroyed: boolean, nowMs: number): void {
    this.marker.className = `hit-marker ${markerClass(kind, destroyed)}`;
    this.marker.style.display = "block";
    this.markerUntilMs = nowMs + MARKER_LIFETIME * 1000;
  }

  /** Project every live number and retire the expired ones. */
  update(projector: ScreenProjector, nowMs: number): void {
    if (this.markerUntilMs > 0 && nowMs >= this.markerUntilMs) {
      this.marker.style.display = "none";
      this.markerUntilMs = 0;
    }

    for (const slot of this.pool) {
      if (!slot.active) continue;

      const fraction = lifeFraction((nowMs - slot.bornMs) / 1000);
      if (fraction >= 1) {
        this.retire(slot);
        continue;
      }

      const screen = projector.project(slot.x, slot.y + numberRise(fraction), slot.z);
      if (!screen.visible) {
        // Behind the camera: hidden, not retired, because turning back should
        // find it still counting down.
        slot.element.style.display = "none";
        continue;
      }

      slot.element.style.display = "block";
      slot.element.style.transform = `translate(${screen.x.toFixed(1)}px, ${screen.y.toFixed(1)}px)`;
      slot.element.style.opacity = numberOpacity(fraction).toFixed(3);
    }
  }

  /**
   * What is on screen right now, for the smoke test.
   *
   * A screenshot cannot tell a damage number from the ammo counter, and at the
   * frame rate software WebGL manages it may not even catch one before it
   * expires. Reading the elements is what makes "a shot produced one number
   * saying 30, and a chevron" an assertion rather than a hope.
   */
  describe(): {
    pool: number;
    visible: { text: string; cls: string; opacity: string }[];
    marker: string | null;
  } {
    return {
      pool: this.pool.length,
      visible: this.pool
        .filter((slot) => slot.active && slot.element.style.display !== "none")
        .map((slot) => ({
          text: slot.element.textContent ?? "",
          cls: slot.element.className,
          opacity: slot.element.style.opacity,
        })),
      marker: this.marker.style.display === "none" ? null : this.marker.className,
    };
  }

  private takeSlot(): LiveNumber {
    for (let i = 0; i < this.pool.length; i++) {
      const slot = this.pool[(this.cursor + i) % this.pool.length]!;
      if (!slot.active) {
        this.cursor = (this.cursor + i + 1) % this.pool.length;
        return slot;
      }
    }
    // All busy: recycle the oldest.
    let oldest = this.pool[0]!;
    for (const slot of this.pool) if (slot.bornMs < oldest.bornMs) oldest = slot;
    return oldest;
  }

  private retire(slot: LiveNumber): void {
    slot.active = false;
    slot.element.style.display = "none";
  }
}
