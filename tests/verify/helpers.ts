/**
 * Shared helpers for the independent verification suite (tests/verify/*).
 *
 * IMPORTANT: these tests are written against the FROZEN public contracts only —
 * generateTrack(seed, style), createRace(config, track), stepRace(race, dt, input),
 * plus the tuning constants in src/game/config.ts. They deliberately do not use
 * engine-dev's own tests or private module internals, so they can catch an
 * implementation that is "self-consistently wrong".
 */

import { CARS, PHYSICS, RACE, TRACK } from '../../src/game/config';
import { createRace, stepRace } from '../../src/game/race';
import { generateTrack } from '../../src/game/track';
import type {
  CarInput,
  RaceConfig,
  RaceState,
  Racer,
  Track,
  TrackStyle,
} from '../../src/game/types';

export const TEST_SEED = 20261018;
export const BASE_CONFIG: RaceConfig = {
  seed: TEST_SEED,
  style: 'circuit',
  laps: 1,
  opponents: 3,
  difficulty: 'normal',
  carClass: 'balanced',
  playerName: 'VERIFIER',
};

export const NEUTRAL: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

export function makeTrack(seed: number = TEST_SEED, style: TrackStyle = 'circuit'): Track {
  return generateTrack(seed, style);
}

export function makeRace(overrides: Partial<RaceConfig> = {}, style: TrackStyle = 'circuit'): RaceState {
  const config: RaceConfig = { ...BASE_CONFIG, ...overrides, style: overrides.style ?? style };
  return createRace(config, makeTrack(config.seed, config.style));
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** Wrap an angle (radians) into (-PI, PI]. */
export function wrapAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Deep-scan any object graph (skipping functions) for NaN/Infinity, reporting
 * dotted paths so failures are actionable. Cycle-safe and depth-limited.
 */
export function findNonFinite(root: unknown, rootPath = 'race'): string[] {
  const bad: string[] = [];
  const seen = new Set<object>();
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 14) return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) bad.push(`${path} = ${value}`);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, 4000);
      for (let i = 0; i < limit; i++) walk(value[i], `${path}[${i}]`, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) walk(record[key], `${path}.${key}`, depth + 1);
  };
  walk(root, rootPath, 0);
  return bad;
}

/** Every numeric field of a racer (used by per-step invariant sweeps). */
export function racerNumbers(racer: Racer): { path: string; value: number }[] {
  const car = racer.car;
  return [
    { path: 'car.pos.x', value: car.pos.x },
    { path: 'car.pos.y', value: car.pos.y },
    { path: 'car.angle', value: car.angle },
    { path: 'car.vel.x', value: car.vel.x },
    { path: 'car.vel.y', value: car.vel.y },
    { path: 'car.angularVel', value: car.angularVel },
    { path: 'car.speed', value: car.speed },
    { path: 'car.forwardSpeed', value: car.forwardSpeed },
    { path: 'car.steer', value: car.steer },
    { path: 'car.slip', value: car.slip },
    { path: 'car.driftTime', value: car.driftTime },
    { path: 'car.driftCharge', value: car.driftCharge },
    { path: 'car.boostTime', value: car.boostTime },
    { path: 'car.engineRpm', value: car.engineRpm },
    { path: 'car.gear', value: car.gear },
    { path: 'car.crashCooldown', value: car.crashCooldown },
    { path: 'progress.s', value: racer.progress.s },
    { path: 'progress.totalS', value: racer.progress.totalS },
    { path: 'progress.lateral', value: racer.progress.lateral },
    { path: 'lap', value: racer.lap },
    { path: 'place', value: racer.place },
    { path: 'totalTime', value: racer.totalTime },
    { path: 'penalty', value: racer.penalty },
  ];
}

/** Advance a race by `seconds` of fixed substeps, driving the player with `inputFor`. */
export function simulate(
  race: RaceState,
  seconds: number,
  inputFor: (race: RaceState, step: number) => CarInput,
  onStep?: (race: RaceState, step: number) => void,
): number {
  const dt = PHYSICS.subStep;
  const steps = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < steps; i++) {
    if (race.phase === 'finished') return i;
    stepRace(race, dt, inputFor(race, i));
    onStep?.(race, i);
  }
  return steps;
}

/** Step until the countdown ends (needed before steering/accelerating for real). */
export function settleCountdown(race: RaceState): void {
  const dt = PHYSICS.subStep;
  let guard = 0;
  while (race.phase === 'countdown' && guard < 1000) {
    stepRace(race, dt, NEUTRAL);
    guard += 1;
  }
}

/**
 * Learn the sign convention of `CarInput.steer` from the simulation itself:
 * positive steer normally increases or decreases `car.angle` depending on the
 * implementation. Returns +1 when positive steer increases the heading angle.
 */
export function calibrateSteerSign(): number {
  const race = makeRace({ opponents: 0 });
  settleCountdown(race);
  const dt = PHYSICS.subStep;
  const straight: CarInput = { throttle: 1, brake: 0, steer: 0, handbrake: false };
  for (let i = 0; i < 240; i++) stepRace(race, dt, straight);
  const before = race.player.car.angle;
  for (let i = 0; i < 90; i++) {
    stepRace(race, dt, { throttle: 1, brake: 0, steer: 1, handbrake: false });
  }
  const delta = wrapAngle(race.player.car.angle - before);
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-6) return 1; // frozen/unknown: default
  return delta > 0 ? 1 : -1;
}

/**
 * Independent pure-pursuit driver used by the behavioural tests. It only reads
 * the public RaceState/Racer fields, never any private engine helpers.
 */
export class Autopilot {
  private readonly steerSign: number;
  private stuckTime = 0;

  constructor(steerSign: number) {
    this.steerSign = steerSign;
  }

  input(race: RaceState): CarInput {
    const p = race.player;
    const track = race.track;
    const speed = p.car.speed;
    const look = clamp(95 + speed * 0.55, 85, 380);
    const target = track.posAt(((p.progress.s + look) % track.length + track.length) % track.length);
    const desired = Math.atan2(target.y - p.car.pos.y, target.x - p.car.pos.x);
    const error = wrapAngle(desired - p.car.angle);
    let steer = clamp(error * 2.6, -1, 1) * this.steerSign;

    const top = p.spec.topSpeed;
    let throttle = speed < top * 0.9 ? 1 : 0.55;
    let brake = 0;
    let handbrake = false;

    const ahead = track.at((p.progress.s + 200) % track.length);
    const demand = Math.abs(ahead.curvature) * speed * speed;
    if (demand > 1300 && speed > 240) {
      brake = clamp((demand - 1300) / 2600, 0.1, 0.9);
      throttle = 0;
    }

    if (speed < 15 && race.phase === 'racing') {
      this.stuckTime += PHYSICS.subStep;
      if (this.stuckTime > 1) {
        steer = -steer;
        return { throttle: 0, brake: 1, steer, handbrake: false };
      }
    } else {
      this.stuckTime = 0;
    }

    return { throttle, brake, steer, handbrake };
  }
}

/** Compact serialisation of a race used by the determinism tests. */
export function raceSnapshot(race: RaceState): string {
  return JSON.stringify({
    phase: race.phase,
    countdown: race.countdown,
    time: race.time,
    racers: race.racers.map((r) => ({
      id: r.id,
      name: r.name,
      lap: r.lap,
      place: r.place,
      finished: r.finished,
      finishTime: r.finishTime,
      bestLap: r.bestLap,
      lastLap: r.lastLap,
      lapTimes: r.lapTimes,
      totalTime: r.totalTime,
      progress: {
        s: r.progress.s,
        lap: r.progress.lap,
        totalS: r.progress.totalS,
        lateral: r.progress.lateral,
      },
      pos: { x: r.car.pos.x, y: r.car.pos.y },
      angle: r.car.angle,
      speed: r.car.speed,
      forwardSpeed: r.car.forwardSpeed,
      drifting: r.car.drifting,
      wrongWay: r.wrongWay,
    })),
    standings: race.standings.map((r) => r.id),
    finishedOrder: race.finishedOrder.map((r) => r.id),
  });
}

/** Track sample snapshot used to prove track generation determinism. */
export function trackSnapshot(track: Track): string {
  return JSON.stringify({
    seed: track.seed,
    style: track.style,
    name: track.name,
    length: track.length,
    step: track.step,
    startIndex: track.startIndex,
    bounds: track.bounds,
    samples: track.samples.slice(0, 64).map((s) => ({
      pos: s.pos,
      dir: s.dir,
      normal: s.normal,
      curvature: s.curvature,
      width: s.width,
      s: s.s,
    })),
  });
}

/** Handy constant exports so tests don't re-import config all the time. */
export { CARS, PHYSICS, RACE, TRACK };
