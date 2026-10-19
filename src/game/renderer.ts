/**
 * NEON RACER — Canvas 2D presentation layer.  OWNER: render-dev.
 *
 * Frozen contract:
 *   export function createRenderer(canvas: HTMLCanvasElement): Renderer
 *   export function drawAttract(ctx: CanvasRenderingContext2D, scene: AttractScene): void
 *   export interface AttractScene
 *
 * Design
 *  - per-Track cache (built once, keyed by Track identity) holding flattened
 *    Float32Array geometry, per-sample AABBs for culling, pylon positions and a
 *    pre-rendered "apron" bitmap (shoulder band + neon halo around the circuit),
 *  - per frame the visible sample runs are found with the AABBs, then the whole
 *    track detail pass (asphalt band, kerbs, edge lines, centre dashes, start
 *    line, barrier glow, pylons) is stroked as a handful of batched paths, so
 *    everything stays crisp at any zoom without rebuilding paths per sample,
 *  - cars are drawn procedurally (shadow, body, cockpit, wheels turned by
 *    `car.steer`, wings, headlights, brake lights, boost flame, name tag),
 *  - screen-space pass: vignette, scanlines, impact flash, debug overlay.
 */

import { CAMERA, carClassOf, COLORS, TRACK } from './config';
import { viewBounds, type Bounds } from './camera';
import { drawEffects } from './effects';
import { clamp, clamp01, mulberry32, TAU } from './math';
import type { CarClass, Racer, Renderer, Scene, Track } from './types';

export interface AttractScene {
  width: number;
  height: number;
  dpr: number;
  time: number;
  track: Track;
}

/* ------------------------------------------------------------- constants -- */

const RUN_MAX = 192;
const DILATE = 7;
/** samples per culling block (conservative bounds per block) */
const CULL_BLOCK = 32;
const GRID_SPACING = 240;
const MAX_APRON = 1024;
const APRON_BUDGET = 1.6e6;
/** how many distinct pre-rendered aprons to keep (same seed/style reuses one) */
const APRON_CACHE_MAX = 2;
const NAME_TAG_ZOOM = 0.42;

/* ---------------------------------------------------------- small utils -- */

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) * 0.5));
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const colorCache = new Map<string, Rgb>();

/**
 * Accepts "#rrggbb" and the "rgb(r,g,b)" that shade() returns — shading a shaded
 * colour has to keep its hue, not fall back to white.
 */
function toRgb(color: string): Rgb {
  const hit = colorCache.get(color);
  if (hit) return hit;
  let r = 255;
  let g = 255;
  let b = 255;
  if (color.charCodeAt(0) === 35 && color.length >= 7) {
    r = parseInt(color.slice(1, 3), 16);
    g = parseInt(color.slice(3, 5), 16);
    b = parseInt(color.slice(5, 7), 16);
    if (!Number.isFinite(r)) r = 255;
    if (!Number.isFinite(g)) g = 255;
    if (!Number.isFinite(b)) b = 255;
  } else if (color.charCodeAt(0) === 114 /* r */) {
    const parts = color.slice(color.indexOf('(') + 1, color.indexOf(')')).split(',');
    r = Number(parts[0]);
    g = Number(parts[1]);
    b = Number(parts[2]);
    if (!Number.isFinite(r)) r = 255;
    if (!Number.isFinite(g)) g = 255;
    if (!Number.isFinite(b)) b = 255;
  }
  const v = { r, g, b };
  colorCache.set(color, v);
  return v;
}

// Colour strings are memoised on quantised (colour, amount) pairs: cars need a
// handful of shades each frame and rebuilding the strings showed up as GC churn.
const shadeCache = new Map<string, string>();
const rgbaCache = new Map<string, string>();

/** amount > 0 lightens toward white, < 0 darkens toward black. */
function shade(hex: string, amount: number): string {
  const t = clamp(amount, -1, 1);
  const key = `${hex}|${(t * 100) | 0}`;
  const hit = shadeCache.get(key);
  if (hit !== undefined) return hit;
  const { r, g, b } = toRgb(hex);
  const mix = (c: number): number => Math.round(t >= 0 ? c + (255 - c) * t : c * (1 + t));
  const out = `rgb(${mix(r)},${mix(g)},${mix(b)})`;
  shadeCache.set(key, out);
  return out;
}

function rgba(hex: string, a: number): string {
  const q = a <= 0 ? 0 : a >= 1 ? 1 : Math.round(a * 100) / 100;
  const key = `${hex}|${q}`;
  const hit = rgbaCache.get(key);
  if (hit !== undefined) return hit;
  const { r, g, b } = toRgb(hex);
  const out = `rgba(${r},${g},${b},${q})`;
  rgbaCache.set(key, out);
  return out;
}

function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Alpha multiplier for world-space labels so they never fight the DOM HUD:
 * the bottom-centre band holds the speed readout, the top-centre band the lap
 * timer / countdown. Labels fade out inside those two rectangles.
 */
function hudTagAlpha(sx: number, sy: number, w: number, h: number): number {
  const centre = 1 - clamp01((Math.abs(sx - w * 0.5) / (w * 0.5) - 0.3) / 0.16);
  if (centre <= 0) return 1;
  const bottom = clamp01((sy - h * 0.76) / (h * 0.07));
  const top = clamp01((h * 0.15 - sy) / (h * 0.07));
  const band = Math.max(bottom, top);
  return 1 - band * centre * 0.94;
}

/* --------------------------------------------------------- track geometry -- */

interface TrackCache {
  track: Track;
  n: number;
  step: number;
  // flattened x,y pairs
  el: Float32Array; // asphalt left edge
  er: Float32Array; // asphalt right edge
  cl: Float32Array; // kerb centre, left
  cr: Float32Array; // kerb centre, right
  wl: Float32Array; // white line, left
  wr: Float32Array; // white line, right
  bl: Float32Array; // barrier, left
  br: Float32Array; // barrier, right
  ctr: Float32Array; // centreline
  rl: Float32Array; // racing line
  bbox: Float32Array; // n * 4 AABB of the whole road cross-section
  /** conservative AABB per CULL_BLOCK samples, so the per-frame scan only
   *  touches samples near the view instead of all of them */
  blockBounds: Float32Array;
  blockVis: Uint8Array;
  blockCount: number;
  px: Float32Array; // pylons
  py: Float32Array;
  pylonCount: number;
  maxWidth: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  startX0: number;
  startY0: number;
  startX1: number;
  startY1: number;
  startNX: number;
  startNY: number;
  startDX: number;
  startDY: number;
  startS: number;
  apron: HTMLCanvasElement | null;
  apronScale: number;
  originX: number;
  originY: number;
  worldW: number;
  worldH: number;
  vis: Uint8Array;
  runs: Int32Array;
  runCount: number;
}

function buildCache(track: Track): TrackCache {
  const samples = track.samples ?? [];
  const n = Math.max(0, Math.min(samples.length, track.leftEdge?.length ?? 0, track.rightEdge?.length ?? 0));
  const el = new Float32Array(n * 2);
  const er = new Float32Array(n * 2);
  const cl = new Float32Array(n * 2);
  const cr = new Float32Array(n * 2);
  const wl = new Float32Array(n * 2);
  const wr = new Float32Array(n * 2);
  const bl = new Float32Array(n * 2);
  const br = new Float32Array(n * 2);
  const ctr = new Float32Array(n * 2);
  const rl = new Float32Array(n * 2);
  const bbox = new Float32Array(n * 4);
  let maxWidth = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const curbW = TRACK.curbWidth;
  const runoff = TRACK.runoff;
  const lineInset = curbW + 3.2;

  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const lx = track.leftEdge[i].x;
    const ly = track.leftEdge[i].y;
    const rx = track.rightEdge[i].x;
    const ry = track.rightEdge[i].y;
    const nx = s.normal.x;
    const ny = s.normal.y;
    const w = s.width;
    if (w > maxWidth) maxWidth = w;
    const o = i * 2;
    el[o] = lx;
    el[o + 1] = ly;
    er[o] = rx;
    er[o + 1] = ry;
    cl[o] = lx - nx * (curbW * 0.5);
    cl[o + 1] = ly - ny * (curbW * 0.5);
    cr[o] = rx + nx * (curbW * 0.5);
    cr[o + 1] = ry + ny * (curbW * 0.5);
    wl[o] = lx - nx * lineInset;
    wl[o + 1] = ly - ny * lineInset;
    wr[o] = rx + nx * lineInset;
    wr[o + 1] = ry + ny * lineInset;
    bl[o] = lx + nx * runoff;
    bl[o + 1] = ly + ny * runoff;
    br[o] = rx - nx * runoff;
    br[o + 1] = ry - ny * runoff;
    const cxp = s.pos.x;
    const cyp = s.pos.y;
    ctr[o] = cxp;
    ctr[o + 1] = cyp;
    const rp = track.racingLine?.[i] ?? s.pos;
    rl[o] = rp.x;
    rl[o + 1] = rp.y;
    const b = i * 4;
    const x0 = Math.min(lx, rx, bl[o], br[o]);
    const x1 = Math.max(lx, rx, bl[o], br[o]);
    const y0 = Math.min(ly, ry, bl[o + 1], br[o + 1]);
    const y1 = Math.max(ly, ry, bl[o + 1], br[o + 1]);
    bbox[b] = x0;
    bbox[b + 1] = y0;
    bbox[b + 2] = x1;
    bbox[b + 3] = y1;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  }

  const blockCount = Math.ceil(n / CULL_BLOCK);
  const blockBounds = new Float32Array(Math.max(1, blockCount) * 4);
  for (let b = 0; b < blockCount; b++) {
    const i0 = b * CULL_BLOCK;
    const i1 = Math.min(n, i0 + CULL_BLOCK);
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    for (let i = i0; i < i1; i++) {
      const o = i * 4;
      if ((bbox[o] as number) < bx0) bx0 = bbox[o] as number;
      if ((bbox[o + 1] as number) < by0) by0 = bbox[o + 1] as number;
      if ((bbox[o + 2] as number) > bx1) bx1 = bbox[o + 2] as number;
      if ((bbox[o + 3] as number) > by1) by1 = bbox[o + 3] as number;
    }
    blockBounds[b * 4] = bx0;
    blockBounds[b * 4 + 1] = by0;
    blockBounds[b * 4 + 2] = bx1;
    blockBounds[b * 4 + 3] = by1;
  }

  if (n === 0) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
    maxWidth = 120;
  }

  // start/finish line (tolerate a degenerate startLine, which placeholders had)
  let startX0 = 0;
  let startY0 = 0;
  let startX1 = 0;
  let startY1 = 0;
  let startDX = 1;
  let startDY = 0;
  let startS = 0;
  const si = Math.max(0, Math.min(n - 1, track.startIndex | 0));
  const ss = n > 0 ? samples[si] : null;
  if (track.startLine) {
    startX0 = track.startLine.a.x;
    startY0 = track.startLine.a.y;
    startX1 = track.startLine.b.x;
    startY1 = track.startLine.b.y;
    startDX = track.startLine.dir.x;
    startDY = track.startLine.dir.y;
  }
  if (ss && Math.hypot(startX1 - startX0, startY1 - startY0) < 4) {
    const half = ss.width * 0.5;
    startX0 = ss.pos.x + ss.normal.x * half;
    startY0 = ss.pos.y + ss.normal.y * half;
    startX1 = ss.pos.x - ss.normal.x * half;
    startY1 = ss.pos.y - ss.normal.y * half;
    startDX = ss.dir.x;
    startDY = ss.dir.y;
  }
  startS = ss ? ss.s : 0;
  const dLen = Math.hypot(startDX, startDY) || 1;
  startDX /= dLen;
  startDY /= dLen;

  // pylons along the barrier, alternating sides, every 9 samples
  const pylonStep = 9;
  const pylonCount = n > 0 ? Math.floor(n / pylonStep) : 0;
  const px = new Float32Array(pylonCount);
  const py = new Float32Array(pylonCount);
  for (let k = 0; k < pylonCount; k++) {
    const i = (k * pylonStep) % n;
    const left = (k & 1) === 0;
    px[k] = left ? bl[i * 2] : br[i * 2];
    py[k] = left ? bl[i * 2 + 1] : br[i * 2 + 1];
  }

  const cache: TrackCache = {
    track,
    n,
    step: track.step || TRACK.sampleStep,
    el,
    er,
    cl,
    cr,
    wl,
    wr,
    bl,
    br,
    ctr,
    rl,
    bbox,
    px,
    py,
    pylonCount,
    maxWidth,
    minX,
    minY,
    maxX,
    maxY,
    startX0,
    startY0,
    startX1,
    startY1,
    startNX: 0,
    startNY: 0,
    startDX,
    startDY,
    startS,
    apron: null,
    apronScale: 1,
    originX: 0,
    originY: 0,
    worldW: 0,
    worldH: 0,
    blockBounds,
    blockVis: new Uint8Array(Math.max(1, blockCount)),
    blockCount,
    vis: new Uint8Array(Math.max(1, n)),
    runs: new Int32Array(RUN_MAX * 2),
    runCount: 0,
  };

  // normal for the start line (used to lay the chequer rows)
  if (ss) {
    cache.startNX = ss.normal.x;
    cache.startNY = ss.normal.y;
  }
  buildApron(cache);
  return cache;
}

/**
 * Aprons are keyed by track content, not object identity: `generateTrack` is
 * deterministic, so re-running the same seed/style reuses the bitmap instead of
 * re-rasterising it on the first frame of the next race.
 */
const apronCache = new Map<string, { canvas: HTMLCanvasElement; scale: number; originX: number; originY: number }>();

function apronKey(track: Track): string {
  return `${track.seed}|${track.style}|${track.samples.length}|${Math.round(track.length)}`;
}

/**
 * Pre-render the low-frequency parts of the circuit once per Track: ambient
 * halo, shoulder band, asphalt with grain, worn groove and the barrier bloom.
 * The per-frame pass then only has to stroke crisp detail on top of one blit.
 *
 * This runs inside the first frame after a race starts, so it is deliberately
 * cheap: reduced-resolution bitmap, band fills instead of per-speckle rects and
 * a cached result for repeated tracks.
 */
function buildApron(cache: TrackCache): void {
  if (typeof document === 'undefined' || cache.n < 3) return;
  const margin = cache.maxWidth * 0.5 + TRACK.runoff + 200;
  const minX = cache.minX - margin;
  const minY = cache.minY - margin;
  const worldW = Math.max(1, cache.maxX - cache.minX + margin * 2);
  const worldH = Math.max(1, cache.maxY - cache.minY + margin * 2);
  const scale = clamp(
    Math.min(0.62, MAX_APRON / worldW, MAX_APRON / worldH, Math.sqrt(APRON_BUDGET / (worldW * worldH))),
    0.06,
    0.62,
  );

  cache.apronScale = scale;
  cache.originX = minX;
  cache.originY = minY;
  cache.worldW = worldW;
  cache.worldH = worldH;

  const key = apronKey(cache.track);
  const hit = apronCache.get(key);
  if (hit && hit.scale === scale && hit.originX === minX && hit.originY === minY) {
    cache.apron = hit.canvas;
    return;
  }

  const cw = Math.max(2, Math.ceil(worldW * scale));
  const ch = Math.max(2, Math.ceil(worldH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const n = cache.n;

  // 1) wide ambient halo so the circuit glows in the void
  strokeClosed(g, cache.ctr, n);
  g.strokeStyle = 'rgba(58,74,255,0.05)';
  g.lineWidth = cache.maxWidth + TRACK.runoff * 2 + 420;
  g.stroke();
  g.strokeStyle = 'rgba(0,190,255,0.045)';
  g.lineWidth = cache.maxWidth + TRACK.runoff * 2 + 170;
  g.stroke();

  // 2) shoulder band between the asphalt edge and the barrier
  bandPath(g, cache.bl, cache.br, cache);
  g.fillStyle = 'rgba(11,18,38,0.96)';
  g.fill();

  // 3) asphalt band
  bandPath(g, cache.el, cache.er, cache);
  g.fillStyle = COLORS.asphalt;
  g.fill();

  // 4) asphalt grain: one (well, two) pattern fills instead of ~18k clipped
  //    rects — this used to be 90% of the whole build.
  const pat = noisePattern(g);
  if (pat) {
    g.save();
    g.globalAlpha = 0.55;
    g.fillStyle = pat;
    bandPath(g, cache.el, cache.er, cache);
    g.fill();
    g.translate(37, 61); // shift the lattice so the second pass adds new grain
    bandPath(g, cache.el, cache.er, cache);
    g.fill();
    g.restore();
  }

  // worn racing groove
  strokeClosed(g, cache.rl, n);
  g.strokeStyle = 'rgba(206,228,255,0.05)';
  g.lineWidth = cache.maxWidth * 0.6;
  g.stroke();
  // darker edge falloff inside the asphalt
  strokeClosed(g, cache.el, n);
  g.strokeStyle = 'rgba(0,0,0,0.22)';
  g.lineWidth = 9;
  g.stroke();
  strokeClosed(g, cache.er, n);
  g.stroke();

  // 5) barrier bloom (baked: the per-frame pass only needs thin crisp lines)
  for (let side = 0; side < 2; side++) {
    const arr = side === 0 ? cache.bl : cache.br;
    strokeClosed(g, arr, n);
    g.strokeStyle = 'rgba(26,104,255,0.17)';
    g.lineWidth = 52;
    g.stroke();
    g.strokeStyle = 'rgba(40,214,255,0.24)';
    g.lineWidth = 18;
    g.stroke();
  }

  cache.apron = canvas;
  apronCache.set(key, { canvas, scale, originX: minX, originY: minY });
  if (apronCache.size > APRON_CACHE_MAX) {
    const oldest = apronCache.keys().next().value;
    if (oldest !== undefined) apronCache.delete(oldest);
  }
}

function strokeClosed(ctx: CanvasRenderingContext2D, arr: Float32Array, n: number): void {
  ctx.beginPath();
  ctx.moveTo(arr[0] as number, arr[1] as number);
  for (let i = 1; i < n; i++) ctx.lineTo(arr[i * 2] as number, arr[i * 2 + 1] as number);
  ctx.closePath();
}

/** Polygon between two index-aligned edge arrays (forward, then backward). */
function bandPath(ctx: CanvasRenderingContext2D, left: Float32Array, right: Float32Array, cache: TrackCache): void {
  const n = cache.n;
  if (n < 2) return;
  ctx.beginPath();
  ctx.moveTo(left[0] as number, left[1] as number);
  for (let i = 1; i < n; i++) ctx.lineTo(left[i * 2] as number, left[i * 2 + 1] as number);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(right[i * 2] as number, right[i * 2 + 1] as number);
  ctx.closePath();
}

/* ------------------------------------------------------------- culling --- */

function computeRuns(cache: TrackCache, b: Bounds): void {
  const n = cache.n;
  const runs = cache.runs;
  cache.runCount = 0;
  if (n < 2) return;
  const vis = cache.vis;
  const bbox = cache.bbox;
  const blockBounds = cache.blockBounds;
  const blockVis = cache.blockVis;
  vis.fill(0);
  let visible = 0;
  // coarse pass: which blocks of CULL_BLOCK samples could touch the view?
  const blocks = cache.blockCount;
  blockVis.fill(0);
  let anyBlock = false;
  for (let blk = 0; blk < blocks; blk++) {
    const o = blk * 4;
    if (
      (blockBounds[o] as number) <= b.maxX &&
      (blockBounds[o + 2] as number) >= b.minX &&
      (blockBounds[o + 1] as number) <= b.maxY &&
      (blockBounds[o + 3] as number) >= b.minY
    ) {
      blockVis[blk] = 1;
      anyBlock = true;
    }
  }
  if (!anyBlock) return;
  // fine pass: only samples whose block survived
  for (let blk = 0; blk < blocks; blk++) {
    if (!blockVis[blk]) continue;
    const i0 = blk * CULL_BLOCK;
    const i1 = Math.min(n, i0 + CULL_BLOCK);
    for (let i = i0; i < i1; i++) {
      const o = i * 4;
      if (
        (bbox[o] as number) <= b.maxX &&
        (bbox[o + 2] as number) >= b.minX &&
        (bbox[o + 1] as number) <= b.maxY &&
        (bbox[o + 3] as number) >= b.minY
      ) {
        vis[i] = 1;
        visible++;
      }
    }
  }
  if (visible === 0) return;
  // walk from the first invisible sample so runs never straddle the array end
  let firstClear = -1;
  for (let i = 0; i < n; i++) {
    if (!vis[i]) {
      firstClear = i;
      break;
    }
  }
  if (firstClear < 0) {
    runs[0] = 0;
    runs[1] = n;
    cache.runCount = 1;
    return;
  }
  let idx = firstClear + 1 >= n ? 0 : firstClear + 1;
  let left = n;
  let count = 0;
  while (left > 0 && count < RUN_MAX) {
    while (left > 0 && !vis[idx]) {
      idx++;
      if (idx >= n) idx = 0;
      left--;
    }
    if (left === 0) break;
    const start = idx;
    let len = 0;
    while (left > 0 && vis[idx]) {
      idx++;
      if (idx >= n) idx = 0;
      left--;
      len++;
    }
    runs[count * 2] = start;
    runs[count * 2 + 1] = len;
    count++;
  }
  // Extend every run by DILATE samples so strokes/polygons run past the screen
  // edge (this is what the old mask dilation was for, at O(visible * DILATE)
  // cost every frame; extending the emitted runs is O(runs)).
  for (let r = 0; r < count; r++) {
    const start = runs[r * 2] as number;
    const len = runs[r * 2 + 1] as number;
    let s0 = start - DILATE;
    while (s0 < 0) s0 += n;
    runs[r * 2] = s0 % n;
    runs[r * 2 + 1] = Math.min(n, len + DILATE * 2);
  }
  cache.runCount = count;
}

function beginEdgePath(ctx: CanvasRenderingContext2D, arr: Float32Array, cache: TrackCache): void {
  const n = cache.n;
  const runs = cache.runs;
  ctx.beginPath();
  for (let r = 0; r < cache.runCount; r++) {
    const start = runs[r * 2] as number;
    const count = runs[r * 2 + 1] as number;
    let idx = start;
    ctx.moveTo(arr[idx * 2] as number, arr[idx * 2 + 1] as number);
    for (let k = 1; k < count; k++) {
      idx++;
      if (idx >= n) idx = 0;
      ctx.lineTo(arr[idx * 2] as number, arr[idx * 2 + 1] as number);
    }
  }
}

function beginBandPath(
  ctx: CanvasRenderingContext2D,
  left: Float32Array,
  right: Float32Array,
  cache: TrackCache,
): void {
  const n = cache.n;
  const runs = cache.runs;
  ctx.beginPath();
  for (let r = 0; r < cache.runCount; r++) {
    const start = runs[r * 2] as number;
    const count = runs[r * 2 + 1] as number;
    let idx = start;
    ctx.moveTo(left[idx * 2] as number, left[idx * 2 + 1] as number);
    for (let k = 1; k < count; k++) {
      idx++;
      if (idx >= n) idx = 0;
      ctx.lineTo(left[idx * 2] as number, left[idx * 2 + 1] as number);
    }
    for (let k = 0; k < count; k++) {
      ctx.lineTo(right[idx * 2] as number, right[idx * 2 + 1] as number);
      idx--;
      if (idx < 0) idx = n - 1;
    }
    ctx.closePath();
  }
}

/* ------------------------------------------------------------ noise tile -- */

let noiseTile: HTMLCanvasElement | null = null;
const patternCache = new WeakMap<CanvasRenderingContext2D, CanvasPattern | null>();

function noisePattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  let p = patternCache.get(ctx);
  if (p !== undefined) return p;
  if (typeof document === 'undefined') {
    patternCache.set(ctx, null);
    return null;
  }
  if (!noiseTile) {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    if (!g) return null;
    const rng = mulberry32(0xa5f00d);
    for (let i = 0; i < 2400; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const light = rng() < 0.45;
      const a = 0.02 + rng() * 0.055;
      g.fillStyle = light ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.6})`;
      const w = rng() < 0.75 ? 1 : 2;
      g.fillRect(Math.round(x), Math.round(y), w, 1);
    }
    // a couple of long faint streaks per tile
    for (let i = 0; i < 26; i++) {
      const y = rng() * size;
      g.strokeStyle = `rgba(0,0,0,${0.03 + rng() * 0.05})`;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, Math.round(y));
      g.lineTo(size, Math.round(y + (rng() - 0.5) * 10));
      g.stroke();
    }
    noiseTile = c;
  }
  p = ctx.createPattern(noiseTile, 'repeat');
  patternCache.set(ctx, p);
  return p;
}

/* --------------------------------------------------------- track drawing -- */

function drawVoidGrid(
  ctx: CanvasRenderingContext2D,
  b: Bounds,
  zoom: number,
  time: number,
  ox = 0,
  oy = 0,
): void {
  // ox/oy shift the lattice itself: the far background layer is drawn offset
  // from the track by the chase parallax (this is the 2D stand-in for the low
  // camera angle). Shifting the phase instead of the context keeps the
  // per-frame culling bounds exact and allocation free.
  let sp = GRID_SPACING;
  const spanX = b.maxX - b.minX;
  if (spanX / sp > 90) sp *= 4;
  const x0 = Math.floor((b.minX - ox) / sp) * sp + ox;
  const x1 = Math.ceil((b.maxX - ox) / sp) * sp + ox;
  const y0 = Math.floor((b.minY - oy) / sp) * sp + oy;
  const y1 = Math.ceil((b.maxY - oy) / sp) * sp + oy;
  const px = 1 / Math.max(0.05, zoom);
  ctx.lineWidth = px;
  ctx.strokeStyle = 'rgba(48,104,200,0.20)';
  ctx.beginPath();
  for (let x = x0; x <= x1; x += sp) {
    ctx.moveTo(x, b.minY);
    ctx.lineTo(x, b.maxY);
  }
  for (let y = y0; y <= y1; y += sp) {
    ctx.moveTo(b.minX, y);
    ctx.lineTo(b.maxX, y);
  }
  ctx.stroke();

  // major lines pulse slowly, drifting with time
  const major = sp * 4;
  const drift = (time * 26) % major;
  const mx0 = Math.floor((b.minX - ox - drift) / major) * major + drift + ox;
  const my0 = Math.floor((b.minY - oy - drift) / major) * major + drift + oy;
  ctx.strokeStyle = 'rgba(0,190,255,0.13)';
  ctx.lineWidth = px * 1.6;
  ctx.beginPath();
  for (let x = mx0; x <= b.maxX; x += major) {
    ctx.moveTo(x, b.minY);
    ctx.lineTo(x, b.maxY);
  }
  for (let y = my0; y <= b.maxY; y += major) {
    ctx.moveTo(b.minX, y);
    ctx.lineTo(b.maxX, y);
  }
  ctx.stroke();
}

function blitApron(ctx: CanvasRenderingContext2D, cache: TrackCache, b: Bounds): void {
  const img = cache.apron;
  if (!img) return;
  const s = cache.apronScale;
  const aw = img.width;
  const ah = img.height;
  let sx = (b.minX - cache.originX) * s;
  let sy = (b.minY - cache.originY) * s;
  let ex = (b.maxX - cache.originX) * s;
  let ey = (b.maxY - cache.originY) * s;
  if (ex <= 0 || ey <= 0 || sx >= aw || sy >= ah) return;
  if (sx < 0) sx = 0;
  if (sy < 0) sy = 0;
  if (ex > aw) ex = aw;
  if (ey > ah) ey = ah;
  const sw = ex - sx;
  const sh = ey - sy;
  if (sw <= 0 || sh <= 0) return;
  const smooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    img,
    sx,
    sy,
    sw,
    sh,
    cache.originX + sx / s,
    cache.originY + sy / s,
    sw / s,
    sh / s,
  );
  ctx.imageSmoothingEnabled = smooth;
}

function drawStartLine(ctx: CanvasRenderingContext2D, cache: TrackCache, b: Bounds): void {
  const x0 = cache.startX0;
  const y0 = cache.startY0;
  const x1 = cache.startX1;
  const y1 = cache.startY1;
  const lx = Math.min(x0, x1);
  const ly = Math.min(y0, y1);
  if (lx > b.maxX || ly > b.maxY) return;
  if (Math.max(x0, x1) < b.minX || Math.max(y0, y1) < b.minY) return;
  const spanX = x1 - x0;
  const spanY = y1 - y0;
  const span = Math.hypot(spanX, spanY);
  if (span < 8) return;
  const ux = spanX / span;
  const uy = spanY / span;
  const dx = cache.startDX;
  const dy = cache.startDY;
  const cols = clamp(Math.round(span / 14), 6, 20);
  const cell = span / cols;
  const rows = 3;
  const depth = cell * rows * 0.62;

  ctx.save();
  // soft glow bed
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = COLORS.hudCyan;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x1 - dx * depth * 1.4, y1 - dy * depth * 1.4);
  ctx.lineTo(x0 - dx * depth * 1.4, y0 - dy * depth * 1.4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const bright = ((r + c) & 1) === 0;
      ctx.fillStyle = bright ? COLORS.startLine : '#0a0f22';
      const ax = x0 + ux * cell * c - dx * depth * (r / rows);
      const ay = y0 + uy * cell * c - dy * depth * (r / rows);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax + ux * cell, ay + uy * cell);
      ctx.lineTo(ax + ux * cell - dx * (depth / rows), ay + uy * cell - dy * (depth / rows));
      ctx.lineTo(ax - dx * (depth / rows), ay - dy * (depth / rows));
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawTrackDetail(
  ctx: CanvasRenderingContext2D,
  cache: TrackCache,
  b: Bounds,
  zoom: number,
  time: number,
  quality: number,
): void {
  const n = cache.n;
  if (n < 3) return;
  computeRuns(cache, b);
  if (cache.runCount === 0) return;

  /* ------------------------------------------------------------ asphalt -- */
  // The apron already carries the asphalt, grain and groove at apron
  // resolution. Only when the camera is zoomed past ~1.0 do we repaint the band
  // crisply so the road edge never looks soft.
  const crisp = quality > 0 && zoom > 0.96;
  if (crisp) {
    beginBandPath(ctx, cache.el, cache.er, cache);
    ctx.fillStyle = COLORS.asphalt;
    ctx.fill();
  }

  if (crisp) {
    const pat = noisePattern(ctx);
    if (pat) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = pat;
      ctx.fill();
      ctx.restore();
    }
  }

  // worn racing groove
  if (crisp) {
    beginEdgePath(ctx, cache.rl, cache);
    ctx.strokeStyle = 'rgba(210,232,255,0.045)';
    ctx.lineWidth = cache.maxWidth * 0.55;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // asphalt edge shadow (inside the kerb band)
  ctx.lineCap = 'butt';
  beginEdgePath(ctx, cache.el, cache);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 5;
  ctx.stroke();
  beginEdgePath(ctx, cache.er, cache);
  ctx.stroke();

  /* --------------------------------------------------------------- kerbs -- */
  // Two offset dashed strokes produce the classic alternating red/white kerb
  // with 4 canvas calls instead of one quad per cell (which used to dominate
  // the per-frame command count).
  const cell = 24;
  ctx.lineCap = 'butt';
  ctx.setLineDash([cell, cell]);
  for (let side = 0; side < 2; side++) {
    const centre = side === 0 ? cache.cl : cache.cr;
    beginEdgePath(ctx, centre, cache);
    ctx.lineWidth = TRACK.curbWidth;
    ctx.lineDashOffset = 0;
    ctx.strokeStyle = 'rgba(255,46,99,0.92)';
    ctx.stroke();
    ctx.lineDashOffset = -cell;
    ctx.strokeStyle = 'rgba(240,246,255,0.95)';
    ctx.stroke();
  }
  ctx.setLineDash([]);

  /* ---------------------------------------------------------- edge lines -- */
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(238,244,255,0.85)';
  ctx.lineWidth = 3.2;
  beginEdgePath(ctx, cache.wl, cache);
  ctx.stroke();
  beginEdgePath(ctx, cache.wr, cache);
  ctx.stroke();

  /* --------------------------------------------------------- centre dash -- */
  beginEdgePath(ctx, cache.ctr, cache);
  ctx.setLineDash([26, 30]);
  ctx.lineDashOffset = -cache.startS;
  ctx.strokeStyle = 'rgba(238,244,255,0.22)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.setLineDash([]);

  drawStartLine(ctx, cache, b);

  /* ------------------------------------------------------------ barriers -- */
  for (let side = 0; side < 2; side++) {
    const arr = side === 0 ? cache.bl : cache.br;
    beginEdgePath(ctx, arr, cache);
    ctx.strokeStyle = 'rgba(18,24,48,0.95)';
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(40,220,255,0.26)';
    ctx.lineWidth = 9;
    ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(96,238,255,0.55)';
    ctx.lineWidth = 3.4;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(226,252,255,0.5)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }

  /* -------------------------------------------------------------- pylons -- */
  if (quality > 0 && zoom > 0.3 && cache.pylonCount > 0) {
    const glow = glowSprite(ctx, COLORS.hudCyan);
    const glowPink = glowSprite(ctx, COLORS.hudPink);
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.2);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < cache.pylonCount; i++) {
      const x = cache.px[i] as number;
      const y = cache.py[i] as number;
      if (x < b.minX - 40 || x > b.maxX + 40 || y < b.minY - 40 || y > b.maxY + 40) continue;
      const pink = (i & 1) === 0;
      const img = pink ? glowPink : glow;
      const size = (pink ? 54 : 46) * (0.85 + 0.25 * ((i * 7) % 5) / 5);
      ctx.globalAlpha = 0.3 + 0.2 * pulse * (pink ? 1 : 0.6);
      if (img) ctx.drawImage(img, x - size * 0.5, y - size * 0.5, size, size);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = pink ? '#ffd6e0' : '#dffcff';
      const d = 2.6 / Math.max(0.35, zoom);
      ctx.fillRect(x - d * 0.5, y - d * 0.5, d, d);
    }
    ctx.restore();
  }
}

/* --------------------------------------------------------------- sprites -- */

const glowCache = new Map<string, HTMLCanvasElement | null>();

/** Soft radial bloom sprite in a single colour (cached per colour). */
function glowSprite(ctx: CanvasRenderingContext2D, color: string): HTMLCanvasElement | null {
  void ctx;
  let img = glowCache.get(color);
  if (img !== undefined) return img;
  if (typeof document === 'undefined') {
    glowCache.set(color, null);
    return null;
  }
  const size = 96;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (!g) {
    glowCache.set(color, null);
    return null;
  }
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, rgba(color, 0.85));
  grad.addColorStop(0.35, rgba(color, 0.3));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  glowCache.set(color, c);
  return c;
}

/* ------------------------------------------------------------------ cars -- */

/**
 * Cars are pre-rendered once per (class, colour, accent) into offscreen
 * canvases and blitted with rotation; only the animated parts (wheels, lights,
 * flames, canopy sweep) are drawn per frame on top. That keeps 10 detailed cars
 * inside the frame budget without a single shadowBlur or per-frame gradient.
 */
const ART_SCALE = 2;

interface CarArt {
  canvas: HTMLCanvasElement;
  /** world size of the sprite canvas */
  w: number;
  h: number;
  cls: CarClass;
  /** canopy rectangle in car-local units (for the animated specular sweep) */
  cx: number;
  cy: number;
  cw: number;
  ch: number;
  /** exhaust nozzle positions, x,y pairs */
  exhaust: number[];
  frontW: number;
  frontL: number;
  rearW: number;
  rearL: number;
}

const carArtCache = new Map<string, CarArt | null>();
/** measured width per racer name (the font never changes) */
const nameWidthCache = new Map<string, number>();
const wheelCache = new Map<string, HTMLCanvasElement | null>();
let flameImg: HTMLCanvasElement | null | undefined;
let coneImg: HTMLCanvasElement | null | undefined;

function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  roundRectPath(g, x, y, w, h, r);
}

/** Static car body: hull, livery, canopy glass, wings, splitter, nozzles. */
function makeCarArt(racer: Racer): CarArt | null {
  if (typeof document === 'undefined') return null;
  const cls = carClassOf(racer.spec);
  const variant = ((racer.id | 0) % 3 + 3) % 3;
  const color = racer.color;
  const accent = racer.accent;
  const L = racer.spec.length;
  const W = racer.spec.width;
  const key = `${cls}|${variant}|${color}|${accent}|${L}|${W}`;
  const cached = carArtCache.get(key);
  if (cached !== undefined) return cached;

  const pad = 10;
  const w = L + pad * 2;
  const h = W + pad * 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(4, Math.ceil(w * ART_SCALE));
  canvas.height = Math.max(4, Math.ceil(h * ART_SCALE));
  const g = canvas.getContext('2d');
  if (!g) {
    carArtCache.set(key, null);
    return null;
  }
  g.setTransform(ART_SCALE, 0, 0, ART_SCALE, canvas.width * 0.5, canvas.height * 0.5);
  g.lineJoin = 'round';
  g.lineCap = 'round';

  const hx = L * 0.5;
  const hy = W * 0.5;
  const drifter = cls === 'drifter';
  const speedster = cls === 'speedster';
  const nose = speedster ? 3.4 : 0;
  const dark = shade(color, -0.55);
  const deep = shade(color, -0.78);

  /* ------------------------------------------------------------- hull --- */
  rrect(g, -hx - 1, -hy - 1, L + 2, W + 2, 8);
  g.fillStyle = '#03050c';
  g.fill();

  const hull = g.createLinearGradient(0, -hy, 0, hy);
  // Kept deliberately saturated: at ~40 px per car the body colour must read at
  // a glance, so the highlight stop is barely lighter than the livery itself.
  hull.addColorStop(0, shade(color, -0.04));
  hull.addColorStop(0.22, shade(color, -0.16));
  hull.addColorStop(0.6, shade(color, -0.46));
  hull.addColorStop(1, shade(color, -0.76));
  rrect(g, -hx, -hy, L, W, 7);
  g.fillStyle = hull;
  g.fill();

  // nose cone
  g.beginPath();
  g.moveTo(hx * 0.12, -hy);
  g.lineTo(hx - 4, -hy * 0.56);
  g.lineTo(hx + nose, -hy * 0.22);
  g.lineTo(hx + nose, hy * 0.22);
  g.lineTo(hx - 4, hy * 0.56);
  g.lineTo(hx * 0.12, hy);
  g.closePath();
  g.fillStyle = rgba(shade(color, 0.02), 0.95);
  g.fill();

  // side pods
  for (const sgn of [-1, 1]) {
    const py = sgn < 0 ? -hy + 0.6 : hy - 4.4;
    rrect(g, -hx * 0.46, py, hx * 1.2, 3.8, 1.8);
    g.fillStyle = rgba(dark, 0.95);
    g.fill();
    g.fillStyle = rgba(accent, 0.45);
    g.fillRect(-hx * 0.44, sgn < 0 ? py + 0.5 : py + 3.0, hx * 1.14, 0.5);
  }

  /* ----------------------------------------------------------- livery --- */
  // Livery stripes: a dark keyline under each accent band keeps them readable
  // on light and dark liveries alike.
  const stripe = (y: number, th: number, a: number, from = -hx * 0.62, len = L * 0.74): void => {
    g.fillStyle = 'rgba(4,6,14,0.6)';
    g.fillRect(from - 0.5, y - th * 0.5 - 0.6, len + 1, th + 1.2);
    g.fillStyle = rgba(shade(accent, -0.1), a);
    g.fillRect(from, y - th * 0.5, len, th);
  };
  if (drifter) {
    stripe(-2.9, 1.3, 0.9);
    stripe(2.9, 1.3, 0.9);
    stripe(0, 0.9, 0.35);
    for (const sgn of [-1, 1]) {
      g.beginPath();
      g.moveTo(-hx * 0.86, sgn * hy * 0.88);
      g.lineTo(-hx * 0.5, sgn * hy * 0.88);
      g.lineTo(-hx * 0.68, sgn * hy * 0.34);
      g.closePath();
      g.fillStyle = rgba(accent, 0.8);
      g.fill();
    }
  } else if (speedster) {
    stripe(0, 2.2, 0.92);
    g.beginPath();
    g.moveTo(hx * 0.3, -hy * 0.72);
    g.lineTo(hx + nose - 1, 0);
    g.lineTo(hx * 0.3, hy * 0.72);
    g.lineTo(hx * 0.14, 0);
    g.closePath();
    g.fillStyle = rgba(accent, 0.88);
    g.fill();
  } else if (variant === 1) {
    stripe(0, 2.4, 0.88);
    stripe(-hy * 0.62, 1.0, 0.5);
    stripe(hy * 0.62, 1.0, 0.5);
  } else if (variant === 2) {
    stripe(-3.2, 1.2, 0.85, -hx * 0.8, L * 0.62);
    stripe(3.2, 1.2, 0.85, -hx * 0.8, L * 0.62);
    g.fillStyle = rgba(accent, 0.75);
    g.beginPath();
    g.moveTo(hx * 0.62, -hy * 0.5);
    g.lineTo(hx - 1, 0);
    g.lineTo(hx * 0.62, hy * 0.5);
    g.closePath();
    g.fill();
  } else {
    stripe(-3.0, 1.2, 0.88);
    stripe(3.0, 1.2, 0.88);
    stripe(0, 1.0, 0.35);
  }

  /* ------------------------------------------------------ glass canopy --- */
  const cw = L * 0.34;
  const ch = W * 0.54;
  const cx0 = -L * 0.1;
  const cy0 = -ch * 0.5;
  // roll hoop + intake behind the canopy
  rrect(g, cx0 - 4.4, -hy * 0.62, 3.6, W * 0.62, 1.4);
  g.fillStyle = rgba(deep, 0.98);
  g.fill();
  g.fillStyle = rgba(accent, 0.75);
  g.fillRect(cx0 - 4.4, -hy * 0.62, 3.6, 0.9);
  g.fillStyle = '#05070e';
  g.beginPath();
  g.moveTo(cx0 - 3.2, -hy * 0.42);
  g.lineTo(cx0 - 1.2, 0);
  g.lineTo(cx0 - 3.2, hy * 0.42);
  g.closePath();
  g.fill();

  g.beginPath();
  roundRectPath(g, cx0, cy0, cw, ch, 4.2);
  const glass = g.createLinearGradient(0, cy0, 0, cy0 + ch);
  glass.addColorStop(0, 'rgba(112,172,228,0.92)');
  glass.addColorStop(0.3, 'rgba(16,28,58,0.97)');
  glass.addColorStop(1, 'rgba(4,7,16,0.99)');
  g.fillStyle = glass;
  g.fill();
  g.lineWidth = 1;
  g.strokeStyle = rgba(accent, 0.55);
  g.stroke();
  // windscreen highlight
  g.fillStyle = 'rgba(200,232,255,0.4)';
  g.fillRect(cx0 + cw * 0.5, cy0 + 1.6, cw * 0.3, 1.1);

  /* ------------------------------------------------------------ wings --- */
  const wingSpan = drifter ? W + 8.5 : W + 4;
  const wingX = -hx - 3.2;
  g.fillStyle = rgba(deep, 0.98);
  g.fillRect(wingX - 0.8, -wingSpan * 0.5 - 1.1, 6.6, wingSpan + 2.2);
  g.fillStyle = shade(accent, -0.42);
  g.fillRect(wingX, -wingSpan * 0.5, 4.4, wingSpan);
  g.fillStyle = rgba(accent, 0.85);
  g.fillRect(wingX - 0.6, -wingSpan * 0.5, 0.8, wingSpan);
  g.fillStyle = rgba(shade(accent, 0.25), 0.75);
  g.fillRect(wingX + 3.4, -wingSpan * 0.5, 1.0, wingSpan);

  // front splitter + canards
  g.fillStyle = rgba(deep, 0.98);
  rrect(g, hx - 3.4 + nose, -hy * 0.98, 4.6, W * 0.98, 1.2);
  g.fill();
  for (const sgn of [-1, 1]) {
    g.beginPath();
    g.moveTo(hx - 5 + nose, sgn * hy * 0.62);
    g.lineTo(hx - 8.6 + nose, sgn * (hy + 1.6));
    g.lineTo(hx - 10.4 + nose, sgn * hy * 0.62);
    g.closePath();
    g.fillStyle = rgba(accent, 0.85);
    g.fill();
  }

  /* --------------------------------------------------------- diffuser --- */
  const diffW = speedster ? W * 0.92 : W * 0.7;
  g.fillStyle = '#06090f';
  rrect(g, -hx - 1.4, -diffW * 0.5, 3.8, diffW, 1.2);
  g.fill();
  g.strokeStyle = rgba(accent, 0.35);
  g.lineWidth = 0.7;
  for (let i = 1; i < 4; i++) {
    const y = -diffW * 0.5 + (diffW * i) / 4;
    g.beginPath();
    g.moveTo(-hx - 1.2, y);
    g.lineTo(-hx + 2.2, y);
    g.stroke();
  }

  /* --------------------------------------------------------- nozzles ---- */
  const exhaust: number[] = [];
  const nozzles = speedster || drifter ? 2 : 1;
  if (nozzles === 2) {
    exhaust.push(-hx - 2.6, -W * 0.24, -hx - 2.6, W * 0.24);
  } else {
    exhaust.push(-hx - 2.6, 0);
  }
  for (let i = 0; i < exhaust.length; i += 2) {
    const ex = exhaust[i] as number;
    const ey = exhaust[i + 1] as number;
    rrect(g, ex - 1.2, ey - 1.7, 3.2, 3.4, 1.2);
    g.fillStyle = '#141a26';
    g.fill();
    g.strokeStyle = 'rgba(180,200,230,0.4)';
    g.lineWidth = 0.6;
    g.stroke();
  }

  // dark keyline + rim light: the outline is what makes a 40 px car read
  rrect(g, -hx, -hy, L, W, 7);
  g.strokeStyle = 'rgba(3,5,12,0.85)';
  g.lineWidth = 1.3;
  g.stroke();
  rrect(g, -hx + 0.8, -hy + 0.8, L - 1.6, W - 1.6, 6.4);
  g.strokeStyle = 'rgba(255,255,255,0.14)';
  g.lineWidth = 0.7;
  g.stroke();

  const art: CarArt = {
    canvas,
    w,
    h,
    cls,
    cx: cx0,
    cy: cy0,
    cw,
    ch,
    exhaust,
    frontW: 6.4,
    frontL: 12.4,
    rearW: drifter ? 7.9 : 6.9,
    rearL: drifter ? 13.6 : 12.8,
  };
  carArtCache.set(key, art);
  return art;
}

/** Tyre + spoked rim + brake disc, pre-rendered (front wheels turn with steer). */
function makeWheel(l: number, w: number, key: string): HTMLCanvasElement | null {
  const cached = wheelCache.get(key);
  if (cached !== undefined) return cached;
  if (typeof document === 'undefined') {
    wheelCache.set(key, null);
    return null;
  }
  const pad = 1.5;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(4, Math.ceil((l + pad * 2) * ART_SCALE));
  canvas.height = Math.max(4, Math.ceil((w + pad * 2) * ART_SCALE));
  const g = canvas.getContext('2d');
  if (!g) {
    wheelCache.set(key, null);
    return null;
  }
  g.setTransform(ART_SCALE, 0, 0, ART_SCALE, canvas.width * 0.5, canvas.height * 0.5);
  g.lineCap = 'round';
  // tyre
  rrect(g, -l * 0.5, -w * 0.5, l, w, w * 0.36);
  g.fillStyle = '#080b14';
  g.fill();
  g.strokeStyle = 'rgba(150,170,205,0.22)';
  g.lineWidth = 0.7;
  g.stroke();
  // tyre shoulders (a hint of sidewall so the wheel is not a flat box)
  rrect(g, -l * 0.5, -w * 0.5, l, w, w * 0.36);
  g.fillStyle = 'rgba(28,34,52,0.9)';
  g.fill();
  rrect(g, -l * 0.42, -w * 0.42, l * 0.84, w * 0.84, w * 0.3);
  g.fillStyle = '#05070d';
  g.fill();
  // rim: small, dark metal with a thin bright ring
  rrect(g, -l * 0.24, -w * 0.26, l * 0.48, w * 0.52, w * 0.2);
  g.fillStyle = 'rgba(96,108,132,0.95)';
  g.fill();
  rrect(g, -l * 0.19, -w * 0.2, l * 0.38, w * 0.4, w * 0.16);
  g.fillStyle = 'rgba(20,24,36,0.95)';
  g.fill();
  // spokes
  g.strokeStyle = 'rgba(178,196,224,0.45)';
  g.lineWidth = 0.7;
  for (let i = -1; i <= 1; i++) {
    g.beginPath();
    g.moveTo(-l * 0.17, i * w * 0.13);
    g.lineTo(l * 0.17, i * w * 0.13);
    g.stroke();
  }
  // brake disc peeking through
  g.beginPath();
  g.arc(0, 0, w * 0.13, 0, TAU);
  g.fillStyle = 'rgba(255,140,60,0.35)';
  g.fill();
  wheelCache.set(key, canvas);
  return canvas;
}

/** Twin-exhaust flame plume, drawn additively with a flicker. */
function flameSprite(): HTMLCanvasElement | null {
  if (flameImg !== undefined) return flameImg;
  if (typeof document === 'undefined') {
    flameImg = null;
    return null;
  }
  const w = 128;
  const h = 64;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) {
    flameImg = null;
    return null;
  }
  const plume = (len: number, halfW: number, stops: Array<[number, string]>): void => {
    const grad = g.createLinearGradient(0, 0, len, 0);
    for (const [at, col] of stops) grad.addColorStop(at, col);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, h * 0.5 - halfW);
    g.lineTo(len, h * 0.5);
    g.lineTo(0, h * 0.5 + halfW);
    g.closePath();
    g.fill();
  };
  plume(120, 26, [
    [0, 'rgba(255,80,190,0.55)'],
    [0.35, 'rgba(255,120,60,0.5)'],
    [1, 'rgba(255,60,160,0)'],
  ]);
  plume(92, 16, [
    [0, 'rgba(255,170,60,0.85)'],
    [0.5, 'rgba(255,120,40,0.5)'],
    [1, 'rgba(255,80,40,0)'],
  ]);
  plume(58, 8, [
    [0, 'rgba(255,252,235,0.98)'],
    [0.55, 'rgba(255,226,140,0.75)'],
    [1, 'rgba(255,180,80,0)'],
  ]);
  flameImg = c;
  return c;
}

/** Warm headlight cone with a soft falloff (narrow end at x = 0). */
function coneSprite(): HTMLCanvasElement | null {
  if (coneImg !== undefined) return coneImg;
  if (typeof document === 'undefined') {
    coneImg = null;
    return null;
  }
  const w = 160;
  const h = 128;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) {
    coneImg = null;
    return null;
  }
  const layers: Array<[number, number, number]> = [
    [w, h * 0.5, 0.5],
    [w * 0.8, h * 0.34, 0.5],
    [w * 0.55, h * 0.2, 0.65],
  ];
  for (const [len, halfW, alpha] of layers) {
    const grad = g.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, `rgba(255,244,205,${alpha})`);
    grad.addColorStop(0.45, `rgba(255,236,180,${alpha * 0.5})`);
    grad.addColorStop(1, 'rgba(255,225,160,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, h * 0.5 - halfW * 0.16);
    g.lineTo(len, h * 0.5 - halfW);
    g.lineTo(len, h * 0.5 + halfW);
    g.lineTo(0, h * 0.5 + halfW * 0.16);
    g.closePath();
    g.fill();
  }
  coneImg = c;
  return c;
}

function drawCarShadow(ctx: CanvasRenderingContext2D, racer: Racer): void {
  const car = racer.car;
  const L = racer.spec.length;
  const W = racer.spec.width;
  ctx.save();
  ctx.translate(car.pos.x + 3.5, car.pos.y + 5);
  ctx.rotate(car.angle);
  ctx.beginPath();
  roundRectPath(ctx, -L * 0.5, -W * 0.5, L, W, 7);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();
  ctx.restore();
}

function drawCar(
  ctx: CanvasRenderingContext2D,
  racer: Racer,
  time: number,
  zoom: number,
  showName: boolean,
  tagAlpha: number,
  camAngle: number,
  isPlayer: boolean,
): void {
  const car = racer.car;
  const L = racer.spec.length;
  const W = racer.spec.width;
  const hx = L * 0.5;
  const hy = W * 0.5;
  const accent = racer.accent;
  const steer = clamp(car.steer, -0.85, 0.85);
  const braking = clamp01(racer.input ? racer.input.brake : 0);
  const boosting = car.boostTime > 0;
  const speedF = clamp01(car.speed / Math.max(1, racer.spec.topSpeed));
  const detail = zoom > 0.42;
  const art = makeCarArt(racer);

  ctx.save();
  ctx.translate(car.pos.x, car.pos.y);
  ctx.rotate(car.angle);

  /* --------------------------------------------------------- underglow --- */
  if (detail) {
    const pool = glowSprite(ctx, racer.color);
    if (pool) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (isPlayer ? 0.3 : 0.18) + speedF * 0.06 + (boosting ? 0.14 : 0);
      const s = L * 2.7;
      ctx.drawImage(pool, -s * 0.5, -s * 0.5, s, s);
      ctx.restore();
    }
  }

  /* -------------------------------------------------------------- body --- */
  if (art) {
    ctx.drawImage(art.canvas, -art.w * 0.5, -art.h * 0.5, art.w, art.h);
  } else {
    ctx.beginPath();
    roundRectPath(ctx, -hx, -hy, L, W, 7);
    ctx.fillStyle = racer.color;
    ctx.fill();
    ctx.strokeStyle = rgba(accent, 0.5);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /* --------------------------------------------------------- headlights -- */
  const cone = detail ? coneSprite() : null;
  if (cone) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.09 + 0.06 * speedF;
    const cl = L * 1.7;
    const cH = W * 1.9;
    ctx.drawImage(cone, hx - 1, -cH * 0.5, cl, cH);
    ctx.restore();
  }
  ctx.fillStyle = 'rgba(255,250,225,0.95)';
  ctx.beginPath();
  ctx.rect(hx - 2.2, -hy * 0.74, 2.6, 3.4);
  ctx.rect(hx - 2.2, hy * 0.74 - 3.4, 2.6, 3.4);
  ctx.fill();

  /* ------------------------------------------------------------- wheels -- */
  const wx = L * 0.3;
  const rearX = -L * 0.31;
  const frontW = art ? art.frontW : 6.4;
  const frontL = art ? art.frontL : 12.4;
  const rearW = art ? art.rearW : 6.9;
  const rearL = art ? art.rearL : 12.8;
  const wy = hy - 0.6;
  const wheelFront = makeWheel(frontL, frontW, `f|${frontL}|${frontW}`);
  const wheelRear = makeWheel(rearL, rearW, `r|${rearL}|${rearW}`);
  const discGlow = braking > 0.06 && detail ? glowSprite(ctx, '#ff8a2b') : null;
  for (let i = 0; i < 4; i++) {
    const front = i < 2;
    const sx = front ? wx : rearX;
    const sy = i % 2 === 0 ? -wy : wy;
    const img = front ? wheelFront : wheelRear;
    ctx.save();
    ctx.translate(sx, sy);
    if (front) ctx.rotate(steer);
    if (img) ctx.drawImage(img, -frontL * 0.5 - 1.5, -frontW * 0.5 - 1.5, frontL + 3, frontW + 3);
    else {
      ctx.fillStyle = '#0a0d18';
      ctx.fillRect(-6, -3, 12, 6);
    }
    if (discGlow && front) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = braking * 0.55;
      ctx.drawImage(discGlow, -9, -9, 18, 18);
      ctx.restore();
    }
    ctx.restore();
  }

  /* ------------------------------------------------ canopy specular sweep */
  if (art && detail) {
    const travel = ((time * 0.42 + hash01(racer.id * 17 + 3)) % 1) * (art.cw + 14) - 12;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = '#dff2ff';
    ctx.beginPath();
    ctx.moveTo(art.cx + travel, art.cy);
    ctx.lineTo(art.cx + travel + 6, art.cy);
    ctx.lineTo(art.cx + travel - 1, art.cy + art.ch);
    ctx.lineTo(art.cx + travel - 7, art.cy + art.ch);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* -------------------------------------------------------------- lamps -- */
  const tailOn = braking > 0.05 || car.forwardSpeed < -4;
  ctx.fillStyle = tailOn ? 'rgba(255,70,110,0.98)' : 'rgba(150,28,58,0.8)';
  ctx.fillRect(-hx - 0.2, -hy * 0.78, 2.3, W * 0.78);
  if (tailOn) {
    const bloom = detail ? glowSprite(ctx, COLORS.hudPink) : null;
    if (bloom) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.2 + braking * 0.6;
      ctx.drawImage(bloom, -hx - 30, -hy - 12, 40, W + 24);
      ctx.restore();
    }
  }
  if (car.forwardSpeed < -4) {
    ctx.fillStyle = 'rgba(240,248,255,0.9)';
    ctx.fillRect(-hx - 0.6, -2.4, 2, 4.8);
  }

  /* ------------------------------------------------------------- flames -- */
  if (boosting && art) {
    const flame = flameSprite();
    if (flame) {
      const flick = 0.72 + 0.28 * Math.sin(time * 41 + racer.id * 1.7) + 0.12 * Math.sin(time * 67 + racer.id);
      const heat = clamp01(car.boostTime / 0.25);
      const len = (26 + 26 * flick) * (0.6 + 0.4 * heat) + speedF * 12;
      const halfW = 7 + 3 * flick;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < art.exhaust.length; i += 2) {
        const ex = art.exhaust[i] as number;
        const ey = art.exhaust[i + 1] as number;
        ctx.globalAlpha = 0.85;
        ctx.drawImage(flame, ex - len, ey - halfW, len, halfW * 2);
      }
      ctx.restore();
    }
  }

  ctx.restore();

  /* --------------------------------------------------------- name plate -- */
  if (showName && zoom > NAME_TAG_ZOOM && tagAlpha > 0.04) {
    ctx.save();
    ctx.globalAlpha = tagAlpha;
    ctx.translate(car.pos.x, car.pos.y);
    if (camAngle) ctx.rotate(-camAngle);
    ctx.scale(1 / zoom, 1 / zoom);
    ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const label = racer.name;
    let tw = nameWidthCache.get(label);
    if (tw === undefined) {
      tw = ctx.measureText(label).width;
      nameWidthCache.set(label, tw);
    }
    ctx.fillStyle = 'rgba(6,10,22,0.55)';
    ctx.fillRect(-tw * 0.5 - 4, -40, tw + 8, 14);
    ctx.fillStyle = rgba(accent, 0.92);
    ctx.fillText(label, 0, -28);
    ctx.restore();
  }
}

function drawPlayerHalo(
  ctx: CanvasRenderingContext2D,
  racer: Racer,
  time: number,
  zoom: number,
  camAngle: number,
): void {
  const car = racer.car;
  const charge = clamp01(car.driftCharge);
  const boosting = car.boostTime > 0;

  // rotating dashed ring, charging with the drift gauge and flaring on boost
  ctx.save();
  ctx.translate(car.pos.x, car.pos.y);
  ctx.globalCompositeOperation = 'lighter';
  const pulse = 0.5 + 0.14 * Math.sin(time * 4);
  const radius = 34 * (1 + 0.02 * Math.sin(time * 5)) + charge * 3 + (boosting ? 5 : 0);
  ctx.strokeStyle = rgba(COLORS.hudCyan, 0.45 + charge * 0.35 + (boosting ? 0.2 : 0));
  ctx.lineWidth = 1.6 / zoom;
  ctx.setLineDash([11 / zoom, 9 / zoom]);
  ctx.lineDashOffset = -time * 26 / zoom;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  // charge arc + boost flare
  if (charge > 0.01) {
    ctx.strokeStyle = charge >= 0.999 ? rgba(COLORS.boost, pulse + 0.3) : rgba(COLORS.hudCyan, 0.85);
    ctx.lineWidth = 3 / zoom;
    ctx.beginPath();
    ctx.arc(0, 0, radius + 4, -Math.PI * 0.5, -Math.PI * 0.5 + charge * TAU);
    ctx.stroke();
  }
  if (boosting) {
    const flare = glowSprite(ctx, COLORS.boost);
    if (flare) {
      const s = racer.spec.length * (4.2 + 0.5 * Math.sin(time * 30));
      ctx.globalAlpha = 0.35;
      ctx.drawImage(flare, -s * 0.5, -s * 0.5, s, s);
    }
  }
  ctx.restore();

  // place chevron above the car, always upright on screen
  if (zoom > 0.34) {
    ctx.save();
    ctx.translate(car.pos.x, car.pos.y);
    if (camAngle) ctx.rotate(-camAngle);
    ctx.scale(1 / zoom, 1 / zoom);
    const bob = Math.sin(time * 3.6) * 2;
    const place = racer.place || 1;
    ctx.beginPath();
    ctx.moveTo(0, -32 + bob);
    ctx.lineTo(-7, -44 + bob);
    ctx.lineTo(7, -44 + bob);
    ctx.closePath();
    ctx.fillStyle = rgba(COLORS.hudCyan, 0.95);
    ctx.fill();
    ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(6,10,22,0.85)';
    ctx.fillText(`P${place}`, 0, -57 + bob);
    ctx.restore();
  }
}

/* ------------------------------------------------------------- overlays -- */

interface OverlayCache {
  w: number;
  h: number;
  dpr: number;
  /** pre-composited vignette + scanlines, blitted as one pass */
  screen: HTMLCanvasElement | null;
  /** vertical gradient strip for the travelling CRT band */
  band: HTMLCanvasElement | null;
  bandH: number;
  glowEdge: CanvasGradient | null;
  wrongWay: CanvasGradient | null;
  wrongW: number;
}

function buildScreenOverlay(oc: OverlayCache, w: number, h: number, dpr: number): void {
  if (typeof document === 'undefined') return;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const g = c.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  // vignette
  const grad = g.createRadialGradient(
    w * 0.5,
    h * 0.5,
    Math.min(w, h) * 0.22,
    w * 0.5,
    h * 0.52,
    Math.max(w, h) * 0.78,
  );
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.62, 'rgba(2,4,12,0.28)');
  grad.addColorStop(1, 'rgba(0,0,4,0.78)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // scanlines baked in, so the live frame only pays for one full-screen blend
  g.fillStyle = 'rgba(255,255,255,0.035)';
  for (let y = 0; y < h; y += 4) g.fillRect(0, y, w, 1);
  g.fillStyle = 'rgba(0,0,0,0.05)';
  for (let y = 2; y < h; y += 4) g.fillRect(0, y, w, 1);

  // corner tint: keep the composition HUD friendly (bright top corners read as UI)
  g.globalCompositeOperation = 'lighter';
  const edge = g.createLinearGradient(0, 0, 0, h * 0.35);
  edge.addColorStop(0, 'rgba(20,40,90,0.20)');
  edge.addColorStop(1, 'rgba(20,40,90,0)');
  g.fillStyle = edge;
  g.fillRect(0, 0, w, h * 0.35);

  oc.screen = c;

  // travelling band strip
  const bandH = 200;
  const b = document.createElement('canvas');
  b.width = 4;
  b.height = Math.max(2, Math.round(bandH * dpr));
  const bg = b.getContext('2d');
  if (bg) {
    const bgd = bg.createLinearGradient(0, 0, 0, b.height);
    bgd.addColorStop(0, 'rgba(0,240,255,0)');
    bgd.addColorStop(0.5, 'rgba(0,240,255,0.05)');
    bgd.addColorStop(1, 'rgba(0,240,255,0)');
    bg.fillStyle = bgd;
    bg.fillRect(0, 0, b.width, b.height);
    oc.band = b;
    oc.bandH = bandH;
  }
}

function drawScreenOverlays(
  ctx: CanvasRenderingContext2D,
  oc: OverlayCache,
  w: number,
  h: number,
  time: number,
  flash: number,
  wrongWay: number,
  dpr: number,
): void {
  if (oc.w !== w || oc.h !== h || oc.dpr !== dpr || !oc.screen) {
    oc.w = w;
    oc.h = h;
    oc.dpr = dpr;
    oc.wrongWay = null;
    buildScreenOverlay(oc, w, h, dpr);
  }

  if (oc.screen) ctx.drawImage(oc.screen, 0, 0, w, h);

  // slow scanning band for a CRT feel
  if (oc.band) {
    const bandY = ((time * 58) % (h + oc.bandH)) - oc.bandH * 0.5;
    ctx.drawImage(oc.band, 0, bandY, w, oc.bandH);
  }

  if (wrongWay > 0) {
    if (!oc.wrongWay || oc.wrongW !== w) {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, 'rgba(255,46,99,0.9)');
      g.addColorStop(0.35, 'rgba(255,46,99,0)');
      g.addColorStop(0.65, 'rgba(255,46,99,0)');
      g.addColorStop(1, 'rgba(255,46,99,0.9)');
      oc.wrongWay = g;
      oc.wrongW = w;
    }
    ctx.save();
    ctx.globalAlpha = 0.16 + 0.1 * Math.sin(time * 9);
    ctx.fillStyle = oc.wrongWay;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  if (flash > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp01(flash);
    ctx.fillStyle = 'rgba(190,225,255,0.5)';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}

interface DebugState {
  history: Float32Array;
  head: number;
  fps: number;
}

function drawDebug(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  dbg: DebugState,
  flash: number,
): void {
  const race = scene.race;
  const p = race.player;
  const car = p.car;
  const lines = [
    `NEON RACER  ${dbg.fps.toFixed(0)} fps  ${(1000 / Math.max(1, dbg.fps)).toFixed(1)} ms`,
    `cam zoom ${scene.camera.zoom.toFixed(2)}  angle ${(scene.camera.angle * 57.3).toFixed(1)}°  shake ${scene.camera.shake.toFixed(2)}`,
    `pos ${car.pos.x.toFixed(0)}, ${car.pos.y.toFixed(0)}   vel ${car.speed.toFixed(0)} u/s`,
    `s ${p.progress.s.toFixed(0)}/${race.track.length.toFixed(0)}  lap ${p.lap + 1}/${race.config.laps}  place ${p.place}/${race.racers.length}`,
    `lateral ${p.progress.lateral.toFixed(1)}  slip ${car.slip.toFixed(2)}  drift ${car.drifting ? 'Y' : 'n'} ${car.driftTime.toFixed(1)}s`,
    `surface ${car.surface}  boost ${car.boostTime.toFixed(2)}s  crash ${car.crashCooldown.toFixed(2)}s`,
    `particles ${scene.effects.particles.length}  skids ${scene.effects.skids.length}  flash ${flash.toFixed(2)}`,
  ];
  const w = 372;
  const h = 22 + lines.length * 15 + 44;
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = 'rgba(4,8,18,0.78)';
  ctx.fillRect(12, 12, w, h);
  ctx.strokeStyle = 'rgba(0,240,255,0.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(12.5, 12.5, w, h);
  ctx.font = '500 11px ui-monospace, "Cascadia Mono", Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLORS.hudText;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i] as string, 22, 22 + i * 15);

  // frame time graph
  const gy = 22 + lines.length * 15 + 6;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(22, gy, w - 20, 30);
  ctx.strokeStyle = 'rgba(0,240,255,0.25)';
  ctx.beginPath();
  ctx.moveTo(22, gy + 16.7);
  ctx.lineTo(w + 2, gy + 16.7);
  ctx.stroke();
  const bars = 60;
  for (let i = 0; i < bars; i++) {
    const idx = (dbg.head - bars + i + dbg.history.length * 2) % dbg.history.length;
    const v = dbg.history[idx] as number;
    const bh = clamp((v / 33) * 30, 1, 30);
    ctx.fillStyle = v > 22 ? '#ff2e63' : v > 17 ? '#ffd400' : '#00e676';
    ctx.fillRect(22 + i * ((w - 20) / bars), gy + 30 - bh, (w - 20) / bars - 1, bh);
  }
  ctx.restore();
}

/* ------------------------------------------------------------- renderer -- */

/** Reused per-frame visibility flags so the car loop never allocates. */
const carVisibleScratch: boolean[] = [];



export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('NEON RACER: 2D context unavailable');
  let dpr = 1;
  let width = 0;
  let height = 0;
  let cache: TrackCache | null = null;
  const overlay: OverlayCache = { w: 0, h: 0, dpr: 0, screen: null, band: null, bandH: 200, glowEdge: null, wrongWay: null, wrongW: 0 };
  const debug: DebugState = { history: new Float32Array(120), head: 0, fps: 60 };
  let crashState = new Float64Array(16);
  let crashSeen = new Uint8Array(16);
  let flash = 0;
  let boostLatch = 0;
  // Far-layer parallax: a path integral of the camera's displacement along the
  // direction of travel. Only the distant void/grid layer uses it, so cars,
  // track, kerbs and skid marks never slide relative to each other.
  let parPrevX = NaN;
  let parPrevY = NaN;
  let parDist = 0;

  function ensureSlots(id: number): void {
    if (id < crashState.length) return;
    let size = crashState.length;
    while (size <= id) size *= 2;
    const next = new Float64Array(size);
    next.set(crashState);
    const seen = new Uint8Array(size);
    seen.set(crashSeen);
    crashState = next;
    crashSeen = seen;
  }

  return {
    resize(cssWidth, cssHeight, nextDpr) {
      const w = Math.max(1, Math.round(cssWidth));
      const h = Math.max(1, Math.round(cssHeight));
      dpr = clamp(Number.isFinite(nextDpr) && nextDpr > 0 ? nextDpr : 1, 0.5, 2);
      width = w;
      height = h;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      overlay.w = 0;
      overlay.h = 0;
      overlay.dpr = 0;
      overlay.screen = null;
      overlay.band = null;
    },

    draw(scene: Scene) {
      const w = scene.width > 0 ? scene.width : width;
      const h = scene.height > 0 ? scene.height : height;
      const camera = scene.camera;
      const race = scene.race;

      // frame timing
      const frameMs = (Number.isFinite(scene.dt) ? scene.dt : 1 / 60) * 1000;
      debug.history[debug.head] = frameMs;
      debug.head = (debug.head + 1) % debug.history.length;
      debug.fps = debug.fps * 0.9 + (1000 / Math.max(1, frameMs)) * 0.1;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = COLORS.void;
      ctx.fillRect(0, 0, w, h);

      if (!race || !race.track) {
        return;
      }
      const track = race.track;
      if (!cache || cache.track !== track) cache = buildCache(track);
      const tc = cache;

      // impact / boost flashes are derived from race state only
      let impactNow = 0;
      let boostNow = 0;
      for (let i = 0; i < race.racers.length; i++) {
        const racer = race.racers[i];
        if (!racer || !racer.car) continue;
        const id = racer.id >= 0 ? racer.id | 0 : i;
        if (id >= crashState.length) ensureSlots(id);
        const crash = Number.isFinite(racer.car.crashCooldown) ? racer.car.crashCooldown : 0;
        if (crashSeen[id]) {
          const jump = crash - (crashState[id] as number);
          if (jump > 0.015) impactNow = Math.max(impactNow, clamp01(jump * 1.6));
        }
        crashSeen[id] = 1;
        crashState[id] = crash;
        if (racer.isPlayer && racer.car.boostTime > 0.001 && boostLatch <= 0) boostNow = 1;
        if (racer.isPlayer) boostLatch = racer.car.boostTime;
      }
      flash *= Math.exp(-4.6 * Math.max(1 / 240, Math.min(1 / 20, scene.dt || 1 / 60)));
      flash = Math.min(1, flash + impactNow * 0.55);
      if (boostNow) flash = Math.min(1, flash + 0.16);

      const bounds = viewBounds(camera, w, h);
      const zoom = clamp(camera.zoom, 0.05, 3);

      /* ------------------------------------------------- world space pass -- */
      ctx.save();
      ctx.translate(w * 0.5 + camera.shakeX, h * 0.5 + camera.shakeY);
      if (camera.angle) ctx.rotate(camera.angle);
      ctx.scale(zoom, zoom);
      ctx.translate(-camera.pos.x, -camera.pos.y);

      // depth layer 0 (far): the void grid parallaxes; layer 1 (near): apron,
      // track detail, skid marks, effects and cars share one transform.
      let farX = 0;
      let farY = 0;
      if (camera.mode !== 'topdown' && race.player && race.player.car) {
        const pc = race.player.car;
        let dvx = Math.cos(pc.angle);
        let dvy = Math.sin(pc.angle);
        if (pc.speed > 20 && Number.isFinite(pc.vel.x) && Number.isFinite(pc.vel.y)) {
          dvx = pc.vel.x / pc.speed;
          dvy = pc.vel.y / pc.speed;
        }
        if (Number.isFinite(parPrevX)) parDist += (camera.pos.x - parPrevX) * dvx + (camera.pos.y - parPrevY) * dvy;
        const k = parDist * CAMERA.chaseParallax;
        farX = dvx * k;
        farY = dvy * k;
      } else {
        parDist = 0;
      }
      parPrevX = camera.pos.x;
      parPrevY = camera.pos.y;

      drawVoidGrid(ctx, bounds, zoom, scene.time, farX, farY);
      blitApron(ctx, tc, bounds);
      drawTrackDetail(ctx, tc, bounds, zoom, scene.time, 1);
      drawEffects(ctx, scene.effects, camera);

      // cars: shadows first, then bodies with the player drawn on top. Cars are
      // culled against the (rotated) view bounds, which also bounds the work.
      const racers = race.racers;
      const cull = 140;
      const carVisible: boolean[] = carVisibleScratch;
      for (let i = 0; i < racers.length; i++) {
        const racer = racers[i];
        const car = racer ? racer.car : null;
        const vis =
          !!car &&
          car.pos.x > bounds.minX - cull &&
          car.pos.x < bounds.maxX + cull &&
          car.pos.y > bounds.minY - cull &&
          car.pos.y < bounds.maxY + cull;
        carVisible[i] = vis;
        if (vis && car) drawCarShadow(ctx, racer as Racer);
      }
      const camAngle = camera.angle;
      const camCos = Math.cos(camAngle);
      const camSin = Math.sin(camAngle);
      // the DOM HUD owns the centre of the screen during the grid countdown
      const tagsOn = race.phase !== 'countdown';
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < racers.length; i++) {
          const racer = racers[i];
          if (!racer || !racer.car || !carVisible[i]) continue;
          if (pass === 0 ? racer.isPlayer : !racer.isPlayer) continue;
          if (racer.isPlayer) drawPlayerHalo(ctx, racer, scene.time, zoom, camAngle);
          let tag = tagsOn ? 1 : 0;
          if (!racer.isPlayer && tagsOn) {
            const rx = (racer.car.pos.x - camera.pos.x) * zoom;
            const ry = (racer.car.pos.y - camera.pos.y) * zoom;
            tag = hudTagAlpha(
              w * 0.5 + camera.shakeX + rx * camCos - ry * camSin,
              h * 0.5 + camera.shakeY + rx * camSin + ry * camCos,
              w,
              h,
            );
          }
          drawCar(ctx, racer, scene.time, zoom, !racer.isPlayer, tag, camAngle, racer.isPlayer);
        }
      }
      ctx.restore();

      /* ------------------------------------------------- screen space pass -- */
      drawScreenOverlays(ctx, overlay, w, h, scene.time, flash, race.player?.wrongWay ? 1 : 0, dpr);
      if (scene.showDebug) drawDebug(ctx, scene, debug, flash);
    },

    dispose() {
      cache = null;
      overlay.screen = null;
      overlay.band = null;
    },
  };
}

/* ---------------------------------------------------------- attract mode -- */

let attractCache: TrackCache | null = null;

export function drawAttract(ctx: CanvasRenderingContext2D, scene: AttractScene): void {
  const { width, height, dpr, time, track } = scene;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.void;
  ctx.fillRect(0, 0, width, height);
  if (!track) return;
  if (!attractCache || attractCache.track !== track) attractCache = buildCache(track);
  const tc = attractCache;
  if (tc.n < 3) return;

  const spanX = Math.max(1, tc.maxX - tc.minX);
  const spanY = Math.max(1, tc.maxY - tc.minY);
  const cx = (tc.minX + tc.maxX) * 0.5;
  const cy = (tc.minY + tc.maxY) * 0.5;
  const fit = Math.min(width / spanX, height / spanY) * 0.82;
  const zoom = clamp(fit * (1 + 0.035 * Math.sin(time * 0.13)), 0.05, 3);
  const angle = Math.sin(time * 0.055) * 0.12 + time * 0.008;

  const r = Math.hypot(width, height) / (2 * zoom) + 120;
  const bounds: Bounds = { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };

  ctx.save();
  ctx.translate(width * 0.5, height * 0.5);
  ctx.rotate(angle);
  ctx.scale(zoom, zoom);
  ctx.translate(-cx, -cy);
  drawVoidGrid(ctx, bounds, zoom, time, 0, 0);
  blitApron(ctx, tc, bounds);
  drawTrackDetail(ctx, tc, bounds, zoom, time, 0);

  // energy pulses running along the circuit
  const glow = glowSprite(ctx, COLORS.hudCyan);
  const glowPink = glowSprite(ctx, COLORS.hudPink);
  if (glow) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const pulses = 14;
    for (let i = 0; i < pulses; i++) {
      const s = (time * 420 + (i * track.length) / pulses) % track.length;
      const idx = Math.floor(s / Math.max(1, tc.step)) % tc.n;
      const x = tc.ctr[idx * 2] as number;
      const y = tc.ctr[idx * 2 + 1] as number;
      const img = (i & 1) === 0 ? glow : glowPink;
      const size = 70;
      ctx.globalAlpha = 0.5;
      if (img) ctx.drawImage(img, x - size * 0.5, y - size * 0.5, size, size);
    }
    ctx.restore();
  }
  ctx.restore();

  const oc = attractOverlay;
  if (oc.w !== width || oc.h !== height) {
    oc.w = width;
    oc.h = height;
  }
  drawScreenOverlays(ctx, oc, width, height, time, 0, 0, dpr);
}

const attractOverlay: OverlayCache = {
  w: 0,
  h: 0,
  dpr: 0,
  screen: null,
  band: null,
  bandH: 200,
  glowEdge: null,
  wrongWay: null,
  wrongW: 0,
};
