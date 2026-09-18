/**
 * Small math helpers.
 *
 * Deliberately independent of three.js: the simulation must run headless in
 * tests and on a Node server, where pulling in a renderer would be dead weight.
 * The render layer converts to `THREE.Vector3` at its own boundary.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const vec2 = (x = 0, y = 0): Vec2 => ({ x, y });

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

/** Lerp without clamping, for callers that need extrapolation. */
export function lerpUnclamped(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

export function length3(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function lengthSq3(v: Vec3): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

export function distance3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function distance2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function normalise3(v: Vec3): Vec3 {
  const len = length3(v);
  if (len < 1e-9) return vec3(0, 0, 0);
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale3(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}

export function lerp2(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

export function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Angle between two vectors, in degrees. */
export function angleBetween3(a: Vec3, b: Vec3): number {
  const denom = length3(a) * length3(b);
  if (denom < 1e-9) return 0;
  return (Math.acos(clamp(dot3(a, b) / denom, -1, 1)) * 180) / Math.PI;
}

/** Clamp a horizontal input vector to unit length, so diagonals are not faster. */
export function clampMagnitude2(v: Vec2, max: number): Vec2 {
  const lenSq = v.x * v.x + v.y * v.y;
  if (lenSq <= max * max || lenSq < 1e-12) return v;
  const scale = max / Math.sqrt(lenSq);
  return { x: v.x * scale, y: v.y * scale };
}

/** Wrap a value into [0, limit). */
export function repeat(value: number, limit: number): number {
  return value - Math.floor(value / limit) * limit;
}

/** Shortest signed difference between two angles, in degrees. */
export function deltaAngle(from: number, to: number): number {
  let delta = repeat(to - from, 360);
  if (delta > 180) delta -= 360;
  return delta;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + deltaAngle(a, b) * clamp01(t);
}

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
