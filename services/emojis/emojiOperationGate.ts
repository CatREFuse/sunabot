interface GenerationState {
  active: number;
  keys: Set<string>;
}

interface NormalizationState {
  active: number;
}

export type EmojiGenerationAdmission =
  | { ok: true; release(): void }
  | { ok: false; reason: "key" | "capacity" };

export type EmojiNormalizationAdmission =
  | { ok: true; release(): void }
  | { ok: false; reason: "capacity" };

export class EmojiNormalizationBusyError extends Error {
  constructor() {
    super("Emoji normalization capacity is exhausted.");
    this.name = "EmojiNormalizationBusyError";
  }
}

export class EmojiGenerationGate {
  private readonly states = new Map<string, GenerationState>();

  constructor(private readonly maxActivePerAgent = 2) {
    if (!Number.isSafeInteger(maxActivePerAgent) || maxActivePerAgent < 1) {
      throw new Error("Emoji generation concurrency must be a positive integer.");
    }
  }

  tryAcquire(agentId: string, key: string): EmojiGenerationAdmission {
    const state = this.states.get(agentId) ?? { active: 0, keys: new Set<string>() };
    if (state.keys.has(key)) return { ok: false, reason: "key" };
    if (state.active >= this.maxActivePerAgent) return { ok: false, reason: "capacity" };
    state.active += 1;
    state.keys.add(key);
    this.states.set(agentId, state);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        state.active -= 1;
        state.keys.delete(key);
        if (state.active === 0) this.states.delete(agentId);
      }
    };
  }
}

export class EmojiNormalizationGate {
  private readonly states = new Map<string, NormalizationState>();

  constructor(private readonly maxActivePerAgent = 2) {
    if (!Number.isSafeInteger(maxActivePerAgent) || maxActivePerAgent < 1) {
      throw new Error("Emoji normalization concurrency must be a positive integer.");
    }
  }

  tryAcquire(agentId: string): EmojiNormalizationAdmission {
    const state = this.states.get(agentId) ?? { active: 0 };
    if (state.active >= this.maxActivePerAgent) {
      return { ok: false, reason: "capacity" };
    }
    state.active += 1;
    this.states.set(agentId, state);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        state.active -= 1;
        if (state.active === 0) this.states.delete(agentId);
      }
    };
  }
}
