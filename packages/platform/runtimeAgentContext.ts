import { AsyncLocalStorage } from "node:async_hooks";
import type { AppConfig } from "../../src/types.js";

const storage = new AsyncLocalStorage<Pick<AppConfig, "persona">>();

export function runWithAgentRuntimeContext<T>(config: Pick<AppConfig, "persona">, operation: () => T): T {
  return storage.run(config, operation);
}

export function currentAgentRuntimeConfig() {
  return storage.getStore();
}
