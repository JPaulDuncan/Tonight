/**
 * The night clock: lighting as a function of storm progress.
 *
 * Vision pillar 2 is that the match runs from dusk to sunrise, and the storm
 * phase is the hand on that clock. `MatchLightingBlueprint` holds one keyframe
 * per phase; this interpolates between them so the sky moves continuously
 * rather than snapping at each phase boundary, which would read as a bug.
 *
 * Pure arithmetic over Blueprint data -- no three.js, no colour library. The
 * renderer takes the numbers and sets whatever it sets.
 *
 * The one rule this must not break is the visibility floor: ambient light never
 * affects gameplay, and `minPlayerRimIntensity` is the bottom of it. Nothing
 * here may return a value that darkens a character below that floor, so the
 * floor is not interpolated at all -- it is a constant of the Blueprint.
 */

import type { LightingKeyframe, MatchLightingBlueprint } from "@/blueprints/types";
import { clamp01, lerp } from "@/core/math";

/** A colour as three 0..1 channels, which is what a renderer wants. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface SkyState {
  readonly sun: Rgb;
  readonly sunIntensity: number;
  readonly fog: Rgb;
  readonly fogDensity: number;
  readonly sunElevationDegrees: number;
  /** The floor under character visibility. Never interpolated. */
  readonly rimIntensity: number;
}

/** `#rrggbb` to channels. Anything unparseable is mid grey rather than black. */
export function parseHex(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return { r: 0.5, g: 0.5, b: 0.5 };
  const value = Number.parseInt(match[1]!, 16);
  return {
    r: ((value >> 16) & 0xff) / 255,
    g: ((value >> 8) & 0xff) / 255,
    b: (value & 0xff) / 255,
  };
}

export function toHex(colour: Rgb): string {
  const channel = (v: number) =>
    Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  return `#${channel(colour.r)}${channel(colour.g)}${channel(colour.b)}`;
}

/**
 * Blend two colours.
 *
 * Done per channel on the authored sRGB values rather than in linear space.
 * That is the wrong answer for physical light and the right one here: the
 * keyframes were picked by eye against the rendered scene, so the midpoint a
 * designer expects between dusk orange and blue hour is the one halfway along
 * the swatch, not the one halfway along the photon count.
 */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t);
  return { r: lerp(a.r, b.r, k), g: lerp(a.g, b.g, k), b: lerp(a.b, b.b, k) };
}

function keyframeFor(
  lighting: MatchLightingBlueprint, phaseIndex: number,
): LightingKeyframe | undefined {
  return lighting.keyframesByPhase.find((k) => k.phaseIndex === phaseIndex);
}

function stateOf(keyframe: LightingKeyframe, rimIntensity: number): SkyState {
  return {
    sun: parseHex(keyframe.sunColour),
    sunIntensity: keyframe.sunIntensity,
    fog: parseHex(keyframe.fogColour),
    fogDensity: keyframe.fogDensity,
    sunElevationDegrees: keyframe.sunElevationDegrees,
    rimIntensity,
  };
}

/**
 * The sky partway through a phase.
 *
 * `fraction` is how far through `phaseIndex` the match is, 0..1. At 1 the
 * result equals the next phase's keyframe exactly, which is what makes the
 * boundary invisible: the last frame of phase 2 and the first frame of phase 3
 * describe the same sky.
 *
 * The final phase holds its own keyframe rather than extrapolating into a
 * colour nobody authored.
 */
export function skyAt(
  lighting: MatchLightingBlueprint, phaseIndex: number, fraction: number,
): SkyState {
  const floor = lighting.minPlayerRimIntensity;
  const frames = lighting.keyframesByPhase;
  if (frames.length === 0) {
    return {
      sun: { r: 1, g: 1, b: 1 }, sunIntensity: 1,
      fog: { r: 0.5, g: 0.5, b: 0.5 }, fogDensity: 0.01,
      sunElevationDegrees: 0, rimIntensity: floor,
    };
  }

  const first = frames.reduce((a, b) => (a.phaseIndex <= b.phaseIndex ? a : b));
  const last = frames.reduce((a, b) => (a.phaseIndex >= b.phaseIndex ? a : b));
  if (phaseIndex <= first.phaseIndex && fraction <= 0) return stateOf(first, floor);
  if (phaseIndex >= last.phaseIndex) return stateOf(last, floor);

  const current = keyframeFor(lighting, phaseIndex) ?? first;
  const next = keyframeFor(lighting, phaseIndex + 1) ?? last;
  const t = clamp01(fraction);

  return {
    sun: mixRgb(parseHex(current.sunColour), parseHex(next.sunColour), t),
    sunIntensity: lerp(current.sunIntensity, next.sunIntensity, t),
    fog: mixRgb(parseHex(current.fogColour), parseHex(next.fogColour), t),
    fogDensity: lerp(current.fogDensity, next.fogDensity, t),
    sunElevationDegrees: lerp(
      current.sunElevationDegrees, next.sunElevationDegrees, t,
    ),
    rimIntensity: floor,
  };
}

/**
 * Where the sun sits, in metres, for a light at `distance` from the scene.
 *
 * Below the horizon the elevation is negative and the light drops under the
 * ground, which is exactly right: that is what night is. The renderer keeps
 * its ambient floor regardless, so nothing becomes invisible.
 */
export function sunPosition(
  elevationDegrees: number, distance: number, azimuthDegrees = 35,
): { x: number; y: number; z: number } {
  const elevation = (elevationDegrees * Math.PI) / 180;
  const azimuth = (azimuthDegrees * Math.PI) / 180;
  const horizontal = Math.cos(elevation) * distance;
  return {
    x: Math.sin(azimuth) * horizontal,
    y: Math.sin(elevation) * distance,
    z: Math.cos(azimuth) * horizontal,
  };
}
