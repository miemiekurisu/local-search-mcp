function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Allow the process to exit if this is the only handle remaining
    if (typeof t.unref === 'function') t.unref();
  });
}

function isAbortError(err) {
  // Check direct name (undici AbortError)
  if (err && err.name === 'AbortError') return true;
  // Check cause chain for nested abort errors
  let cause = err?.cause;
  for (let depth = 0; depth < 5; depth++) {
    if (!cause) break;
    if (cause.name === 'AbortError') return true;
    if (cause.code === 'ABORT_ERR') return true;
    cause = cause.cause;
  }
  // Also check the top-level code property
  if (err?.code === 'ABORT_ERR') return true;
  return false;
}

export async function retry(fn, options = {}) {
  const {
    maxRetries = 2,
    baseDelayMs = 1000,
    maxDelayMs = 10000,
    retryableStatuses = [429, 502, 503, 504],
    jitter = true,
    shouldRetry: shouldRetryFn = null,
  } = options;

  let attempt = 0;

  while (true) {
    try {
      const result = await fn();

      if (result && typeof result.status === 'number' && retryableStatuses.includes(result.status)) {
        const err = new Error(`HTTP ${result.status}`);
        err.status = result.status;
        err.response = result;
        throw err;
      }

      return result;
    } catch (err) {
      // AbortError should never be retried — check name, code, and nested cause
      if (isAbortError(err)) {
        throw err;
      }

      if (attempt >= maxRetries) {
        err.attempts = attempt + 1;
        throw err;
      }

      if (shouldRetryFn && !shouldRetryFn(err, attempt)) {
        err.attempts = attempt + 1;
        throw err;
      }

      attempt++;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const finalDelay = jitter ? delay * (0.5 + Math.random() * 0.5) : delay;
      await sleep(finalDelay);
    }
  }
}

export class RetryPolicy {
  constructor(options = {}) {
    this._options = options;
  }

  execute(fn) {
    return retry(fn, this._options);
  }
}
