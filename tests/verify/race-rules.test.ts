/**
 * Independent race-rules tests.
 *
 * Drives a complete 1-lap race (player handled by our own autopilot) and checks
 * the rules the HUD/results screen depend on: finishing, standings places, lap
 * timing bookkeeping and monotonic race progress.
 */

import { describe, expect, it } from 'vitest';
import { PHYSICS } from '../../src/game/config';
import { stepRace } from '../../src/game/race';
import {
  Autopilot,
  calibrateSteerSign,
  makeRace,
  settleCountdown,
} from './helpers';

describe('race rules', () => {
  it('countdown gates the race clock', () => {
    const race = makeRace({ laps: 1, opponents: 2 });
    expect(race.phase).toBe('countdown');
    expect(race.countdown).toBeGreaterThan(0);
    expect(race.time).toBe(0);
    settleCountdown(race);
    expect(race.phase).toBe('racing');
    expect(race.countdown).toBe(0);
    expect(race.time).toBeGreaterThanOrEqual(0);
  });

  it('a 1-lap race with 4 AI opponents finishes with valid standings and lap times', () => {
    const steerSign = calibrateSteerSign();
    const autopilot = new Autopilot(steerSign);
    const race = makeRace({ laps: 1, opponents: 4, difficulty: 'normal' });
    const dt = PHYSICS.subStep;
    const maxSteps = Math.round(300 / dt);
    const lastTotalS = new Map<number, number>();
    const monotonicViolations: string[] = [];
    let steps = 0;

    for (; steps < maxSteps && race.phase !== 'finished'; steps++) {
      stepRace(race, dt, autopilot.input(race));
      for (const racer of race.racers) {
        const previous = lastTotalS.get(racer.id);
        if (previous !== undefined && racer.progress.totalS < previous - 1e-6) {
          monotonicViolations.push(
            `racer ${racer.id} totalS went ${previous.toFixed(4)} -> ${racer.progress.totalS.toFixed(4)} at step ${steps}`,
          );
        }
        lastTotalS.set(racer.id, racer.progress.totalS);
        if (monotonicViolations.length > 20) break;
      }
    }

    // The race must actually finish (not just run forever).
    expect(race.phase).toBe('finished');
    expect(race.player.finished).toBe(true);
    expect(steps).toBeLessThan(maxSteps);
    expect(monotonicViolations.slice(0, 10)).toEqual([]);

    // Racers: unique ids, unique contiguous places 1..N, valid positions.
    expect(new Set(race.racers.map((r) => r.id)).size).toBe(race.racers.length);
    expect(race.standings.length).toBe(race.racers.length);
    const places = race.standings.map((r) => r.place).sort((a, b) => a - b);
    expect(places).toEqual(Array.from({ length: race.racers.length }, (_, i) => i + 1));
    for (let i = 0; i < race.standings.length; i++) {
      expect(race.standings[i]!.place).toBe(i + 1);
    }

    // Lap timing bookkeeping.
    for (const racer of race.racers) {
      expect(racer.lapTimes.length).toBeLessThanOrEqual(race.config.laps);
      for (const lapTime of racer.lapTimes) {
        expect(Number.isFinite(lapTime)).toBe(true);
        expect(lapTime).toBeGreaterThan(2);
        expect(lapTime).toBeLessThan(600);
      }
      if (racer.bestLap != null) {
        expect(racer.bestLap).toBe(Math.min(...racer.lapTimes));
      }
      if (racer.finished) {
        expect(racer.lapTimes.length).toBe(race.config.laps);
        expect(racer.finishTime).not.toBeNull();
      }
    }

    // The player completed their laps and the finish order is coherent.
    expect(race.player.lapTimes.length).toBe(race.config.laps);
    expect(race.player.lapTimes.length).toBeGreaterThan(0);
    expect(race.player.bestLap).not.toBeNull();
    expect(race.player.bestLap!).toBeGreaterThan(2);
    expect(race.player.progress.totalS).toBeGreaterThan(race.track.length * race.config.laps * 0.9);
    expect(race.player.lap).toBeGreaterThanOrEqual(1);
    expect(race.finishedOrder.length).toBeGreaterThan(0);
    expect(race.finishedOrder[0]).toBe(race.standings[0]);
  });

  it('lap times grow as laps are completed and never go backwards', () => {
    const steerSign = calibrateSteerSign();
    const autopilot = new Autopilot(steerSign);
    const race = makeRace({ laps: 2, opponents: 1, difficulty: 'easy' });
    const dt = PHYSICS.subStep;
    const maxSteps = Math.round(300 / dt);
    let lastCount = 0;
    let completed = false;

    for (let i = 0; i < maxSteps; i++) {
      if (race.phase === 'finished') {
        completed = true;
        break;
      }
      stepRace(race, dt, autopilot.input(race));
      const count = race.player.lapTimes.length;
      expect(count).toBeGreaterThanOrEqual(lastCount); // never shrinks
      lastCount = count;
      expect(count).toBeLessThanOrEqual(race.config.laps);
    }

    expect(completed || race.player.lap >= 1).toBe(true);
    for (let i = 1; i < race.player.lapTimes.length; i++) {
      // A lap time is a duration, so it must stay positive; total elapsed time
      // derived from it must strictly increase with the lap index.
      const cumulative = race.player.lapTimes.slice(0, i + 1).reduce((a, b) => a + b, 0);
      const previousCumulative = race.player.lapTimes.slice(0, i).reduce((a, b) => a + b, 0);
      expect(cumulative).toBeGreaterThan(previousCumulative);
    }
  });
});
