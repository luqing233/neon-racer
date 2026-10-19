/**
 * NEON RACER — particles, skid marks and speed streaks.  OWNER: render-dev.
 *
 * Frozen contract:
 *   export function createEffects(): EffectsState
 *   export function updateEffects(fx: EffectsState, race: RaceState, dt: number): void
 *   export function drawEffects(ctx: CanvasRenderingContext2D, fx: EffectsState, camera: CameraState): void
 *   export function resetEffects(fx: EffectsState): void
 *
 * Rules of engagement
 *  - everything is driven from RaceState only (slip / drifting / boostTime /
 *    surface / crashCooldown / input.brake) — never from raw input events,
 *  - pooled and capped: <= 1400 live particles, <= 2500 skid segments,
 *  - no per-frame allocation in the hot paths (free lists + in-place compaction),
 *  - drawEffects() runs inside the camera transform: it keeps world coordinates
 *    and only ever culls with the camera centre + zoom.
 */

import { COLORS, PHYSICS } from './config';
import { clamp, clamp01, mulberry32, TAU } from './math';
import type { CameraState, EffectsState, Particle, ParticleKind, RaceState, SkidMark } from './types';

const PARTICLE_CAP = 1400;
const SKID_CAP = 2500;
/** world units between two skid segments of the same wheel */
const SKID_STEP = 15;
const BOOST_STEP = 26;
/** alpha per second bleed */
const FADE_TIRE = 0.03;
const FADE_BOOST = 1.15;
/** marks/particles are only laid for cars this close to the camera focus */
const NEAR_CAR = 2600;

const SMOKE_SLIP = 0.16;
const DUST_SPEED = 45;
const SPARK_SPEED_DROP = 120;

interface FxInner {
  rng: () => number;
  pool: Particle[];
  skidPool: SkidMark[];
  allocated: number;
  recycle: number;
  time: number;
  /** player speed factor, drives the speed streaks */
  speedFactor: number;
  boost: number;
  acc: Float64Array; // 5 accumulators per racer: smoke, dust, boost, spark, debris
  wheel: Float64Array; // 4 slots per racer: prev rear-left / rear-right anchor
  anchored: Uint8Array;
  prevCrash: Float64Array;
  prevSpeed: Float64Array;
  seen: Uint8Array;
  side: Uint8Array;
}

const ACC_SMOKE = 0;
const ACC_DUST = 1;
const ACC_BOOST = 2;
const ACC_SPARK = 3;
const ACC_SLOTS = 4;

const store = new WeakMap<EffectsState, FxInner>();

function innerOf(fx: EffectsState, create: boolean): FxInner | null {
  let s = store.get(fx);
  if (!s && create) {
    const n = 16;
    s = {
      rng: mulberry32(0x5eed1e),
      pool: [],
      skidPool: [],
      allocated: 0,
      recycle: 0,
      time: 0,
      speedFactor: 0,
      boost: 0,
      acc: new Float64Array(n * ACC_SLOTS),
      wheel: new Float64Array(n * 4),
      anchored: new Uint8Array(n),
      prevCrash: new Float64Array(n),
      prevSpeed: new Float64Array(n),
      seen: new Uint8Array(n),
      side: new Uint8Array(n),
    };
    store.set(fx, s);
  }
  return s ?? null;
}

function ensureSlots(s: FxInner, id: number): void {
  if (id < s.anchored.length) return;
  let size = s.anchored.length;
  while (size <= id) size *= 2;
  const acc = new Float64Array(size * ACC_SLOTS);
  acc.set(s.acc);
  s.acc = acc;
  const wheel = new Float64Array(size * 4);
  wheel.set(s.wheel);
  s.wheel = wheel;
  const prevCrash = new Float64Array(size);
  prevCrash.set(s.prevCrash);
  s.prevCrash = prevCrash;
  const prevSpeed = new Float64Array(size);
  prevSpeed.set(s.prevSpeed);
  s.prevSpeed = prevSpeed;
  const anchored = new Uint8Array(size);
  anchored.set(s.anchored);
  s.anchored = anchored;
  const seen = new Uint8Array(size);
  seen.set(s.seen);
  s.seen = seen;
  const side = new Uint8Array(size);
  side.set(s.side);
  s.side = side;
}

/* ------------------------------------------------------------------ spawn -- */

function newParticle(): Particle {
  return {
    pos: { x: 0, y: 0 },
    vel: { x: 0, y: 0 },
    life: 0,
    maxLife: 1,
    size: 1,
    color: '#fff',
    kind: 'smoke',
    drag: 1,
    angle: 0,
    spin: 0,
  };
}

function spawn(
  s: FxInner,
  fx: EffectsState,
  kind: ParticleKind,
  x: number,
  y: number,
  vx: number,
  vy: number,
  life: number,
  size: number,
  color: string,
  drag: number,
  spin: number,
): void {
  let p: Particle | undefined;
  let inList = false;
  const pool = s.pool;
  if (pool.length > 0) {
    p = pool.pop();
  } else if (s.allocated < PARTICLE_CAP) {
    p = newParticle();
    s.allocated++;
  } else {
    const live = fx.particles;
    const n = live.length;
    if (n === 0) return;
    p = live[s.recycle % n];
    s.recycle = (s.recycle + 1) % 8192;
    inList = true;
  }
  if (!p) return;
  p.pos.x = x;
  p.pos.y = y;
  p.vel.x = vx;
  p.vel.y = vy;
  p.life = life;
  p.maxLife = life;
  p.size = size;
  p.color = color;
  p.kind = kind;
  p.drag = drag;
  p.angle = s.rng() * TAU;
  p.spin = spin;
  if (!inList) fx.particles.push(p);
}

function pushSkid(
  s: FxInner,
  fx: EffectsState,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  alpha: number,
  width: number,
  kind: 'tire' | 'boost',
): void {
  const skids = fx.skids;
  let sk: SkidMark | undefined = s.skidPool.pop();
  if (!sk) sk = { a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, alpha: 0, width: 0, kind: 'tire' };
  sk.a.x = ax;
  sk.a.y = ay;
  sk.b.x = bx;
  sk.b.y = by;
  sk.alpha = alpha;
  // snapped so the batched draw can group marks by width
  sk.width = width < 6 ? 5.4 : width < 7.2 ? 6.6 : 7.8;
  sk.kind = kind;
  skids.push(sk);
  if (skids.length > SKID_CAP) {
    const drop = skids.splice(0, 32);
    for (let i = 0; i < drop.length; i++) s.skidPool.push(drop[i] as SkidMark);
  }
}

/* ----------------------------------------------------------------- update -- */

/** The internals are always created together with the EffectsState. */
function innerOfOrCreate(fx: EffectsState): FxInner {
  const s = innerOf(fx, true);
  if (!s) throw new Error('NEON RACER: effects state unavailable');
  return s;
}

export function createEffects(): EffectsState {
  const fx: EffectsState = { particles: [], skids: [] };
  innerOfOrCreate(fx);
  return fx;
}

export function resetEffects(fx: EffectsState): void {
  const s = innerOfOrCreate(fx);
  for (let i = 0; i < fx.particles.length; i++) s.pool.push(fx.particles[i] as Particle);
  for (let i = 0; i < fx.skids.length; i++) s.skidPool.push(fx.skids[i] as SkidMark);
  fx.particles.length = 0;
  fx.skids.length = 0;
  s.acc.fill(0);
  s.anchored.fill(0);
  s.prevCrash.fill(0);
  s.prevSpeed.fill(0);
  s.seen.fill(0);
  s.side.fill(0);
  s.time = 0;
  s.speedFactor = 0;
  s.boost = 0;
}

export function updateEffects(fx: EffectsState, race: RaceState, dt: number): void {
  const s = innerOfOrCreate(fx);
  let step = Number.isFinite(dt) ? dt : 1 / 60;
  if (step <= 0) step = 1 / 60;
  if (step > 1 / 20) step = 1 / 20;
  s.time += step;

  /* --------------------------------------------------------- integration -- */
  const ps = fx.particles;
  let write = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i] as Particle;
    p.life -= step;
    if (p.life <= 0) {
      s.pool.push(p);
      continue;
    }
    const dampen = Math.exp(-p.drag * step);
    p.vel.x *= dampen;
    p.vel.y *= dampen;
    p.pos.x += p.vel.x * step;
    p.pos.y += p.vel.y * step;
    p.angle += p.spin * step;
    ps[write++] = p;
  }
  ps.length = write;

  /* -------------------------------------------------------------- skids -- */
  const skids = fx.skids;
  let sw = 0;
  for (let i = 0; i < skids.length; i++) {
    const sk = skids[i] as SkidMark;
    sk.alpha -= (sk.kind === 'boost' ? FADE_BOOST : FADE_TIRE) * step;
    if (sk.alpha <= 0.012) {
      s.skidPool.push(sk);
      continue;
    }
    skids[sw++] = sk;
  }
  skids.length = sw;

  if (!race || !race.racers || !race.player) return;
  const player = race.player;
  const playerPos = player.car.pos;
  const top = Math.max(1, player.spec.topSpeed);
  const sf = clamp01(player.car.speed / top);
  s.speedFactor += (sf - s.speedFactor) * (1 - Math.exp(-4 * step));
  s.boost += ((player.car.boostTime > 0 ? 1 : 0) - s.boost) * (1 - Math.exp(-8 * step));

  const racers = race.racers;
  for (let r = 0; r < racers.length; r++) {
    const racer = racers[r];
    if (!racer || !racer.car) continue;
    const id = racer.id >= 0 ? racer.id | 0 : r;
    ensureSlots(s, id);
    const car = racer.car;
    const speed = Math.max(0, Number.isFinite(car.speed) ? car.speed : 0);
    const crash = Math.max(0, Number.isFinite(car.crashCooldown) ? car.crashCooldown : 0);
    const slip = clamp01(car.slip);
    const drifting = car.drifting;
    const offroad = car.surface === 'grass';
    const spec = racer.spec;
    const c = Math.cos(car.angle);
    const sn = Math.sin(car.angle);
    const px = car.pos.x;
    const py = car.pos.y;

    // rear axle + both rear wheels in world space
    const rearX = px - c * spec.length * 0.32;
    const rearY = py - sn * spec.length * 0.32;
    const hw = spec.width * 0.42;
    const wlx = rearX - sn * hw;
    const wly = rearY + c * hw;
    const wrx = rearX + sn * hw;
    const wry = rearY - c * hw;

    const accBase = id * ACC_SLOTS;

    /* ---------------------------------------------------------- impacts -- */
    let impact = 0;
    if (s.seen[id]) {
      const jump = crash - (s.prevCrash[id] as number);
      const drop = (s.prevSpeed[id] as number) - speed;
      if (jump > 0.015) impact = Math.max(impact, 0.5 + jump * 2.2);
      if (drop > SPARK_SPEED_DROP) impact = Math.max(impact, drop / PHYSICS.crashImpactThreshold);
    }
    s.seen[id] = 1;
    s.prevCrash[id] = crash;
    s.prevSpeed[id] = speed;

    const nearPlayer =
      racer.isPlayer ||
      Math.abs(px - playerPos.x) < NEAR_CAR + 800 ||
      Math.abs(py - playerPos.y) < NEAR_CAR + 800;

    if (impact > 0.6 && nearPlayer) {
      const power = clamp(impact, 0.6, 3);
      const dirX = speed > 1 ? car.vel.x / speed : c;
      const dirY = speed > 1 ? car.vel.y / speed : sn;
      const nSparks = Math.round(6 + power * 8);
      for (let i = 0; i < nSparks; i++) {
        const a = s.rng() * TAU;
        const v = 70 + s.rng() * 190 * power;
        spawn(
          s,
          fx,
          'spark',
          px + c * spec.length * 0.42 + (s.rng() - 0.5) * spec.width,
          py + sn * spec.length * 0.42 + (s.rng() - 0.5) * spec.width,
          -dirX * 60 + Math.cos(a) * v,
          -dirY * 60 + Math.sin(a) * v,
          0.18 + s.rng() * 0.34,
          1.6 + s.rng() * 2.4,
          COLORS.spark,
          2.6,
          (s.rng() - 0.5) * 18,
        );
      }
      if (power > 1.3) {
        const nDebris = Math.round(3 + power * 3);
        for (let i = 0; i < nDebris; i++) {
          const a = s.rng() * TAU;
          const v = 40 + s.rng() * 150;
          spawn(
            s,
            fx,
            'debris',
            px + (s.rng() - 0.5) * spec.length * 0.6,
            py + (s.rng() - 0.5) * spec.length * 0.6,
            Math.cos(a) * v,
            Math.sin(a) * v,
            0.7 + s.rng() * 0.9,
            2.6 + s.rng() * 3.4,
            racer.color,
            1.3,
            (s.rng() - 0.5) * 22,
          );
        }
        // a puff of tyre smoke on the hit
        for (let i = 0; i < 8; i++) {
          const a = s.rng() * TAU;
          spawn(
            s,
            fx,
            'smoke',
            px + (s.rng() - 0.5) * spec.length,
            py + (s.rng() - 0.5) * spec.length,
            Math.cos(a) * 60,
            Math.sin(a) * 60,
            0.5 + s.rng() * 0.5,
            9 + s.rng() * 10,
            COLORS.smoke,
            1.5,
            0,
          );
        }
      }
    }
    // scraping along a barrier: a thin trickle of sparks
    if (crash > 0 && speed > 60 && nearPlayer) {
      const acc = (s.acc[accBase + ACC_SPARK] as number) + step * 22;
      let n = Math.floor(acc);
      s.acc[accBase + ACC_SPARK] = acc - n;
      const side = s.side[id] ?? 0;
      while (n-- > 0) {
        const sx = side ? wrx : wlx;
        const sy = side ? wry : wly;
        spawn(
          s,
          fx,
          'spark',
          sx,
          sy,
          -car.vel.x * 0.25 + (s.rng() - 0.5) * 120,
          -car.vel.y * 0.25 + (s.rng() - 0.5) * 120,
          0.12 + s.rng() * 0.22,
          1.3 + s.rng() * 1.8,
          COLORS.spark,
          3,
          0,
        );
      }
      s.side[id] = side ? 0 : 1;
    }

    /* -------------------------------------------------------- skid marks -- */
    const braking = racer.input ? racer.input.brake : 0;
    const scrubbing =
      speed > 35 &&
      (slip > SMOKE_SLIP || drifting || car.handbrake || (braking > 0.35 && speed > 80));
    const boosting = car.boostTime > 0 && speed > 50;

    if (!s.anchored[id]) {
      s.anchored[id] = 1;
      s.wheel[id * 4] = wlx;
      s.wheel[id * 4 + 1] = wly;
      s.wheel[id * 4 + 2] = wrx;
      s.wheel[id * 4 + 3] = wry;
    }

    const ax = s.wheel[id * 4] as number;
    const ay = s.wheel[id * 4 + 1] as number;
    const bx = s.wheel[id * 4 + 2] as number;
    const by = s.wheel[id * 4 + 3] as number;

    const strength = clamp01(Math.max(slip * 1.3, drifting ? 0.5 : 0, braking * 0.7, car.handbrake ? 0.6 : 0));
    if (scrubbing && nearPlayer) {
      const dl = Math.hypot(wlx - ax, wly - ay);
      const dr = Math.hypot(wrx - bx, wry - by);
      const gap = Math.max(dl, dr);
      if (gap > SKID_STEP) {
        const alpha = clamp(0.22 + strength * 0.72, 0.16, 0.95);
        const width = 5.2 + strength * 2.6;
        pushSkid(s, fx, ax, ay, wlx, wly, alpha, width, 'tire');
        pushSkid(s, fx, bx, by, wrx, wry, alpha, width, 'tire');
        s.wheel[id * 4] = wlx;
        s.wheel[id * 4 + 1] = wly;
        s.wheel[id * 4 + 2] = wrx;
        s.wheel[id * 4 + 3] = wry;
      }
    } else {
      s.wheel[id * 4] = wlx;
      s.wheel[id * 4 + 1] = wly;
      s.wheel[id * 4 + 2] = wrx;
      s.wheel[id * 4 + 3] = wry;
    }

    if (boosting && nearPlayer) {
      const dl = Math.hypot(wlx - ax, wly - ay);
      if (dl > BOOST_STEP) {
        pushSkid(s, fx, ax, ay, wlx, wly, 0.5, 7.4, 'boost');
        pushSkid(s, fx, bx, by, wrx, wry, 0.5, 7.4, 'boost');
      }
    }

    if (!nearPlayer) continue;

    /* ------------------------------------------------------------ smoke -- */
    const smoking = speed > 55 && (slip > 0.2 || drifting);
    if (smoking) {
      const rate = 9 + slip * 38 + (drifting ? 12 : 0);
      const acc = (s.acc[accBase + ACC_SMOKE] as number) + step * rate;
      let n = Math.min(6, Math.floor(acc));
      s.acc[accBase + ACC_SMOKE] = acc - Math.floor(acc);
      const side = (s.side[id] ?? 0) === 1;
      while (n-- > 0) {
        const ox = side ? wrx : wlx;
        const oy = side ? wry : wly;
        const spread = 26 + slip * 40;
        spawn(
          s,
          fx,
          'smoke',
          ox + (s.rng() - 0.5) * 12,
          oy + (s.rng() - 0.5) * 12,
          car.vel.x * 0.16 + (s.rng() - 0.5) * spread,
          car.vel.y * 0.16 + (s.rng() - 0.5) * spread,
          0.5 + s.rng() * 0.7,
          7 + s.rng() * 9 + slip * 6,
          COLORS.smoke,
          1.7,
          (s.rng() - 0.5) * 3,
        );
      }
    } else {
      s.acc[accBase + ACC_SMOKE] = 0;
    }

    /* ------------------------------------------------------------- dust -- */
    if (offroad && speed > DUST_SPEED) {
      const rate = 8 + speed / 40;
      const acc = (s.acc[accBase + ACC_DUST] as number) + step * rate;
      let n = Math.min(5, Math.floor(acc));
      s.acc[accBase + ACC_DUST] = acc - Math.floor(acc);
      while (n-- > 0) {
        spawn(
          s,
          fx,
          'dust',
          px - c * spec.length * 0.4 + (s.rng() - 0.5) * spec.width,
          py - sn * spec.length * 0.4 + (s.rng() - 0.5) * spec.width,
          car.vel.x * 0.2 + (s.rng() - 0.5) * 44,
          car.vel.y * 0.2 + (s.rng() - 0.5) * 44,
          0.45 + s.rng() * 0.6,
          6 + s.rng() * 8,
          COLORS.dust,
          1.9,
          (s.rng() - 0.5) * 2,
        );
      }
    } else {
      s.acc[accBase + ACC_DUST] = 0;
    }

    /* ------------------------------------------------------------ boost -- */
    if (car.boostTime > 0) {
      const acc = (s.acc[accBase + ACC_BOOST] as number) + step * 58;
      let n = Math.min(8, Math.floor(acc));
      s.acc[accBase + ACC_BOOST] = acc - Math.floor(acc);
      const back = spec.length * 0.5;
      while (n-- > 0) {
        const hot = s.rng() < 0.45;
        spawn(
          s,
          fx,
          'boost',
          px - c * back + (s.rng() - 0.5) * spec.width * 0.5,
          py - sn * back + (s.rng() - 0.5) * spec.width * 0.5,
          -c * (70 + s.rng() * 120) + car.vel.x * 0.35,
          -sn * (70 + s.rng() * 120) + car.vel.y * 0.35,
          0.12 + s.rng() * 0.2,
          5 + s.rng() * 6,
          hot ? COLORS.boostHot : COLORS.boost,
          3.2,
          0,
        );
      }
    } else {
      s.acc[accBase + ACC_BOOST] = 0;
    }
  }
}

/* ------------------------------------------------------------------ draw -- */

interface Sprites {
  smoke: HTMLCanvasElement | null;
  dust: HTMLCanvasElement | null;
  spark: HTMLCanvasElement | null;
  boost: HTMLCanvasElement | null;
  glowCyan: HTMLCanvasElement | null;
  glowPink: HTMLCanvasElement | null;
}

let sprites: Sprites | null = null;

function blob(size: number, stops: Array<[number, string]>): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g2 = c.getContext('2d');
  if (!g2) return null;
  const g = g2.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, color] of stops) g.addColorStop(at, color);
  g2.fillStyle = g;
  g2.fillRect(0, 0, size, size);
  return c;
}

function ensureSprites(): Sprites {
  if (!sprites) {
    sprites = {
      smoke: blob(64, [
        [0, 'rgba(236,242,255,0.95)'],
        [0.42, 'rgba(186,204,244,0.4)'],
        [1, 'rgba(150,175,225,0)'],
      ]),
      dust: blob(64, [
        [0, 'rgba(178,194,238,0.8)'],
        [0.5, 'rgba(120,140,200,0.28)'],
        [1, 'rgba(90,110,170,0)'],
      ]),
      spark: blob(32, [
        [0, 'rgba(255,255,255,1)'],
        [0.3, 'rgba(255,228,130,0.95)'],
        [0.65, 'rgba(255,170,60,0.35)'],
        [1, 'rgba(255,120,40,0)'],
      ]),
      boost: blob(64, [
        [0, 'rgba(255,255,238,1)'],
        [0.28, 'rgba(255,214,90,0.9)'],
        [0.62, 'rgba(255,120,50,0.32)'],
        [1, 'rgba(255,60,160,0)'],
      ]),
      glowCyan: blob(96, [
        [0, 'rgba(0,240,255,0.85)'],
        [0.35, 'rgba(0,190,255,0.3)'],
        [1, 'rgba(0,120,255,0)'],
      ]),
      glowPink: blob(96, [
        [0, 'rgba(255,46,99,0.8)'],
        [0.4, 'rgba(255,46,99,0.25)'],
        [1, 'rgba(255,46,99,0)'],
      ]),
    };
  }
  return sprites;
}

/** Cheap deterministic hash in [0,1). */
function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function drawEffects(ctx: CanvasRenderingContext2D, fx: EffectsState, camera: CameraState): void {
  const s = innerOf(fx, false);
  const cx = camera && Number.isFinite(camera.pos.x) ? camera.pos.x : 0;
  const cy = camera && Number.isFinite(camera.pos.y) ? camera.pos.y : 0;
  const zoom = clamp(camera && Number.isFinite(camera.zoom) ? camera.zoom : 1, 0.15, 3);
  const range = 1150 / zoom + 240;
  const r2 = range * range;
  const spr = ensureSprites();

  /* -------------------------------------------------------- speed lines -- */
  if (s && s.speedFactor > 0.4) {
    const k = clamp01((s.speedFactor - 0.4) / 0.6);
    const n = 18 + Math.round(k * 14);
    const len = 70 + k * 260;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.12 + 0.34 * k;
    ctx.strokeStyle = 'rgba(150,232,255,0.85)';
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.1 + k * 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + hash01(i * 13 + 5) * 0.7;
      const speedPhase = 0.28 + k * 0.85;
      const phase = (hash01(i * 7 + 11) + s.time * speedPhase) % 1;
      const r0 = 150 + phase * (range - 190);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const stretch = len * (0.25 + phase * 0.9);
      ctx.moveTo(cx + ca * r0, cy + sa * r0);
      ctx.lineTo(cx + ca * (r0 + stretch), cy + sa * (r0 + stretch));
    }
    ctx.stroke();
    ctx.restore();
  }

  /* --------------------------------------------------------- skid marks -- */
  const skids = fx.skids;
  if (skids.length > 0) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // tire rubber: 3 width classes x 4 alpha buckets, batched into a handful
    // of strokes instead of one stroke per mark.
    for (let wc = 0; wc < 3; wc++) {
      const width = wc === 0 ? 5.4 : wc === 1 ? 6.6 : 7.8;
      for (let b = 0; b < 4; b++) {
        const lo = b * 0.25;
        const hi = lo + 0.25;
        let started = false;
        for (let i = 0; i < skids.length; i++) {
          const sk = skids[i] as SkidMark;
          if (sk.kind !== 'tire') continue;
          const a = sk.alpha;
          if (a <= lo || a > hi) continue;
          if (sk.width < width - 0.6 || sk.width > width + 0.6) continue;
          const mx = (sk.a.x + sk.b.x) * 0.5 - cx;
          const my = (sk.a.y + sk.b.y) * 0.5 - cy;
          if (mx * mx + my * my > r2) continue;
          if (!started) {
            ctx.beginPath();
            started = true;
          }
          ctx.moveTo(sk.a.x, sk.a.y);
          ctx.lineTo(sk.b.x, sk.b.y);
        }
        if (started) {
          ctx.globalAlpha = Math.min(1, (lo + hi) * 0.5) * 0.85;
          ctx.strokeStyle = '#0a0d18';
          ctx.lineWidth = width;
          ctx.stroke();
        }
      }
    }
    // boost streaks: additive neon
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = 'rgba(120,236,255,0.9)';
    ctx.lineWidth = 7.4;
    ctx.beginPath();
    let boostStarted = false;
    for (let i = 0; i < skids.length; i++) {
      const sk = skids[i] as SkidMark;
      if (sk.kind !== 'boost') continue;
      const mx = (sk.a.x + sk.b.x) * 0.5 - cx;
      const my = (sk.a.y + sk.b.y) * 0.5 - cy;
      if (mx * mx + my * my > r2) continue;
      ctx.moveTo(sk.a.x, sk.a.y);
      ctx.lineTo(sk.b.x, sk.b.y);
      boostStarted = true;
    }
    if (boostStarted) ctx.stroke();
    ctx.restore();
  }

  /* ----------------------------------------------------------- particles -- */
  const ps = fx.particles;
  if (ps.length === 0) return;

  // pass 0: smoke + dust (soft blobs), pass 1: sparks, pass 2: boost, pass 3: debris
  ctx.save();
  for (let pass = 0; pass < 4; pass++) {
    if (pass === 3) {
      ctx.globalCompositeOperation = 'source-over';
    } else if (pass === 1 || pass === 2) {
      ctx.globalCompositeOperation = 'lighter';
    } else {
      ctx.globalCompositeOperation = 'source-over';
    }
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i] as Particle;
      const kind = p.kind;
      const isSmoke = kind === 'smoke';
      const isDust = kind === 'dust';
      const isSpark = kind === 'spark';
      const isBoost = kind === 'boost';
      const isDebris = kind === 'debris';
      if (pass === 0 && !isSmoke && !isDust) continue;
      if (pass === 1 && !isSpark) continue;
      if (pass === 2 && !isBoost) continue;
      if (pass === 3 && !isDebris) continue;

      const dx = p.pos.x - cx;
      const dy = p.pos.y - cy;
      if (dx * dx + dy * dy > r2) continue;
      const t = clamp01(p.life / p.maxLife);
      const age = 1 - t;

      if (isSpark) {
        const size = p.size * (0.5 + t * 0.7) * 5;
        ctx.globalAlpha = Math.min(1, t * 1.5);
        if (spr.spark) ctx.drawImage(spr.spark, p.pos.x - size * 0.5, p.pos.y - size * 0.5, size, size);
        else {
          ctx.fillStyle = COLORS.spark;
          ctx.fillRect(p.pos.x - size * 0.25, p.pos.y - size * 0.25, size * 0.5, size * 0.5);
        }
      } else if (isBoost) {
        const size = p.size * (1.6 + age * 1.9);
        ctx.globalAlpha = Math.min(1, t * 1.15) * 0.9;
        if (spr.boost) ctx.drawImage(spr.boost, p.pos.x - size * 0.5, p.pos.y - size * 0.5, size, size);
      } else if (isDebris) {
        const size = p.size * (0.7 + t * 0.5);
        ctx.globalAlpha = Math.min(0.95, t * 1.4);
        ctx.save();
        ctx.translate(p.pos.x, p.pos.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = '#141a2e';
        ctx.fillRect(-size * 0.5, -size * 0.35, size, size * 0.7);
        ctx.fillStyle = p.color;
        ctx.globalAlpha *= 0.55;
        ctx.fillRect(-size * 0.5, -size * 0.35, size, size * 0.28);
        ctx.restore();
      } else {
        const growth = isDust ? 1.55 : 2.15;
        const size = p.size * (0.85 + age * growth);
        const alpha = isDust ? 0.5 : 0.72;
        ctx.globalAlpha = t * t * alpha;
        const img = isDust ? spr.dust : spr.smoke;
        if (img) ctx.drawImage(img, p.pos.x - size * 0.5, p.pos.y - size * 0.5, size, size);
        else {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.pos.x, p.pos.y, size * 0.5, 0, TAU);
          ctx.fill();
        }
      }
    }
  }
  ctx.restore();
}
