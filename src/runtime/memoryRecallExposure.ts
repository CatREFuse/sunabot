import type { AppConfig } from "../types.js";
import { renderedPromptUsesVariable, type RenderedPromptRequest } from "../../services/agent/promptSystem.js";
import {
  recallMemory,
  recordModelContextRecall,
  reserveModelContextRecall,
  type MemoryEntry,
  type MemoryRecallInput
} from "../../services/memory/memoryService.js";

export class ModelContextMemoryRecall {
  private readonly matches = new Map<string, MemoryEntry>();
  private committed = false;

  constructor(
    private readonly config: AppConfig,
    private readonly recallKey: string
  ) {}

  async search(input: MemoryRecallInput = {}) {
    return recallMemory(this.config, input);
  }

  async recall(input: MemoryRecallInput = {}) {
    const result = await this.search(input);
    if (!result.ok) return result;
    const accepted = this.includeAvailable(result.matches);
    return { ...result, matches: accepted };
  }

  includePromptVariable(
    request: RenderedPromptRequest,
    variable: string,
    matches: readonly MemoryEntry[]
  ) {
    if (!renderedPromptUsesVariable(request, variable)) return;
    const accepted = this.includeAvailable(matches);
    if (accepted.length !== matches.length) {
      throw new Error("Memory model-context exposure is stale; the model request was not started.");
    }
  }

  include(matches: readonly MemoryEntry[]) {
    const accepted = this.includeAvailable(matches);
    if (accepted.length !== matches.length) {
      throw new Error("Memory model-context exposure is stale; the model request was not started.");
    }
  }

  commit() {
    if (this.committed) return;
    this.committed = true;
    if (!this.matches.size) return;
    recordModelContextRecall(this.config, [...this.matches.values()], {
      kind: "model_context",
      recallKey: this.recallKey
    });
  }

  private includeAvailable(matches: readonly MemoryEntry[]) {
    const unseen = matches.filter((match) => match.source !== "long_term" || !this.matches.has(match.id));
    const { accepted } = reserveModelContextRecall(this.config, unseen, this.recallKey);
    for (const match of accepted) {
      if (match.source === "long_term") this.matches.set(match.id, match);
    }
    const acceptedIds = new Set(accepted.filter((match) => match.source === "long_term").map((match) => match.id));
    return matches.filter((match) => match.source !== "long_term" ||
      this.matches.has(match.id) || acceptedIds.has(match.id));
  }
}
