#!/usr/bin/env node
/**
 * cdp.mjs — zero-dependency Chrome DevTools Protocol driver for Neon Racer.
 *
 * Environment (proved, do not re-litigate):
 *  - WSL2 with networkingMode=mirrored: 127.0.0.1 is shared between Windows and WSL,
 *    so a Node process *inside WSL* can both serve HTTP to Windows Chrome and talk
 *    to the Chrome DevTools endpoint over a plain WebSocket.
 *  - Windows Chrome lives at "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe".
 *    Chrome must be given WINDOWS paths for --user-data-dir.
 *  - Node 24 ships global fetch + WebSocket, so nothing is npm-installed.
 *
 * Public API (see launch()):
 *   const browser = await launch({ width: 1600, height: 900 });
 *   await browser.navigate(url);
 *   await browser.evaluate('document.title');
 *   await browser.waitFor('window.__NEON__', 15000);
 *   const shot = await browser.screenshot('artifacts/01-menu.png');
 *   await browser.clickSelector('[data-testid="start-race"]');
 *   await browser.setViewport(390, 844);
 *   const { console, pageErrors, network } = browser.logs();
 *   await browser.close();
 *
 * Everything fails loudly: missing Chrome, debugger that never opens, navigation
 * errors and JS exceptions all throw Errors with actionable messages.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ utils -- */

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/** Locate a runnable Chrome/Chromium. Throws with the full candidate list. */
export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Chrome not found. Looked for:\n  ' +
      CHROME_CANDIDATES.join('\n  ') +
      '\nInstall Chrome or set CHROME_PATH=/path/to/chrome.',
  );
}

function isWindowsChrome(chromePath) {
  return /^\/mnt\/[a-z]\//i.test(chromePath) || /\.exe$/i.test(chromePath);
}

/** Convert a WSL path (/mnt/c/...) into a Windows path (C:\...). */
export function toWindowsPath(p) {
  const m = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
  if (!m) return null;
  return `${m[1].toUpperCase()}:\\${m[2].replaceAll('/', '\\')}`;
}

/** Ask the OS for a free TCP port on 127.0.0.1. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
  });
}

/** Poll `fn` until it returns truthy or the timeout expires. */
async function poll(fn, { timeoutMs = 20000, intervalMs = 100, label = 'condition' } = {}) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}.${suffix}`);
}

function trimTail(text, lines = 30) {
  const all = String(text ?? '').trim().split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

/* ------------------------------------------------------------ CDP session -- */

/** One page-level CDP connection: commands, events, console/error collection. */
export class CdpSession {
  constructor(wsUrl, { commandTimeoutMs = 25000, chromeLog = () => '' } = {}) {
    this.wsUrl = wsUrl;
    this.commandTimeoutMs = commandTimeoutMs;
    this._chromeLog = chromeLog;
    this.ws = null;
    this._nextId = 1;
    this._pending = new Map();
    this._pageLoadWaiters = [];
    this._console = [];
    this._pageErrors = [];
    this._logEntries = [];
    this._network = [];
    this._httpErrors = [];
    this._requestUrls = new Map();
    this._consoleById = new Map();
    this.closed = false;
  }

  async connect() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WebSocket connect timeout: ${this.wsUrl}`)), 15000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error connecting to ${this.wsUrl}`));
      });
    });
    ws.addEventListener('message', (event) => this._onMessage(event));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const waiter of this._pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`CDP connection closed while waiting for ${waiter.method}`));
      }
      this._pending.clear();
      for (const waiter of this._pageLoadWaiters) waiter();
      this._pageLoadWaiters.length = 0;
    });
    return this;
  }

  /** Raw CDP command. Resolves with the result payload, rejects on CDP error. */
  send(method, params = {}) {
    if (!this.ws || this.closed) {
      return Promise.reject(new Error(`CDP session is closed; cannot send ${method}`));
    }
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP command timed out after ${this.commandTimeoutMs} ms: ${method}`));
      }, this.commandTimeoutMs);
      this._pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(error);
      }
    });
  }

  _onMessage(event) {
    const parse = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id != null) {
        const waiter = this._pending.get(msg.id);
        if (!waiter) return;
        this._pending.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.error) {
          waiter.reject(
            new Error(`CDP ${waiter.method} failed: ${msg.error.message} (code ${msg.error.code})`),
          );
        } else {
          waiter.resolve(msg.result ?? {});
        }
        return;
      }
      this._onEvent(msg);
    };

    const data = event.data;
    if (typeof data === 'string') parse(data);
    else if (data && typeof data.text === 'function') data.text().then(parse).catch(() => {});
    else if (data instanceof ArrayBuffer) parse(Buffer.from(data).toString('utf8'));
  }

  _onEvent(msg) {
    const { method, params } = msg;
    switch (method) {
      case 'Page.loadEventFired': {
        const waiters = this._pageLoadWaiters.slice();
        this._pageLoadWaiters.length = 0;
        for (const waiter of waiters) waiter();
        break;
      }
      case 'Runtime.consoleAPICalled': {
        const text = (params.args ?? [])
          .map((arg) => {
            if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
            if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
            return arg.description ?? arg.type ?? '?';
          })
          .join(' ');
        this._console.push({
          type: params.type,
          text,
          ts: Date.now(),
          url: params.stackTrace?.callFrames?.[0]?.url ?? null,
          line: params.stackTrace?.callFrames?.[0]?.lineNumber ?? null,
        });
        break;
      }
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails ?? {};
        this._pageErrors.push({
          text: details.exception?.description ?? details.text ?? 'Unknown exception',
          url: details.url ?? null,
          line: details.lineNumber ?? null,
          column: details.columnNumber ?? null,
          ts: Date.now(),
        });
        break;
      }
      case 'Log.entryAdded': {
        const entry = params.entry ?? {};
        this._logEntries.push({
          level: entry.level,
          source: entry.source,
          text: entry.text,
          url: entry.url ?? null,
          line: entry.lineNumber ?? null,
          ts: Date.now(),
        });
        break;
      }
      case 'Network.requestWillBeSent': {
        this._requestUrls.set(params.requestId, params.request?.url ?? '');
        break;
      }
      case 'Network.loadingFailed': {
        this._network.push({
          url: this._requestUrls.get(params.requestId) ?? '',
          errorText: params.errorText ?? 'unknown',
          canceled: Boolean(params.canceled),
          ts: Date.now(),
        });
        break;
      }
      case 'Network.responseReceived': {
        const status = params.response?.status ?? 0;
        if (status >= 400) {
          this._httpErrors.push({
            url: params.response?.url ?? '',
            status,
            resourceType: params.type ?? null,
            ts: Date.now(),
          });
        }
        break;
      }
      case 'Page.javascriptDialogOpening': {
        // Never let a modal alert()/confirm() block the run.
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        break;
      }
      default:
        break;
    }
  }

  /** Enable the domains the harness relies on and flush any startup events. */
  async enableDomains() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {});
    return this;
  }

  /* --------------------------------------------------------------- actions -- */

  /**
   * Evaluate an expression in the page. Throws on JS exceptions, returns the
   * serialised value. Async expressions are awaited automatically.
   */
  async evaluate(expression, { timeoutMs = 30000 } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      timeout: timeoutMs,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const description = details.exception?.description ?? details.text ?? 'unknown exception';
      throw new Error(`Page JavaScript error while evaluating:\n${truncate(expression, 500)}\n→ ${description}`);
    }
    return result.result?.value;
  }

  /** Poll a page expression until it is truthy. Returns the truthy value. */
  async waitFor(expression, timeoutMs = 20000, label = null) {
    return poll(
      async () => {
        const value = await this.evaluate(expression);
        return value === undefined ? null : value;
      },
      { timeoutMs, label: label ?? `page expression: ${truncate(expression, 120)}` },
    );
  }

  /** Navigate and wait for the load event + document.readyState === "complete". */
  async navigate(url, { timeoutMs = 25000 } = {}) {
    const loadPromise = new Promise((resolve) => this._pageLoadWaiters.push(resolve));
    const result = await this.send('Page.navigate', { url });
    if (result.errorText) {
      throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
    }
    await Promise.race([loadPromise, sleep(timeoutMs)]);
    await this.waitFor('document.readyState === "complete"', timeoutMs, `page load of ${url}`);
    return result;
  }

  /** Wait until at least `count` animation frames have been painted. */
  async waitForFrames(count = 2, timeoutMs = 10000) {
    return this.evaluate(
      `new Promise((resolve, reject) => {
        let left = ${Math.max(1, count)};
        const deadline = performance.now() + ${timeoutMs};
        const tick = () => {
          if (performance.now() > deadline) { reject(new Error('waitForFrames timed out')); return; }
          left -= 1;
          if (left <= 0) resolve(true); else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })`,
    );
  }

  /** Capture a PNG via CDP and write it to a WSL-visible path. */
  async screenshot(filePath, { clip = null, format = 'png' } = {}) {
    const params = { format, fromSurface: true, captureBeyondViewport: false };
    if (clip) params.clip = { ...clip, scale: 1 };
    const { data } = await this.send('Page.captureScreenshot', params);
    if (!data) throw new Error(`Page.captureScreenshot returned no data for ${filePath}`);
    const buffer = Buffer.from(data, 'base64');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    return { path: filePath, bytes: buffer.length };
  }

  /** Click an element by CSS selector using real mouse events at its centre. */
  async clickSelector(selector) {
    const rect = await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width < 1 || r.height < 1) return { reason: 'zero-size' };
        if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') {
          return { reason: 'not-interactive' };
        }
        const x = Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2));
        const y = Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2));
        const hit = document.elementFromPoint(x, y);
        return { x, y, hit: hit ? (hit.closest(${JSON.stringify(selector)}) ? true : false) : false };
      })()`,
    );
    if (!rect || rect.reason) {
      throw new Error(`clickSelector: element ${selector} not found/visible (${rect?.reason ?? 'missing'})`);
    }
    const { x, y } = rect;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    });
    return rect;
  }

  /** Focus a field and insert text as a real user would. */
  async typeInto(selector, text) {
    await this.clickSelector(selector);
    await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('typeInto: missing ' + ${JSON.stringify(selector)});
        el.focus();
        if ('value' in el) el.value = '';
        return true;
      })()`,
    );
    await this.send('Input.insertText', { text });
  }

  /** Press a named key (Escape, Enter, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, KeyP …). */
  async pressKey(name) {
    const keys = {
      Escape: { key: 'Escape', code: 'Escape', vk: 27 },
      Enter: { key: 'Enter', code: 'Enter', vk: 13 },
      Space: { key: ' ', code: 'Space', vk: 32 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
      KeyP: { key: 'p', code: 'KeyP', vk: 80 },
      KeyR: { key: 'r', code: 'KeyR', vk: 82 },
      KeyM: { key: 'm', code: 'KeyM', vk: 77 },
      KeyV: { key: 'v', code: 'KeyV', vk: 86 },
    };
    const spec = keys[name];
    if (!spec) throw new Error(`pressKey: unsupported key "${name}"`);
    const base = {
      key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk,
    };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /** Emulate a viewport (used for the responsive screenshots). */
  async setViewport(width, height, { deviceScaleFactor = 1, mobile = false, touch = false } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor, mobile,
      screenWidth: width, screenHeight: height,
    });
    if (touch) {
      await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    // The resize listener in main.ts reacts to the resulting resize event.
    await sleep(350);
    return this.evaluate(`({
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      scrollWidth: document.documentElement.scrollWidth,
      coarsePointer: matchMedia('(pointer: coarse)').matches,
    })`);
  }

  async clearViewport() {
    await this.send('Emulation.clearDeviceMetricsOverride');
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
    await sleep(250);
  }

  /* ----------------------------------------------------------------- logs -- */

  /** Everything captured so far. Arrays are copies; safe to JSON-serialise. */
  logs() {
    return {
      console: this._console.map((entry) => ({ ...entry })),
      pageErrors: this._pageErrors.map((entry) => ({ ...entry })),
      logEntries: this._logEntries.map((entry) => ({ ...entry })),
      network: this._network.map((entry) => ({ ...entry })),
      httpErrors: this._httpErrors.map((entry) => ({ ...entry })),
    };
  }

  /** Errors that should fail the run: page exceptions + console.error + failed requests. */
  errors() {
    const consoleErrors = this._console
      .filter((entry) => entry.type === 'error' || entry.type === 'assert')
      .map((entry) => `[console.${entry.type}] ${entry.text}`);
    const pageErrors = this._pageErrors.map((entry) => `[pageerror] ${entry.text}`);
    // Chromium logs some benign entries through Log.entryAdded (e.g. favicon 404s
    // handled by the static server, autoplay notices). Only error/warning levels
    // are reported; shoot.mjs decides which are fatal.
    const logErrors = this._logEntries
      .filter((entry) => entry.level === 'error')
      .map((entry) => `[log] ${entry.text}`);
    const networkErrors = [
      ...this._network.filter((entry) => !entry.canceled).map((entry) => `[network] ${entry.errorText} → ${entry.url}`),
      ...this._httpErrors.map((entry) => `[http ${entry.status}] ${entry.url}`),
    ];
    return { consoleErrors, pageErrors, logErrors, networkErrors };
  }

  clearLogs() {
    this._console.length = 0;
    this._pageErrors.length = 0;
    this._logEntries.length = 0;
    this._network.length = 0;
    this._httpErrors.length = 0;
  }

  async close() {
    try {
      await this.send('Browser.close');
    } catch {
      /* the browser may already be gone */
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.closed = true;
  }
}


/* ------------------------------------------------------- process cleanup -- */

/** Kill every chrome.exe whose command line references `chromeUserDataDir`. */
export function killChromeForProfile(chromeUserDataDir) {
  if (!chromeUserDataDir) return false;
  try {
    const looksWindowsPath = /^[A-Za-z]:[\\/]/.test(chromeUserDataDir);
    if (process.platform === 'win32' || looksWindowsPath) {
      // NOTE: arbitrary Linux env vars are NOT forwarded to Windows processes by
      // WSL interop, so the profile path must be embedded in the script itself.
      const psPath = String(chromeUserDataDir).replaceAll("'", "''");
      const ps = [
        'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'"',
        `| Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${psPath}') }`,
        '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
      ].join(' ');
      const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        timeout: 20000,
        encoding: 'utf8',
      });
      if (out.error || out.status !== 0) return false;
      return true;
    }
    const out = spawnSync('pkill', ['-f', chromeUserDataDir], { timeout: 10000 });
    return out.status === 0;
  } catch {
    return false;
  }
}

/** Best-effort deletion of a Chrome profile directory without blocking the run. */
function scheduleProfileCleanup(wslUserDataDir) {
  if (!wslUserDataDir) return;
  rm(wslUserDataDir, { recursive: true, force: true, maxRetries: 1, retryDelay: 200 }).catch(() => {});
}

/* ---------------------------------------------------------------- browser -- */

class Browser {
  constructor({ chromePath, userDataDir, wslUserDataDir, process: proc, port, session, browserWsUrl, chromeLog }) {
    this.chromePath = chromePath;
    this.userDataDir = userDataDir;
    this.wslUserDataDir = wslUserDataDir;
    this.process = proc;
    this.port = port;
    this.session = session;
    this.browserWsUrl = browserWsUrl;
    this._chromeLog = chromeLog;
    this._browserWs = null;
  }

  /* Delegate the everyday helpers onto the page session. */
  evaluate(...args) { return this.session.evaluate(...args); }
  waitFor(...args) { return this.session.waitFor(...args); }
  waitForFrames(...args) { return this.session.waitForFrames(...args); }
  navigate(...args) { return this.session.navigate(...args); }
  screenshot(...args) { return this.session.screenshot(...args); }
  clickSelector(...args) { return this.session.clickSelector(...args); }
  typeInto(...args) { return this.session.typeInto(...args); }
  pressKey(...args) { return this.session.pressKey(...args); }
  setViewport(...args) { return this.session.setViewport(...args); }
  clearViewport(...args) { return this.session.clearViewport(...args); }
  logs() { return this.session.logs(); }
  errors() { return this.session.errors(); }
  clearLogs() { this.session.clearLogs(); }
  chromeLog() { return this._chromeLog(); }
  /** Raw CDP command passthrough (Performance.enable, Emulation.*, …). */
  send(...args) { return this.session.send(...args); }

  async versionInfo(port = this.port) {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.json();
  }

  async close() {
    const proc = this.process;
    // Preferred shutdown: Browser.close over the browser-level websocket.
    try {
      if (!this._browserWs && this.browserWsUrl) {
        this._browserWs = new WebSocket(this.browserWsUrl);
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('browser ws timeout')), 5000);
          this._browserWs.addEventListener('open', () => { clearTimeout(t); resolve(); });
          this._browserWs.addEventListener('error', () => { clearTimeout(t); reject(new Error('browser ws error')); });
        });
      }
      this._browserWs?.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    } catch {
      /* fall through to process kill */
    }
    const exited = await Promise.race([
      new Promise((resolve) => proc.once('exit', () => resolve(true))),
      sleep(6000).then(() => false),
    ]);
    if (!exited) {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    try {
      this._browserWs?.close();
    } catch {
      /* ignore */
    }
    // Anything still alive under this exact profile is ours: kill it precisely.
    try {
      killChromeForProfile(this.userDataDir);
    } catch {
      /* ignore */
    }
    // Best-effort profile cleanup (Chrome profiles hold thousands of files on the
    // Windows drive; never let deleting them delay the actual result).
    scheduleProfileCleanup(this.wslUserDataDir);
  }
}

/**
 * Launch Chrome headless with remote debugging and return a connected Browser.
 * Throws a descriptive Error when Chrome or the debugger is unavailable.
 */
export async function launch({
  chromePath = findChrome(),
  width = 1600,
  height = 900,
  userDataDir = null,
  cleanupProfile = true,
  extraArgs = [],
  startupTimeoutMs = 25000,
  commandTimeoutMs = 25000,
} = {}) {
  const windowsChrome = isWindowsChrome(chromePath);

  // Chrome on Windows only accepts Windows paths; WSL may only pass paths it can
  // create, so hide the profile directory under C:\Temp when on Windows Chrome.
  let wslUserDataDir;
  let chromeUserDataDir;
  if (userDataDir) {
    wslUserDataDir = path.resolve(userDataDir);
    chromeUserDataDir = windowsChrome ? toWindowsPath(wslUserDataDir) : wslUserDataDir;
    if (windowsChrome && !chromeUserDataDir) {
      throw new Error(`launch(): cannot map ${wslUserDataDir} to a Windows path for --user-data-dir`);
    }
  } else {
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    if (windowsChrome) {
      wslUserDataDir = `/mnt/c/Temp/neon-racer/ud-${stamp}`;
      chromeUserDataDir = `C:\\Temp\\neon-racer\\ud-${stamp}`;
    } else {
      wslUserDataDir = `/tmp/neon-racer-ud-${stamp}`;
      chromeUserDataDir = wslUserDataDir;
    }
  }

  const args = [
    '--headless=new',
    // Port 0: let Chrome pick an ephemeral port. WSL free-port probes do not
    // always agree with Windows' reserved/excluded port ranges, so Chrome is the
    // only reliable source of truth; it publishes the port in DevToolsActivePort.
    '--remote-debugging-port=0',
    `--user-data-dir=${chromeUserDataDir}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    ...extraArgs,
    'about:blank',
  ];

  let chromeStderr = '';
  const proc = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout?.on('data', (chunk) => { chromeStderr += chunk.toString(); });
  proc.stderr?.on('data', (chunk) => { chromeStderr += chunk.toString(); });
  const chromeLog = () => trimTail(chromeStderr, 40);

  const fail = (reason) => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    killChromeForProfile(chromeUserDataDir);
    if (cleanupProfile) scheduleProfileCleanup(wslUserDataDir);
    throw new Error(
      `${reason}\n\nChrome: ${chromePath}\nArgs: ${args.join(' ')}\n\n--- chrome output (tail) ---\n${chromeLog() || '(empty)'}`,
    );
  };

  proc.once('error', (error) => {
    chromeStderr += `\nspawn error: ${error.message}`;
  });

  // Chrome writes the chosen port to <user-data-dir>/DevToolsActivePort (first
  // line = port, second line = browser websocket path). Its stderr line
  // "DevTools listening on ws://127.0.0.1:<port>/..." is the fallback.
  const activePortFile = path.join(wslUserDataDir, 'DevToolsActivePort');
  let port = 0;
  const discoverPort = async () => {
    if (port) return port;
    if (proc.exitCode !== null) throw new Error(`Chrome exited early with code ${proc.exitCode}`);
    const fromFile = await readFile(activePortFile, 'utf8').catch(() => '');
    const fileMatch = /^(\d+)\s*$/m.exec(fromFile.trim().split('\n')[0] ?? '');
    const logMatch = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(chromeStderr);
    const candidate = Number(fileMatch?.[1] ?? logMatch?.[1] ?? 0);
    if (!candidate) throw new Error('DevTools port not published yet');
    port = candidate;
    return port;
  };
  try {
    await poll(discoverPort, { timeoutMs: startupTimeoutMs, intervalMs: 100, label: 'Chrome DevToolsActivePort' });
  } catch (error) {
    fail(`Chrome did not publish its DevTools port. Is the debugger blocked?\nOriginal error: ${error.message}`);
  }

  // Wait for the HTTP endpoint (the debugger listens on Windows 127.0.0.1:port,
  // shared with WSL thanks to mirrored networking).
  let version;
  try {
    version = await poll(
      async () => {
        await discoverPort();
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      },
      { timeoutMs: startupTimeoutMs, intervalMs: 150, label: `Chrome DevTools endpoint on 127.0.0.1:${port || '(pending)'}` },
    );
  } catch (error) {
    fail(
      `Could not reach the Chrome DevTools endpoint. In WSL2 this needs mirrored networking ` +
        `(Windows and WSL share 127.0.0.1); check \`wslinfo --networking-mode\`.\n` +
        `Original error: ${error.message}`,
    );
  }

  // Find the page target and connect at page level (simplest reliable automation).
  const listTargets = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    return res.json();
  };
  let targets = [];
  try {
    targets = await poll(
      async () => {
        const list = await listTargets();
        return list.some((t) => t.type === 'page') ? list : null;
      },
      { timeoutMs: 8000, intervalMs: 100, label: 'a page target' },
    );
  } catch {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    if (!res.ok) fail(`Could not open a page target (HTTP ${res.status}).`);
    targets = await listTargets();
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page?.webSocketDebuggerUrl) fail('Chrome exposed no debuggable page target.');

  const session = new CdpSession(page.webSocketDebuggerUrl, {
    commandTimeoutMs,
    chromeLog,
  });
  try {
    await session.connect();
    await session.enableDomains();
  } catch (error) {
    fail(`Could not initialise the CDP page session: ${error.message}`);
  }

  const browser = new Browser({
    chromePath,
    userDataDir: chromeUserDataDir,
    wslUserDataDir: cleanupProfile ? wslUserDataDir : null,
    process: proc,
    port,
    session,
    browserWsUrl: version.webSocketDebuggerUrl,
    chromeLog,
  });
  // Let callers read the captured Chrome output if startup complains later.
  browser._chromeLog = chromeLog;
  browser.browserVersion = version.Browser;
  return browser;
}

function truncate(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/* ---------------------------------------------------------------- CLI test -- */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chrome = findChrome();
  console.log(`chrome: ${chrome}`);
  const netmode = spawnSync('sh', ['-c', 'wslinfo --networking-mode 2>/dev/null || echo unknown'], { encoding: 'utf8' });
  console.log(`wsl networking mode: ${(netmode.stdout ?? '').trim() || 'unknown'}`);
  const browser = await launch({ width: 800, height: 600 });
  try {
    console.log(`browser: ${browser.browserVersion}`);
    await browser.navigate('data:text/html,<title>cdp-selftest</title><h1>hello</h1>');
    const title = await browser.evaluate('document.title');
    const size = await browser.screenshot('/tmp/cdp-selftest.png');
    console.log(JSON.stringify({ ok: title === 'cdp-selftest', title, screenshotBytes: size.bytes, errors: browser.errors() }));
  } finally {
    await browser.close();
  }
}
