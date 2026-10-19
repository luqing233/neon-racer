#!/usr/bin/env node
/**
 * stall-probe.mjs — independent measurement of the startRace() → first-frame window.
 *
 * Corroborates (or refutes) render-dev's diagnosis that the multi-second stall on
 * a fresh race is browser style/layout/paint/composite rather than renderer JS.
 * For every run it records:
 *   - startRace() call duration,
 *   - latency to the 1st and 2nd animation frame after startRace() returns,
 *   - when the race screen becomes visible,
 *   - PerformanceObserver longtasks inside the window,
 *   - CDP Performance.getMetrics deltas (TaskDuration / ScriptDuration /
 *     LayoutDuration / RecalcStyleDuration) across the window,
 *   - whether the canvas pixels changed (a frame actually painted).
 *
 * Usage: node tools/stall-probe.mjs [--runs 6]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launch, PROJECT_ROOT } from './cdp.mjs';
import { startServer } from './static-server.mjs';

const OUT_DIR = path.resolve(PROJECT_ROOT, 'artifacts');
const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg >= 0 ? Math.max(1, Number(process.argv[runsArg + 1]) || 6) : 6;
const log = (...parts) => console.error('[stall]', ...parts);

const SEEDS = [20261018, 888, 777, 1234, 20261018, 20261018, 20261018, 20261018];

/** One measurement, entirely inside the page (awaitPromise). */
async function measureRun(cfg) {
  {
    const t0 = performance.now();
    const race = window.__NEON__.startRace(cfg);
    window.__RACE__ = race;
    const t1 = performance.now();

    const longtasks = [];
    let longtaskError = null;
    let obs = null;
    try {
      obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longtasks.push({ start: +(entry.startTime - t1).toFixed(1), duration: +entry.duration.toFixed(1) });
      });
      obs.observe({ type: 'longtask' });
    } catch (error) {
      longtaskError = String((error && error.message) || error);
    }

    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const sample = () => Array.from(ctx.getImageData(0, 0, 4, 4).data).join(',');
    const pixelsBefore = sample();

    // NOTE: rAF callback timestamps are the *frame* time and can predate t1 when
    // startRace() itself is slow, so latency must be sampled with performance.now()
    // inside the callback, not from the callback argument.
    const rel = () => +(performance.now() - t1).toFixed(1);
    let firstRaf = null;
    let secondRaf = null;
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        firstRaf = rel();
        requestAnimationFrame(() => {
          secondRaf = rel();
          resolve();
        });
      });
    });

    let screenVisibleAt = null;
    const deadline = performance.now() + 1200;
    const screenUp = () => {
      const hud = document.querySelector('[data-testid="hud-root"]');
      const screen = document.querySelector('[data-screen="race"]');
      const visible = (el) => Boolean(el) && !el.hidden && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
      return visible(hud) || visible(screen);
    };
    while (screenVisibleAt === null && performance.now() < deadline) {
      if (screenUp()) screenVisibleAt = rel();
      else await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    const pixelsAfter = sample();
    const result = {
      callMs: +(t1 - t0).toFixed(1),
      firstRaf,
      secondRaf,
      screenVisibleAt,
      longtasks,
      longtaskError,
      canvasChanged: pixelsBefore !== pixelsAfter,
      trackLength: +race.track.length.toFixed(0),
      trackName: race.track.name,
      hidden: document.hidden,
      visibility: document.visibilityState,
    };
    if (obs) obs.disconnect();
    return result;
  };
  // eslint-disable-next-line no-new-func
  return new Function(`return (${probe.toString()})(${JSON.stringify(config)})`)();
}

/**
 * Measure one UI action (startRace / togglePause / quit click) with the same
 * window instrumentation. Used for the A/B that separates the DOM screen-swap
 * cost (menu→race) from a no-swap restart (race→race), both with a warm cache.
 */
async function measureAction(kind, payload) {
  const longtasks = [];
  let obs = null;
  try {
    obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longtasks.push({ duration: +entry.duration.toFixed(1) });
    });
    obs.observe({ type: 'longtask' });
  } catch (error) {
    /* longtask unsupported */
  }
  const t0 = performance.now();
  let detail = null;
  if (kind === 'startRace') {
    const race = window.__NEON__.startRace(payload);
    window.__RACE__ = race;
    detail = { track: race.track.name, length: +race.track.length.toFixed(0) };
  } else if (kind === 'togglePause') {
    window.__NEON__.togglePause();
    detail = { paused: window.__NEON__.state() === null ? null : undefined };
  } else if (kind === 'clickQuit') {
    const button = document.querySelector('[data-testid="pause-quit"]');
    if (button) button.click();
    detail = { clicked: Boolean(button) };
  }
  const t1 = performance.now();
  let first = null;
  let second = null;
  await new Promise((resolve) => {
    requestAnimationFrame(() => {
      first = +(performance.now() - t1).toFixed(1);
      requestAnimationFrame(() => {
        second = +(performance.now() - t1).toFixed(1);
        resolve();
      });
    });
  });
  if (obs) obs.disconnect();
  return {
    kind,
    callMs: +(t1 - t0).toFixed(1),
    firstRaf: first,
    secondRaf: second,
    longtasks,
    longtaskTotalMs: +longtasks.reduce((sum, task) => sum + task.duration, 0).toFixed(1),
    detail,
  };
}

async function metricsOf(browser) {
  const response = await browser.send('Performance.getMetrics').catch(() => ({ metrics: [] }));
  const map = {};
  for (const entry of response.metrics ?? []) map[entry.name] = entry.value;
  return map;
}

let server = null;
let browser = null;
const report = { harness: 'tools/stall-probe.mjs', startedAt: new Date().toISOString(), runs: [], summary: null, ok: false };

try {
  server = await startServer({ root: path.join(PROJECT_ROOT, 'dist'), quiet: true });
  browser = await launch({ width: 1600, height: 900, commandTimeoutMs: 120000 });
  report.chrome = browser.browserVersion;
  await browser.setViewport(1600, 900, { deviceScaleFactor: 1 });
  await browser.navigate(`${server.url}/`);
  await browser.waitFor('Boolean(window.__NEON__ && window.__NEON__.version)', 25000, '__NEON__');
  await browser.waitForFrames(6, 90000);
  await browser.send('Performance.enable').catch(() => {});
  log(`chrome ${browser.browserVersion}`);

  for (let i = 0; i < RUNS; i++) {
    const seed = SEEDS[i % SEEDS.length];
    const style = seed === 777 ? 'speedway' : seed === 1234 ? 'technical' : 'circuit';
    const cfg = { seed, style, laps: 2, opponents: 3, difficulty: 'normal', carClass: 'balanced', playerName: 'STALL' };
    const before = await metricsOf(browser);
    const measured = await browser.evaluate(`(${measureRun.toString()})(${JSON.stringify(cfg)})`, { timeoutMs: 60000 });
    const after = await metricsOf(browser);
    const delta = (name) => +(((after[name] ?? 0) - (before[name] ?? 0)) * 1000).toFixed(2);
    const run = {
      index: i + 1,
      seed,
      style,
      ...measured,
      longtaskTotalMs: +measured.longtasks.reduce((sum, task) => sum + task.duration, 0).toFixed(1),
      longtaskMaxMs: measured.longtasks.length ? Math.max(...measured.longtasks.map((task) => task.duration)) : 0,
      metrics: {
        taskMs: delta('TaskDuration'),
        scriptMs: delta('ScriptDuration'),
        layoutMs: delta('LayoutDuration'),
        recalcStyleMs: delta('RecalcStyleDuration'),
      },
    };
    report.runs.push(run);
    log(
      `run ${i + 1} seed ${seed} ${style}: call=${run.callMs}ms firstRaf=${run.firstRaf}ms secondRaf=${run.secondRaf}ms ` +
        `screen=${run.screenVisibleAt}ms longtasks=${run.longtasks.length}/${run.longtaskTotalMs}ms ` +
        `task=${run.metrics.taskMs}ms script=${run.metrics.scriptMs}ms layout=${run.metrics.layoutMs}ms canvasChanged=${run.canvasChanged}`,
    );
  }

  /* ---- phase B: A/B menu->race swap vs no-swap restart (warm cache) ---- */
  const cachedCfg = { seed: 20261018, style: 'circuit', laps: 2, opponents: 3, difficulty: 'normal', carClass: 'balanced', playerName: 'STALL' };
  const freshCfg = { seed: 551234, style: 'circuit', laps: 2, opponents: 3, difficulty: 'normal', carClass: 'balanced', playerName: 'STALL' };
  const median = (values) => {
    const sorted = [...values].filter((value) => typeof value === 'number').sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  };
  const runAction = async (kind, payload) => {
    const before = await metricsOf(browser);
    const measured = await browser.evaluate(`(${measureAction.toString()})(${JSON.stringify(kind)}, ${JSON.stringify(payload ?? null)})`, { timeoutMs: 60000 });
    const after = await metricsOf(browser);
    const delta = (name) => +(((after[name] ?? 0) - (before[name] ?? 0)) * 1000).toFixed(2);
    return { ...measured, metrics: { taskMs: delta('TaskDuration'), scriptMs: delta('ScriptDuration'), layoutMs: delta('LayoutDuration'), recalcStyleMs: delta('RecalcStyleDuration') } };
  };

  // Ensure a warm race on the cached seed, then measure idle frame pacing.
  await browser.evaluate(`(() => { if (!window.__NEON__.state()) window.__RACE__ = window.__NEON__.startRace(${JSON.stringify(cachedCfg)}); return true; })()`);
  await browser.waitForFrames(8, 90000);
  const idleFrames = await browser.evaluate(
    `new Promise((resolve) => { const gaps = []; let last = performance.now(); const loop = (now) => { gaps.push(+(now - last).toFixed(1)); last = now; if (gaps.length < 8) requestAnimationFrame(loop); else resolve(gaps); }; requestAnimationFrame(loop); })`,
    { timeoutMs: 60000 },
  );

  const restartRuns = [];
  for (let i = 0; i < 3; i++) restartRuns.push(await runAction('startRace', cachedCfg));

  const pauseRun = await runAction('togglePause');
  const resumeRun = await runAction('togglePause');

  await runAction('togglePause'); // open the pause overlay again
  const quitRun = await runAction('clickQuit');
  await browser.waitForFrames(6, 90000);

  const menuToRaceCached = [];
  for (let i = 0; i < 3; i++) menuToRaceCached.push(await runAction('startRace', cachedCfg));
  const menuToRaceFresh = [];
  for (let i = 0; i < 2; i++) menuToRaceFresh.push(await runAction('startRace', freshCfg));

  const restartFirst = restartRuns.map((run) => run.firstRaf);
  const cachedFirst = menuToRaceCached.map((run) => run.firstRaf);
  const freshFirst = menuToRaceFresh.map((run) => run.firstRaf);
  report.swap = {
    idleFrameGapsMs: idleFrames,
    idleMedianGapMs: median(idleFrames),
    restartCached: { runs: restartRuns, medianFirstRaf: median(restartFirst), medianLayoutMs: median(restartRuns.map((run) => run.metrics.layoutMs)), medianTaskMs: median(restartRuns.map((run) => run.metrics.taskMs)) },
    menuToRaceCached: { runs: menuToRaceCached, medianFirstRaf: median(cachedFirst), medianLayoutMs: median(menuToRaceCached.map((run) => run.metrics.layoutMs)), medianTaskMs: median(menuToRaceCached.map((run) => run.metrics.taskMs)) },
    menuToRaceFresh: { runs: menuToRaceFresh, medianFirstRaf: median(freshFirst), medianLayoutMs: median(menuToRaceFresh.map((run) => run.metrics.layoutMs)), medianTaskMs: median(menuToRaceFresh.map((run) => run.metrics.taskMs)) },
    pauseSwap: pauseRun,
    resumeSwap: resumeRun,
    quitToMenu: quitRun,
    comparison: {
      domSwapCostMs: (median(cachedFirst) ?? 0) - (median(restartFirst) ?? 0),
      freshTrackCostMs: (median(freshFirst) ?? 0) - (median(cachedFirst) ?? 0),
    },
  };
  log(`swap A/B: restart(cached)=${report.swap.restartCached.medianFirstRaf}ms menu->race(cached)=${report.swap.menuToRaceCached.medianFirstRaf}ms menu->race(fresh)=${report.swap.menuToRaceFresh.medianFirstRaf}ms domSwap=${report.swap.comparison.domSwapCostMs}ms freshTrack=${report.swap.comparison.freshTrackCostMs}ms idleGap=${report.swap.idleMedianGapMs}ms`);

  const firstRafs = report.runs.map((run) => run.firstRaf).filter((value) => typeof value === 'number');
  const sorted = [...firstRafs].sort((a, b) => a - b);
  report.summary = {
    runs: report.runs.length,
    firstRafMin: sorted[0] ?? null,
    firstRafMedian: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    firstRafMax: sorted[sorted.length - 1] ?? null,
    totalMin: Math.min(...report.runs.map((run) => run.callMs + (run.firstRaf ?? 0))),
    totalMax: Math.max(...report.runs.map((run) => run.callMs + (run.firstRaf ?? 0))),
    longtaskRuns: report.runs.filter((run) => run.longtasks.length > 0).length,
    maxLongtaskMs: Math.max(0, ...report.runs.map((run) => run.longtaskMaxMs)),
    maxLayoutMs: Math.max(0, ...report.runs.map((run) => run.metrics.layoutMs)),
    maxTaskMs: Math.max(0, ...report.runs.map((run) => run.metrics.taskMs)),
  };
  report.ok = true;
  log(`summary ${JSON.stringify(report.summary)}`);
} catch (error) {
  report.error = error.message;
  log('FATAL:', error.stack ?? error.message);
} finally {
  try {
    if (browser) await browser.close();
  } catch (error) {
    log('cleanup error:', error.message);
  }
  try {
    if (server) await server.close();
  } catch (error) {
    log('server cleanup error:', error.message);
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(OUT_DIR, { recursive: true }).catch(() => {});
  await writeFile(path.join(OUT_DIR, 'stall-probe.json'), JSON.stringify(report, null, 2)).catch(() => {});
  console.log(JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
}
