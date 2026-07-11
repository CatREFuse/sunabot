import fs from "node:fs";
import path from "node:path";
import type { ConversationRecord } from "./types.js";

const DIRECTORY_TTL_MS = 5 * 60 * 1000;
const DIRECTORY_RETRY_MS = 3_000;
const DIRECTORY_STARTUP_RETRY_DELAY_MS = 300;

interface OneBotDirectoryGateway {
  getStatus(): { connectedAt?: string };
  sendAction(action: string, params: Record<string, unknown>): Promise<unknown>;
}

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
  private snapshot: DirectorySnapshot;
  private pending: Promise<void> | undefined;
  private readonly cachePath: string | undefined;

  constructor(options: ConversationDirectoryOptions = {}) {
    this.cachePath = options.cachePath;
    this.snapshot = options.cachePath ? readCachedSnapshot(options.cachePath) : emptySnapshot();
  }

  async enrich(records: readonly ConversationRecord[], gateway: OneBotDirectoryGateway) {
    await this.refresh(gateway);
    if (!this.snapshot.friendsReady || !this.snapshot.groupsReady) {
      await delay(DIRECTORY_STARTUP_RETRY_DELAY_MS);
      await this.refresh(gateway, true);
    }
    return enrichConversationTitles(records, this.snapshot);
  }

  describe(records: readonly ConversationRecord[]) {
    return enrichConversationTitles(records, this.snapshot);
  }

  private async refresh(gateway: OneBotDirectoryGateway, force = false) {
    const generation = String(gateway.getStatus().connectedAt ?? "unknown");
    if (!force && this.snapshot.generation === generation && this.snapshot.expiresAt > Date.now()) return;
    if (!this.pending) {
      this.pending = this.load(gateway, generation).finally(() => { this.pending = undefined; });
    }
    await this.pending;
  }

  private async load(gateway: OneBotDirectoryGateway, generation: string) {
    const [friendsResult, groupsResult] = await Promise.allSettled([
      gateway.sendAction("get_friend_list", {}),
      gateway.sendAction("get_group_list", {})
    ]);
    const friendPayload = friendsResult.status === "fulfilled"
      ? directoryPayload(friendsResult.value)
      : { ready: false, items: [] };
    const groupPayload = groupsResult.status === "fulfilled"
      ? directoryPayload(groupsResult.value)
      : { ready: false, items: [] };
    const friendsReady = friendPayload.ready;
    const groupsReady = groupPayload.ready;
    const friends = friendsReady
      ? mergeMaps(this.snapshot.friends, friendMap(friendPayload.items))
      : this.snapshot.friends;
    const groups = groupsReady
      ? mergeMaps(this.snapshot.groups, groupMap(groupPayload.items))
      : this.snapshot.groups;
    this.snapshot = {
      generation,
      expiresAt: Date.now() + (friendsReady && groupsReady ? DIRECTORY_TTL_MS : DIRECTORY_RETRY_MS),
      friends,
      groups,
      friendsReady,
      groupsReady
    };
    if (friendsReady || groupsReady) this.persistSnapshot();
  }

  private persistSnapshot() {
    if (!this.cachePath) return;
    const temporaryPath = `${this.cachePath}.${process.pid}.tmp`;
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      friends: [...this.snapshot.friends.entries()]
        .sort(([left], [right]) => left - right)
        .map(([userId, identity]) => ({ userId, ...identity })),
      groups: [...this.snapshot.groups.entries()]
        .sort(([left], [right]) => left - right)
        .map(([groupId, groupName]) => ({ groupId, groupName }))
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

function enrichConversationTitles(records: readonly ConversationRecord[], snapshot: DirectorySnapshot) {
  return records.map((record) => {
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

function friendMap(items: Array<Record<string, unknown>>) {
  const result = new Map<number, FriendIdentity>();
  for (const item of items) {
    const userId = positiveInteger(item.user_id ?? item.userId);
    if (!userId) continue;
    result.set(userId, {
      nickname: cleanText(item.nickname),
      remark: cleanText(item.remark)
    });
  }
  return result;
}

function groupMap(items: Array<Record<string, unknown>>) {
  const result = new Map<number, string>();
  for (const item of items) {
    const groupId = positiveInteger(item.group_id ?? item.groupId);
    const groupName = cleanText(item.group_name ?? item.groupName);
    if (groupId && groupName) result.set(groupId, groupName);
  }
  return result;
}

function directoryPayload(value: unknown) {
  const root = recordValue(value);
  const data = root.data;
  const status = cleanText(root.status).toLowerCase();
  const retcode = root.retcode == null ? 0 : Number(root.retcode);
  const ready = Array.isArray(data) && status !== "failed" && retcode === 0;
  return { ready, items: ready ? recordItems(data) : [] };
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

function readCachedSnapshot(cachePath: string): DirectorySnapshot {
  try {
    const root = recordValue(JSON.parse(fs.readFileSync(cachePath, "utf8")));
    if (root.version !== 1) return emptySnapshot();
    return {
      ...emptySnapshot(),
      friends: friendMap(recordItems(root.friends)),
      groups: groupMap(recordItems(root.groups))
    };
  } catch {
    return emptySnapshot();
  }
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

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
