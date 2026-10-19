/**
 * localStorage persistence: player settings and per-track records.
 *
 * OWNER: lead (small cross-cutting infra; main.ts depends on the exact return
 * shapes). Degrades to an in-memory store when localStorage is unavailable
 * (private mode, file://, headless browsers with storage disabled).
 */

import { CAMERA, RACE } from '../game/config';
import type { Settings, Track, TrackRecord } from '../game/types';

const SETTINGS_KEY = 'neon-racer:settings:v1';
const RECORDS_KEY = 'neon-racer:records:v1';

export const DEFAULT_SETTINGS: Settings = {
  sound: true,
  playerName: 'PLAYER',
  carClass: 'balanced',
  laps: RACE.defaultLaps,
  difficulty: 'normal',
  opponents: RACE.defaultOpponents,
  showDebug: false,
  seed: 20261018,
  style: 'circuit',
  cameraMode: CAMERA.defaultMode,
};

/* ------------------------------------------------------------- low level -- */

const memory = new Map<string, string>();
let storageOk = true;

function readRaw(key: string): string | null {
  if (storageOk) {
    try {
      const value = window.localStorage.getItem(key);
      return value;
    } catch {
      storageOk = false;
    }
  }
  return memory.get(key) ?? null;
}

function writeRaw(key: string, value: string): void {
  memory.set(key, value);
  if (!storageOk) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    storageOk = false;
  }
}

function readJson<T>(key: string): T | null {
  const raw = readRaw(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- settings -- */

export function loadSettings(): Settings {
  const stored = readJson<Partial<Settings>>(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

/** Merge `patch` into the stored settings and return the full new settings. */
export function saveSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...loadSettings(), ...patch };
  writeRaw(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/* --------------------------------------------------------------- records -- */

type RecordBook = Record<string, TrackRecord>;

/** Stable id for a generated track; used as the record key. */
export function recordKey(track: Track): string {
  return `${track.style}-${track.seed}`;
}

export function loadRecord(track: Track): TrackRecord | null {
  const book = readJson<RecordBook>(RECORDS_KEY);
  return book?.[recordKey(track)] ?? null;
}

export function loadAllRecords(): RecordBook {
  return readJson<RecordBook>(RECORDS_KEY) ?? {};
}

export interface SaveResult {
  record: TrackRecord;
  improvedLap: boolean;
  improvedTotal: boolean;
}

/**
 * Store a finished run. A lap time only counts when it is a real lap time
 * (finite and > 0), a total time only when the race was actually completed.
 */
export function saveResult(
  track: Track,
  result: { bestLap: number | null; totalTime: number | null },
): SaveResult {
  const book = readJson<RecordBook>(RECORDS_KEY) ?? {};
  const key = recordKey(track);
  const prev: TrackRecord = book[key] ?? { bestLap: null, bestTotal: null, runs: 0, updatedAt: null };

  const lap = result.bestLap != null && Number.isFinite(result.bestLap) && result.bestLap > 0 ? result.bestLap : null;
  const total =
    result.totalTime != null && Number.isFinite(result.totalTime) && result.totalTime > 0 ? result.totalTime : null;

  const improvedLap = lap != null && (prev.bestLap == null || lap < prev.bestLap);
  const improvedTotal = total != null && (prev.bestTotal == null || total < prev.bestTotal);

  const next: TrackRecord = {
    bestLap: improvedLap ? lap : prev.bestLap,
    bestTotal: improvedTotal ? total : prev.bestTotal,
    runs: prev.runs + 1,
    updatedAt: Date.now(),
  };
  book[key] = next;
  writeRaw(RECORDS_KEY, JSON.stringify(book));
  return { record: next, improvedLap, improvedTotal };
}

export function clearRecords(): void {
  writeRaw(RECORDS_KEY, JSON.stringify({}));
}
