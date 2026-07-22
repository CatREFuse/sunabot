export class RendererQueueFullError extends Error {
  constructor() {
    super("Renderer queue is full.");
    this.name = "RendererQueueFullError";
  }
}

export class RendererLimiter {
  private active = 0;
  private closed = false;
  private readonly waiters: Array<{ resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; abort?: () => void }> = [];

  constructor(private readonly limit: number, private readonly maxQueued: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxQueued) || maxQueued < 0) {
      throw new Error("Renderer limiter bounds are invalid.");
    }
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal) {
    if (this.closed) throw new Error("Renderer limiter is closed.");
    await this.acquire(signal);
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.releaseNext();
    }
  }

  private async acquire(signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason ?? new Error("Renderer request aborted.");
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await this.wait(signal);
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.abort && waiter.signal) waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(new Error("Renderer limiter is closed."));
    }
  }

  private wait(signal?: AbortSignal) {
    if (this.waiters.length >= this.maxQueued) throw new RendererQueueFullError();
    return new Promise<void>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, reject, signal };
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Renderer request aborted."));
        };
        if (signal.aborted) return waiter.abort();
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private releaseNext() {
    const waiter = this.waiters.shift();
    if (!waiter) return;
    if (waiter.abort && waiter.signal) waiter.signal.removeEventListener("abort", waiter.abort);
    this.active += 1;
    waiter.resolve();
  }
}
