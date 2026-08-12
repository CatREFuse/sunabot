import fs from "node:fs";
import path from "node:path";
import type {
  ContactIdentityV1,
  ConversationDirectoryPort,
  ConversationRecord,
  GroupIdentityV1
} from "../../packages/contracts/messaging/messages.js";

const DIRECTORY_TTL_MS = 5 * 60 * 1000;
const DIRECTORY_RETRY_MS = 3_000;
const DIRECTORY_STARTUP_RETRY_DELAY_MS = 300;

interface FriendIdentity {
  nickname: string;
  remark: string;
}

interface DirectorySnapshot {
  generation: string;
  expiresAt: number;
  friends: Map<number, FriendIdentity>;
  groups: Map<number, string>;
  friendsReady: boolean;
  groupsReady: boolean;
}

interface ConversationDirectoryOptions {
  cachePath?: string;
}

export class ConversationDirectory {
  private readonly snapshots: Map<string, DirectorySnapshot>;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly cachePath: string | undefined;

  constructor(options: ConversationDirectoryOptions = {}) {
    this.cachePath = options.cachePath;
    this.snapshots = options.cachePath ? readCachedSnapshots(options.cachePath) : new Map();
  }

  async enrich<T extends ConversationRecord>(records: readonly T[], gateway: ConversationDirectoryPort) {
    const accountIds = [...new Set(records.map(conversationAccountId))];
    await Promise.all(accountIds.map((accountId) => this.refresh(gateway, accountId)));
    const retryAccountIds = accountIds.filter((accountId) => {
      const snapshot = this.snapshotFor(accountId);
      return !snapshot.friendsReady || !snapshot.groupsReady;
    });
    if (retryAccountIds.length) {
      await delay(DIRECTORY_STARTUP_RETRY_DELAY_MS);
      await Promise.all(retryAccountIds.map((accountId) => this.refresh(gateway, accountId, true)));
    }
    return enrichConversationTitles(records, this.snapshots);
  }

  describe<T extends ConversationRecord>(records: readonly T[]) {
    return enrichConversationTitles(records, this.snapshots);
  }

  private snapshotFor(accountId: string) {
    return this.snapshots.get(accountId) ?? emptySnapshot();
  }

  private async refresh(gateway: ConversationDirectoryPort, accountId: string, force = false) {
    const snapshot = this.snapshotFor(accountId);
    const generation = gateway.conversationDirectoryGeneration(accountId);
    if (!force && snapshot.generation === generation && snapshot.expiresAt > Date.now()) return;
    let pending = this.pending.get(accountId);
    if (!pending) {
      const load = this.load(gateway, accountId, generation).finally(() => {
        if (this.pending.get(accountId) === load) this.pending.delete(accountId);
      });
      this.pending.set(accountId, load);
      pending = load;
    }
    await pending;
  }

  private async load(gateway: ConversationDirectoryPort, accountId: string, generation: string) {
    const previous = this.snapshotFor(accountId);
    const directory = await gateway.loadConversationDirectory(accountId).catch(() => ({
      friendsReady: false,
      groupsReady: false,
      friends: [],
      groups: []
    }));
    const friendsReady = directory.friendsReady;
    const groupsReady = directory.groupsReady;
    const friends = friendsReady
      ? mergeMaps(previous.friends, friendMap(directory.friends))
      : previous.friends;
    const groups = groupsReady
      ? mergeMaps(previous.groups, groupMap(directory.groups))
      : previous.groups;
    this.snapshots.set(accountId, {
      generation,
      expiresAt: Date.now() + (friendsReady && groupsReady ? DIRECTORY_TTL_MS : DIRECTORY_RETRY_MS),
      friends,
      groups,
      friendsReady,
      groupsReady
    });
    if (friendsReady || groupsReady) this.persistSnapshot();
  }

  private persistSnapshot() {
    if (!this.cachePath) return;
    const temporaryPath = `${this.cachePath}.${process.pid}.tmp`;
    const payload = {
      version: 2,
      updatedAt: new Date().toISOString(),
      accounts: [...this.snapshots.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([accountId, snapshot]) => ({
          accountId,
          friends: [...snapshot.friends.entries()]
            .sort(([left], [right]) => left - right)
            .map(([userId, identity]) => ({ userId, ...identity })),
          groups: [...snapshot.groups.entries()]
            .sort(([left], [right]) => left - right)
            .map(([groupId, groupName]) => ({ groupId, groupName }))
        }))
    };
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      fs.renameSync(temporaryPath, this.cachePath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      console.warn("[conversation-directory] cache write failed", error);
    }
  }
}

function enrichConversationTitles<T extends ConversationRecord>(
  records: readonly T[],
  snapshots: ReadonlyMap<string, DirectorySnapshot>
) {
  return records.map((record) => {
    const snapshot = snapshots.get(conversationAccountId(record)) ?? emptySnapshot();
    if (record.groupId) {
      const groupName = snapshot.groups.get(record.groupId) || readableStoredTitle(record) || `群 ${record.groupId}`;
      return { ...record, title: groupName, groupName };
    }

    const friend = snapshot.friends.get(record.userId);
    const recentIdentity = latestPrivateIdentity(record);
    const nickname = friend?.nickname || recentIdentity.nickname;
    const remark = friend?.remark || "";
    const title = remark || nickname || readableStoredTitle(record) || `QQ ${record.userId}`;
    return {
      ...record,
      title,
      nickname: nickname || undefined,
      remark: remark || undefined
    };
  });
}

function latestPrivateIdentity(record: ConversationRecord) {
  const message = [...record.messages].reverse().find((item) => item.role === "user" && item.userId === record.userId);
  const nickname = cleanText(message?.senderNickname) || cleanText(message?.senderName);
  return { nickname: isNumericLabel(nickname) ? "" : nickname };
}

function readableStoredTitle(record: ConversationRecord) {
  const title = cleanText(record.title);
  if (!title || isNumericLabel(title)) return "";
  if (title === `QQ ${record.userId}` || title === `群 ${record.groupId}` || title === "群聊") return "";
  return title;
}

function friendMap(items: ReadonlyArray<ContactIdentityV1 | Record<string, unknown>>) {
  const result = new Map<number, FriendIdentity>();
  for (const item of items) {
    const userId = positiveInteger(item.userId);
    if (!userId) continue;
    result.set(userId, {
      nickname: cleanText(item.nickname),
      remark: cleanText(item.remark)
    });
  }
  return result;
}

function groupMap(items: ReadonlyArray<GroupIdentityV1 | Record<string, unknown>>) {
  const result = new Map<number, string>();
  for (const item of items) {
    const groupId = positiveInteger(item.groupId);
    const groupName = cleanText(item.groupName);
    if (groupId && groupName) result.set(groupId, groupName);
  }
  return result;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function isNumericLabel(value: string) {
  return /^\d+$/.test(value);
}

function mergeMaps<K, V>(previous: ReadonlyMap<K, V>, current: ReadonlyMap<K, V>) {
  return new Map<K, V>([...previous, ...current]);
}

function readCachedSnapshots(cachePath: string): Map<string, DirectorySnapshot> {
  try {
    const root = recordValue(JSON.parse(fs.readFileSync(cachePath, "utf8")));
    if (root.version === 1) return new Map([["primary", cachedSnapshot(root)]]);
    if (root.version !== 2) return new Map();
    return new Map(recordItems(root.accounts).flatMap((item) => {
      const accountId = cachedAccountId(item.accountId);
      return accountId ? [[accountId, cachedSnapshot(item)] as const] : [];
    }));
  } catch {
    return new Map();
  }
}

function cachedSnapshot(value: Record<string, unknown>): DirectorySnapshot {
  return {
    ...emptySnapshot(),
    friends: friendMap(recordItems(value.friends)),
    groups: groupMap(recordItems(value.groups))
  };
}

function recordItems(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((item) => {
      const record = recordValue(item);
      return Object.keys(record).length ? [record] : [];
    })
    : [];
}

function emptySnapshot(): DirectorySnapshot {
  return {
    generation: "",
    expiresAt: 0,
    friends: new Map(),
    groups: new Map(),
    friendsReady: false,
    groupsReady: false
  };
}

function conversationAccountId(record: Pick<ConversationRecord, "accountId">) {
  return cachedAccountId(record.accountId) || "primary";
}

function cachedAccountId(value: unknown) {
  const accountId = cleanText(value);
  return /^[A-Za-z0-9_-]{1,64}$/.test(accountId) ? accountId : "";
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
