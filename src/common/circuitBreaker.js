export const CircuitState = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

export class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 30000, halfOpenMaxRequests = 1 } = {}) {
    this._threshold = threshold;
    this._cooldownMs = cooldownMs;
    this._halfOpenMaxRequests = halfOpenMaxRequests;
    this._state = CircuitState.CLOSED;
    this._failureCount = 0;
    this._successCount = 0;
    this._lastFailureTime = 0;
    this._halfOpenRequestCount = 0;
  }

  get state() {
    return this._state;
  }

  async call(fn) {
    if (this._state === CircuitState.OPEN) {
      if (Date.now() - this._lastFailureTime >= this._cooldownMs) {
        this._state = CircuitState.HALF_OPEN;
        this._halfOpenRequestCount = 0;
      } else {
        const err = new Error('Circuit breaker is OPEN');
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
    }

    if (this._state === CircuitState.HALF_OPEN && this._halfOpenRequestCount >= this._halfOpenMaxRequests) {
      const err = new Error('Circuit breaker half-open max requests exceeded');
      err.code = 'CIRCUIT_HALF_OPEN_BUSY';
      throw err;
    }

    this._halfOpenRequestCount++;
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  onSuccess() {
    this._successCount++;
    if (this._state === CircuitState.HALF_OPEN) {
      this._state = CircuitState.CLOSED;
      this._failureCount = 0;
    }
  }

  onFailure() {
    this._failureCount++;
    this._lastFailureTime = Date.now();
    if (this._state === CircuitState.HALF_OPEN || this._failureCount >= this._threshold) {
      this._state = CircuitState.OPEN;
    }
  }

  reset() {
    this._state = CircuitState.CLOSED;
    this._failureCount = 0;
    this._successCount = 0;
    this._lastFailureTime = 0;
    this._halfOpenRequestCount = 0;
  }
}
