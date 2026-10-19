/**
 * NEON RACER — entry point and integration layer.
 *
 * OWNER: lead. This wires the four workstreams together:
 *   game/track + vehicle + ai + race   (simulation)
 *   game/camera + renderer + effects   (presentation)
 *   ui/*                               (input, HUD, menus, audio, records)
 *
 * It also publishes a small debug API on `window.__NEON__` so the game can be
 * driven from a headless browser during verification (see tools/).
 */

import { RACE, PHYSICS, CAMERA } from './game/config';
import type { CarInput, CameraMode, InputAction, RaceConfig, RaceState, Scene, Settings, TrackRecord } from './game/types';
import { generateTrack } from './game/track';
import { createRace, respawnRacer, stepRace } from './game/race';
import { createCamera, updateCamera } from './game/camera';
import { createRenderer, drawAttract } from './game/renderer';
import { createEffects, resetEffects, updateEffects } from './game/effects';
import { createInput } from './ui/input';
import { createUI } from './ui/ui';
import { createAudio } from './ui/audio';
import { loadRecord, loadSettings, saveResult, saveSettings } from './ui/storage';
import './styles.css';

const VERSION = '1.0.0';

/** Fail fast with a readable message when a required DOM node is missing. */
function require<T>(value: T | null, message: string): T {
  if (value == null) throw new Error(`NEON RACER: ${message}`);
  return value;
}

const canvas = require(document.getElementById('game') as HTMLCanvasElement | null, '#game canvas missing from index.html');
const uiRoot = require(document.getElementById('ui-root'), '#ui-root missing from index.html');
const ctx = require(canvas.getContext('2d', { alpha: false }), 'Canvas 2D is not available in this browser');

/* ------------------------------------------------------------------ setup -- */

let settings: Settings = loadSettings();
let race: RaceState | null = null;
let paused = false;
let showDebug = settings.showDebug;
let lastConfig: RaceConfig | null = null;
let resultsShown = false;
let wrongWayCooldown = 0;

const renderer = createRenderer(canvas);
const camera = createCamera();
const effects = createEffects();
const audio = createAudio();
const input = createInput(document.body);

/** Player input override used by the headless test harness. */
let forcedInput: CarInput | null = null;

const NEUTRAL: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

/* --------------------------------------------------------------------- ui -- */

const ui = createUI(uiRoot, {
  onStart(config) {
    lastConfig = config;
    settings = saveSettings({
      playerName: config.playerName,
      carClass: config.carClass,
      laps: config.laps,
      difficulty: config.difficulty,
      opponents: config.opponents,
    });
    startRace(config);
  },
  onRestart() {
    if (lastConfig) startRace(lastConfig);
  },
  onQuit() {
    race = null;
    paused = false;
    audio.stop();
    ui.showScreen('menu');
    ui.toast('已退出比赛 / RACE ABORTED', 'info');
  },
  onPauseToggle() {
    togglePause();
  },
  onSoundToggle(enabled) {
    settings = saveSettings({ sound: enabled });
    audio.setEnabled(enabled);
    ui.setSoundEnabled(enabled);
  },
});

ui.setSoundEnabled(settings.sound);
audio.setEnabled(settings.sound);
camera.mode = settings.cameraMode ?? CAMERA.defaultMode;
ui.showScreen('menu');

/** Switch framing mode at runtime; persists for the next session. */
function setCameraMode(mode: CameraMode, announce = true): void {
  settings = saveSettings({ cameraMode: mode });
  camera.mode = mode;
  if (announce) {
    ui.toast(mode === 'chase' ? '视角：第三人称跟随 CHASE CAM' : '视角：俯视 NORTH-UP CAM', 'info');
  }
}

/* ------------------------------------------------------------------ race --- */

function startRace(config: RaceConfig): void {
  // pick up choices made in the menu (camera mode, sound, …)
  settings = loadSettings();
  const track = generateTrack(config.seed, config.style);
  race = createRace(config, track);
  paused = false;
  resultsShown = false;
  wrongWayCooldown = 0;
  input.setEnabled(true);
  resetEffects(effects);
  camera.pos = { x: race.player.car.pos.x, y: race.player.car.pos.y };
  camera.zoom = CAMERA.chaseZoomSlow;
  camera.angle = 0;
  camera.mode = settings.cameraMode ?? CAMERA.defaultMode;
  camera.shake = 0;
  ui.showScreen('race');
  saveSettings({ seed: config.seed, style: config.style });
}

function togglePause(): void {
  if (!race || race.phase === 'finished') return;
  paused = !paused;
  input.setEnabled(!paused);
  if (paused) {
    audio.stop();
    ui.showScreen('pause');
  } else {
    ui.showScreen('race');
  }
}

function finishRace(): void {
  if (!race || resultsShown) return;
  resultsShown = true;
  const record = loadRecord(race.track);
  const result = saveResult(race.track, {
    bestLap: race.player.bestLap,
    totalTime: race.player.finishTime ?? race.player.totalTime,
  });
  input.setEnabled(false);
  audio.stop();
  ui.showResults(race, record as TrackRecord | null, result.improvedLap || result.improvedTotal);
  ui.showScreen('results');
}

function handleActions(actions: InputAction[]): void {
  for (const action of actions) {
    switch (action) {
      case 'pause':
        if (race && race.phase === 'finished') ui.showScreen('results');
        else togglePause();
        break;
      case 'restart':
        if (lastConfig && race) startRace(lastConfig);
        break;
      case 'reset-car':
        if (race) respawnRacer(race, race.player.id);
        break;
      case 'toggle-debug':
        showDebug = !showDebug;
        settings = saveSettings({ showDebug });
        break;
      case 'toggle-sound':
        settings = saveSettings({ sound: !settings.sound });
        audio.setEnabled(settings.sound);
        ui.setSoundEnabled(settings.sound);
        break;
      case 'toggle-camera':
        setCameraMode(camera.mode === 'chase' ? 'topdown' : 'chase');
        break;
      default:
        break;
    }
  }
}

/* ------------------------------------------------------------------ loop --- */

let simAccumulator = 0;
let lastFrameMs = 0;
let smoothedFps = 60;
let elapsed = 0;

function stepSimulation(dt: number): void {
  if (!race || paused) return;
  simAccumulator += dt;
  const sub = PHYSICS.subStep;
  let guard = 0;
  while (simAccumulator >= sub && guard < 12) {
    const playerInput = forcedInput ?? input.sample();
    stepRace(race, sub, playerInput);
    simAccumulator -= sub;
    guard++;
  }
  if (guard >= 12) simAccumulator = 0;

  // drain events raised by the simulation this frame
  if (race.events.length) {
    for (const event of race.events) {
      audio.playEvent(event, race);
      const isPlayer = event.racerId === race.player.id;
      if (!isPlayer) continue;
      switch (event.type) {
        case 'best-lap':
          ui.toast(`最快圈 BEST LAP ${event.text ?? ''}`, 'good');
          break;
        case 'lap':
          ui.toast(`第 ${event.value ?? 0} 圈完成 LAP ${event.value ?? 0}`, 'info');
          break;
        case 'drift-boost':
          ui.toast('漂移充能完成 DRIFT BOOST READY', 'good');
          break;
        case 'wrong-way':
          if (wrongWayCooldown <= 0) {
            ui.toast('方向错误 WRONG WAY!', 'bad');
            wrongWayCooldown = 2.5;
          }
          break;
        case 'go':
          ui.toast('出发 GO!', 'good');
          break;
        default:
          break;
      }
    }
    race.events.length = 0;
  }

  if (wrongWayCooldown > 0) wrongWayCooldown -= dt;
  if (race.phase === 'finished') finishRace();
}

function frame(nowMs: number): void {
  requestAnimationFrame(frame);
  if (!lastFrameMs) lastFrameMs = nowMs;
  let dt = (nowMs - lastFrameMs) / 1000;
  lastFrameMs = nowMs;
  if (dt > PHYSICS.maxFrameTime) dt = PHYSICS.maxFrameTime;
  if (dt <= 0) dt = 1 / 60;
  elapsed += dt;
  smoothedFps = smoothedFps * 0.92 + (1 / dt) * 0.08;

  handleActions(input.drainActions());
  stepSimulation(dt);

  if (race) {
    updateCamera(camera, race, dt);
    updateEffects(effects, race, dt);
    ui.updateHud(race, smoothedFps);
    audio.update(race, dt);

    const scene: Scene = {
      ctx,
      track: race.track,
      race,
      camera,
      effects,
      width: canvas.clientWidth || window.innerWidth,
      height: canvas.clientHeight || window.innerHeight,
      time: elapsed,
      dt,
      showDebug,
    };
    renderer.draw(scene);
  } else {
    // menu background: still render something so the page is never blank
    renderMenuBackdrop();
  }
}

/* --------------------------------------------------------------- resizing -- */

function resize(): void {
  const w = Math.max(320, window.innerWidth);
  const h = Math.max(240, window.innerHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.resize(w, h, dpr);
}

window.addEventListener('resize', resize, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && race && !paused && race.phase !== 'finished') togglePause();
});

/* ----------------------------------------------------------- menu canvas -- */

const attractTrack = generateTrack(settings.seed || 20261018, settings.style || 'circuit');

/** Attract mode: a slow fly-over of the track behind the main menu. */
function renderMenuBackdrop(): void {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  drawAttract(ctx, { width: w, height: h, dpr, time: elapsed, track: attractTrack });
}

/* ------------------------------------------------------------- debug api -- */

const debugApi = {
  version: VERSION,
  /** Start a race programmatically (used by tools/shoot.mjs). */
  startRace(partial?: Partial<RaceConfig>): RaceState {
    const config: RaceConfig = {
      seed: 20261018,
      style: 'circuit',
      laps: RACE.defaultLaps,
      opponents: RACE.defaultOpponents,
      difficulty: 'normal',
      carClass: settings.carClass,
      playerName: settings.playerName,
      ...partial,
    };
    lastConfig = config;
    startRace(config);
    return race as RaceState;
  },
  /** Advance the simulation deterministically (independent of rAF timing). */
  tick(seconds: number, step = PHYSICS.subStep): void {
    let left = Math.max(0, seconds);
    let guard = 0;
    while (left > 1e-6 && guard < 20000) {
      const dt = Math.min(step, left);
      stepSimulation(dt);
      left -= dt;
      guard++;
    }
  },
  /** Override the player input (null restores the keyboard). */
  press(input: Partial<CarInput> | null): void {
    forcedInput = input ? { ...NEUTRAL, ...input } : null;
  },
  /** 'chase' (third-person follow) or 'topdown' (north-up). */
  setCameraMode(mode: CameraMode): void {
    setCameraMode(mode, false);
  },
  cameraMode(): CameraMode {
    return camera.mode;
  },
  state() {
    if (!race) return null;
    const p = race.player;
    return {
      phase: race.phase,
      time: race.time,
      countdown: race.countdown,
      lap: p.lap,
      laps: race.config.laps,
      place: p.place,
      racers: race.racers.length,
      speed: p.car.speed,
      pos: { x: p.car.pos.x, y: p.car.pos.y },
      bestLap: p.bestLap,
      finished: p.finished,
      trackLength: race.track.length,
      cameraMode: camera.mode,
      cameraZoom: camera.zoom,
      cameraAngle: camera.angle,
    };
  },
  standings() {
    return race ? race.standings.map((r) => ({ id: r.id, name: r.name, place: r.place, lap: r.lap, totalS: r.progress.totalS })) : [];
  },
  togglePause(): void {
    togglePause();
  },
  setDebug(on: boolean): void {
    showDebug = on;
  },
  config(): Settings {
    return settings;
  },
};

declare global {
  interface Window {
    __NEON__: typeof debugApi;
  }
}
window.__NEON__ = debugApi;

/* ------------------------------------------------------------------ boot -- */

resize();
requestAnimationFrame(frame);
