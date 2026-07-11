import type { OneBotEvent } from "../../src/types.js";

const GROUP_MEMBER_NAME_CACHE_TTL_MS = 30 * 60 * 1000;
const GROUP_MEMBER_NAME_FAILURE_TTL_MS = 60 * 1000;

interface OneBotActionSender {
  sendAction(action: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface SenderIdentity {
  userId: string;
  nickname: string;
  card: string;
  displayName: string;
}

interface CachedSenderIdentity {
  value: SenderIdentity;
  expiresAt: number;
}

export function senderDisplayName(sender: Record<string, unknown> | undefined) {
  return senderIdentity(sender).displayName;
}

export function senderIdentity(sender: Record<string, unknown> | undefined): SenderIdentity {
  const userId = nonEmptyString(sender?.user_id);
  const nickname = nonEmptyString(sender?.nickname);
  const card = nonEmptyString(sender?.card);
  return { userId, nickname, card, displayName: card || nickname || userId };
}

export class SenderNameResolver {
  private readonly cache = new Map<string, CachedSenderIdentity>();
  private readonly pending = new Map<string, Promise<SenderIdentity>>();

  async hydrate(event: OneBotEvent, gateway: OneBotActionSender) {
    const current = senderIdentity(event.sender);
    const userId = event.user_id || Number(current.userId);
    const groupId = event.message_type === "group" ? event.group_id : undefined;
    const complete = Boolean(current.nickname) && (groupId == null || Boolean(current.card));
    if (complete || !userId) return current.displayName;

    const key = groupId ? `group:${groupId}:${userId}` : `user:${userId}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      const identity = mergeIdentity(current, cached.value);
      this.apply(event, identity);
      return identity.displayName;
    }
    if (cached) this.cache.delete(key);

    let request = this.pending.get(key);
    if (!request) {
      request = this.load(userId, groupId, gateway, key);
      this.pending.set(key, request);
    }

    const identity = mergeIdentity(current, await request);
    this.apply(event, identity);
    return identity.displayName;
  }

  private async load(userId: number, groupId: number | undefined, gateway: OneBotActionSender, key: string) {
    try {
      const payload = groupId
        ? await gateway.sendAction("get_group_member_info", { group_id: groupId, user_id: userId, no_cache: false })
        : await gateway.sendAction("get_stranger_info", { user_id: userId, no_cache: false });
      const identity = senderIdentityFromPayload(payload);
      this.cache.set(key, {
        value: identity,
        expiresAt: Date.now() + (identity.displayName ? GROUP_MEMBER_NAME_CACHE_TTL_MS : GROUP_MEMBER_NAME_FAILURE_TTL_MS)
      });
      return identity;
    } catch (error) {
      const empty = senderIdentity(undefined);
      this.cache.set(key, {
        value: empty,
        expiresAt: Date.now() + GROUP_MEMBER_NAME_FAILURE_TTL_MS
      });
      console.warn("[runtime] resolve sender identity failed; using stored identity", {
        groupId,
        userId,
        error
      });
      return empty;
    } finally {
      this.pending.delete(key);
    }
  }

  private apply(event: OneBotEvent, identity: SenderIdentity) {
    if (!identity.displayName) return;
    event.sender = {
      ...event.sender,
      user_id: event.sender?.user_id ?? event.user_id ?? identity.userId,
      nickname: identity.nickname || event.sender?.nickname,
      card: identity.card || event.sender?.card
    };
  }
}

function senderIdentityFromPayload(payload: unknown) {
  const root = recordValue(payload);
  const data = recordValue(root?.data);
  return senderIdentity(data);
}

function mergeIdentity(current: SenderIdentity, resolved: SenderIdentity): SenderIdentity {
  const userId = current.userId || resolved.userId;
  const nickname = current.nickname || resolved.nickname;
  const card = current.card || resolved.card;
  return { userId, nickname, card, displayName: card || nickname || userId };
}

function recordValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown) {
  return value == null ? "" : String(value).trim();
}
