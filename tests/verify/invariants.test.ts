/**
 * Independent physical-invariant tests.
 *
 * A 60 s simulated race (real physics + AI + our own autopilot) must never
 * produce NaN/Infinity, must respect the spec top speed, must keep cars near the
 * track, and must keep the lateral offset within the legal run-off envelope.
 */

import { describe, expect, it } from 'vitest';
import { CARS, PHYSICS, TRACK } from '../../src/game/config';
import type { RaceState } from '../../src/game/types';
import {
  Autopilot,
  calibrateSteerSign,
  findNonFinite,
  isFiniteNumber,
  makeRace,
  racerNumbers,
  simulate,
} from './helpers';

const SPEED_TOLERANCE = 1.2; // spec: never above 1.2x spec.topSpeed
const BOUNDS_MARGIN = 600; // world units outside the track bounding box
const SECONDS = 60;

describe(`physical invariants over ${SECONDS}s of racing`, () => {
  // Run one 60 s race and collect every violation; asserting on the collected
  // list keeps a single (fast) simulation for all invariant families.
  const steerSign = calibrateSteerSign();
  const autopilot = new Autopilot(steerSign);
  // 9 laps guarantees the race is still running after the full 60 s window.
  const race = makeRace({ laps: 9, opponents: 4, difficulty: 'normal' });

  const nanViolations: string[] = [];
  const speedViolations: string[] = [];
  const boundsViolations: string[] = [];
  const lateralViolations: string[] = [];
  let maxObservedSpeed = 0;
  let stepsRun = 0;

  simulate(
    race,
    SECONDS,
    (current: RaceState) => autopilot.input(current),
    (current: RaceState, step: number) => {
      stepsRun = step + 1;
      for (const racer of current.racers) {
        for (const { path, value } of racerNumbers(racer)) {
          if (!isFiniteNumber(value)) nanViolations.push(`racer ${racer.id} ${path} = ${value}`);
        }
        maxObservedSpeed = Math.max(maxObservedSpeed, Math.abs(racer.car.speed));
        if (Math.abs(racer.car.speed) > racer.spec.topSpeed * SPEED_TOLERANCE + 1e-6) {
          speedViolations.push(
            `racer ${racer.id} speed ${racer.car.speed.toFixed(2)} > ${(racer.spec.topSpeed * SPEED_TOLERANCE).toFixed(2)}`,
          );
        }
        const { bounds } = current.track;
        if (
          racer.car.pos.x < bounds.minX - BOUNDS_MARGIN ||
          racer.car.pos.x > bounds.maxX + BOUNDS_MARGIN ||
          racer.car.pos.y < bounds.minY - BOUNDS_MARGIN ||
          racer.car.pos.y > bounds.maxY + BOUNDS_MARGIN
        ) {
          boundsViolations.push(
            `racer ${racer.id} at (${racer.car.pos.x.toFixed(1)}, ${racer.car.pos.y.toFixed(1)}) outside bounds+${BOUNDS_MARGIN}`,
          );
        }
        const query = current.track.query(racer.car.pos);
        const lateralLimit = query.width / 2 + TRACK.runoff + racer.spec.length;
        if (!isFiniteNumber(query.lateral)) {
          nanViolations.push(`racer ${racer.id} track.query(racer.pos).lateral = ${query.lateral}`);
        } else if (Math.abs(query.lateral) > lateralLimit + 1e-6) {
          lateralViolations.push(
            `racer ${racer.id} lateral ${query.lateral.toFixed(1)} > limit ${lateralLimit.toFixed(1)}`,
          );
        }
      }
      // Full deep scan of the whole state graph once per simulated second.
      if (step % 120 === 0) nanViolations.push(...findNonFinite(current));
    },
  );

  it('runs the full simulated duration', () => {
    expect(stepsRun).toBeGreaterThanOrEqual(Math.round(SECONDS / PHYSICS.subStep) - 1);
    expect(race.time).toBeGreaterThan(SECONDS * 0.7);
  });

  it('never produces NaN or Infinity anywhere in RaceState', () => {
    expect(nanViolations.slice(0, 20)).toEqual([]);
    expect(findNonFinite(race)).toEqual([]);
  });

  it('never exceeds 1.2x the car spec top speed', () => {
    expect(speedViolations.slice(0, 10)).toEqual([]);
    expect(maxObservedSpeed).toBeGreaterThan(50); // sanity: the cars actually moved
    for (const spec of Object.values(CARS)) {
      expect(Number.isFinite(spec.topSpeed)).toBe(true);
    }
  });

  it('keeps every car within track.bounds + margin', () => {
    expect(boundsViolations.slice(0, 10)).toEqual([]);
  });

  it('keeps lateral offset within road half width + run-off + car length', () => {
    expect(lateralViolations.slice(0, 10)).toEqual([]);
  });

  it('track geometry itself is finite and sane', () => {
    expect(race.track.samples.length).toBeGreaterThan(32);
    expect(race.track.length).toBeGreaterThan(500);
    expect(findNonFinite(race.track, 'track')).toEqual([]);
    for (const sample of race.track.samples) {
      expect(Number.isFinite(sample.width)).toBe(true);
      expect(sample.width).toBeGreaterThan(40);
      expect(Math.hypot(sample.dir.x, sample.dir.y)).toBeCloseTo(1, 6);
      expect(Math.hypot(sample.normal.x, sample.normal.y)).toBeCloseTo(1, 6);
    }
    expect(race.track.bounds.maxX).toBeGreaterThan(race.track.bounds.minX);
    expect(race.track.bounds.maxY).toBeGreaterThan(race.track.bounds.minY);
  });
});
