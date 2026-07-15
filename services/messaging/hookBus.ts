export type HookName = "before_context" | "after_context" | "before_reply" | "after_reply";

export interface HookPayload {
  channel: string;
  text: string;
  context: Record<string, unknown>;
}

type HookHandler = (payload: HookPayload) => Promise<HookPayload> | HookPayload;

interface RegisteredHook {
  id?: string;
  handler: HookHandler;
}

export class HookBus {
  private readonly handlers = new Map<HookName, RegisteredHook[]>();

  register(name: HookName, handler: HookHandler): void;
  register(name: HookName, id: string, handler: HookHandler): void;
  register(name: HookName, idOrHandler: string | HookHandler, registeredHandler?: HookHandler) {
    const id = typeof idOrHandler === "string" ? requiredHandlerId(idOrHandler) : undefined;
    const handler = typeof idOrHandler === "function" ? idOrHandler : registeredHandler;
    if (!handler) throw new Error("hook handler is required.");
    if (name === "after_reply" && !id) throw new Error("after_reply hook id is required.");
    const list = this.handlers.get(name) ?? [];
    if (id && list.some((entry) => entry.id === id)) throw new Error(`${name} hook id is duplicated: ${id}`);
    list.push({ id, handler });
    this.handlers.set(name, list);
  }

  async run(name: HookName, payload: HookPayload) {
    const handlers = this.handlers.get(name) ?? [];
    let current = payload;
    for (const { handler } of handlers) {
      current = await handler(current);
    }
    return current;
  }

  async runEach(
    name: HookName,
    payload: HookPayload,
    visitor: (handlerId: string, invoke: (payload?: HookPayload) => Promise<HookPayload>) => Promise<unknown>
  ) {
    for (const { id, handler } of this.handlers.get(name) ?? []) {
      if (!id) throw new Error(`${name} hook id is required for durable delivery.`);
      await visitor(id, async (override) => handler(override ?? payload));
    }
  }
}

function requiredHandlerId(value: string) {
  const id = value.trim();
  if (!id) throw new Error("hook id is required.");
  if (id.length > 80) throw new Error("hook id must contain at most 80 characters.");
  return id;
}
