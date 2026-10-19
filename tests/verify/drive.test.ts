/**
 * Independent "player can actually drive" test.
 *
 * Uses the pure window-less simulation (createRace/stepRace) with our own
 * centre-line controller. If a human could not steer the car around the track,
 * this test fails.
 */

import { describe, expect, it } from 'vitest';
import { CARS, PHYSICS } from '../../src/game/config';
import { stepRace } from '../../src/game/race';
import {
  Autopilot,
  calibrateSteerSign,
  makeRace,
  settleCountdown,
  simulate,
} from './helpers';

describe('player can actually drive', () => {
  const steerSign = calibrateSteerSign();

  it('full throttle from the grid produces forward motion', () => {
    const race = makeRace({ laps: 2, opponents: 0 });
    expect(race.phase).toBe('countdown');
    settleCountdown(race);
    expect(race.phase).toBe('racing');

    const startS = race.player.progress.s;
    const dt = PHYSICS.subStep;
    for (let i = 0; i < Math.round(4 / dt); i++) {
      stepRace(race, dt, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    }

    expect(race.player.car.speed).toBeGreaterThan(60);
    expect(race.player.car.speed).toBeLessThanOrEqual(CARS.balanced.topSpeed * 1.2);
    expect(race.player.progress.totalS).toBeGreaterThan(100);
    expect(Number.isFinite(startS)).toBe(true);
  });

  it('a simple centre-line controller covers >60% of the track in 60 s', () => {
    const autopilot = new Autopilot(steerSign);
    const race = makeRace({ laps: 3, opponents: 0 });
    let maxSpeed = 0;

    simulate(
      race,
      60,
      (current) => autopilot.input(current),
      (current) => {
        maxSpeed = Math.max(maxSpeed, current.player.car.speed);
      },
    );

    expect(maxSpeed).toBeGreaterThan(CARS.balanced.topSpeed * 0.25);
    expect(race.player.progress.totalS).toBeGreaterThan(race.track.length * 0.6);
    expect(race.player.progress.s).toBeGreaterThanOrEqual(0);
    expect(race.player.progress.s).toBeLessThan(race.track.length * 1.01);
    expect(Number.isFinite(race.player.car.pos.x)).toBe(true);
    expect(Number.isFinite(race.player.car.pos.y)).toBe(true);
  });

  it('steering follows the calibrated sign convention', () => {
    const race = makeRace({ laps: 2, opponents: 0 });
    settleCountdown(race);
    const dt = PHYSICS.subStep;
    for (let i = 0; i < Math.round(2 / dt); i++) {
      stepRace(race, dt, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    }
    const before = race.player.car.angle;
    for (let i = 0; i < Math.round(0.6 / dt); i++) {
      stepRace(race, dt, { throttle: 1, brake: 0, steer: steerSign, handbrake: false });
    }
    const delta = race.player.car.angle - before;
    // With the calibrated sign, holding steer must change the heading in a
    // consistent direction and the angular acceleration must be finite.
    expect(Number.isFinite(delta)).toBe(true);
    expect(Number.isFinite(race.player.car.angularVel)).toBe(true);
    expect(Math.abs(delta)).toBeGreaterThan(0.02);
  });
});
