// Bounded, cancellable FIFO mutex for one non-reentrant resource.
//
// Some work cannot be parallelised at all: the ChatGPT engine drives a single
// Chrome-DevTools-MCP client with one selected tab, so two concurrent searches
// would type into the same composer and each read the other reply. That engine
// also bypasses the browser page-slot semaphore, so without a lock of its own an
// arbitrary number of clients could pile onto the same tab. The queue is bounded
// on purpose: past the limit a caller gets a busy error with a retry hint rather
// than waiting behind a stuck conversation nobody can cancel.
import { abortError } from '../utils/abort.js';

export class ExclusiveQueue {
  constructor({ name = 'resource', maxQueued = 4, busyCode = 'RESOURCE_BUSY' } = {}) {
    this.name = name;
    this.maxQueued = maxQueued;
    this.busyCode = busyCode;
    this.busy = false;
    this.waiters = [];
  }

  status() {
    return { name: this.name, busy: this.busy, queued: this.waiters.length, max_queued: this.maxQueued };
  }

  // Resolves with an idempotent release function. Like the page-slot semaphore the
  // lock travels with the hand-off, so a release can never free a slot twice.
  acquire(signal = null) {
    if (signal?.aborted) return Promise.reject(abortError(signal, `${this.name} wait aborted`));
    if (!this.busy && this.waiters.length === 0) {
      this.busy = true;
      return Promise.resolve(this._release());
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(Object.assign(
        new Error(`${this.name} is busy (${this.waiters.length} waiting); try again later`),
        { code: this.busyCode, details: this.status() }
      ));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, settled: false, signal: signal || null, onAbort: null };
      waiter.onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(abortError(signal, `${this.name} wait aborted`));
      };
      if (waiter.signal) waiter.signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  _release() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift();
        if (waiter.settled) continue;
        waiter.settled = true;
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
        this.busy = true; // handed straight over, never observed as idle
        waiter.resolve(this._release());
        return;
      }
      this.busy = false;
    };
  }
}
