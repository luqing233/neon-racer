/**
 * NEON RACER — in-race HUD (DOM overlay + minimap canvas).
 *
 * Internal to the UI layer: created by ui.ts and fed by main.ts through
 * `ui.updateHud(race, fps)` once per frame. The HUD is intentionally cheap:
 *   - every DOM node is cached and only written when its text/class changes
 *   - the minimap track outline is pre-rendered once per track to an offscreen
 *     canvas and blitted every frame, so only the racer dots are drawn live
 *   - no per-frame array/object allocation in the hot path
 *
 * Speed conversion: the simulation works in world units/second. We display
 * km/h with a fixed factor of 0.5, i.e. a car with `topSpeed = 560 u/s`
 * reads exactly 280 km/h at its top speed. See SPEED_TO_KMH below.
 */

import { CAMERA, CARS, DIFFICULTY } from '../game/config';
import { clamp, formatDelta, formatTime, TAU } from '../game/math';
import type { CameraMode, RaceState, Racer, Track } from '../game/types';
import { loadSettings } from './storage';

/** World units per second -> displayed km/h (0.5 => 560 u/s shows as 280 km/h). */
const SPEED_TO_KMH = 0.5;

const MAX_STANDINGS_ROWS = 6;
const STANDINGS_TOP = 5;
const MINIMAP_MAX_W = 196;
const MINIMAP_MAX_H = 154;
const MINIMAP_PAD = 10;
const GO_FLASH_SECONDS = 1.2;
/** How often the camera chip re-reads the persisted setting (a mid-race V
 *  press is persisted by main.ts; this keeps the chip in sync without any
 *  per-frame storage access). */
const CAMERA_POLL_MS = 400;
const CAMERA_LABELS: Readonly<Record<CameraMode, string>> = {
  chase: 'CHASE 跟随',
  topdown: 'NORTH-UP 俯视',
};

export interface Hud {
  readonly root: HTMLElement;
  update(race: RaceState, fps: number): void;
  setVisible(visible: boolean): void;
}

interface StandingRow {
  li: HTMLElement;
  pos: HTMLElement;
  chip: HTMLElement;
  name: HTMLElement;
  lap: HTMLElement;
}

interface StandingState {
  kind: number; // 0 = empty, 1 = rival, 2 = player
  id: number;
  place: number;
  lap: number;
  finished: boolean;
  name: string;
}

function query<T extends Element>(root: HTMLElement, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`NEON RACER HUD: missing element ${selector}`);
  return found;
}

function createStandingRow(): StandingRow {
  const li = document.createElement('li');
  li.className = 'hud-standing';
  li.hidden = true;
  const pos = document.createElement('span');
  pos.className = 'hud-standing-pos';
  const chip = document.createElement('i');
  chip.className = 'hud-standing-chip';
  const name = document.createElement('span');
  name.className = 'hud-standing-name';
  const lap = document.createElement('span');
  lap.className = 'hud-standing-lap';
  li.append(pos, chip, name, lap);
  return { li, pos, chip, name, lap };
}

export function createHud(parent: HTMLElement): Hud {
  const root = document.createElement('div');
  root.className = 'hud';
  root.hidden = true;
  root.dataset.testid = 'hud-root';
  root.innerHTML = `
    <div class="hud-vignette" aria-hidden="true"></div>

    <div class="hud-block hud-top-left">
      <div class="hud-place-wrap">
        <b class="hud-place" data-testid="hud-place">P1</b>
        <span class="hud-total">/6</span>
      </div>
      <div class="hud-lap-row">
        <span class="hud-label">圈数 LAP</span>
        <b class="hud-lap" data-testid="hud-lap">1/3</b>
      </div>
      <div class="hud-lap-row hud-lap-row-alt">
        <span class="hud-label">难度 DIFFICULTY</span>
        <b class="hud-class" data-testid="hud-class">PRO</b>
      </div>
      <div class="hud-camera" data-testid="hud-camera">
        <span class="hud-camera-key">V</span>
        <b class="hud-camera-mode">CHASE 跟随</b>
      </div>
    </div>

    <div class="hud-block hud-top-center">
      <div class="hud-curlap-label">当前圈 CURRENT LAP</div>
      <div class="hud-curlap" data-testid="hud-current">0:00.000</div>
      <div class="hud-clock"><span>比赛计时 RACE</span><b data-testid="hud-time">0:00.000</b></div>
    </div>

    <div class="hud-block hud-top-right">
      <div class="hud-minimap">
        <span class="hud-minimap-label">赛道 TRACK</span>
        <canvas class="hud-minimap-canvas" data-testid="hud-minimap"></canvas>
      </div>
      <div class="hud-standings">
        <div class="hud-standings-title"><span>实时排名</span><em>LIVE STANDINGS</em></div>
        <ol class="hud-standings-list" data-testid="hud-standings"></ol>
      </div>
    </div>

    <div class="hud-block hud-bottom-left">
      <div class="hud-stat">
        <span>最快圈 <em>BEST</em></span>
        <b data-testid="hud-best">--:--.---</b>
      </div>
      <div class="hud-stat">
        <span>上圈 <em>LAST</em></span>
        <b data-testid="hud-last">--:--.---</b>
        <i class="hud-delta" data-testid="hud-delta"></i>
      </div>
      <div class="hud-stat hud-stat-dim">
        <span>赛车 <em>CAR</em></span>
        <b data-testid="hud-car">—</b>
      </div>
    </div>

    <div class="hud-block hud-bottom-center">
      <div class="hud-rev">
        <div class="hud-rev-fill" data-testid="hud-rev"></div>
        <div class="hud-rev-ticks" aria-hidden="true"></div>
      </div>
      <div class="hud-speedrow">
        <b class="hud-speed" data-testid="hud-speed">0</b>
        <div class="hud-speedunit">
          <span class="hud-unit">KM/H</span>
          <span class="hud-gearbox"><i class="hud-gear-label">档位 GEAR</i><b class="hud-gear" data-testid="hud-gear">1</b></span>
        </div>
      </div>
      <div class="hud-boost">
        <span class="hud-boost-label">漂移充能 <em>DRIFT CHARGE</em></span>
        <span class="hud-boost-bar"><i class="hud-boost-fill" data-testid="hud-boost"></i></span>
        <b class="hud-boost-state" data-testid="hud-boost-state">0%</b>
      </div>
    </div>

    <div class="hud-block hud-bottom-right">
      <div class="hud-flag" data-testid="hud-surface">道路 ROAD</div>
      <div class="hud-fps"><span>FPS</span><b data-testid="hud-fps">60</b></div>
    </div>

    <div class="hud-countdown" data-testid="hud-countdown" hidden>
      <span class="hud-countdown-num"></span>
      <span class="hud-countdown-hint">准备 GET READY</span>
    </div>

    <div class="hud-wrongway" data-testid="hud-wrong-way">⚠ 方向错误 WRONG WAY ⚠</div>
    <div class="hud-finish" data-testid="hud-finish" hidden>
      <b>FINISH</b>
      <span>完赛 · 等待结果 RACE COMPLETE</span>
    </div>
  `;
  parent.appendChild(root);

  /* ------------------------------------------------------------- elements -- */

  const placeEl = query<HTMLElement>(root, '[data-testid="hud-place"]');
  const totalEl = query<HTMLElement>(root, '.hud-total');
  const lapEl = query<HTMLElement>(root, '[data-testid="hud-lap"]');
  const classEl = query<HTMLElement>(root, '[data-testid="hud-class"]');
  const cameraChipEl = query<HTMLElement>(root, '[data-testid="hud-camera"]');
  const cameraModeEl = query<HTMLElement>(root, '.hud-camera-mode');
  const curLapEl = query<HTMLElement>(root, '[data-testid="hud-current"]');
  const clockEl = query<HTMLElement>(root, '[data-testid="hud-time"]');
  const bestEl = query<HTMLElement>(root, '[data-testid="hud-best"]');
  const lastEl = query<HTMLElement>(root, '[data-testid="hud-last"]');
  const deltaEl = query<HTMLElement>(root, '[data-testid="hud-delta"]');
  const carEl = query<HTMLElement>(root, '[data-testid="hud-car"]');
  const speedEl = query<HTMLElement>(root, '[data-testid="hud-speed"]');
  const gearEl = query<HTMLElement>(root, '[data-testid="hud-gear"]');
  const revEl = query<HTMLElement>(root, '[data-testid="hud-rev"]');
  const boostEl = query<HTMLElement>(root, '.hud-boost');
  const boostFillEl = query<HTMLElement>(root, '[data-testid="hud-boost"]');
  const boostStateEl = query<HTMLElement>(root, '[data-testid="hud-boost-state"]');
  const flagEl = query<HTMLElement>(root, '[data-testid="hud-surface"]');
  const fpsEl = query<HTMLElement>(root, '[data-testid="hud-fps"]');
  const fpsWrap = query<HTMLElement>(root, '.hud-fps');
  const standingsList = query<HTMLElement>(root, '[data-testid="hud-standings"]');
  const countdownEl = query<HTMLElement>(root, '[data-testid="hud-countdown"]');
  const countdownNum = query<HTMLElement>(root, '.hud-countdown-num');
  const countdownHint = query<HTMLElement>(root, '.hud-countdown-hint');
  const wrongWayEl = query<HTMLElement>(root, '[data-testid="hud-wrong-way"]');
  const finishEl = query<HTMLElement>(root, '[data-testid="hud-finish"]');
  const minimapCanvas = query<HTMLCanvasElement>(root, '[data-testid="hud-minimap"]');

  /* ------------------------------------------------------- standings rows -- */

  const standingRows: StandingRow[] = [];
  const standingState: StandingState[] = [];
  for (let i = 0; i < MAX_STANDINGS_ROWS; i++) {
    const row = createStandingRow();
    standingsList.appendChild(row.li);
    standingRows.push(row);
    standingState.push({ kind: 0, id: -1, place: -1, lap: -1, finished: false, name: '' });
  }

  /* ---------------------------------------------------------- minimap cache -- */

  let mapCtx: CanvasRenderingContext2D | null = null;
  let mapOutline: HTMLCanvasElement | null = null;
  let mapTrack: Track | null = null;
  let mapScale = 1;
  let mapOffsetX = 0;
  let mapOffsetY = 0;
  let mapCssW = 0;
  let mapCssH = 0;
  let mapReady = false;

  function buildMinimap(track: Track): void {
    mapReady = false;
    mapTrack = track;
    try {
      const left = track.leftEdge;
      const right = track.rightEdge;
      const bounds = track.bounds;
      const boundsW = Math.max(1, bounds.maxX - bounds.minX);
      const boundsH = Math.max(1, bounds.maxY - bounds.minY);
      const innerW = MINIMAP_MAX_W - MINIMAP_PAD * 2;
      const innerH = MINIMAP_MAX_H - MINIMAP_PAD * 2;
      const scale = Math.min(innerW / boundsW, innerH / boundsH);
      const cssW = Math.max(48, Math.round(boundsW * scale + MINIMAP_PAD * 2));
      const cssH = Math.max(48, Math.round(boundsH * scale + MINIMAP_PAD * 2));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (left.length < 3 || right.length < 3) return;

      minimapCanvas.width = Math.max(1, Math.round(cssW * dpr));
      minimapCanvas.height = Math.max(1, Math.round(cssH * dpr));
      minimapCanvas.style.width = `${cssW}px`;
      minimapCanvas.style.height = `${cssH}px`;
      mapCssW = cssW;
      mapCssH = cssH;

      mapScale = scale;
      mapOffsetX = MINIMAP_PAD + (cssW - MINIMAP_PAD * 2 - boundsW * scale) / 2 - bounds.minX * scale;
      mapOffsetY = MINIMAP_PAD + (cssH - MINIMAP_PAD * 2 - boundsH * scale) / 2 - bounds.minY * scale;

      const ctx = minimapCanvas.getContext('2d');
      if (!ctx) return;
      mapCtx = ctx;

      const outline = document.createElement('canvas');
      outline.width = minimapCanvas.width;
      outline.height = minimapCanvas.height;
      const octx = outline.getContext('2d');
      if (!octx) return;

      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.translate(mapOffsetX, mapOffsetY);
      octx.scale(mapScale, mapScale);

      /* Asphalt band: left edge forward, right edge backward. */
      octx.beginPath();
      octx.moveTo(left[0]!.x, left[0]!.y);
      for (let i = 1; i < left.length; i++) octx.lineTo(left[i]!.x, left[i]!.y);
      for (let i = right.length - 1; i >= 0; i--) octx.lineTo(right[i]!.x, right[i]!.y);
      octx.closePath();
      octx.fillStyle = 'rgba(0, 240, 255, 0.10)';
      octx.fill();

      /* Neon edges. */
      octx.lineWidth = Math.max(0.8, 1.1) / mapScale;
      octx.lineJoin = 'round';
      octx.strokeStyle = 'rgba(0, 240, 255, 0.62)';
      octx.stroke();

      /* Start / finish line. */
      const si = ((track.startIndex % left.length) + left.length) % left.length;
      const startA = left[si]!;
      const startB = right[si]!;
      octx.beginPath();
      octx.moveTo(startA.x, startA.y);
      octx.lineTo(startB.x, startB.y);
      octx.lineWidth = 3 / mapScale;
      octx.strokeStyle = 'rgba(255, 46, 99, 0.95)';
      octx.stroke();

      mapOutline = outline;
      mapReady = true;
    } catch {
      mapReady = false;
    }
  }

  function drawMinimap(race: RaceState): void {
    if (!mapReady || !mapCtx || !mapOutline || mapCssW <= 0 || mapCssH <= 0) return;
    const ctx = mapCtx;
    const dpr = minimapCanvas.width / Math.max(1, mapCssW);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
    ctx.drawImage(mapOutline, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    /* Rivals first… */
    const racers = race.racers;
    for (let i = 0; i < racers.length; i++) {
      const racer = racers[i]!;
      if (racer.isPlayer) continue;
      const x = mapOffsetX + racer.car.pos.x * mapScale;
      const y = mapOffsetY + racer.car.pos.y * mapScale;
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, TAU);
      ctx.fillStyle = racer.color;
      ctx.fill();
    }

    /* …then the player, glowing on top. */
    const player = race.player;
    const px = mapOffsetX + player.car.pos.x * mapScale;
    const py = mapOffsetY + player.car.pos.y * mapScale;
    ctx.shadowColor = player.color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, TAU);
    ctx.fillStyle = player.color;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  /* --------------------------------------------------------- update caches -- */

  const textCache = {
    place: '\u0000',
    total: '\u0000',
    lap: '\u0000',
    class: '\u0000',
    current: '\u0000',
    clock: '\u0000',
    best: '\u0000',
    last: '\u0000',
    delta: '\u0000',
    car: '\u0000',
    speed: '\u0000',
    gear: '\u0000',
    boostState: '\u0000',
    camera: '\u0000',
    flag: '\u0000',
    fps: '\u0000',
    countdown: '\u0000',
  };
  type TextKey = keyof typeof textCache;

  const classCache = {
    placeFirst: false,
    fast: false,
    boostReady: false,
    boostActive: false,
    grass: false,
    cameraTopdown: false,
    fpsLow: false,
    wrongWay: false,
    finish: false,
  };

  let countdownKey = '';
  let cameraMode: CameraMode = readCameraSetting();
  let cameraPollAt = 0;
  let bestFlashUntil = 0;
  let lastBestSeen: number | null = null;
  let visible = false;

  function readCameraSetting(): CameraMode {
    try {
      const mode = loadSettings().cameraMode;
      return mode === 'topdown' || mode === 'chase' ? mode : CAMERA.defaultMode;
    } catch {
      return CAMERA.defaultMode;
    }
  }

  function setText(el: HTMLElement, key: TextKey, value: string): void {
    if (textCache[key] === value) return;
    textCache[key] = value;
    el.textContent = value;
  }

  function setClass(el: HTMLElement, key: keyof typeof classCache, on: boolean, className: string): void {
    if (classCache[key] === on) return;
    classCache[key] = on;
    el.classList.toggle(className, on);
  }

  function invalidate(): void {
    for (const key of Object.keys(textCache) as TextKey[]) textCache[key] = '\u0000';
    for (const key of Object.keys(classCache) as (keyof typeof classCache)[]) classCache[key] = false;
    for (let i = 0; i < standingState.length; i++) {
      const state = standingState[i]!;
      state.kind = 0;
      state.id = -1;
      state.place = -1;
      state.lap = -1;
      state.finished = false;
      state.name = '';
    }
    countdownKey = '';
    bestFlashUntil = 0;
    lastBestSeen = null;
    mapTrack = null;
    mapReady = false;
    /* showScreen('race') is called on every race start: pick up menu choices */
    cameraMode = readCameraSetting();
    cameraPollAt = 0;
  }

  /* ------------------------------------------------------------ standings -- */

  function applyStandingRow(index: number, racer: Racer, race: RaceState): void {
    const row = standingRows[index]!;
    const state = standingState[index]!;
    const kind = racer.isPlayer ? 2 : 1;
    const lapShown = Math.min(racer.lap + 1, race.config.laps);
    const lapText = racer.finished ? 'FIN' : `L${lapShown}`;

    if (state.kind !== kind) {
      state.kind = kind;
      row.li.hidden = false;
      row.li.classList.toggle('is-player', kind === 2);
    }
    if (state.id !== racer.id) {
      state.id = racer.id;
      row.chip.style.background = racer.color;
    }
    if (state.place !== racer.place) {
      state.place = racer.place;
      row.pos.textContent = String(racer.place);
    }
    if (state.name !== racer.name) {
      state.name = racer.name;
      row.name.textContent = racer.name;
    }
    if (state.lap !== lapShown || state.finished !== racer.finished) {
      state.lap = lapShown;
      state.finished = racer.finished;
      row.lap.textContent = lapText;
      row.li.classList.toggle('is-finished', racer.finished);
    }
  }

  function updateStandings(race: RaceState): void {
    const standings = race.standings;
    let count = 0;
    const top = Math.min(STANDINGS_TOP, standings.length);
    for (let i = 0; i < top; i++) applyStandingRow(count++, standings[i]!, race);

    const player = race.player;
    if (player.place > STANDINGS_TOP && count < MAX_STANDINGS_ROWS) applyStandingRow(count++, player, race);

    for (let i = count; i < MAX_STANDINGS_ROWS; i++) {
      const state = standingState[i]!;
      if (state.kind !== 0) {
        state.kind = 0;
        standingRows[i]!.li.hidden = true;
      }
    }
  }

  /* ------------------------------------------------------------- countdown -- */

  function pop(el: HTMLElement): void {
    if (typeof el.animate !== 'function') return;
    try {
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    } catch {
      /* ignore */
    }
    try {
      el.animate(
        [
          { transform: 'scale(1.5)', opacity: 0.15 },
          { transform: 'scale(1)', opacity: 1 },
        ],
        { duration: 320, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      );
    } catch {
      /* animations are decorative */
    }
  }

  function updateCountdown(race: RaceState): void {
    let key = '';
    let text = '';
    let hint = '';
    let isGo = false;

    if (race.phase === 'countdown') {
      const seconds = clamp(Math.ceil(race.countdown), 1, 3);
      key = `n${seconds}`;
      text = String(seconds);
      hint = '准备 GET READY';
    } else if (race.phase === 'racing' && race.time < GO_FLASH_SECONDS) {
      key = 'go';
      text = 'GO!';
      hint = '全速前进 FULL THROTTLE';
      isGo = true;
    }

    if (!key) {
      if (countdownKey !== '') {
        countdownKey = '';
        countdownEl.hidden = true;
      }
      return;
    }
    if (countdownEl.hidden) countdownEl.hidden = false;
    if (countdownKey !== key) {
      countdownKey = key;
      countdownNum.textContent = text;
      countdownHint.textContent = hint;
      countdownEl.classList.toggle('is-go', isGo);
      pop(countdownNum);
    }
  }

  /* ---------------------------------------------------------------- update -- */

  function update(race: RaceState, fps: number): void {
    if (!visible) return;

    if (race.track !== mapTrack) buildMinimap(race.track);
    drawMinimap(race);

    const player = race.player;
    const car = player.car;
    const laps = race.config.laps;
    const racers = race.racers.length;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();

    /* position / lap ---------------------------------------------------- */
    setText(placeEl, 'place', `P${player.place}`);
    setClass(placeEl, 'placeFirst', player.place === 1, 'is-first');
    setText(totalEl, 'total', `/${racers}`);

    const displayLap = Math.min(player.lap + 1, laps);
    setText(lapEl, 'lap', `${displayLap}/${laps}`);

    setText(classEl, 'class', DIFFICULTY[race.config.difficulty].label.split(' ').pop() ?? 'PRO');
    setText(carEl, 'car', CARS[race.config.carClass].name);

    /* lap times --------------------------------------------------------- */
    setText(bestEl, 'best', formatTime(player.bestLap));
    setText(lastEl, 'last', formatTime(player.lastLap));
    if (player.lastLap != null && player.bestLap != null && player.lastLap > player.bestLap + 0.0005) {
      setText(deltaEl, 'delta', formatDelta(player.lastLap - player.bestLap));
      deltaEl.classList.add('is-positive');
    } else {
      setText(deltaEl, 'delta', player.lastLap != null && player.bestLap != null ? 'BEST' : '');
      deltaEl.classList.toggle('is-positive', false);
      deltaEl.classList.toggle('is-best', player.lastLap != null && player.lastLap === player.bestLap);
    }
    if (player.bestLap != null && player.bestLap !== lastBestSeen) {
      lastBestSeen = player.bestLap;
      bestFlashUntil = now + 1800;
    }
    bestEl.classList.toggle('is-new', now < bestFlashUntil);

    /* timers ------------------------------------------------------------ */
    let currentLapTime: number | null;
    if (race.phase === 'countdown') currentLapTime = 0;
    else if (player.finished) currentLapTime = player.lastLap;
    else currentLapTime = Math.max(0, race.time - player.lapStartTime);
    setText(curLapEl, 'current', formatTime(currentLapTime));
    setText(clockEl, 'clock', formatTime(race.time));

    /* speed cluster ----------------------------------------------------- */
    const speedKmh = Math.round(car.speed * SPEED_TO_KMH);
    setText(speedEl, 'speed', String(speedKmh));
    setClass(speedEl, 'fast', speedKmh >= 200, 'is-fast');

    const gearText = car.speed < 2 && car.forwardSpeed <= 0.5 ? 'N' : String(car.gear);
    setText(gearEl, 'gear', gearText);

    const rev = clamp(car.engineRpm, 0, 1);
    revEl.style.transform = `scaleX(${rev.toFixed(3)})`;
    revEl.classList.toggle('is-redline', rev > 0.85);

    /* boost ------------------------------------------------------------- */
    const charge = clamp(car.driftCharge, 0, 1);
    const boosting = car.boostTime > 0;
    const ready = boosting || charge >= 0.999;
    if (classCache.boostActive !== boosting) {
      classCache.boostActive = boosting;
      boostEl.classList.toggle('is-active', boosting);
    }
    if (classCache.boostReady !== ready) {
      classCache.boostReady = ready;
      boostEl.classList.toggle('is-ready', ready && !boosting);
    }
    const fill = boosting ? 1 : charge;
    boostFillEl.style.transform = `scaleX(${fill.toFixed(3)})`;
    const boostText = boosting ? 'BOOST!' : charge >= 0.999 ? '就绪 READY' : `${Math.floor(charge * 100)}%`;
    setText(boostStateEl, 'boostState', boostText);

    /* camera mode chip ---------------------------------------------------- */
    if (now - cameraPollAt > CAMERA_POLL_MS) {
      cameraPollAt = now;
      const stored = readCameraSetting();
      if (stored !== cameraMode) cameraMode = stored;
    }
    setText(cameraModeEl, 'camera', CAMERA_LABELS[cameraMode]);
    setClass(cameraChipEl, 'cameraTopdown', cameraMode === 'topdown', 'is-topdown');

    /* surface / wrong way ------------------------------------------------ */
    const surface = car.surface;
    setText(flagEl, 'flag', surface === 'grass' ? '草地 GRASS' : surface === 'curb' ? '路肩 CURB' : '道路 ROAD');
    setClass(flagEl, 'grass', surface === 'grass', 'is-grass');
    setClass(wrongWayEl, 'wrongWay', player.wrongWay, 'is-on');

    /* fps ---------------------------------------------------------------- */
    const fpsValue = Math.round(clamp(fps, 0, 999));
    setText(fpsEl, 'fps', String(fpsValue));
    setClass(fpsWrap, 'fpsLow', fpsValue > 0 && fpsValue < 48, 'is-low');

    /* standings / countdown / finish ------------------------------------- */
    updateStandings(race);
    updateCountdown(race);

    const showFinish = race.phase === 'finished' && countdownKey !== 'finish';
    if (classCache.finish !== showFinish) {
      classCache.finish = showFinish;
      finishEl.hidden = !showFinish;
    }
  }

  return {
    root,
    update,
    setVisible(next: boolean): void {
      if (visible === next) return;
      visible = next;
      root.hidden = !next;
      if (next) invalidate();
    },
  };
}
