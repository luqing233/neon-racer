/**
 * Unit tests for src/game/vehicle.ts — arcade physics, walls, surfaces, drift/boost.
 * OWNER: engine-dev.
 */

import { describe, expect, it } from 'vitest';
import { CARS, PHYSICS, TRACK } from '../../src/game/config';
import { generateTrack } from '../../src/game/track';
import { createCarState, stepCar } from '../../src/game/vehicle';
import type { CarInput, CarSpec, CarState, StepOptions, Track, TrackQuery, Vec2 } from '../../src/game/types';

const dt = PHYSICS.subStep;
const NEUTRAL: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

/** A "parking lot": physics without barriers, everything is road. */
function openTrack(base: Track): Track {
  const openQuery = (p: Vec2): TrackQuery => ({
    index: 0,
    s: 0,
    lateral: 0,
    center: p,
    dir: { x: 1, y: 0 },
    normal: { x: 0, y: -1 },
    width: 1e9,
    surface: 'road',
    onRoad: true,
    radius: Infinity,
  });
  return { ...base, query: openQuery };
}

function spawn(spec: CarSpec, angle = 0, speed = 0): CarState {
  const car = createCarState(spec, { x: 0, y: 0 }, angle);
  car.vel = { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed };
  car.speed = speed;
  car.forwardSpeed = speed;
  return car;
}

function assertFinite(car: CarState): void {
  for (const v of [car.pos.x, car.pos.y, car.angle, car.vel.x, car.vel.y, car.angularVel, car.speed, car.steer, car.slip, car.driftCharge, car.engineRpm]) {
    expect(Number.isFinite(v)).toBe(true);
  }
  expect(car.gear).toBeGreaterThanOrEqual(1);
  expect(car.gear).toBeLessThanOrEqual(6);
  expect(car.slip).toBeGreaterThanOrEqual(0);
  expect(car.slip).toBeLessThanOrEqual(1);
  expect(car.driftCharge).toBeGreaterThanOrEqual(0);
  expect(car.driftCharge).toBeLessThanOrEqual(1);
}

const open = openTrack(generateTrack(20261018, 'speedway'));

describe('stepCar: straight line', () => {
  it('full throttle for 10 s is a soft-capped top speed and never NaNs', () => {
    for (const key of ['balanced', 'drifter', 'speedster'] as const) {
      const spec = CARS[key];
      const car = spawn(spec);
      const input: CarInput = { ...NEUTRAL, throttle: 1 };
      let maxSpeed = 0;
      for (let i = 0; i < Math.round(10 / dt); i++) {
        stepCar(car, spec, input, dt, open);
        maxSpeed = Math.max(maxSpeed, car.speed);
        if (i % 300 === 0) assertFinite(car);
      }
      assertFinite(car);
      expect(car.speed).toBeLessThan(spec.topSpeed * 1.15);
      expect(car.speed).toBeGreaterThan(spec.topSpeed * 0.9);
      expect(maxSpeed).toBeLessThan(spec.topSpeed * 1.15);
      expect(car.engineRpm).toBeGreaterThan(0.5);
      expect(car.surface).toBe('road');
    }
  });

  it('reaches a sane speed within 4 seconds and keeps HUD fields valid', () => {
    const spec = CARS.balanced;
    const car = spawn(spec);
    for (let i = 0; i < Math.round(4 / dt); i++) stepCar(car, spec, { ...NEUTRAL, throttle: 1 }, dt, open);
    expect(car.speed).toBeGreaterThan(spec.topSpeed * 0.75);
    expect(car.engineRpm).toBeGreaterThan(0);
    expect(car.gear).toBeGreaterThanOrEqual(1);
  });

  it('brakes to a stop and then reverses up to the reverse cap', () => {
    const spec = CARS.balanced;
    const car = spawn(spec, 0, 0);
    for (let i = 0; i < Math.round(6 / dt); i++) stepCar(car, spec, { ...NEUTRAL, throttle: 1 }, dt, open);
    const top = car.speed;
    let minAbsSpeed = Infinity;
    for (let i = 0; i < Math.round(0.7 / dt); i++) {
      stepCar(car, spec, { ...NEUTRAL, brake: 1 }, dt, open);
      minAbsSpeed = Math.min(minAbsSpeed, Math.abs(car.speed));
    }
    expect(minAbsSpeed).toBeLessThan(top * 0.12);
    for (let i = 0; i < Math.round(4 / dt); i++) stepCar(car, spec, { ...NEUTRAL, brake: 1 }, dt, open);
    assertFinite(car);
    expect(car.forwardSpeed).toBeLessThan(-10);
    expect(Math.abs(car.speed)).toBeLessThanOrEqual(spec.reverseSpeed * 1.1);
  });

  it('is deterministic for identical input sequences', () => {
    const spec = CARS.drifter;
    const a = spawn(spec, 0.2, 300);
    const b = spawn(spec, 0.2, 300);
    for (let i = 0; i < Math.round(6 / dt); i++) {
      const input: CarInput = {
        throttle: 0.8,
        brake: 0,
        steer: Math.sin(i * dt * 2.3) * 0.8,
        handbrake: i % 240 < 60,
      };
      stepCar(a, spec, input, dt, open);
      stepCar(b, spec, input, dt, open);
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/** A perfectly straight, endless corridor: no track curvature, only two walls. */
function straightCorridor(width = 140): Track {
  const step = 8;
  const count = 4000;
  const samples = Array.from({ length: count }, (_, i) => ({
    pos: { x: i * step, y: 0 },
    dir: { x: 1, y: 0 },
    normal: { x: 0, y: -1 },
    curvature: 0,
    width,
    s: i * step,
  }));
  const length = count * step;
  const half = width / 2;
  const track = {
    seed: 0,
    style: 'speedway' as const,
    name: 'CORRIDOR',
    samples,
    length,
    step,
    startIndex: 0,
    startLine: { a: { x: 0, y: half }, b: { x: 0, y: -half }, dir: { x: 1, y: 0 } },
    bounds: { minX: 0, minY: -half, maxX: length, maxY: half },
    leftEdge: samples.map((s) => ({ x: s.pos.x, y: half })),
    rightEdge: samples.map((s) => ({ x: s.pos.x, y: -half })),
    racingLine: samples.map((s) => ({ ...s.pos })),
    query(p: Vec2): TrackQuery {
      const lateral = -p.y;
      const absLat = Math.abs(lateral);
      const index = Math.max(0, Math.min(count - 1, Math.floor(p.x / step)));
      return {
        index,
        s: ((index * step) % length + length) % length,
        lateral,
        center: { x: p.x, y: 0 },
        dir: { x: 1, y: 0 },
        normal: { x: 0, y: -1 },
        width,
        surface: absLat <= half - TRACK.curbWidth ? 'road' : absLat <= half ? 'curb' : 'grass',
        onRoad: absLat <= half,
        radius: Infinity,
      };
    },
    at(s: number) {
      const wrapped = ((s % length) + length) % length;
      const i = Math.floor(wrapped / step) % count;
      return samples[i]!;
    },
    posAt(s: number) {
      return this.at(s).pos;
    },
    deltaS(a: number, b: number) {
      let d = (b - a) % length;
      if (d > length / 2) d -= length;
      if (d <= -length / 2) d += length;
      return d;
    },
  };
  return track as Track;
}

describe('stepCar: walls', () => {
  it('cannot drive through a barrier head-on at top speed', () => {
    const track = generateTrack(20261018, 'circuit');
    const spec = CARS.balanced;
    const start = track.at(0);
    // aim straight at the barrier with a lot of speed
    const angle = Math.atan2(start.normal.y, start.normal.x);
    const car = createCarState(spec, { x: start.pos.x, y: start.pos.y }, angle);
    car.vel = { x: Math.cos(angle) * spec.topSpeed, y: Math.sin(angle) * spec.topSpeed };
    car.speed = spec.topSpeed;
    let maxLat = 0;
    let impacts = 0;
    for (let i = 0; i < Math.round(4 / dt); i++) {
      const res = stepCar(car, spec, { ...NEUTRAL, throttle: 1 }, dt, track);
      if (res.impact > 0) impacts++;
      const q = track.query(car.pos);
      maxLat = Math.max(maxLat, Math.abs(q.lateral) - (q.width / 2 + TRACK.runoff));
      assertFinite(car);
    }
    expect(maxLat).toBeLessThan(0.5);
    expect(impacts).toBeGreaterThan(0);
  });

  it('scraping along a barrier is not a dead stop: it keeps most of its speed', () => {
    const spec = CARS.balanced;
    const corridor = straightCorridor(140);
    const barrierLat = corridor.samples[0]!.width / 2 + TRACK.runoff - spec.width / 2;
    // start against the left wall with a ~3 degree bias into it, full throttle
    const bias = 0.05;
    const angle = -bias; // world heading: slightly towards the wall (negative y)
    const car = createCarState(spec, { x: 100, y: -barrierLat }, angle);
    car.vel = { x: Math.cos(angle) * 500, y: Math.sin(angle) * 500 };
    car.speed = 500;
    car.forwardSpeed = 500;
    let contactSteps = 0;
    let speedAtOneSecond = 0;
    const targetAngle = -bias; // hold the nose gently into the wall (like a player would)
    for (let i = 0; i < Math.round(5 / dt); i++) {
      let error = targetAngle - car.angle;
      while (error > Math.PI) error -= Math.PI * 2;
      while (error < -Math.PI) error += Math.PI * 2;
      const steer = Math.max(-1, Math.min(1, error * 3 + car.angularVel * 0.15));
      const res = stepCar(car, spec, { throttle: 1, brake: 0, steer, handbrake: false }, dt, corridor);
      if (res.wallContact) contactSteps++;
      if (i === Math.round(1 / dt)) speedAtOneSecond = car.speed;
      assertFinite(car);
    }
    // it really did grind for the whole window...
    expect(contactSteps * dt).toBeGreaterThan(3.5);
    // ...without being glued to the wall
    expect(car.speed).toBeGreaterThan(spec.topSpeed * 0.5);
    expect(speedAtOneSecond).toBeGreaterThan(spec.topSpeed * 0.5);
    expect(car.speed).toBeGreaterThan(speedAtOneSecond * 0.6);
    // and it never crossed the barrier
    const q = corridor.query(car.pos);
    expect(Math.abs(q.lateral)).toBeLessThanOrEqual(q.width / 2 + TRACK.runoff);
  });

  it('escapes a wedged wall pocket with the throttle pinned (no permanent trap)', () => {
    const spec = CARS.balanced;
    const corridor = straightCorridor(140);
    const barrierLat = corridor.samples[0]!.width / 2 + TRACK.runoff - spec.width / 2;
    // nose crunch into the left wall, then keep full throttle AND full lock into it:
    // the wall-riding assist must still let the car slide clear instead of parking.
    const angle = -1.2;
    const car = createCarState(spec, { x: 100, y: -barrierLat }, angle);
    car.vel = { x: Math.cos(angle) * 300, y: Math.sin(angle) * 300 };
    car.speed = 300;
    car.forwardSpeed = 300;
    const startX = car.pos.x;
    for (let i = 0; i < Math.round(3 / dt); i++) {
      stepCar(car, spec, { throttle: 1, brake: 0, steer: -1, handbrake: false }, dt, corridor);
    }
    assertFinite(car);
    // it is moving along the corridor again, roughly parallel to the barrier
    expect(car.pos.x - startX).toBeGreaterThan(300);
    expect(car.speed).toBeGreaterThan(120);
    expect(Math.abs(Math.cos(car.angle))).toBeGreaterThan(0.8);
    const q = corridor.query(car.pos);
    expect(Math.abs(q.lateral)).toBeLessThanOrEqual(q.width / 2 + TRACK.runoff);
  });

  it('cannot tunnel through a barrier at 45 degrees or while off-road', () => {
    const track = generateTrack(7, 'technical');
    const spec = CARS.speedster;
    for (const startS of [0, 500, 1500]) {
      const sample = track.at(startS);
      const base = Math.atan2(sample.dir.y, sample.dir.x);
      for (const aiming of [Math.PI / 4, Math.PI / 2]) {
        const angle = base + aiming;
        const car = createCarState(spec, { x: sample.pos.x, y: sample.pos.y }, angle);
        car.vel = { x: Math.cos(angle) * spec.topSpeed, y: Math.sin(angle) * spec.topSpeed };
        for (let i = 0; i < Math.round(3 / dt); i++) {
          const q0 = track.query(car.pos);
          const opts: StepOptions =
            q0.surface === 'grass'
              ? { gripScale: PHYSICS.grassGrip, topSpeedScale: PHYSICS.grassDrag, extraAccel: -PHYSICS.grassResist }
              : {};
          stepCar(car, spec, { ...NEUTRAL, throttle: 1 }, dt, track, opts);
          const q = track.query(car.pos);
          expect(Math.abs(q.lateral)).toBeLessThanOrEqual(q.width / 2 + TRACK.runoff + 0.5);
        }
        assertFinite(car);
      }
    }
  });
});

describe('stepCar: surfaces and StepOptions', () => {
  it('reports and reacts to curb and grass', () => {
    const track = generateTrack(2026, 'circuit');
    const spec = CARS.balanced;
    const sample = track.at(900);
    const curbPos = {
      x: sample.pos.x + sample.normal.x * (sample.width / 2 - TRACK.curbWidth / 2),
      y: sample.pos.y + sample.normal.y * (sample.width / 2 - TRACK.curbWidth / 2),
    };
    const curbCar = createCarState(spec, curbPos, Math.atan2(sample.dir.y, sample.dir.x));
    const curbRes = stepCar(curbCar, spec, { ...NEUTRAL, throttle: 1 }, dt, track);
    expect(curbRes.surface).toBe('curb');
    expect(curbRes.onRoad).toBe(true);

    const grassPos = {
      x: sample.pos.x + sample.normal.x * (sample.width / 2 + 20),
      y: sample.pos.y + sample.normal.y * (sample.width / 2 + 20),
    };
    const grassCar = createCarState(spec, grassPos, Math.atan2(sample.dir.y, sample.dir.x));
    const grassRes = stepCar(grassCar, spec, { ...NEUTRAL, throttle: 1 }, dt, track);
    expect(grassRes.surface).toBe('grass');
    expect(grassRes.onRoad).toBe(false);
  });

  it('honours topSpeedScale, gripScale and extraAccel', () => {
    const spec = CARS.balanced;
    // top speed scale
    const fast = spawn(spec);
    const slow = spawn(spec);
    for (let i = 0; i < Math.round(8 / dt); i++) {
      stepCar(fast, spec, { ...NEUTRAL, throttle: 1 }, dt, open);
      stepCar(slow, spec, { ...NEUTRAL, throttle: 1 }, dt, open, { topSpeedScale: 0.6 });
    }
    expect(slow.speed).toBeLessThanOrEqual(spec.topSpeed * 0.6 * 1.08);
    expect(slow.speed).toBeLessThan(fast.speed * 0.75);

    // extra rolling resistance (off-road) lowers the top speed noticeably
    const resisted = spawn(spec);
    const plain = spawn(spec);
    for (let i = 0; i < Math.round(8 / dt); i++) {
      stepCar(resisted, spec, { ...NEUTRAL, throttle: 1 }, dt, open, { extraAccel: -PHYSICS.grassResist });
      stepCar(plain, spec, { ...NEUTRAL, throttle: 1 }, dt, open);
    }
    expect(resisted.speed).toBeLessThan(plain.speed * 0.85);
    expect(resisted.speed).toBeGreaterThan(0);

    // reduced grip makes the car understeer/run wider at the same steering input
    const grippy = spawn(spec, 0, 420);
    const slippery = spawn(spec, 0, 420);
    for (let i = 0; i < Math.round(3 / dt); i++) {
      stepCar(grippy, spec, { ...NEUTRAL, throttle: 0.6, steer: 0.5 }, dt, open, { gripScale: 1 });
      stepCar(slippery, spec, { ...NEUTRAL, throttle: 0.6, steer: 0.5 }, dt, open, { gripScale: PHYSICS.grassGrip });
    }
    expect(Math.abs(slippery.angularVel)).toBeLessThan(Math.abs(grippy.angularVel));
    assertFinite(grippy);
    assertFinite(slippery);
  });
});

describe('stepCar: drift and boost', () => {
  interface DriftRun {
    firstDrift: number;
    maxSlip: number;
    maxSkid: number;
    meanSlipWhileDrifting: number;
    boostAt: number;
    boostSeen: boolean;
    minSpeed: number;
    recoverySlip: number;
    recoveryDrift: number;
    endDrifting: boolean;
    endSlip: number;
    endYaw: number;
    endSpeed: number;
    headingSwing: number;
    drifting: boolean;
  }

  /**
   * Hold the handbrake for `hold` seconds, then release it and keep the wheel
   * mostly straight for `release` more seconds (an arcade drift + recovery).
   */
  function handbrakeRun(
    spec: CarSpec,
    speed: number,
    steer: number,
    hold: number,
    release: number,
    seedStart = 0,
  ): DriftRun & { car: CarState } {
    const car = spawn(spec, seedStart, speed);
    let firstDrift = -1;
    let maxSlip = 0;
    let maxSkid = 0;
    let slipSum = 0;
    let slipCount = 0;
    let minSpeed = Infinity;
    let boostAt = -1;
    let boostSeen = false;
    let recoverySlip = -1;
    let recoveryDrift = -1;
    const releaseStart = car.angle;
    const holdSteps = Math.round(hold / dt);
    const totalSteps = Math.round((hold + release) / dt);
    for (let i = 0; i < totalSteps; i++) {
      const input: CarInput =
        i < holdSteps
          ? { throttle: 1, brake: 0, steer, handbrake: true }
          : { throttle: 0.6, brake: 0, steer: steer * 0.2, handbrake: false };
      const result = stepCar(car, spec, input, dt, open);
      maxSkid = Math.max(maxSkid, result.skid);
      if (car.boostTime > 0) boostSeen = true;
      if (i < holdSteps) {
        if (car.drifting) {
          if (firstDrift < 0) firstDrift = i * dt;
          slipSum += car.slip;
          slipCount++;
        }
        maxSlip = Math.max(maxSlip, car.slip);
        minSpeed = Math.min(minSpeed, car.speed);
        if (boostAt < 0 && car.boostTime > 0) boostAt = i * dt;
      } else {
        const since = (i - holdSteps) * dt;
        if (recoverySlip < 0 && car.slip < PHYSICS.driftSlipThreshold) recoverySlip = since;
        if (recoveryDrift < 0 && !car.drifting) recoveryDrift = since;
      }
    }
    let headingSwing = car.angle - releaseStart;
    while (headingSwing > Math.PI) headingSwing -= Math.PI * 2;
    while (headingSwing < -Math.PI) headingSwing += Math.PI * 2;
    return {
      car,
      firstDrift,
      maxSlip,
      maxSkid,
      meanSlipWhileDrifting: slipCount ? slipSum / slipCount : 0,
      boostAt,
      boostSeen,
      minSpeed,
      recoverySlip,
      recoveryDrift,
      endDrifting: car.drifting,
      endSlip: car.slip,
      endYaw: car.angularVel,
      endSpeed: car.speed,
      headingSwing,
      drifting: car.drifting,
    };
  }

  it('(a) handbrake + steer at speed enters a real drift in every car class', () => {
    for (const key of ['balanced', 'drifter', 'speedster'] as const) {
      const spec = CARS[key];
      const run = handbrakeRun(spec, 380, 0.6, 1.2, 0.1);
      expect(run.firstDrift).toBeGreaterThanOrEqual(0);
      expect(run.firstDrift).toBeLessThan(1.2);
      expect(run.maxSlip).toBeGreaterThan(PHYSICS.driftSlipThreshold);
      expect(run.car.drifting).toBe(true);
      // skid output is in sync with the slip (drives skid marks + smoke)
      expect(run.maxSkid).toBeGreaterThan(0.4);
      expect(run.minSpeed).toBeGreaterThan(PHYSICS.driftMinSpeed * 0.8);
      assertFinite(run.car);
    }
  });

  it('(b) a sustained handbrake drift fills driftCharge and grants the boost', () => {
    for (const key of ['balanced', 'drifter', 'speedster'] as const) {
      const spec = CARS[key];
      const run = handbrakeRun(spec, 420, 0.7, 2.6, 0.5);
      expect(run.boostAt).toBeGreaterThan(0);
      expect(run.boostSeen).toBe(true);
      // charge belongs to the drift: roughly driftChargeTime after entry
      expect(run.boostAt - run.firstDrift).toBeGreaterThan(PHYSICS.driftChargeTime * 0.8);
      expect(run.boostAt - run.firstDrift).toBeLessThan(PHYSICS.driftChargeTime * 1.6);
      // and the drift must not scrub the car below the drift speed floor
      expect(run.minSpeed).toBeGreaterThan(PHYSICS.driftMinSpeed);
      assertFinite(run.car);
    }
  });

  it('(c) releasing the handbrake recovers grip and straightens the car', () => {
    for (const key of ['balanced', 'drifter', 'speedster'] as const) {
      const spec = CARS[key];
      const run = handbrakeRun(spec, 400, 0.7, 1.8, 2);
      expect(run.recoverySlip).toBeGreaterThanOrEqual(0);
      expect(run.recoverySlip).toBeLessThan(1.5);
      expect(run.recoveryDrift).toBeGreaterThanOrEqual(0);
      expect(run.recoveryDrift).toBeLessThan(1.5);
      expect(run.endDrifting).toBe(false);
      expect(run.endSlip).toBeLessThan(PHYSICS.driftSlipThreshold);
      // no permanent rotation / spin: yaw calms down and the heading settles
      expect(Math.abs(run.endYaw)).toBeLessThan(1.2);
      expect(Math.abs(run.headingSwing)).toBeLessThan(Math.PI);
      expect(run.endSpeed).toBeGreaterThan(PHYSICS.driftMinSpeed);
      assertFinite(run.car);
    }
  });

  it('(d) normal cornering without the handbrake never starts a drift', () => {
    for (const key of ['balanced', 'drifter', 'speedster'] as const) {
      const spec = CARS[key];
      for (const speed of [260, 380, 500]) {
        const car = spawn(spec, 0, speed);
        let everDrifted = false;
        let maxSlip = 0;
        for (let i = 0; i < Math.round(3 / dt); i++) {
          stepCar(car, spec, { throttle: 0.85, brake: 0, steer: 1, handbrake: false }, dt, open);
          if (car.drifting) everDrifted = true;
          maxSlip = Math.max(maxSlip, car.slip);
        }
        expect(everDrifted).toBe(false);
        expect(maxSlip).toBeLessThan(PHYSICS.driftSlipThreshold);
        expect(car.driftCharge).toBeLessThan(0.2);
        assertFinite(car);
      }
    }
  });

  it('(e) all three classes drift, and the drifter carries the most angle', () => {
    const angles: Record<string, number> = {};
    for (const key of ['balanced', 'drifter', 'speedster'] as const) {
      const run = handbrakeRun(CARS[key], 420, 0.55, 1.6, 0.1);
      angles[key] = run.meanSlipWhileDrifting;
      // every class can hold a drift for the whole window
      expect(run.meanSlipWhileDrifting).toBeGreaterThan(PHYSICS.driftSlipThreshold);
      expect(run.car.drifting).toBe(true);
    }
    // drifter (lowest rear grip) should be easiest: more angle for the same input
    expect(angles.drifter!).toBeGreaterThan(angles.speedster! + 0.02);
  });

  it('grants a boost charge that pushes the car past its regular top speed', () => {
    const spec = CARS.drifter;
    const car = spawn(spec, 0, 480);
    let maxSpeed = 0;
    let boostSeen = false;
    for (let i = 0; i < Math.round(4 / dt); i++) {
      const input: CarInput =
        i < Math.round(2.2 / dt)
          ? { throttle: 1, brake: 0, steer: 0.6, handbrake: true }
          : { throttle: 1, brake: 0, steer: 0.1, handbrake: false };
      stepCar(car, spec, input, dt, open);
      if (car.boostTime > 0) boostSeen = true;
      maxSpeed = Math.max(maxSpeed, car.speed);
      assertFinite(car);
    }
    expect(boostSeen).toBe(true);
    expect(maxSpeed).toBeGreaterThan(spec.topSpeed * 1.01);
    expect(maxSpeed).toBeLessThan(spec.topSpeed * 1.2);
  });

  it('produces skid output and drift start/end flags', () => {
    const spec = CARS.balanced;
    const car = spawn(spec, 0, 480);
    let started = 0;
    let ended = 0;
    let maxSkid = 0;
    for (let i = 0; i < Math.round(4 / dt); i++) {
      const input: CarInput = {
        throttle: 0.9,
        brake: 0,
        steer: i < Math.round(1.4 / dt) ? 0.6 : 0.1,
        handbrake: i < Math.round(1.4 / dt),
      };
      const res = stepCar(car, spec, input, dt, open);
      if (res.driftStart) started++;
      if (res.driftEnd) ended++;
      maxSkid = Math.max(maxSkid, res.skid);
    }
    expect(started).toBeGreaterThan(0);
    expect(ended).toBeGreaterThan(0);
    expect(maxSkid).toBeGreaterThan(0.2);
  });
});

describe('stepCar: robustness', () => {
  it('never produces NaN for hostile inputs and clamps bad dt', () => {
    const track = generateTrack(99, 'circuit');
    const spec = CARS.speedster;
    const car = createCarState(spec, track.at(0).pos, 0);
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const optSets: StepOptions[] = [
      {},
      { gripScale: PHYSICS.grassGrip, topSpeedScale: PHYSICS.grassDrag, extraAccel: -PHYSICS.grassResist },
      { gripScale: PHYSICS.curbGrip },
      { extraAccel: 200, topSpeedScale: 1.1 },
    ];
    for (let i = 0; i < 12000; i++) {
      const input: CarInput = {
        throttle: rnd(),
        brake: rnd() < 0.15 ? rnd() : 0,
        steer: rnd() * 2 - 1,
        handbrake: rnd() < 0.2,
      };
      const badDt = i % 500 === 0 ? (i % 1000 === 0 ? -1 : Number.NaN) : dt;
      stepCar(car, spec, input, badDt, track, optSets[i % optSets.length]);
      if (i % 250 === 0) {
        assertFinite(car);
        const q = track.query(car.pos);
        expect(Math.abs(q.lateral)).toBeLessThanOrEqual(q.width / 2 + TRACK.runoff + 1);
      }
    }
    assertFinite(car);
  });

  it('survives NaN inputs without corrupting the state', () => {
    const spec = CARS.balanced;
    const car = spawn(spec, 0, 200);
    stepCar(car, spec, { throttle: Number.NaN, brake: Number.NaN, steer: Number.NaN, handbrake: false }, dt, open);
    assertFinite(car);
    const before = JSON.stringify(car);
    stepCar(car, spec, { ...NEUTRAL, throttle: 1 }, dt, open);
    expect(JSON.stringify(car)).not.toBe(before);
    assertFinite(car);
  });

  it('never exceeds the barrier for any car class on a full lap of driving', () => {
    const track = generateTrack(20261018, 'technical');
    for (const key of ['balanced', 'drifter', 'speedster'] as const) {
      const spec = CARS[key];
      const sample = track.at(0);
      const car = createCarState(spec, sample.pos, Math.atan2(sample.dir.y, sample.dir.x));
      let seed = 7;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) >>> 0;
        return seed / 4294967296;
      };
      for (let i = 0; i < Math.round(30 / dt); i++) {
        const q0 = track.query(car.pos);
        const opts: StepOptions =
          q0.surface === 'grass'
            ? { gripScale: PHYSICS.grassGrip, topSpeedScale: PHYSICS.grassDrag, extraAccel: -PHYSICS.grassResist }
            : {};
        const input: CarInput = {
          throttle: 0.75 + rnd() * 0.25,
          brake: 0,
          steer: Math.sin(i * dt * 0.7) * 0.4 + (rnd() - 0.5) * 0.3,
          handbrake: false,
        };
        stepCar(car, spec, input, dt, track, opts);
        if (i % 600 === 0) {
          const q = track.query(car.pos);
          expect(Math.abs(q.lateral)).toBeLessThanOrEqual(q.width / 2 + TRACK.runoff + 1);
        }
      }
      assertFinite(car);
    }
  });
});
