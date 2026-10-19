/**
 * NEON RACER — procedural closed-circuit generator.
 *
 * OWNER: engine-dev.
 *
 * Pipeline:
 *   1. deterministic jittered control points on a (possibly anisotropic) circle
 *   2. closed Catmull–Rom spline through them
 *   3. even arc-length resampling at ~TRACK.sampleStep
 *   4. curvature-limited smoothing so no corner is tighter than TRACK.minRadius
 *   5. validation (simple loop, bounds) with deterministic retries
 *   6. width profile from curvature, real racing line (wide entry / tight apex /
 *      wide exit), start line on the straightest stretch
 *   7. O(1)-ish nearest-centerline query through a uniform spatial grid
 *
 * Every random draw comes from a seed-derived mulberry32 RNG, so
 * generateTrack(seed, style) is a pure deterministic function.
 */

import { TRACK } from './config';
import {
  TAU,
  clamp,
  catmullRomVec,
  dist,
  hashString,
  inverseLerp,
  lerp,
  mulberry32,
  perpLeft,
  smoothstep,
  wrap,
  wrapAngle,
} from './math';
import type { Rng, Surface, Track, TrackQuery, TrackSample, TrackStyle, Vec2 } from './types';

/* ------------------------------------------------------------------ tuning -- */

/** spatial grid cell size, world units (must comfortably exceed TRACK.minRadius) */
const GRID_CELL = 200;
/** how far inside the asphalt edge the racing line is kept at minimum */
const RACING_LINE_MARGIN = 16;
/**
 * Minimum radius of curvature allowed for the racing line itself (the line cuts
 * inside the corners, so it may be tighter than the centreline — but never by
 * more than 10%, otherwise the line stops being drivable).
 */
const LINE_RADIUS_FLOOR = TRACK.minRadius * 0.9;
/** cap on generator attempts (each attempt is deterministic) */
const MAX_ATTEMPTS = 7;
/** cap on curvature-limit smoothing passes per attempt */
const MAX_SMOOTH_PASSES = 220;

/* ------------------------------------------------------------------ assets -- */

const NAME_ADJECTIVES: Record<'circuit' | 'technical' | 'speedway', readonly string[]> = {
  circuit: ['NEON', 'CHROME', 'VIOLET', 'ELECTRIC', 'MIDNIGHT', 'SYNTH', 'HYPER', 'LASER', 'AURORA'],
  technical: ['TWISTED', 'RAZOR', 'SERPENT', 'CINDER', 'KNOT', 'RIPTIDE', 'VERTIGO', 'OBSIDIAN'],
  speedway: ['TURBO', 'BLAZE', 'COMET', 'THUNDER', 'BOLT', 'VELOCITY', 'PHOTON', 'MACH'],
};

const NAME_NOUNS = ['SPIRAL', 'LOOP', 'RING', 'CIRCUIT', 'MAZE', 'CIRCLE', 'PULSE', 'PASS', 'RUN', 'HAIRPIN'];

/* --------------------------------------------------------------- type utils -- */

type ConcreteStyle = 'circuit' | 'technical' | 'speedway';

interface StyleParams {
  baseRadius: number;
  radialJitter: number;
  angularJitter: number;
  notchCount: number;
  notchDepthMin: number;
  notchDepthMax: number;
  anisotropyMin: number;
  anisotropyMax: number;
  widthBias: number;
  minControls: number;
  maxControls: number;
}

/* ------------------------------------------------------------------ helpers -- */

function resolveStyle(seed: number, style: TrackStyle): ConcreteStyle {
  if (style !== 'random') return style;
  // Independent hash so generateTrack(seed, 'random') === generateTrack(seed, picked).
  const rng = mulberry32((seed ^ 0x51ed270b) >>> 0);
  return TRACK.styles[Math.floor(rng() * TRACK.styles.length) % TRACK.styles.length] as ConcreteStyle;
}

function styleParams(style: ConcreteStyle): StyleParams {
  switch (style) {
    case 'technical':
      return {
        baseRadius: TRACK.fieldSize * 0.215,
        radialJitter: 0.17,
        angularJitter: 0.42,
        notchCount: 2,
        notchDepthMin: 0.62,
        notchDepthMax: 0.8,
        anisotropyMin: 0.96,
        anisotropyMax: 1.06,
        widthBias: 0.8,
        minControls: 11,
        maxControls: 14,
      };
    case 'speedway':
      return {
        baseRadius: TRACK.fieldSize * 0.25,
        radialJitter: 0.06,
        angularJitter: 0.16,
        notchCount: 0,
        notchDepthMin: 1,
        notchDepthMax: 1,
        anisotropyMin: 1.42,
        anisotropyMax: 1.6,
        widthBias: 1.14,
        minControls: 9,
        maxControls: 11,
      };
    case 'circuit':
    default:
      return {
        baseRadius: TRACK.fieldSize * 0.255,
        radialJitter: 0.15,
        angularJitter: 0.35,
        notchCount: 1,
        notchDepthMin: 0.7,
        notchDepthMax: 0.86,
        anisotropyMin: 0.95,
        anisotropyMax: 1.08,
        widthBias: 1,
        minControls: 9,
        maxControls: 12,
      };
  }
}

/** Closed Catmull–Rom sampling of `controls` with `subdiv` steps per segment. */
function sampleClosedSpline(controls: readonly Vec2[], subdiv: number): Vec2[] {
  const n = controls.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = controls[(i - 1 + n) % n] as Vec2;
    const p1 = controls[i] as Vec2;
    const p2 = controls[(i + 1) % n] as Vec2;
    const p3 = controls[(i + 2) % n] as Vec2;
    for (let k = 0; k < subdiv; k++) out.push(catmullRomVec(p0, p1, p2, p3, k / subdiv));
  }
  return out;
}

interface ResampledLoop {
  points: Vec2[];
  step: number;
  length: number;
}

/** Resample a closed polyline to even arc-length spacing close to `targetStep`. */
function resampleClosed(raw: readonly Vec2[], targetStep: number): ResampledLoop {
  const n = raw.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = raw[i] as Vec2;
    const b = raw[(i + 1) % n] as Vec2;
    cum[i + 1] = (cum[i] as number) + dist(a, b);
  }
  const total = cum[n] as number;
  const count = Math.max(64, Math.round(total / targetStep));
  const step = total / count;
  const points: Vec2[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (seg < n - 1 && (cum[seg + 1] as number) < target) seg++;
    const segStart = cum[seg] as number;
    const segLen = (cum[seg + 1] as number) - segStart;
    const t = segLen > 1e-9 ? (target - segStart) / segLen : 0;
    const a = raw[seg] as Vec2;
    const b = raw[(seg + 1) % n] as Vec2;
    points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return { points, step, length: total };
}

const headingOf = (a: Vec2, b: Vec2): number => Math.atan2(b.y - a.y, b.x - a.x);

/**
 * Signed curvature per sample (positive = turning left, matching TrackSample docs:
 * our heading convention turns left when the canvas angle shrinks, hence the minus).
 */
function computeCurvature(points: readonly Vec2[], step: number): number[] {
  const n = points.length;
  const kappa = new Array<number>(n);
  const inv = 1 / step;
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n] as Vec2;
    const here = points[i] as Vec2;
    const next = points[(i + 1) % n] as Vec2;
    const hPrev = headingOf(prev, here);
    const hNext = headingOf(here, next);
    kappa[i] = -wrapAngle(hNext - hPrev) * inv;
  }
  return kappa;
}

/** Circular moving average of a per-sample scalar. */
function smoothCircular(values: readonly number[], radius: number): number[] {
  const n = values.length;
  if (radius <= 0 || n === 0) return values.slice();
  const out = new Array<number>(n);
  const span = radius * 2 + 1;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += values[wrap(i + k, n)] as number;
    out[i] = sum / span;
  }
  return out;
}

/**
 * Round off corners until every curvature radius is at least `minRadius`.
 *
 * A violation mask is built per sample and blurred with a Gaussian whose width
 * grows slowly across passes; every point is then pulled towards a Gaussian
 * blur of the curve, with a strength proportional to that mask. A Gaussian blur
 * lowers curvature, the correction is local, and the limit is a smooth oval, so
 * the process converges without ever moving points outside the playfield.
 * Spacing is restored by an even resample every few passes.
 */
function enforceMinRadius(points: Vec2[], step: number, minRadius: number, passes: number): Vec2[] {
  let current = points.slice();
  let currentStep = step;
  const target = minRadius * 1.03;
  const moved: Vec2[] = new Array<Vec2>(points.length);
  for (let pass = 0; pass < passes; pass++) {
    const kappa = computeCurvature(current, currentStep);
    const n = current.length;
    const bad = new Float64Array(n);
    let violations = 0;
    for (let i = 0; i < n; i++) {
      const k = Math.abs(kappa[i] as number);
      const radius = k > 1e-7 ? 1 / k : Number.POSITIVE_INFINITY;
      if (radius < target) {
        bad[i] = 1;
        violations++;
      }
    }
    if (violations === 0) break;

    const sigma = Math.min(16, 2 + pass * 0.07);
    const reach = Math.ceil(sigma * 3);
    const falloff = new Float64Array(reach * 2 + 1);
    const kernel = new Float64Array(reach * 2 + 1);
    let kernelSum = 0;
    for (let d = -reach; d <= reach; d++) {
      const g = Math.exp(-(d * d) / (2 * sigma * sigma));
      falloff[d + reach] = g;
      kernel[d + reach] = g;
      kernelSum += g;
    }
    if (kernelSum > 0) for (let i = 0; i < kernel.length; i++) kernel[i] = (kernel[i] as number) / kernelSum;

    while (moved.length < n) moved.push({ x: 0, y: 0 });
    for (let i = 0; i < n; i++) {
      const here = current[i] as Vec2;
      let mask = 0;
      let sx = 0;
      let sy = 0;
      for (let d = -reach; d <= reach; d++) {
        const j = wrap(i + d, n);
        const g = falloff[d + reach] as number;
        if (g > 1e-4 && bad[j]) {
          mask += g;
        }
        const w = kernel[d + reach] as number;
        const p = current[j] as Vec2;
        sx += p.x * w;
        sy += p.y * w;
      }
      const weight = 0.8 * (mask > 1 ? 1 : mask);
      moved[i] = { x: here.x * (1 - weight) + sx * weight, y: here.y * (1 - weight) + sy * weight };
    }
    const needsResample = pass % 3 === 2 || pass === passes - 1;
    if (needsResample) {
      const resampled = resampleClosed(moved.slice(0, n), TRACK.sampleStep);
      current = resampled.points;
      currentStep = resampled.step;
    } else {
      current = moved.slice(0, n);
    }
  }
  return current;
}

/** Is the loop a simple, non-self-intersecting star-shaped closed curve? */
function isSimpleLoop(points: readonly Vec2[]): boolean {
  const n = points.length;
  if (n < 32) return false;
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  let winding = 0;
  let prevAngle = Math.atan2((points[0] as Vec2).y - cy, (points[0] as Vec2).x - cx);
  for (let i = 1; i <= n; i++) {
    const p = points[i % n] as Vec2;
    const dx = p.x - cx;
    const dy = p.y - cy;
    if (Math.hypot(dx, dy) < 1) return false;
    const angle = Math.atan2(dy, dx);
    const delta = wrapAngle(angle - prevAngle);
    // every step must advance in the same rotational direction and be < half a turn
    if (delta <= 1e-4 || delta >= Math.PI * 0.75) return false;
    winding += delta;
    prevAngle = angle;
  }
  return Math.abs(winding - TAU) < 0.05;
}

/* --------------------------------------------------------------- generator -- */

interface LoopBuild {
  points: Vec2[];
  step: number;
  length: number;
  kappa: number[];
}

function buildControlPoints(rng: Rng, params: StyleParams, jitterScale: number): Vec2[] {
  const count = Math.floor(lerp(params.minControls, params.maxControls + 1, rng()));
  const n = clamp(count, TRACK.minControlPoints, TRACK.maxControlPoints);
  const spacing = TAU / n;
  const rotation = rng() * TAU;
  const anisotropy = lerp(params.anisotropyMin, params.anisotropyMax, rng());
  const radial = new Array<number>(n);
  const angle = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    angle[i] = rotation + i * spacing + (rng() * 2 - 1) * params.angularJitter * spacing * jitterScale;
    radial[i] = params.baseRadius * (1 + (rng() * 2 - 1) * params.radialJitter * jitterScale);
  }
  // Deliberate notches create proper braking corners (technical / circuit).
  for (let k = 0; k < params.notchCount; k++) {
    const idx = Math.floor(rng() * n) % n;
    const depth = lerp(params.notchDepthMin, params.notchDepthMax, rng());
    const sign = rng() < 0.65 ? 1 : -1; // mostly inward notches, sometimes bumps
    radial[idx] = (radial[idx] as number) * (sign > 0 ? depth : 2 - depth);
  }
  const controls: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const r = radial[i] as number;
    const a = angle[i] as number;
    controls.push({ x: Math.cos(a) * r * anisotropy, y: Math.sin(a) * r });
  }
  return controls;
}

function buildLoop(rng: Rng, style: ConcreteStyle, jitterScale: number): LoopBuild {
  const params = styleParams(style);
  const controls = buildControlPoints(rng, params, jitterScale);
  const dense = sampleClosedSpline(controls, 72);
  let resampled = resampleClosed(dense, TRACK.sampleStep);
  const limited = enforceMinRadius(resampled.points, resampled.step, TRACK.minRadius, MAX_SMOOTH_PASSES);
  resampled = resampleClosed(limited, TRACK.sampleStep);
  return {
    points: resampled.points,
    step: resampled.step,
    length: resampled.length,
    kappa: computeCurvature(resampled.points, resampled.step),
  };
}

/** Does every centreline point (plus its asphalt edge) stay inside the playfield? */
function insideField(points: readonly Vec2[], kappa: readonly number[], widthBias: number): boolean {
  const limit = TRACK.fieldSize / 2 - 2;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vec2;
    const k = Math.abs(kappa[i] as number);
    const radius = k > 1e-7 ? 1 / k : Number.POSITIVE_INFINITY;
    const width = trackWidthAt(radius, widthBias);
    // conservative circular bound around the sample
    if (Math.hypot(p.x, p.y) + width / 2 + TRACK.runoff > limit) return false;
  }
  return true;
}

/** Final guard: every corner radius must respect TRACK.minRadius. */
function satisfiesMinRadius(kappa: readonly number[], minRadius: number): boolean {
  for (const k of kappa) {
    const abs = Math.abs(k);
    if (abs > 1e-7 && 1 / abs < minRadius * 0.97) return false;
  }
  return true;
}

/** Even out any tiny curvature noise before deriving width / racing line. */
function polishCurvature(kappa: readonly number[]): number[] {
  return smoothCircular(smoothCircular(kappa, 2), 2);
}

function trackWidthAt(radius: number, widthBias: number): number {
  const straightness = smoothstep(inverseLerp(300, 1000, radius));
  const base = lerp(TRACK.minWidth, TRACK.maxWidth, straightness) * widthBias;
  return clamp(base, TRACK.minWidth, TRACK.maxWidth);
}

function buildWidthProfile(kappa: readonly number[], params: StyleParams): number[] {
  const raw: number[] = kappa.map((k) => {
    const radius = Math.abs(k) > 1e-7 ? 1 / Math.abs(k) : Number.POSITIVE_INFINITY;
    return trackWidthAt(radius, params.widthBias);
  });
  const smoothed = smoothCircular(raw, 22);
  return smoothed.map((w) => clamp(w, TRACK.minWidth, TRACK.maxWidth));
}

/**
 * Raw racing-line offset profile: wide entry / tight apex / wide exit.
 *
 * A corner apex (a curvature maximum) pushes the line towards the inside while the
 * entry/exit flanks push it to the outside. The raw signal is intentionally dirty;
 * `smoothOffsets` + `relaxRacingLine` turn it into something a car can actually
 * follow while never coming closer than RACING_LINE_MARGIN to the asphalt edge.
 */
function buildRacingLineOffsets(kappa: readonly number[], widths: readonly number[], step: number): number[] {
  const n = kappa.length;
  const kappaSmooth = smoothCircular(kappa, 6);
  const look = Math.max(2, Math.round(150 / step));
  const hmax = new Array<number>(n);
  const contrast = new Array<number>(n);
  let maxContrast = 1e-9;
  for (let i = 0; i < n; i++) {
    const here = kappaSmooth[i] as number;
    const ahead = kappaSmooth[wrap(i + look, n)] as number;
    const behind = kappaSmooth[wrap(i - look, n)] as number;
    const value = 2 * here - ahead - behind;
    contrast[i] = value;
    const abs = Math.abs(value);
    if (abs > maxContrast) maxContrast = abs;
    hmax[i] = Math.max(8, (widths[i] as number) / 2 - RACING_LINE_MARGIN);
  }
  // normalise so the sharpest corner uses most of the available width
  const scale = 1 / Math.max(1e-7, maxContrast * 0.6);
  const normalized = new Array<number>(n);
  for (let i = 0; i < n; i++) normalized[i] = clamp((contrast[i] as number) * scale, -1, 1);
  const offsets = new Array<number>(n);
  for (let i = 0; i < n; i++) offsets[i] = (normalized[i] as number) * (hmax[i] as number);
  return offsets;
}

/** Heavy circular low-pass: kills the shoulders in the raw profile without erasing its shape. */
function smoothOffsets(offsets: readonly number[], radius: number, passes: number): number[] {
  let current = offsets.slice();
  for (let pass = 0; pass < passes; pass++) current = smoothCircular(current, radius);
  return current;
}

/**
 * Curvature-limited relaxation of the racing line.
 *
 * The offset curve is measured geometrically (radius of the polyline through three
 * consecutive line points). Where it dips below `minRadius`, a smooth windowed
 * shrink pulls the offsets back towards the centreline. Shrinking is monotone and
 * bounded (offsets stay inside the asphalt), and the limit `h = 0` is the
 * centreline itself, whose radius is guaranteed to be above the floor — so this
 * always converges and never needs a hard-coded cap in the result.
 */
function relaxRacingLine(
  offsets: readonly number[],
  centers: readonly Vec2[],
  normals: readonly Vec2[],
  widths: readonly number[],
  minRadius: number,
): number[] {
  const n = offsets.length;
  const hmax = new Float64Array(n);
  for (let i = 0; i < n; i++) hmax[i] = Math.max(8, (widths[i] as number) / 2 - RACING_LINE_MARGIN);
  let h = Float64Array.from(offsets);
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const bad = new Uint8Array(n);
  const next = new Float64Array(n);
  const badFactors = new Float64Array(n);
  const target = minRadius * 1.01;
  const sigma = 12;
  const reach = Math.ceil(sigma * 3);
  for (let pass = 0; pass < 600; pass++) {
    for (let i = 0; i < n; i++) {
      px[i] = (centers[i] as Vec2).x + (normals[i] as Vec2).x * (h[i] as number);
      py[i] = (centers[i] as Vec2).y + (normals[i] as Vec2).y * (h[i] as number);
    }
    let violations = 0;
    for (let i = 0; i < n; i++) {
      const i0 = (i - 1 + n) % n;
      const i1 = (i + 1) % n;
      const ax = px[i0] as number;
      const ay = py[i0] as number;
      const bx = px[i] as number;
      const by = py[i] as number;
      const cx = px[i1] as number;
      const cy = py[i1] as number;
      const cross = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
      let radius = Number.POSITIVE_INFINITY;
      if (cross > 1e-9) {
        radius =
          (Math.hypot(bx - ax, by - ay) * Math.hypot(cx - bx, cy - by) * Math.hypot(ax - cx, ay - cy)) / (2 * cross);
      }
      if (radius < target) {
        bad[i] = 1;
        violations++;
      } else {
        bad[i] = 0;
      }
    }
    if (violations === 0) break;
    badFactors.fill(1);
    for (let i = 0; i < n; i++) {
      if (!bad[i]) continue;
      for (let d = -reach; d <= reach; d++) {
        const j = wrap(i + d, n);
        const factor = 1 - 0.06 * Math.exp(-(d * d) / (2 * sigma * sigma));
        if (factor < (badFactors[j] as number)) badFactors[j] = factor;
      }
    }
    for (let i = 0; i < n; i++) next[i] = (h[i] as number) * (badFactors[i] as number);
    // light low-pass so the shrinking offsets stay smooth
    for (let i = 0; i < n; i++) {
      const value = ((next[(i - 1 + n) % n] as number) + (next[i] as number) * 2 + (next[(i + 1) % n] as number)) / 4;
      const lim = hmax[i] as number;
      next[i] = value > lim ? lim : value < -lim ? -lim : value;
    }
    h = Float64Array.from(next);
  }
  return Array.from(h);
}

/** Rotate every index-aligned array so that `shift` becomes index 0. */
function rotateArray<T>(arr: readonly T[], shift: number): T[] {
  const n = arr.length;
  const s = wrap(shift, n);
  const out = new Array<T>(n);
  for (let i = 0; i < n; i++) out[i] = arr[(i + s) % n] as T;
  return out;
}

/* --------------------------------------------------------------- query grid -- */

interface SpatialGrid {
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  cells: number[][];
  cellSize: number;
}

function buildGrid(points: readonly Vec2[]): SpatialGrid {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  // pad by one cell so queries slightly outside still start inside the grid
  minX -= GRID_CELL;
  minY -= GRID_CELL;
  maxX += GRID_CELL;
  maxY += GRID_CELL;
  const cols = Math.max(1, Math.ceil((maxX - minX) / GRID_CELL));
  const rows = Math.max(1, Math.ceil((maxY - minY) / GRID_CELL));
  const cells: number[][] = new Array(cols * rows);
  for (let i = 0; i < cells.length; i++) cells[i] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vec2;
    const cx = clamp(Math.floor((p.x - minX) / GRID_CELL), 0, cols - 1);
    const cy = clamp(Math.floor((p.y - minY) / GRID_CELL), 0, rows - 1);
    (cells[cy * cols + cx] as number[]).push(i);
  }
  return { minX, minY, cols, rows, cells, cellSize: GRID_CELL };
}

function nearestSampleIndex(grid: SpatialGrid, points: readonly Vec2[], p: Vec2): number {
  const { minX, minY, cols, rows, cells, cellSize } = grid;
  // clamp the start cell into the grid, then expand ring by ring until the best
  // candidate provably beats everything still unsearched
  const qx = clamp(Math.floor((p.x - minX) / cellSize), 0, cols - 1);
  const qy = clamp(Math.floor((p.y - minY) / cellSize), 0, rows - 1);
  let best = -1;
  let bestD2 = Infinity;
  const maxRing = Math.max(cols, rows);
  for (let ring = 0; ring <= maxRing; ring++) {
    const x0 = qx - ring;
    const x1 = qx + ring;
    const y0 = qy - ring;
    const y1 = qy + ring;
    for (let cy = y0; cy <= y1; cy++) {
      if (cy < 0 || cy >= rows) continue;
      for (let cx = x0; cx <= x1; cx++) {
        if (cx < 0 || cx >= cols) continue;
        // only the ring border when ring > 0
        if (ring > 0 && cx !== x0 && cx !== x1 && cy !== y0 && cy !== y1) continue;
        const bucket = cells[cy * cols + cx] as number[];
        for (let k = 0; k < bucket.length; k++) {
          const idx = bucket[k] as number;
          const q = points[idx] as Vec2;
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = idx;
          }
        }
      }
    }
    if (best >= 0 && ring * cellSize > Math.sqrt(bestD2) + 1e-6) {
      // every cell in the next ring is farther away than the current best
      break;
    }
  }
  return best >= 0 ? best : 0;
}

/* --------------------------------------------------------------- result types -- */

interface FinalizeInput {
  points: Vec2[];
  step: number;
  kappa: number[];
}

function finalizeTrack(seed: number, style: ConcreteStyle, input: FinalizeInput): Track {
  const { points, step, kappa } = input;
  const n = points.length;
  const length = n * step;
  const polishedKappa = polishCurvature(kappa);
  const params = styleParams(style);

  // width profile, gently varying with curvature
  const widths = buildWidthProfile(polishedKappa, params);

  // rotate the loop so index 0 sits on the straightest stretch (start/finish line).
  // The window covers the whole start grid plus the launch zone, so the wider
  // grid rows always spawn on a gentle part of the track.
  const window = Math.max(4, Math.round(360 / step));
  let bestStart = 0;
  let bestCost = Infinity;
  for (let i = 0; i < n; i++) {
    let cost = 0;
    for (let k = -window; k <= window; k++) cost += Math.abs(polishedKappa[wrap(i + k, n)] as number);
    if (cost < bestCost) {
      bestCost = cost;
      bestStart = i;
    }
  }
  const pos = rotateArray(points, bestStart);
  const kap = rotateArray(polishedKappa, bestStart);
  const wid = rotateArray(widths, bestStart);

  // derived per-sample data
  const dirs: Vec2[] = new Array<Vec2>(n);
  const normals: Vec2[] = new Array<Vec2>(n);
  for (let i = 0; i < n; i++) {
    const a = pos[i] as Vec2;
    const b = pos[(i + 1) % n] as Vec2;
    const inv = 1 / Math.max(1e-9, dist(a, b));
    const dir = { x: (b.x - a.x) * inv, y: (b.y - a.y) * inv };
    dirs[i] = dir;
    normals[i] = perpLeft(dir);
  }

  const leftEdge: Vec2[] = new Array<Vec2>(n);
  const rightEdge: Vec2[] = new Array<Vec2>(n);
  for (let i = 0; i < n; i++) {
    const p = pos[i] as Vec2;
    const nr = normals[i] as Vec2;
    const half = (wid[i] as number) / 2;
    leftEdge[i] = { x: p.x + nr.x * half, y: p.y + nr.y * half };
    rightEdge[i] = { x: p.x - nr.x * half, y: p.y - nr.y * half };
  }

  const rawOffsets = buildRacingLineOffsets(kap, wid, step);
  // low-pass the raw profile, then guarantee the line's own corner radii are drivable
  const lineOffsets = relaxRacingLine(smoothOffsets(rawOffsets, 20, 3), pos, normals, wid, LINE_RADIUS_FLOOR);
  const racingLine: Vec2[] = new Array<Vec2>(n);
  for (let i = 0; i < n; i++) {
    const p = pos[i] as Vec2;
    const nrm = normals[i] as Vec2;
    const lim = Math.max(0, (wid[i] as number) / 2 - RACING_LINE_MARGIN);
    const h = clamp(lineOffsets[i] as number, -lim, lim);
    racingLine[i] = { x: p.x + nrm.x * h, y: p.y + nrm.y * h };
  }

  const samples: TrackSample[] = new Array<TrackSample>(n);
  for (let i = 0; i < n; i++) {
    samples[i] = {
      pos: { x: (pos[i] as Vec2).x, y: (pos[i] as Vec2).y },
      dir: dirs[i] as Vec2,
      normal: normals[i] as Vec2,
      curvature: kap[i] as number,
      width: wid[i] as number,
      s: i * step,
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    for (const e of [leftEdge[i] as Vec2, rightEdge[i] as Vec2]) {
      if (e.x < minX) minX = e.x;
      if (e.y < minY) minY = e.y;
      if (e.x > maxX) maxX = e.x;
      if (e.y > maxY) maxY = e.y;
    }
  }
  const bounds = { minX, minY, maxX, maxY };

  const grid = buildGrid(pos);
  const curb = TRACK.curbWidth;
  const trackLength = length;

  const at = (s: number): TrackSample => {
    const wrapped = wrap(s, trackLength);
    const i = Math.floor(wrapped / step) % n;
    const t = wrapped / step - Math.floor(wrapped / step);
    const j = (i + 1) % n;
    const a = samples[i] as TrackSample;
    const b = samples[j] as TrackSample;
    const x = a.pos.x + (b.pos.x - a.pos.x) * t;
    const y = a.pos.y + (b.pos.y - a.pos.y) * t;
    let dx = a.dir.x + (b.dir.x - a.dir.x) * t;
    let dy = a.dir.y + (b.dir.y - a.dir.y) * t;
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    return {
      pos: { x, y },
      dir: { x: dx, y: dy },
      normal: { x: dy, y: -dx },
      curvature: a.curvature + (b.curvature - a.curvature) * t,
      width: a.width + (b.width - a.width) * t,
      s: wrapped,
    };
  };

  const query = (p: Vec2): TrackQuery => {
    const nearest = nearestSampleIndex(grid, pos, p);
    let bestD2 = Infinity;
    let bestSeg = nearest;
    let bestT = 0;
    for (let d = -2; d <= 2; d++) {
      const i = wrap(nearest + d, n);
      const a = samples[i] as TrackSample;
      const b = samples[(i + 1) % n] as TrackSample;
      const abx = b.pos.x - a.pos.x;
      const aby = b.pos.y - a.pos.y;
      const l2 = abx * abx + aby * aby;
      let t = 0;
      if (l2 > 1e-9) {
        t = ((p.x - a.pos.x) * abx + (p.y - a.pos.y) * aby) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      const cx = a.pos.x + abx * t;
      const cy = a.pos.y + aby * t;
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestSeg = i;
        bestT = t;
      }
    }
    const a = samples[bestSeg] as TrackSample;
    const b = samples[(bestSeg + 1) % n] as TrackSample;
    let dx = a.dir.x + (b.dir.x - a.dir.x) * bestT;
    let dy = a.dir.y + (b.dir.y - a.dir.y) * bestT;
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    const nx = dy;
    const ny = -dx;
    const width = a.width + (b.width - a.width) * bestT;
    const curvature = a.curvature + (b.curvature - a.curvature) * bestT;
    const center = {
      x: a.pos.x + (b.pos.x - a.pos.x) * bestT,
      y: a.pos.y + (b.pos.y - a.pos.y) * bestT,
    };
    const lateral = (p.x - center.x) * nx + (p.y - center.y) * ny;
    const absLat = Math.abs(lateral);
    let surface: Surface;
    if (absLat <= width / 2) surface = absLat <= width / 2 - curb ? 'road' : 'curb';
    else surface = 'grass';
    const radius = Math.abs(curvature) > 1e-7 ? 1 / Math.abs(curvature) : Number.POSITIVE_INFINITY;
    return {
      index: nearest,
      s: wrap(((bestSeg + bestT) % n) * step, trackLength),
      lateral,
      center,
      dir: { x: dx, y: dy },
      normal: { x: nx, y: ny },
      width,
      surface,
      onRoad: Math.abs(lateral) <= width / 2,
      radius,
    };
  };

  const deltaS = (a: number, b: number): number => {
    let d = (b - a) % trackLength;
    if (d > trackLength / 2) d -= trackLength;
    if (d <= -trackLength / 2) d += trackLength;
    return d;
  };

  const track: Track = {
    seed,
    style,
    name: makeName(seed, style),
    samples,
    length: trackLength,
    step,
    startIndex: 0,
    startLine: {
      a: { x: (leftEdge[0] as Vec2).x, y: (leftEdge[0] as Vec2).y },
      b: { x: (rightEdge[0] as Vec2).x, y: (rightEdge[0] as Vec2).y },
      dir: { x: (dirs[0] as Vec2).x, y: (dirs[0] as Vec2).y },
    },
    bounds,
    leftEdge,
    rightEdge,
    racingLine,
    query,
    at,
    posAt: (s: number) => at(s).pos,
    deltaS,
  };
  return track;
}


function makeName(seed: number, style: ConcreteStyle): string {
  const rng = mulberry32((seed ^ hashString(`name:${style}`)) >>> 0);
  const adjectives = NAME_ADJECTIVES[style];
  const adjective = adjectives[Math.floor(rng() * adjectives.length) % adjectives.length] as string;
  const noun = NAME_NOUNS[Math.floor(rng() * NAME_NOUNS.length) % NAME_NOUNS.length] as string;
  return `${adjective} ${noun}`;
}

/* ------------------------------------------------------------------ public -- */

export function generateTrack(seed: number, style: TrackStyle): Track {
  const concreteStyle = resolveStyle(seed, style);
  const params = styleParams(concreteStyle);
  let rng = mulberry32((seed ^ hashString(`track:${concreteStyle}`)) >>> 0);
  let chosen: LoopBuild | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const jitterScale = attempt === 0 ? 1 : Math.max(0.28, 1 / (1 + attempt * 1.1));
    const candidate = buildLoop(rng, concreteStyle, jitterScale);
    rng = mulberry32((seed ^ hashString(`track:${concreteStyle}:${attempt}`)) >>> 0);
    const fitsField = insideField(candidate.points, candidate.kappa, params.widthBias);
    const radiusOk = satisfiesMinRadius(candidate.kappa, TRACK.minRadius);
    if (fitsField && radiusOk && isSimpleLoop(candidate.points)) {
      chosen = candidate;
      break;
    }
  }

  if (!chosen) {
    // Deterministic last resort: a perfect (and therefore guaranteed valid) ring.
    const radius = TRACK.fieldSize * 0.27;
    const points: Vec2[] = [];
    const count = Math.round((TAU * radius) / TRACK.sampleStep);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU;
      points.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
    }
    const step = (TAU * radius) / count;
    chosen = {
      points,
      step,
      length: TAU * radius,
      kappa: new Array<number>(count).fill(1 / radius),
    };
  }

  return finalizeTrack(seed, concreteStyle, {
    points: chosen.points,
    step: chosen.step,
    kappa: chosen.kappa,
  });
}

/**
 * Compute the racing-line lateral offset at a given sample index (helper for the
 * simulation modules: AI line following and respawn placement).
 */
export function racingLineOffset(track: Track, index: number): number {
  const n = track.samples.length;
  const i = wrap(Math.round(index), n);
  const sample = track.samples[i] as TrackSample;
  const line = track.racingLine[i] as Vec2;
  return (line.x - sample.pos.x) * sample.normal.x + (line.y - sample.pos.y) * sample.normal.y;
}

/** Lateral offset of the racing line at an arc length `s`. */
export function racingLineLateralAt(track: Track, s: number): number {
  const n = track.samples.length;
  const i = wrap(Math.floor(wrap(s, track.length) / track.step), n);
  return racingLineOffset(track, i);
}
