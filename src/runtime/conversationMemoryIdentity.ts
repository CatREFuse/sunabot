import type { MemoryFactInput } from "../../services/memory/memoryService.js";
import { escapeRegExp, uniqueStrings } from "./messagingAttachmentHelpers.js";
import type { BatchUserInfo } from "./runtimeContracts.js";

export function hasForbiddenMemoryRecallPhrase(value: unknown) {
  return /(?:我(?:还|仍|仍然|依然|一直|始终|清楚地)?记得|我(?:回想|回忆)(?:起|起来)?|我(?:想起|忆起)|(?:在|凭|按|依)?我(?:的)?印象(?:里|中)?|我有印象|印象中我|\bI\s+(?:(?:still|clearly)\s+)?(?:remember|recall)\b)/iu.test(stringValue(value));
}

export function normalizeQqId(value: unknown) {
  const text = stringValue(value);
  if (!text) return "";
  const match = text.match(/^(?:QQ(?:号)?\s*[:：#]?\s*)?(\d{5,12})$/iu);
  return match?.[1] ?? "";
}

export function normalizeQqIds(value: unknown) {
  return uniqueStrings(qqIdentityParts(value).map(normalizeQqId).filter(Boolean));
}

export function hasInvalidQqIdentity(value: unknown) {
  return qqIdentityParts(value).some((part) => !normalizeQqId(part));
}

function qqIdentityParts(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(qqIdentityParts);
  const text = stringValue(value);
  if (!text) return [];
  if (normalizeQqId(text)) return [text];
  return text.split(/[,\s，、/]+/).filter(Boolean);
}

function stringValue(value: unknown) {
  return String(value ?? "").trim();
}

function validMemoryUserName(value: unknown, userId?: string) {
  const userName = stringValue(value);
  return userName && userName !== userId && !normalizeQqId(userName) ? userName : undefined;
}

export function trustedParticipantName(user: BatchUserInfo) {
  return trustedParticipantNames(user)[0] ?? "";
}

function trustedParticipantNames(user: BatchUserInfo) {
  return uniqueStrings((user.addressNames ?? user.names ?? [])
    .map((name) => validMemoryUserName(normalizeObservedName(name, user.userId), user.userId))
    .filter((name): name is string => Boolean(name)));
}

function normalizeObservedName(value: unknown, userId: string) {
  const name = stringValue(value);
  return name && name !== userId ? name : "";
}

export function replaceReportedMemoryIdentity(
  text: string,
  identity: { userId: string; userName: string },
  reportedName?: string
) {
  const staleName = validMemoryUserName(reportedName, identity.userId);
  if (!staleName || staleName === identity.userName) return text;
  const identitySuffix = `(?=\\s*[（(]\\s*QQ(?:号)?\\s*[:：#]?\\s*${escapeRegExp(identity.userId)}(?!\\d)\\s*[）)])`;
  return text.replace(new RegExp(`${escapeRegExp(staleName)}${identitySuffix}`, "gu"), identity.userName);
}

export function hasMemoryIdentity(
  text: string,
  identity: { userId: string; userName: string }
) {
  return findMemoryIdentityMatch(text, identity) != null;
}

function findMemoryIdentityMatch(
  text: string,
  identity: { userId: string; userName: string }
) {
  const markerPattern = new RegExp(
    `[（(]\\s*QQ(?:号)?\\s*[:：#]?\\s*${escapeRegExp(identity.userId)}(?!\\d)\\s*[）)]`,
    "gu"
  );
  for (const marker of text.matchAll(markerPattern)) {
    const markerStart = marker.index;
    const beforeMarker = text.slice(0, markerStart).replace(/\s+$/u, "");
    if (!beforeMarker.endsWith(identity.userName)) continue;
    const identityStart = beforeMarker.length - identity.userName.length;
    if (!hasMemoryIdentityLeftBoundary(beforeMarker.slice(0, identityStart))) continue;
    return { start: identityStart, end: markerStart + marker[0].length };
  }
  return undefined;
}

function hasMemoryIdentityLeftBoundary(leftContext: string) {
  if (!leftContext) return true;
  if (/[\s,，.。!！?？;；:：、"'“”‘’「」『』\[\]【】({（]$/u.test(leftContext)) return true;
  return /(?:认为|觉得|知道|了解|了解到|注意到|意识到|理解|相信|判断|看出|发现|在意|担心|期待|欣赏|认可|重视|愿意|乐意|支持|感谢|关心|关注|尊重|喜欢|信任|帮助|陪伴|保护|告诉|听到|看到|得知|提到|关于|涉及|对|和|与)$/u.test(leftContext);
}

export function hasOnlyTrustedMemoryIdentityMarkers(text: string, participants: BatchUserInfo[]) {
  const participantById = new Map(participants.map((participant) => [participant.userId, participant]));
  for (const marker of text.matchAll(/[（(]\s*QQ(?:号)?\s*[:：#]?\s*(\d{5,12})(?!\d)\s*[）)]/giu)) {
    const participant = participantById.get(marker[1]!);
    if (!participant) return false;
    const beforeMarker = text.slice(0, marker.index).replace(/\s+$/u, "");
    const trusted = trustedParticipantNames(participant).some((userName) => {
      if (!beforeMarker.endsWith(userName)) return false;
      const identityStart = beforeMarker.length - userName.length;
      return hasMemoryIdentityLeftBoundary(beforeMarker.slice(0, identityStart));
    });
    if (!trusted) return false;
  }
  return true;
}

export function hasUntrustedMemoryQq(fact: MemoryFactInput, participants: BatchUserInfo[]) {
  if (hasInvalidQqIdentity(fact.userId) || hasInvalidQqIdentity(fact.userIds)) return true;
  if (!participants.length) return false;
  const trustedIds = new Set(participants.map((participant) => participant.userId));
  const declaredIds = uniqueStrings([
    ...normalizeQqIds(fact.userIds),
    ...normalizeQqIds(fact.userId)
  ]);
  const referencedIds = [...fact.fact.matchAll(/[（(]\s*QQ(?:号)?\s*[:：#]?\s*(\d{5,12})(?!\d)\s*[）)]/giu)]
    .map((match) => match[1]!)
    .filter(Boolean);
  if ([...declaredIds, ...referencedIds].some((userId) => !trustedIds.has(userId))) return true;
  if (declaredIds.length && referencedIds.some((userId) => !declaredIds.includes(userId))) return true;
  if (!declaredIds.length && referencedIds.length) {
    return referencedIds.some((userId) => {
      const participant = participants.find((candidate) => candidate.userId === userId);
      return !participant || !trustedParticipantNames(participant).some((userName) => (
        hasMemoryIdentity(fact.fact, { userId, userName })
      ));
    });
  }
  return false;
}

export function resolveFactUsers(fact: MemoryFactInput, participants: BatchUserInfo[]) {
  if (!participants.length) return [];
  const participantById = new Map(participants.map((user) => [user.userId, user]));
  const explicitIds = uniqueStrings([
    ...normalizeQqIds(fact.userIds),
    ...normalizeQqIds(fact.userId)
  ]);
  const explicitUsers = explicitIds.flatMap((id) => {
    const user = participantById.get(id);
    return user ? [user] : [];
  });
  if (explicitIds.length) return explicitUsers;
  return participants.filter((user) => trustedParticipantNames(user).some((userName) => (
    hasMemoryIdentity(fact.fact, { userId: user.userId, userName })
  )));
}

const ROLE_COGNITION_PREFIX = /^我(?:也)?(?:认为|觉得|知道|了解到|注意到|意识到|理解|相信|判断|看出|发现|在意|担心|期待|欣赏|认可|重视|愿意|乐意|对)/u;
const ROLE_MEMORY_PREFIX = /^我(?:的(?:判断|看法|感受|担心|期待|打算|决定|关注)|(?:也)?(?:认为|觉得|知道|了解到|注意到|意识到|理解|相信|判断|看出|发现|在意|担心|期待|欣赏|认可|重视|愿意|乐意|会|将|要|打算|决定|继续|正在|已经|仍会|准备|希望|需要|对|和|与))/u;

export function isRoleFirstPersonMemory(
  text: string,
  identities: Array<{ userId: string; userName: string }>
) {
  return ROLE_MEMORY_PREFIX.test(text)
    && identities.some(({ userId, userName }) => text.includes(userId) || text.includes(userName))
    && !hasAmbiguousUserFirstPersonSubject(text, identities, ROLE_MEMORY_PREFIX);
}

export function isRoleFirstPersonProfile(
  text: string,
  identities: Array<{ userId: string; userName: string }>
) {
  return ROLE_COGNITION_PREFIX.test(text)
    && !hasAmbiguousUserFirstPersonSubject(text, identities, ROLE_COGNITION_PREFIX);
}

function hasAmbiguousUserFirstPersonSubject(
  text: string,
  identities: Array<{ userId: string; userName: string }>,
  prefixPattern: RegExp
) {
  const prefix = text.match(prefixPattern)?.[0];
  if (!prefix) return true;
  const matches = identities.flatMap((identity) => {
    const match = findMemoryIdentityMatch(text, identity);
    return match ? [{ identity, ...match }] : [];
  });
  if (/["'“‘「『][^"'“”‘’「」『』\r\n]{0,80}?(?:我(?:自己|本人)?|自己|本人|\bI\b)/iu.test(text)) {
    return true;
  }
  if (matches.some(({ end }) => {
    const tail = text.slice(end);
    const firstPerson = "(?:其实|当时|现在|后来|目前)?\\s*(?:我(?:自己|本人)?|自己|本人|I\\b)";
    const speech = new RegExp(`^[^。！？!?；;\\n]{0,24}?(?:说(?:道)?|讲(?:道)?|表示|提到|自述|回答|声称|写道|解释(?:道)?|回应(?:道)?|回复(?:道)?|转述)\\s*(?:(?:[:：]\\s*)[\"'“‘「『]?\\s*${firstPerson}|(?:自己|本人))`, "iu");
    const tell = new RegExp(`^[^。！？!?；;\\n]{0,24}?告诉(?:了)?我\\s*[:：]\\s*[\"'“‘「『]?\\s*${firstPerson}`, "iu");
    return speech.test(tail) || tell.test(tail);
  })) {
    return true;
  }
  if (matches.some(({ end }) => /^\s*是我的(?:昵称|名字|姓名|身份)/u.test(text.slice(end)))) {
    return true;
  }

  const firstIdentityStart = matches.reduce<number | undefined>((earliest, match) => (
    earliest == null || match.start < earliest ? match.start : earliest
  ), undefined);
  const beforeIdentity = text.slice(prefix.length, firstIdentityStart ?? text.length).trim();
  const hasRelationalRoleSubject = matches.some(({ start }) => (
    /^我(?:自己|本人)?(?:和|与|对)\s*$/u.test(text.slice(prefix.length, start).trim())
  ));
  if (hasRelationalRoleSubject) return false;
  return /^(?:我(?:自己|本人)?|自己|本人)/u.test(beforeIdentity)
    || /(?:我的|自己|本人)/u.test(beforeIdentity);
}
