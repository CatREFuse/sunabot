import type { CodexCoordinatorSettings } from "./sessionCoordinatorTypes.js";
import type { SessionStore } from "./sessionStore.js";
import { SessionTurnResultCoordinator } from "./sessionTurnResultCoordinator.js";
import { SessionTurnWake } from "./sessionTurnWake.js";

interface SessionTurnServicesOptions {
  store: SessionStore;
  workerId: string;
  codexSettings: () => CodexCoordinatorSettings;
  clock: () => number;
  ensureStarted: () => void;
  isActive: () => boolean;
  isStopped: () => boolean;
  scheduleTurns: () => void;
  scheduleOutbox: () => void;
  scheduleTools: () => void;
  serializeError: (error: unknown) => unknown;
}

export function createSessionTurnServices(options: SessionTurnServicesOptions) {
  return {
    wake: new SessionTurnWake({
      store: options.store,
      clock: options.clock,
      ensureStarted: options.ensureStarted,
      isActive: options.isActive,
      scheduleTurns: options.scheduleTurns
    }),
    results: new SessionTurnResultCoordinator({
      store: options.store,
      workerId: options.workerId,
      codexSettings: options.codexSettings,
      isStopped: options.isStopped,
      scheduleOutbox: options.scheduleOutbox,
      scheduleTools: options.scheduleTools,
      serializeError: options.serializeError
    })
  };
}

export type SessionTurnServices = ReturnType<typeof createSessionTurnServices>;
