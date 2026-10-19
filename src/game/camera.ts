/**
 * NEON RACER — chase / top-down camera.  OWNER: render-dev.
 *
 * Frozen contract:
 *   export function createCamera(): CameraState
 *   export function updateCamera(cam: CameraState, race: RaceState, dt: number): void
 *   export function viewBounds(cam: CameraState, width: number, height: number): Bounds
 *   export interface Bounds
 *
 * Modes (CameraState.mode)
 *  - 'chase'   third-person follow: the camera rotates with the car so the
 *              heading points up the screen, the car is anchored below centre,
 *              a drift lag shows the car slightly from the side and a hard
 *              angular-rate cap stops a spin from whipping the frame.
 *  - 'topdown' north-up tactical view (the original framing) with a whisper of
 *              roll into corners.
 *
 * Everything is frame-rate independent (exponential damping), stable at 30 and
 * 144 fps, and sanitised against NaN. Mode changes are damped, never teleports.
 *
 * Per-camera hidden state lives in a WeakMap so multiple CameraState instances
 * stay independent and createCamera() keeps its published shape.
 */

import { CAMERA } from './config';
import { angleDiff, clamp, clamp01, damp, lerp } from './math';
import type { CameraState, RaceState } from './types';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Fraction of the half-viewport the car may drift away from the centre. */
const SAFE_FRACTION = 0.55;
/** Fallback viewport when viewBounds() has not been called yet. */
const DEFAULT_VIEW_W = 1600;
const DEFAULT_VIEW_H = 900;
const MAX_SHAKE = 14;
/** Below this error the camera snaps onto its target (exact settle). */
const SETTLE_EPS = 0.004;

interface CamInner {
  /** viewport reported by the renderer (CSS px) */
  viewW: number;
  viewH: number;
  /** shake bookkeeping */
  shake: number;
  t: number;
  phase: number;
  /** per-racer previous state, indexed by racer id */
  prevCrash: Float64Array;
  prevSpeed: Float64Array;
  seen: Uint8Array;
  /** lazy state so the camera never "teleports" from (0,0) on the first frame */
  ready: boolean;
  mode: string;
  /** impact recoil: how far the rig is pushed back along travel, world units */
  recoil: number;
}

const store = new WeakMap<CameraState, CamInner>();

function innerOf(cam: CameraState): CamInner {
  let s = store.get(cam);
  if (!s) {
    s = {
      viewW: DEFAULT_VIEW_W,
      viewH: DEFAULT_VIEW_H,
      shake: 0,
      t: 0,
      phase: 0,
      prevCrash: new Float64Array(16),
      prevSpeed: new Float64Array(16),
      seen: new Uint8Array(16),
      ready: false,
      mode: CAMERA.defaultMode,
      recoil: 0,
    };
    store.set(cam, s);
  }
  return s;
}

function ensureRacerSlots(s: CamInner, id: number): void {
  if (id < s.prevCrash.length) return;
  let size = s.prevCrash.length;
  while (size <= id) size *= 2;
  const crash = new Float64Array(size);
  const speed = new Float64Array(size);
  const seen = new Uint8Array(size);
  crash.set(s.prevCrash);
  speed.set(s.prevSpeed);
  seen.set(s.seen);
  s.prevCrash = crash;
  s.prevSpeed = speed;
  s.seen = seen;
}

export function createCamera(): CameraState {
  return {
    pos: { x: 0, y: 0 },
    zoom: CAMERA.chaseZoomSlow,
    angle: 0,
    mode: CAMERA.defaultMode,
    shake: 0,
    shakeX: 0,
    shakeY: 0,
  };
}

export function updateCamera(cam: CameraState, race: RaceState, dt: number): void {
  const s = innerOf(cam);
  if (!race || !race.player || !race.player.car) return;

  // Clamp dt so a stalled tab cannot fling the camera across the map.
  let step = Number.isFinite(dt) ? dt : 1 / 60;
  if (step <= 0) step = 1 / 60;
  if (step > 1 / 20) step = 1 / 20;
  s.t += step;

  // An external reset (main.ts zeroes camera.shake on race start) wins over the
  // internally tracked amplitude.
  if (cam.shake === 0 && s.shake !== 0) s.shake = 0;

  const chase = cam.mode !== 'topdown';
  const player = race.player;
  const car = player.car;
  const pos = car.pos;
  const px = Number.isFinite(pos.x) ? pos.x : 0;
  const py = Number.isFinite(pos.y) ? pos.y : 0;
  const heading = Number.isFinite(car.angle) ? car.angle : 0;
  const hx = Math.cos(heading);
  const hy = Math.sin(heading);

  if (!s.ready) {
    // First frame after boot: snap into frame instead of gliding from origin.
    cam.pos.x = px;
    cam.pos.y = py;
    cam.zoom = chase ? CAMERA.chaseZoomSlow : CAMERA.topdownZoomSlow;
    cam.angle = chase ? -heading - Math.PI * 0.5 : 0;
    s.ready = true;
  }
  s.mode = chase ? 'chase' : 'topdown';

  const top = Math.max(1, player.spec.topSpeed);
  const speed = Math.max(0, Number.isFinite(car.speed) ? car.speed : 0);
  const sf = clamp(speed / top, 0, 1.15);
  const boosting = car.boostTime > 0;
  const yawRate = Number.isFinite(car.angularVel) ? car.angularVel : 0;

  /* ---------------------------------------------------- direction of travel -- */
  // Mainstream chase rigs orbit a point ahead of the car along its *direction of
  // travel*, not along its nose, so a sliding car is framed from the side. At
  // very low speed we bias back to the heading so a stopped car stays stable.
  let tvx = hx;
  let tvy = hy;
  if (chase && speed > 25) {
    const inv = 1 / speed;
    const vx = car.vel.x * inv;
    const vy = car.vel.y * inv;
    if (Number.isFinite(vx) && Number.isFinite(vy)) {
      const w = clamp01((speed - 25) / 150) * 0.85;
      tvx = hx + (vx - hx) * w;
      tvy = hy + (vy - hy) * w;
      const l = Math.hypot(tvx, tvy) || 1;
      tvx /= l;
      tvy /= l;
    }
  } else if (!chase) {
    tvx = hx;
    tvy = hy;
  }

  /* ------------------------------------------------------------- rotation -- */
  // Signed slide: the velocity direction relative to the heading. Positive means
  // the car is travelling to the right of where its nose points.
  let slide = 0;
  if (speed > 40) {
    const vAng = Math.atan2(car.vel.y, car.vel.x);
    if (Number.isFinite(vAng)) {
      const d = angleDiff(heading, vAng);
      if (Math.abs(d) < 2.2) slide = d; // ignore reverse / spin-through cases
    }
  }
  const driftAmt = clamp01(Math.max(car.slip * 1.8, car.drifting ? 0.75 : 0, slide !== 0 ? 0.25 : 0));

  let angleTarget: number;
  if (chase) {
    // Lag toward the direction of travel: sliding shows the car from the side.
    const lag = clamp(-slide, -CAMERA.chaseDriftLag, CAMERA.chaseDriftLag) * driftAmt;
    angleTarget = -heading - Math.PI * 0.5 + lag;
  } else {
    angleTarget = clamp(-yawRate * 0.055, -0.05, 0.05);
  }

  // Drift whip: the rig follows the car calmly while gripping and snaps round
  // when the car is sliding, which is what sells the drift.
  const turnRate = chase ? lerp(CAMERA.chaseTurnRate, CAMERA.chaseTurnRateDrift, driftAmt) : 7.5;
  const err = angleDiff(cam.angle, angleTarget);
  // Fresh grid / respawn: the camera still sits on the car with a large angular
  // error, so frame it immediately instead of spinning the world for a second.
  if (chase && speed < 30 && Math.abs(err) > 1.2 && Math.hypot(cam.pos.x - px, cam.pos.y - py) < 70) {
    cam.angle = angleTarget;
  }
  const wanted = angleDiff(cam.angle, angleTarget) * (1 - Math.exp(-turnRate * step));
  const maxStep = CAMERA.chaseMaxTurnRate * step;
  cam.angle += clamp(wanted, -maxStep, maxStep);
  if (Math.abs(angleDiff(cam.angle, angleTarget)) < SETTLE_EPS && Math.abs(yawRate) < 0.09) {
    cam.angle = angleTarget; // settle exactly when straight / stopped
  }

  /* ------------------------------------------------------------- position -- */
  const zoomNow = clamp(Number.isFinite(cam.zoom) ? cam.zoom : 1, 0.22, 2.5);
  const viewH = s.viewH > 0 ? s.viewH : DEFAULT_VIEW_H;
  let tx: number;
  let ty: number;
  if (chase) {
    // Three terms along the direction of travel:
    //  - chaseAnchor keeps the car that fraction of the half-height below centre,
    //  - a speed look-ahead (chaseLeadMin..Max) shows more of the road ahead,
    //  - chaseBack lifts the rig, i.e. the raised camera looks further down the
    //    road (the renderer pairs this with the far-layer parallax),
    //  - recoil briefly pushes the whole rig back on an impact.
    const anchorLead = (CAMERA.chaseAnchor * (viewH * 0.5)) / zoomNow;
    const aheadLead = clamp(speed * 0.32, CAMERA.chaseLeadMin, CAMERA.chaseLeadMax) * 0.38;
    const lead = anchorLead + aheadLead + CAMERA.chaseBack - s.recoil;
    tx = px + tvx * lead;
    ty = py + tvy * lead;
  } else {
    let vx = hx;
    let vy = hy;
    if (speed > 12) {
      const inv = 1 / speed;
      const cx = car.vel.x * inv;
      const cy = car.vel.y * inv;
      if (Number.isFinite(cx) && Number.isFinite(cy)) {
        vx = cx * 0.6 + vx * 0.4;
        vy = cy * 0.6 + vy * 0.4;
      }
    }
    const vl = Math.hypot(vx, vy) || 1;
    vx /= vl;
    vy /= vl;
    const lead = clamp(speed * 0.34, 26, 232) + (boosting ? 46 : 0);
    tx = px + vx * lead;
    ty = py + vy * lead;
    const lat = clamp(-yawRate * speed * 0.1, -78, 78);
    tx += -vy * lat;
    ty += vx * lat;
  }

  // Screen-space safe area: whatever the mode, rotation or shake is doing, the
  // car never wanders past SAFE_FRACTION of the half-viewport.
  const viewW = s.viewW > 0 ? s.viewW : DEFAULT_VIEW_W;
  const ca = Math.cos(cam.angle);
  const sa = Math.sin(cam.angle);
  const dx = px - tx;
  const dy = py - ty;
  const sx = (dx * ca - dy * sa) * zoomNow;
  const sy = (dx * sa + dy * ca) * zoomNow;
  const maxSX = viewW * 0.5 * SAFE_FRACTION;
  const maxSY = viewH * 0.5 * SAFE_FRACTION;
  let csx = 0;
  let csy = 0;
  if (sx > maxSX) csx = sx - maxSX;
  else if (sx < -maxSX) csx = sx + maxSX;
  if (sy > maxSY) csy = sy - maxSY;
  else if (sy < -maxSY) csy = sy + maxSY;
  if (csx !== 0 || csy !== 0) {
    // rotate the screen-space correction back into world space
    tx += (csx * ca + csy * sa) / zoomNow;
    ty += (-csx * sa + csy * ca) / zoomNow;
  }

  if (chase) {
    // Per-axis damping: each axis is an independent critically damped spring
    // (exponential form cannot overshoot), and the axis the rig actually travels
    // along gets the snappier rate.
    const followX = lerp(CAMERA.chaseFollowSlow, CAMERA.chaseFollowFast, clamp01(sf * (0.6 + 0.4 * Math.abs(tvx))));
    const followY = lerp(CAMERA.chaseFollowSlow, CAMERA.chaseFollowFast, clamp01(sf * (0.6 + 0.4 * Math.abs(tvy))));
    cam.pos.x = damp(cam.pos.x, tx, followX, step);
    cam.pos.y = damp(cam.pos.y, ty, followY, step);
  } else {
    const follow = lerp(5.2, 9.5, sf);
    cam.pos.x = damp(cam.pos.x, tx, follow, step);
    cam.pos.y = damp(cam.pos.y, ty, follow, step);
  }

  /* ----------------------------------------------------------------- zoom -- */
  s.phase += step * (0.5 + sf * 2.6);
  const breathe = Math.sin(s.phase * Math.PI * 0.6) * (0.005 + 0.014 * sf);
  const zSlow = chase ? CAMERA.chaseZoomSlow : CAMERA.topdownZoomSlow;
  const zFast = chase ? CAMERA.chaseZoomFast : CAMERA.topdownZoomFast;
  const boostKick = boosting ? (chase ? CAMERA.chaseBoostZoom : 0.055) : 0;
  const targetZoom = clamp(lerp(zSlow, zFast, sf) - boostKick + breathe, 0.3, 1.9);
  cam.zoom = damp(cam.zoom, targetZoom, 3.1, step);

  /* ---------------------------------------------------------------- shake -- */
  let shake = s.shake;
  const racers = race.racers;
  if (racers) {
    for (let i = 0; i < racers.length; i++) {
      const racer = racers[i];
      if (!racer || !racer.car) continue;
      const id = racer.id >= 0 ? racer.id | 0 : i;
      ensureRacerSlots(s, id);
      const c = racer.car;
      const crash = Number.isFinite(c.crashCooldown) ? c.crashCooldown : 0;
      const spd = Math.max(0, Number.isFinite(c.speed) ? c.speed : 0);
      if (s.seen[id]) {
        const prevCrash = s.prevCrash[id] as number;
        const prevSpeed = s.prevSpeed[id] as number;
        const jump = crash - prevCrash;
        const drop = prevSpeed - spd;
        // Hedge: a wall hit both refreshes crashCooldown and eats speed. Accept
        // either signal, weight by how much speed the impact cost.
        const hit = (jump > 0.015 ? 1 : 0) + (drop > 150 ? 1 : 0);
        if (hit > 0 && (racer.isPlayer || drop > 260 || jump > 0.2)) {
          const mag = clamp(Math.max(0, drop) / 300 + Math.max(0, jump) * 1.4, 0.18, 2.4);
          const scale = racer.isPlayer ? 1 : 0.45;
          shake = Math.max(shake, mag * scale);
          if (chase && racer.isPlayer) s.recoil = Math.min(64, s.recoil + mag * 26);
        }
      }
      s.seen[id] = 1;
      s.prevCrash[id] = crash;
      s.prevSpeed[id] = spd;
    }
  }

  // recoil bleeds off with the shake
  s.recoil *= Math.exp(-6.5 * step);
  if (!Number.isFinite(s.recoil) || s.recoil < 0.01) s.recoil = 0;

  if (boosting) shake = Math.max(shake, 0.5 + sf * 0.5);
  shake = Math.max(shake, sf * sf * 0.16); // faint top-speed rumble
  shake *= Math.exp(-CAMERA.shakeDecay * step);
  if (!Number.isFinite(shake)) shake = 0;
  shake = clamp(shake, 0, MAX_SHAKE);
  s.shake = shake;

  const amp = shake;
  cam.shake = amp;
  // Layered sines read as a smoother "engine" shudder than white noise.
  const tt = s.t * 60;
  cam.shakeX = amp * (Math.sin(tt * 0.9) * 0.62 + Math.sin(tt * 2.31 + 1.7) * 0.38);
  cam.shakeY = amp * (Math.sin(tt * 1.13 + 0.6) * 0.58 + Math.sin(tt * 2.77 + 2.4) * 0.42);

  /* ------------------------------------------------------------- sanitise -- */
  if (!Number.isFinite(cam.pos.x)) cam.pos.x = px;
  if (!Number.isFinite(cam.pos.y)) cam.pos.y = py;
  if (!Number.isFinite(cam.zoom) || cam.zoom <= 0.01) {
    cam.zoom = chase ? CAMERA.chaseZoomSlow : CAMERA.topdownZoomSlow;
  }
  if (!Number.isFinite(cam.angle)) cam.angle = chase ? -heading - Math.PI * 0.5 : 0;
  if (!Number.isFinite(cam.shakeX)) cam.shakeX = 0;
  if (!Number.isFinite(cam.shakeY)) cam.shakeY = 0;
  if (!cam.mode) cam.mode = CAMERA.defaultMode;
}

export function viewBounds(cam: CameraState, width: number, height: number): Bounds {
  const s = innerOf(cam);
  const w = width > 0 && Number.isFinite(width) ? width : DEFAULT_VIEW_W;
  const h = height > 0 && Number.isFinite(height) ? height : DEFAULT_VIEW_H;
  s.viewW = w;
  s.viewH = h;
  const zoom = clamp(Number.isFinite(cam.zoom) ? cam.zoom : 1, 0.05, 4);
  const a = Number.isFinite(cam.angle) ? cam.angle : 0;
  const absCos = Math.abs(Math.cos(a));
  const absSin = Math.abs(Math.sin(a));
  // AABB of the ROTATED viewport (a half-diagonal would over-cull nothing but a
  // half-width/half-height pair would clip the screen corners).
  const halfW = ((w * 0.5) * absCos + (h * 0.5) * absSin) / zoom + 90;
  const halfH = ((w * 0.5) * absSin + (h * 0.5) * absCos) / zoom + 90;
  const cx = Number.isFinite(cam.pos.x) ? cam.pos.x : 0;
  const cy = Number.isFinite(cam.pos.y) ? cam.pos.y : 0;
  return { minX: cx - halfW, minY: cy - halfH, maxX: cx + halfW, maxY: cy + halfH };
}
