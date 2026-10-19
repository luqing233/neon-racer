/**
 * NEON RACER — player-facing UI: main menu, pause overlay, results screen,
 * toasts and the bridge to the in-race HUD (hud.ts).
 *
 * Frozen contract:
 *   export function createUI(root: HTMLElement, handlers: UIHandlers): UI
 *
 * main.ts owns the game loop and calls:
 *   createUI(uiRoot, handlers) -> ui
 *   ui.showScreen(screen)              (menu | race | pause | results)
 *   ui.updateHud(race, fps)            (every rendered frame)
 *   ui.showResults(race, record, improved)
 *   ui.toast(text, kind)
 *   ui.setSoundEnabled(enabled)
 *
 * Screens are driven exclusively by showScreen(); the menu never needs a race
 * to exist, so it works on first load (attract-mode backdrop behind it).
 */

import { CAMERA, CAR_COLORS, CARS, DIFFICULTY, RACE, TRACK } from '../game/config';
import { clamp, formatTime, TAU } from '../game/math';
import type {
  CameraMode,
  CarClass,
  Difficulty,
  RaceConfig,
  RaceState,
  Screen,
  Settings,
  ToastKind,
  Track,
  TrackRecord,
  TrackStyle,
  UI,
  UIHandlers,
} from '../game/types';
import { generateTrack } from '../game/track';
import { createHud } from './hud';
import { DEFAULT_SETTINGS, loadRecord, loadSettings, saveSettings } from './storage';

const TRACK_STYLES: readonly TrackStyle[] = ['circuit', 'technical', 'speedway', 'random'];
const CAMERA_MODES: readonly CameraMode[] = ['chase', 'topdown'];
const CAMERA_MODE_LABELS: Readonly<Record<CameraMode, string>> = {
  chase: '第三人称跟随 CHASE CAM',
  topdown: '俯视 NORTH-UP',
};
const CAR_CLASSES: readonly CarClass[] = ['balanced', 'drifter', 'speedster'];
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard', 'insane'];
const MAX_NAME_LENGTH = 16;
const MAX_SEED = 99_999_999;
const MAX_TOASTS = 4;

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape untrusted strings (player name, generator names) before innerHTML. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** Coerce persisted settings to legal values (localStorage is user-writable). */
function sanitizeSettings(raw: Settings): Settings {
  const style = (TRACK_STYLES as readonly string[]).includes(raw.style) ? raw.style : 'circuit';
  const carClass = (CAR_CLASSES as readonly string[]).includes(raw.carClass) ? raw.carClass : 'balanced';
  const difficulty = (DIFFICULTIES as readonly string[]).includes(raw.difficulty) ? raw.difficulty : 'normal';
  const seed = Number(raw.seed);
  const laps = Number(raw.laps);
  const opponents = Number(raw.opponents);
  const cameraMode = (CAMERA_MODES as readonly string[]).includes(raw.cameraMode)
    ? raw.cameraMode
    : CAMERA.defaultMode;
  return {
    sound: raw.sound !== false,
    playerName:
      typeof raw.playerName === 'string' && raw.playerName.trim() !== ''
        ? raw.playerName.trim().slice(0, MAX_NAME_LENGTH)
        : DEFAULT_SETTINGS.playerName,
    carClass: carClass as CarClass,
    laps: Number.isFinite(laps) ? clamp(Math.round(laps), RACE.minLaps, RACE.maxLaps) : RACE.defaultLaps,
    difficulty: difficulty as Difficulty,
    opponents: Number.isFinite(opponents)
      ? clamp(Math.round(opponents), 0, RACE.maxOpponents)
      : RACE.defaultOpponents,
    showDebug: raw.showDebug === true,
    seed: Number.isFinite(seed) ? clamp(Math.floor(seed), 0, MAX_SEED) : DEFAULT_SETTINGS.seed,
    style: style as TrackStyle,
    cameraMode: cameraMode as CameraMode,
  };
}

function styleOptions(selected: TrackStyle): string {
  return TRACK_STYLES.map(
    (style) => `<option value="${style}"${style === selected ? ' selected' : ''}>${TRACK.styleLabels[style]}</option>`,
  ).join('');
}

function carClassOptions(selected: CarClass): string {
  return CAR_CLASSES.map(
    (carClass) => `<option value="${carClass}"${carClass === selected ? ' selected' : ''}>${CARS[carClass].name}</option>`,
  ).join('');
}

function cameraModeOptions(selected: CameraMode): string {
  return CAMERA_MODES.map(
    (mode) =>
      `<option value="${mode}"${mode === selected ? ' selected' : ''}>${CAMERA_MODE_LABELS[mode]}</option>`,
  ).join('');
}

function difficultyOptions(selected: Difficulty): string {
  return DIFFICULTIES.map(
    (difficulty) =>
      `<option value="${difficulty}"${difficulty === selected ? ' selected' : ''}>${DIFFICULTY[difficulty].label}</option>`,
  ).join('');
}

function controlsLegend(): string {
  return `
    <div class="legend">
      <div class="legend-item"><span class="kbd">W</span><span class="kbd">↑</span><b>油门 THROTTLE</b></div>
      <div class="legend-item"><span class="kbd">S</span><span class="kbd">↓</span><b>刹车 BRAKE</b></div>
      <div class="legend-item"><span class="kbd">A</span><span class="kbd">D</span><b>转向 STEER</b></div>
      <div class="legend-item"><span class="kbd">SPACE</span><b>手刹 DRIFT</b></div>
      <div class="legend-item"><span class="kbd">ESC</span><span class="kbd">P</span><b>暂停 PAUSE</b></div>
      <div class="legend-item"><span class="kbd">R</span><b>重开 RESTART</b></div>
      <div class="legend-item"><span class="kbd">C</span><b>复位 RESET</b></div>
      <div class="legend-item"><span class="kbd">M</span><b>静音 MUTE</b></div>
      <div class="legend-item" data-testid="legend-camera"><span class="kbd">V</span><b>切换视角 CAMERA</b></div>
      <div class="legend-item"><span class="kbd">F1</span><span class="kbd">H</span><b>调试 DEBUG</b></div>
    </div>`;
}

function soundButton(modifier = ''): string {
  return `<button type="button" class="btn btn-ghost sound-toggle${modifier ? ` ${modifier}` : ''}" data-action="sound" data-testid="sound-toggle" aria-pressed="true">
      <span class="sound-dot" aria-hidden="true"></span>声音 <em>SOUND</em> <b data-sound-label>开 ON</b>
    </button>`;
}

function menuTemplate(settings: Settings): string {
  return `
    <div class="screen menu-screen" data-screen="menu" data-testid="menu">
      <div class="menu-decor" aria-hidden="true">
        <div class="menu-orb menu-orb-cyan"></div>
        <div class="menu-orb menu-orb-pink"></div>
        <div class="menu-grid-floor"></div>
        <div class="menu-scanlines"></div>
      </div>
      <div class="menu-inner">
        <header class="brand">
          <div class="brand-main">
            <div class="brand-kicker"><span class="brand-live" aria-hidden="true"></span>零依赖街机赛车 · ZERO-DEPENDENCY ARCADE RACER</div>
            <h1 class="brand-title" data-text="NEON RACER">NEON RACER</h1>
            <p class="brand-sub">霓虹赛车 <i>·</i> 夜城狂飙 <i>·</i> NIGHT CITY OVERDRIVE</p>
          </div>
          <div class="brand-meta">
            <div><b>60</b><span>FPS TARGET</span></div>
            <div><b>10</b><span>RACERS MAX</span></div>
            <div><b>0</b><span>ASSET FILES</span></div>
          </div>
        </header>

        <div class="menu-grid">
          <section class="panel panel-setup" aria-label="比赛设置 RACE SETUP">
            <div class="panel-head">
              <h2 class="panel-title">比赛设置 <small>RACE SETUP</small></h2>
              <span class="panel-tag">P1 GRID</span>
            </div>

            <div class="field">
              <label class="field-label" for="menu-seed"><b>赛道种子</b><span>TRACK SEED</span></label>
              <div class="field-control">
                <input class="input input-seed" id="menu-seed" data-testid="seed" type="number" inputmode="numeric"
                  step="1" min="0" max="${MAX_SEED}" value="${settings.seed}" autocomplete="off" />
                <button type="button" class="btn btn-small" data-action="random-seed" data-testid="random-seed">随机 <em>RANDOM</em></button>
              </div>
            </div>

            <div class="field">
              <label class="field-label" for="menu-style"><b>赛道风格</b><span>TRACK STYLE</span></label>
              <div class="field-control">
                <div class="select-wrap"><select class="select" id="menu-style" data-testid="style">${styleOptions(settings.style)}</select></div>
              </div>
            </div>

            <div class="field">
              <label class="field-label" for="menu-laps"><b>圈数</b><span>LAPS</span></label>
              <div class="field-control">
                <div class="range-wrap">
                  <input class="range" id="menu-laps" data-testid="laps" type="range" min="${RACE.minLaps}" max="${RACE.maxLaps}" step="1" value="${settings.laps}" />
                  <output class="range-out" data-output="laps">${settings.laps}</output>
                </div>
              </div>
            </div>

            <div class="field">
              <label class="field-label" for="menu-opponents"><b>对手数量</b><span>OPPONENTS</span></label>
              <div class="field-control">
                <div class="range-wrap">
                  <input class="range" id="menu-opponents" data-testid="opponents" type="range" min="0" max="${RACE.maxOpponents}" step="1" value="${settings.opponents}" />
                  <output class="range-out" data-output="opponents">${settings.opponents}</output>
                </div>
              </div>
            </div>

            <div class="field">
              <label class="field-label" for="menu-difficulty"><b>难度</b><span>DIFFICULTY</span></label>
              <div class="field-control">
                <div class="select-wrap"><select class="select" id="menu-difficulty" data-testid="difficulty">${difficultyOptions(settings.difficulty)}</select></div>
              </div>
            </div>

            <div class="field">
              <label class="field-label" for="menu-car"><b>赛车等级</b><span>CAR CLASS</span></label>
              <div class="field-control field-control-car">
                <div class="select-wrap"><select class="select" id="menu-car" data-testid="car-class">${carClassOptions(settings.carClass)}</select></div>
                <canvas class="car-preview" data-car-preview aria-hidden="true"></canvas>
              </div>
            </div>

            <div class="field">
              <label class="field-label" for="menu-camera"><b>视角</b><span>CAMERA</span></label>
              <div class="field-control">
                <div class="select-wrap"><select class="select" id="menu-camera" data-testid="camera-mode">${cameraModeOptions(settings.cameraMode)}</select></div>
              </div>
            </div>

            <div class="field">
              <label class="field-label" for="menu-name"><b>车手名称</b><span>PLAYER NAME</span></label>
              <div class="field-control">
                <input class="input input-name" id="menu-name" data-testid="player-name" type="text" maxlength="${MAX_NAME_LENGTH}"
                  placeholder="PLAYER" autocomplete="off" spellcheck="false" />
              </div>
            </div>
          </section>

          <aside class="menu-side">
            <section class="panel panel-record" aria-label="赛道记录 TRACK RECORD">
              <div class="panel-head">
                <h2 class="panel-title">赛道记录 <small>TRACK RECORD</small></h2>
                <span class="panel-tag" data-record-key>—</span>
              </div>
              <div class="record-track">
                <b data-testid="record-track-name">—</b>
                <span data-testid="record-track-meta">生成赛道预览 · GENERATING</span>
              </div>
              <dl class="record-grid">
                <div class="record-cell"><dt>最快圈 <em>BEST LAP</em></dt><dd data-testid="record-best-lap">--:--.---</dd></div>
                <div class="record-cell"><dt>最快总时 <em>BEST TOTAL</em></dt><dd data-testid="record-best-total">--:--.---</dd></div>
                <div class="record-cell"><dt>完成次数 <em>RUNS</em></dt><dd data-testid="record-runs">0</dd></div>
              </dl>
              <p class="record-empty" data-record-empty>暂无记录 <i>·</i> NO RECORD YET</p>
            </section>

            <section class="panel panel-start">
              <button type="button" class="btn btn-primary start-btn" data-action="start" data-testid="start-race">
                <span class="start-btn-main">开始比赛 <em>START RACE</em></span>
                <span class="start-btn-sub">键盘 · 鼠标 · 触屏 · ALL INPUTS</span>
              </button>
              <div class="start-row">
                ${soundButton()}
                <span class="start-hint">按 <span class="kbd">ENTER</span> 亦可开始<br />ESC / P 暂停 · 全屏体验更佳</span>
              </div>
            </section>

            <section class="panel panel-legend" aria-label="操作 CONTROLS">
              <div class="panel-head">
                <h2 class="panel-title">操作 <small>CONTROLS</small></h2>
                <span class="panel-tag">KEYBOARD</span>
              </div>
              ${controlsLegend()}
            </section>
          </aside>
        </div>

        <footer class="menu-foot">
          <span>© 2026 NEON RACER <i>·</i> 霓虹赛车</span>
          <span>触屏设备自动显示虚拟按键 <i>·</i> TOUCH CONTROLS AUTO</span>
          <span>ZERO DEPENDENCY <i>·</i> CANVAS 2D</span>
        </footer>
      </div>
    </div>`;
}

function pauseTemplate(): string {
  return `
    <div class="screen overlay-screen" data-screen="pause" data-testid="pause-overlay" hidden>
      <div class="overlay-panel panel pause-panel" role="dialog" aria-modal="true" aria-labelledby="pause-title">
        <div class="overlay-kicker"><span class="brand-live" aria-hidden="true"></span>SIMULATION PAUSED</div>
        <h2 class="overlay-title" id="pause-title">暂停 <em>PAUSED</em></h2>
        <p class="overlay-sub">比赛已暂停 · 计时与 AI 均已冻结</p>
        <div class="btn-row">
          <button type="button" class="btn btn-primary" data-action="resume" data-testid="pause-resume">继续 <em>RESUME</em></button>
          <button type="button" class="btn" data-action="restart" data-testid="pause-restart">重开 <em>RESTART</em></button>
          <button type="button" class="btn btn-danger" data-action="quit" data-testid="pause-quit">退出 <em>QUIT</em></button>
        </div>
        <div class="overlay-legend">
          <h3 class="overlay-legend-title">操作 <small>CONTROLS</small></h3>
          ${controlsLegend()}
        </div>
        <div class="overlay-foot">
          ${soundButton('btn-small')}
          <span>ESC / P 继续 <i>·</i> R 重开 <i>·</i> 进度不会保存</span>
        </div>
      </div>
    </div>`;
}

function resultsTemplate(): string {
  return `
    <div class="screen overlay-screen results-screen" data-screen="results" data-testid="results" hidden>
      <div class="overlay-panel panel results-panel" role="dialog" aria-modal="true" aria-labelledby="results-title">
        <div class="results-badge" data-testid="new-record" hidden>新纪录 <em>NEW RECORD</em></div>
        <div class="overlay-kicker"><span class="brand-live" aria-hidden="true"></span>RACE COMPLETE</div>
        <div class="results-head">
          <div class="results-place">
            <span class="results-place-label">最终名次 <em>FINAL POSITION</em></span>
            <b data-results-place>P1</b><span class="results-place-total" data-results-place-total>/6</span>
          </div>
          <div class="results-title-wrap">
            <h2 class="overlay-title" id="results-title">冲线 <em>FINISH</em></h2>
            <p class="overlay-sub" data-results-sub>—</p>
          </div>
        </div>
        <div class="stat-grid">
          <div class="stat"><span>最快圈 <em>BEST LAP</em></span><b data-results-best>--:--.---</b></div>
          <div class="stat"><span>总用时 <em>TOTAL</em></span><b data-results-total>--:--.---</b></div>
          <div class="stat"><span>原纪录 <em>PREVIOUS BEST</em></span><b data-results-record>--:--.---</b></div>
          <div class="stat"><span>完成圈数 <em>LAPS</em></span><b data-results-laps>—</b></div>
        </div>
        <div class="results-columns">
          <section aria-label="圈速 LAP TIMES">
            <h3 class="results-list-title">圈速 <small>LAP TIMES</small></h3>
            <ol class="lap-list" data-results-laps-list></ol>
          </section>
          <section aria-label="最终排名 FINAL ORDER">
            <h3 class="results-list-title">最终排名 <small>FINAL ORDER</small></h3>
            <ol class="final-list" data-results-standings></ol>
          </section>
        </div>
        <div class="btn-row results-actions">
          <button type="button" class="btn btn-primary" data-action="restart" data-testid="results-restart">再来一局 <em>RACE AGAIN</em></button>
          <button type="button" class="btn" data-action="quit" data-testid="results-quit">返回菜单 <em>MAIN MENU</em></button>
        </div>
      </div>
    </div>`;
}

function query<T extends Element>(root: HTMLElement, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`NEON RACER UI: missing element ${selector}`);
  return found;
}

function queryAll<T extends Element>(root: HTMLElement, selector: string): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

export function createUI(root: HTMLElement, handlers: UIHandlers): UI {
  let settings = sanitizeSettings(loadSettings());
  let soundEnabled = settings.sound;

  root.innerHTML =
    menuTemplate(settings) +
    pauseTemplate() +
    resultsTemplate() +
    '<div class="toasts" data-testid="toasts" aria-live="polite" aria-atomic="false"></div>';

  const hud = createHud(root);

  /* ---------------------------------------------------------- dom lookups -- */

  const screens = queryAll<HTMLElement>(root, '.screen');
  const pauseScreen = query<HTMLElement>(root, '[data-screen="pause"]');
  const resultsScreen = query<HTMLElement>(root, '[data-screen="results"]');
  const toastsEl = query<HTMLElement>(root, '[data-testid="toasts"]');

  const seedInput = query<HTMLInputElement>(root, '[data-testid="seed"]');
  const styleSelect = query<HTMLSelectElement>(root, '[data-testid="style"]');
  const lapsInput = query<HTMLInputElement>(root, '[data-testid="laps"]');
  const opponentsInput = query<HTMLInputElement>(root, '[data-testid="opponents"]');
  const difficultySelect = query<HTMLSelectElement>(root, '[data-testid="difficulty"]');
  const carClassSelect = query<HTMLSelectElement>(root, '[data-testid="car-class"]');
  const cameraModeSelect = query<HTMLSelectElement>(root, '[data-testid="camera-mode"]');
  const nameInput = query<HTMLInputElement>(root, '[data-testid="player-name"]');
  const lapsOutput = query<HTMLOutputElement>(root, '[data-output="laps"]');
  const opponentsOutput = query<HTMLOutputElement>(root, '[data-output="opponents"]');
  const carPreview = query<HTMLCanvasElement>(root, '[data-car-preview]');

  const recordKeyEl = query<HTMLElement>(root, '[data-record-key]');
  const recordNameEl = query<HTMLElement>(root, '[data-testid="record-track-name"]');
  const recordMetaEl = query<HTMLElement>(root, '[data-testid="record-track-meta"]');
  const recordLapEl = query<HTMLElement>(root, '[data-testid="record-best-lap"]');
  const recordTotalEl = query<HTMLElement>(root, '[data-testid="record-best-total"]');
  const recordRunsEl = query<HTMLElement>(root, '[data-testid="record-runs"]');
  const recordEmptyEl = query<HTMLElement>(root, '[data-record-empty]');

  const resultsBadge = query<HTMLElement>(root, '[data-testid="new-record"]');
  const resultsPanel = query<HTMLElement>(root, '.results-panel');
  const resultsPlace = query<HTMLElement>(root, '[data-results-place]');
  const resultsPlaceTotal = query<HTMLElement>(root, '[data-results-place-total]');
  const resultsSub = query<HTMLElement>(root, '[data-results-sub]');
  const resultsBest = query<HTMLElement>(root, '[data-results-best]');
  const resultsTotal = query<HTMLElement>(root, '[data-results-total]');
  const resultsRecord = query<HTMLElement>(root, '[data-results-record]');
  const resultsLaps = query<HTMLElement>(root, '[data-results-laps]');
  const resultsLapList = query<HTMLElement>(root, '[data-results-laps-list]');
  const resultsStandings = query<HTMLElement>(root, '[data-results-standings]');

  /* ------------------------------------------------------------- helpers --- */

  nameInput.value = settings.playerName;

  function readSeed(): number {
    const value = Number(seedInput.value);
    if (!Number.isFinite(value)) return settings.seed || DEFAULT_SETTINGS.seed;
    return clamp(Math.floor(value), 0, MAX_SEED);
  }

  function readStyle(): TrackStyle {
    const value = styleSelect.value as TrackStyle;
    return TRACK_STYLES.includes(value) ? value : settings.style;
  }

  function readDifficulty(): Difficulty {
    const value = difficultySelect.value as Difficulty;
    return DIFFICULTIES.includes(value) ? value : settings.difficulty;
  }

  function readCarClass(): CarClass {
    const value = carClassSelect.value as CarClass;
    return CAR_CLASSES.includes(value) ? value : settings.carClass;
  }

  function readCameraMode(): CameraMode {
    const value = cameraModeSelect.value as CameraMode;
    return CAMERA_MODES.includes(value) ? value : settings.cameraMode;
  }

  function readRange(input: HTMLInputElement, min: number, max: number, fallback: number): number {
    const value = Number(input.value);
    if (!Number.isFinite(value)) return fallback;
    return clamp(Math.round(value), min, max);
  }

  function readPlayerName(): string {
    const value = nameInput.value.trim().slice(0, MAX_NAME_LENGTH);
    return value === '' ? DEFAULT_SETTINGS.playerName : value;
  }

  function collectConfig(): RaceConfig {
    return {
      seed: readSeed(),
      style: readStyle(),
      laps: readRange(lapsInput, RACE.minLaps, RACE.maxLaps, RACE.defaultLaps),
      opponents: readRange(opponentsInput, 0, RACE.maxOpponents, RACE.defaultOpponents),
      difficulty: readDifficulty(),
      carClass: readCarClass(),
      playerName: readPlayerName(),
    };
  }

  /* -------------------------------------------------------- car preview ---- */

  function drawCarPreview(): void {
    const ctx = carPreview.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = 112;
    const cssH = 52;
    carPreview.width = Math.round(cssW * dpr);
    carPreview.height = Math.round(cssH * dpr);
    carPreview.style.width = `${cssW}px`;
    carPreview.style.height = `${cssH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const palette = CAR_COLORS[0]!;
    ctx.save();
    ctx.translate(cssW / 2, cssH / 2);

    /* ground glow */
    ctx.fillStyle = 'rgba(0, 240, 255, 0.10)';
    ctx.beginPath();
    ctx.ellipse(0, 15, 44, 8, 0, 0, TAU);
    ctx.fill();

    /* wheels */
    ctx.fillStyle = '#05060f';
    ctx.fillRect(-24, -21, 15, 7);
    ctx.fillRect(8, -21, 15, 7);
    ctx.fillRect(-24, 14, 15, 7);
    ctx.fillRect(8, 14, 15, 7);

    /* body with neon glow */
    ctx.shadowColor = palette.color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = palette.color;
    ctx.beginPath();
    ctx.roundRect(-32, -14, 64, 28, 9);
    ctx.fill();
    ctx.shadowBlur = 0;

    /* nose + cockpit + stripe */
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.roundRect(19, -9, 10, 18, 3);
    ctx.fill();
    ctx.fillStyle = 'rgba(5, 10, 22, 0.82)';
    ctx.beginPath();
    ctx.roundRect(-8, -8, 18, 16, 5);
    ctx.fill();
    ctx.fillStyle = palette.accent;
    ctx.fillRect(-27, -2, 16, 4);

    ctx.restore();
  }

  /* ------------------------------------------------------ track preview ---- */

  let previewTrack: Track | null = null;
  let previewKey = '';
  let recordTimer = 0;

  function refreshRecordNow(): void {
    const seed = readSeed();
    const style = readStyle();
    const key = `${style}:${seed}`;
    recordKeyEl.textContent = `SEED ${seed} · ${style.toUpperCase()}`;
    if (!previewTrack || previewKey !== key) {
      try {
        previewTrack = generateTrack(seed, style);
      } catch {
        previewTrack = null;
      }
      previewKey = key;
    }
    const track = previewTrack;
    if (!track) {
      recordNameEl.textContent = '赛道不可用 TRACK UNAVAILABLE';
      recordMetaEl.textContent = '—';
      recordLapEl.textContent = formatTime(null);
      recordTotalEl.textContent = formatTime(null);
      recordRunsEl.textContent = '0';
      recordEmptyEl.hidden = false;
      return;
    }
    recordNameEl.textContent = track.name;
    recordMetaEl.textContent = `${TRACK.styleLabels[track.style]} · 种子 seed ${track.seed}`;

    let record: TrackRecord | null = null;
    try {
      record = loadRecord(track);
    } catch {
      record = null;
    }
    if (!record || (record.bestLap == null && record.bestTotal == null && record.runs === 0)) {
      recordEmptyEl.hidden = false;
      recordLapEl.textContent = formatTime(null);
      recordTotalEl.textContent = formatTime(null);
      recordRunsEl.textContent = '0';
    } else {
      recordEmptyEl.hidden = true;
      recordLapEl.textContent = formatTime(record.bestLap);
      recordTotalEl.textContent = formatTime(record.bestTotal);
      recordRunsEl.textContent = String(record.runs);
    }
  }

  function scheduleRecordRefresh(delay = 220): void {
    if (recordTimer) window.clearTimeout(recordTimer);
    recordTimer = window.setTimeout(() => {
      recordTimer = 0;
      refreshRecordNow();
    }, delay);
  }

  /* ---------------------------------------------------------- sound state -- */

  function applySoundState(): void {
    for (const label of queryAll<HTMLElement>(root, '[data-sound-label]')) {
      label.textContent = soundEnabled ? '开 ON' : '关 OFF';
    }
    for (const toggle of queryAll<HTMLElement>(root, '[data-action="sound"]')) {
      toggle.setAttribute('aria-pressed', soundEnabled ? 'true' : 'false');
      toggle.classList.toggle('is-off', !soundEnabled);
    }
  }

  function toggleSound(force?: boolean): void {
    const next = force ?? !soundEnabled;
    soundEnabled = next;
    settings = saveSettings({ sound: next });
    applySoundState();
    handlers.onSoundToggle(next);
  }

  /* --------------------------------------------------------------- start --- */

  function beginRace(): void {
    if (recordTimer) {
      window.clearTimeout(recordTimer);
      recordTimer = 0;
    }
    const config = collectConfig();
    seedInput.value = String(config.seed);
    settings = sanitizeSettings(
      saveSettings({
        seed: config.seed,
        style: config.style,
        laps: config.laps,
        opponents: config.opponents,
        difficulty: config.difficulty,
        carClass: config.carClass,
        playerName: config.playerName,
      }),
    );
    handlers.onStart(config);
  }

  /* ---------------------------------------------------------- menu events -- */

  seedInput.addEventListener('input', () => scheduleRecordRefresh());
  seedInput.addEventListener('change', () => {
    seedInput.value = String(readSeed());
    settings = saveSettings({ seed: readSeed() });
    refreshRecordNow();
  });

  styleSelect.addEventListener('change', () => {
    settings = saveSettings({ style: readStyle() });
    refreshRecordNow();
  });

  lapsInput.addEventListener('input', () => {
    const laps = readRange(lapsInput, RACE.minLaps, RACE.maxLaps, RACE.defaultLaps);
    lapsOutput.textContent = String(laps);
    settings = saveSettings({ laps });
  });

  opponentsInput.addEventListener('input', () => {
    const opponents = readRange(opponentsInput, 0, RACE.maxOpponents, RACE.defaultOpponents);
    opponentsOutput.textContent = String(opponents);
    settings = saveSettings({ opponents });
  });

  difficultySelect.addEventListener('change', () => {
    settings = saveSettings({ difficulty: readDifficulty() });
  });

  carClassSelect.addEventListener('change', () => {
    settings = saveSettings({ carClass: readCarClass() });
    drawCarPreview();
  });

  /* main.ts re-reads saved settings on every race start, so persisting the
   * choice here is all that is needed to make V / the menu round-trip. */
  cameraModeSelect.addEventListener('change', () => {
    settings = saveSettings({ cameraMode: readCameraMode() });
  });

  nameInput.addEventListener('change', () => {
    const name = readPlayerName();
    nameInput.value = name;
    settings = saveSettings({ playerName: name });
  });

  for (const input of [nameInput, seedInput]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        beginRace();
      }
    });
  }

  /* ------------------------------------------------------- click handling -- */

  root.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const actionEl = target?.closest<HTMLElement>('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    switch (action) {
      case 'start':
        beginRace();
        break;
      case 'random-seed': {
        const seed = Math.floor(Math.random() * (MAX_SEED - 1_000_000)) + 1_000_000;
        seedInput.value = String(seed);
        settings = saveSettings({ seed });
        refreshRecordNow();
        break;
      }
      case 'sound':
        toggleSound();
        break;
      case 'resume':
        handlers.onPauseToggle();
        break;
      case 'restart':
        handlers.onRestart();
        break;
      case 'quit':
        handlers.onQuit();
        break;
      default:
        break;
    }
  });

  /* --------------------------------------------------------------- screens -- */

  function focusFirstButton(container: HTMLElement): void {
    const button = container.querySelector<HTMLButtonElement>('button:not([disabled])');
    if (!button) return;
    try {
      button.focus({ preventScroll: true });
    } catch {
      button.focus();
    }
  }

  function showScreen(next: Screen): void {
    // Leaving a screen retires its transient notices: a stale "GO!" or lap toast
    // must never linger over the menu / pause / results overlay.
    if (root.dataset.screen && root.dataset.screen !== next) clearToasts();
    for (const el of screens) el.hidden = el.dataset.screen !== next;
    root.dataset.screen = next;
    document.body.dataset.screen = next;
    hud.setVisible(next === 'race');

    if (next === 'race') {
      const active = document.activeElement as HTMLElement | null;
      if (active && root.contains(active)) active.blur();
    } else if (next === 'pause') {
      focusFirstButton(pauseScreen);
    } else if (next === 'results') {
      focusFirstButton(resultsScreen);
    } else if (next === 'menu') {
      refreshRecordNow();
    }
  }

  /* --------------------------------------------------------------- results -- */

  function showResults(race: RaceState, record: TrackRecord | null, improved: boolean): void {
    const player = race.player;
    const total = race.racers.length;
    resultsPlace.textContent = `P${player.place}`;
    resultsPlaceTotal.textContent = `/${total}`;
    resultsPlace.classList.toggle('is-win', player.place === 1);
    resultsSub.textContent = `${race.track.name} · ${race.config.laps} 圈 LAPS · ${DIFFICULTY[race.config.difficulty].label} · ${CARS[race.config.carClass].name}`;
    resultsBest.textContent = formatTime(player.bestLap);
    resultsTotal.textContent = formatTime(player.finishTime ?? player.totalTime);
    resultsLaps.textContent = `${Math.min(player.lap, race.config.laps)}/${race.config.laps}`;
    resultsRecord.textContent = formatTime(record?.bestLap ?? null);
    resultsBadge.hidden = !improved;
    resultsPanel.classList.toggle('is-record', improved);

    /* per-lap times */
    const laps = player.lapTimes;
    if (laps.length === 0) {
      resultsLapList.innerHTML = '<li class="lap-empty">无有效圈速 · NO TIMED LAPS</li>';
    } else {
      let best = Number.POSITIVE_INFINITY;
      for (const time of laps) if (time < best) best = time;
      let html = '';
      for (let i = 0; i < laps.length; i++) {
        const time = laps[i]!;
        const isBest = time === best;
        html += `<li class="lap-row${isBest ? ' is-best' : ''}"><span class="lap-index">LAP ${i + 1}</span><b>${formatTime(time)}</b>${isBest ? '<i class="lap-tag">BEST</i>' : ''}</li>`;
      }
      resultsLapList.innerHTML = html;
    }

    /* final order */
    let standingsHtml = '';
    for (const racer of race.standings) {
      const lapText = racer.finished ? 'FIN' : `L${Math.min(racer.lap + 1, race.config.laps)}`;
      standingsHtml += `<li class="final-row${racer.isPlayer ? ' is-player' : ''}"><span class="final-pos">${racer.place}</span><i class="final-chip" style="background:${racer.color}"></i><span class="final-name">${escapeHtml(racer.name)}</span><span class="final-lap">${lapText}</span></li>`;
    }
    resultsStandings.innerHTML = standingsHtml;
  }

  /* ---------------------------------------------------------------- toasts -- */

  function clearToasts(): void {
    for (const child of Array.from(toastsEl.children)) child.remove();
  }

  function toast(text: string, kind: ToastKind = 'info'): void {
    const node = document.createElement('div');
    node.className = `toast toast-${kind}`;
    node.textContent = text;
    toastsEl.appendChild(node);
    while (toastsEl.children.length > MAX_TOASTS) {
      toastsEl.firstElementChild?.remove();
    }
    window.setTimeout(() => {
      node.classList.add('is-out');
      window.setTimeout(() => node.remove(), 260);
    }, 2400);
  }

  /* -------------------------------------------------------------- boot ----- */

  drawCarPreview();
  applySoundState();
  refreshRecordNow();
  document.body.dataset.screen = 'menu';
  root.dataset.screen = 'menu';

  return {
    showScreen,
    updateHud(race: RaceState, fps: number): void {
      hud.update(race, fps);
    },
    showResults,
    toast,
    setSoundEnabled(enabled: boolean): void {
      soundEnabled = enabled;
      applySoundState();
    },
  };
}
