import type {
  InboundMessageV1,
  MessagingPort,
  SenderIdentityV1
} from "../../packages/contracts/messaging/messages.js";

const GROUP_MEMBER_NAME_CACHE_TTL_MS = 30 * 60 * 1000;
const GROUP_MEMBER_NAME_FAILURE_TTL_MS = 60 * 1000;

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

export function senderDisplayName(sender: SenderIdentityV1 | Record<string, unknown> | undefined) {
  return senderIdentity(sender).displayName;
}

export function senderIdentity(sender: SenderIdentityV1 | Record<string, unknown> | undefined): SenderIdentity {
  const userId = nonEmptyString(sender && "id" in sender ? sender.id : sender?.user_id);
  const nickname = nonEmptyString(sender?.nickname);
  const card = nonEmptyString(sender?.card);
  return { userId, nickname, card, displayName: card || nickname || userId };
}

export class SenderNameResolver {
  private readonly cache = new Map<string, CachedSenderIdentity>();
  private readonly pending = new Map<string, Promise<SenderIdentity>>();

  async hydrate(message: InboundMessageV1, gateway: Pick<MessagingPort, "resolveSender">) {
    const identity = await this.resolve({
      sender: message.sender,
      accountId: message.accountId,
      userId: message.userId,
      groupId: message.groupId
    }, gateway);
    message.sender = contractSenderIdentity(identity);
    return identity.displayName;
  }

  async resolve(
    input: { sender?: SenderIdentityV1; accountId?: string; userId: number; groupId?: number },
    gateway: Pick<MessagingPort, "resolveSender">
  ) {
    const current = senderIdentity(input.sender);
    const userId = input.userId || Number(current.userId);
    const groupId = input.groupId;
    const complete = Boolean(current.nickname) && (groupId == null || Boolean(current.card));
    if (complete || !userId) return current;

    const accountKey = input.accountId || "primary";
    const key = groupId
      ? `account:${accountKey}:group:${groupId}:${userId}`
      : `account:${accountKey}:user:${userId}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      const identity = mergeIdentity(current, cached.value);
      return identity;
    }
    if (cached) this.cache.delete(key);

    let request = this.pending.get(key);
    if (!request) {
      request = this.load(input.accountId, userId, groupId, gateway, key);
      this.pending.set(key, request);
    }

    const identity = mergeIdentity(current, await request);
    return identity;
  }

  private async load(
    accountId: string | undefined,
    userId: number,
    groupId: number | undefined,
    gateway: Pick<MessagingPort, "resolveSender">,
    key: string
  ) {
    try {
      const identity = senderIdentity(await gateway.resolveSender({
        ...(accountId ? { accountId } : {}),
        userId,
        groupId
      }));
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
        accountId,
        groupId,
        userId,
        error
      });
      return empty;
    } finally {
      this.pending.delete(key);
    }
  }

}

function mergeIdentity(current: SenderIdentity, resolved: SenderIdentity): SenderIdentity {
  const userId = current.userId || resolved.userId;
  const nickname = current.nickname || resolved.nickname;
  const card = current.card || resolved.card;
  return { userId, nickname, card, displayName: card || nickname || userId };
}

function nonEmptyString(value: unknown) {
  return value == null ? "" : String(value).trim();
}

function contractSenderIdentity(identity: SenderIdentity): SenderIdentityV1 {
  return {
    id: identity.userId,
    ...(identity.nickname ? { nickname: identity.nickname } : {}),
    ...(identity.card ? { card: identity.card } : {}),
    ...(identity.displayName ? { displayName: identity.displayName } : {})
  };
}
