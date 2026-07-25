import path from "node:path";
import type {
  BashAccessMode,
  BashAuditResult,
  BashExecutionBackend,
  BashPathAccess,
  BashAuditRisk
} from "./bashAudit.js";

export interface RestrictedBashInvocation {
  executable: string;
  args: string[];
  pathOperands: RestrictedPathOperand[];
}

export type RestrictedPathRole = "read-file" | "read-entry" | "write-file" | "create-directory" | "delete-file" | "delete-directory";

export interface RestrictedPathOperand {
  path: string;
  role: RestrictedPathRole;
}

export interface BashPolicyInput {
  command: string;
  backend: BashExecutionBackend;
  accessMode: BashAccessMode;
  strictMode: boolean;
  workbenchRoot: string;
  addressableWorkbenches?: readonly BashAddressableWorkbench[];
  audit: BashAuditResult;
}

export interface BashAddressableWorkbench {
  root: string;
  writable: boolean;
}

export interface BashPolicyResult {
  decision: "allow" | "confirm" | "deny";
  risk: BashAuditRisk;
  reason: string;
  outsideAccesses: BashPathAccess[];
  restrictedInvocation?: RestrictedBashInvocation;
}

interface RestrictedCommandSpec {
  executable: string;
  shortFlags?: string;
  longFlags?: readonly string[];
  valueOptions?: Readonly<Record<string, (value: string) => boolean>>;
  defaultMode?: string;
  operandMode: "path" | "text" | "grep";
  minOperands?: number;
  maxOperands?: number;
  pathSemantics?: "read-files" | "read-entries" | "copy-file" | "move-file" | "write-files" | "create-directories" | "delete-files" | "delete-directories";
}

interface RestrictedParseResult {
  invocation?: RestrictedBashInvocation;
  reason: string;
}

const decimal = (value: string) => /^\d+$/.test(value);
const byteCount = (value: string) => /^\d+[bkmgtpezy]?$/i.test(value);
const safeDirectoryMode = (value: string) => {
  if (!/^0?[0-7]{3}$/.test(value)) return false;
  const mode = Number.parseInt(value, 8);
  return (mode & 0o7022) === 0;
};

const RESTRICTED_COMMANDS: Readonly<Record<string, RestrictedCommandSpec>> = {
  base64: command("/usr/bin/base64", "path", { shortFlags: "di", longFlags: ["decode", "ignore-garbage"], minOperands: 1, maxOperands: 1, pathSemantics: "read-files" }),
  basename: command("/usr/bin/basename", "path", { minOperands: 1, maxOperands: 2 }),
  cat: command("/usr/bin/cat", "path", { shortFlags: "AbEnstTuv", longFlags: ["show-all", "number-nonblank", "show-ends", "number", "squeeze-blank", "show-tabs", "show-nonprinting"], minOperands: 1, pathSemantics: "read-files" }),
  cksum: command("/usr/bin/cksum", "path", { minOperands: 1, pathSemantics: "read-files" }),
  cmp: command("/usr/bin/cmp", "path", { shortFlags: "ls", longFlags: ["verbose", "quiet", "silent"], minOperands: 2, maxOperands: 2, pathSemantics: "read-files" }),
  cp: command("/usr/bin/cp", "path", { shortFlags: "finTv", longFlags: ["force", "interactive", "no-clobber", "no-target-directory", "verbose"], minOperands: 2, maxOperands: 2, pathSemantics: "copy-file" }),
  diff: command("/usr/bin/diff", "path", { shortFlags: "abBNqsuw", longFlags: ["text", "ignore-space-change", "ignore-blank-lines", "new-file", "brief", "report-identical-files", "unified", "ignore-all-space"], minOperands: 2, maxOperands: 2, pathSemantics: "read-files" }),
  dirname: command("/usr/bin/dirname", "path", { minOperands: 1 }),
  echo: command("/usr/bin/echo", "text", { shortFlags: "n" }),
  false: command("/usr/bin/false", "text", { maxOperands: 0 }),
  grep: command("/usr/bin/grep", "grep", { shortFlags: "EFGHhilLnoqsvwx", longFlags: ["extended-regexp", "fixed-strings", "basic-regexp", "with-filename", "no-filename", "ignore-case", "files-with-matches", "files-without-match", "line-number", "only-matching", "quiet", "no-messages", "invert-match", "word-regexp", "line-regexp"], minOperands: 2, pathSemantics: "read-files" }),
  head: command("/usr/bin/head", "path", { shortFlags: "qv", longFlags: ["quiet", "silent", "verbose"], valueOptions: { "-n": decimal, "--lines": decimal, "-c": byteCount, "--bytes": byteCount }, minOperands: 1, pathSemantics: "read-files" }),
  ls: command("/usr/bin/ls", "path", { shortFlags: "1AaFdhilnrStu", longFlags: ["all", "almost-all", "classify", "directory", "human-readable", "inode", "numeric-uid-gid", "reverse"], pathSemantics: "read-entries" }),
  md5sum: checksum("md5sum"),
  mkdir: command("/usr/bin/mkdir", "path", {
    shortFlags: "v",
    longFlags: ["verbose"],
    valueOptions: { "-m": safeDirectoryMode, "--mode": safeDirectoryMode },
    defaultMode: "700",
    minOperands: 1,
    pathSemantics: "create-directories"
  }),
  mv: command("/usr/bin/mv", "path", { shortFlags: "finTv", longFlags: ["force", "interactive", "no-clobber", "no-target-directory", "verbose"], minOperands: 2, maxOperands: 2, pathSemantics: "move-file" }),
  printf: command("/usr/bin/printf", "text", { minOperands: 1 }),
  pwd: command("/usr/bin/pwd", "text", { shortFlags: "LP", longFlags: ["logical", "physical"], maxOperands: 0 }),
  rm: command("/usr/bin/rm", "path", { shortFlags: "fiv", longFlags: ["force", "interactive", "verbose"], minOperands: 1, pathSemantics: "delete-files" }),
  rmdir: command("/usr/bin/rmdir", "path", { shortFlags: "v", longFlags: ["verbose", "ignore-fail-on-non-empty"], minOperands: 1, pathSemantics: "delete-directories" }),
  sha1sum: checksum("sha1sum"),
  sha224sum: checksum("sha224sum"),
  sha256sum: checksum("sha256sum"),
  sha384sum: checksum("sha384sum"),
  sha512sum: checksum("sha512sum"),
  stat: command("/usr/bin/stat", "path", { shortFlags: "f", longFlags: ["file-system"], minOperands: 1, pathSemantics: "read-files" }),
  tail: command("/usr/bin/tail", "path", { shortFlags: "qv", longFlags: ["quiet", "silent", "verbose"], valueOptions: { "-n": decimal, "--lines": decimal, "-c": byteCount, "--bytes": byteCount }, minOperands: 1, pathSemantics: "read-files" }),
  touch: command("/usr/bin/touch", "path", { shortFlags: "acm", longFlags: ["no-create"], minOperands: 1, pathSemantics: "write-files" }),
  true: command("/usr/bin/true", "text", { maxOperands: 0 }),
  wc: command("/usr/bin/wc", "path", { shortFlags: "cLlmw", longFlags: ["bytes", "max-line-length", "lines", "chars", "words"], minOperands: 1, pathSemantics: "read-files" })
};

export const WORKSPACE_BASH_ADMIN_EXECUTABLE = "/bin/bash";
export const WORKSPACE_BASH_RESTRICTED_EXECUTABLES = Object.freeze(
  [...new Set(Object.values(RESTRICTED_COMMANDS).map((spec) => spec.executable))].sort()
);

const ALWAYS_DENIED_COMMANDS = /(^|[;&|()\s])(?:\/[^\s;&|()]+\/)?(?:sudo|su|doas|mount|umount|mkfs(?:\.[\w-]+)?|fdisk|parted|losetup|swapon|swapoff|shutdown|reboot|poweroff|halt)(?=$|[;&|()\s])/i;
const READ_ONLY_SHARED_ROOTS = ["/skills", "/mcp"] as const;

export function evaluateBashPolicy(input: BashPolicyInput): BashPolicyResult {
  const permanentReason = permanentDenialReason(input.command);
  if (permanentReason) return denied("high", permanentReason, input.audit.outsideAccesses);

  let restrictedInvocation: RestrictedBashInvocation | undefined;
  if (input.accessMode === "restricted") {
    const restricted = parseRestrictedCommand(input.command);
    if (!restricted.invocation) {
      return denied(maxRisk(input.audit.risk, "medium"), restricted.reason, input.audit.outsideAccesses);
    }
    restrictedInvocation = restricted.invocation;
  }

  if (input.audit.decision === "deny" || input.audit.risk === "high") {
    return denied(input.audit.risk, input.audit.summary, input.audit.outsideAccesses);
  }

  const normalized = normalizeOutsideAccesses(
    input.audit.outsideAccesses,
    input.workbenchRoot,
    input.addressableWorkbenches
  );
  if (normalized.invalidReason) {
    return denied(maxRisk(input.audit.risk, "medium"), normalized.invalidReason, []);
  }
  const outsideAccesses = normalized.accesses;
  const auditorRequiresConfirmation = input.audit.decision === "confirm";
  if (auditorRequiresConfirmation && !outsideAccesses.length) {
    return denied(maxRisk(input.audit.risk, "medium"), "审计要求确认，但没有可绑定的合法绝对外部路径。", []);
  }

  const outsideWorkbench = auditorRequiresConfirmation || (
    input.audit.outsideWorkbench && !normalized.onlyRecognizedWorkbenchAccesses
  ) ||
    outsideAccesses.length > 0 || hasParentTraversal(input.command);
  if (!outsideWorkbench) {
    return {
      decision: "allow",
      risk: input.audit.risk,
      reason: input.audit.summary,
      outsideAccesses: [],
      restrictedInvocation
    };
  }

  if (input.backend === "docker" || input.accessMode !== "admin") {
    return denied(
      maxRisk(input.audit.risk, "medium"),
      "Docker Bash 只能写入当前 Agent 的 workbench，并只读访问 Skill 与 MCP 配置。",
      outsideAccesses
    );
  }

  if (!outsideAccesses.length) {
    return denied(maxRisk(input.audit.risk, "medium"), "审计未返回可绑定的 workbench 外路径。", []);
  }

  const mutatesOutside = outsideAccesses.some((access) => access.access === "write" || access.access === "delete");
  if (mutatesOutside) {
    return denied(maxRisk(input.audit.risk, "medium"), "Phase A 只允许一次性确认读取既存的 workbench 外文件。", outsideAccesses);
  }

  return {
    decision: "confirm",
    risk: maxRisk(input.audit.risk, mutatesOutside ? "medium" : "low"),
    reason: input.audit.summary,
    outsideAccesses
  };
}

export function permanentDenialReason(command: string) {
  const canonical = canonicalSafetyCommand(command);
  if (hasStartedSelfRecursiveFunction(canonical)) {
    return "永久拒绝 fork bomb。";
  }
  if (hasVariableWrappedDestructiveCommand(canonical)) return "永久拒绝变量包装的递归删除命令。";
  if (ALWAYS_DENIED_COMMANDS.test(canonical)) return "永久拒绝提权、挂载、磁盘或关机命令。";
  if (/(?:^|[;&|()\s])(?:\/[^\s;&|()]+\/)?dd\b[^\n;&|]*\bof\s*=\s*\/dev\//i.test(canonical)) {
    return "永久拒绝直接写入设备。";
  }
  if (dangerousRecursiveRemoval(canonical)) return "永久拒绝递归删除根目录、当前目录或通配符目标。";
  if (dangerousFindDelete(canonical)) return "永久拒绝从根目录或 workbench 根开始批量删除。";
  return "";
}

export function restrictedDenialReason(command: string) {
  return parseRestrictedCommand(command).reason;
}

export function parseRestrictedCommand(command: string): RestrictedParseResult {
  const parsed = parseSingleArgv(command);
  if (!parsed.argv) return { reason: parsed.reason };
  const [name, ...args] = parsed.argv;
  if (!name || /^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) {
    return { reason: "受限 Bash 不允许环境变量赋值。" };
  }
  if (name.includes("/")) return { reason: "受限 Bash 只允许固定命令名，不允许路径可执行文件。" };
  const spec = RESTRICTED_COMMANDS[name];
  if (!spec) return { reason: `受限 Bash 不允许命令：${name}` };
  const validation = validateRestrictedArguments(args, spec);
  if (validation.reason) return { reason: validation.reason };
  return {
    invocation: {
      executable: spec.executable,
      args: normalizedRestrictedArguments(args, spec, validation.modeOptionConsumed),
      pathOperands: buildRestrictedPathOperands(validation.pathOperands, spec.pathSemantics)
    },
    reason: ""
  };
}

function parseSingleArgv(command: string): { argv?: string[]; reason: string } {
  if (/[\u0000\r\n;&|<>`\\$*?\[\]{}()!#~]/.test(command)) {
    return { reason: "受限 Bash 不允许 shell 连接、重定向、展开、通配符或转义。" };
  }
  const argv: string[] = [];
  let token = "";
  let quote: "'" | "\"" | "" = "";
  let started = false;
  for (const character of command) {
    if (quote) {
      if (character === quote) quote = "";
      else token += character;
      started = true;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) argv.push(token);
      token = "";
      started = false;
      continue;
    }
    token += character;
    started = true;
  }
  if (quote) return { reason: "受限 Bash 拒绝未闭合的引号。" };
  if (started) argv.push(token);
  if (!argv.length) return { reason: "受限 Bash 没有识别到可执行的文件命令。" };
  return { argv, reason: "" };
}

function validateRestrictedArguments(args: string[], spec: RestrictedCommandSpec) {
  const operands: string[] = [];
  let options = true;
  let modeOptionConsumed = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (options && argument === "--") {
      options = false;
      continue;
    }
    if (options && argument.startsWith("--")) {
      const separator = argument.indexOf("=");
      const option = separator >= 0 ? argument.slice(0, separator) : argument;
      const inlineValue = separator >= 0 ? argument.slice(separator + 1) : undefined;
      const validator = spec.valueOptions?.[option];
      if (validator) {
        const value = inlineValue ?? args[++index];
        if (value == null || !validator(value)) return { reason: `受限 Bash 的参数无效：${option}`, pathOperands: [] };
        if (option === "--mode") modeOptionConsumed = true;
        continue;
      }
      if (inlineValue !== undefined || !spec.longFlags?.includes(option.slice(2))) {
        return { reason: `受限 Bash 不允许参数：${argument}`, pathOperands: [] };
      }
      continue;
    }
    if (options && argument.startsWith("-") && argument !== "-") {
      const validator = spec.valueOptions?.[argument];
      if (validator) {
        const value = args[++index];
        if (value == null || !validator(value)) return { reason: `受限 Bash 的参数无效：${argument}`, pathOperands: [] };
        if (argument === "-m") modeOptionConsumed = true;
        continue;
      }
      if (!spec.shortFlags || !argument.slice(1).split("").every((flag) => spec.shortFlags?.includes(flag))) {
        return { reason: `受限 Bash 不允许参数：${argument}`, pathOperands: [] };
      }
      continue;
    }
    operands.push(argument);
  }
  if (operands.length < (spec.minOperands ?? 0) || operands.length > (spec.maxOperands ?? Number.POSITIVE_INFINITY)) {
    return { reason: "受限 Bash 的文件参数数量无效。", pathOperands: [] };
  }
  const paths = spec.operandMode === "grep" ? operands.slice(1) : spec.operandMode === "path" ? operands : [];
  if (paths.some((operand) => !isSafeRelativePath(operand))) {
    return { reason: "受限 Bash 的文件参数必须是 workbench 相对路径。", pathOperands: [] };
  }
  return { reason: "", pathOperands: paths, modeOptionConsumed };
}

function normalizedRestrictedArguments(
  args: string[],
  spec: RestrictedCommandSpec,
  modeOptionConsumed: boolean | undefined
) {
  if (!spec.defaultMode || modeOptionConsumed) return args;
  return [`--mode=${spec.defaultMode}`, ...args];
}

function buildRestrictedPathOperands(
  operands: string[],
  semantics: RestrictedCommandSpec["pathSemantics"]
): RestrictedPathOperand[] {
  if (!semantics) return [];
  if (semantics === "read-entries" && operands.length === 0) {
    return [{ path: ".", role: "read-entry" }];
  }
  if (semantics === "copy-file" || semantics === "move-file") {
    return [
      { path: operands[0]!, role: "read-file" },
      { path: operands[1]!, role: "write-file" }
    ];
  }
  const roles: Record<Exclude<NonNullable<RestrictedCommandSpec["pathSemantics"]>, "copy-file" | "move-file">, RestrictedPathRole> = {
    "read-files": "read-file",
    "read-entries": "read-entry",
    "write-files": "write-file",
    "create-directories": "create-directory",
    "delete-files": "delete-file",
    "delete-directories": "delete-directory"
  };
  const role = roles[semantics];
  return operands.map((operand) => ({ path: operand, role }));
}

function dangerousRecursiveRemoval(command: string) {
  if (/\bxargs\b[^\n]*\brm\b[^\n]*(?:--recursive|-[A-Za-z]*[rR][A-Za-z]*)/i.test(command)) return true;
  for (const match of command.matchAll(/(?:^|[;&|()\s])(?:\/[^\s;&|()]+\/)?rm\s+([^;&|\n]*)/gi)) {
    const tokens = safetyWords(match[1] ?? "");
    const recursive = tokens.some((token) => /^-[^-]*[rR]/.test(token) || token === "--recursive");
    if (!recursive) continue;
    const targets = tokens.filter((token) => token !== "--" && !token.startsWith("-"));
    if (!targets.length && /\bxargs\b/i.test(command.slice(0, match.index))) return true;
    if (targets.some(isDangerousRemovalTarget)) return true;
  }
  return false;
}

function dangerousFindDelete(command: string) {
  for (const match of command.matchAll(/(?:^|[;&|()\s])(?:\/[^\s;&|()]+\/)?find\s+([^;&|\n]*)/gi)) {
    const tokens = safetyWords(match[1] ?? "");
    const deleteIndex = tokens.indexOf("-delete");
    if (deleteIndex < 0) continue;
    const roots: string[] = [];
    for (let index = 0; index < deleteIndex; index += 1) {
      const token = tokens[index] ?? "";
      if (["-H", "-L", "-P"].includes(token) || /^-O\d+$/.test(token)) continue;
      if (token === "-D") {
        index += 1;
        continue;
      }
      if (token.startsWith("-") || token === "!" || token === "(") break;
      roots.push(token);
    }
    if (!roots.length) return true;
    if (roots.some((root) => {
      const normalized = path.posix.normalize(root.replace(/\/+$/, "") || "/");
      return normalized === "/" || normalized === "." || normalized === ".." || normalized === "/workbench";
    })) return true;
  }
  return false;
}

function isDangerousRemovalTarget(target: string) {
  const normalized = path.posix.normalize(target.replace(/\/+$/, "") || "/");
  return normalized === "/" || normalized === "." || normalized === ".." || normalized === "/workbench" ||
    /[*?\[]/.test(target) || /\$\(|`|\$\{|\$[A-Za-z_]/.test(target);
}

function canonicalSafetyCommand(command: string) {
  return command.replace(/\\([\s\S])/g, "$1").replace(/["']/g, "");
}

function hasStartedSelfRecursiveFunction(command: string) {
  const definitions = [
    /(?:^|[;&|()\s])function\s+([:A-Za-z_][A-Za-z0-9_]*)(?:\s*\(\s*\))?\s*\{([\s\S]*?)\}\s*;?\s*\1(?=$|[;&|()\s])/g,
    /(?:^|[;&|()\s])([:A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{([\s\S]*?)\}\s*;?\s*\1(?=$|[;&|()\s])/g
  ];
  for (const pattern of definitions) {
    for (const match of command.matchAll(pattern)) {
      const name = match[1] ?? "";
      const body = match[2] ?? "";
      if (new RegExp(`(?:^|[;&|()\\s])${escapeRegExp(name)}(?=$|[;&|()\\s])`).test(body)) return true;
    }
  }
  return false;
}

function hasVariableWrappedDestructiveCommand(command: string) {
  for (const match of command.matchAll(
    /(?:^|[;&|()\s])([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:\/[^\s;&|()]+\/)?(?:rm|find)(?=$|[;&|()\s])/gi
  )) {
    const name = match[1] ?? "";
    const remainder = command.slice((match.index ?? 0) + match[0].length);
    const expansion = new RegExp(`(?:^|[;&|()\\s])\\$(?:\\{${escapeRegExp(name)}\\}|${escapeRegExp(name)})(?=$|[;&|()\\s])`);
    if (expansion.test(remainder)) return true;
  }
  return false;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safetyWords(value: string) {
  return value.trim().split(/\s+/).filter(Boolean);
}

function hasParentTraversal(command: string) {
  return /(^|[\s:=/])\.\.(?:[\s/]|$)/.test(command);
}

function normalizeOutsideAccesses(
  accesses: BashPathAccess[],
  workbenchRoot: string,
  addressableWorkbenches: readonly BashAddressableWorkbench[] = []
) {
  const normalized = new Map<string, BashPathAccess>();
  const validatedWorkbenches = normalizeAddressableWorkbenches(addressableWorkbenches);
  if (validatedWorkbenches.invalidReason) {
    return {
      accesses: [],
      invalidReason: validatedWorkbenches.invalidReason,
      onlyRecognizedWorkbenchAccesses: false
    };
  }
  let recognizedWorkbenchAccessCount = 0;
  for (const access of accesses) {
    const rawPath = access.path.trim();
    if (!rawPath || rawPath.includes("\0") || !path.isAbsolute(rawPath)) {
      return invalidOutsideAccess("审计返回了非绝对或无效的 workbench 外路径。");
    }
    if (rawPath.split(/[\\/]+/).includes("..")) {
      return invalidOutsideAccess("审计返回了包含父目录跳转的 workbench 外路径。");
    }
    if (isReadOnlySharedPath(rawPath)) {
      if (access.access !== "read") {
        return invalidOutsideAccess("Skill 与 MCP 共享配置只允许读取。");
      }
      recognizedWorkbenchAccessCount += 1;
      continue;
    }
    const addressable = validatedWorkbenches.workbenches.find((workbench) => (
      isWithinPath(workbench.root, rawPath)
    ));
    if (addressable) {
      if (!addressable.writable && access.access !== "read") {
        return invalidOutsideAccess("Native workbench 只读投影不允许写入或删除。");
      }
      recognizedWorkbenchAccessCount += 1;
      continue;
    }
    if (isWorkbenchPath(rawPath, workbenchRoot)) {
      recognizedWorkbenchAccessCount += 1;
      continue;
    }
    const resolved = path.resolve(rawPath);
    if (
      resolved === "/"
      || resolved.split(path.sep).filter(Boolean).length < 2
      || isAncestorPath(resolved, workbenchRoot)
      || validatedWorkbenches.workbenches.some((workbench) => isAncestorPath(resolved, workbench.root))
    ) {
      return invalidOutsideAccess("审计返回了根目录、过宽目录或 workbench 父目录。");
    }
    const key = `${access.access}\0${resolved}`;
    normalized.set(key, { path: resolved, access: access.access });
  }
  return {
    accesses: [...normalized.values()],
    invalidReason: "",
    onlyRecognizedWorkbenchAccesses: (
      accesses.length > 0 && recognizedWorkbenchAccessCount === accesses.length
    )
  };
}

function normalizeAddressableWorkbenches(workbenches: readonly BashAddressableWorkbench[]) {
  const normalized: BashAddressableWorkbench[] = [];
  for (const workbench of workbenches) {
    if (
      !workbench
      || typeof workbench.root !== "string"
      || !path.isAbsolute(workbench.root)
      || workbench.root.includes("\0")
      || typeof workbench.writable !== "boolean"
    ) {
      return {
        workbenches: [],
        invalidReason: "可寻址 workbench 边界无效。"
      };
    }
    const root = path.resolve(workbench.root);
    if (root === "/" || root.split(path.sep).filter(Boolean).length < 1) {
      return {
        workbenches: [],
        invalidReason: "可寻址 workbench 边界无效。"
      };
    }
    normalized.push({ root, writable: workbench.writable });
  }
  normalized.sort((left, right) => right.root.length - left.root.length);
  return { workbenches: normalized, invalidReason: "" };
}

function invalidOutsideAccess(invalidReason: string) {
  return {
    accesses: [] as BashPathAccess[],
    invalidReason,
    onlyRecognizedWorkbenchAccesses: false
  };
}

function isReadOnlySharedPath(candidate: string) {
  const normalized = path.posix.normalize(candidate);
  return READ_ONLY_SHARED_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function isWorkbenchPath(candidate: string, workbenchRoot: string) {
  if (candidate === "/workbench" || candidate.startsWith("/workbench/")) return true;
  return isWithinPath(workbenchRoot, candidate);
}

function isWithinPath(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function isAncestorPath(candidate: string, workbenchRoot: string) {
  const relative = path.relative(candidate, path.resolve(workbenchRoot));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isSafeRelativePath(candidate: string) {
  if (!candidate || candidate === "-" || path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || candidate.includes("\0")) return false;
  const segments = candidate.split(/[\\/]+/);
  return !segments.includes("..") && !segments.some((segment) => segment === "") && !/[*?\[]/.test(candidate);
}

function checksum(name: string): RestrictedCommandSpec {
  return command(`/usr/bin/${name}`, "path", { minOperands: 1, pathSemantics: "read-files" });
}

function command(
  executable: string,
  operandMode: RestrictedCommandSpec["operandMode"],
  options: Omit<RestrictedCommandSpec, "executable" | "operandMode"> = {}
): RestrictedCommandSpec {
  return { executable, operandMode, ...options };
}

function denied(risk: BashAuditRisk, reason: string, outsideAccesses: BashPathAccess[]): BashPolicyResult {
  return { decision: "deny", risk, reason, outsideAccesses };
}

function maxRisk(left: BashAuditRisk, right: BashAuditRisk): BashAuditRisk {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  return rank[left] >= rank[right] ? left : right;
}
