import { useEffect, useState } from 'react';
import { api, sse } from '../api.js';
import { toast } from './toast.js';
import { notifyDesktop } from './notify.js';

/**
 * THE HEALTH CHECK, WATCHED FROM ANYWHERE IN THE APP.
 *
 * The run belongs to the server (see `routes/health.js`, "THE ONE IN-MEMORY RUN
 * TABLE"). This module is the page's side of that: a module-level store, like
 * `toast.js`, so the stream that watches a run is not owned by any component.
 *
 * WHY NOT COMPONENT STATE. It was component state, and navigating away from
 * Health Assist unmounted it: the progress vanished, the button said "Check
 * again", and pressing it answered "a health check is already running". The
 * check was fine; the page had simply forgotten it. Here, leaving the page
 * changes nothing, and coming back — or reloading the tab — finds the run
 * through `GET /runs/active` and watches it again.
 *
 * The outcome is announced ONCE, from here, whichever page is showing: a toast
 * in the app, and a desktop notification if the person turned those on and is
 * in another window.
 */

const IDLE = { status: 'idle', runId: null, startedAt: null, progress: null, message: null, finishedSeq: 0 };
let state = IDLE;
let watching = null;          // the runId a stream is currently open for
let generation = 0;           // bumped on log out; a stream from an older generation is ignored
const listeners = new Set();

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) { try { fn(state); } catch { /* a listener's problem */ } }
}

export function getHealthRun() { return state; }

export function subscribeHealthRun(fn) {
  listeners.add(fn);
  fn(state);
  return () => { listeners.delete(fn); };
}

/** React binding. */
export function useHealthRun() {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => subscribeHealthRun(setSnapshot), []);
  return snapshot;
}

export const isActive = (s) => s.status === 'starting' || s.status === 'running';

function announce(status, message) {
  if (status === 'completed') {
    toast.success('Health check complete.');
    notifyDesktop({ title: 'Health check complete', body: 'Your results are ready in Health Assist.', tag: 'nha-health', path: '/health' });
  } else if (status === 'failed') {
    toast.error('The health check did not finish.', { detail: message });
    notifyDesktop({ title: 'Health check did not finish', body: message || 'Open Health Assist for the reason.', tag: 'nha-health', path: '/health' });
  } else if (status === 'cancelled') {
    toast.success('Stopped. Nothing was written — a health check only reads.');
  }
}

function finish(runId, status, message) {
  watching = null;
  set({ status, runId, message: message ?? null, progress: null, finishedSeq: state.finishedSeq + 1 });
  announce(status, message);
}

/**
 * Watch one stream to its terminal frame. The terminal frame is CAPTURED, not
 * thrown from the handler — `sse()` swallows handler exceptions.
 *
 * Two different failures, told apart by whether any frame arrived:
 *   - refused before it began (a 409, no instance bound, server down): THROWN,
 *     so the caller can say why;
 *   - the stream dropped after it began: that says nothing about the RUN, so
 *     `recover` asks the server what became of it instead of guessing.
 */
async function follow(runId, open) {
  let terminal = null;
  let gotFrame = false;
  let seenRunId = runId;
  const myGeneration = generation;
  const stale = () => myGeneration !== generation;
  try {
    await open((evt) => {
      if (stale()) return;
      gotFrame = true;
      if (evt.type === 'run_started') {
        seenRunId = evt.runId;
        watching = evt.runId;
        set({ status: 'running', runId: evt.runId, startedAt: evt.startedAt ?? state.startedAt, message: null });
      } else if (evt.type === 'progress') {
        set({ status: 'running', progress: evt });
      } else if (evt.type === 'done' || evt.type === 'error' || evt.type === 'cancelled') {
        terminal = evt;
      }
    });
  } catch (err) {
    if (stale()) return undefined;
    if (!gotFrame) throw err;
    if (!terminal) return recover(seenRunId, err);
  }
  if (stale()) return undefined;
  if (!terminal) return recover(seenRunId, null);
  if (terminal.type === 'done') return finish(seenRunId, 'completed');
  if (terminal.type === 'cancelled') return finish(seenRunId, 'cancelled', terminal.note);
  return finish(seenRunId, 'failed', terminal.message);
}

let recovering = false;

/**
 * The stream dropped. Wait for the server, then ask it: is the run still going
 * (watch it again), or how did it end (report that)? Only if the server never
 * comes back is the outcome reported as unknown — and it says so.
 */
async function recover(runId, err) {
  if (recovering) return undefined;
  recovering = true;
  watching = null;
  const myGeneration = generation;
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((r) => { setTimeout(r, Math.min(1000 * 2 ** attempt, 15000)); });
      if (myGeneration !== generation) return undefined;   // logged out while waiting
      let active;
      try { ({ run: active } = await api.get('/health/runs/active')); } catch { continue; /* not back yet */ }
      if (active) { recovering = false; return attachHealthRun(active.id, active); }
      if (!runId) { set({ ...IDLE, finishedSeq: state.finishedSeq }); return undefined; }
      try {
        const { run } = await api.get(`/health/runs/${runId}`);
        if (run?.status === 'completed' || run?.status === 'partial') return finish(runId, 'completed');
        if (run?.status === 'cancelled') return finish(runId, 'cancelled', run.error);
        if (run?.status === 'failed') return finish(runId, 'failed', run.error);
      } catch {
        /* 404 — the run belongs to an instance that is no longer bound. */
        set({ ...IDLE, finishedSeq: state.finishedSeq });
        return undefined;
      }
    }
    return finish(runId, 'failed', `Lost contact with the SAOS server while watching the check${err?.message ? ` (${err.message})` : ''}. `
      + 'If the server was restarted, the check was interrupted — run it again.');
  } finally {
    recovering = false;
  }
}

/** Watch a run that is already going. Safe to call repeatedly. */
export function attachHealthRun(runId, known = null) {
  if (!runId || watching === runId) return undefined;
  watching = runId;
  set({ status: 'running', runId, startedAt: known?.startedAt ?? null, progress: known?.progress ?? null, message: null });
  return follow(runId, (onEvent) => sse(`/health/runs/${runId}/stream`, null, onEvent, 'GET'))
    .catch((err) => recover(runId, err));
}

/**
 * Is a check running against this instance? Watch it if so. Called when the
 * app loads and when Health Assist opens, so a refresh or a return visit picks
 * the run back up.
 */
export async function discoverHealthRun() {
  try {
    const { run } = await api.get('/health/runs/active');
    if (run) attachHealthRun(run.id, run);
    return run ?? null;
  } catch {
    return null;
  }
}

/** Start a check — or, if one is already running, watch that one instead. */
export async function startHealthRun(body = {}) {
  if (isActive(state)) return undefined;
  set({ status: 'starting', runId: null, startedAt: null, progress: { stage: 'starting', percent: 0 }, message: null });
  const existing = await discoverHealthRun();
  if (existing) return undefined;
  try {
    return await follow(null, (onEvent) => sse('/health/runs', body, onEvent, 'POST'));
  } catch (err) {
    /* A 409 raced us: another tab started one a moment ago. Watch it. */
    const raced = await discoverHealthRun();
    if (!raced) {
      set({ ...IDLE, finishedSeq: state.finishedSeq, message: err.message });
      toast.error(err.message);
    }
    return undefined;
  }
}

/**
 * Log out: forget the run entirely. The server stops a check against an
 * instance that is no longer bound, and its data is purged; any frame still
 * arriving from that stream belongs to an older generation and is ignored, so
 * nothing about the old instance is shown or announced after this.
 */
export function resetHealthRun() {
  generation += 1;
  watching = null;
  set({ ...IDLE, finishedSeq: state.finishedSeq });
}

/** Stop the running check. The stream's `cancelled` frame is what ends it. */
export async function stopHealthRun() {
  if (!state.runId) return;
  try {
    const r = await api.post(`/health/runs/${state.runId}/cancel`);
    if (!r?.ok) toast.error(r?.message || 'That check is not running any more.');
  } catch (err) {
    toast.error(err.message);
  }
}
