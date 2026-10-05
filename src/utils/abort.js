// Shared helper for "the caller stopped caring" errors.
//
// Every cancellable layer (browser page slots, engine fan-out) rejects with the
// same shape so callers can branch on `err.code === 'ABORTED'` instead of
// matching message text. Without a shared code, abandoned work looked like a
// random engine outage in failures[] and hid the real congestion cause.
export function abortError(signal, fallbackMessage = 'task aborted by caller') {
  const reason = signal?.reason;
  const message = (typeof reason === 'string' && reason) || reason?.message || fallbackMessage;
  return Object.assign(new Error(message), { code: 'ABORTED' });
}

// A layer that owns a wall-clock budget (one engine attempt, one tool call) marks
// its signal so every layer downstream can see how much of that budget is left.
//
// The browser page queue is the reason this exists: it used to wait its own
// PAGE_QUEUE_TIMEOUT_MS no matter what, so on a MAX_CONCURRENT_PAGES=1 host an
// engine with a 20s budget was killed by its own deadline while still *queued*.
// The client saw ENGINE_TIMEOUT (a fake engine outage, not congestion), and the
// doomed waiter held queue capacity until then, which is what pushed the next
// client into PAGE_QUEUE_FULL.
export function markSignalDeadline(signal, ms) {
  if (!signal || !Number.isFinite(ms) || ms <= 0) return signal;
  try {
    signal.deadlineAt = Date.now() + ms;
  } catch {
    // Sealed/frozen signal: leave the budget unknown rather than fail the request.
  }
  return signal;
}

// Remaining budget in ms, or null when the signal carries no budget (an
// open-ended caller such as an interactive login page).
export function signalRemainingMs(signal, now = Date.now()) {
  const deadlineAt = signal?.deadlineAt;
  if (!Number.isFinite(deadlineAt)) return null;
  return Math.max(0, deadlineAt - now);
}
