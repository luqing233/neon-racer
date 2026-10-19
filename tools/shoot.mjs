#!/usr/bin/env node
/**
 * shoot.mjs — end-to-end scripted verification run for Neon Racer.
 *
 * What it does:
 *  1. serves the BUILT dist/ directory on 127.0.0.1 (zero deps),
 *  2. launches Windows Chrome headless and drives it over CDP (tools/cdp.mjs),
 *  3. captures the six required screenshots into artifacts/,
 *  4. drives a full 1-lap race through window.__NEON__ and samples the state,
 *  5. writes artifacts/report.json and prints a single JSON summary on stdout.
 *
 * Exit code: 0 only when every screenshot exists, the canvas is not a blank
 * frame, the 1-lap race actually finished, and no page/console/network error was
 * logged. `--smoke` only checks menu boot + rendering (used as harness self-test).
 *
 * Usage: node tools/shoot.mjs [--smoke] [--out artifacts] [--width 1600] [--height 900]
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findChrome, launch, PROJECT_ROOT } from './cdp.mjs';
import { startServer } from './static-server.mjs';

/* ------------------------------------------------------------- arguments -- */

function parseArgs(argv) {
  const args = { smoke: false, out: 'artifacts', width: 1600, height: 900 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--smoke') args.smoke = true;
    else if (arg === '--out') args.out = argv[++i] ?? args.out;
    else if (arg === '--width') args.width = Number(argv[++i] ?? args.width);
    else if (arg === '--height') args.height = Number(argv[++i] ?? args.height);
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node tools/shoot.mjs [--smoke] [--out artifacts] [--width 1600] [--height 900]');
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const OUT_DIR = path.resolve(PROJECT_ROOT, args.out);
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const REQUIRED_SCREENS = [
  '01-menu',
  '02-countdown',
  '03-racing',
  '04-drift-or-boost',
  '05-hud-closeup',
  '06-results',
];
const BENIGN_LOG_PATTERNS = [/favicon/i];

const log = (...parts) => console.error('[shoot]', ...parts);
const failures = [];
const checks = [];
function check(name, pass, detail = null, { optional = false } = {}) {
  checks.push({ name, pass: Boolean(pass), detail, optional });
  if (!pass && !optional) failures.push(detail ? `${name}: ${detail}` : name);
  const label = pass ? 'PASS' : optional ? 'WARN' : 'FAIL';
  log(`${label}  ${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(pass);
}

/* ------------------------------------------------------------- page hacks -- */

/**
 * Installed in the page: pure-pursuit auto-driver over the public debug API.
 *
 * Controller ported from tests/lead/acceptance.test.ts (lead-proven: 9/9
 * seed x style tracks, 100% lap completion, 0 s stuck). It uses track.query()
 * for the current arc length, aims at the precomputed racingLine with a
 * speed-dependent lookahead, and derives a corner speed from the tightest
 * radius inside the braking window.
 */
function installDriver() {
  const api = window.__NEON__;
  const race = window.__RACE__;
  if (!race) throw new Error('installDriver: window.__RACE__ missing — call __NEON__.startRace() first');

  // PHYSICS.subStep from the frozen config (src/game/config.ts). Driving the
  // simulation one fixed substep at a time makes the browser run equivalent to
  // the pure-sim probe in tests/lead/acceptance.test.ts.
  const SUB = 1 / 120;

  const track = race.track;
  const player = race.player;

  let steerSign = 1;
  let maxSpeed = 0;
  let nanSeen = false;
  let driftSeen = false;
  let boostSeen = false;
  let wrongWaySeen = false;
  let simTime = 0;
  let steps = 0;
  let samples = [];
  let lastInput = null;
  let stuckTime = 0;
  let recoverUntil = 0;

  const wrap = (a) => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  };
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function scan() {
    const car = player.car;
    const values = [
      car.pos.x, car.pos.y, car.angle, car.vel.x, car.vel.y, car.speed,
      car.forwardSpeed, car.angularVel, car.slip, car.steer, car.driftTime,
      car.driftCharge, car.boostTime, car.engineRpm, car.gear, car.crashCooldown,
      player.progress.s, player.progress.lateral, player.progress.totalS,
      player.lap, player.place, player.totalTime, player.penalty,
    ];
    for (const value of values) if (!finite(value)) nanSeen = true;
    if (player.wrongWay) wrongWaySeen = true;
    if (car.drifting) driftSeen = true;
    if (car.boostTime > 0) boostSeen = true;
    if (car.speed > maxSpeed) maxSpeed = car.speed;
  }

  /** Pure-pursuit controller (lead-proven logic). */
  function controllerInput() {
    const car = player.car;
    const q = track.query(car.pos);

    // Aim a speed-dependent distance ahead on the racing line.
    const lookahead = Math.max(150, Math.min(430, car.speed * 0.62));
    const targetS = (((q.s + lookahead) % track.length) + track.length) % track.length;
    const targetIndex = Math.floor(targetS / track.step) % track.racingLine.length;
    const target = track.racingLine[targetIndex] ?? track.posAt(targetS);
    const desired = Math.atan2(target.y - car.pos.y, target.x - car.pos.x);
    const err = wrap(desired - car.angle);

    // Corner speed from the tightest radius within the braking window.
    let radius = Infinity;
    for (let ahead = 40; ahead < 520; ahead += 40) {
      const sample = track.at(q.s + ahead);
      if (Math.abs(sample.curvature) > 1e-6) radius = Math.min(radius, Math.abs(1 / sample.curvature));
    }
    const vTarget = Math.min(player.spec.topSpeed * 0.92, Math.sqrt(900 * Math.max(radius, 60)));

    let input = {
      throttle: car.speed < vTarget ? 1 : 0,
      brake: car.speed > vTarget * 1.12 ? 0.85 : 0,
      steer: clamp(err * 1.9, -1, 1) * steerSign,
      handbrake: false,
    };

    // Recover from a wall scrape / spin: reverse out briefly, then rejoin.
    if (race.phase === 'racing' && car.speed < 20) {
      stuckTime += SUB;
      if (stuckTime > 1.5 && simTime >= recoverUntil) recoverUntil = simTime + 1.0;
    } else {
      stuckTime = 0;
    }
    if (simTime < recoverUntil) {
      input = { throttle: 0, brake: 1, steer: -clamp(err * 1.9, -1, 1) * steerSign, handbrake: false };
    }
    return input;
  }

  function step(inputOverride) {
    let input = inputOverride ? { ...inputOverride } : controllerInput();
    input.steer = clamp(input.steer ?? 0, -1, 1);
    input.throttle = clamp(input.throttle ?? 0, 0, 1);
    input.brake = clamp(input.brake ?? 0, 0, 1);
    input.handbrake = Boolean(input.handbrake);
    lastInput = input;
    api.press(input);
    api.tick(SUB, SUB);
    steps += 1;
    simTime += SUB;
    scan();
    return input;
  }

  function sample() {
    samples.push({
      t: +race.time.toFixed(2),
      speed: +player.car.speed.toFixed(1),
      lap: player.lap,
      place: player.place,
      s: +player.progress.s.toFixed(1),
      lateral: +player.progress.lateral.toFixed(1),
      drifting: player.car.drifting,
      boost: +player.car.boostTime.toFixed(2),
    });
    if (samples.length > 400) samples = samples.slice(-400);
  }

  function snapshot() {
    return {
      phase: race.phase,
      countdown: +race.countdown.toFixed(2),
      time: +race.time.toFixed(2),
      lap: player.lap,
      laps: race.config.laps,
      speed: +player.car.speed.toFixed(1),
      place: player.place,
      finished: player.finished,
      finishTime: player.finishTime,
      bestLap: player.bestLap,
      lapTimes: player.lapTimes.slice(),
      drifting: player.car.drifting,
      boostTime: +player.car.boostTime.toFixed(2),
      wrongWay: player.wrongWay,
      s: +player.progress.s.toFixed(1),
      trackLength: +track.length.toFixed(1),
      racers: race.racers.length,
      flags: {
        driftSeen, boostSeen, wrongWaySeen, nanSeen,
        maxSpeed: +maxSpeed.toFixed(1), simTime: +simTime.toFixed(2), steps,
        steerSign, lastInput,
      },
    };
  }

  window.__DRIVER__ = {
    snapshot,
    state() {
      return { steerSign, simTime, steps, nanSeen, driftSeen, boostSeen, wrongWaySeen, maxSpeed, samples };
    },
    /** Learn the steer sign convention from the real physics (positive steer -> +angle?). */
    calibrateSteer() {
      const before = player.car.angle;
      for (let i = 0; i < 90; i++) step({ throttle: 1, brake: 0, steer: 1, handbrake: false });
      const delta = wrap(player.car.angle - before);
      if (Math.abs(delta) > 1e-5) steerSign = delta > 0 ? 1 : -1;
      for (let i = 0; i < 12; i++) step({ throttle: 0.4, brake: 0, steer: 0, handbrake: false });
      stuckTime = 0;
      recoverUntil = 0;
      return { steerSign, delta: +delta.toFixed(4) };
    },
    /** Drive with the controller for `seconds` of simulated time. */
    run(seconds) {
      const total = Math.max(1, Math.round(seconds / SUB));
      for (let i = 0; i < total; i++) {
        if (race.phase === 'finished') break;
        step(null);
        if (i % 60 === 0) sample();
      }
      return snapshot();
    },
    /** Drive until the car reaches `targetSpeed` (or timeout / finish). */
    runUntilSpeed(targetSpeed, maxSeconds = 25) {
      const total = Math.max(1, Math.round(maxSeconds / SUB));
      for (let i = 0; i < total; i++) {
        if (race.phase === 'finished') break;
        step(null);
        if (i % 30 === 0) sample();
        if (player.car.speed >= targetSpeed) break;
      }
      return snapshot();
    },
    /** Drive until the car is back on the racing surface at racing speed. */
    runUntilClean(maxSeconds = 20) {
      const total = Math.max(1, Math.round(maxSeconds / SUB));
      for (let i = 0; i < total; i++) {
        if (race.phase === 'finished') break;
        step(null);
        if (i % 30 === 0) sample();
        if (player.car.speed >= player.spec.topSpeed * 0.5 && player.progress.onRoad) break;
      }
      return snapshot();
    },
    /** Drive flat out with a handbrake flick until a drift / boost is detected. */
    driftAttempt(maxSeconds = 10) {
      const total = Math.max(1, Math.round(maxSeconds / SUB));
      for (let i = 0; i < total; i++) {
        if (race.phase === 'finished') break;
        const speed = player.car.speed;
        const input =
          speed < player.spec.topSpeed * 0.5
            ? controllerInput()
            : { throttle: 1, brake: 0, steer: 0.9 * steerSign, handbrake: true };
        step(input);
        if (i % 12 === 0) sample();
        if (driftSeen || boostSeen) return { detected: true, snapshot: snapshot() };
      }
      return { detected: false, snapshot: snapshot() };
    },
    /** Drive until the race genuinely finishes (or return after `maxSeconds`). */
    untilFinished(maxSeconds = 180) {
      const total = Math.max(1, Math.round(maxSeconds / SUB));
      for (let i = 0; i < total; i++) {
        if (race.phase === 'finished') break;
        step(null);
        if (i % 60 === 0) sample();
      }
      return { finished: race.phase === 'finished', snapshot: snapshot() };
    },
    /** Hold an explicit input for a while (used to provoke wrong-way etc.). */
    force(seconds, input) {
      const total = Math.max(1, Math.round(seconds / SUB));
      for (let i = 0; i < total; i++) {
        if (race.phase === 'finished') break;
        step(input);
        if (i % 60 === 0) sample();
      }
      return snapshot();
    },
    /** Take the final sample series out of the page (full history). */
    takeSamples() {
      const all = samples.slice();
      samples = [];
      return all;
    },
  };
  return { ok: true, snapshot: snapshot() };
}

/** Canvas pixel statistics — proves the frame is not a blank/black render. */
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
    sampleCount: count,
    meanLuminance: +mean.toFixed(2),
    stddevLuminance: +Math.sqrt(variance).toFixed(2),
    nonDarkFraction: +(nonDark / count).toFixed(4),
    distinctColors: colors.size,
  };
}

/** DOM snapshot: which screens/testids are live and what text is readable. */
function domStats() {
  const testids = [...document.querySelectorAll('[data-testid]')].map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      id: el.getAttribute('data-testid'),
      visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden',
      text: (el.textContent ?? '').trim().slice(0, 80),
    };
  });
  return {
    title: document.title,
    testids,
    startButton: Boolean(document.querySelector('[data-testid="start-race"]')),
    bodyText: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
    bodyTextLength: (document.body.innerText ?? '').trim().length,
    canvasCount: document.querySelectorAll('canvas').length,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
  };
}

/* ---------------------------------------------------------------- helpers -- */

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function gather(browser) {
  const dom = await browser.evaluate(`(${domStats.toString()})()`);
  const canvas = await browser.evaluate(`(${canvasStats.toString()})()`);
  return { dom, canvas };
}

async function takeShot(browser, name, report, extra = {}) {
  const filePath = path.join(OUT_DIR, `${name}.png`);
  const result = await browser.screenshot(filePath);
  const buffer = await readFile(filePath);
  const size = pngSize(buffer);
  const stats = await gather(browser);
  const shot = {
    name,
    file: path.relative(PROJECT_ROOT, filePath).split(path.sep).join('/'),
    bytes: result.bytes,
    png: size,
    canvas: stats.canvas,
    dom: extra.dom ?? stats.dom,
    ...extra,
  };
  report.screens.push(shot);
  log(
    `shot ${name}.png ${result.bytes} bytes` +
      (size ? ` ${size.width}x${size.height}` : ' (not a valid PNG!)') +
      ` canvas stddev=${stats.canvas.stddevLuminance} colors=${stats.canvas.distinctColors}`,
  );
  return shot;
}

function validateShot(shot, { minBytes = 8000 } = {}) {
  const problems = [];
  if (!existsSync(path.resolve(PROJECT_ROOT, shot.file))) problems.push(`${shot.name}.png missing`);
  if (shot.bytes < minBytes) problems.push(`${shot.name}.png only ${shot.bytes} bytes (< ${minBytes})`);
  if (!shot.png) problems.push(`${shot.name}.png is not a valid PNG`);
  const canvas = shot.canvas ?? {};
  if (canvas.error) problems.push(`${shot.name} canvas: ${canvas.error}`);
  else {
    if (!(canvas.stddevLuminance >= 2.0)) problems.push(`${shot.name} canvas looks flat (stddev ${canvas.stddevLuminance})`);
    if (!(canvas.distinctColors >= 5)) problems.push(`${shot.name} canvas nearly monochrome (${canvas.distinctColors} colours)`);
  }
  return problems;
}

function collectFatalErrors(browser) {
  const errors = browser.errors();
  const fatal = [];
  for (const text of errors.pageErrors) fatal.push(text);
  for (const text of errors.consoleErrors) fatal.push(text);
  for (const text of errors.networkErrors) fatal.push(text);
  for (const text of errors.logErrors) {
    if (!BENIGN_LOG_PATTERNS.some((pattern) => pattern.test(text))) fatal.push(text);
  }
  return { ...errors, fatal };
}

/* ------------------------------------------------------------------- main -- */

let server = null;
let browser = null;
const startedAt = Date.now();
const report = {
  harness: 'tools/shoot.mjs',
  mode: args.smoke ? 'smoke' : 'full',
  startedAt: new Date().toISOString(),
  projectRoot: PROJECT_ROOT,
  chrome: null,
  baseUrl: null,
  viewport: { width: args.width, height: args.height },
  dist: null,
  screens: [],
  race: null,
  samples: [],
  dom: null,
  console: null,
  checks,
  failures,
  ok: false,
};

try {
  if (!existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error(`Built app missing: ${DIST_DIR}/index.html. Run \`npm run build\` first.`);
  }
  report.dist = {
    index: path.join(DIST_DIR, 'index.html'),
    bytes: (await readFile(path.join(DIST_DIR, 'index.html'))).length,
  };

  log(`chrome: ${findChrome()}`);
  server = await startServer({ root: DIST_DIR, quiet: true });
  report.baseUrl = `${server.url}/`;
  log(`serving ${server.root} at ${report.baseUrl}`);

  browser = await launch({
    width: args.width,
    height: args.height,
    commandTimeoutMs: 180000,
  });
  report.chrome = browser.browserVersion;
  log(`browser: ${browser.browserVersion}`);

  // Force an exact viewport so screenshots have known dimensions.
  const viewport = await browser.setViewport(args.width, args.height, { deviceScaleFactor: 1 });
  report.viewport.actual = viewport;

  await browser.navigate(`${server.url}/`);
  const booted = await browser.waitFor('Boolean(window.__NEON__ && window.__NEON__.version)', 25000, 'window.__NEON__ debug API');
  check('debug API window.__NEON__ available', Boolean(booted));
  report.apiVersion = await browser.evaluate('window.__NEON__.version');
  log(`__NEON__.version = ${report.apiVersion}`);

  await browser.waitForFrames(4, 90000);
  await new Promise((resolve) => setTimeout(resolve, 700)); // attract-mode backdrop settles

  /* ---- 01 menu ---- */
  const menu = await takeShot(browser, '01-menu', report, { state: await browser.evaluate('window.__NEON__.state()') });
  check('01-menu canvas rendered', !menu.canvas.error && menu.canvas.stddevLuminance >= 2.0, menu.canvas.error ?? `stddev=${menu.canvas.stddevLuminance}`);
  check('01-menu body text present', (report.dom = menu.dom) && menu.dom.bodyTextLength > 0, `bodyTextLength=${menu.dom.bodyTextLength}`);
  check('01-menu start control found', menu.dom.startButton, menu.dom.startButton ? null : 'no [data-testid="start-race"] (API fallback will be used)', { optional: true });

  if (args.smoke) {
    const fatal = collectFatalErrors(browser);
    report.console = { ...browser.logs(), fatal: fatal.fatal, errors: browser.errors() };
    check('console/page/network clean', fatal.fatal.length === 0, fatal.fatal.slice(0, 6).join(' | ') || null);
    report.ok = failures.length === 0;
    log(`smoke run ${report.ok ? 'OK' : 'FAILED'}`);
  } else {
    /* ---- 02 countdown: click the real start button ---- */
    let startMethod = 'data-testid';
    let clickError = null;
    if (menu.dom.startButton) {
      try {
        await browser.clickSelector('[data-testid="start-race"]');
      } catch (error) {
        clickError = error.message;
        startMethod = 'api-fallback';
      }
    } else {
      startMethod = 'api-fallback';
    }
    if (startMethod === 'api-fallback') {
      await browser.evaluate(`window.__NEON__.startRace({ laps: 3, opponents: 5, difficulty: 'normal' })`);
    }
    await browser.waitForFrames(3, 90000);
    await new Promise((resolve) => setTimeout(resolve, 120));
    let countdownState = await browser.evaluate('window.__NEON__.state()');
    if (!countdownState) {
      // The click may not have started a race at all — record and force one.
      startMethod = 'api-fallback';
      await browser.evaluate(`window.__NEON__.startRace({ laps: 3, opponents: 5, difficulty: 'normal', seed: 20261018 })`);
      countdownState = await browser.evaluate('window.__NEON__.state()');
    }
    const countdown = await takeShot(browser, '02-countdown', report, { state: countdownState, startMethod, clickError });
    check('02-countdown race started', Boolean(countdownState), countdownState ? null : 'state() returned null after start');
    check(
      '02-countdown phase visible',
      countdownState?.phase === 'countdown' || countdownState?.phase === 'racing',
      `phase=${countdownState?.phase}`,
    );

    /* ---- API race with 1 lap, driven by the in-page autopilot ---- */
    const apiRace = await browser.evaluate(`(() => {
      const race = window.__NEON__.startRace({
        seed: 20261018, style: 'circuit', laps: 1, opponents: 3,
        difficulty: 'normal', carClass: 'balanced', playerName: 'VERIFIER',
      });
      window.__RACE__ = race;
      return {
        laps: race.config.laps,
        racers: race.racers.length,
        trackName: race.track.name,
        trackLength: +race.track.length.toFixed(1),
        phase: race.phase,
      };
    })()`);
    report.race = { ...apiRace, startMethod, completed: false, driftDetected: false, boostDetected: false, resultsForced: false };
    log(`race started: ${JSON.stringify(apiRace)}`);

    await browser.evaluate(`(${installDriver.toString()})()`);

    // Tick through the countdown first (no throttle before GO), then learn the
    // steer sign convention from the real physics.
    await browser.evaluate('window.__NEON__.press(null); window.__NEON__.tick(4.2);');
    const calibration = await browser.evaluate('window.__DRIVER__.calibrateSteer()');
    log(`steer calibration: ${JSON.stringify(calibration)}`);
    await browser.waitForFrames(2, 90000);

    /* ---- 03 racing at speed ---- */
    const topSpeed = await browser.evaluate('window.__RACE__.player.spec.topSpeed');
    const fast = await browser.evaluate(`window.__DRIVER__.runUntilSpeed(${topSpeed * 0.55}, 25)`);
    await browser.waitForFrames(3, 90000);
    const racing = await takeShot(browser, '03-racing', report, { state: fast });
    check('03-racing car at speed', (fast?.speed ?? 0) > topSpeed * 0.35, `speed=${fast?.speed} topSpeed=${topSpeed}`);
    check('03-racing sequence advanced', (fast?.time ?? 0) > 1, `time=${fast?.time}`);

    /* ---- 04 drift or boost ---- */
    const drift = await browser.evaluate('window.__DRIVER__.driftAttempt(10)');
    await browser.waitForFrames(2, 90000);
    const driftShot = await takeShot(browser, '04-drift-or-boost', report, { state: drift.snapshot });
    report.race.driftDetected = Boolean(drift.snapshot?.flags?.driftSeen);
    report.race.boostDetected = Boolean(drift.snapshot?.flags?.boostSeen);
    check(
      '04 drift-or-boost shows a drift/boost',
      drift.detected === true,
      `driftSeen=${report.race.driftDetected} boostSeen=${report.race.boostDetected}`,
    );

    /* ---- 05 HUD (full 1600x900 frame) ---- */
    const hudState = await browser.evaluate('window.__DRIVER__.runUntilClean(20)');
    await browser.waitForFrames(3, 90000);
    const hud = await takeShot(browser, '05-hud-closeup', report, { state: hudState });
    const hudTestids = hud.dom.testids.filter((t) => t.id && t.id.startsWith('hud-'));
    check('05-hud HUD elements visible', hudTestids.length > 0, `hud-* testids: ${hudTestids.map((t) => t.id).join(', ') || 'none'}`);
    check('05-hud viewport is 1600x900', hud.png?.width === args.width && hud.png?.height === args.height, `png=${hud.png?.width}x${hud.png?.height}`);

    /* ---- 06 results after a genuine 1-lap drive ---- */
    const finish = await browser.evaluate('window.__DRIVER__.untilFinished(180)', { timeoutMs: 120000 });
    let forcedResults = false;
    if (!finish.finished) {
      log('WARN: autopilot did not finish the 1-lap race within 180 s of sim time — forcing the finished phase ONLY to render the results screen');
      forcedResults = true;
      await browser.evaluate(`(() => {
        const race = window.__RACE__;
        race.phase = 'finished';
        race.player.finished = true;
        race.player.lap = Math.max(race.player.lap, race.config.laps);
        if (!race.player.lapTimes.length) race.player.lapTimes.push(12.5);
        if (race.player.bestLap == null) race.player.bestLap = race.player.lapTimes[0];
        if (race.player.totalTime <= 0) race.player.totalTime = race.time;
        window.__NEON__.tick(1 / 30);
        return true;
      })()`);
    }
    report.race.completed = finish.finished;
    report.race.resultsForced = forcedResults;
    await browser.waitForFrames(3, 90000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const resultsState = await browser.evaluate('window.__NEON__.state()');
    const results = await takeShot(browser, '06-results', report, { state: resultsState });
    check('06-results race genuinely completed', finish.finished, forcedResults ? 'autopilot failed to finish — results screen was forced' : null);
    check(
      '06-results screen has readable text',
      results.dom.bodyTextLength > 0,
      `bodyTextLength=${results.dom.bodyTextLength}`,
    );
    report.race.final = finish.snapshot;

    // Numeric race assertions required by the acceptance brief.
    const standings = await browser.evaluate('window.__NEON__.standings()');
    report.race.standings = standings;
    const places = [...standings.map((entry) => entry.place)].sort((a, b) => a - b);
    const expectedPlaces = Array.from({ length: standings.length }, (_, i) => i + 1);
    check(
      'race standings places unique and contiguous 1..N',
      JSON.stringify(places) === JSON.stringify(expectedPlaces),
      `places=${JSON.stringify(places)}`,
    );
    const model = resultsState ?? finish.snapshot;
    check(
      'race state: lap completed / phase finished',
      Boolean(model && (model.phase === 'finished' || model.finished || (model.lap ?? 0) >= 1)),
      `phase=${model?.phase} lap=${model?.lap} finished=${model?.finished}`,
    );
    check(
      'race bestLap is sane (5 s .. 600 s)',
      Number.isFinite(model?.bestLap) && model.bestLap > 5 && model.bestLap < 600,
      `bestLap=${model?.bestLap}`,
    );
    const finalLapTimes = finish.snapshot?.lapTimes ?? [];
    check(
      'race lap times are sane positives',
      finalLapTimes.length > 0 && finalLapTimes.every((t) => Number.isFinite(t) && t > 5 && t < 600),
      `lapTimes=${JSON.stringify(finalLapTimes)}`,
    );

    /* ---- collect the sampled state series ---- */
    try {
      report.samples = await browser.evaluate('window.__DRIVER__.takeSamples()');
    } catch {
      report.samples = [];
    }
    report.race.flags = finish.snapshot?.flags ?? null;

    // Validate every screenshot.
    for (const shot of report.screens) {
      const problems = validateShot(shot);
      check(
        `${shot.name}.png valid (exists, >8KB, non-blank canvas)`,
        problems.length === 0,
        problems.join('; ') || null,
      );
    }

    const fatal = collectFatalErrors(browser);
    report.console = { ...browser.logs(), fatal: fatal.fatal, errors: browser.errors() };
    check('console/page/network clean', fatal.fatal.length === 0, fatal.fatal.slice(0, 6).join(' | ') || null);
  }
} catch (error) {
  failures.push(`harness exception: ${error.message}`);
  log('FATAL:', error.stack ?? error.message);
  report.error = error.message;
} finally {
  try {
    if (browser) {
      const fatal = collectFatalErrors(browser);
      report.console = { ...(report.console ?? browser.logs()), ...browser.logs(), fatal: fatal.fatal, errors: browser.errors() };
      report.chromeLog = browser.chromeLog().slice(-4000);
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
  if (!report.console) report.console = { console: [], pageErrors: [], logEntries: [], network: [], httpErrors: [], fatal: [] };
  if (!report.race && !args.smoke) report.race = { completed: false, resultsForced: false };
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  report.checks = checks;
  report.failures = failures;
  report.ok = failures.length === 0;
  try {
    await writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  } catch (error) {
    log('could not write artifacts/report.json:', error.message);
  }
  // The single machine-readable line goes to stdout; all logging is on stderr.
  console.log(JSON.stringify({
    ok: report.ok,
    mode: report.mode,
    durationMs: report.durationMs,
    screens: report.screens.map((s) => ({ name: s.name, file: s.file, bytes: s.bytes, png: s.png })),
    race: report.race,
    consoleErrors: report.console?.fatal ?? [],
    checks: report.checks.map((c) => ({ name: c.name, pass: c.pass, detail: c.detail })),
    failures: report.failures,
  }));
  process.exit(report.ok ? 0 : 1);
}
