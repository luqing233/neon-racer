/**
 * NEON RACER — central tuning table.
 *
 * OWNER: lead. Everything that two modules must agree on lives here: car specs,
 * track dimensions, difficulty presets, palette, start-grid and race rules.
 * Teammates: read values from here, do NOT hard-code your own copies. If a value
 * needs to change, message the lead (this file is shared by all workstreams).
 */

import type { CarClass, CarSpec, CameraMode, Difficulty, TrackStyle } from './types';

/* ------------------------------------------------------------------ track -- */

export const TRACK = {
  /** spacing between centerline samples, world units */
  sampleStep: 8,
  /** road width range used by the generator */
  minWidth: 176,
  maxWidth: 264,
  /** width of the painted curb strip on each side */
  curbWidth: 20,
  /** run-off between the asphalt edge and the barrier */
  runoff: 62,
  /** total playfield the generator must stay inside */
  fieldSize: 9200,
  /** minimum radius of curvature the generator must respect */
  minRadius: 300,
  /** control point count range for the random loop */
  minControlPoints: 12,
  maxControlPoints: 19,
  /** deterministic style list used when style === 'random' */
  styles: ['circuit', 'technical', 'speedway'] as const satisfies readonly TrackStyle[],
  /** short display names per style */
  styleLabels: {
    circuit: '环道 CIRCUIT',
    technical: '技术赛道 TECHNICAL',
    speedway: '高速环 SPEEDWAY',
    random: '随机 RANDOM',
  } satisfies Record<TrackStyle, string>,
} as const;

/* -------------------------------------------------------------------- car -- */

/** Player-selectable car classes. Keys must match the CarClass union. */
export const CARS: Record<CarClass, CarSpec> = {
  balanced: {
    name: 'BALANCED · 均衡',
    mass: 1,
    enginePower: 620,
    topSpeed: 560,
    reverseSpeed: 150,
    brakeForce: 900,
    maxSteer: 0.52,
    steerSpeed: 3.4,
    gripFront: 0.92,
    gripRear: 0.86,
    handbrakeGrip: 0.34,
    driftGrip: 0.72,
    drag: 0.0016,
    rollResist: 60,
    boostPower: 380,
    boostDuration: 1.4,
    width: 24,
    length: 46,
  },
  drifter: {
    name: 'DRIFTER · 漂移',
    mass: 0.92,
    enginePower: 645,
    topSpeed: 545,
    reverseSpeed: 155,
    brakeForce: 880,
    maxSteer: 0.6,
    steerSpeed: 3.9,
    gripFront: 0.9,
    gripRear: 0.77,
    handbrakeGrip: 0.24,
    driftGrip: 0.66,
    drag: 0.0017,
    rollResist: 62,
    boostPower: 400,
    boostDuration: 1.6,
    width: 24,
    length: 46,
  },
  speedster: {
    name: 'SPEEDSTER · 疾速',
    mass: 1.1,
    enginePower: 700,
    topSpeed: 645,
    reverseSpeed: 145,
    brakeForce: 940,
    maxSteer: 0.46,
    steerSpeed: 3.1,
    gripFront: 0.95,
    gripRear: 0.9,
    handbrakeGrip: 0.4,
    driftGrip: 0.78,
    drag: 0.0015,
    rollResist: 64,
    boostPower: 360,
    boostDuration: 1.3,
    width: 24,
    length: 46,
  },
};

/** Livery palette — index 0 is the player, the rest are handed to the AI. */export const CAR_COLORS: readonly { color: string; accent: string }[] = [
  { color: '#00f0ff', accent: '#ffffff' },
  { color: '#ff2e63', accent: '#ffd6e0' },
  { color: '#ffd400', accent: '#fff6c2' },
  { color: '#7c4dff', accent: '#d6c9ff' },
  { color: '#00e676', accent: '#c8ffe0' },
  { color: '#ff7a00', accent: '#ffe0bd' },
  { color: '#00b0ff', accent: '#c9ecff' },
  { color: '#f50057', accent: '#ffd0e0' },
  { color: '#76ff03', accent: '#e8ffc9' },
  { color: '#18ffff', accent: '#d0ffff' },
] as const;

export const AI_NAMES: readonly string[] = [
  'VIPER',
  'NOVA',
  'GHOST',
  'BLAZE',
  'KATANA',
  'ZENITH',
  'RIPTIDE',
  'ONYX',
  'PULSAR',
  'HEX',
] as const;

/* -------------------------------------------------------------- physics --- */

export const PHYSICS = {
  /** fixed simulation step, seconds (accumulator based) */
  subStep: 1 / 120,
  /** never advance more than this per frame, seconds */
  maxFrameTime: 1 / 20,
  /** normal restitution against a barrier */
  wallRestitution: 0.35,
  /** tangential speed kept after scraping a wall (1 = no loss) */
  wallFriction: 0.86,
  /** impact speed above which a crash event/particles fire, units/s */
  crashImpactThreshold: 90,
  /** grip multiplier when two wheels are on the curb */
  curbGrip: 0.82,
  /** top speed multiplier off-road (grass) */
  grassDrag: 0.6,
  /** grip multiplier off-road */
  grassGrip: 0.55,
  /** extra rolling resistance off-road, units/s² */
  grassResist: 220,
  /** speed above which drifting charges the boost gauge, units/s */
  driftMinSpeed: 170,
  /** slip above which a car counts as drifting */
  driftSlipThreshold: 0.28,
  /** seconds of drifting needed to fill one boost charge */
  driftChargeTime: 1.5,
} as const;

/* ------------------------------------------------------------------ race --- */

export const RACE = {
  defaultLaps: 3,
  minLaps: 1,
  maxLaps: 9,
  defaultOpponents: 5,
  maxOpponents: 9,
  countdownSeconds: 3.4,
  /** distance behind the line of the first grid row, units */
  gridStartOffset: 70,
  /** longitudinal gap between grid rows, units */
  gridRowGap: 62,
  /** lateral offset of each car in a row, units */
  gridColOffset: 46,
  /** seconds off-track before the "wrong way" warning */
  wrongWayDelay: 1.1,
  /** how many seconds a finished player waits before results (AI finish too) */
  resultsDelay: 1.6,
} as const;

/* ------------------------------------------------------------ difficulty -- */

export interface DifficultyPreset {
  label: string;
  /** AI skill range */
  skillMin: number;
  skillMax: number;
  /** corner speed multiplier, 0..1.2 */
  cornerSpeed: number;
  /** overtaking aggression */
  aggression: number;
  /** probability per second of a small mistake */
  mistakeRate: number;
  /** AI top speed multiplier */
  speedScale: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyPreset> = {
  easy: {
    label: '新手 ROOKIE',
    skillMin: 0.5,
    skillMax: 0.68,
    cornerSpeed: 0.86,
    aggression: 0.25,
    mistakeRate: 0.16,
    speedScale: 0.9,
  },
  normal: {
    label: '标准 PRO',
    skillMin: 0.68,
    skillMax: 0.84,
    cornerSpeed: 0.94,
    aggression: 0.45,
    mistakeRate: 0.1,
    speedScale: 0.96,
  },
  hard: {
    label: '高手 VETERAN',
    skillMin: 0.82,
    skillMax: 0.94,
    cornerSpeed: 1.02,
    aggression: 0.65,
    mistakeRate: 0.06,
    speedScale: 1.0,
  },
  insane: {
    label: '疯子 INSANE',
    skillMin: 0.92,
    skillMax: 1,
    cornerSpeed: 1.1,
    aggression: 0.85,
    mistakeRate: 0.03,
    speedScale: 1.04,
  },
};

/* --------------------------------------------------------------- camera -- */

/**
 * Framing constants for both camera modes.
 *
 * The chase rig follows the pattern used by mainstream arcade racers (Mario Kart
 * / Forza-style "chase far"): the camera orbits a look-at point that leads the
 * car along its VELOCITY (not its nose), so a sliding car is framed from the side;
 * the yaw follows the car with damping plus extra whip while drifting; the rig
 * pulls back and tightens at speed; and each axis is critically damped
 * independently so no axis can overshoot.
 *
 * This is a 2D top-down game, so the "low angle" of a 3D racer is expressed as
 * SCREEN-SPACE parallax: halo it as a raised rig by drawing background layers
 * offset proportionally to their depth (`chaseParallax`), under a longitudinal
 * camera offset (`chaseBack`) that pushes the whole scene away from the camera.
 */
export const CAMERA = {
  /** default framing: the third-person car-following view */
  defaultMode: 'chase' as CameraMode,
  /**
   * The car sits this fraction of the half-height BELOW the screen centre: we
   * look down the road ahead instead of at the car, like a real chase cam.
   */
  chaseAnchor: 0.3,
  /**
   * Camera rig height. We look at the car from a raised point, which under a
   * top-down projection shows a constant lateral line offset in the direction
   * the car travels (screen "up" while heading up).
   */
  chaseBack: 54,
  /**
   * Screen parallax of the distant background per unit of rig height — the 2D
   * stand-in for a low camera angle: the world slides past the raised camera.
   */
  chaseParallax: 0.46,
  /** chase (drift): extra yaw lag so the car is seen slightly from the side, radians */
  chaseDriftLag: 0.34,
  /** chase (boost): punchy extra zoom-out */
  chaseBoostZoom: 0.07,
  /** zoom at standstill → at top speed, per mode */
  chaseZoomSlow: 1.02,
  chaseZoomFast: 0.76,
  topdownZoomSlow: 0.96,
  topdownZoomFast: 0.655,
  /** rotation follow rate in chase mode, per second (grip / drift) */
  chaseTurnRate: 3.6,
  chaseTurnRateDrift: 8.2,
  /** hard cap on camera yaw rate so a spin cannot whip the view, rad/s */
  chaseMaxTurnRate: 3.5,
  /** per-axis position follow rates (critically damped), per second */
  chaseFollowSlow: 5.4,
  chaseFollowFast: 10.5,
  /** look-ahead along the direction of travel, world units at speed */
  chaseLeadMin: 26,
  chaseLeadMax: 232,
  /** how fast the camera settles after a hard impact, per second */
  shakeDecay: 7.5,
} as const;

/* ------------------------------------------------------------------ cars -- */

/**
 * Which class a CarSpec belongs to. CARS holds one shared instance per class, so
 * identity is the fast path; the numeric fallback keeps third-party specs working.
 */
export function carClassOf(spec: CarSpec): CarClass {
  if (spec === CARS.balanced) return 'balanced';
  if (spec === CARS.drifter) return 'drifter';
  if (spec === CARS.speedster) return 'speedster';
  if (spec.maxSteer >= 0.56) return 'drifter';
  return spec.topSpeed >= 600 ? 'speedster' : 'balanced';
}

/* --------------------------------------------------------------- visuals -- */

export const COLORS = {
  void: '#05060f',
  asphaltDark: '#141a2e',
  asphalt: '#1d2440',
  asphaltLight: '#242c4d',
  curbA: '#ff2e63',
  curbB: '#f2f4ff',
  grass: '#0a1224',
  grassLine: '#101c38',
  wall: '#3a4470',
  wallGlow: '#28e0ff',
  startLine: '#f2f4ff',
  racingLine: 'rgba(0, 240, 255, 0.10)',
  hudCyan: '#00f0ff',
  hudPink: '#ff2e63',
  hudYellow: '#ffd400',
  hudText: '#e8f4ff',
  hudDim: 'rgba(232, 244, 255, 0.55)',
  boost: '#ffd400',
  boostHot: '#fff3b0',
  smoke: 'rgba(200, 214, 255, 0.5)',
  spark: '#ffd400',
  dust: 'rgba(120, 140, 200, 0.42)',
} as const;
