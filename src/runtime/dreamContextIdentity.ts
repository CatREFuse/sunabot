import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

interface DreamIdentityProjectionLimits {
  arrays: {
    workingMemories: number;
    longTermMemories: number;
    identityReferences: number;
    userProfiles: number;
    conversations: number;
    messagesPerConversation: number;
    activeTasks: number;
    taskTargets: number;
    taskMentions: number;
    directorItems: number;
    directorParticipants: number;
  };
  stringChars: { opaqueId: number };
}

export class DreamIdentityIndex {
  private readonly parent = new Map<string, string>();
  private readonly aliases = new Map<string, Set<string>>();
  private readonly fieldBindings = new Map<string, string>();
  private canonicalByRoot = new Map<string, string>();

  constructor(
    private readonly seed: string,
    private readonly opaqueIdLimit: number,
    private readonly identityReferenceLimit: number
  ) {}

  addGroup(values: readonly unknown[]) {
    const keys = values.flatMap((value) => identityAlias(value, this.opaqueIdLimit)).filter(Boolean);
    if (!keys.length) return;
    for (const { key, raw } of keys) {
      if (!this.parent.has(key)) this.parent.set(key, key);
      const variants = this.aliases.get(key) ?? new Set<string>();
      variants.add(raw);
      this.aliases.set(key, variants);
    }
    for (const item of keys.slice(1)) this.union(keys[0]!.key, item.key);
  }

  finalize() {
    const members = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      const values = members.get(root) ?? [];
      values.push(key);
      members.set(root, values);
    }
    this.canonicalByRoot = new Map([...members].map(([root, values]) => [root, values.sort(aliasOrder)[0]!]));
  }

  ref(value: unknown) {
    const alias = identityAlias(value, this.opaqueIdLimit)[0];
    const canonical = alias && this.parent.has(alias.key)
      ? this.canonicalByRoot.get(this.find(alias.key)) ?? alias.key
      : alias?.key ?? "unknown";
    return this.refForKey(canonical);
  }

  refForGroup(values: readonly unknown[]) {
    const first = values.flatMap((value) => identityAlias(value, this.opaqueIdLimit))[0];
    return first ? this.ref(first.raw) : undefined;
  }

  refsForRecord(record: JsonRecord) {
    return uniqueStrings(dreamIdentityValues(record).map((value) => this.ref(value)))
      .slice(0, this.identityReferenceLimit);
  }

  redact(value: string) {
    let text = value;
    const replacements = [...this.aliases.values()].flatMap((variants) => {
      return [...variants].map((raw) => {
        const display = identityAliasToken(this.seed, raw);
        const existing = this.fieldBindings.get(display);
        if (existing != null && existing !== raw) {
          throw new Error("Dream identity alias token collision.");
        }
        this.fieldBindings.set(display, raw);
        return { raw, display };
      });
    }).sort((a, b) => b.raw.length - a.raw.length || a.raw.localeCompare(b.raw));
    const markers = replacements.map((_replacement, index) => `\u{E000}${index.toString(36)}\u{E001}`);
    for (const [index, replacement] of replacements.entries()) {
      text = replaceIdentityLiteral(text, replacement.raw, markers[index]!);
    }
    for (const [index, replacement] of replacements.entries()) {
      text = text.replaceAll(markers[index]!, replacement.display);
    }
    return text;
  }

  bindingsForText(value: string) {
    return [...this.fieldBindings]
      .filter(([token]) => value.includes(token))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([token, original]) => ({ token, value: original }));
  }

  private refForKey(key: string) {
    return dreamOpaqueReference(this.seed, "person", key);
  }

  private find(key: string): string {
    const parent = this.parent.get(key) ?? key;
    if (parent === key) return key;
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }

  private union(left: string, right: string) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const [parent, child] = aliasOrder(leftRoot, rightRoot) <= 0
      ? [leftRoot, rightRoot] : [rightRoot, leftRoot];
    this.parent.set(child, parent);
  }
}

export function buildDreamIdentityIndex(
  input: JsonRecord,
  seed: string,
  limits: DreamIdentityProjectionLimits
) {
  const identities = new DreamIdentityIndex(
    seed,
    limits.stringChars.opaqueId,
    limits.arrays.identityReferences
  );
  for (const field of ["workingMemories", "longTermMemories"] as const) {
    for (const raw of arrayValue(input[field]).slice(0, limits.arrays[field])) {
      identitiesForRecord(recordValue(recordValue(raw).memory), identities);
    }
  }
  for (const raw of arrayValue(input.userProfiles).slice(0, limits.arrays.userProfiles)) {
    identitiesForRecord(recordValue(raw), identities);
  }
  for (const raw of arrayValue(input.observedConversations).slice(0, limits.arrays.conversations)) {
    const conversation = recordValue(raw);
    for (const message of arrayValue(conversation.messages).slice(0, limits.arrays.messagesPerConversation)) {
      identities.addGroup(dreamIdentityValues(recordValue(message)));
    }
  }
  for (const raw of arrayValue(input.activeTasks).slice(0, limits.arrays.activeTasks)) {
    for (const target of arrayValue(recordValue(raw).targets).slice(0, limits.arrays.taskTargets)) {
      for (const userId of arrayValue(recordValue(target).mentionUserIds).slice(0, limits.arrays.taskMentions)) {
        identities.addGroup([userId]);
      }
    }
  }
  const schedule = recordValue(input.plannedDailySchedule);
  for (const raw of arrayValue(schedule.items).slice(0, limits.arrays.directorItems)) {
    for (const participant of arrayValue(recordValue(raw).participants)
      .slice(0, limits.arrays.directorParticipants)) {
      identities.addGroup([participant]);
    }
  }
  const persona = recordValue(input.persona);
  identities.addGroup([persona.id, persona.name]);
  identities.finalize();
  return identities;
}

export function dreamOpaqueReference(seed: string, namespace: string, value: string) {
  const digest = createHash("sha256")
    .update(seed)
    .update("\0")
    .update(namespace)
    .update("\0")
    .update(value.normalize("NFKC").trim().toLowerCase())
    .digest("hex")
    .slice(0, 24);
  return `${namespace}:${digest}`;
}

function identitiesForRecord(record: JsonRecord, identities: DreamIdentityIndex) {
  const ids = uniqueIdentityValues([record.userId, ...arrayValue(record.userIds)]);
  const names = uniqueIdentityValues([
    record.userName, record.addressName, ...arrayValue(record.addressNames), record.senderName,
    record.senderNickname, record.senderCard
  ]);
  if (ids.length === 1) identities.addGroup([...ids, ...names]);
  else if (ids.length && ids.length === names.length) {
    ids.forEach((id, index) => identities.addGroup([id, names[index]]));
  } else {
    ids.forEach((id) => identities.addGroup([id]));
    names.forEach((name) => identities.addGroup([name]));
  }
}

export function dreamIdentityValues(record: JsonRecord) {
  return uniqueIdentityValues([
    record.userId, ...arrayValue(record.userIds), record.userName, record.addressName,
    ...arrayValue(record.addressNames), record.senderName, record.senderNickname, record.senderCard
  ]);
}

function uniqueIdentityValues(values: readonly unknown[]) {
  return uniqueStrings(values.flatMap((value) => {
    return typeof value === "string" || typeof value === "number" ? [String(value).trim()] : [];
  }).filter(Boolean));
}

function identityAlias(value: unknown, maxChars: number) {
  if (typeof value !== "string" && typeof value !== "number") return [];
  const raw = [...String(value).normalize("NFC").trim()].slice(0, maxChars).join("");
  if (!raw) return [];
  const canonical = raw.normalize("NFKC").toLowerCase();
  const kind = /^\d+$/u.test(canonical) ? "0" : "1";
  return [{ key: `${kind}:${canonical}`, raw }];
}

function aliasOrder(left: string, right: string) {
  return left.localeCompare(right);
}

function replaceIdentityLiteral(value: string, literal: string, replacement: string) {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!escaped) return value;
  if (/^\d+$/u.test(literal)) {
    return value.replace(new RegExp(`(^|[^0-9])${escaped}(?=$|[^0-9])`, "gu"), `$1${replacement}`);
  }
  if (/^[A-Za-z0-9_]+$/u.test(literal)) {
    return value.replace(new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "gu"), `$1${replacement}`);
  }
  return value.replace(new RegExp(escaped, "gu"), replacement);
}

function identityAliasToken(seed: string, value: string) {
  const digest = createHash("sha256")
    .update(seed)
    .update("\0alias\0")
    .update(value.normalize("NFC"))
    .digest("hex")
    .slice(0, 24);
  return `人物-${digest}`;
}

function recordValue(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)];
}
