export type HookName = "before_context" | "after_context" | "before_reply" | "after_reply";

export interface HookPayload {
  channel: string;
  text: string;
  context: Record<string, unknown>;
}

type HookHandler = (payload: HookPayload) => Promise<HookPayload> | HookPayload;

export class HookBus {
  private readonly handlers = new Map<HookName, HookHandler[]>();

  register(name: HookName, handler: HookHandler) {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }

  async run(name: HookName, payload: HookPayload) {
    const handlers = this.handlers.get(name) ?? [];
    let current = payload;
    for (const handler of handlers) {
      current = await handler(current);
    }
    return current;
  }
}
