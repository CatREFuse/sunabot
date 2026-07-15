export class OutboxPartitionScheduler {
  private readonly paused = new Set<string>();
  private readonly ready = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly probeDelayMs: number,
    private readonly inactive: () => boolean,
    private readonly schedule: () => void
  ) {}

  excluded(active: Iterable<string>) {
    return [...this.paused, ...active];
  }

  takeReady() {
    const partition = [...this.ready].sort()[0];
    if (partition) this.ready.delete(partition);
    return partition;
  }

  pause(partition: string) {
    this.paused.add(partition);
    this.ready.delete(partition);
    this.scheduleProbe(partition);
  }

  retry(partition: string) {
    if (this.paused.has(partition)) this.scheduleProbe(partition);
  }

  completeAttempt(partition: string, connectivityProven: boolean) {
    if (!this.paused.has(partition)) return;
    if (connectivityProven) this.resume(partition);
    else this.scheduleProbe(partition);
  }

  resume(partition: string) {
    this.paused.delete(partition);
    this.ready.delete(partition);
    const timer = this.timers.get(partition);
    if (timer) clearTimeout(timer);
    this.timers.delete(partition);
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.ready.clear();
  }

  private scheduleProbe(partition: string) {
    if (this.timers.has(partition)) return;
    const timer = setTimeout(() => {
      if (this.timers.get(partition) !== timer) return;
      this.timers.delete(partition);
      if (this.inactive() || !this.paused.has(partition)) return;
      this.ready.add(partition);
      this.schedule();
    }, this.probeDelayMs);
    timer.unref?.();
    this.timers.set(partition, timer);
  }
}
