interface MutexWaiter {
  resolve(release: () => void): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class VoiceAsyncMutex {
  private locked = false;
  private readonly waiters: MutexWaiter[] = [];

  async runExclusive<T>(
    operation: () => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortedError());
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.releaseHandle());
    }
    return new Promise((resolve, reject) => {
      const waiter: MutexWaiter = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortedError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private releaseHandle() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseNext();
    };
  }

  private releaseNext() {
    while (this.waiters.length) {
      const waiter = this.waiters.shift()!;
      if (waiter.onAbort && waiter.signal) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(abortedError());
        continue;
      }
      waiter.resolve(this.releaseHandle());
      return;
    }
    this.locked = false;
  }
}

function abortedError() {
  const error = new Error("Voice operation was aborted.");
  error.name = "AbortError";
  return error;
}
