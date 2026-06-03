export class RateLimiter {
  constructor({ minIntervalMs = 1000, maxConcurrency = 1, maxQueueSize = 100 } = {}) {
    this._minIntervalMs = minIntervalMs;
    this._maxConcurrency = maxConcurrency;
    this._maxQueueSize = maxQueueSize;
    this._buckets = new Map();
  }

  acquire(key) {
    let bucket = this._buckets.get(key);
    if (!bucket) {
      bucket = { queue: [], lastDispatchTime: 0, activeCount: 0, timer: null };
      this._buckets.set(key, bucket);
    }

    return new Promise((resolve, reject) => {
      if (bucket.queue.length >= this._maxQueueSize) {
        return reject(new Error('Rate limiter queue full (max queue size exceeded)'));
      }
      bucket.queue.push(resolve);
      this._drain(key);
    });
  }

  release(key) {
    const bucket = this._buckets.get(key);
    if (!bucket) return;
    bucket.activeCount = Math.max(0, bucket.activeCount - 1);
    this._drain(key);
  }

  _drain(key) {
    const bucket = this._buckets.get(key);
    if (!bucket || bucket.queue.length === 0) return;
    if (bucket.activeCount >= this._maxConcurrency) return;
    if (bucket.timer !== null) return;

    const now = Date.now();
    const elapsed = now - bucket.lastDispatchTime;

    if (elapsed < this._minIntervalMs) {
      const waitTime = this._minIntervalMs - elapsed;
      const t = setTimeout(() => {
        bucket.timer = null;
        this._dispatchBatch(key);
      }, waitTime);
      bucket.timer = t;
      if (typeof t.unref === 'function') t.unref();
      return;
    }

    this._dispatchBatch(key);
  }

  _dispatchBatch(key) {
    const bucket = this._buckets.get(key);
    if (!bucket || bucket.queue.length === 0) return;

    const available = this._maxConcurrency - bucket.activeCount;
    if (available <= 0) return;

    const batchSize = Math.min(available, bucket.queue.length);
    bucket.lastDispatchTime = Date.now();

    for (let i = 0; i < batchSize; i++) {
      const resolve = bucket.queue.shift();
      bucket.activeCount++;
      resolve();
    }

    if (bucket.queue.length > 0 && bucket.activeCount < this._maxConcurrency) {
      setImmediate(() => this._drain(key));
    }
  }
}
