interface McpArgumentAnalysis {
  credential: boolean;
  unsafePath: boolean;
  decodeLimitExceeded: boolean;
}

export const SAFE_MCP_COMMAND_PATTERN = /^\/(?:usr\/(?:local\/)?bin|bin)\/[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
export const MCP_RUNTIME_INTERPRETERS = [
  "bash", "dash", "deno", "env", "fish", "java", "ksh", "node", "nodejs",
  "perl", "php", "python", "python3", "ruby", "sh", "zsh"
] as const;

const runtimeInterpreters = new Set<string>(MCP_RUNTIME_INTERPRETERS);

export function isSafeMcpCommandPath(command: string) {
  return SAFE_MCP_COMMAND_PATTERN.test(command);
}

export function analyzeMcpArgument(value: string): McpArgumentAnalysis {
  const decoded = decodedCredentialCandidates(value);
  return {
    credential: decoded.candidates.some((candidate) => candidateContainsCredential(candidate)),
    unsafePath: decoded.candidates.some((candidate) => isUnsafeMcpArgumentPath(candidate)),
    decodeLimitExceeded: decoded.limitExceeded
  };
}

export function isUnsafeMcpCommand(command: string) {
  const segments = command.split("/").filter(Boolean);
  const executable = segments.at(-1) ?? "";
  const normalizedExecutable = executable.toLowerCase();
  if (runtimeInterpreters.has(normalizedExecutable)
    || /^(?:node|nodejs|python|perl|ruby|php|java)\d+(?:\.\d+)*$/u.test(normalizedExecutable)) {
    return true;
  }
  const dynamicSegments = command.startsWith("/opt/")
    ? [segments[1] ?? "", executable]
    : [executable];
  return dynamicSegments.some((segment) => {
    if (!segment) return true;
    const decoded = decodedCredentialCandidates(segment);
    return decoded.limitExceeded || decoded.candidates.some((candidate) =>
      candidateContainsCredential(candidate) || looksLikeOpaqueExecutableSegment(candidate));
  });
}

function candidateContainsCredential(candidate: string) {
  if (/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/u.test(candidate) ||
      /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/u.test(candidate) ||
      /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/u.test(candidate) ||
      /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/u.test(candidate)) {
    return true;
  }
  return looksLikeOpaqueSecret(candidate) ||
    /(?:^|[^a-z0-9])(?:authorization|bearer|basic[ \t]+[A-Za-z0-9+/=]+|token|secret|password|passwd|api[-_]?key|access[-_]?token|client[-_]?secret|private[-_]?key|cookie|netrc|cert|key)(?:$|[^a-z0-9])/iu.test(candidate) ||
    /(?:^|\s)(?:--header|-H|--cookie|--netrc|--cert|--key)(?:\s|=|$)/u.test(candidate) ||
    /[?&](?:access_token|token|api_key|apikey|key|secret|password)=/iu.test(candidate);
}

function isUnsafeMcpArgumentPath(value: string) {
  for (const fragment of argumentFragments(value)) {
    if (/^https?:\/\//iu.test(fragment)) continue;
    if (/^(?:file:|[A-Za-z]:[\\/]|\\\\|\/\/|~[\\/])/iu.test(fragment) ||
        /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(fragment)) {
      return true;
    }
    if (fragment.startsWith("/")) {
      if (fragment === "/workbench") continue;
      if (!fragment.startsWith("/workbench/")) return true;
      if (fragment.slice("/workbench/".length).split("/").some((segment) =>
        !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/u.test(segment))) {
        return true;
      }
    }
  }
  return false;
}

function decodedCredentialCandidates(value: string) {
  const maximumCandidates = 24;
  const maximumDepth = 4;
  const queue = [{ value, depth: 0 }];
  const candidates = new Set<string>();
  let limitExceeded = false;
  while (queue.length > 0) {
    const current = queue.shift()!;
    const candidate = current.value;
    if (candidates.has(candidate)) continue;
    if (candidates.size >= maximumCandidates) {
      limitExceeded = true;
      break;
    }
    candidates.add(candidate);
    const derived = argumentFragments(candidate).filter((fragment) => fragment !== candidate);
    if (candidate.length <= 4_096) {
      try {
        const percentDecoded = decodeURIComponent(candidate);
        if (percentDecoded !== candidate) derived.push(percentDecoded);
      } catch { /* malformed encoding is rejected by the auditable argument grammar */ }
      const base64Decoded = decodeBase64Utf8(candidate);
      if (base64Decoded != null && base64Decoded !== candidate) derived.push(base64Decoded);
    }
    for (const next of derived) {
      if (!next || candidates.has(next)) continue;
      if (current.depth >= maximumDepth) {
        limitExceeded = true;
      } else {
        queue.push({ value: next, depth: current.depth + 1 });
      }
    }
  }
  return { candidates: [...candidates], limitExceeded };
}

function argumentFragments(value: string) {
  const fragments = new Set([value]);
  let lastSeparator = -1;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "=" || value[index] === ",") {
      const suffix = value.slice(index + 1);
      if (suffix) fragments.add(suffix);
      lastSeparator = index;
    } else if (value[index] === ":") {
      const scheme = value.slice(lastSeparator + 1, index);
      const suffix = value.slice(index + 1);
      if (suffix && !/^https?$/iu.test(scheme)) fragments.add(suffix);
      lastSeparator = index;
    }
  }
  return [...fragments];
}

function decodeBase64Utf8(value: string) {
  if (value.length < 16 || value.length > 4_096 || !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value)) return null;
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  if (padded.length % 4 !== 0) return null;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function looksLikeOpaqueSecret(value: string) {
  if (value.length < 24 || value.length > 2_048 || value.startsWith("/workbench/") ||
      /^https?:\/\//iu.test(value) ||
      /^--[a-z0-9-]+=(?:https?:\/\/|\/workbench(?:\/|$)|[a-z0-9._-]{1,64}$)/iu.test(value) ||
      value.startsWith("--") && /^[a-z0-9-]+$/u.test(value)) {
    return false;
  }
  if (/^[a-f0-9]{32,}$/iu.test(value) ||
      /^(?=[A-Z2-7]{32,}={0,6}$)(?=.*[2-7])[A-Z2-7]+=*$/u.test(value) ||
      /^(?=[a-z2-7]{32,}={0,6}$)(?=.*[2-7])[a-z2-7]+=*$/u.test(value)) {
    return true;
  }
  const distinct = new Set(value).size;
  if (/^[A-Za-z0-9]+$/u.test(value) && value.length >= 32 && distinct <= 6) return true;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u]
    .filter((pattern) => pattern.test(value)).length;
  if (classes < 2) return false;
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 4.1;
}

function looksLikeOpaqueExecutableSegment(value: string) {
  if (/^[a-f0-9]{32,}$/iu.test(value)) return true;
  if (/^(?=[A-Z2-7]{32,}$)(?=.*[2-7])[A-Z2-7]+$/u.test(value) ||
      /^(?=[a-z2-7]{32,}$)(?=.*[2-7])[a-z2-7]+$/u.test(value)) return true;
  return value.length >= 48 && /^[A-Za-z0-9]+$/u.test(value) && new Set(value).size <= 8;
}
