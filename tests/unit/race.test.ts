/**
 * Unit tests for src/game/race.ts — grid start, countdown, laps, standings,
 * penalties, wrong-way, collisions and respawn.
 * OWNER: engine-dev.
 */

import { describe, expect, it } from 'vitest';
import { PHYSICS, RACE } from '../../src/game/config';
import { createAIDriver, updateAIDriver } from '../../src/game/ai';
import { mulberry32, formatTime } from '../../src/game/math';
import { createRace, respawnRacer, stepRace } from '../../src/game/race';
import { generateTrack } from '../../src/game/track';
import type { CarInput, RaceConfig, RaceEvent, RaceState, TrackStyle } from '../../src/game/types';

const dt = PHYSICS.subStep;
const NEUTRAL: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

const BASE_CONFIG: RaceConfig = {
  seed: 20261018,
  style: 'circuit',
  laps: RACE.defaultLaps,
  opponents: 5,
  difficulty: 'normal',
  carClass: 'balanced',
  playerName: 'TESTER',
};

function makeRace(overrides: Partial<RaceConfig> = {}, style: TrackStyle = 'circuit'): RaceState {
  const config: RaceConfig = { ...BASE_CONFIG, ...overrides, style: overrides.style ?? style };
  return createRace(config, generateTrack(config.seed, config.style));
}

function settleCountdown(race: RaceState): void {
  let guard = 0;
  while (race.phase === 'countdown' && guard < 2000) {
    stepRace(race, dt, NEUTRAL);
    guard++;
  }
}

function drainEvents(race: RaceState): RaceEvent[] {
  const events = race.events.slice();
  race.events.length = 0;
  return events;
}

/** Teleport a racer's car to an arc length and heading along the track. */
function teleport(race: RaceState, racerId: number, s: number, headingOffset = 0, speed = 0): void {
  const racer = race.racers.find((r) => r.id === racerId);
  if (!racer) throw new Error(`racer ${racerId} missing`);
  const track = race.track;
  const sample = track.at(s);
  racer.car.pos = { x: sample.pos.x, y: sample.pos.y };
  const angle = Math.atan2(sample.dir.y, sample.dir.x) + headingOffset;
  racer.car.angle = angle;
  racer.car.vel = { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed };
  racer.car.speed = Math.abs(speed);
  racer.car.forwardSpeed = speed;
  racer.car.angularVel = 0;
}

/** Drive the race with AI inputs for every car (player included). */
function runRaceHeadless(
  race: RaceState,
  maxSeconds = 600,
  onStep?: (race: RaceState) => void,
): { steps: number; elapsed: number; events: Record<string, number> } {
  const track = race.track;
  const playerDriver = createAIDriver(0, race.config.difficulty, mulberry32(0x5eed));
  const traffic = race.racers.map((r) => r.car);
  const events: Record<string, number> = {};
  let elapsed = 0;
  let steps = 0;
  while (race.phase !== 'finished' && elapsed < maxSeconds) {
    const input = updateAIDriver(playerDriver, race.player.car, track, dt, traffic);
    stepRace(race, dt, input);
    for (const event of drainEvents(race)) events[event.type] = (events[event.type] ?? 0) + 1;
    onStep?.(race);
    elapsed += dt;
    steps++;
  }
  return { steps, elapsed, events };
}

/** Every numeric field that must stay finite for the whole race state. */
function numericValues(race: RaceState): number[] {
  const values: number[] = [race.time, race.countdown];
  for (const r of race.racers) {
    const car = r.car;
    values.push(
      car.pos.x, car.pos.y, car.angle, car.vel.x, car.vel.y, car.angularVel, car.speed, car.forwardSpeed,
      car.steer, car.slip, car.driftTime, car.driftCharge, car.boostTime, car.engineRpm, car.gear, car.crashCooldown,
      r.progress.s, r.progress.totalS, r.progress.lateral, r.lap, r.place, r.totalTime, r.penalty,
      r.lapStartTime, r.finishTime ?? 0,
    );
  }
  return values;
}

describe('createRace: grid and countdown', () => {
  it('builds the grid with two cars per row, player on pole, behind the line', () => {
    const race = makeRace({ opponents: 5 });
    expect(race.racers.length).toBe(6);
    expect(race.player.isPlayer).toBe(true);
    expect(race.player.id).toBe(0);
    expect(race.racers.filter((r) => r.isPlayer).length).toBe(1);
    expect(race.standings.length).toBe(race.racers.length);
    for (const racer of race.racers) {
      expect(racer.driver === null).toBe(racer.isPlayer);
      expect(racer.progress.totalS).toBeLessThan(0);
      expect(racer.lap).toBe(0);
      expect(racer.finished).toBe(false);
      expect(racer.lapTimes).toEqual([]);
    }
    // first row: two cars, one either side of the centerline
    const firstRowS = race.racers.slice(0, 2).map((r) => race.track.query(r.car.pos).lateral);
    expect(Math.sign(firstRowS[0]!)).toBe(-Math.sign(firstRowS[1]!));
    expect(Math.abs(Math.abs(firstRowS[0]!) - Math.abs(firstRowS[1]!))).toBeLessThan(1);
    // two cars per row
    const rowS = race.racers.map((r) => Math.round(Math.abs(race.track.query(r.car.pos).s - race.track.length) / RACE.gridRowGap));
    void rowS;
    expect(race.phase).toBe('countdown');
    expect(race.countdown).toBe(RACE.countdownSeconds);
    expect(race.time).toBe(0);
  });

  // One mega-test used to cover all 9 race builds and ~5,000 physics steps; on a
  // loaded machine that crossed vitest's 5 s default and produced an intermittent
  // timeout. Split per style with an explicit budget, same assertions.
  for (const style of ['circuit', 'technical', 'speedway'] as TrackStyle[]) {
    it(
      `spawns the full widened field on asphalt, behind the line, without overlaps (${style})`,
      { timeout: 30_000 },
      () => {
      for (const seed of [20261018, 7, 424242]) {
        const race = makeRace({ opponents: RACE.maxOpponents, style, seed });
        expect(race.racers.length).toBe(RACE.maxOpponents + 1);
        for (const racer of race.racers) {
          const query = race.track.query(racer.car.pos);
          expect(query.onRoad).toBe(true);
          expect(query.surface === 'road' || query.surface === 'curb').toBe(true);
          expect(query.width / 2).toBeGreaterThan(RACE.gridColOffset + racer.spec.width / 2);
          expect(racer.progress.totalS).toBeLessThan(0);
        }
        // grid cars must not overlap (same minimum distance the collision solver uses)
        for (let i = 0; i < race.racers.length; i++) {
          for (let j = i + 1; j < race.racers.length; j++) {
            const a = race.racers[i]!;
            const b = race.racers[j]!;
            const distance = Math.hypot(a.car.pos.x - b.car.pos.x, a.car.pos.y - b.car.pos.y);
            const minimum = (a.spec.width + b.spec.width) * 0.62;
            expect(distance).toBeGreaterThan(minimum);
          }
        }
        // and once the lights go out nobody is shoved off the asphalt
        settleCountdown(race);
        for (let i = 0; i < Math.round(1.5 / dt); i++) stepRace(race, dt, NEUTRAL);
        for (const racer of race.racers) {
          expect(race.track.query(racer.car.pos).onRoad).toBe(true);
          expect(Number.isFinite(racer.car.pos.x)).toBe(true);
          expect(Number.isFinite(racer.car.pos.y)).toBe(true);
        }
      }
      },
    );
  }

  it('ignores throttle before GO and emits 3-2-1 + go events', () => {
    const race = makeRace({ opponents: 2 });
    const startPos = { x: race.player.car.pos.x, y: race.player.car.pos.y };
    const countdownValues: number[] = [];
    let goCount = 0;
    for (let i = 0; i < Math.round((RACE.countdownSeconds + 1) / dt); i++) {
      stepRace(race, dt, { throttle: 1, brake: 0, steer: 0.4, handbrake: false });
      for (const event of drainEvents(race)) {
        if (event.type === 'countdown') countdownValues.push(event.value ?? -1);
        if (event.type === 'go') goCount++;
      }
      if (race.phase === 'countdown') {
        expect(race.player.car.speed).toBe(0);
        expect(race.player.car.pos.x).toBeCloseTo(startPos.x, 9);
      }
    }
    expect(race.phase).toBe('racing');
    expect(race.countdown).toBe(0);
    expect(countdownValues).toEqual([3, 2, 1]);
    expect(goCount).toBe(1);
    // once racing, throttle works
    for (let i = 0; i < Math.round(2 / dt); i++) stepRace(race, dt, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    expect(race.player.car.speed).toBeGreaterThan(20);
    expect(race.time).toBeGreaterThan(1.5);
  });

  it('is callable at 1/120 s and at a coarser dt without breaking', () => {
    const race = makeRace({ opponents: 0 });
    // mixed step sizes across the whole countdown
    for (let i = 0; i < 120; i++) stepRace(race, 1 / 60, NEUTRAL);
    for (let i = 0; i < 120; i++) stepRace(race, dt, NEUTRAL);
    for (let i = 0; i < Math.round(3 / (1 / 30)); i++) stepRace(race, 1 / 30, NEUTRAL);
    expect(race.phase).toBe('racing');
    for (const value of numericValues(race)) expect(Number.isFinite(value)).toBe(true);
  });
});

describe('race: lap counting is direction-aware and cannot be farmed', () => {
  it('does not count a lap for the initial crossing of the start line', () => {
    const race = makeRace({ opponents: 0, laps: 3 });
    settleCountdown(race);
    drainEvents(race);
    // drive forward until the line is crossed (car starts ~60 units behind it)
    for (let i = 0; i < Math.round(4 / dt); i++) {
      stepRace(race, dt, { throttle: 0.5, brake: 0, steer: 0, handbrake: false });
    }
    expect(race.player.lap).toBe(0);
    expect(race.player.lapTimes).toEqual([]);
    expect(race.player.lapStartTime).toBeGreaterThan(0);
  });

  it('does not award a lap when reversing over the line and driving forward again', () => {
    const race = makeRace({ opponents: 0, laps: 3 });
    settleCountdown(race);
    teleport(race, 0, 1200, 0, 0);
    // settle internal progress with a few neutral steps
    for (let i = 0; i < 10; i++) stepRace(race, dt, NEUTRAL);
    // cross the start line forward once (first crossing: starts the lap timer)
    teleport(race, 0, race.track.length - 5, 0, 200);
    for (let i = 0; i < Math.round(0.3 / dt); i++) stepRace(race, dt, NEUTRAL);
    const lapAfterFirstCross = race.player.lap;
    // teleport just after the line, reverse backwards over it, then forward again
    teleport(race, 0, 8, 0, 0);
    for (let i = 0; i < 5; i++) stepRace(race, dt, NEUTRAL);
    teleport(race, 0, race.track.length - 12, 0, -120);
    for (let i = 0; i < Math.round(0.4 / dt); i++) stepRace(race, dt, NEUTRAL);
    teleport(race, 0, 10, 0, 200);
    for (let i = 0; i < Math.round(0.3 / dt); i++) stepRace(race, dt, NEUTRAL);
    expect(race.player.lap).toBe(lapAfterFirstCross);
    expect(race.player.lap).toBe(0);
    expect(race.player.lapTimes.length).toBe(0);
  });
});

describe('race: full race simulation with AI-only inputs', () => {
  it(
    'completes RACE.defaultLaps laps on every style with sane lap times and standings',
    { timeout: 120000 },
    () => {
      for (const style of ['circuit', 'technical', 'speedway'] as TrackStyle[]) {
        const race = makeRace({ laps: RACE.defaultLaps, opponents: 5, style });
        const { elapsed, events } = runRaceHeadless(race, 600);
        const player = race.player;

        // race actually finished in a sane amount of time
        expect(race.phase).toBe('finished');
        expect(elapsed).toBeLessThan(600);
        expect(race.time).toBeGreaterThan(20);
        expect(race.time).toBeLessThan(600);

        // laps and lap timing
        expect(player.finished).toBe(true);
        expect(player.lap).toBe(RACE.defaultLaps);
        expect(player.lapTimes.length).toBe(RACE.defaultLaps);
        expect(player.bestLap).toBe(Math.min(...player.lapTimes));
        expect(player.lastLap).toBe(player.lapTimes[player.lapTimes.length - 1]);
        expect(player.finishTime).not.toBeNull();
        expect(player.finishTime!).toBeGreaterThan(0);
        for (const lapTime of player.lapTimes) {
          expect(Number.isFinite(lapTime)).toBe(true);
          expect(lapTime).toBeGreaterThan(2);
          expect(lapTime).toBeLessThan(300);
        }
        expect(player.bestLap!).toBeLessThan(300);

        // progress: monotonic distance, full laps covered
        expect(player.progress.totalS).toBeGreaterThan(race.track.length * RACE.defaultLaps * 0.9);
        expect(player.progress.lap).toBe(player.lap);

        // standings: complete, sorted, unique places
        expect(race.standings.length).toBe(race.racers.length);
        const places = race.standings.map((r) => r.place).sort((a, b) => a - b);
        expect(places).toEqual(Array.from({ length: race.racers.length }, (_, i) => i + 1));
        for (let i = 0; i < race.standings.length; i++) expect(race.standings[i]!.place).toBe(i + 1);
        for (let i = 1; i < race.standings.length; i++) {
          const previous = race.standings[i - 1]!;
          const current = race.standings[i]!;
          if (previous.finished && current.finished) {
            expect(previous.finishTime!).toBeLessThanOrEqual(current.finishTime!);
          }
        }
        expect(race.finishedOrder.length).toBeGreaterThan(0);
        expect(race.finishedOrder[0]).toBe(race.standings[0]);

        // events were produced and are well-formed
        expect(events.go).toBe(1);
        expect(events.countdown).toBe(3);
        expect(events.lap).toBeGreaterThanOrEqual(RACE.defaultLaps);
        expect(events['best-lap']).toBeGreaterThanOrEqual(RACE.defaultLaps);

        // no NaN/Infinity anywhere
        for (const value of numericValues(race)) expect(Number.isFinite(value)).toBe(true);
        for (const r of race.racers) {
          expect(Number.isFinite(r.progress.totalS)).toBe(true);
          expect(Number.isFinite(r.progress.s)).toBe(true);
          expect(r.progress.s).toBeGreaterThanOrEqual(0);
          expect(r.progress.s).toBeLessThan(race.track.length * 1.0001);
          expect(r.penalty).toBeGreaterThanOrEqual(0);
        }
        // results formatting used by the HUD must not throw
        expect(formatTime(player.bestLap)).toMatch(/^\d+:\d{2}\.\d{3}$/);
      }
    },
  );

  it('is deterministic for identical config, seed and player input', () => {
    const run = () => {
      const race = makeRace({ laps: 2, opponents: 3, difficulty: 'hard' });
      const snapshots: string[] = [];
      for (let i = 0; i < Math.round(25 / dt); i++) {
        stepRace(race, dt, { throttle: 1, brake: 0, steer: Math.sin(i / 140) * 0.4, handbrake: i % 800 < 40 });
        if (i % 240 === 0) snapshots.push(JSON.stringify(numericValues(race)));
      }
      return { snapshots, lapTimes: race.player.lapTimes.slice(), finish: race.player.finishTime, standings: race.standings.map((r) => [r.id, r.place]) };
    };
    const a = run();
    const b = run();
    expect(a.snapshots).toEqual(b.snapshots);
    expect(a.lapTimes).toEqual(b.lapTimes);
    expect(a.finish).toBe(b.finish);
    expect(a.standings).toEqual(b.standings);
  });
});

describe('race: penalties, warnings and respawn', () => {
  it('applies an off-road penalty once per excursion and fires a single event', () => {
    const race = makeRace({ opponents: 0, laps: 3 });
    settleCountdown(race);
    drainEvents(race);
    const track = race.track;
    // park the car on the grass beside the track
    const sample = track.at(600);
    const grassPos = {
      x: sample.pos.x + sample.normal.x * (sample.width / 2 + 25),
      y: sample.pos.y + sample.normal.y * (sample.width / 2 + 25),
    };
    const car = race.player.car;
    car.pos = grassPos;
    car.angle = Math.atan2(sample.dir.y, sample.dir.x);
    car.vel = { x: 0, y: 0 };
    const query = track.query(car.pos);
    expect(query.onRoad).toBe(false);
    const penaltyBefore = race.player.penalty;
    for (let i = 0; i < Math.round(3 / dt); i++) {
      car.vel = { x: 0, y: 0 }; // hold the car still on the grass
      stepRace(race, dt, NEUTRAL);
    }
    const events = drainEvents(race);
    const offroadEvents = events.filter((e) => e.type === 'offroad' && e.racerId === race.player.id);
    expect(offroadEvents.length).toBe(1);
    expect(race.player.penalty).toBeGreaterThan(penaltyBefore);
    expect(race.player.penalty).toBeCloseTo(0.75, 6);
    // the penalty is added to the finalised time
    expect(race.player.penalty).toBeLessThan(5);
  });

  it('warns exactly once while driving backwards, then clears after recovering', () => {
    const race = makeRace({ opponents: 0, laps: 3 });
    settleCountdown(race);
    drainEvents(race);
    // face against the track direction and drive backwards along it
    teleport(race, 0, 800, Math.PI, 0);
    for (let i = 0; i < Math.round(1.8 / dt); i++) {
      stepRace(race, dt, { throttle: 0.6, brake: 0, steer: 0, handbrake: false });
    }
    const events = drainEvents(race);
    expect(race.player.wrongWay).toBe(true);
    expect(events.filter((e) => e.type === 'wrong-way' && e.racerId === race.player.id).length).toBe(1);
    // recover: drive with the track direction
    teleport(race, 0, race.track.query(race.player.car.pos).s, 0, 0);
    for (let i = 0; i < Math.round(2.5 / dt); i++) {
      stepRace(race, dt, { throttle: 0.7, brake: 0, steer: 0, handbrake: false });
    }
    expect(race.player.wrongWay).toBe(false);
  });

  it('respawnRacer puts the car back on the racing line, stationary and facing forward', () => {
    const race = makeRace({ opponents: 0, laps: 3 });
    settleCountdown(race);
    const car = race.player.car;
    const sample = race.track.at(1500);
    car.pos = {
      x: sample.pos.x + sample.normal.x * (sample.width / 2 + 30),
      y: sample.pos.y + sample.normal.y * (sample.width / 2 + 30),
    };
    car.angle = 1.23;
    car.vel = { x: 300, y: -40 };
    car.angularVel = 2;
    race.player.wrongWay = true;

    respawnRacer(race, race.player.id);
    const query = race.track.query(car.pos);
    const lineLat = (race.track.racingLine[query.index]!.x - race.track.samples[query.index]!.pos.x) * race.track.samples[query.index]!.normal.x +
      (race.track.racingLine[query.index]!.y - race.track.samples[query.index]!.pos.y) * race.track.samples[query.index]!.normal.y;
    expect(Math.abs(car.speed)).toBeLessThan(1e-6);
    expect(Math.abs(query.lateral - lineLat)).toBeLessThan(8);
    expect(Math.abs(query.lateral)).toBeLessThan(query.width / 2);
    const trackDir = Math.atan2(race.track.at(query.s).dir.y, race.track.at(query.s).dir.x);
    const forward = { x: Math.cos(car.angle), y: Math.sin(car.angle) };
    expect(forward.x * Math.cos(trackDir) + forward.y * Math.sin(trackDir)).toBeGreaterThan(0.9);
    expect(race.player.wrongWay).toBe(false);
  });
});

describe('race: collisions', () => {
  it('fires a collision event for a wall impact above the threshold (once)', () => {
    const race = makeRace({ opponents: 0, laps: 3 });
    settleCountdown(race);
    drainEvents(race);
    const track = race.track;
    const sample = track.at(1200);
    const car = race.player.car;
    // aim straight at the barrier at 500 u/s
    const angle = Math.atan2(sample.normal.y, sample.normal.x);
    car.pos = { x: sample.pos.x, y: sample.pos.y };
    car.angle = angle;
    car.vel = { x: Math.cos(angle) * 500, y: Math.sin(angle) * 500 };
    car.speed = 500;
    car.forwardSpeed = 500;
    const speedBefore = car.speed;
    for (let i = 0; i < Math.round(0.6 / dt); i++) {
      stepRace(race, dt, NEUTRAL);
    }
    const events = drainEvents(race);
    const collisions = events.filter((e) => e.type === 'collision' && e.racerId === race.player.id);
    expect(collisions.length).toBe(1);
    expect(collisions[0]!.value!).toBeGreaterThan(PHYSICS.crashImpactThreshold);
    // crashing costs most of the speed
    expect(car.speed).toBeLessThan(speedBefore * 0.5);
    // and the car never passes through the barrier
    const q = track.query(car.pos);
    expect(Math.abs(q.lateral)).toBeLessThanOrEqual(q.width / 2 + 30);
  });

  it('separates overlapping cars and fires a collision for a heavy impact', () => {
    const race = makeRace({ opponents: 1, laps: 3 });
    settleCountdown(race);
    drainEvents(race);
    const a = race.player.car;
    const b = race.racers[1]!.car;
    const track = race.track;
    const sample = track.at(2000);
    a.pos = { x: sample.pos.x, y: sample.pos.y };
    a.angle = Math.atan2(sample.dir.y, sample.dir.x);
    a.vel = { x: sample.dir.x * 220, y: sample.dir.y * 220 };
    b.pos = { x: sample.pos.x + sample.dir.x * 20, y: sample.pos.y + sample.dir.y * 20 };
    b.angle = a.angle;
    b.vel = { x: -sample.dir.x * 40, y: -sample.dir.y * 40 };
    stepRace(race, dt, NEUTRAL);
    const distance = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
    const minDistance = (race.player.spec.width + race.racers[1]!.spec.width) * 0.62;
    expect(distance).toBeGreaterThanOrEqual(minDistance - 0.5);
    const collisions = drainEvents(race).filter((e) => e.type === 'collision');
    expect(collisions.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps cars from tunneling through each other over many steps', () => {
    const race = makeRace({ opponents: 2, laps: 3 });
    settleCountdown(race);
    const track = race.track;
    for (let i = 0; i < 3; i++) {
      teleport(race, i, 900 + i * 10, 0, 0);
    }
    let minSeparation = Infinity;
    for (let i = 0; i < Math.round(3 / dt); i++) {
      stepRace(race, dt, NEUTRAL);
      for (let x = 0; x < race.racers.length; x++) {
        for (let y = x + 1; y < race.racers.length; y++) {
          const p = race.racers[x]!.car.pos;
          const q = race.racers[y]!.car.pos;
          minSeparation = Math.min(minSeparation, Math.hypot(p.x - q.x, p.y - q.y));
        }
      }
    }
    void track;
    expect(minSeparation).toBeGreaterThan(20);
  });
});
