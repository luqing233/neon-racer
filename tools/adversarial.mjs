#!/usr/bin/env node
/**
 * adversarial.mjs — T5 adversarial checks for Neon Racer, driven over CDP.
 *
 * Covers the task-5 checklist items the screenshot script does not:
 *   (a) determinism      — two identical scripted runs → identical state()/standings
 *   (b) robustness       — pause/resume/restart/quit+start, screenshots after each
 *   (c) NaN hunt         — 30 s of scripted racing @120 Hz + per-rAF state() polling
 *   (d) responsive       — 1600x900 and 390x844 screenshots
 *   (e) performance      — 3 s of rAF frame times + main-thread cost, mean/p95
 *   (f) wrong-way        — deliberately drive backwards, require racer.wrongWay
 *
 * It never edits src/**. It writes screenshots 07-*..15-* and artifacts/adversarial.json,
 * prints one JSON line on stdout and exits non-zero if a hard check fails.
 *
 * Usage: node tools/adversarial.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launch, PROJECT_ROOT } from './cdp.mjs';
import { startServer } from './static-server.mjs';

const OUT_DIR = path.resolve(PROJECT_ROOT, 'artifacts');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const VIEWPORT = { width: 1600, height: 900 };

const log = (...parts) => console.error('[adversarial]', ...parts);
const checks = [];
const failures = [];

function check(name, pass, detail = null, { fatality = 'hard' } = {}) {
  const ok = Boolean(pass);
  checks.push({ name, pass: ok, detail, fatality });
  if (!ok) {
    if (fatality === 'hard') failures.push(detail ? `${name}: ${detail}` : name);
    log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}

function warn(name, detail) {
  checks.push({ name, pass: true, detail, fatality: 'note' });
  log(`NOTE  ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------------- page utils -- */

/** Canvas pixel statistics — proves the frame is not blank/black. */
function canvasStats() {
  const canvas = document.getElementById('game');
  if (!canvas) return { error: 'no #game canvas' };
  const ctx = canvas.getContext('2d');
  if (!ctx) return { error: 'no 2d context' };
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) return { error: `canvas has zero backing store size (${w}x${h})` };
  const strideX = Math.max(1, Math.floor(w / 80));
  const strideY = Math.max(1, Math.floor(h / 45));
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let nonDark = 0;
  const colors = new Set();
  for (let y = Math.floor(strideY / 2); y < h; y += strideY) {
    for (let x = Math.floor(strideX / 2); x < w; x += strideX) {
      const d = ctx.getImageData(x, y, 1, 1).data;
      const lum = 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
      count += 1;
      sum += lum;
      sumSq += lum * lum;
      if (lum > 18) nonDark += 1;
      colors.add(`${d[0] >> 3},${d[1] >> 3},${d[2] >> 3}`);
    }
  }
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  return {
    backingWidth: w,
    backingHeight: h,
    cssWidth: canvas.clientWidth,
    cssHeight: canvas.clientHeight,
    meanLuminance: +mean.toFixed(2),
    stddevLuminance: +Math.sqrt(variance).toFixed(2),
    nonDarkFraction: +(nonDark / count).toFixed(4),
    distinctColors: colors.size,
  };
}

function domStats() {
  const testids = [...document.querySelectorAll('[data-testid]')].map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      id: el.getAttribute('data-testid'),
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden',
    };
  });
  return {
    title: document.title,
    testids,
    bodyText: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
    bodyTextLength: (document.body.innerText ?? '').trim().length,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  };
}

/** Is the given testid inside the viewport and not hidden? */
function isVisible(selector) {
  const el = document.querySelector(selector);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return !el.hidden && r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
}

/* ------------------------------------------------------- scripted drivers -- */

/** Two identical scripted runs entirely inside one synchronous evaluate →
 *  no rAF can interleave, so the comparison is genuinely apples-to-apples. */
function detRun() {
  const api = window.__NEON__;
  const race = api.startRace({
    seed: 424242, style: 'circuit', laps: 1, opponents: 3,
    difficulty: 'normal', carClass: 'balanced', playerName: 'DET',
  });
  api.press(null);
  api.tick(4.2);
  const samples = [];
  for (let i = 0; i < 30 * 120; i++) {
    api.press({ throttle: 1, brake: 0, steer: Math.sin(i / 150) * 0.45, handbrake: i % 900 < 50 });
    api.tick(1 / 120, 1 / 120);
    if (i % 60 === 0) samples.push(JSON.stringify({ state: api.state(), standings: api.standings() }));
  }
  return {
    count: samples.length,
    samples,
    final: JSON.stringify({ state: api.state(), standings: api.standings() }),
    track: race.track.name,
  };
}

/** 30 simulated seconds of aggressive driving, scanning state() + full racer state. */
function nanHunt() {
  const api = window.__NEON__;
  const race = api.startRace({
    seed: 777, style: 'speedway', laps: 3, opponents: 5,
    difficulty: 'hard', carClass: 'drifter', playerName: 'NANHUNT',
  });
  api.press(null);
  api.tick(4.2);
  const SUB = 1 / 120;
  const bad = [];
  let maxSpeed = 0;
  let driftSeen = false;
  let boostSeen = false;
  let offroadSeen = false;
  let steps = 0;

  const checkRacer = (racer) => {
    for (const key of Object.keys(racer.car)) {
      const value = racer.car[key];
      if (typeof value === 'number' && !Number.isFinite(value)) bad.push(`racer${racer.id}.car.${key}`);
    }
    for (const key of Object.keys(racer.progress)) {
      const value = racer.progress[key];
      if (typeof value === 'number' && !Number.isFinite(value)) bad.push(`racer${racer.id}.progress.${key}`);
    }
    for (const value of [racer.lap, racer.place, racer.totalTime, racer.penalty]) {
      if (!Number.isFinite(value)) bad.push(`racer${racer.id} scalar`);
    }
  };

  for (let i = 0; i < 30 * 120; i++) {
    const phase = i % 900;
    api.press({
      throttle: phase < 600 ? 1 : 0.15,
      brake: phase > 840 ? 0.7 : 0,
      steer: Math.sin(i / 83) * 0.9,
      handbrake: phase > 780 && phase < 860,
    });
    api.tick(SUB, SUB);
    steps += 1;
    const state = api.state();
    if (!state) {
      bad.push('state() returned null');
      break;
    }
    for (const key of ['time', 'countdown', 'lap', 'lap', 'speed']) {
      const value = state[key];
      if (value !== null && value !== undefined && typeof value === 'number' && !Number.isFinite(value)) {
        bad.push(`state.${key}`);
      }
    }
    if (state.pos && (!Number.isFinite(state.pos.x) || !Number.isFinite(state.pos.y))) bad.push('state.pos');
    if (state.bestLap !== null && !Number.isFinite(state.bestLap)) bad.push('state.bestLap');
    if (i % 120 === 0) for (const racer of race.racers) checkRacer(racer);
    for (const racer of race.racers) {
      if (Number.isFinite(racer.car.speed)) maxSpeed = Math.max(maxSpeed, racer.car.speed);
      if (racer.car.drifting) driftSeen = true;
      if (racer.car.boostTime > 0) boostSeen = true;
      if (racer.car.surface === 'grass') offroadSeen = true;
    }
    if (bad.length > 40) break;
  }
  return {
    steps,
    bad: bad.slice(0, 20),
    maxSpeed: +maxSpeed.toFixed(1),
    driftSeen,
    boostSeen,
    offroadSeen,
    phase: race.phase,
    hudHasNaN: /NaN|Infinity/.test(document.body.innerText),
  };
}

/** Poll state() once per animation frame for a few real seconds. */
function rafStatePoll(seconds) {
  const api = window.__NEON__;
  return new Promise((resolve) => {
    const bad = [];
    let frames = 0;
    const start = performance.now();
    const scanObject = (prefix, obj) => {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'number' && !Number.isFinite(value)) bad.push(`${prefix}.${key}`);
        else if (value && typeof value === 'object' && !Array.isArray(value)) scanObject(`${prefix}.${key}`, value);
      }
    };
    const loop = () => {
      frames += 1;
      const state = api.state();
      if (!state) bad.push('state() null');
      else scanObject('state', state);
      if (performance.now() - start < seconds * 1000 && bad.length === 0) requestAnimationFrame(loop);
      else resolve({ frames, bad: bad.slice(0, 20) });
    };
    requestAnimationFrame(loop);
  });
}

/** Deliberately drive backwards / turn around until racer.wrongWay fires. */
function wrongWayProbe() {
  const api = window.__NEON__;
  const race = api.startRace({
    seed: 20261018, style: 'circuit', laps: 3, opponents: 2,
    difficulty: 'easy', carClass: 'balanced', playerName: 'WRONGWAY',
  });
  window.__RACE__ = race;
  api.press(null);
  api.tick(4.2);
  const SUB = 1 / 120;
  const track = race.track;
  const player = race.player;
  const wrap = (a) => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  };
  const trackDirAngle = () => {
    const q = track.query(player.car.pos);
    const sample = track.at(q.s);
    return Math.atan2(sample.dir.y, sample.dir.x);
  };
  const result = { method: null, wrongWaySeen: false, simTime: 0, speedAtTrigger: 0, attempts: [] };

  // Attempt 1: reverse gear straight back over the start line.
  for (let i = 0; i < 8 * 120; i++) {
    api.press({ throttle: 0, brake: 1, steer: 0, handbrake: false });
    api.tick(SUB, SUB);
    result.simTime += SUB;
    if (player.wrongWay) {
      result.wrongWaySeen = true;
      result.method = 'reverse';
      break;
    }
  }
  result.attempts.push({ method: 'reverse', wrongWaySeen: result.wrongWaySeen, speed: +player.car.speed.toFixed(1) });

  if (!result.wrongWaySeen) {
    // Attempt 2: build speed forward, then do a U-turn and drive against the track.
    for (let i = 0; i < 3 * 120; i++) {
      api.press({ throttle: 1, brake: 0, steer: 0, handbrake: false });
      api.tick(SUB, SUB);
      result.simTime += SUB;
    }
    let turned = false;
    for (let i = 0; i < 8 * 120; i++) {
      api.press({ throttle: 0.6, brake: 0, steer: 1, handbrake: false });
      api.tick(SUB, SUB);
      result.simTime += SUB;
      if (player.wrongWay) {
        result.wrongWaySeen = true;
        result.method = 'u-turn';
        break;
      }
      if (Math.abs(wrap(player.car.angle - trackDirAngle())) > 2.4) {
        turned = true;
        break;
      }
    }
    if (!result.wrongWaySeen) {
      for (let i = 0; i < 7 * 120; i++) {
        api.press({ throttle: 1, brake: 0, steer: 0.1, handbrake: false });
        api.tick(SUB, SUB);
        result.simTime += SUB;
        if (player.wrongWay) {
          result.wrongWaySeen = true;
          result.method = 'u-turn-then-drive-backwards';
          break;
        }
      }
      result.attempts.push({ method: 'u-turn', turned, wrongWaySeen: result.wrongWaySeen });
    }
  }

  result.speedAtTrigger = +player.car.speed.toFixed(1);
  result.angleVsTrack = +wrap(player.car.angle - trackDirAngle()).toFixed(3);
  result.snapshot = {
    speed: +player.car.speed.toFixed(1),
    wrongWay: player.wrongWay,
    s: +player.progress.s.toFixed(1),
    time: +race.time.toFixed(2),
    lap: player.lap,
    counterSteer: true,
  };
  result.hudIndicatorOn = (() => {
    const el = document.querySelector('[data-testid="hud-wrong-way"]');
    return Boolean(el && (el.classList.contains('is-on') || getComputedStyle(el).opacity === '1'));
  })();
  // Keep forcing the wrong-way motion so the warning stays on for the screenshot.
  api.press({ throttle: 1, brake: 0, steer: 0.1, handbrake: false });
  return result;
}

/** rAF frame-time sampler. Returns frame intervals in ms. */
function rafSampler(seconds) {
  return new Promise((resolve) => {
    const frames = [];
    let last = performance.now();
    const start = last;
    const loop = (now) => {
      frames.push(now - last);
      last = now;
      if (now - start < seconds * 1000) requestAnimationFrame(loop);
      else resolve(frames);
    };
    requestAnimationFrame(loop);
  });
}

/* ---------------------------------------------------------------- helpers -- */

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function gather(browser) {
  const dom = await browser.evaluate(`(${domStats.toString()})()`);
  const canvas = await browser.evaluate(`(${canvasStats.toString()})()`);
  return { dom, canvas };
}

async function shot(browser, name, report, extra = {}) {
  const filePath = path.join(OUT_DIR, `${name}.png`);
  const result = await browser.screenshot(filePath);
  const buffer = await readFile(filePath);
  const size = pngSize(buffer);
  const stats = await gather(browser);
  const entry = {
    name,
    file: path.relative(PROJECT_ROOT, filePath).split(path.sep).join('/'),
    bytes: result.bytes,
    png: size,
    canvas: stats.canvas,
    dom: extra.dom ?? stats.dom,
    ...extra,
  };
  report.screens.push(entry);
  log(`shot ${name}.png ${result.bytes} bytes${size ? ` ${size.width}x${size.height}` : ' (invalid PNG!)'} canvas stddev=${stats.canvas.stddevLuminance}`);
  return entry;
}

function validateShot(entry) {
  const problems = [];
  if (!entry.png) problems.push('not a valid PNG');
  if (entry.bytes < 20000) problems.push(`only ${entry.bytes} bytes (< 20 KB)`);
  const canvas = entry.canvas ?? {};
  if (canvas.error) problems.push(canvas.error);
  else {
    if (!(canvas.stddevLuminance >= 2.0)) problems.push(`flat canvas (stddev ${canvas.stddevLuminance})`);
    if (!(canvas.distinctColors >= 5)) problems.push(`nearly monochrome (${canvas.distinctColors} colours)`);
  }
  return problems;
}

async function startApiRace(browser, partial) {
  return browser.evaluate(`(() => {
    const race = window.__NEON__.startRace(${JSON.stringify(partial)});
    window.__RACE__ = race;
    return {
      laps: race.config.laps,
      racers: race.racers.length,
      track: race.track.name,
      length: +race.track.length.toFixed(1),
      phase: race.phase,
    };
  })()`);
}

async function pauseRun(browser) {
  await browser.pressKey('Escape');
  const visible = await browser
    .waitFor(`(${isVisible.toString()})('[data-testid="pause-overlay"]')`, 3000)
    .catch(() => false);
  if (!visible) {
    await browser.evaluate('window.__NEON__.togglePause()');
    await browser.waitForFrames(2, 90000);
  }
  return visible;
}

async function isScreenVisible(browser, selector) {
  return browser.evaluate(`(${isVisible.toString()})(${JSON.stringify(selector)})`);
}

/* ------------------------------------------------------------------- main -- */

let server = null;
let browser = null;
const startedAt = Date.now();
const report = {
  harness: 'tools/adversarial.mjs',
  startedAt: new Date().toISOString(),
  viewport: VIEWPORT,
  screens: [],
  checks,
  failures,
  perf: null,
  determinism: null,
  robustness: [],
  nanHunt: null,
  responsive: null,
  wrongWay: null,
  console: null,
  ok: false,
};

try {
  if (!DIST_DIR || !(await readFile(path.join(DIST_DIR, 'index.html')).catch(() => null))) {
    throw new Error(`Built app missing: ${DIST_DIR}/index.html. Run \`npm run build\` first.`);
  }
  server = await startServer({ root: DIST_DIR, quiet: true });
  browser = await launch({ width: VIEWPORT.width, height: VIEWPORT.height, commandTimeoutMs: 240000 });
  report.chrome = browser.browserVersion;
  log(`chrome ${browser.browserVersion}, serving ${server.url}`);

  await browser.setViewport(VIEWPORT.width, VIEWPORT.height, { deviceScaleFactor: 1 });
  await browser.navigate(`${server.url}/`);
  await browser.waitFor('Boolean(window.__NEON__ && window.__NEON__.version)', 25000, 'window.__NEON__');
  check('debug API available', true, `version ${await browser.evaluate('window.__NEON__.version')}`);
  await browser.waitForFrames(3, 90000);

  /* ---------------------------------------------------------- (a) determinism -- */
  log('--- determinism ---');
  const detScript = `(${detRun.toString()})()`;
  const detA = await browser.evaluate(detScript, { timeoutMs: 120000 });
  const detB = await browser.evaluate(detScript, { timeoutMs: 120000 });
  const detIdentical = JSON.stringify(detA) === JSON.stringify(detB);
  report.determinism = {
    samplesPerRun: detA.count,
    identicalSamples: JSON.stringify(detA.samples) === JSON.stringify(detB.samples),
    identicalFinal: detA.final === detB.final,
    finalA: detA.final,
    finalB: detB.final,
  };
  check(
    'determinism: two identical scripted runs produce identical state() samples',
    report.determinism.identicalSamples && detA.count > 30,
    `samples/run=${detA.count}`,
  );
  check(
    'determinism: identical final state()/standings outcome',
    report.determinism.identicalFinal,
    detA.final === detB.final ? null : 'final snapshots differ',
  );

  /* ---------------------------------------------------------- (d) responsive -- */
  log('--- responsive ---');
  const responsiveRace = await startApiRace(browser, {
    seed: 20261018, style: 'circuit', laps: 2, opponents: 3, difficulty: 'normal', carClass: 'balanced',
  });
  await browser.evaluate('window.__NEON__.press(null); window.__NEON__.tick(4.2); window.__NEON__.press({ throttle: 1, brake: 0, steer: 0.12, handbrake: false }); window.__NEON__.tick(2.5);');
  await browser.waitForFrames(3, 90000);
  const desktopShot = await shot(browser, '07-responsive-1600x900', report);
  const desktopProblems = validateShot(desktopShot);
  check('responsive: 1600x900 racing screenshot valid', desktopProblems.length === 0, desktopProblems.join('; ') || null);
  check(
    'responsive: 1600x900 viewport exact',
    desktopShot.png?.width === 1600 && desktopShot.png?.height === 900,
    `${desktopShot.png?.width}x${desktopShot.png?.height}`,
  );

  // Mobile: boot a FRESH page at 390x844 with touch emulation so touch-device
  // detection runs at boot (input.ts probes (pointer: coarse) in createInput) —
  // this is what a real phone sees, including the on-screen touch controls.
  const mobileViewport = await browser.setViewport(390, 844, { deviceScaleFactor: 1, mobile: true, touch: true });
  await browser.navigate(`${server.url}/`);
  await browser.waitFor('Boolean(window.__NEON__ && window.__NEON__.version)', 25000, 'mobile boot __NEON__');
  await browser.waitForFrames(10, 90000);
  const mobileMenuVisible = await isScreenVisible(browser, '[data-testid="menu"]');
  const mobileMenuShot = await shot(browser, '09-responsive-390x844-menu', report, { viewport: mobileViewport });
  const mobileMenuProblems = validateShot(mobileMenuShot);
  const mobileDocument = await browser.evaluate(`({
    innerWidth,
    innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    coarsePointer: matchMedia('(pointer: coarse)').matches,
    touchButtons: document.querySelectorAll('.touch-btn').length,
    touchTestids: [...document.querySelectorAll('[data-testid^="touch-"]')].map((el) => el.getAttribute('data-testid')),
  })`);
  check('responsive: 390x844 menu screenshot valid', mobileMenuProblems.length === 0, mobileMenuProblems.join('; ') || null);
  check('responsive: 390x844 menu visible after fresh mobile boot', mobileMenuVisible);
  check(
    'responsive: on-screen touch controls created on a touch device',
    mobileDocument.touchButtons > 3,
    `touch buttons=${mobileDocument.touchButtons} testids=${JSON.stringify(mobileDocument.touchTestids)}`,
  );
  check(
    'responsive: no horizontal overflow at 390x844',
    mobileDocument.scrollWidth <= mobileDocument.innerWidth + 1,
    `scrollWidth=${mobileDocument.scrollWidth} viewport=${mobileDocument.innerWidth}`,
  );
  warn('responsive: coarse pointer emulation', `matchMedia('(pointer: coarse)') = ${mobileDocument.coarsePointer}`);

  // Mobile racing screenshot: start through the real UI button at mobile size.
  await browser.clickSelector('[data-testid="start-race"]');
  await browser.waitFor('window.__NEON__.state() !== null', 10000, 'mobile race state');
  await browser.evaluate('window.__NEON__.tick(4.2); window.__NEON__.press({ throttle: 1, brake: 0, steer: 0.12, handbrake: false }); window.__NEON__.tick(2.5);');
  await browser.waitForFrames(3, 90000);
  const mobileRaceShot = await shot(browser, '08-responsive-390x844-racing', report, { viewport: mobileViewport });
  const mobileProblems = validateShot(mobileRaceShot);
  const mobileRaceCanvas = mobileRaceShot.canvas ?? {};
  check(
    'responsive: 390x844 racing screenshot valid',
    mobileProblems.length === 0 &&
      mobileRaceCanvas.cssWidth <= 390 &&
      mobileRaceCanvas.cssWidth > 300 &&
      mobileRaceCanvas.cssHeight > 700,
    `${mobileProblems.join('; ') || 'ok'}; canvas css ${mobileRaceCanvas.cssWidth}x${mobileRaceCanvas.cssHeight}`,
  );
  report.responsive = {
    desktop: { png: desktopShot.png, canvas: desktopShot.canvas },
    mobile: {
      viewport: mobileDocument,
      menuPng: mobileMenuShot.png,
      racingPng: mobileRaceShot.png,
      canvas: mobileRaceShot.canvas,
    },
  };

  // Restore a fresh desktop page so the robustness phase starts from the menu.
  await browser.clearViewport();
  await browser.setViewport(VIEWPORT.width, VIEWPORT.height, { deviceScaleFactor: 1 });
  await browser.navigate(`${server.url}/`);
  await browser.waitFor('Boolean(window.__NEON__ && window.__NEON__.version)', 25000, 'desktop reboot __NEON__');
  await browser.waitForFrames(10, 90000);
  const menuAfterMobile = await isScreenVisible(browser, '[data-testid="menu"]');
  const restoredViewport = await browser.evaluate('({ width: innerWidth, height: innerHeight })');
  check(
    'responsive: desktop viewport restored (1600x900), menu visible',
    menuAfterMobile && restoredViewport.width === 1600 && restoredViewport.height === 900,
    `viewport=${restoredViewport.width}x${restoredViewport.height} menu=${menuAfterMobile}`,
  );

  /* ---------------------------------------------------------- (b) robustness -- */
  log('--- robustness: start / pause / resume / restart / quit / start again ---');
  const robustness = report.robustness;

  await browser.clickSelector('[data-testid="start-race"]');
  await browser.waitFor('window.__NEON__.state() !== null', 10000, 'race state after UI start');
  await browser.evaluate('window.__NEON__.tick(4.2); window.__NEON__.press({ throttle: 1, brake: 0, steer: 0.1, handbrake: false }); window.__NEON__.tick(2);');
  await browser.waitForFrames(3, 90000);
  let robustnessState = await browser.evaluate('window.__NEON__.state()');
  const startedViaUi = Boolean(robustnessState);
  check('robustness: race starts from the real UI button', startedViaUi, robustnessState ? `phase=${robustnessState.phase}` : 'state() null');

  // --- pause
  const pauseVisible = await pauseRun(browser);
  const pausedTimeBefore = (await browser.evaluate('window.__NEON__.state()'))?.time ?? -1;
  await browser.evaluate('window.__NEON__.tick(1)');
  const pausedTimeAfter = (await browser.evaluate('window.__NEON__.state()'))?.time ?? -2;
  await browser.waitForFrames(2, 90000);
  const pauseShot = await shot(browser, '10-pause', report);
  const pauseProblems = validateShot(pauseShot);
  robustness.push({ action: 'pause', overlayVisible: pauseVisible, timeBefore: pausedTimeBefore, timeAfter: pausedTimeAfter });
  check('robustness: pause overlay visible', pauseVisible);
  check(
    'robustness: paused simulation is frozen (tick(1) advances nothing)',
    Math.abs(pausedTimeAfter - pausedTimeBefore) < 1e-9,
    `time ${pausedTimeBefore} -> ${pausedTimeAfter}`,
  );
  check('robustness: pause screenshot valid', pauseProblems.length === 0, pauseProblems.join('; ') || null);

  // --- resume (real button)
  await browser.clickSelector('[data-testid="pause-resume"]');
  await browser.waitForFrames(3, 90000);
  const resumeOverlayHidden = !(await isScreenVisible(browser, '[data-testid="pause-overlay"]'));
  const resumeTimeBefore = (await browser.evaluate('window.__NEON__.state()'))?.time ?? -1;
  await browser.evaluate('window.__NEON__.tick(0.5)');
  const resumeTimeAfter = (await browser.evaluate('window.__NEON__.state()'))?.time ?? -2;
  await browser.waitForFrames(2, 90000);
  const resumeShot = await shot(browser, '11-resumed', report);
  const resumeProblems = validateShot(resumeShot);
  robustness.push({ action: 'resume', overlayHidden: resumeOverlayHidden, timeBefore: resumeTimeBefore, timeAfter: resumeTimeAfter });
  check('robustness: pause overlay hidden after RESUME', resumeOverlayHidden);
  check(
    'robustness: simulation advances after resume',
    resumeTimeAfter > resumeTimeBefore + 0.2,
    `time ${resumeTimeBefore} -> ${resumeTimeAfter}`,
  );
  check('robustness: resume screenshot valid', resumeProblems.length === 0, resumeProblems.join('; ') || null);

  // --- restart mid-race (keyboard R)
  await browser.pressKey('KeyR');
  await browser.waitForFrames(4, 90000);
  await browser.waitFor('window.__NEON__.state() !== null && window.__NEON__.state().phase === "countdown"', 8000, 'restart countdown').catch(() => {});
  const restartedState = await browser.evaluate('window.__NEON__.state()');
  const restartedShot = await shot(browser, '12-restarted', report);
  const restartedProblems = validateShot(restartedShot);
  robustness.push({ action: 'restart', phase: restartedState?.phase, time: restartedState?.time });
  check(
    'robustness: restart mid-race resets to countdown',
    restartedState?.phase === 'countdown' && (restartedState?.time ?? 99) < 1,
    `phase=${restartedState?.phase} time=${restartedState?.time}`,
  );
  check('robustness: restart screenshot valid', restartedProblems.length === 0, restartedProblems.join('; ') || null);

  // --- quit to menu, then start again from the menu
  await browser.evaluate('window.__NEON__.tick(4.2); window.__NEON__.press({ throttle: 1, brake: 0, steer: 0.1, handbrake: false }); window.__NEON__.tick(1.2);');
  const pausedForQuit = await pauseRun(browser);
  await browser.clickSelector('[data-testid="pause-quit"]');
  await browser.waitForFrames(4, 90000);
  const quitStateNull = await browser.evaluate('window.__NEON__.state() === null');
  const quitMenuVisible = await isScreenVisible(browser, '[data-testid="menu"]');
  const quitShot = await shot(browser, '13-quit-menu', report);
  const quitProblems = validateShot(quitShot);
  robustness.push({ action: 'quit', pausedForQuit, stateNull: quitStateNull, menuVisible: quitMenuVisible });
  check('robustness: quit clears the race and shows the menu', quitStateNull && quitMenuVisible, `stateNull=${quitStateNull} menu=${quitMenuVisible}`);
  check('robustness: quit screenshot valid', quitProblems.length === 0, quitProblems.join('; ') || null);

  // --- start again from the menu
  await browser.clickSelector('[data-testid="start-race"]');
  await browser.waitFor('window.__NEON__.state() !== null', 10000, 'race after restarting from menu');
  await browser.evaluate('window.__NEON__.tick(4.2); window.__NEON__.press({ throttle: 1, brake: 0, steer: 0, handbrake: false }); window.__NEON__.tick(1.5);');
  await browser.waitForFrames(3, 90000);
  const againState = await browser.evaluate('window.__NEON__.state()');
  const againShot = await shot(browser, '14-started-again', report);
  const againProblems = validateShot(againShot);
  robustness.push({ action: 'start-again', phase: againState?.phase, speed: againState?.speed });
  check(
    'robustness: race starts again after quit',
    Boolean(againState) && (againState.phase === 'racing' || againState.phase === 'countdown'),
    `phase=${againState?.phase}`,
  );
  check('robustness: start-again screenshot valid', againProblems.length === 0, againProblems.join('; ') || null);

  /* ------------------------------------------------------------- (c) NaN hunt -- */
  log('--- NaN hunt (30 s @120 Hz + per-frame state polling) ---');
  const nanSync = await browser.evaluate(`(${nanHunt.toString()})()`, { timeoutMs: 180000 });
  report.nanHunt = { sync: { ...nanSync, bad: undefined, badCount: nanSync.bad.length }, syncBad: nanSync.bad.slice(0, 10) };
  check(
    'NaN hunt: 30 s of racing at 120 Hz produces no NaN/Infinity in state() or racer state',
    nanSync.bad.length === 0 && !nanSync.hudHasNaN,
    nanSync.bad.slice(0, 6).join(' | ') || (nanSync.hudHasNaN ? 'HUD text contains NaN/Infinity' : null),
  );
  check(
    'NaN hunt: driving actually happened (speed/drift/off-road)',
    nanSync.maxSpeed > 100 && (nanSync.driftSeen || nanSync.boostSeen),
    `maxSpeed=${nanSync.maxSpeed} drift=${nanSync.driftSeen} boost=${nanSync.boostSeen} offroad=${nanSync.offroadSeen}`,
  );
  await startApiRace(browser, { seed: 888, style: 'circuit', laps: 5, opponents: 2, difficulty: 'normal' });
  await browser.evaluate('window.__NEON__.press(null); window.__NEON__.tick(4.2); window.__NEON__.press({ throttle: 0.7, brake: 0, steer: 0.15, handbrake: false });');
  // A fresh race generates a new track whose first frame includes the one-time
  // offscreen track pre-render (multi-second under SwiftShader). Warm up first so
  // the measurement window contains steady-state frames only.
  await browser.waitForFrames(12, 90000);
  const nanRaf = await browser.evaluate(`(${rafStatePoll.toString()})(3)`, { timeoutMs: 60000 });
  report.nanHunt.raf = { frames: nanRaf.frames, bad: nanRaf.bad };
  check(
    'NaN hunt: per-rAF state() polling is finite',
    nanRaf.bad.length === 0 && nanRaf.frames > 10,
    nanRaf.bad.slice(0, 6).join(' | ') || `frames=${nanRaf.frames}`,
  );

  /* -------------------------------------------------------------- (e) perf -- */
  log('--- performance (3 s rAF frame times at 1600x900, 10 cars) ---');
  await startApiRace(browser, {
    seed: 20261018, style: 'circuit', laps: 3, opponents: 9, difficulty: 'hard', carClass: 'speedster',
  });
  await browser.evaluate('window.__NEON__.press(null); window.__NEON__.tick(4.2); window.__NEON__.press({ throttle: 0.75, brake: 0, steer: 0.12, handbrake: false });');
  // Warm up past the one-time track pre-render / first-composite stall, then
  // sample steady-state frames for 3 s (same methodology as any profiling run).
  await browser.waitForFrames(15, 90000);
  const hudFpsText = await browser.evaluate(`document.querySelector('[data-testid="hud-fps"]')?.textContent ?? null`);
  await browser.send('Performance.enable').catch(() => {});
  const metricsOf = (response) => {
    const map = {};
    for (const entry of response.metrics ?? []) map[entry.name] = entry.value;
    return map;
  };
  const beforeMetrics = metricsOf(await browser.send('Performance.getMetrics').catch(() => ({ metrics: [] })));
  const frameTimes = await browser.evaluate(`(${rafSampler.toString()})(3)`, { timeoutMs: 60000 });
  const afterMetrics = metricsOf(await browser.send('Performance.getMetrics').catch(() => ({ metrics: [] })));
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const total = frameTimes.reduce((sum, value) => sum + value, 0);
  const meanInterval = total / Math.max(1, frameTimes.length);
  const taskDelta = (afterMetrics.TaskDuration ?? 0) - (beforeMetrics.TaskDuration ?? 0);
  const scriptDelta = (afterMetrics.ScriptDuration ?? 0) - (beforeMetrics.ScriptDuration ?? 0);
  const layoutDelta = (afterMetrics.LayoutDuration ?? 0) - (beforeMetrics.LayoutDuration ?? 0);
  const frameCount = frameTimes.length;
  const mainThreadMsPerFrame = (taskDelta / Math.max(1, frameCount)) * 1000;
  report.perf = {
    viewport: VIEWPORT,
    racers: 10,
    sampleSeconds: 3,
    frames: frameCount,
    meanIntervalMs: +meanInterval.toFixed(2),
    p50Ms: +percentile(sorted, 50).toFixed(2),
    p95Ms: +percentile(sorted, 95).toFixed(2),
    maxMs: +sorted[sorted.length - 1]?.toFixed?.(2),
    minMs: +sorted[0]?.toFixed?.(2),
    fps: +(1000 / meanInterval).toFixed(1),
    hudFpsText,
    mainThreadMsPerFrame: +mainThreadMsPerFrame.toFixed(2),
    scriptMsPerFrame: +((scriptDelta / Math.max(1, frameCount)) * 1000).toFixed(2),
    layoutMsPerFrame: +((layoutDelta / Math.max(1, frameCount)) * 1000).toFixed(2),
    flagMeanOver22ms: meanInterval > 22,
    compositorBound: meanInterval > 22 && mainThreadMsPerFrame <= 8,
  };
  check('perf: rAF sampler collected frames', frameCount > 30, `frames=${frameCount}`);
  // Acceptance criterion: report mean/p95 and FLAG mean > 22 ms. The rAF interval
  // in headless Chrome is compositor-bound (SwiftShader software raster), so the
  // actionable game-side number is main-thread TaskDuration per frame against the
  // 60 fps budget (16.7 ms).
  check(
    'perf: main-thread cost per frame within the 60 fps budget (<= 16.7 ms)',
    mainThreadMsPerFrame <= 16.7,
    `mainThread=${mainThreadMsPerFrame.toFixed(2)} ms/frame (script=${report.perf.scriptMsPerFrame}, layout=${report.perf.layoutMsPerFrame})`,
  );
  if (mainThreadMsPerFrame > 8) {
    warn(
      'perf: main-thread cost above render-dev measured draw budget',
      `${mainThreadMsPerFrame.toFixed(2)} ms/frame total main-thread (render-dev measured draw() at 4.0-4.75 ms; remainder is sim+HUD+audio+GC)`,
    );
  }
  if (report.perf.flagMeanOver22ms) {
    warn(
      'perf: rAF interval mean > 22 ms',
      `mean=${report.perf.meanIntervalMs} ms p95=${report.perf.p95Ms} ms mainThread=${report.perf.mainThreadMsPerFrame} ms/frame` +
        (report.perf.compositorBound ? ' → compositor-bound (headless SwiftShader software raster), not a game-logic defect' : ' → investigate'),
    );
  } else {
    check('perf: rAF interval mean <= 22 ms', true, `mean=${report.perf.meanIntervalMs} ms p95=${report.perf.p95Ms} ms`);
  }
  const perfShot = await shot(browser, '15-perf-racing', report);
  check('perf: racing screenshot during perf run valid', validateShot(perfShot).length === 0, validateShot(perfShot).join('; ') || null);

  /* ---------------------------------------------------------- (f) wrong-way -- */
  log('--- wrong-way ---');
  const wrongWay = await browser.evaluate(`(${wrongWayProbe.toString()})()`, { timeoutMs: 120000 });
  await browser.waitForFrames(3, 90000);
  const wrongWayHud = await browser.evaluate(`(() => {
    const el = document.querySelector('[data-testid="hud-wrong-way"]');
    if (!el) return { exists: false };
    const cs = getComputedStyle(el);
    return {
      exists: true,
      isOn: el.classList.contains('is-on'),
      hidden: el.hidden,
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      text: (el.textContent ?? '').trim(),
    };
  })()`);
  const wrongWayShot = await shot(browser, '16-wrong-way', report, { probe: wrongWay.attempts, hud: wrongWayHud });
  report.wrongWay = wrongWay;
  report.wrongWay.hudAfterFrames = wrongWayHud;
  check(
    'wrong-way: driving against the track sets racer.wrongWay',
    wrongWay.wrongWaySeen === true,
    `method=${wrongWay.method} attempts=${JSON.stringify(wrongWay.attempts)}`,
  );
  check(
    'wrong-way: HUD warning indicator turns on',
    wrongWayHud.exists && wrongWayHud.isOn === true && wrongWayHud.hidden === false,
    `hud-wrong-way ${JSON.stringify(wrongWayHud)}`,
  );
  check('wrong-way: screenshot valid', validateShot(wrongWayShot).length === 0, validateShot(wrongWayShot).join('; ') || null);

  /* ------------------------------------------------------------ screenshots -- */
  for (const entry of report.screens) {
    const problems = validateShot(entry);
    check(`${entry.name}.png valid (>20 KB, non-blank, valid PNG)`, problems.length === 0, problems.join('; ') || null);
  }

  /* ---------------------------------------------------------------- console -- */
  const logs = browser.logs();
  const fatal = [];
  for (const text of logs.pageErrors) fatal.push(`[pageerror] ${text}`);
  for (const text of logs.console.filter((entry) => entry.type === 'error' || entry.type === 'assert')) {
    fatal.push(`[console.${text.type}] ${text.text}`);
  }
  for (const text of logs.network.filter((entry) => !entry.canceled)) fatal.push(`[network] ${text.errorText} → ${text.url}`);
  for (const text of logs.httpErrors) fatal.push(`[http ${text.status}] ${text.url}`);
  report.console = {
    consoleErrors: logs.console.filter((entry) => entry.type === 'error' || entry.type === 'assert'),
    pageErrors: logs.pageErrors,
    networkErrors: logs.network,
    httpErrors: logs.httpErrors,
    logEntries: logs.logEntries.slice(-20),
    fatal,
  };
  check('console/page/network clean for the whole adversarial run', fatal.length === 0, fatal.slice(0, 6).join(' | ') || null);
} catch (error) {
  failures.push(`harness exception: ${error.message}`);
  log('FATAL:', error.stack ?? error.message);
  report.error = error.message;
} finally {
  try {
    if (browser) {
      const logs = browser.logs();
      if (!report.console) {
        report.console = {
          consoleErrors: logs.console.filter((entry) => entry.type === 'error' || entry.type === 'assert'),
          pageErrors: logs.pageErrors,
          networkErrors: logs.network,
          httpErrors: logs.httpErrors,
          logEntries: logs.logEntries.slice(-20),
        };
      }
      report.chromeLog = browser.chromeLog().slice(-3000);
      await browser.close();
    }
  } catch (error) {
    log('cleanup error:', error.message);
  }
  try {
    if (server) await server.close();
  } catch (error) {
    log('server cleanup error:', error.message);
  }
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  report.checks = checks;
  report.failures = failures;
  report.ok = failures.length === 0;
  try {
    await writeFile(path.join(OUT_DIR, 'adversarial.json'), JSON.stringify(report, null, 2));
  } catch (error) {
    log('could not write artifacts/adversarial.json:', error.message);
  }
  console.log(
    JSON.stringify({
      ok: report.ok,
      durationMs: report.durationMs,
      determinism: report.determinism,
      perf: report.perf,
      nanHunt: report.nanHunt,
      wrongWay: report.wrongWay,
      responsive: report.responsive,
      screens: report.screens.map((entry) => ({ name: entry.name, file: entry.file, bytes: entry.bytes, png: entry.png })),
      checks: report.checks.map((entry) => ({ name: entry.name, pass: entry.pass, detail: entry.detail })),
      failures: report.failures,
    }),
  );
  process.exit(report.ok ? 0 : 1);
}
