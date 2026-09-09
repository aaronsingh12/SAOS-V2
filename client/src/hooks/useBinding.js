import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * The header's live readout: bound instance, active scope, connection + sync.
 *
 * A sibling of useHealth rather than part of it, and deliberately so. /health
 * is the gate every page waits on and answers in ~2ms because it reads only
 * settings and a cached probe; this one reads the instance to compare the
 * managed Fluent sources against it. Folding the two would put a multi-read
 * comparison in front of every page render — the exact mistake /health was
 * already fixed for once.
 *
 * Same shared-poller shape as useHealth: one module-level store, one interval,
 * so N subscribers do not mean N requests, and a component mounting mid-cycle
 * gets the last known answer instead of flashing "unknown".
 */

const POLL_MS = 30_000;
/** While a deploy is in flight the answer changes fast, so ask more often. */
const BUSY_POLL_MS = 5_000;

let state = { loading: true, binding: null, error: null };
const listeners = new Set();
let timer = null;
let inFlight = null;

function emit() {
  const snapshot = state;
  for (const fn of listeners) fn(snapshot);
}

function reschedule() {
  if (!listeners.size) return;
  const wanted = state.binding?.deploying ? BUSY_POLL_MS : POLL_MS;
  if (timer) clearInterval(timer);
  timer = setInterval(poll, wanted);
}

async function poll({ refresh = false } = {}) {
  if (inFlight) return inFlight;
  inFlight = api
    .get(`/system/binding${refresh ? '?refresh=1' : ''}`)
    .then((binding) => { state = { loading: false, binding, error: null }; })
    .catch((err) => {
      // The local server, not the instance — say so rather than blaming the PDI.
      state = { loading: false, binding: null, error: err.message };
    })
    .finally(() => { inFlight = null; emit(); reschedule(); });
  return inFlight;
}

/**
 * Called after anything that changes the binding, so the header never lags a
 * save. `refresh` bypasses the server's short cache, because the whole point
 * of calling it here is that the previous answer is now known to be stale.
 */
export function refreshBinding() { return poll({ refresh: true }); }

function subscribe(fn) {
  listeners.add(fn);
  if (listeners.size === 1) { poll(); reschedule(); }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) { clearInterval(timer); timer = null; }
  };
}

export function useBinding() {
  const [snap, setSnap] = useState(state);
  useEffect(() => subscribe(setSnap), []);
  return {
    loading: snap.loading,
    error: snap.error,
    binding: snap.binding,
    instance: snap.binding?.instance ?? null,
    scope: snap.binding?.scope ?? null,
    status: snap.binding?.status ?? null,
    sync: snap.binding?.sync ?? null,
    deploying: snap.binding?.deploying === true,
  };
}
