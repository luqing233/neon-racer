/**
 * LEAD-owned diagnostic/acceptance probe.
 *
 * Independently answers: "can a straightforward pure-pursuit controller drive a
 * generated track for a full lap?" — i.e. is the game actually drivable by a
 * human who steers toward the corner, and are generated circuits free of
 * impossible corners?
 *
 * Run: npx vitest run tests/lead
 */

import { describe, expect, it } from 'vitest';
import { CARS, PHYSICS, TRACK } from '../../src/game/config';
import { createRace, stepRace } from '../../src/game/race';
import { generateTrack } from '../../src/game/track';
import type { CarInput, RaceConfig, RaceState, Track, TrackStyle } from '../../src/game/types';

const STYLES: TrackStyle[] = ['circuit', 'technical', 'speedway'];
const SEEDS = [20261018, 7, 424242];

function makeRace(seed: number, style: TrackStyle, laps: number, opponents: number): RaceState {
  const track = generateTrack(seed, style);
  const config: RaceConfig = {
    seed,
    style,
    laps,
    opponents,
    difficulty: 'normal',
    carClass: 'balanced',
    playerName: 'LEAD',
  };
  return createRace(config, track);
}

function settleCountdown(race: RaceState): void {
  const dt = PHYSICS.subStep;
  let guard = 0;
  while (race.phase === 'countdown' && guard < 20000) {
    stepRace(race, dt, { throttle: 0, brake: 0, steer: 0, handbrake: false });
    guard++;
  }
}

function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/** Which sign of `steer` turns the car toward +angle? Calibrated empirically. */
function calibrateSteerSign(): number {
  const race = makeRace(1, 'circuit', 1, 0);
  settleCountdown(race);
  const dt = PHYSICS.subStep;
  const before = race.player.car.angle;
  for (let i = 0; i < Math.round(0.5 / dt); i++) {
    stepRace(race, dt, { throttle: 1, brake: 0, steer: 1, handbrake: false });
  }
  const delta = wrapAngle(race.player.car.angle - before);
  return delta >= 0 ? 1 : -1;
}

interface ProbeResult {
  laps: number;
  fraction: number;
  maxSpeed: number;
  stuckSeconds: number;
  finished: boolean;
  minRadiusOnPath: number;
}

function drive(track: Track, race: RaceState, steerSign: number, seconds: number): ProbeResult {
  const dt = PHYSICS.subStep;
  let maxSpeed = 0;
  let stuck = 0;
  let minRadius = Infinity;
  const total = Math.round(seconds / dt);
  for (let i = 0; i < total; i++) {
    const car = race.player.car;
    const q = track.query(car.pos);
    minRadius = Math.min(minRadius, q.radius);
    // pure pursuit: aim a speed-dependent distance ahead on the racing line
    const lookahead = Math.max(150, Math.min(430, car.speed * 0.62));
    const target = track.racingLine[Math.floor((((q.s + lookahead) % track.length) + track.length) % track.length / track.step) % track.racingLine.length]!;
    const desired = Math.atan2(target.y - car.pos.y, target.x - car.pos.x);
    const err = wrapAngle(desired - car.angle);
    // corner speed from the tightest radius within the braking window
    let radius = Infinity;
    for (let ahead = 40; ahead < 520; ahead += 40) {
      const sample = track.at(q.s + ahead);
      if (Math.abs(sample.curvature) > 1e-6) radius = Math.min(radius, Math.abs(1 / sample.curvature));
    }
    const vTarget = Math.min(CARS.balanced.topSpeed * 0.92, Math.sqrt(900 * Math.max(radius, 60)));
    const input: CarInput = {
      throttle: car.speed < vTarget ? 1 : 0,
      brake: car.speed > vTarget * 1.12 ? 0.85 : 0,
      steer: Math.max(-1, Math.min(1, err * 1.9)) * steerSign,
      handbrake: false,
    };
    stepRace(race, dt, input);
    maxSpeed = Math.max(maxSpeed, car.speed);
    if (car.speed < 25) stuck += dt;
  }
  return {
    laps: race.player.lap,
    fraction: race.player.progress.totalS / track.length,
    maxSpeed,
    stuckSeconds: stuck,
    finished: race.player.finished,
    minRadiusOnPath: minRadius,
  };
}

describe('LEAD probe: is a generated track actually drivable?', () => {
  it('reports min radius + pure-pursuit lap completion across seeds/styles', () => {
    const steerSign = calibrateSteerSign();
    const rows: string[] = [];
    for (const style of STYLES) {
      for (const seed of SEEDS) {
        const track = generateTrack(seed, style);
        let minRadius = Infinity;
        for (const sample of track.samples) {
          if (Math.abs(sample.curvature) > 1e-6) minRadius = Math.min(minRadius, Math.abs(1 / sample.curvature));
        }
        const race = makeRace(seed, style, 1, 3);
        settleCountdown(race);
        const result = drive(track, race, steerSign, 150);
        rows.push(
          `${style.padEnd(9)} seed=${String(seed).padEnd(9)} len=${track.length.toFixed(0).padStart(6)} ` +
            `minR=${minRadius.toFixed(0).padStart(5)} (limit ${TRACK.minRadius}) ` +
            `laps=${result.laps} frac=${(result.fraction * 100).toFixed(0)}% maxV=${result.maxSpeed.toFixed(0).padStart(3)} ` +
            `stuck=${result.stuckSeconds.toFixed(1)}s`,
        );
      }
    }
    // eslint-disable-next-line no-console
    console.log(`\n${rows.join('\n')}\n`);
    expect(rows.length).toBe(9);
    // 9 tracks x 150 simulated seconds at 120 Hz — needs its own budget when the
    // rest of the suite is running in parallel workers.
  }, 60_000);

  it('a pure-pursuit controller completes a full lap on the default track', () => {
    const steerSign = calibrateSteerSign();
    const track = generateTrack(20261018, 'circuit');
    const race = makeRace(20261018, 'circuit', 1, 0);
    settleCountdown(race);
    const result = drive(track, race, steerSign, 150);
    expect(result.laps).toBeGreaterThanOrEqual(1);
    expect(result.maxSpeed).toBeGreaterThan(CARS.balanced.topSpeed * 0.4);
    expect(result.maxSpeed).toBeLessThan(CARS.balanced.topSpeed * 1.2);
  }, 30_000);
});
