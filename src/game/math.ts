/**
 * Small dependency-free math/utility toolbox shared by every module.
 *
 * OWNER: lead. Read-only for teammates — if you need another helper, ask the lead
 * instead of adding one here (this file is imported by all four workstreams).
 */

import type { Rng, Vec2 } from './types';

export const TAU = Math.PI * 2;

/* ------------------------------------------------------------ scalar math -- */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const inverseLerp = (a: number, b: number, v: number): number => (b === a ? 0 : clamp01((v - a) / (b - a)));
export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
export const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Wrap `v` into [0, max). */
export function wrap(v: number, max: number): number {
  if (max <= 0) return 0;
  const m = v % max;
  return m < 0 ? m + max : m;
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  else if (x <= -Math.PI) x += TAU;
  return x;
}

/** Shortest signed rotation taking angle `a` to angle `b`. */
export const angleDiff = (a: number, b: number): number => wrapAngle(b - a);

/** Frame-rate independent exponential smoothing: moves `current` toward `target`. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Frame-rate independent smoothing for angles (takes the short way round). */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + angleDiff(current, target) * (1 - Math.exp(-lambda * dt));
}

/* -------------------------------------------------------------- vector 2 -- */

export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const clone = (a: Vec2): Vec2 => ({ x: a.x, y: a.y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const addScaled = (a: Vec2, b: Vec2, k: number): Vec2 => ({ x: a.x + b.x * k, y: a.y + b.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** 2D cross product (z component of the 3D cross product). */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len2 = (a: Vec2): number => a.x * a.x + a.y * a.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist2 = (a: Vec2, b: Vec2): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export function norm(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
}

export function limit(a: Vec2, max: number): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return l > max && l > 1e-9 ? { x: (a.x / l) * max, y: (a.y / l) * max } : { x: a.x, y: a.y };
}

export const fromAngle = (angle: number, length = 1): Vec2 => ({
  x: Math.cos(angle) * length,
  y: Math.sin(angle) * length,
});

/** Rotate `a` by `angle` radians (clockwise on screen, matching canvas). */
export function rot(a: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

/** Rotate a -90°: the left-hand side of a heading. */
export const perpLeft = (a: Vec2): Vec2 => ({ x: a.y, y: -a.x });

/** Rotate a +90°: the right-hand side of a heading. */
export const perpRight = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

export const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);

/* ------------------------------------------------------------- geometry --- */

export interface ClosestPoint {
  point: Vec2;
  /** 0..1 position along ab */
  t: number;
  dist: number;
}

/** Closest point on segment ab to p, plus the squared distance is not returned. */
export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): ClosestPoint {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  const t = l2 > 1e-9 ? clamp01(((p.x - a.x) * abx + (p.y - a.y) * aby) / l2) : 0;
  const point = { x: a.x + abx * t, y: a.y + aby * t };
  return { point, t, dist: Math.hypot(p.x - point.x, p.y - point.y) };
}

/** Does the circle (center c, radius r) overlap segment ab? */
export function circleSegmentHit(c: Vec2, r: number, a: Vec2, b: Vec2): boolean {
  return closestPointOnSegment(c, a, b).dist <= r;
}

/** Do segments p1p2 and p3p4 cross? Touching endpoints count. */
export function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1 = cross(sub(p2, p1), sub(p3, p1));
  const d2 = cross(sub(p2, p1), sub(p4, p1));
  const d3 = cross(sub(p4, p3), sub(p1, p3));
  const d4 = cross(sub(p4, p3), sub(p2, p3));
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/* ---------------------------------------------------------------- random -- */

/** Deterministic 32-bit PRNG (mulberry32). Same seed ⇒ same sequence. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randRange = (rng: Rng, lo: number, hi: number): number => lo + rng() * (hi - lo);
export const randInt = (rng: Rng, loInclusive: number, hiInclusive: number): number =>
  Math.floor(loInclusive + rng() * (hiInclusive - loInclusive + 1));
export const chance = (rng: Rng, p: number): boolean => rng() < p;

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length] as T;
}

/** Returns a new shuffled array (Fisher–Yates, deterministic). */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Hash a string into a 32-bit unsigned int (used for stable track ids). */
export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/* ---------------------------------------------------------------- spline -- */

/** Centripetal-ish Catmull–Rom interpolation of 4 control points at t in [0,1]. */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

export const catmullRomVec = (p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 => ({
  x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
  y: catmullRom(p0.y, p1.y, p2.y, p3.y, t),
});

/* ----------------------------------------------------------------- misc --- */

/** 83.456 → "1:23.456"; null → "--:--.---" */
export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--.---';
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(3)}`;
}

/** Signed delta for the HUD: +1.23 / -0.45 */
export function formatDelta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--';
  return `${seconds >= 0 ? '+' : '-'}${Math.abs(seconds).toFixed(2)}`;
}
