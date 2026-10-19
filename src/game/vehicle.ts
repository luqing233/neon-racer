/**
 * NEON RACER — arcade car physics.
 *
 * OWNER: engine-dev.
 *
 * A compact bicycle model with arcade sensibilities:
 *   - engine force + quadratic drag + rolling resistance → topSpeed is a soft cap
 *   - front/rear tyre slip angles with a grip budget per axle (understeer when the
 *     front saturates, oversteer when the rear does)
 *   - handbrake + drift sustain reduce rear grip → controllable powerslides
 *   - sustained drifts fill driftCharge; a full charge grants one boost charge
 *   - wall barriers (width/2 + TRACK.runoff) reflect the car, never let it through
 *   - off-road grip/speed/rolling penalties arrive through StepOptions
 *
 * The step is fixed-substep (caller provides dt = PHYSICS.subStep), deterministic
 * and free of DOM/random access. Every division is guarded and the function
 * self-heals to a finite state should anything ever go non-finite.
 */

import { PHYSICS, TRACK } from './config';
import { clamp, clamp01, wrapAngle } from './math';
import type { CarInput, CarSpec, CarState, CarStepResult, StepOptions, Surface, Track, Vec2 } from './types';

/* ---------------------------------------------------------------- constants -- */

/** lateral acceleration budget granted per unit of engine power (arcade scale). */
const LATERAL_BUDGET_PER_POWER = 1.0;
/** virtual wheelbase relative to body length — arcade steering geometry */
const WHEELBASE_RATIO = 1.9;
/** yaw inertia: radius of gyration² relative to wheelbase² */
const YAW_INERTIA_RATIO = 1 / 6;
/** yaw scrub damping, 1/s */
const SCRUB_DAMPING = 2.5;
/** how quickly the front wheels reach the requested angle (multiplies spec.steerSpeed) */
const STEER_RESPONSE = 1.6;
/** slip angle (radians) at which a tyre reaches its grip limit */
const TYRE_SATURATION_SLIP = 0.11;
/** strength of the arcade countersteer assist once the car is genuinely sliding */
const COUNTER_STEER_ASSIST = 1.1;
/** |body slip| where the countersteer assist starts to wake up (radians) */
const ASSIST_SLIP_FLOOR = 0.22;
/** how much extra slip it takes for the assist to reach full strength */
const ASSIST_RANGE = 0.5;
/** hard cap on the assist's counter-steer (radians) — a nudge, not a takeover */
const ASSIST_MAX = 0.3;
/** while the handbrake is held the player is drifting on purpose: barely assist */
const HANDBRAKE_ASSIST_SCALE = 0.3;
/** body slip a handbrake drift settles at, before steering influence (radians) */
const DRIFT_ANGLE_BASE = 0.22;
/** extra drift angle per unit of steering input */
const DRIFT_ANGLE_STEER = 0.16;
/** never let the body slide further than this (radians, ~34°) */
const DRIFT_ANGLE_MAX = 0.42;
/** how fast the slip angle is driven towards the drift target, 1/s */
const DRIFT_BETA_RATE = 5;
/** cap on the slip-angle rate, rad/s */
const DRIFT_BETA_RATE_MAX = 2.5;
/** how quickly the yaw rate follows the drift target, 1/s */
const DRIFT_YAW_RESPONSE = 12;
/** yaw-rate cap while the handbrake is held, rad/s (prevents spins) */
const DRIFT_YAW_RATE_CAP = 2.2;
/** how fast a released drift bleeds its body slip back to zero, 1/s */
const DRIFT_RECOVERY_RATE = 3;
/** cap on the recovery slip-rate, rad/s */
const DRIFT_RECOVERY_MAX = 1.6;
/** how quickly the yaw rate follows the recovery target, 1/s */
const DRIFT_RECOVERY_RESPONSE = 7;
/** reduced handbrake drag once the car is sideways, so drifts keep momentum */
const HANDBRAKE_DRIFT_DRAG = 90;
/** speed-sensitive steering falloff: fraction of the lock kept at very high speed */
const STEER_SPEED_FALLOFF = 0.002;
const STEER_MIN_FRACTION = 0.62;
/** extra deceleration applied above the soft speed cap, units/s² per unit over */
const OVERSPEED_PULLBACK = 7;
/** handbrake longitudinal drag, units/s² */
const HANDBRAKE_DRAG = 300;
/** tangential speed kept per second while grinding along a barrier (12%/s loss) */
const WALL_SCRAPE_LOSS = 0.12;
/** how fast the nose is nudged towards the barrier tangent while wall-riding, rad/s */
const WALL_ALIGN_RATE = 3;
/** how quickly slip settles when nothing sustains it */
const SLIP_RELAX = 2.2;
/** boost speed allowance above the regular top speed */
const BOOST_TOP_SPEED_BONUS = 0.12;

/* ------------------------------------------------------------------ helpers -- */

const safe = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

const signOrZero = (v: number): number => (v > 1e-6 ? 1 : v < -1e-6 ? -1 : 0);

const allFinite = (car: CarState): boolean =>
  Number.isFinite(car.pos.x) &&
  Number.isFinite(car.pos.y) &&
  Number.isFinite(car.angle) &&
  Number.isFinite(car.vel.x) &&
  Number.isFinite(car.vel.y) &&
  Number.isFinite(car.angularVel) &&
  Number.isFinite(car.speed) &&
  Number.isFinite(car.steer) &&
  Number.isFinite(car.slip);

const NEUTRAL_RESULT: CarStepResult = {
  impact: 0,
  onRoad: true,
  surface: 'road',
  driftStart: false,
  driftEnd: false,
  skid: 0,
  wallContact: false,
};

/* ------------------------------------------------------------------- create -- */

export function createCarState(_spec: CarSpec, pos: Vec2, angle: number): CarState {
  return {
    pos: { x: safe(pos.x), y: safe(pos.y) },
    angle: safe(angle),
    vel: { x: 0, y: 0 },
    angularVel: 0,
    speed: 0,
    forwardSpeed: 0,
    steer: 0,
    slip: 0,
    drifting: false,
    driftTime: 0,
    driftCharge: 0,
    boostTime: 0,
    engineRpm: 0,
    gear: 1,
    handbrake: false,
    crashCooldown: 0,
    surface: 'road',
  };
}

/* --------------------------------------------------------------------- step -- */

export function stepCar(
  car: CarState,
  spec: CarSpec,
  input: CarInput,
  dt: number,
  track: Track,
  opts: StepOptions = {},
): CarStepResult {
  if (!(dt > 0) || !Number.isFinite(dt)) return NEUTRAL_RESULT;
  const step = Math.min(dt, 0.05); // one substep is 1/120; never integrate a huge frame

  const prevPos = { x: car.pos.x, y: car.pos.y };
  const prevAngle = car.angle;
  const prevDrifting = car.drifting;
  let impact = 0;
  let wallContact = false;

  const throttle = clamp01(safe(input.throttle));
  const brake = clamp01(safe(input.brake));
  const steerInput = clamp(safe(input.steer), -1, 1);
  const handbrake = input.handbrake === true;
  const gripScale = opts.gripScale ?? 1;
  const extraAccel = opts.extraAccel ?? 0;
  const topSpeedScale = opts.topSpeedScale ?? 1;

  /* --- body axes ---------------------------------------------------------- */
  const cosA = Math.cos(car.angle);
  const sinA = Math.sin(car.angle);
  const fx = cosA;
  const fy = sinA;
  const rx = -sinA;
  const ry = cosA;
  // current body-frame velocity (u forward, v to the driver's right)
  const u = car.vel.x * fx + car.vel.y * fy;
  const v = car.vel.x * rx + car.vel.y * ry;

  /* --- steering ----------------------------------------------------------- */
  const absU = Math.abs(u);
  const steerFalloff = clamp01(STEER_MIN_FRACTION + (1 - STEER_MIN_FRACTION) / (1 + absU * STEER_SPEED_FALLOFF));
  const steerMax = spec.maxSteer * steerFalloff;
  const steerTarget = steerInput * steerMax;
  car.steer += (steerTarget - car.steer) * (1 - Math.exp(-spec.steerSpeed * STEER_RESPONSE * step));
  car.steer = clamp(car.steer, -spec.maxSteer, spec.maxSteer);

  /* --- tyre grip budgets -------------------------------------------------- */
  const budget = spec.enginePower * LATERAL_BUDGET_PER_POWER;
  const frontGrip = (spec.gripFront / 0.9) * gripScale;
  let rearGrip = (spec.gripRear / 0.9) * gripScale;
  if (handbrake) rearGrip *= spec.handbrakeGrip;
  else if (car.drifting) rearGrip *= spec.driftGrip;
  const aFrontMax = (budget * 0.5 * frontGrip) / spec.mass;
  const aRearMax = (budget * 0.5 * rearGrip) / spec.mass;

  /* --- slip angles and tyre forces ---------------------------------------- */
  const wheelbase = spec.length * WHEELBASE_RATIO;
  const halfWheelbase = wheelbase * 0.5;
  const travelDir = signOrZero(u) || 1; // -1 while reversing
  const vFront = v + car.angularVel * halfWheelbase;
  const vRear = v - car.angularVel * halfWheelbase;
  const velScale = Math.max(Math.abs(u), 28);
  // Arcade stability assist: the "invisible hands" add a little countersteer
  // once the body starts sliding, so drifts settle instead of snapping into a spin.
  const speedAssist = clamp01((Math.abs(u) - 80) / 180);
  const bodySlipAngle = Math.atan2(v, Math.abs(u) || 1); // + = pointing right of travel
  const bodySlipAbs = Math.abs(bodySlipAngle);
  // The assist is a spin catcher: it stays silent through normal cornering AND
  // through the first part of a deliberate handbrake drift, and only counter-steers
  // once the car is well past the drift threshold. While Space is held it is scaled
  // right down, otherwise it would fight the driver out of the drift.
  const assistBlend = clamp01((bodySlipAbs - ASSIST_SLIP_FLOOR) / ASSIST_RANGE);
  const assistScale = handbrake ? HANDBRAKE_ASSIST_SCALE : 1;
  const assist = clamp(-bodySlipAngle * COUNTER_STEER_ASSIST * speedAssist * assistBlend * assistScale, -ASSIST_MAX, ASSIST_MAX);
  const steerEffective = clamp(car.steer - assist, -spec.maxSteer * 1.25, spec.maxSteer * 1.25);
  const slipFront = Math.atan2(vFront, velScale) - steerEffective * travelDir;
  const slipRear = Math.atan2(vRear, velScale);
  const stiffnessFront = aFrontMax / TYRE_SATURATION_SLIP;
  const stiffnessRear = aRearMax / TYRE_SATURATION_SLIP;
  const aFront = clamp(-stiffnessFront * slipFront, -aFrontMax, aFrontMax);
  const aRear = clamp(-stiffnessRear * slipRear, -aRearMax, aRearMax);

  /* --- longitudinal forces ------------------------------------------------ */
  const capBase = spec.topSpeed * topSpeedScale;
  const boostActive = car.boostTime > 0;
  const cap = capBase * (1 + (boostActive ? BOOST_TOP_SPEED_BONUS : 0));
  let engineFactor: number;
  if (cap <= 1e-3) {
    engineFactor = 0;
  } else {
    engineFactor = u < cap ? 1 : 0;
  }
  let longAccel = 0;
  if (brake > 0.02 && u > 3) {
    longAccel -= brake * spec.brakeForce;
  } else if (throttle > 0.02) {
    longAccel += throttle * spec.enginePower * engineFactor;
  } else if (brake > 0.02) {
    // reverse gear (only once the car has come to a halt)
    const reverseCap = spec.reverseSpeed * topSpeedScale;
    if (u > -reverseCap) longAccel -= brake * spec.enginePower * 0.62;
  }
  if (boostActive && throttle > 0.02) longAccel += spec.boostPower;
  if (handbrake && absU > 2) {
    // while the car is actually sideways the handbrake mostly locks the rear
    // laterally; scrubbing the full straight-line drag would kill the drift
    const sideways = bodySlipAbs > PHYSICS.driftSlipThreshold * 0.8;
    longAccel -= signOrZero(u) * (sideways ? HANDBRAKE_DRIFT_DRAG : HANDBRAKE_DRAG);
  }
  // quadratic drag + rolling resistance (never flips the sign of the velocity)
  longAccel -= spec.drag * u * Math.abs(u);
  const resist = spec.rollResist;
  if (absU > 1e-3) {
    const resistMag = Math.min(Math.abs(u) / step, resist);
    longAccel -= signOrZero(u) * resistMag;
  }
  longAccel += extraAccel;
  // hard pull-back above the soft cap (keep top speed honest, boostable)
  if (u > cap) longAccel -= (u - cap) * OVERSPEED_PULLBACK;

  /* --- yaw dynamics ------------------------------------------------------- */
  const inertia = wheelbase * wheelbase * YAW_INERTIA_RATIO;
  const yawAccel = (halfWheelbase * aFront - halfWheelbase * aRear) / inertia;
  car.angularVel += yawAccel * step;
  car.angularVel *= Math.exp(-SCRUB_DAMPING * step); // scrub damping keeps the model stable
  car.angularVel = clamp(car.angularVel, -7, 7);

  /*
   * Arcade drift governor. While Space is held above the drift speed the yaw rate
   * is *commanded* instead of left to the tyre force balance (which either decays
   * the slide or runs away into a spin):
   *   d(beta)/dt = d(velocity direction)/dt - yaw rate
   * so choosing a target body slip and solving for the yaw rate makes Space + steer
   * produce exactly the drift angle the player asked for, independent of grip noise.
   * Releasing Space hands the car straight back to the tyre model + spin catcher.
   */
  if (handbrake && absU > PHYSICS.driftMinSpeed * 0.9) {
    const direction = signOrZero(steerInput) !== 0 ? signOrZero(steerInput) : signOrZero(bodySlipAngle);
    if (direction !== 0) {
      const wanted = -direction * Math.min(DRIFT_ANGLE_MAX, DRIFT_ANGLE_BASE + DRIFT_ANGLE_STEER * Math.abs(steerInput));
      const speedAbs = Math.max(30, Math.hypot(car.vel.x, car.vel.y));
      const velocityTurnRate = ((aFront + aRear) * Math.cos(bodySlipAngle)) / speedAbs; // d(velocity dir)/dt
      const betaRate = clamp((wanted - bodySlipAngle) * DRIFT_BETA_RATE, -DRIFT_BETA_RATE_MAX, DRIFT_BETA_RATE_MAX);
      const omegaTarget = clamp(velocityTurnRate - betaRate, -DRIFT_YAW_RATE_CAP, DRIFT_YAW_RATE_CAP);
      car.angularVel += (omegaTarget - car.angularVel) * (1 - Math.exp(-DRIFT_YAW_RESPONSE * step));
      car.angularVel = clamp(car.angularVel, -DRIFT_YAW_RATE_CAP, DRIFT_YAW_RATE_CAP);
    }
  } else if (car.drifting && absU > 40) {
    // Release recovery: with Space up the drift angle is bled back to zero at a
    // controlled rate, so the car grips up and straightens instead of spinning.
    const speedAbs = Math.max(30, Math.hypot(car.vel.x, car.vel.y));
    const velocityTurnRate = ((aFront + aRear) * Math.cos(bodySlipAngle)) / speedAbs;
    const recovery = clamp(bodySlipAngle * DRIFT_RECOVERY_RATE, -DRIFT_RECOVERY_MAX, DRIFT_RECOVERY_MAX);
    const omegaTarget = clamp(velocityTurnRate + recovery, -DRIFT_YAW_RATE_CAP, DRIFT_YAW_RATE_CAP);
    car.angularVel += (omegaTarget - car.angularVel) * (1 - Math.exp(-DRIFT_RECOVERY_RESPONSE * step));
  }

  /* --- integrate ---------------------------------------------------------- */
  const latAccel = aFront + aRear;
  const ax = fx * longAccel + rx * latAccel;
  const ay = fy * longAccel + ry * latAccel;
  car.vel.x += ax * step;
  car.vel.y += ay * step;
  if (absU < 6 && throttle < 0.02 && brake < 0.02) {
    // parked: bleed residual creep so the car is genuinely stationary
    const damp = Math.exp(-8 * step);
    car.vel.x *= damp;
    car.vel.y *= damp;
  }
  car.angle = wrapAngle(car.angle + car.angularVel * step);
  car.pos.x += car.vel.x * step;
  car.pos.y += car.vel.y * step;

  /* --- drift / slip / boost bookkeeping ----------------------------------- */
  const uAfter = car.vel.x * fx + car.vel.y * fy;
  const vAfter = car.vel.x * rx + car.vel.y * ry;
  const speed = Math.hypot(car.vel.x, car.vel.y);
  const slipAngle = Math.atan2(Math.abs(vAfter), Math.max(Math.abs(uAfter), 25));
  const slipTarget = clamp01(slipAngle / 0.55);
  car.slip += (slipTarget - car.slip) * (1 - Math.exp(-(slipTarget > car.slip ? 26 : SLIP_RELAX * 4) * step));
  car.slip = clamp01(car.slip);
  car.forwardSpeed = uAfter;
  car.speed = speed;

  const driftSpeedOk = Math.abs(uAfter) > PHYSICS.driftMinSpeed * (car.drifting ? 0.7 : 1);
  const driftStart = !prevDrifting && car.slip > PHYSICS.driftSlipThreshold && driftSpeedOk;
  const driftEnd = prevDrifting && (car.slip < PHYSICS.driftSlipThreshold * 0.6 || !driftSpeedOk);
  car.drifting = prevDrifting ? !driftEnd : driftStart;
  if (car.drifting) {
    car.driftTime += step;
    car.driftCharge += step / PHYSICS.driftChargeTime;
  } else {
    car.driftTime = 0;
    car.driftCharge = Math.max(0, car.driftCharge - step * 0.35);
  }
  if (car.driftCharge >= 1) {
    car.driftCharge = 0;
    car.boostTime = spec.boostDuration;
    car.drifting = false;
    car.driftTime = 0;
  }
  if (car.boostTime > 0) car.boostTime = Math.max(0, car.boostTime - step);
  /* --- surface ------------------------------------------------------------ */
  let surface: Surface = 'road';
  let onRoad = true;
  {
    const q = track.query(car.pos);
    surface = q.surface;
    onRoad = q.onRoad;
    car.surface = surface;
    const halfRoad = q.width / 2;
    const barrier = halfRoad + TRACK.runoff - spec.width / 2;
    const lateral = q.lateral;
    if (Math.abs(lateral) > barrier) {
      // A barrier hit is only a *bounce* on the first frame of contact. While the
      // car keeps grinding along the wall we merely cancel the inward velocity and
      // bleed a little tangential speed (dt-aware), otherwise a 120 Hz loop would
      // glue the car to the barrier.
      const inContact = car.crashCooldown > 0;
      const outward = lateral > 0 ? 1 : -1;
      const push = Math.abs(lateral) - barrier;
      car.pos.x -= q.normal.x * outward * push;
      car.pos.y -= q.normal.y * outward * push;
      const nx = q.normal.x * outward;
      const ny = q.normal.y * outward;
      const vn = car.vel.x * nx + car.vel.y * ny; // speed into the wall
      const scrub = Math.exp(-WALL_SCRAPE_LOSS * step);
      if (vn > 0) {
        const tx = car.vel.x - nx * vn;
        const ty = car.vel.y - ny * vn;
        if (!inContact) {
          impact = vn;
          car.vel.x = tx * PHYSICS.wallFriction - nx * vn * PHYSICS.wallRestitution;
          car.vel.y = ty * PHYSICS.wallFriction - ny * vn * PHYSICS.wallRestitution;
          car.angularVel *= 0.55;
        } else {
          car.vel.x = tx * scrub;
          car.vel.y = ty * scrub;
          car.angularVel *= Math.exp(-2.5 * step);
          // Arcade wall-riding: nudge the nose parallel to the barrier so a car
          // that is pushed into the wall slides along it instead of digging in
          // and getting trapped in a corner pocket.
          const tangentSpeed = Math.hypot(tx, ty);
          let dirX: number;
          let dirY: number;
          if (tangentSpeed > 0.5) {
            dirX = tx / tangentSpeed;
            dirY = ty / tangentSpeed;
          } else {
            const travel = q.dir.x * fx + q.dir.y * fy >= 0 ? 1 : -1;
            dirX = q.dir.x * travel;
            dirY = q.dir.y * travel;
          }
          const alignErr = wrapAngle(Math.atan2(dirY, dirX) - car.angle);
          const maxTurn = WALL_ALIGN_RATE * step;
          car.angle = wrapAngle(car.angle + clamp(alignErr, -maxTurn, maxTurn));
          car.angularVel *= Math.exp(-8 * step);
        }
      } else {
        // already outside but moving inwards: clamp the position, mild scrub only
        const keep = Math.exp(-WALL_SCRAPE_LOSS * 0.35 * step);
        car.vel.x *= keep;
        car.vel.y *= keep;
      }
      // recompute body-frame speed after the bump so HUD/skid data is sane
      wallContact = true;
      car.crashCooldown = 0.32;
      const uWall = car.vel.x * fx + car.vel.y * fy;
      const vWall = car.vel.x * rx + car.vel.y * ry;
      car.forwardSpeed = uWall;
      car.speed = Math.hypot(car.vel.x, car.vel.y);
      car.slip = clamp01(Math.atan2(Math.abs(vWall), Math.max(Math.abs(uWall), 25)) / 0.55);
    }
  }

  /* --- cosmetic rpm / gear ------------------------------------------------ */
  const rpmTarget = clamp01(Math.abs(car.forwardSpeed) / Math.max(1, spec.topSpeed)) * 0.86 + throttle * 0.14;
  car.engineRpm = clamp01(car.engineRpm + (rpmTarget - car.engineRpm) * (1 - Math.exp(-12 * step)));
  car.gear = clamp(1 + Math.floor(car.engineRpm * 5.999), 1, 6);
  car.handbrake = handbrake;
  car.crashCooldown = Math.max(0, car.crashCooldown - step);

  /* --- safety net --------------------------------------------------------- */
  if (!allFinite(car)) {
    car.pos = { x: safe(prevPos.x), y: safe(prevPos.y) };
    car.angle = safe(prevAngle);
    car.vel = { x: 0, y: 0 };
    car.angularVel = 0;
    car.steer = 0;
    car.slip = 0;
    car.drifting = false;
    car.driftTime = 0;
    car.speed = 0;
    car.forwardSpeed = 0;
    car.engineRpm = 0;
    car.gear = 1;
  }

  const skid = car.drifting
    ? clamp01(0.3 + car.slip)
    : clamp01((car.slip - PHYSICS.driftSlipThreshold) * 1.4 + (surface === 'grass' && speed > 60 ? 0.25 : 0));
  const impactSpeed = Math.max(0, impact);
  return {
    impact: impactSpeed,
    onRoad,
    surface,
    driftStart: driftStart && car.drifting,
    driftEnd,
    skid,
    wallContact,
  };
}
