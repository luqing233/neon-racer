/**
 * Unit tests for src/game/track.ts — procedural generator, spatial query, racing line.
 * OWNER: engine-dev. Run with `npx vitest run`.
 */

import { describe, expect, it } from 'vitest';
import { RACE, TRACK } from '../../src/game/config';
import { generateTrack } from '../../src/game/track';
import { segmentsIntersect } from '../../src/game/math';
import type { Track, TrackStyle, Vec2 } from '../../src/game/types';

const STYLES: TrackStyle[] = ['circuit', 'technical', 'speedway', 'random'];
const SEEDS = [1, 42, 20261018, 77777];

/** geometric radius of curvature through three consecutive samples */
function circumRadius(a: Vec2, b: Vec2, c: Vec2): number {
  const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  if (cross < 1e-9) return Number.POSITIVE_INFINITY;
  const ab = Math.hypot(b.x - a.x, b.y - a.y);
  const bc = Math.hypot(c.x - b.x, c.y - b.y);
  const ca = Math.hypot(a.x - c.x, a.y - c.y);
  return (ab * bc * ca) / (2 * cross);
}

function serialize(track: Track): string {
  return JSON.stringify({
    seed: track.seed,
    style: track.style,
    name: track.name,
    step: track.step,
    length: track.length,
    startIndex: track.startIndex,
    samples: track.samples,
    leftEdge: track.leftEdge,
    rightEdge: track.rightEdge,
    racingLine: track.racingLine,
    startLine: track.startLine,
    bounds: track.bounds,
  });
}

/** brute-force nearest point on the centerline polyline */
function bruteNearest(track: Track, p: Vec2): { dist: number; lateral: number } {
  const n = track.samples.length;
  let bestD2 = Infinity;
  let bestLat = 0;
  for (let i = 0; i < n; i++) {
    const a = track.samples[i]!.pos;
    const b = track.samples[(i + 1) % n]!.pos;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const l2 = abx * abx + aby * aby || 1;
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = a.x + abx * t;
    const cy = a.y + aby * t;
    const d2 = (p.x - cx) ** 2 + (p.y - cy) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      const sample = track.samples[i]!;
      const nx = sample.dir.y;
      const ny = -sample.dir.x;
      bestLat = (p.x - cx) * nx + (p.y - cy) * ny;
    }
  }
  return { dist: Math.sqrt(bestD2), lateral: bestLat };
}

describe('generateTrack: determinism', () => {
  it('produces an identical track for the same seed and style', { timeout: 30000 }, () => {
    for (const style of STYLES) {
      for (const seed of SEEDS.slice(0, 3)) {
        expect(serialize(generateTrack(seed, style))).toBe(serialize(generateTrack(seed, style)));
      }
    }
  });

  it('resolves "random" deterministically and identically to the chosen style', { timeout: 30000 }, () => {
    for (const seed of SEEDS) {
      const a = generateTrack(seed, 'random');
      const b = generateTrack(seed, 'random');
      expect(a.style).toBe(b.style);
      expect(a.name).toBe(b.name);
      expect(a.style === 'circuit' || a.style === 'technical' || a.style === 'speedway').toBe(true);
      expect(serialize(a)).toBe(serialize(generateTrack(seed, a.style)));
    }
  });

  it('gives different tracks for different seeds and different styles', { timeout: 30000 }, () => {
    expect(serialize(generateTrack(1, 'circuit'))).not.toBe(serialize(generateTrack(2, 'circuit')));
    expect(serialize(generateTrack(7, 'circuit'))).not.toBe(serialize(generateTrack(7, 'technical')));
  });
});

describe('generateTrack: geometry invariants', () => {
  it('keeps every sample, edge and barrier inside the playfield', { timeout: 30000 }, () => {
    const half = TRACK.fieldSize / 2;
    for (const style of STYLES) {
      for (const seed of SEEDS) {
        const track = generateTrack(seed, style);
        for (const s of track.samples) {
          expect(Math.abs(s.pos.x)).toBeLessThanOrEqual(half);
          expect(Math.abs(s.pos.y)).toBeLessThanOrEqual(half);
        }
        for (const edge of [...track.leftEdge, ...track.rightEdge]) {
          expect(Math.abs(edge.x)).toBeLessThanOrEqual(half);
          expect(Math.abs(edge.y)).toBeLessThanOrEqual(half);
        }
        expect(track.bounds.minX).toBeLessThan(track.bounds.maxX);
        expect(track.bounds.minY).toBeLessThan(track.bounds.maxY);
        expect(track.bounds.minX).toBeGreaterThanOrEqual(-half);
        expect(track.bounds.maxX).toBeLessThanOrEqual(half);
      }
    }
  });

  it('closes the loop without a seam', { timeout: 30000 }, () => {
    for (const style of STYLES) {
      for (const seed of SEEDS) {
        const track = generateTrack(seed, style);
        const n = track.samples.length;
        const first = track.samples[0]!;
        const last = track.samples[n - 1]!;
        const gap = Math.hypot(first.pos.x - last.pos.x, first.pos.y - last.pos.y);
        // chord vs arc: a vertex between two samples makes the chord a hair shorter
        expect(Math.abs(gap - track.step)).toBeLessThan(track.step * 0.01);
        expect(first.s).toBe(0);
        expect(last.s).toBeCloseTo(track.length - track.step, 6);
        expect(track.posAt(0).x).toBeCloseTo(first.pos.x, 9);
        expect(track.posAt(track.length).x).toBeCloseTo(first.pos.x, 9);
        expect(track.posAt(-track.step).x).toBeCloseTo(last.pos.x, 6);
        expect(track.posAt(-track.step).y).toBeCloseTo(last.pos.y, 6);
      }
    }
  });

  it('respects TRACK.minRadius everywhere on the centerline', { timeout: 30000 }, () => {
    for (const style of STYLES) {
      for (const seed of SEEDS) {
        const track = generateTrack(seed, style);
        const n = track.samples.length;
        let tightest = Infinity;
        for (let i = 0; i < n; i++) {
          const r = circumRadius(
            track.samples[(i - 1 + n) % n]!.pos,
            track.samples[i]!.pos,
            track.samples[(i + 1) % n]!.pos,
          );
          if (r < tightest) tightest = r;
        }
        expect(tightest).toBeGreaterThanOrEqual(TRACK.minRadius * 0.98);
      }
    }
  });

  it('stays simple (no self-intersection): winding around the centroid is monotonic', { timeout: 30000 }, () => {
    for (const style of STYLES) {
      for (const seed of SEEDS) {
        const track = generateTrack(seed, style);
        const n = track.samples.length;
        let cx = 0;
        let cy = 0;
        for (const s of track.samples) {
          cx += s.pos.x;
          cy += s.pos.y;
        }
        cx /= n;
        cy /= n;
        let winding = 0;
        let prev = Math.atan2(track.samples[0]!.pos.y - cy, track.samples[0]!.pos.x - cx);
        for (let i = 1; i <= n; i++) {
          const p = track.samples[i % n]!.pos;
          const angle = Math.atan2(p.y - cy, p.x - cx);
          let d = angle - prev;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d <= -Math.PI) d += Math.PI * 2;
          expect(d).toBeGreaterThan(0);
          winding += d;
          prev = angle;
        }
        expect(Math.abs(winding)).toBeCloseTo(Math.PI * 2, 2);
      }
    }
  });

  it('samples evenly, keeps widths in range and edges symmetric', { timeout: 30000 }, () => {
    for (const style of STYLES) {
      for (const seed of SEEDS) {
        const track = generateTrack(seed, style);
        const n = track.samples.length;
        for (let i = 0; i < n; i++) {
          const a = track.samples[i]!;
          const b = track.samples[(i + 1) % n]!;
          const gap = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
          // even arc-length spacing; chords differ by <1% where a vertex sits inside a step
          expect(Math.abs(gap - track.step)).toBeLessThan(track.step * 0.01);
          expect(a.width).toBeGreaterThanOrEqual(TRACK.minWidth - 0.01);
          expect(a.width).toBeLessThanOrEqual(TRACK.maxWidth + 0.01);
          // tangent, normal and curvature are consistent
          const dirLen = Math.hypot(a.dir.x, a.dir.y);
          expect(dirLen).toBeCloseTo(1, 9);
          expect(a.normal.x).toBeCloseTo(a.dir.y, 9);
          expect(a.normal.y).toBeCloseTo(-a.dir.x, 9);
          const left = track.leftEdge[i]!;
          const right = track.rightEdge[i]!;
          expect(Math.hypot(left.x - right.x, left.y - right.y)).toBeCloseTo(a.width, 6);
          const midX = (left.x + right.x) / 2;
          const midY = (left.y + right.y) / 2;
          expect(midX).toBeCloseTo(a.pos.x, 6);
          expect(midY).toBeCloseTo(a.pos.y, 6);
        }
      }
    }
  });

  it('varies width with curvature and by style (technical narrower than speedway)', { timeout: 30000 }, () => {
    const technical = generateTrack(20261018, 'technical');
    const speedway = generateTrack(20261018, 'speedway');
    const avg = (t: Track) => t.samples.reduce((sum, s) => sum + s.width, 0) / t.samples.length;
    expect(avg(technical)).toBeLessThan(avg(speedway));
    expect(speedway.length).toBeGreaterThan(technical.length);
    // width reacts to curvature: the tightest corners are narrower than the straights
    let tightWidth = Infinity;
    let straightWidth = 0;
    for (const s of technical.samples) {
      const radius = Math.abs(s.curvature) > 1e-7 ? 1 / Math.abs(s.curvature) : Infinity;
      if (radius < 320) tightWidth = Math.min(tightWidth, s.width);
      if (radius > 2000) straightWidth = Math.max(straightWidth, s.width);
    }
    if (Number.isFinite(tightWidth)) expect(tightWidth).toBeLessThan(straightWidth);
  });
});

describe('generateTrack: racing line', () => {
  it('is index-aligned and stays at least 12 units inside the asphalt', { timeout: 30000 }, () => {
    for (const style of STYLES) {
      for (const seed of SEEDS) {
        const track = generateTrack(seed, style);
        expect(track.racingLine.length).toBe(track.samples.length);
        let maxOffset = 0;
        for (let i = 0; i < track.samples.length; i++) {
          const s = track.samples[i]!;
          const l = track.racingLine[i]!;
          const lateral = (l.x - s.pos.x) * s.normal.x + (l.y - s.pos.y) * s.normal.y;
          expect(s.width / 2 - Math.abs(lateral)).toBeGreaterThanOrEqual(12);
          expect(Math.abs(lateral)).toBeLessThanOrEqual(s.width / 2);
          maxOffset = Math.max(maxOffset, Math.abs(lateral));
        }
        // a real racing line leaves the centerline somewhere
        expect(maxOffset).toBeGreaterThan(8);
      }
    }
  });

  it('is drivable: its own corner radii never collapse', { timeout: 30000 }, () => {
    // The line cuts to the inside of corners, so it may be tighter than the
    // centreline — but never by more than 20% of the corridor's design minimum.
    // The generator targets TRACK.minRadius * 0.9 (see LINE_RADIUS_FLOOR); this
    // floor leaves headroom for the discrete sampling while staying far above
    // any car's minimum turning radius (~176 units).
    const LINE_FLOOR = TRACK.minRadius * 0.8;
    for (const style of STYLES) {
      for (const seed of SEEDS) {
        const track = generateTrack(seed, style);
        const n = track.racingLine.length;
        for (let i = 0; i < n; i++) {
          const r = circumRadius(
            track.racingLine[(i - 1 + n) % n]!,
            track.racingLine[i]!,
            track.racingLine[(i + 1) % n]!,
          );
          expect(r).toBeGreaterThanOrEqual(LINE_FLOOR);
        }
      }
    }
  });
});

describe('generateTrack: query', () => {
  it('returns the accurate nearest point, lateral sign and surface', { timeout: 30000 }, () => {
    for (const style of STYLES) {
      const track = generateTrack(20261018, style);
      for (let k = 0; k < 120; k++) {
        const s = (k / 120) * track.length;
        const sample = track.at(s);
        // walk outwards on the left-hand normal in steps
        const offsets = [0, 10, sample.width / 2 - TRACK.curbWidth - 2, sample.width / 2 - 4, sample.width / 2 + 10];
        for (const offset of offsets) {
          const p = { x: sample.pos.x + sample.normal.x * offset, y: sample.pos.y + sample.normal.y * offset };
          const q = track.query(p);
          expect(Math.abs(q.lateral - offset)).toBeLessThan(0.6);
          expect(q.onRoad).toBe(Math.abs(offset) <= sample.width / 2 + 0.5);
          if (Math.abs(offset) <= sample.width / 2 - TRACK.curbWidth - 2) expect(q.surface).toBe('road');
          if (offset > sample.width / 2 + 4) expect(q.surface).toBe('grass');
          // curvature (the reciprocal) is the meaningful quantity at huge radii
          expect(Math.abs(1 / q.radius - Math.abs(sample.curvature))).toBeLessThan(3e-4);
          // agrees with an O(n) brute-force projection
          const brute = bruteNearest(track, p);
          expect(Math.abs(brute.dist - Math.abs(q.lateral))).toBeLessThan(1.0);
        }
      }
      // right side gives a negative lateral
      const sample = track.at(track.length * 0.37);
      const p = { x: sample.pos.x - sample.normal.x * 25, y: sample.pos.y - sample.normal.y * 25 };
      expect(Math.abs(track.query(p).lateral + 25)).toBeLessThan(0.6);
    }
  });

  it('has no seam: queries around the start line agree with the neighbouring samples', { timeout: 30000 }, () => {
    const track = generateTrack(20261018, 'circuit');
    const n = track.samples.length;
    const probe = (s: number, lat: number) => {
      const sample = track.at(s);
      return track.query({ x: sample.pos.x + sample.normal.x * lat, y: sample.pos.y + sample.normal.y * lat });
    };
    for (const lat of [-40, -10, 0, 12, 45]) {
      const before = probe(track.length - 4, lat);
      const at0 = probe(0, lat);
      const after = probe(4, lat);
      expect(before.lateral).toBeCloseTo(lat, 1);
      expect(at0.lateral).toBeCloseTo(lat, 1);
      expect(after.lateral).toBeCloseTo(lat, 1);
      // the local frame must rotate continuously across the seam
      const d1 = Math.hypot(before.dir.x - at0.dir.x, before.dir.y - at0.dir.y);
      const d2 = Math.hypot(at0.dir.x - after.dir.x, at0.dir.y - after.dir.y);
      expect(d1).toBeLessThan(0.02);
      expect(d2).toBeLessThan(0.02);
    }
    expect(n).toBeGreaterThan(100);
  });

  it('handles points far outside the track without NaN', { timeout: 30000 }, () => {
    const track = generateTrack(7, 'technical');
    for (const p of [
      { x: 0, y: 0 },
      { x: 5000, y: -5000 },
      { x: -99999, y: 99999 },
    ]) {
      const q = track.query(p);
      expect(Number.isFinite(q.lateral)).toBe(true);
      expect(Number.isFinite(q.s)).toBe(true);
      expect(Number.isFinite(q.radius)).toBe(true);
      expect(q.surface).toBe('grass');
    }
  });

  it('deltaS wraps into (-length/2, length/2]', { timeout: 30000 }, () => {
    const track = generateTrack(3, 'speedway');
    const L = track.length;
    expect(track.deltaS(0, 0)).toBe(0);
    expect(track.deltaS(0, 10)).toBeCloseTo(10, 9);
    expect(track.deltaS(10, 0)).toBeCloseTo(-10, 9);
    expect(track.deltaS(0, L - 1)).toBeCloseTo(-1, 9);
    expect(track.deltaS(L - 1, 0)).toBeCloseTo(1, 9);
    expect(track.deltaS(0, L / 2)).toBeCloseTo(L / 2, 9);
    expect(track.deltaS(0, -L / 2)).toBeCloseTo(L / 2, 9);
    for (const [a, b] of [
      [0.3, L - 5],
      [L * 0.9, L * 0.1],
      [-20, 30],
    ] as const) {
      const d = track.deltaS(a, b);
      expect(d).toBeGreaterThan(-L / 2);
      expect(d).toBeLessThanOrEqual(L / 2);
      expect(((a + d - b) / L) % 1).toBeCloseTo(0, 6);
    }
  });

  it('at(s) interpolates between samples with wrapping', { timeout: 30000 }, () => {
    const track = generateTrack(11, 'circuit');
    const s = track.length * 0.42;
    const i = Math.floor(s / track.step);
    const a = track.samples[i]!;
    const b = track.samples[(i + 1) % track.samples.length]!;
    const mid = track.at(s);
    const t = (s - i * track.step) / track.step;
    expect(mid.pos.x).toBeCloseTo(a.pos.x + (b.pos.x - a.pos.x) * t, 6);
    expect(mid.pos.y).toBeCloseTo(a.pos.y + (b.pos.y - a.pos.y) * t, 6);
    expect(mid.width).toBeCloseTo(a.width + (b.width - a.width) * t, 6);
    const wrapped = track.at(s - track.length);
    expect(wrapped.pos.x).toBeCloseTo(mid.pos.x, 6);
    expect(wrapped.pos.y).toBeCloseTo(mid.pos.y, 6);
    expect(track.posAt(s)).toEqual(mid.pos);
  });

  it('answers 20k queries quickly (spatial grid, not O(n) per call)', { timeout: 30000 }, () => {
    const track = generateTrack(20261018, 'technical');
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < 20000; i++) {
      const sample = track.samples[i % track.samples.length]!;
      acc += track.query(sample.pos).lateral;
    }
    const ms = performance.now() - t0;
    expect(Math.abs(acc)).toBeLessThan(1e-3);
    // ~3µs/query in node; give the CI plenty of headroom
    expect(ms).toBeLessThan(2000);
  });
});

/* --------------------------------------------------------------------------- */
/* Widened-geometry hardening: the tracks are long and wide now, so the risky    */
/* failure modes are corner-radius violations, folded/overlapping asphalt edges  */
/* and a start straight that is too short for the wider grid.                    */
/* --------------------------------------------------------------------------- */

interface ScanSegment {
  a: Vec2;
  b: Vec2;
  /** 0 = left edge, 1 = right edge, 2 = centerline */
  kind: number;
  index: number;
}

function collectSegments(track: Track): ScanSegment[] {
  const segments: ScanSegment[] = [];
  const push = (pts: Vec2[], kind: number): void => {
    for (let i = 0; i < pts.length; i++) {
      segments.push({ a: pts[i]!, b: pts[(i + 1) % pts.length]!, kind, index: i });
    }
  };
  push(track.leftEdge, 0);
  push(track.rightEdge, 1);
  push(track.samples.map((sample) => sample.pos), 2);
  return segments;
}

/** Segment intersections between different polylines / distant parts of one polyline. */
function countEdgeIntersections(track: Track): number {
  const segments = collectSegments(track);
  const n = track.samples.length;
  const cell = 256;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number): string => `${x},${y}`;
  segments.forEach((segment, i) => {
    const minX = Math.floor(Math.min(segment.a.x, segment.b.x) / cell);
    const maxX = Math.floor(Math.max(segment.a.x, segment.b.x) / cell);
    const minY = Math.floor(Math.min(segment.a.y, segment.b.y) / cell);
    const maxY = Math.floor(Math.max(segment.a.y, segment.b.y) / cell);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const bucket = grid.get(key(x, y));
        if (bucket) bucket.push(i);
        else grid.set(key(x, y), [i]);
      }
    }
  });
  let hits = 0;
  const checked = new Set<number>();
  segments.forEach((segment, i) => {
    const minX = Math.floor(Math.min(segment.a.x, segment.b.x) / cell);
    const maxX = Math.floor(Math.max(segment.a.x, segment.b.x) / cell);
    const minY = Math.floor(Math.min(segment.a.y, segment.b.y) / cell);
    const maxY = Math.floor(Math.max(segment.a.y, segment.b.y) / cell);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (const j of grid.get(key(x, y)) ?? []) {
          if (j <= i) continue;
          const other = segments[j]!;
          if (segment.kind === other.kind) {
            const distance = Math.min(Math.abs(segment.index - other.index), n - Math.abs(segment.index - other.index));
            if (distance <= 3) continue;
          } else {
            // edge vs its own centreline: skip geometrically coincident pairs
            const dx = (segment.a.x + segment.b.x) / 2 - (other.a.x + other.b.x) / 2;
            const dy = (segment.a.y + segment.b.y) / 2 - (other.a.y + other.b.y) / 2;
            if (Math.hypot(dx, dy) < 3 * TRACK.sampleStep) continue;
          }
          const pairKey = i * 1e7 + j;
          if (checked.has(pairKey)) continue;
          checked.add(pairKey);
          if (segmentsIntersect(segment.a, segment.b, other.a, other.b)) hits++;
        }
      }
    }
  });
  return hits;
}

/** Closest approach between an asphalt edge and a *different* section of the loop. */
function foreignSectionDistance(track: Track): number {
  const n = track.samples.length;
  const cell = 400;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const center = track.samples[i]!.pos;
    const k = `${Math.floor(center.x / cell)},${Math.floor(center.y / cell)}`;
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }
  const edges = [...track.leftEdge, ...track.rightEdge];
  let closest = Infinity;
  for (let e = 0; e < edges.length; e++) {
    const p = edges[e]!;
    const own = e % n;
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (const i of grid.get(`${x},${y}`) ?? []) {
          const distance = Math.min(Math.abs(i - own), n - Math.abs(i - own));
          if (distance < 60) continue;
          const d = Math.hypot(track.samples[i]!.pos.x - p.x, track.samples[i]!.pos.y - p.y);
          if (d < closest) closest = d;
        }
      }
    }
  }
  return closest;
}

describe('generateTrack: widened envelope hardening', () => {
  const SCAN_SEEDS = [13, 7932, 55446, 20261018, 23770, 99991, 424242, 7, 110879, 182150, 229664, 134636];

  it(
    'keeps corner radii, margins, bounds and the start straight safe across 36 tracks',
    { timeout: 180000 },
    () => {
      const halfField = TRACK.fieldSize / 2;
      // the start grid reaches this far behind the line (all rows, max field)
      const gridExtent = RACE.gridStartOffset + RACE.gridRowGap * (Math.ceil((RACE.maxOpponents + 1) / 2) - 1);
      for (const style of ['circuit', 'technical', 'speedway'] as const) {
        for (const seed of SCAN_SEEDS) {
          const track = generateTrack(seed, style);
          expect(track.samples.length).toBeGreaterThan(1000);

          // (a) every sample respects the curvature floor
          const n = track.samples.length;
          let tightest = Infinity;
          for (let i = 0; i < n; i++) {
            const r = circumRadius(track.samples[(i - 1 + n) % n]!.pos, track.samples[i]!.pos, track.samples[(i + 1) % n]!.pos);
            if (r < tightest) tightest = r;
          }
          expect(tightest).toBeGreaterThanOrEqual(TRACK.minRadius * 0.97);

          // (b) racing line stays inside the asphalt with a real margin
          let margin = Infinity;
          let lineTightest = Infinity;
          let maxOffset = 0;
          for (let i = 0; i < n; i++) {
            const sample = track.samples[i]!;
            const line = track.racingLine[i]!;
            const lateral = (line.x - sample.pos.x) * sample.normal.x + (line.y - sample.pos.y) * sample.normal.y;
            margin = Math.min(margin, sample.width / 2 - Math.abs(lateral));
            maxOffset = Math.max(maxOffset, Math.abs(lateral));
            const r = circumRadius(
              track.racingLine[(i - 1 + n) % n]!,
              track.racingLine[i]!,
              track.racingLine[(i + 1) % n]!,
            );
            if (r < lineTightest) lineTightest = r;
          }
          expect(margin).toBeGreaterThanOrEqual(12);
          expect(lineTightest).toBeGreaterThanOrEqual(TRACK.minRadius * 0.8);
          // still a real racing line: it cuts meaningfully inside the corners
          expect(maxOffset).toBeGreaterThanOrEqual(15);

          // (c) no folded or crossing asphalt edges and no section overlap
          expect(countEdgeIntersections(track)).toBe(0);
          expect(foreignSectionDistance(track)).toBeGreaterThan(TRACK.maxWidth);

          // (d) nothing leaves the playfield
          for (const p of [...track.leftEdge, ...track.rightEdge, ...track.samples.map((s) => s.pos)]) {
            expect(Math.abs(p.x)).toBeLessThanOrEqual(halfField);
            expect(Math.abs(p.y)).toBeLessThanOrEqual(halfField);
          }

          // (e) the start grid + launch zone sit on a gentle stretch
          for (let d = -gridExtent - 40; d <= gridExtent + 340; d += track.step) {
            const sample = track.at(d);
            const radius = Math.abs(sample.curvature) > 1e-7 ? 1 / Math.abs(sample.curvature) : Infinity;
            expect(radius).toBeGreaterThanOrEqual(400);
          }
        }
      }
    },
  );

  it('stays deterministic on the wider envelope', { timeout: 60000 }, () => {
    for (const style of ['circuit', 'technical', 'speedway'] as const) {
      for (const seed of SCAN_SEEDS.slice(0, 4)) {
        expect(serialize(generateTrack(seed, style))).toBe(serialize(generateTrack(seed, style)));
      }
    }
  });
});
