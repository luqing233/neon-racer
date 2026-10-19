/**
 * Independent determinism tests.
 *
 * The contract in src/game/types.ts says the simulation is deterministic given
 * (seed, inputs). These tests feed identical scripted inputs into two separate
 * RaceState instances and require bit-identical snapshots, including the AI.
 */

import { describe, expect, it } from 'vitest';
import { PHYSICS } from '../../src/game/config';
import { stepRace } from '../../src/game/race';
import type { CarInput } from '../../src/game/types';
import {
  makeRace,
  makeTrack,
  raceSnapshot,
  trackSnapshot,
} from './helpers';

/** Deterministic scripted driver input: mostly flat out, weaving, occasional handbrake. */
function scriptedInput(step: number): CarInput {
  return {
    throttle: 1,
    brake: 0,
    steer: Math.sin(step / 150) * 0.45,
    handbrake: step % 900 < 50,
  };
}

describe('determinism', () => {
  it('generateTrack(seed, style) is deterministic', () => {
    const a = trackSnapshot(makeTrack(424242, 'technical'));
    const b = trackSnapshot(makeTrack(424242, 'technical'));
    expect(b).toBe(a);
  });

  it('different seeds produce different tracks', () => {
    expect(trackSnapshot(makeTrack(1, 'circuit'))).not.toBe(trackSnapshot(makeTrack(2, 'circuit')));
  });

  it('identical scripted input produces identical race samples and outcome', () => {
    const raceA = makeRace({ laps: 1, opponents: 4, difficulty: 'hard' });
    const raceB = makeRace({ laps: 1, opponents: 4, difficulty: 'hard' });
    const dt = PHYSICS.subStep;
    const totalSteps = Math.round(45 / dt);
    let comparedSamples = 0;

    for (let i = 0; i < totalSteps; i++) {
      if (raceA.phase === 'finished' && raceB.phase === 'finished') break;
      const input = scriptedInput(i);
      stepRace(raceA, dt, input);
      stepRace(raceB, dt, input);
      if (i % 60 === 0) {
        expect(raceSnapshot(raceB)).toBe(raceSnapshot(raceA));
        comparedSamples += 1;
      }
    }

    expect(comparedSamples).toBeGreaterThan(10);
    expect(raceSnapshot(raceB)).toBe(raceSnapshot(raceA));
    expect(raceB.time).toBe(raceA.time);
    expect(raceB.standings.map((r) => r.id)).toEqual(raceA.standings.map((r) => r.id));
    expect(raceB.finishedOrder.map((r) => r.id)).toEqual(raceA.finishedOrder.map((r) => r.id));
  });

  it('AI-only simulation is deterministic per seed', () => {
    // opponents become AI; the player is left neutral so the AI is what matters.
    const raceA = makeRace({ laps: 1, opponents: 3, difficulty: 'insane' });
    const raceB = makeRace({ laps: 1, opponents: 3, difficulty: 'insane' });
    const dt = PHYSICS.subStep;
    const neutral: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    for (let i = 0; i < Math.round(20 / dt); i++) {
      stepRace(raceA, dt, neutral);
      stepRace(raceB, dt, neutral);
      if (i % 120 === 0) expect(raceSnapshot(raceB)).toBe(raceSnapshot(raceA));
    }
    expect(raceSnapshot(raceB)).toBe(raceSnapshot(raceA));
  });
});
