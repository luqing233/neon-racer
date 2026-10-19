/**
 * Unit tests for src/game/ai.ts — racing-line following, traffic, recovery, determinism.
 * OWNER: engine-dev.
 */

import { describe, expect, it } from 'vitest';
import { CARS, PHYSICS, TRACK } from '../../src/game/config';
import { createAIDriver, updateAIDriver } from '../../src/game/ai';
import { mulberry32 } from '../../src/game/math';
import { generateTrack } from '../../src/game/track';
import { createCarState, stepCar } from '../../src/game/vehicle';
import type { CarInput, CarState, Difficulty, Track } from '../../src/game/types';

const dt = PHYSICS.subStep;
const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard', 'insane'];

interface DriveStats {
  laps: number;
  lapTimes: number[];
  offRoadSeconds: number;
  wallImpacts: number;
  maxSpeed: number;
  minSpeedAfterStart: number;
  finalSpeed: number;
  stuckSeconds: number;
}

function drive(track: Track, difficulty: Difficulty, seconds: number, seedRng = 4242): DriveStats {
  const spec = CARS.balanced;
  // start 60 units behind the line like the real grid so lap 1 is measurable
  const start = track.at(-60);
  const car = createCarState(spec, start.pos, Math.atan2(start.dir.y, start.dir.x));
  const driver = createAIDriver(0, difficulty, mulberry32(seedRng));
  const traffic: CarState[] = [car];
  let laps = 0;
  const lapTimes: number[] = [];
  let offRoad = 0;
  let wallImpacts = 0;
  let maxSpeed = 0;
  let minSpeedAfterStart = Infinity;
  let stuckSeconds = 0;
  let prevS = track.query(car.pos).s;
  let crossed = false;
  let lapStart = 0;
  let t = 0;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const q0 = track.query(car.pos);
    const opts =
      q0.surface === 'grass'
        ? { gripScale: PHYSICS.grassGrip, topSpeedScale: PHYSICS.grassDrag, extraAccel: -PHYSICS.grassResist }
        : q0.surface === 'curb'
          ? { gripScale: PHYSICS.curbGrip }
          : {};
    const input = updateAIDriver(driver, car, track, dt, traffic);
    const res = stepCar(car, spec, input, dt, track, opts);
    if (res.surface === 'grass') offRoad++;
    if (res.impact > 0) wallImpacts++;
    if (car.speed < 25) stuckSeconds += dt;
    maxSpeed = Math.max(maxSpeed, car.speed);
    if (t > 2) minSpeedAfterStart = Math.min(minSpeedAfterStart, car.speed);
    t += dt;
    const q = track.query(car.pos);
    const d = track.deltaS(prevS, q.s);
    if (q.s < prevS && d > 0) {
      if (crossed) {
        laps++;
        lapTimes.push(t - lapStart);
      }
      crossed = true;
      lapStart = t;
    }
    prevS = q.s;
  }
  return { laps, lapTimes, offRoadSeconds: offRoad * dt, wallImpacts, maxSpeed, minSpeedAfterStart, finalSpeed: car.speed, stuckSeconds };
}

describe('createAIDriver', () => {
  it('is deterministic and produces sane personalities per difficulty', () => {
    for (const difficulty of DIFFICULTIES) {
      const a = createAIDriver(3, difficulty, mulberry32(99));
      const b = createAIDriver(3, difficulty, mulberry32(99));
      expect(a.skill).toBe(b.skill);
      expect(a.aggression).toBe(b.aggression);
      expect(a.lineBias).toBe(b.lineBias);
      expect(a.wobblePhase).toBe(b.wobblePhase);
      expect(a.id).toBe(3);
      expect(a.skill).toBeGreaterThanOrEqual(0);
      expect(a.skill).toBeLessThanOrEqual(1);
      expect(a.aggression).toBeGreaterThanOrEqual(0);
      expect(a.aggression).toBeLessThanOrEqual(1);
      expect(Math.abs(a.lineBias)).toBeLessThan(25);
    }
  });

  it('gives higher skill to higher difficulties', () => {
    const avg = (difficulty: Difficulty) => {
      let sum = 0;
      for (let i = 0; i < 40; i++) sum += createAIDriver(0, difficulty, mulberry32(i + 1)).skill;
      return sum / 40;
    };
    const easy = avg('easy');
    const normal = avg('normal');
    const hard = avg('hard');
    const insane = avg('insane');
    expect(normal).toBeGreaterThan(easy);
    expect(hard).toBeGreaterThan(normal);
    expect(insane).toBeGreaterThan(hard);
  });
});

describe('updateAIDriver: driving', () => {
  it('drives clean laps on every track style and difficulty', { timeout: 60000 }, () => {
    for (const style of ['circuit', 'technical', 'speedway'] as const) {
      const track = generateTrack(20261018, style);
      for (const difficulty of DIFFICULTIES) {
        const stats = drive(track, difficulty, 40);
        // the AI must make real progress, stay on the road and not crash
        expect(stats.laps).toBeGreaterThanOrEqual(1);
        expect(stats.offRoadSeconds).toBeLessThan(1);
        expect(stats.wallImpacts).toBe(0);
        expect(stats.maxSpeed).toBeGreaterThan(200);
        expect(Number.isFinite(stats.finalSpeed)).toBe(true);
        for (const lap of stats.lapTimes) {
          expect(Number.isFinite(lap)).toBe(true);
          expect(lap).toBeGreaterThan(3);
          expect(lap).toBeLessThan(60);
        }
      }
    }
  });

  it('uses the wide road without wall-hugging', { timeout: 60000 }, () => {
    for (const style of ['circuit', 'technical', 'speedway'] as const) {
      const track = generateTrack(20261018, style);
      const spec = CARS.balanced;
      const start = track.at(-70);
      const car = createCarState(spec, start.pos, Math.atan2(start.dir.y, start.dir.x));
      const driver = createAIDriver(0, 'normal', mulberry32(31337));
      const traffic: CarState[] = [car];
      let offRoad = 0;
      let hugging = 0;
      let steps = 0;
      let maxRelative = 0;
      for (let i = 0; i < Math.round(45 / dt); i++) {
        const before = track.query(car.pos);
        const opts =
          before.surface === 'grass'
            ? { gripScale: PHYSICS.grassGrip, topSpeedScale: PHYSICS.grassDrag, extraAccel: -PHYSICS.grassResist }
            : {};
        const result = stepCar(car, spec, updateAIDriver(driver, car, track, dt, traffic), dt, track, opts);
        if (result.surface === 'grass') offRoad++;
        const relative = Math.abs(before.lateral) / (before.width / 2);
        if (relative > 0.8) hugging++;
        maxRelative = Math.max(maxRelative, relative);
        steps++;
      }
      expect(offRoad * dt).toBeLessThan(0.5);
      expect(hugging / steps).toBeLessThan(0.25);
      expect(maxRelative).toBeLessThan(0.95);
    }
  });

  it('is faster on higher difficulties', () => {
    const track = generateTrack(20261018, 'circuit');
    const easy = drive(track, 'easy', 45);
    const insane = drive(track, 'insane', 45);
    expect(insane.lapTimes.length).toBeGreaterThan(0);
    expect(easy.lapTimes.length).toBeGreaterThan(0);
    const best = (times: number[]) => Math.min(...times);
    expect(best(insane.lapTimes)).toBeLessThan(best(easy.lapTimes));
  });

  it('is deterministic: identical driver + state ⇒ identical inputs', () => {
    const track = generateTrack(2026, 'technical');
    const run = () => {
      const start = track.at(0);
      const car = createCarState(CARS.drifter, start.pos, Math.atan2(start.dir.y, start.dir.x));
      const driver = createAIDriver(1, 'hard', mulberry32(555));
      const traffic: CarState[] = [car];
      const inputs: CarInput[] = [];
      for (let i = 0; i < 2400; i++) {
        const input = updateAIDriver(driver, car, track, dt, traffic);
        inputs.push(input);
        stepCar(car, CARS.drifter, input, dt, track);
      }
      return { inputs, pos: car.pos, angle: car.angle };
    };
    const a = run();
    const b = run();
    expect(a.inputs).toEqual(b.inputs);
    expect(a.pos).toEqual(b.pos);
    expect(a.angle).toBe(b.angle);
  });
});

describe('updateAIDriver: traffic awareness', () => {
  it('lifts or steers away when a slower car sits directly ahead', () => {
    const track = generateTrack(20261018, 'speedway');
    const spec = CARS.balanced;
    const start = track.at(1200);
    const leader = createCarState(spec, start.pos, Math.atan2(start.dir.y, start.dir.x));
    leader.vel = { x: start.dir.x * 80, y: start.dir.y * 80 };
    leader.speed = 80;
    leader.forwardSpeed = 80;
    const behindSample = track.at(1200 - 55);
    const follower = createCarState(spec, behindSample.pos, Math.atan2(behindSample.dir.y, behindSample.dir.x));
    follower.vel = { x: behindSample.dir.x * 300, y: behindSample.dir.y * 300 };
    follower.speed = 300;
    follower.forwardSpeed = 300;
    const driver = createAIDriver(2, 'normal', mulberry32(7));
    const traffic: CarState[] = [leader, follower];
    let sawBrakeOrAvoid = false;
    let previousSteer = 0;
    for (let i = 0; i < Math.round(1.2 / dt); i++) {
      const input = updateAIDriver(driver, follower, track, dt, traffic);
      if (input.brake > 0) sawBrakeOrAvoid = true;
      if (Math.abs(input.steer - previousSteer) > 0.02) sawBrakeOrAvoid = true;
      previousSteer = input.steer;
      stepCar(follower, spec, input, dt, track, {});
      stepCar(leader, spec, { throttle: 0.1, brake: 0, steer: 0, handbrake: false }, dt, track, {});
    }
    expect(sawBrakeOrAvoid).toBe(true);
    // traffic awareness must never send the car into a wall or off the road
    const q = track.query(follower.pos);
    expect(Math.abs(q.lateral)).toBeLessThanOrEqual(q.width / 2 + TRACK.runoff);
  });
});

describe('updateAIDriver: recovery', () => {
  it('reverses out of a no-progress situation and then rejoins', () => {
    const track = generateTrack(20261018, 'circuit');
    const spec = CARS.balanced;
    const sample = track.at(600);
    // A stationary car making no progress (pinned in a corner pocket): the driver
    // must build up its stuck timer, command reverse, then go forward again.
    const car = createCarState(spec, sample.pos, Math.atan2(sample.dir.y, sample.dir.x));
    const driver = createAIDriver(0, 'normal', mulberry32(11));
    const traffic: CarState[] = [car];
    let sawReverseInput = false;
    let sawRejoin = false;
    let reversing = false;
    for (let i = 0; i < Math.round(6 / dt); i++) {
      const input = updateAIDriver(driver, car, track, dt, traffic);
      if (driver.recovering > 0) {
        if (input.brake > 0 && input.throttle === 0) {
          sawReverseInput = true;
          reversing = true;
        } else if (reversing && input.throttle > 0) {
          sawRejoin = true;
        }
      }
      // deliberately do NOT move the car: it stays stuck
    }
    expect(sawReverseInput).toBe(true);
    expect(sawRejoin).toBe(true);
  });

  it('gets a wall-pinned car free instead of leaving it parked', () => {
    const track = generateTrack(20261018, 'circuit');
    const spec = CARS.balanced;
    const sample = track.at(600);
    // face straight into the barrier, wheels to the wall
    const angle = Math.atan2(sample.normal.y, sample.normal.x);
    const barrierLat = sample.width / 2 + TRACK.runoff - spec.width / 2 - 0.5;
    const car = createCarState(
      spec,
      { x: sample.pos.x + sample.normal.x * barrierLat, y: sample.pos.y + sample.normal.y * barrierLat },
      angle,
    );
    const driver = createAIDriver(0, 'normal', mulberry32(11));
    const traffic: CarState[] = [car];
    let slowRun = 0;
    let worstSlowRun = 0;
    let offsetFromStart = 0;
    for (let i = 0; i < Math.round(10 / dt); i++) {
      const input = updateAIDriver(driver, car, track, dt, traffic);
      stepCar(car, spec, input, dt, track, {});
      if (car.speed < 30) {
        slowRun += dt;
        worstSlowRun = Math.max(worstSlowRun, slowRun);
      } else {
        slowRun = 0;
      }
      offsetFromStart = Math.max(offsetFromStart, Math.hypot(car.pos.x - sample.pos.x, car.pos.y - sample.pos.y));
      if (i % 300 === 0) expect(Number.isFinite(car.pos.x)).toBe(true);
    }
    // never permanently stuck
    expect(worstSlowRun).toBeLessThan(6);
    // and it got properly free: moved away and up to speed
    expect(offsetFromStart).toBeGreaterThan(80);
    expect(car.speed).toBeGreaterThan(60);
    expect(driver.recovering).toBeLessThanOrEqual(0);
  });

  it('never produces NaN inputs for a stationary car with no traffic', () => {
    const track = generateTrack(3, 'technical');
    const start = track.at(0);
    const car = createCarState(CARS.speedster, start.pos, 0);
    const driver = createAIDriver(0, 'insane', mulberry32(2));
    for (let i = 0; i < 900; i++) {
      const input = updateAIDriver(driver, car, track, dt, [car]);
      expect(Number.isFinite(input.throttle)).toBe(true);
      expect(Number.isFinite(input.brake)).toBe(true);
      expect(Number.isFinite(input.steer)).toBe(true);
      expect(input.throttle).toBeGreaterThanOrEqual(0);
      expect(input.throttle).toBeLessThanOrEqual(1);
      expect(input.brake).toBeGreaterThanOrEqual(0);
      expect(input.brake).toBeLessThanOrEqual(1);
      expect(input.steer).toBeGreaterThanOrEqual(-1);
      expect(input.steer).toBeLessThanOrEqual(1);
      stepCar(car, CARS.speedster, input, dt, track, {});
    }
  });
});
