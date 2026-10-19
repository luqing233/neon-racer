/**
 * NEON RACER — fully synthesised WebAudio sound (zero asset files).
 *
 * Graph
 *   engine   : sawtooth + square oscillators -> lowpass -> gain -> master
 *   tyre     : looping white-noise buffer -> bandpass -> gain -> master
 *   off-road : looping white-noise buffer -> lowpass  -> gain -> master
 *   one-shots: countdown / go / lap / best-lap / finish / collision /
 *              drift-boost / offroad / wrong-way, all scheduled on demand
 *
 * Rules
 *   - AudioContext is created lazily from a real user gesture (or from the
 *     first race event once document user-activation exists), never at import
 *     time, so autoplay policies never log errors.
 *   - Master gain stays modest (<= 0.32) and everything routes through it, so
 *     `stop()` / `setEnabled(false)` silences the whole engine without clicks.
 *   - No WebAudio failure may throw or log: every entry point degrades silently.
 *
 * Frozen contract: export function createAudio(): AudioEngine
 */

import { clamp } from '../game/math';
import type { AudioEngine, RaceEvent, RaceState } from '../game/types';

type AudioContextCtor = typeof AudioContext;

const MASTER_GAIN = 0.32;
const ENVELOPE_FLOOR = 0.0001;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof AudioContext !== 'undefined') return AudioContext;
  const legacy = (globalThis as typeof globalThis & { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  return legacy ?? null;
}

/** User activation check so we never construct an AudioContext too early. */
function hasUserActivation(): boolean {
  try {
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    if (activation) return activation.hasBeenActive;
    /* Older browsers: the gesture listener is our only safe entry point. */
    return false;
  } catch {
    return false;
  }
}

export function createAudio(): AudioEngine {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;

  let engineOscA: OscillatorNode | null = null;
  let engineOscB: OscillatorNode | null = null;
  let engineFilter: BiquadFilterNode | null = null;
  let engineGain: GainNode | null = null;

  let squealGain: GainNode | null = null;
  let squealFilter: BiquadFilterNode | null = null;

  let rumbleGain: GainNode | null = null;

  let noiseBuffer: AudioBuffer | null = null;

  let enabled = true;
  let stopped = false;
  let stoppedAt = 0;
  let lastTime = 0;
  let unavailable = false;
  let gestureBound = false;

  /* --------------------------------------------------------------- helpers -- */

  function setParam(param: AudioParam | null | undefined, value: number, timeConstant = 0.05): void {
    if (!param || !ctx) return;
    try {
      param.setTargetAtTime(value, ctx.currentTime, Math.max(0.005, timeConstant));
    } catch {
      /* ignore */
    }
  }

  function silenceLevels(): void {
    setParam(engineGain?.gain ?? null, 0, 0.015);
    setParam(squealGain?.gain ?? null, 0, 0.015);
    setParam(rumbleGain?.gain ?? null, 0, 0.015);
  }

  /* ------------------------------------------------------------- graph build -- */

  function buildNoiseBuffer(context: AudioContext): AudioBuffer | null {
    try {
      const length = Math.max(1, Math.floor(context.sampleRate * 0.6));
      const buffer = context.createBuffer(1, length, context.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      return buffer;
    } catch {
      return null;
    }
  }

  function buildGraph(context: AudioContext, destination: GainNode): void {
    /* --- engine ------------------------------------------------------- */
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 2.4;

    const gain = context.createGain();
    gain.gain.value = 0;
    filter.connect(gain);
    gain.connect(destination);

    const oscA = context.createOscillator();
    oscA.type = 'sawtooth';
    oscA.frequency.value = 60;
    const oscB = context.createOscillator();
    oscB.type = 'square';
    oscB.frequency.value = 121;
    oscB.detune.value = 7;
    const oscBGain = context.createGain();
    oscBGain.gain.value = 0.45;
    oscA.connect(filter);
    oscB.connect(oscBGain);
    oscBGain.connect(filter);
    oscA.start();
    oscB.start();

    engineOscA = oscA;
    engineOscB = oscB;
    engineFilter = filter;
    engineGain = gain;

    /* --- noise sources ------------------------------------------------ */
    noiseBuffer = buildNoiseBuffer(context);
    if (noiseBuffer) {
      const squealSource = context.createBufferSource();
      squealSource.buffer = noiseBuffer;
      squealSource.loop = true;
      const squealBand = context.createBiquadFilter();
      squealBand.type = 'bandpass';
      squealBand.frequency.value = 2100;
      squealBand.Q.value = 9;
      const squealLevel = context.createGain();
      squealLevel.gain.value = 0;
      squealSource.connect(squealBand);
      squealBand.connect(squealLevel);
      squealLevel.connect(destination);
      squealSource.start();
      squealGain = squealLevel;
      squealFilter = squealBand;

      const rumbleSource = context.createBufferSource();
      rumbleSource.buffer = noiseBuffer;
      rumbleSource.loop = true;
      const rumbleLow = context.createBiquadFilter();
      rumbleLow.type = 'lowpass';
      rumbleLow.frequency.value = 240;
      rumbleLow.Q.value = 0.7;
      const rumbleLevel = context.createGain();
      rumbleLevel.gain.value = 0;
      rumbleSource.connect(rumbleLow);
      rumbleLow.connect(rumbleLevel);
      rumbleLevel.connect(destination);
      rumbleSource.start();
      rumbleGain = rumbleLevel;
    }
  }

  function ensureContext(): AudioContext | null {
    if (ctx) return ctx;
    if (unavailable) return null;
    const Ctor = getAudioContextCtor();
    if (!Ctor) {
      unavailable = true;
      return null;
    }
    try {
      const context = new Ctor();
      ctx = context;
      const masterGain = context.createGain();
      masterGain.gain.value = enabled && !stopped ? MASTER_GAIN : 0;
      masterGain.connect(context.destination);
      master = masterGain;
      buildGraph(context, masterGain);
      if (context.state === 'suspended') {
        const resumed = context.resume();
        if (resumed && typeof resumed.catch === 'function') resumed.catch(() => undefined);
      }
      return context;
    } catch {
      unavailable = true;
      ctx = null;
      master = null;
      return null;
    }
  }

  /* -------------------------------------------------------------- resume ---- */

  function resume(): void {
    const context = ensureContext();
    if (!context) return;
    try {
      if (context.state !== 'running') {
        const resumed = context.resume();
        if (resumed && typeof resumed.catch === 'function') resumed.catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
  }

  function bindGestureResume(): void {
    if (gestureBound) return;
    gestureBound = true;
    let handler: () => void;
    const unbind = (): void => {
      window.removeEventListener('pointerdown', handler, true);
      window.removeEventListener('keydown', handler, true);
      window.removeEventListener('touchstart', handler, true);
    };
    handler = (): void => {
      unbind();
      resume();
    };
    try {
      window.addEventListener('pointerdown', handler, { once: true, capture: true, passive: true });
      window.addEventListener('keydown', handler, { once: true, capture: true });
      window.addEventListener('touchstart', handler, { once: true, capture: true, passive: true });
    } catch {
      /* impossible in practice */
    }
  }

  bindGestureResume();

  /* ------------------------------------------------------------- one shots -- */

  function tone(
    type: OscillatorType,
    startFreq: number,
    endFreq: number,
    delay: number,
    duration: number,
    peak: number,
  ): void {
    const context = ctx;
    const destination = master;
    if (!context || !destination) return;
    try {
      const t0 = context.currentTime + Math.max(0, delay);
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = type;
      const f0 = clamp(startFreq, 20, context.sampleRate * 0.45);
      const f1 = clamp(endFreq, 20, context.sampleRate * 0.45);
      osc.frequency.setValueAtTime(f0, t0);
      if (Math.abs(f1 - f0) > 0.5) osc.frequency.exponentialRampToValueAtTime(f1, t0 + duration);
      gain.gain.setValueAtTime(ENVELOPE_FLOOR, t0);
      gain.gain.exponentialRampToValueAtTime(Math.max(ENVELOPE_FLOOR * 2, peak), t0 + Math.min(0.02, duration * 0.25));
      gain.gain.exponentialRampToValueAtTime(ENVELOPE_FLOOR, t0 + duration);
      osc.connect(gain);
      gain.connect(destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.03);
      osc.onended = (): void => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* ignore */
    }
  }

  function noiseBurst(
    peak: number,
    duration: number,
    filterType: BiquadFilterType,
    freqStart: number,
    freqEnd: number,
    delay = 0,
  ): void {
    const context = ctx;
    const destination = master;
    const buffer = noiseBuffer;
    if (!context || !destination || !buffer) return;
    try {
      const t0 = context.currentTime + Math.max(0, delay);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const filter = context.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.setValueAtTime(clamp(freqStart, 30, context.sampleRate * 0.45), t0);
      if (Math.abs(freqEnd - freqStart) > 1) {
        filter.frequency.exponentialRampToValueAtTime(clamp(freqEnd, 30, context.sampleRate * 0.45), t0 + duration);
      }
      filter.Q.value = filterType === 'bandpass' ? 1.4 : 0.8;
      const gain = context.createGain();
      gain.gain.setValueAtTime(ENVELOPE_FLOOR, t0);
      gain.gain.exponentialRampToValueAtTime(Math.max(ENVELOPE_FLOOR * 2, peak), t0 + Math.min(0.03, duration * 0.3));
      gain.gain.exponentialRampToValueAtTime(ENVELOPE_FLOOR, t0 + duration);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(destination);
      source.start(t0);
      source.stop(t0 + duration + 0.04);
      source.onended = (): void => {
        try {
          source.disconnect();
          filter.disconnect();
          gain.disconnect();
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* ignore */
    }
  }

  function playEventSound(event: RaceEvent): void {
    switch (event.type) {
      case 'countdown': {
        const remaining = clamp(event.value ?? 3, 1, 3);
        tone('square', 380 + (4 - remaining) * 110, 380 + (4 - remaining) * 110, 0, 0.12, 0.3);
        break;
      }
      case 'go':
        tone('sawtooth', 520, 1040, 0, 0.24, 0.32);
        tone('square', 780, 1560, 0.04, 0.22, 0.18);
        break;
      case 'lap':
        tone('triangle', 880, 880, 0, 0.09, 0.26);
        tone('triangle', 1180, 1180, 0.1, 0.12, 0.24);
        break;
      case 'best-lap':
        tone('triangle', 660, 660, 0, 0.1, 0.26);
        tone('triangle', 880, 880, 0.1, 0.1, 0.26);
        tone('triangle', 1320, 1320, 0.2, 0.18, 0.3);
        break;
      case 'finish':
        tone('square', 523, 523, 0, 0.16, 0.24);
        tone('square', 659, 659, 0.16, 0.16, 0.24);
        tone('square', 784, 784, 0.32, 0.16, 0.26);
        tone('square', 1046, 1046, 0.48, 0.4, 0.3);
        break;
      case 'collision': {
        const force = clamp((event.value ?? 140) / 520, 0.25, 1);
        noiseBurst(0.42 * force, 0.2, 'bandpass', 1100, 180);
        tone('triangle', 130, 52, 0, 0.22, 0.32 * force);
        break;
      }
      case 'drift-boost':
        noiseBurst(0.2, 0.32, 'bandpass', 380, 2800);
        tone('sawtooth', 180, 820, 0.02, 0.32, 0.16);
        break;
      case 'offroad':
        noiseBurst(0.16, 0.18, 'lowpass', 320, 140);
        break;
      case 'wrong-way':
        tone('sawtooth', 120, 96, 0, 0.2, 0.14);
        tone('sawtooth', 120, 96, 0.22, 0.2, 0.14);
        break;
      default:
        break;
    }
  }

  /* --------------------------------------------------------------- engine -- */

  function updateEngine(race: RaceState, dt: number): void {
    const context = ctx;
    if (!context || !engineGain) return;
    const car = race.player.car;
    const input = race.player.input;
    const racing = race.phase !== 'countdown';
    const rpm = clamp(car.engineRpm, 0, 1);
    const throttle = clamp(input.throttle, 0, 1);
    const smooth = clamp(dt * 2, 0.02, 0.09);

    const frequency = 58 + rpm * 330;
    setParam(engineOscA?.frequency ?? null, frequency, 0.04);
    setParam(engineOscB?.frequency ?? null, frequency * 2.02, 0.04);
    setParam(engineFilter?.frequency ?? null, 620 + rpm * 2400 + (car.boostTime > 0 ? 500 : 0), smooth);

    let level = (0.055 + rpm * 0.075 + throttle * 0.035) * (racing ? 1 : 0.55);
    if (car.boostTime > 0) level += 0.03;
    if (car.surface === 'grass') level += 0.015;
    setParam(engineGain.gain, level, smooth);

    const speed = car.speed;
    const slip = clamp(car.slip, 0, 1);
    const squeal = racing && speed > 90 ? clamp((slip - 0.22) / 0.62, 0, 1) : 0;
    setParam(squealGain?.gain ?? null, squeal * 0.15, smooth);
    setParam(squealFilter?.frequency ?? null, 1500 + slip * 1400 + speed * 0.35, 0.06);

    const offroad = racing && car.surface === 'grass' && speed > 30;
    setParam(rumbleGain?.gain ?? null, offroad ? clamp(speed / 480, 0, 1) * 0.2 : 0, smooth);
  }

  /* ------------------------------------------------------------- public API -- */

  return {
    get enabled(): boolean {
      return enabled;
    },

    resume,

    setEnabled(next: boolean): void {
      enabled = next;
      const context = ctx;
      if (!context || !master) return;
      try {
        const target = next && !stopped ? MASTER_GAIN : 0;
        master.gain.setTargetAtTime(target, context.currentTime, 0.02);
        if (!next) silenceLevels();
      } catch {
        /* ignore */
      }
    },

    update(race: RaceState, dt: number): void {
      if (!enabled || unavailable) return;
      const context = ctx;
      if (!context || !master) return;
      if (context.state !== 'running') {
        lastTime = race.time;
        return;
      }

      if (stopped) {
        /* `stop()` is called on pause/finish/quit. The only things that can
         * un-stop us are the race clock advancing again (resume) or a brand new
         * race whose clock restarted from zero (quit -> menu -> start race). */
        if (race.time > stoppedAt + 1e-4 || race.time < stoppedAt - 0.5) {
          stopped = false;
          setParam(master.gain, MASTER_GAIN, 0.06);
        } else {
          lastTime = race.time;
          return;
        }
      }
      lastTime = race.time;

      try {
        updateEngine(race, dt);
      } catch {
        /* never let audio break the frame loop */
      }
    },

    playEvent(event: RaceEvent, race: RaceState): void {
      void race;
      if (!enabled || stopped || unavailable) return;
      const context = ctx ?? (hasUserActivation() ? ensureContext() : null);
      if (!context || !master || context.state !== 'running') return;
      try {
        playEventSound(event);
      } catch {
        /* ignore */
      }
    },

    stop(): void {
      stopped = true;
      stoppedAt = lastTime;
      silenceLevels();
      const context = ctx;
      if (context && master) {
        try {
          master.gain.cancelScheduledValues(context.currentTime);
          master.gain.setTargetAtTime(0, context.currentTime, 0.015);
        } catch {
          /* ignore */
        }
      }
    },
  };
}
