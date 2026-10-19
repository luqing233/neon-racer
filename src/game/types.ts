/**
 * NEON RACER — shared type contract.
 *
 * OWNER: lead. This file is the interface between every module. Do not change a
 * published signature without telling the lead: four modules are written against it.
 *
 * Conventions
 *  - World units are "px at zoom 1". The camera applies zoom/rotation.
 *  - Angles are radians; 0 = pointing along +x. Positive = clockwise on screen
 *    (canvas y grows downwards, so cos/sin rotation is applied directly).
 *  - Velocities are world units per second. Time is seconds unless suffixed `Ms`.
 *  - Simulation is fixed-substep and deterministic given (seed, inputs).
 */

/** Pseudo random generator in [0, 1). */
export type Rng = () => number;

export interface Vec2 {
  x: number;
  y: number;
}

/* ------------------------------------------------------------------ track -- */

export type TrackStyle = 'circuit' | 'technical' | 'speedway' | 'random';

export type Surface = 'road' | 'curb' | 'grass';

/** One evenly spaced sample of the closed centerline loop. */
export interface TrackSample {
  /** centerline position */
  pos: Vec2;
  /** unit tangent, direction of travel */
  dir: Vec2;
  /** unit left-hand normal (rotate dir by -90°) */
  normal: Vec2;
  /** signed curvature in 1/units: positive = turning left */
  curvature: number;
  /** full road width at this sample (units) */
  width: number;
  /** arc length from the start line to this sample */
  s: number;
}

/** Result of locating an arbitrary world point relative to the centerline. */
export interface TrackQuery {
  /** index of the nearest sample */
  index: number;
  /** arc length of the nearest sample */
  s: number;
  /** signed lateral offset: + means left of the direction of travel */
  lateral: number;
  center: Vec2;
  dir: Vec2;
  normal: Vec2;
  /** local road width */
  width: number;
  surface: Surface;
  onRoad: boolean;
  /** radius of the corner at this point (Infinity when straight) */
  radius: number;
}

export interface Track {
  seed: number;
  style: TrackStyle;
  /** human readable, e.g. "NEON SPIRAL" — shown in menus and records */
  name: string;
  /** closed loop, evenly spaced every `step` units */
  samples: TrackSample[];
  /** total centerline length in units */
  length: number;
  /** spacing between samples in units */
  step: number;
  /** index of the sample that sits on the start/finish line */
  startIndex: number;
  startLine: { a: Vec2; b: Vec2; dir: Vec2 };
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** outer/inner asphalt outline, index-aligned with `samples` */
  leftEdge: Vec2[];
  rightEdge: Vec2[];
  /** racing line points, index-aligned with `samples` */
  racingLine: Vec2[];
  /** O(1) nearest-centerline lookup (implementation may keep a spatial grid) */
  query(p: Vec2): TrackQuery;
  /** interpolated sample at arc length `s` (wraps around the loop) */
  at(s: number): TrackSample;
  /** interpolated centerline position at arc length `s` (wraps) */
  posAt(s: number): Vec2;
  /** signed arc-length difference `b - a` wrapped to (-length/2, length/2] */
  deltaS(a: number, b: number): number;
}

/* ------------------------------------------------------------------- car -- */

export type CarClass = 'balanced' | 'drifter' | 'speedster';

/** Physics tuning for one car. All values positive; see config.ts for the presets. */
export interface CarSpec {
  name: string;
  /** arbitrary mass unit; larger = heavier, slower to change direction */
  mass: number;
  /** forward acceleration at full throttle, units/s² */
  enginePower: number;
  /** speed cap where engine force balances drag, units/s */
  topSpeed: number;
  /** reverse speed cap, units/s */
  reverseSpeed: number;
  /** braking deceleration, units/s² */
  brakeForce: number;
  /** max steering angle at standstill, radians */
  maxSteer: number;
  /** how fast the wheels reach the target angle, rad/s */
  steerSpeed: number;
  /** lateral grip coefficients (0..1 per physics tick budget); higher = more grip */
  gripFront: number;
  gripRear: number;
  /** rear grip multiplier while the handbrake is held (small = easy drift) */
  handbrakeGrip: number;
  /** grip multiplier while already drifting (drift sustain) */
  driftGrip: number;
  /** aerodynamic drag coefficient */
  drag: number;
  /** rolling resistance, units/s² */
  rollResist: number;
  /** extra acceleration while boost is active, units/s² */
  boostPower: number;
  /** boost duration in seconds per charge */
  boostDuration: number;
  /** collision half-extents */
  width: number;
  length: number;
}

/** Player (or AI) command for one simulation step. */
export interface CarInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1 (left) .. 1 (right) */
  steer: number;
  handbrake: boolean;
}

export interface CarState {
  pos: Vec2;
  /** heading in radians */
  angle: number;
  /** world velocity, units/s */
  vel: Vec2;
  /** yaw rate, rad/s */
  angularVel: number;
  /** |vel| in units/s */
  speed: number;
  /** signed speed along heading (negative = reversing) */
  forwardSpeed: number;
  /** current front wheel angle, radians */
  steer: number;
  /** 0..1 lateral slip; drives skid marks and drift scoring */
  slip: number;
  drifting: boolean;
  /** seconds spent in the current continuous drift */
  driftTime: number;
  /** 0..1, fills while drifting; at 1 the car is granted a boost charge */
  driftCharge: number;
  /** remaining boost seconds */
  boostTime: number;
  /** 0..1 normalised engine speed for HUD + audio */
  engineRpm: number;
  /** 1..6, purely cosmetic for the HUD */
  gear: number;
  handbrake: boolean;
  /** seconds until the car can be considered "settled" after a wall hit */
  crashCooldown: number;
  /** current surface under the car */
  surface: Surface;
}

/** Extra multipliers injected by race.ts (boost, off-road penalty, …). */
export interface StepOptions {
  /** multiplier applied to lateral grip; 1 = default */
  gripScale?: number;
  /** extra forward acceleration, units/s² */
  extraAccel?: number;
  /** multiplier applied to top speed (e.g. 0.62 while off-road) */
  topSpeedScale?: number;
}

/** What happened during one physics step — consumed for effects and audio. */
export interface CarStepResult {
  /** impulse magnitude of a wall/car collision this step (0 = none) */
  impact: number;
  onRoad: boolean;
  surface: Surface;
  /** true on the step a drift starts / ends */
  driftStart: boolean;
  driftEnd: boolean;
  /** 0..1 how hard the tires are scrubbing (skid marks + smoke) */
  skid: number;
  /** true when the car was pushed back onto the track */
  wallContact: boolean;
}

/* -------------------------------------------------------------------- ai -- */

export type Difficulty = 'easy' | 'normal' | 'hard' | 'insane';

export interface AIDriver {
  readonly id: number;
  /** 0..1 ability: corner speed and reaction */
  skill: number;
  /** 0..1 how hard it defends / overtakes */
  aggression: number;
  /** lateral bias in units, keeps cars off each other's exact line */
  lineBias: number;
  /** look-ahead distance it is currently targeting, units */
  lookahead: number;
  /** arc length of the current target point */
  targetS: number;
  /** phase for a smooth sinusoidal line wobble */
  wobblePhase: number;
  /** seconds remaining before it re-evaluates an overtake */
  reactionTimer: number;
  /** seconds spent stuck against something; triggers a reverse recovery */
  stuckTimer: number;
  /** current recovery mode (AI reversing out of a wall) */
  recovering: number;
  rng: Rng;
}

/* ------------------------------------------------------------------ race -- */

export interface Progress {
  /** arc length along the centerline, wrapped into [0, length) */
  s: number;
  /** completed laps */
  lap: number;
  /** monotonic race distance = lap * length + s, used for standings */
  totalS: number;
  lateral: number;
  onRoad: boolean;
}

export interface Racer {
  readonly id: number;
  name: string;
  /** primary body colour, CSS hex */
  color: string;
  /** secondary/trim colour, CSS hex */
  accent: string;
  isPlayer: boolean;
  spec: CarSpec;
  car: CarState;
  /** null for the player */
  driver: AIDriver | null;
  /** input applied on the last step (useful for HUD/wheels) */
  input: CarInput;
  progress: Progress;
  lap: number;
  /** completed lap times in seconds */
  lapTimes: number[];
  bestLap: number | null;
  lastLap: number | null;
  /** race clock value when the current lap started */
  lapStartTime: number;
  /** race clock value when the racer crossed the line for the last time */
  totalTime: number;
  /** 1-based position */
  place: number;
  finished: boolean;
  finishTime: number | null;
  /** true when driving against the track direction */
  wrongWay: boolean;
  /** accumulated penalty seconds from cutting the track */
  penalty: number;
}

export type RacePhase = 'countdown' | 'racing' | 'finished';

export type RaceEventType =
  | 'countdown'
  | 'go'
  | 'lap'
  | 'best-lap'
  | 'finish'
  | 'collision'
  | 'drift-boost'
  | 'offroad'
  | 'wrong-way';

/** Fire-and-forget notifications produced by race.ts and drained by main.ts. */
export interface RaceEvent {
  type: RaceEventType;
  racerId: number;
  /** generic numeric payload: lap number, impact speed, lap time … */
  value?: number;
  text?: string;
}

export interface RaceConfig {
  seed: number;
  style: TrackStyle;
  laps: number;
  /** number of AI cars, 0..9 */
  opponents: number;
  difficulty: Difficulty;
  carClass: CarClass;
  playerName: string;
}

export interface RaceState {
  track: Track;
  config: RaceConfig;
  phase: RacePhase;
  /** 3 → 1 countdown seconds, 0 once racing */
  countdown: number;
  /** race clock, starts at 0 on "GO" */
  time: number;
  racers: Racer[];
  player: Racer;
  /** all racers sorted by place */
  standings: Racer[];
  /** racers in the order they crossed the finish line */
  finishedOrder: Racer[];
  /** pending notifications for HUD/audio; main.ts drains this every frame */
  events: RaceEvent[];
}

/* --------------------------------------------------------------- effects -- */

export type ParticleKind = 'smoke' | 'spark' | 'dust' | 'boost' | 'debris';

export interface Particle {
  pos: Vec2;
  vel: Vec2;
  /** remaining life in seconds */
  life: number;
  maxLife: number;
  size: number;
  color: string;
  kind: ParticleKind;
  /** velocity damping per second (0..1) */
  drag: number;
  angle: number;
  spin: number;
}

export interface SkidMark {
  a: Vec2;
  b: Vec2;
  /** 0..1 */
  alpha: number;
  width: number;
  kind: 'tire' | 'boost';
}

export interface EffectsState {
  particles: Particle[];
  skids: SkidMark[];
}

/* -------------------------------------------------------------- renderer -- */

export interface CameraState {
  /** world point the camera looks at */
  pos: Vec2;
  zoom: number;
  /** camera rotation in radians (0 = north-up) */
  angle: number;
  /**
   * Framing mode.
   *  - 'chase'   third-person follow: the camera rotates with the car so the
   *              heading always points up the screen and the car sits below
   *              centre, which is the classic "behind the car" racing view.
   *  - 'topdown' north-up tactical view (the original framing).
   */
  mode: CameraMode;
  /** decaying screen shake amplitude in units */
  shake: number;
  /** per-frame shake offset, already randomised */
  shakeX: number;
  shakeY: number;
}

/** See CameraState.mode. Toggled in game with the camera key and in the menu. */
export type CameraMode = 'chase' | 'topdown';

/** Everything the renderer needs for one frame. */
export interface Scene {
  ctx: CanvasRenderingContext2D;
  track: Track;
  race: RaceState;
  camera: CameraState;
  effects: EffectsState;
  /** logical (CSS pixel) canvas size */
  width: number;
  height: number;
  time: number;
  dt: number;
  showDebug: boolean;
}

export interface Renderer {
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  draw(scene: Scene): void;
  dispose(): void;
}

/* -------------------------------------------------------------------- ui -- */

export type Screen = 'menu' | 'race' | 'pause' | 'results';
export type ToastKind = 'info' | 'good' | 'bad';

export interface UIHandlers {
  onStart(config: RaceConfig): void;
  onRestart(): void;
  onQuit(): void;
  onPauseToggle(): void;
  onSoundToggle(enabled: boolean): void;
}

export interface UI {
  showScreen(screen: Screen): void;
  /** called every frame while racing */
  updateHud(race: RaceState, fps: number): void;
  showResults(race: RaceState, record: TrackRecord | null, improved: boolean): void;
  toast(text: string, kind?: ToastKind): void;
  setSoundEnabled(enabled: boolean): void;
}

/* ----------------------------------------------------------------- input -- */

export type InputAction =
  | 'pause'
  | 'restart'
  | 'toggle-debug'
  | 'toggle-sound'
  | 'toggle-camera'
  | 'reset-car';

export interface InputController {
  /** current player input; returns neutral input while disabled */
  sample(): CarInput;
  /** actions pressed since the previous drain */
  drainActions(): InputAction[];
  /** true when the on-screen touch controls are shown */
  readonly touchActive: boolean;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

/* --------------------------------------------------------------- storage -- */

export interface Settings {
  sound: boolean;
  playerName: string;
  carClass: CarClass;
  laps: number;
  difficulty: Difficulty;
  opponents: number;
  showDebug: boolean;
  /** last played track, used as the menu default */
  seed: number;
  style: TrackStyle;
  /** camera framing, see CameraMode */
  cameraMode: CameraMode;
}

export interface TrackRecord {
  bestLap: number | null;
  bestTotal: number | null;
  runs: number;
  updatedAt: number | null;
}

/* ----------------------------------------------------------------- audio -- */

export interface AudioEngine {
  readonly enabled: boolean;
  /** must be called from a user gesture before sound can start */
  resume(): void;
  setEnabled(enabled: boolean): void;
  /** per-frame: engine tone, tire squeal, off-road rumble */
  update(race: RaceState, dt: number): void;
  playEvent(event: RaceEvent, race: RaceState): void;
  stop(): void;
}
