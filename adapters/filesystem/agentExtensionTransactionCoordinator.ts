import { AsyncLocalStorage } from "node:async_hooks";
import { storeError } from "./agentExtensionSecureFs.js";

export class AgentExtensionTransactionCoordinator {
  private readonly activeAgents = new Set<string>();
  private readonly context = new AsyncLocalStorage<string>();

  owns(agentId: string) {
    return this.context.getStore() === agentId;
  }

  async run<T>(
    agentId: string,
    operation: () => Promise<T>,
    acquire: (scopedOperation: () => Promise<T>) => Promise<T>
  ) {
    if (this.owns(agentId)) return operation();
    if (this.activeAgents.has(agentId)) {
      throw storeError(409, "AGENT_EXTENSION_BUSY", "Agent 扩展正在被其他操作修改。");
    }
    this.activeAgents.add(agentId);
    try {
      return await acquire(() => this.context.run(agentId, operation));
    } finally {
      this.activeAgents.delete(agentId);
    }
  }
}
