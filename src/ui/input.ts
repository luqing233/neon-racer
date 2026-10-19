/**
 * NEON RACER — player input.
 *
 * Keyboard (WASD / arrows / Space) with analogue-feeling steering, plus
 * on-screen touch controls injected into `target` when a touch device is
 * detected (coarse pointer, touch points, or the first real `touchstart`).
 *
 * Frozen contract:
 *   export function createInput(target: HTMLElement): InputController
 *
 * Keyboard map
 *   W / ↑            throttle (0..1, ramped)
 *   S / ↓            brake    (0..1, ramped)
 *   A D / ← →        steer    (-1..1, ramped toward the target, self-centres)
 *   Space            handbrake
 *   Esc / P          pause
 *   R                restart
 *   C                reset car
 *   F1 / H           toggle debug overlay
 *   M                toggle sound
 *   V                toggle camera mode (chase / north-up)
 *
 * The returned controller is polled by main.ts at the simulation sub-step rate
 * (120 Hz), so the ramping integrates against real elapsed time: `sample()`
 * advances the virtual wheel by the time since the previous call.
 */

import { clamp } from '../game/math';
import type { CarInput, InputAction, InputController } from '../game/types';

/** Virtual wheel sweep speed toward full lock, in units per second. */
const STEER_RATE = 6.4;
/** Virtual wheel self-centre speed, in units per second. */
const STEER_CENTER_RATE = 8.4;
/** Pedal ramp speeds (0..1 per second) so digital keys still feel analogue. */
const THROTTLE_RATE = 9;
const BRAKE_RATE = 15;
/** Never integrate more than this after a tab switch / long frame stall. */
const MAX_SAMPLE_DT = 0.1;

const KEY_TO_ACTION: Readonly<Record<string, InputAction>> = {
  Escape: 'pause',
  KeyP: 'pause',
  KeyR: 'restart',
  KeyC: 'reset-car',
  F1: 'toggle-debug',
  KeyH: 'toggle-debug',
  KeyM: 'toggle-sound',
  KeyV: 'toggle-camera',
};

/** Keys that produce driving values (tracked in a Set, sampled every step). */
const DRIVE_CODES: ReadonlySet<string> = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
]);

/** Keys whose browser default (page scroll / help) must be suppressed. */
const PREVENT_DEFAULT_CODES: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
]);

type TouchControl = 'left' | 'right' | 'throttle' | 'brake' | 'handbrake';

function isTouchCapable(): boolean {
  try {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return true;
    return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
}

/** True when the event comes from a text field so WASD must not be hijacked. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

function moveToward(value: number, target: number, maxStep: number): number {
  if (value < target) return Math.min(value + maxStep, target);
  if (value > target) return Math.max(value - maxStep, target);
  return target;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

export function createInput(target: HTMLElement): InputController {
  const keys = new Set<string>();
  const actions: InputAction[] = [];
  /** Pointer id -> control currently held (multi-touch: one entry per finger). */
  const pointers = new Map<number, TouchControl>();

  let enabled = true;
  let steer = 0;
  let throttle = 0;
  let brake = 0;
  let handbrake = false;
  let lastSampleMs = 0;
  let touchActive = isTouchCapable();
  let touchRoot: HTMLElement | null = null;
  let disposed = false;

  /* ------------------------------------------------------------- keyboard -- */

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isEditableTarget(event.target)) return;
    if (event.repeat) {
      if (KEY_TO_ACTION[event.code] || PREVENT_DEFAULT_CODES.has(event.code)) event.preventDefault();
      return;
    }
    const action = KEY_TO_ACTION[event.code];
    if (action) {
      event.preventDefault();
      actions.push(action);
      return;
    }
    if (DRIVE_CODES.has(event.code)) {
      if (PREVENT_DEFAULT_CODES.has(event.code)) event.preventDefault();
      keys.add(event.code);
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (isEditableTarget(event.target)) return;
    keys.delete(event.code);
    if (PREVENT_DEFAULT_CODES.has(event.code)) event.preventDefault();
  };

  /** Losing focus must never leave a key stuck down (menus, alt-tab…). */
  const clearKeys = (): void => {
    keys.clear();
  };

  const onWindowBlur = (): void => {
    clearKeys();
  };

  const onVisibility = (): void => {
    if (document.hidden) clearKeys();
  };

  /* --------------------------------------------------------------- touch -- */

  const syncTouchClasses = (): void => {
    if (!touchRoot) return;
    const buttons = touchRoot.querySelectorAll<HTMLElement>('[data-control]');
    for (const button of buttons) {
      const control = button.dataset.control;
      if (!control) continue;
      let held = false;
      for (const active of pointers.values()) {
        if (active === control) {
          held = true;
          break;
        }
      }
      button.classList.toggle('is-held', held);
      button.setAttribute('aria-pressed', held ? 'true' : 'false');
    }
  };

  const releasePointer = (event: PointerEvent): void => {
    const button = event.currentTarget as HTMLElement | null;
    if (pointers.delete(event.pointerId)) syncTouchClasses();
    if (button && button.hasPointerCapture?.(event.pointerId)) {
      try {
        button.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
    }
  };

  const bindHoldButton = (button: HTMLElement, control: TouchControl | 'pause'): void => {
    button.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        /* capture is best effort */
      }
      if (control === 'pause') {
        actions.push('pause');
        button.classList.add('is-held');
        window.setTimeout(() => button.classList.remove('is-held'), 140);
        return;
      }
      pointers.set(event.pointerId, control);
      syncTouchClasses();
    });
    button.addEventListener('pointerup', releasePointer);
    button.addEventListener('pointercancel', releasePointer);
    button.addEventListener('lostpointercapture', releasePointer);
    button.addEventListener('contextmenu', (event) => event.preventDefault());
  };

  const ensureTouchControls = (): void => {
    if (touchRoot || disposed) return;
    const root = document.createElement('div');
    root.className = 'touch-controls';
    root.dataset.testid = 'touch-controls';
    root.innerHTML = `
      <div class="touch-cluster touch-steer">
        <button type="button" class="touch-btn touch-steer-left" data-control="left" aria-label="左转 LEFT" aria-pressed="false">
          <span aria-hidden="true">◀</span><small>左 LEFT</small>
        </button>
        <button type="button" class="touch-btn touch-steer-right" data-control="right" aria-label="右转 RIGHT" aria-pressed="false">
          <span aria-hidden="true">▶</span><small>右 RIGHT</small>
        </button>
      </div>
      <div class="touch-cluster touch-actions">
        <div class="touch-pedals">
          <button type="button" class="touch-btn touch-brake" data-control="brake" aria-label="刹车 BRAKE" aria-pressed="false">
            <span aria-hidden="true">▼</span><small>刹车<em>BRAKE</em></small>
          </button>
          <button type="button" class="touch-btn touch-throttle" data-control="throttle" aria-label="油门 THROTTLE" aria-pressed="false">
            <span aria-hidden="true">▲</span><small>油门<em>GAS</em></small>
          </button>
        </div>
        <div class="touch-utils">
          <button type="button" class="touch-btn touch-handbrake" data-control="handbrake" aria-label="手刹 HANDBRAKE" aria-pressed="false">
            <span aria-hidden="true">✦</span><small>手刹<em>DRIFT</em></small>
          </button>
          <button type="button" class="touch-btn touch-pause" data-control="pause" data-testid="touch-pause" aria-label="暂停 PAUSE">
            <span aria-hidden="true">❚❚</span><small>暂停<em>PAUSE</em></small>
          </button>
        </div>
      </div>
    `;
    target.appendChild(root);
    touchRoot = root;
    /* lets styles.css keep the HUD corners clear of the on-screen pads */
    document.body.classList.add('has-touch');
    for (const button of root.querySelectorAll<HTMLElement>('[data-control]')) {
      const control = button.dataset.control as TouchControl | 'pause' | undefined;
      if (control) bindHoldButton(button, control);
    }
  };

  const activateTouch = (): void => {
    if (touchActive) return;
    touchActive = true;
    ensureTouchControls();
    window.removeEventListener('pointerdown', onPointerDetect, true);
    window.removeEventListener('touchstart', onTouchDetect, true);
  };

  function onPointerDetect(event: PointerEvent): void {
    if (event.pointerType === 'touch') activateTouch();
  }

  function onTouchDetect(): void {
    activateTouch();
  }

  if (touchActive) ensureTouchControls();

  /* --------------------------------------------------------------- wiring -- */

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onWindowBlur);
  document.addEventListener('visibilitychange', onVisibility);
  if (!touchActive) {
    window.addEventListener('pointerdown', onPointerDetect, { capture: true, passive: true });
    window.addEventListener('touchstart', onTouchDetect, { capture: true, passive: true });
  }

  /* ----------------------------------------------------------- controller -- */

  return {
    get touchActive(): boolean {
      return touchActive;
    },

    sample(): CarInput {
      const stamp = nowMs();
      let dt = lastSampleMs > 0 ? (stamp - lastSampleMs) / 1000 : 1 / 60;
      lastSampleMs = stamp;
      if (!(dt > 0)) dt = 1 / 60;
      if (dt > MAX_SAMPLE_DT) dt = MAX_SAMPLE_DT;

      if (!enabled) {
        steer = 0;
        throttle = 0;
        brake = 0;
        handbrake = false;
        return { throttle: 0, brake: 0, steer: 0, handbrake: false };
      }

      /* --- gather digital states ------------------------------------- */
      const keyLeft = keys.has('ArrowLeft') || keys.has('KeyA');
      const keyRight = keys.has('ArrowRight') || keys.has('KeyD');
      let touchLeft = false;
      let touchRight = false;
      let touchThrottle = false;
      let touchBrake = false;
      let touchHandbrake = false;
      for (const control of pointers.values()) {
        switch (control) {
          case 'left':
            touchLeft = true;
            break;
          case 'right':
            touchRight = true;
            break;
          case 'throttle':
            touchThrottle = true;
            break;
          case 'brake':
            touchBrake = true;
            break;
          case 'handbrake':
            touchHandbrake = true;
            break;
          default:
            break;
        }
      }

      /* --- analogue-feel ramps -------------------------------------- */
      let steerTarget = 0;
      if (keyLeft || touchLeft) steerTarget -= 1;
      if (keyRight || touchRight) steerTarget += 1;
      const steerRate = steerTarget === 0 ? STEER_CENTER_RATE : STEER_RATE;
      steer = clamp(moveToward(steer, steerTarget, steerRate * dt), -1, 1);

      const throttleTarget = keys.has('ArrowUp') || keys.has('KeyW') || touchThrottle ? 1 : 0;
      const brakeTarget = keys.has('ArrowDown') || keys.has('KeyS') || touchBrake ? 1 : 0;
      throttle = moveToward(throttle, throttleTarget, THROTTLE_RATE * dt);
      brake = moveToward(brake, brakeTarget, BRAKE_RATE * dt);

      handbrake = keys.has('Space') || touchHandbrake;

      return { throttle, brake, steer, handbrake };
    },

    drainActions(): InputAction[] {
      if (actions.length === 0) return [];
      const drained = actions.slice();
      actions.length = 0;
      return drained;
    },

    setEnabled(next: boolean): void {
      enabled = next;
      if (!next) {
        steer = 0;
        throttle = 0;
        brake = 0;
        handbrake = false;
        pointers.clear();
        syncTouchClasses();
      }
    },

    dispose(): void {
      disposed = true;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('pointerdown', onPointerDetect, true);
      window.removeEventListener('touchstart', onTouchDetect, true);
      document.removeEventListener('visibilitychange', onVisibility);
      pointers.clear();
      if (touchRoot) {
        touchRoot.remove();
        touchRoot = null;
        document.body.classList.remove('has-touch');
      }
      keys.clear();
      actions.length = 0;
    },
  };
}
