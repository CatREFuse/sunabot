import type { SessionStore } from "./sessionStore.js";
import type {
  EnqueueSessionEventInput,
  UpdateActiveSessionEventInput
} from "./sessionTypes.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface SessionTurnWakeOptions {
  store: SessionStore;
  clock: () => number;
  ensureStarted: () => void;
  isActive: () => boolean;
  scheduleTurns: () => void;
}

export class SessionTurnWake {
  private timer?: ReturnType<typeof setTimeout>;
  private availableAt?: number;
  private scanActive = false;

  constructor(private readonly options: SessionTurnWakeOptions) {}

  enqueueEvent(input: EnqueueSessionEventInput, schedule: boolean) {
    this.options.ensureStarted();
    const result = this.options.store.enqueueEvent(input);
    if (schedule) this.options.scheduleTurns();
    return result;
  }

  listActiveEvents(kind: string) {
    return this.options.store.listActiveEvents(kind);
  }

  reschedulePendingEvent(eventId: string, availableAt: number) {
    this.options.ensureStarted();
    const event = this.options.store.reschedulePendingEvent(eventId, availableAt);
    this.options.scheduleTurns();
    return event;
  }

  bumpActiveEventAvailableAt(eventId: string, kind: string, availableAt: number) {
    this.options.ensureStarted();
    const event = this.options.store.bumpActiveEventAvailableAt(eventId, kind, availableAt);
    this.options.scheduleTurns();
    return event;
  }

  updateActiveEvent(input: UpdateActiveSessionEventInput) {
    this.options.ensureStarted();
    const event = this.options.store.updateActiveEvent(input);
    this.options.scheduleTurns();
    return event;
  }

  get scanning() {
    return this.scanActive;
  }

  scan(operation: () => void) {
    if (!this.options.isActive() || this.scanActive) return;
    this.clear();
    this.scanActive = true;
    try {
      operation();
    } finally {
      this.scanActive = false;
      this.arm();
    }
  }

  arm() {
    if (!this.options.isActive()) return;
    const availableAt = this.options.store.nextClaimableEventAvailableAt();
    if (availableAt == null) {
      this.clear();
      return;
    }
    if (this.timer && this.availableAt === availableAt) return;
    this.clear();
    this.availableAt = availableAt;
    const timer = setTimeout(() => {
      if (this.timer !== timer) return;
      this.timer = undefined;
      this.availableAt = undefined;
      this.options.scheduleTurns();
    }, Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, availableAt - this.options.clock())
    ));
    timer.unref?.();
    this.timer = timer;
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.availableAt = undefined;
  }
}
