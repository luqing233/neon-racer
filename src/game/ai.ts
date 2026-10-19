/**
 * NEON RACER — AI drivers.
 *
 * OWNER: engine-dev.
 *
 * The AI follows the generated racing line with speed-sensitive look-ahead, brakes
 * for corners using a lateral-grip budget derived from its skill, dodges traffic,
 * makes occasional mistakes, and reverses out of trouble when it gets stuck.
 * Randomness comes exclusively from the driver's seeded RNG → fully deterministic.
 */

import { PHYSICS } from './config';
import { clamp, clamp01, wrapAngle } from './math';
import { racingLineLateralAt } from './track';
import type { AIDriver, CarInput, CarState, Difficulty, Rng, Track, TrackSample } from './types';

/* ------------------------------------------------------------------ tuning -- */

/**
 * Lateral acceleration the AI is willing to use (units/s²). Slightly below the
 * car's real limit (~620) so it never washes out in a corner.
 */
const AI_LATERAL_GRIP = 560;
/** AI deceleration budget used for braking-distance prediction, units/s² */
const AI_BRAKE = 760;
/**
 * Straight-line target speed when no corner is in sight. Deliberately above any
 * car's top speed: the vehicle model owns the speed cap, the AI just goes flat out.
 */
const AI_TOP_SPEED = 900;
/** how far ahead corners are scanned, units */
const MAX_SCAN = 1150;
/** preferred gap to the car in front when trying a pass, units */
const PASS_GAP = 76;

/* ------------------------------------------------------------------ create -- */

/**
 * Difficulty is baked into `skill` (0..1 whole-career scale) so that the rest of
 * the AI (which only has the driver record, not the race config) can recover the
 * pace/reaction/mistake profile without extra state.
 */
function skillFor(difficulty: Difficulty, rng: Rng): number {
  switch (difficulty) {
    case 'easy':
      return 0.2 + rng() * 0.1;
    case 'normal':
      return 0.42 + rng() * 0.1;
    case 'hard':
      return 0.62 + rng() * 0.1;
    case 'insane':
    default:
      return 0.82 + rng() * 0.1;
  }
}

function mistakeRateFor(skill: number): number {
  // 0.13 …/s for a rookie up to ~0.04 …/s for an alien — mirrors DIFFICULTY.mistakeRate
  return 0.022 + (1 - skill) * 0.16;
}

export function createAIDriver(id: number, difficulty: Difficulty, rng: Rng): AIDriver {
  const skill = clamp01(skillFor(difficulty, rng));
  return {
    id,
    skill,
    aggression: 0.15 + skill * 0.9,
    lineBias: (rng() - 0.5) * 42,
    lookahead: 240,
    targetS: 0,
    wobblePhase: rng() * Math.PI * 2,
    reactionTimer: 0,
    stuckTimer: 0,
    recovering: 0,
    rng,
  };
}

/* -------------------------------------------------------------------- step -- */

/**
 * Radius of curvature of the racing line itself, cached per track. The line cuts
 * to the inside of corners and is therefore slightly tighter than the centerline;
 * using it for the speed plan keeps the AI from entering corners too hot.
 */
const lineRadiusCache = new WeakMap<Track, Float32Array>();

function getLineRadius(track: Track): Float32Array {
  const cached = lineRadiusCache.get(track);
  if (cached) return cached;
  const n = track.samples.length;
  const line = track.racingLine;
  const radii = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = line[(i - 1 + n) % n] as { x: number; y: number };
    const b = line[i] as { x: number; y: number };
    const c = line[(i + 1) % n] as { x: number; y: number };
    const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (cross < 1e-9) {
      radii[i] = 1e9;
    } else {
      const ab = Math.hypot(b.x - a.x, b.y - a.y);
      const bc = Math.hypot(c.x - b.x, c.y - b.y);
      const ca = Math.hypot(a.x - c.x, a.y - c.y);
      radii[i] = (ab * bc * ca) / (2 * cross);
    }
  }
  lineRadiusCache.set(track, radii);
  return radii;
}

/** Curvature radius at a sample offset from the current position (no allocations). */
function radiusAhead(track: Track, lineRadii: Float32Array, startIndex: number, offset: number): number {
  const n = track.samples.length;
  const index = (startIndex + offset) % n;
  const sample = track.samples[index] as TrackSample;
  const k = Math.abs(sample.curvature);
  const centerRadius = k > 1e-6 ? 1 / k : 1e9;
  const lineRadius = lineRadii[index] as number;
  return centerRadius < lineRadius ? centerRadius : lineRadius;
}

export function updateAIDriver(
  driver: AIDriver,
  car: CarState,
  track: Track,
  dt: number,
  traffic: readonly CarState[],
): CarInput {
  const step = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.05) : PHYSICS.subStep;
  const q = track.query(car.pos);
  const n = track.samples.length;
  const lineRadii = getLineRadius(track);
  const baseIndex = Math.floor(q.s / track.step) % n;
  const speed = Math.abs(car.forwardSpeed);
  const skill = clamp01(driver.skill);

  /* --- timers ------------------------------------------------------------- */
  if (driver.reactionTimer > 0) driver.reactionTimer = Math.max(0, driver.reactionTimer - step);

  /* --- stuck recovery ------------------------------------------------------ */
  if (driver.recovering > 0) {
    driver.recovering -= step;
    const reversing = driver.recovering > 0.5;
    if (reversing) {
      // back away from whatever we are pinned against, steering the tail
      driver.stuckTimer = 0;
      return {
        throttle: 0,
        brake: 1,
        steer: driver.lineBias >= 0 ? -0.7 : 0.7,
        handbrake: false,
      };
    }
    // rejoin phase: creep forward and steer back onto the racing line
    driver.stuckTimer = 0;
    const targetLat = racingLineLateralAt(track, q.s + 120);
    const target = track.at(q.s + 120);
    const tx = target.pos.x + target.normal.x * targetLat;
    const ty = target.pos.y + target.normal.y * targetLat;
    const angleErr = wrapAngle(Math.atan2(ty - car.pos.y, tx - car.pos.x) - car.angle);
    return {
      throttle: car.speed < 90 ? 0.85 : 0.35,
      brake: 0,
      steer: clamp(angleErr * 2.2, -1, 1),
      handbrake: false,
    };
  }
  const lackOfProgress = speed < 26;
  if (lackOfProgress) {
    driver.stuckTimer += step;
  } else {
    driver.stuckTimer = Math.max(0, driver.stuckTimer - step * 2.5);
  }
  if (driver.stuckTimer > 1.25) {
    driver.stuckTimer = 0;
    driver.recovering = 1.45; // 0.95 s reverse + 0.5 s rejoin
  }

  /* --- mistakes ----------------------------------------------------------- */
  const mistakeRate = mistakeRateFor(skill);
  if (driver.reactionTimer <= 0 && driver.rng() < mistakeRate * step) {
    driver.reactionTimer = 0.45 + driver.rng() * 0.7;
  }
  const mistake = driver.reactionTimer > 0 ? clamp01(driver.reactionTimer / 0.6) : 0;

  /* --- desired target on the racing line ---------------------------------- */
  driver.lookahead = clamp(64 + speed * (0.34 + skill * 0.12), 110, 430);
  driver.wobblePhase += step * (1.3 + skill * 1.6);
  const wobble = Math.sin(driver.wobblePhase) * (3 + (1 - skill) * 5);
  driver.targetS = q.s + driver.lookahead;

  const targetIndex = Math.floor(driver.targetS / track.step) % n;
  const targetSample = track.samples[targetIndex] as TrackSample;
  const targetLineLat = racingLineLateralAt(track, driver.targetS);
  const roadLimit = targetSample.width / 2 - 22;
  let targetLat = clamp(targetLineLat + driver.lineBias * 0.35 + wobble, -roadLimit, roadLimit);

  /* --- traffic avoidance --------------------------------------------------- */
  let brakeForTraffic = 0;
  for (const other of traffic) {
    const dx = other.pos.x - car.pos.x;
    const dy = other.pos.y - car.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1 || d2 > 200 * 200) continue; // skip ourselves and distant cars
    const theirQ = track.query(other.pos);
    const ahead = track.deltaS(q.s, theirQ.s);
    const lateralGap = theirQ.lateral - q.lateral;
    if (ahead > 4 && ahead < 150) {
      const sameLane = Math.abs(lateralGap) < 64;
      if (sameLane) {
        // pull to whichever side has more room; low aggression = lift instead
        const passDir = lateralGap >= 0 ? -1 : 1;
        targetLat += passDir * (PASS_GAP - Math.abs(lateralGap) * 0.4) * (0.5 + driver.aggression);
        if (ahead < 66 && other.speed < speed * 0.9) {
          brakeForTraffic = Math.max(brakeForTraffic, (1 - driver.aggression) * 0.9 + 0.15);
        }
      }
    } else if (ahead < 4 && ahead > -30 && Math.abs(lateralGap) < 52) {
      // side by side: drift away slightly to leave room
      targetLat += (lateralGap >= 0 ? -1 : 1) * 26;
    }
  }
  targetLat = clamp(targetLat, -roadLimit, roadLimit);

  /* --- steering: pure pursuit with yaw damping ---------------------------- */
  const targetPos = {
    x: targetSample.pos.x + targetSample.normal.x * targetLat,
    y: targetSample.pos.y + targetSample.normal.y * targetLat,
  };
  let angleErr = Math.atan2(targetPos.y - car.pos.y, targetPos.x - car.pos.x) - car.angle;
  angleErr = wrapAngle(angleErr);
  const steerGain = 1.9 + skill * 1.3;
  let steer = clamp(angleErr * steerGain - car.angularVel * 0.1, -1, 1);
  if (mistake > 0) steer = clamp(steer + Math.sin(driver.wobblePhase * 2.7) * mistake * 0.55, -1, 1);
  // the racing-line cut is widened a little when sliding so the AI catches drifts
  if (car.drifting) steer = clamp(steer - clamp(car.slip, 0, 1) * 0.22, -1, 1);

  /* --- speed planning ----------------------------------------------------- */
  // lateral acceleration budget the AI dares to use, units/s²
  const pace = AI_LATERAL_GRIP * (0.6 + 0.42 * skill);
  const scan = Math.min(MAX_SCAN, speed * 1.55 + 200);
  const scanStride = Math.max(2, Math.round(20 / track.step));
  let vTarget = AI_TOP_SPEED;
  const scanSteps = Math.ceil(scan / (scanStride * track.step));
  for (let k = 1; k <= scanSteps; k++) {
    const offset = k * scanStride;
    const radius = radiusAhead(track, lineRadii, baseIndex, offset);
    const cornerSpeed = Math.sqrt(pace * Math.min(radius, 6000));
    const distance = offset * track.step;
    // speed we may hold now while still being able to slow to cornerSpeed in time
    const allowed = Math.sqrt(cornerSpeed * cornerSpeed + 2 * AI_BRAKE * distance);
    if (allowed < vTarget) vTarget = allowed;
    if (distance > scan) break;
  }

  /* --- boost on exits: charge the drift boost in tight corners ------------ */
  const upcomingRadius = radiusAhead(track, lineRadii, baseIndex, Math.max(2, Math.round(70 / track.step)));
  const handbrake = speed > 300 && upcomingRadius < 300 && skill > 0.55;

  let throttle = speed < vTarget * 0.985 ? 1 : 0;
  let brake = speed > vTarget * 1.045 ? 1 : 0;
  if (brake > 0) throttle = 0;
  if (mistake > 0) {
    throttle *= 1 - 0.7 * mistake;
    brake = Math.max(brake, mistake > 0.65 ? 0.35 : 0);
  }
  if (brakeForTraffic > 0) {
    throttle *= 1 - brakeForTraffic;
    if (brakeForTraffic > 0.55) brake = Math.max(brake, 0.7);
  }

  return {
    throttle: clamp01(throttle),
    brake: clamp01(brake),
    steer: clamp(steer, -1, 1),
    handbrake: handbrake && brake === 0 && !car.drifting,
  };
}

