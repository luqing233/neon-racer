/**
 * NEON RACER — race state machine.
 *
 * OWNER: engine-dev.
 *
 * Responsibilities: grid start, countdown, fixed-step simulation of every racer,
 * direction-aware lap timing, race-distance standings, finish order, wrong-way and
 * off-road detection, car-to-car collisions, and respawning.
 *
 * Deterministic: same config + same player inputs ⇒ identical race. All per-racer
 * bookkeeping that is not part of the published RaceState lives in a WeakMap keyed
 * by the race object, so no state leaks between races and nothing grows unbounded.
 */

import { AI_NAMES, CAR_COLORS, CARS, DIFFICULTY, PHYSICS, RACE } from './config';
import type { DifficultyPreset } from './config';
import { createAIDriver, updateAIDriver } from './ai';
import { formatTime, mulberry32, shuffle, wrap } from './math';
import { racingLineLateralAt } from './track';
import { createCarState, stepCar } from './vehicle';
import type {
  AIDriver,
  CarInput,
  CarSpec,
  CarState,
  Progress,
  RaceConfig,
  RaceEvent,
  RaceState,
  Racer,
  StepOptions,
  Track,
  TrackSample,
  Vec2,
} from './types';

/* ---------------------------------------------------------------- internals -- */

interface RacerState {
  /** last wrapped arc length, for direction-aware crossing detection */
  prevS: number;
  /** signed arc length travelled since the last start-line crossing */
  lapProgress: number;
  /** true once the racer has crossed the line for the first time */
  crossedLine: boolean;
  offroadTime: number;
  offroadPenalised: boolean;
  wrongTime: number;
  collisionCooldown: number;
}

interface RaceInternals {
  racerStates: RacerState[];
  traffic: CarState[];
  stepOptions: StepOptions[];
  lastCountdownWhole: number;
  preset: DifficultyPreset;
  /** -1 until the racer crosses the finish line; then its index in finishedOrder */
  finishRank: number[];
}

const internals = new WeakMap<RaceState, RaceInternals>();

/** tolerance in units for "the racer really drove the lap" */
const LAP_PROGRESS_TOLERANCE = 90;
/** seconds of continuous off-road driving before a penalty */
const OFFROAD_GRACE = 1;
/** off-road time penalty, seconds */
const OFFROAD_PENALTY = 0.75;
/** collision event cooldown per car, seconds */
const COLLISION_COOLDOWN = 0.35;
const NEUTRAL_INPUT: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

/* ------------------------------------------------------------------- grid -- */

function gridPose(track: Track, index: number): { pos: Vec2; angle: number; s: number } {
  const row = Math.floor(index / 2);
  const col = index % 2 === 0 ? -1 : 1;
  // negative s = behind the start/finish line (wraps around the loop)
  const s = -RACE.gridStartOffset - row * RACE.gridRowGap;
  const sample = track.at(s);
  return {
    pos: {
      x: sample.pos.x + sample.normal.x * col * RACE.gridColOffset,
      y: sample.pos.y + sample.normal.y * col * RACE.gridColOffset,
    },
    angle: Math.atan2(sample.dir.y, sample.dir.x),
    s: wrap(s, track.length),
  };
}

/** Initial monotonic race distance: negative while sitting behind the line. */
function startDistance(wrappedS: number, length: number): number {
  let d = wrappedS % length;
  if (d > length / 2) d -= length;
  return d;
}

/* ---------------------------------------------------------------- progress -- */

function makeProgress(q: { s: number; lateral: number; onRoad: boolean }): Progress {
  return { s: q.s, lap: 0, totalS: 0, lateral: q.lateral, onRoad: q.onRoad };
}

function updateProgress(race: RaceState, racer: Racer, state: RacerState, q: { s: number; lateral: number; onRoad: boolean }, dt: number): void {
  const track = race.track;
  const d = track.deltaS(state.prevS, q.s);
  const s = q.s;

  racer.progress.s = s;
  racer.progress.lateral = q.lateral;
  racer.progress.onRoad = q.onRoad;
  // monotonic (signed) race distance; car reversing loses distance in the standings
  racer.progress.totalS += d;
  racer.progress.lap = racer.lap;

  state.lapProgress += d;

  const crossedForward = d > 0 && s < state.prevS;
  if (crossedForward) {
    const coveredLap = state.lapProgress >= track.length - LAP_PROGRESS_TOLERANCE;
    if (!state.crossedLine) {
      // first time over the line: this is where lap 1 is timed from
      state.crossedLine = true;
      racer.lapStartTime = race.time;
      state.lapProgress = 0;
    } else if (coveredLap) {
      completeLap(race, racer, state);
    } else {
      // forward re-cross without a full lap (e.g. after reversing over the line)
      state.lapProgress = 0;
    }
  } else if (d < 0 && s > state.prevS && state.crossedLine) {
    // backing over the line: that lap fraction no longer counts
    state.lapProgress = Math.min(0, state.lapProgress);
  }

  /* ---- off-road shortcut penalty ---------------------------------------- */
  if (!q.onRoad) {
    state.offroadTime += dt;
    if (state.offroadTime > OFFROAD_GRACE && !state.offroadPenalised) {
      state.offroadPenalised = true;
      racer.penalty += OFFROAD_PENALTY;
      pushEvent(race, { type: 'offroad', racerId: racer.id, value: OFFROAD_PENALTY });
    }
  } else {
    state.offroadTime = 0;
    state.offroadPenalised = false;
  }

  /* ---- wrong way warning ------------------------------------------------- */
  const movingBackwards = d < -0.01 && racer.car.speed > 22;
  if (movingBackwards) {
    state.wrongTime += dt;
  } else {
    state.wrongTime = Math.max(0, state.wrongTime - dt * 2);
    if (racer.wrongWay && state.wrongTime <= 0) racer.wrongWay = false;
  }
  if (state.wrongTime > RACE.wrongWayDelay && !racer.wrongWay) {
    racer.wrongWay = true;
    pushEvent(race, { type: 'wrong-way', racerId: racer.id });
  }

  state.prevS = s;
}

function completeLap(race: RaceState, racer: Racer, state: RacerState): void {
  const lapTime = race.time - racer.lapStartTime;
  state.lapProgress = 0;
  racer.lapStartTime = race.time;
  racer.totalTime = race.time;
  racer.lap += 1;
  racer.progress.lap = racer.lap;
  if (!Number.isFinite(lapTime) || lapTime <= 0) return;

  racer.lapTimes.push(lapTime);
  racer.lastLap = lapTime;
  const isBest = racer.bestLap == null || lapTime < racer.bestLap;
  if (isBest) racer.bestLap = lapTime;

  pushEvent(race, { type: 'lap', racerId: racer.id, value: racer.lap });
  if (isBest) pushEvent(race, { type: 'best-lap', racerId: racer.id, value: lapTime, text: formatTime(lapTime) });

  if (racer.lap >= race.config.laps && !racer.finished) {
    finishRacer(race, racer);
  }
}

function finishRacer(race: RaceState, racer: Racer): void {
  racer.finished = true;
  racer.finishTime = race.time + racer.penalty;
  race.finishedOrder.push(racer);
  const data = internals.get(race);
  if (data) data.finishRank[racer.id] = race.finishedOrder.length - 1;
  pushEvent(race, { type: 'finish', racerId: racer.id, value: race.finishedOrder.length });
  if (racer.isPlayer) race.phase = 'finished';
}

function pushEvent(race: RaceState, event: RaceEvent): void {
  // Events are drained by main.ts every frame; a hard cap protects headless runs
  // that never drain while still keeping the last few notifications meaningful.
  if (race.events.length < 512) race.events.push(event);
}

/* --------------------------------------------------------------- stepping --- */

export function createRace(config: RaceConfig, track: Track): RaceState {
  const rng = mulberry32((config.seed ^ 0x9e3779b9) >>> 0);
  const opponentCount = Math.max(0, Math.min(config.opponents, RACE.maxOpponents));
  const total = opponentCount + 1;
  const preset = DIFFICULTY[config.difficulty];
  const names = shuffle(rng, AI_NAMES);

  /** shared RNG so the whole AI field is deterministic for one seed */
  const aiRng = mulberry32((config.seed ^ 0x85ebca6b) >>> 0);

  const racers: Racer[] = [];
  const racerStates: RacerState[] = [];
  const traffic: CarState[] = [];
  const stepOptions: StepOptions[] = [];

  for (let i = 0; i < total; i++) {
    const isPlayer = i === 0;
    const pose = gridPose(track, i);
    const spec: CarSpec = CARS[config.carClass];
    const palette = CAR_COLORS[i % CAR_COLORS.length];
    const color = isPlayer ? (CAR_COLORS[0] as { color: string }).color : (palette as { color: string }).color;
    const accent = isPlayer ? (CAR_COLORS[0] as { accent: string }).accent : (palette as { accent: string }).accent;
    const car = createCarState(spec, pose.pos, pose.angle);
    const q = track.query(car.pos);
    const progress = makeProgress(q);
    progress.totalS = startDistance(pose.s, track.length);
    const racer: Racer = {
      id: i,
      name: isPlayer ? config.playerName || 'PLAYER' : (names[(i - 1) % names.length] as string),
      color,
      accent,
      isPlayer,
      spec,
      car,
      driver: isPlayer ? null : createAIDriver(i, config.difficulty, aiRng),
      input: { ...NEUTRAL_INPUT },
      progress,
      lap: 0,
      lapTimes: [],
      bestLap: null,
      lastLap: null,
      lapStartTime: 0,
      totalTime: 0,
      place: i + 1,
      finished: false,
      finishTime: null,
      wrongWay: false,
      penalty: 0,
    };
    racers.push(racer);
    racerStates.push({
      prevS: q.s,
      lapProgress: 0,
      crossedLine: false,
      offroadTime: 0,
      offroadPenalised: false,
      wrongTime: 0,
      collisionCooldown: 0,
    });
    traffic.push(car);
    stepOptions.push({});
  }

  const race: RaceState = {
    track,
    config,
    phase: 'countdown',
    countdown: RACE.countdownSeconds,
    time: 0,
    racers,
    player: racers[0] as Racer,
    standings: racers.slice(),
    finishedOrder: [],
    events: [],
  };
  internals.set(race, {
    racerStates,
    traffic,
    stepOptions,
    lastCountdownWhole: Math.ceil(RACE.countdownSeconds),
    preset,
    finishRank: new Array<number>(total).fill(-1),
  });
  updatePlaces(race);
  return race;
}

export function stepRace(race: RaceState, dt: number, playerInput: CarInput): void {
  const data = internals.get(race);
  if (!data) return;
  if (race.phase === 'finished') return;
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  const step = Math.min(dt, PHYSICS.subStep * 4);

  /* ---- countdown --------------------------------------------------------- */
  if (race.phase === 'countdown') {
    race.countdown -= step;
    const whole = Math.ceil(race.countdown);
    if (whole < data.lastCountdownWhole) {
      data.lastCountdownWhole = whole;
      if (whole >= 1) pushEvent(race, { type: 'countdown', racerId: race.player.id, value: whole });
    }
    if (race.countdown <= 0) {
      race.countdown = 0;
      race.phase = 'racing';
      race.time = 0;
      for (const racer of race.racers) racer.lapStartTime = 0;
      pushEvent(race, { type: 'go', racerId: race.player.id });
    }
    return;
  }

  race.time += step;

  /* ---- drive every car --------------------------------------------------- */
  for (let i = 0; i < race.racers.length; i++) {
    const racer = race.racers[i] as Racer;
    const car = racer.car;
    const state = data.racerStates[i] as RacerState;
    const opts = data.stepOptions[i] as StepOptions;

    let input: CarInput;
    if (racer.isPlayer) {
      input = playerInput ?? NEUTRAL_INPUT;
    } else if (racer.driver) {
      input = updateAIDriver(racer.driver as AIDriver, car, race.track, step, data.traffic);
    } else {
      input = NEUTRAL_INPUT;
    }
    racer.input = input;

    // surface-dependent physics options (grass is slow and slippery)
    const qBefore = race.track.query(car.pos);
    if (qBefore.surface === 'grass') {
      opts.gripScale = PHYSICS.grassGrip;
      opts.topSpeedScale = PHYSICS.grassDrag;
      opts.extraAccel = -PHYSICS.grassResist;
    } else if (qBefore.surface === 'curb') {
      opts.gripScale = PHYSICS.curbGrip;
      opts.topSpeedScale = 1;
      opts.extraAccel = 0;
    } else {
      opts.gripScale = 1;
      opts.topSpeedScale = 1;
      opts.extraAccel = 0;
    }
    if (!racer.isPlayer) opts.topSpeedScale *= data.preset.speedScale;

    const prevBoost = car.boostTime;
    const result = stepCar(car, racer.spec, input, step, race.track, opts);
    if (car.boostTime > prevBoost + 1e-3) pushEvent(race, { type: 'drift-boost', racerId: racer.id });
    if (result.impact > PHYSICS.crashImpactThreshold && state.collisionCooldown <= 0) {
      state.collisionCooldown = COLLISION_COOLDOWN;
      pushEvent(race, { type: 'collision', racerId: racer.id, value: result.impact });
    }

    state.collisionCooldown = Math.max(0, state.collisionCooldown - step);
    if (racer.finished) continue;

    const q = race.track.query(car.pos);
    updateProgress(race, racer, state, q, step);
  }

  /* ---- car-to-car collisions -------------------------------------------- */
  resolveCollisions(race, data);

  /* ---- standings --------------------------------------------------------- */
  updatePlaces(race);
}

/* ------------------------------------------------------------- collisions --- */

function resolveCollisions(race: RaceState, data: RaceInternals): void {
  const racers = race.racers;
  // A single pair-wise pass cannot fully separate a chain of three or more cars
  // (a later pair can push a car back into an earlier one), so positions are
  // relaxed a few times per step. Velocity impulses and events only happen on the
  // first pass, which keeps the response physical and avoids duplicate events.
  for (let iteration = 0; iteration < 4; iteration++) {
    let anyOverlap = false;
    for (let i = 0; i < racers.length; i++) {
      const a = racers[i] as Racer;
      for (let j = i + 1; j < racers.length; j++) {
        const b = racers[j] as Racer;
        const dx = b.car.pos.x - a.car.pos.x;
        const dy = b.car.pos.y - a.car.pos.y;
        const minDist = (a.spec.width + b.spec.width) * 0.62;
        const dist2 = dx * dx + dy * dy;
        if (dist2 >= minDist * minDist) continue;
        anyOverlap = true;
        const dist = Math.sqrt(dist2);
        let nx: number;
        let ny: number;
        if (dist > 1e-6) {
          nx = dx / dist;
          ny = dy / dist;
        } else {
          nx = 1;
          ny = 0;
        }
        const half = (minDist - dist) * 0.5;
        a.car.pos.x -= nx * half;
        a.car.pos.y -= ny * half;
        b.car.pos.x += nx * half;
        b.car.pos.y += ny * half;

        if (iteration > 0) continue;
        // relative normal velocity: negative = approaching
        const rvx = b.car.vel.x - a.car.vel.x;
        const rvy = b.car.vel.y - a.car.vel.y;
        const vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          const impulse = -vn * 0.6; // equal masses, restitution 0.2
          a.car.vel.x -= nx * impulse;
          a.car.vel.y -= ny * impulse;
          b.car.vel.x += nx * impulse;
          b.car.vel.y += ny * impulse;
          const impact = -vn;
          if (impact > PHYSICS.crashImpactThreshold) {
            a.car.vel.x *= 0.97;
            a.car.vel.y *= 0.97;
            b.car.vel.x *= 0.97;
            b.car.vel.y *= 0.97;
            a.car.angularVel *= 0.85;
            b.car.angularVel *= 0.85;
            const stateA = data.racerStates[i] as RacerState;
            const stateB = data.racerStates[j] as RacerState;
            if (stateA.collisionCooldown <= 0 && stateB.collisionCooldown <= 0) {
              stateA.collisionCooldown = COLLISION_COOLDOWN;
              stateB.collisionCooldown = COLLISION_COOLDOWN;
              const who = a.isPlayer || b.isPlayer ? race.player.id : a.id;
              pushEvent(race, { type: 'collision', racerId: who, value: impact });
            }
          }
        }
      }
    }
    if (!anyOverlap) break;
  }

  // refresh cached scalars after the separation passes
  for (const racer of racers) {
    const car = racer.car;
    car.speed = Math.hypot(car.vel.x, car.vel.y);
    car.forwardSpeed = car.vel.x * Math.cos(car.angle) + car.vel.y * Math.sin(car.angle);
  }
}

/* --------------------------------------------------------------- standings -- */

function compareRacers(a: Racer, b: Racer, finishRank: readonly number[]): number {
  if (a.finished !== b.finished) return a.finished ? -1 : 1;
  if (a.finished && b.finished) {
    // finishing order is the order cars crossed the line (penalties change the
    // recorded time, not the positions on the road)
    const ar = finishRank[a.id] ?? -1;
    const br = finishRank[b.id] ?? -1;
    if (ar !== br) return ar - br;
    return a.id - b.id;
  }
  if (a.progress.totalS !== b.progress.totalS) return b.progress.totalS - a.progress.totalS;
  if (a.lap !== b.lap) return b.lap - a.lap;
  return a.id - b.id;
}

function updatePlaces(race: RaceState): void {
  const data = internals.get(race);
  const finishRank = data ? data.finishRank : [];
  const standings = race.standings;
  standings.sort((a, b) => compareRacers(a, b, finishRank));
  for (let i = 0; i < standings.length; i++) (standings[i] as Racer).place = i + 1;
}

/* ---------------------------------------------------------------- respawn -- */

export function respawnRacer(race: RaceState, racerId: number): void {
  const data = internals.get(race);
  if (!data) return;
  const index = race.racers.findIndex((r) => r.id === racerId);
  if (index < 0) return;
  const racer = race.racers[index] as Racer;
  const state = data.racerStates[index] as RacerState;
  const car = racer.car;
  const track = race.track;

  const q = track.query(car.pos);
  const s = wrap(q.s, track.length);
  const indexLow = Math.floor(s / track.step) % track.samples.length;
  const sample = track.samples[indexLow] as TrackSample;
  const lat = racingLineLateralAt(track, s);
  const pos = {
    x: sample.pos.x + sample.normal.x * lat,
    y: sample.pos.y + sample.normal.y * lat,
  };

  car.pos = pos;
  car.angle = Math.atan2(sample.dir.y, sample.dir.x);
  car.vel = { x: 0, y: 0 };
  car.angularVel = 0;
  car.speed = 0;
  car.forwardSpeed = 0;
  car.steer = 0;
  car.slip = 0;
  car.drifting = false;
  car.driftTime = 0;
  car.driftCharge = 0;
  car.boostTime = 0;
  car.handbrake = false;
  car.crashCooldown = 0;
  car.surface = 'road';
  car.engineRpm = 0;
  car.gear = 1;

  racer.wrongWay = false;
  state.wrongTime = 0;
  state.offroadTime = 0;
  state.offroadPenalised = false;
  state.prevS = s;
  state.collisionCooldown = 0;
  racer.progress.s = s;
  racer.progress.lateral = lat;
  racer.progress.onRoad = true;
}
