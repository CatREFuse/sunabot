const EXPECTED_PROCESS_SOURCES = new Set(["current-release", "current-runtime", "component"]);

export function evaluateRuntimeSnapshot(snapshot) {
  const errors = [];
  const warnings = [];
  const expectation = snapshot.expectation === "running" ? "running" : "free";
  const expectedWorkspace = comparablePath(
    snapshot.workspace?.expected?.realPath ??
    snapshot.workspace?.expected?.path ??
    snapshot.workspace?.identity?.realPath ??
    snapshot.workspace?.identity?.path
  );
  const localDomain = String(snapshot.domain ?? "unknown");

  const addError = (code, message, details) => {
    errors.push({ code, message, ...(details ? { details } : {}) });
  };
  const addWarning = (code, message, details) => {
    warnings.push({ code, message, ...(details ? { details } : {}) });
  };

  checkRelease(snapshot.release ?? {}, expectation, addError);
  checkWorkspace(snapshot.workspace ?? {}, expectation, addError);

  const databases = (snapshot.databases ?? []).map(publicDatabase);
  checkDatabases(databases, expectation, addError);

  const listenerOwners = uniqueProcesses(snapshot.listener?.owners ?? []).map(publicProcess);
  const listenerProxies = uniqueProcesses(snapshot.listener?.proxies ?? []).map(publicProcess);
  const listener = {
    host: String(snapshot.listener?.host ?? "127.0.0.1"),
    port: Number(snapshot.listener?.port ?? 0),
    listening: Boolean(snapshot.listener?.listening),
    owners: listenerOwners,
    proxies: listenerProxies
  };
  checkListener({
    listener,
    expectation,
    localDomain,
    expectedWorkspace,
    releaseVersion: snapshot.release?.contractVersion
  }, addError, addWarning);

  const onebotCandidates = uniqueProcesses(snapshot.onebot?.candidates ?? []).map(publicProcess);
  const onebotConnections = (snapshot.onebot?.connections ?? []).map(publicConnection);
  const onebot = {
    candidates: onebotCandidates,
    connections: onebotConnections
  };
  checkOneBot({
    onebot,
    expectation,
    localDomain,
    expectedWorkspace,
    releaseVersion: snapshot.release?.contractVersion
  }, addError, addWarning);

  for (const warning of snapshot.collectionWarnings ?? []) {
    addWarning(
      safeCode(warning?.code, "COLLECTION_INCOMPLETE"),
      safeString(warning?.message) ?? "runtime doctor 的部分事实无法采集。"
    );
  }

  return {
    ok: errors.length === 0,
    expectation,
    platform: String(snapshot.platform ?? process.platform),
    domain: localDomain,
    release: publicRelease(snapshot.release ?? {}),
    workspace: publicWorkspace(snapshot.workspace ?? {}),
    databases,
    listener,
    onebot,
    errors,
    warnings
  };
}

function checkRelease(release, expectation, addError) {
  if (!release.root?.exists || release.root?.kind !== "directory") {
    addError("RELEASE_ROOT_INVALID", "release root 不存在或不是目录。");
  }
  if (!release.contractVersion || !release.packageVersion || release.contractVersion !== release.packageVersion) {
    addError("RELEASE_VERSION_MISMATCH", "runtime contract 与 package release version 不一致。", {
      contractVersion: safeString(release.contractVersion),
      packageVersion: safeString(release.packageVersion)
    });
  }
  if (!release.expectedNodeVersion || !release.actualNodeVersion || release.expectedNodeVersion !== release.actualNodeVersion) {
    addError("NODE_VERSION_MISMATCH", "当前 Node 版本与 runtime contract 不一致。", {
      expected: safeString(release.expectedNodeVersion),
      actual: safeString(release.actualNodeVersion)
    });
  }
  if (expectation === "running" && !release.runtimeId) {
    addError("RUNTIME_ID_MISSING", "runtime contract 缺少 runtimeId。");
  }
}

function checkWorkspace(workspace, expectation, addError) {
  if (workspace.production && !workspace.explicit) {
    addError("WORKSPACE_NOT_EXPLICIT", "生产运行必须显式设置 SUNABOT_WORKSPACE。");
  }
  if (workspace.production && workspace.explicit && workspace.absoluteConfigured === false) {
    addError("WORKSPACE_NOT_ABSOLUTE", "生产运行的 SUNABOT_WORKSPACE 必须是绝对路径。");
  }
  if (expectation === "running" && (!workspace.identity?.exists || workspace.identity?.kind !== "directory")) {
    addError("WORKSPACE_INVALID", "运行中的 workspace 不存在或不是目录。");
  }
  const actual = identityComparable(workspace.identity) ?? comparablePath(workspace.identity?.realPath ?? workspace.identity?.path);
  const expected = identityComparable(workspace.expected) ?? comparablePath(workspace.expected?.realPath ?? workspace.expected?.path);
  if (workspace.production && actual && expected && actual !== expected) {
    addError("WORKSPACE_EXPECTATION_MISMATCH", "workspace realpath 与 runtime contract 不一致。", {
      expected: publicPath(workspace.expected),
      actual: publicPath(workspace.identity)
    });
  }
}

function checkDatabases(databases, expectation, addError) {
  const canonical = new Map();
  for (const database of databases.filter((item) => item.canonical)) {
    if (canonical.has(database.role)) {
      addError("DATABASE_CANONICAL_DUPLICATE", `数据库角色 ${database.role} 有多个 canonical 路径。`, { role: database.role });
      continue;
    }
    canonical.set(database.role, database);
    if (expectation === "running" && (!database.exists || database.kind !== "file")) {
      addError("DATABASE_MISSING", `运行中的 ${database.role} 数据库不存在。`, {
        role: database.role,
        path: database.path
      });
    }
  }

  for (const role of ["main", "queue"]) {
    if (!canonical.has(role)) {
      addError("DATABASE_CANONICAL_MISSING", `缺少 ${role} 数据库 canonical 路径。`, { role });
    }
  }

  const mainIdentity = identityComparable(canonical.get("main"));
  const queueIdentity = identityComparable(canonical.get("queue"));
  if (mainIdentity && queueIdentity && mainIdentity === queueIdentity) {
    addError("DATABASE_ROLE_ALIAS", "主库与 queue DB 指向同一个文件。", {
      main: canonical.get("main")?.path,
      queue: canonical.get("queue")?.path
    });
  }

  for (const alternate of databases.filter((item) => !item.canonical && item.exists)) {
    const primary = canonical.get(alternate.role);
    if (!primary?.exists) {
      addError("DATABASE_LEGACY_ONLY", `${alternate.role} 只存在非 canonical 数据库。`, {
        role: alternate.role,
        path: alternate.path
      });
      continue;
    }
    if (identityComparable(primary) === identityComparable(alternate)) {
      addError("DATABASE_ALIAS", `${alternate.role} 存在指向 canonical DB 的别名路径。`, {
        role: alternate.role,
        canonicalPath: primary.path,
        aliasPath: alternate.path
      });
    } else {
      addError("DATABASE_SECONDARY", `${alternate.role} 存在第二份数据库文件。`, {
        role: alternate.role,
        canonicalPath: primary.path,
        secondaryPath: alternate.path
      });
    }
  }
}

function checkListener(context, addError, addWarning) {
  const { listener, expectation, localDomain, expectedWorkspace, releaseVersion } = context;
  if (expectation === "free" && listener.listening) {
    addError("RUNTIME_ALREADY_LISTENING", `${listener.host}:${listener.port} 已有监听者，拒绝启动第二个实例。`);
  }
  if (expectation === "running" && !listener.listening) {
    addError("LISTENER_MISSING", `${listener.host}:${listener.port} 没有运行中的监听者。`);
    return;
  }
  if (!listener.listening) return;
  if (listener.owners.length === 0) {
    const target = expectation === "running" ? addError : addWarning;
    target("LISTENER_OWNER_UNKNOWN", "端口已监听，但无法确认 owner 进程。", { port: listener.port });
    return;
  }
  if (listener.owners.length > 1) {
    addError("LISTENER_DUPLICATE", "API 端口存在多个 owner，检测到 split-brain。", {
      owners: listener.owners.map(processReference)
    });
  }
  if (expectation !== "running") return;
  for (const owner of listener.owners) {
    checkProcessOwnership("LISTENER", owner, {
      localDomain,
      expectedWorkspace,
      releaseVersion
    }, addError, addWarning);
  }
}

function checkOneBot(context, addError, addWarning) {
  const { onebot, expectation, localDomain, expectedWorkspace, releaseVersion } = context;
  const active = onebot.connections.filter((connection) => connection.state === "established" || connection.state === "open");
  if (expectation === "running" && active.length === 0) {
    addError("ONEBOT_CONNECTION_MISSING", "运行中的 runtime 没有 OneBot 反向 WebSocket owner。");
  }
  if (active.length > 1) {
    addError("ONEBOT_CONNECTION_DUPLICATE", "检测到多个 OneBot 连接，拒绝重复实例。", {
      connections: active.map((connection) => connection.id)
    });
  }

  const connectedOwners = new Set();
  for (const connection of onebot.connections) {
    if (!connection.owner || connection.owner.alive === false) {
      addError("ONEBOT_ZOMBIE_CONNECTION", "检测到没有存活 owner 的 OneBot 连接。", { connection: connection.id });
      continue;
    }
    connectedOwners.add(processKey(connection.owner));
    if (connection.state !== "established" && connection.state !== "open") {
      addError("ONEBOT_ZOMBIE_CONNECTION", "检测到非活动状态的 OneBot 连接。", {
        connection: connection.id,
        state: connection.state
      });
      continue;
    }
    checkProcessOwnership("ONEBOT", connection.owner, {
      localDomain,
      expectedWorkspace,
      releaseVersion
    }, addError, addWarning);
  }

  if (expectation === "running") {
    for (const candidate of onebot.candidates) {
      if (candidate.alive === false || !connectedOwners.has(processKey(candidate))) {
        addError("ONEBOT_ZOMBIE_PROCESS", "检测到未拥有活动连接的 OneBot/NapCat 进程。", {
          owner: processReference(candidate)
        });
      }
    }
  }
}

function checkProcessOwnership(prefix, owner, expected, addError, addWarning) {
  if (owner.alive === false) {
    addError(`${prefix}_OWNER_DEAD`, `${prefix} owner 进程已不存在。`, { owner: processReference(owner) });
    return;
  }
  if (owner.domain && expected.localDomain && owner.domain !== expected.localDomain) {
    addError(`${prefix}_FOREIGN_DOMAIN`, `${prefix} owner 来自其他运行域。`, { owner: processReference(owner) });
  }
  if (!EXPECTED_PROCESS_SOURCES.has(owner.source)) {
    addError(`${prefix}_RELEASE_MISMATCH`, `${prefix} owner 不属于当前 release。`, { owner: processReference(owner) });
  }
  const actualWorkspace = comparablePath(owner.workspaceRealPath ?? owner.workspace);
  if (expected.expectedWorkspace && !actualWorkspace) {
    addError(`${prefix}_WORKSPACE_UNKNOWN`, `${prefix} owner 的 workspace 无法确认。`, {
      owner: processReference(owner)
    });
  }
  if (expected.expectedWorkspace && actualWorkspace && actualWorkspace !== expected.expectedWorkspace) {
    addError(`${prefix}_WORKSPACE_MISMATCH`, `${prefix} owner 使用了其他 workspace。`, {
      owner: processReference(owner),
      expectedWorkspace: expected.expectedWorkspace,
      actualWorkspace
    });
  }
  if (expected.releaseVersion && owner.releaseVersion && owner.releaseVersion !== expected.releaseVersion) {
    addError(`${prefix}_VERSION_MISMATCH`, `${prefix} owner release version 不一致。`, {
      owner: processReference(owner),
      expectedVersion: expected.releaseVersion,
      actualVersion: owner.releaseVersion
    });
  }
}

function publicRelease(release) {
  return {
    runtimeId: safeString(release.runtimeId),
    root: publicIdentity(release.root),
    contractVersion: safeString(release.contractVersion),
    packageVersion: safeString(release.packageVersion),
    expectedNodeVersion: safeString(release.expectedNodeVersion),
    actualNodeVersion: safeString(release.actualNodeVersion)
  };
}

function publicWorkspace(workspace) {
  return {
    explicit: Boolean(workspace.explicit),
    absoluteConfigured: workspace.absoluteConfigured !== false,
    production: Boolean(workspace.production),
    identity: publicIdentity(workspace.identity),
    expected: publicIdentity(workspace.expected)
  };
}

function publicDatabase(database) {
  return {
    role: database.role === "queue" ? "queue" : "main",
    canonical: Boolean(database.canonical),
    source: safeString(database.source),
    ...publicIdentity(database)
  };
}

function publicConnection(connection, index) {
  return {
    id: safeString(connection.id) ?? `onebot-${index + 1}`,
    state: safeString(connection.state)?.toLowerCase() ?? "unknown",
    localAddress: safeString(connection.localAddress),
    localPort: safeNumber(connection.localPort),
    remoteAddress: safeString(connection.remoteAddress),
    remotePort: safeNumber(connection.remotePort),
    owner: connection.owner ? publicProcess(connection.owner) : null
  };
}

function publicProcess(owner) {
  return {
    pid: safeNumber(owner.pid),
    name: safeString(owner.name),
    user: safeString(owner.user),
    executable: safeString(owner.executable),
    domain: safeString(owner.domain) ?? "unknown",
    source: safeString(owner.source) ?? "unknown",
    releaseRoot: safeString(owner.releaseRoot),
    releaseVersion: safeString(owner.releaseVersion),
    runtimeId: safeString(owner.runtimeId),
    instanceId: safeString(owner.instanceId),
    workspace: safeString(owner.workspace),
    workspaceRealPath: safeString(owner.workspaceRealPath),
    alive: owner.alive !== false
  };
}

function publicIdentity(identity) {
  if (!identity) return undefined;
  return {
    path: safeString(identity.path),
    realPath: safeString(identity.realPath),
    exists: Boolean(identity.exists),
    kind: safeString(identity.kind),
    device: safeIdentityValue(identity.device),
    inode: safeIdentityValue(identity.inode)
  };
}

function publicPath(identity) {
  return safeString(identity?.realPath ?? identity?.path);
}

function processReference(owner) {
  return {
    pid: owner.pid,
    name: owner.name,
    domain: owner.domain,
    source: owner.source
  };
}

function uniqueProcesses(processes) {
  const unique = new Map();
  for (const owner of processes) unique.set(processKey(owner), owner);
  return [...unique.values()];
}

function processKey(owner) {
  return safeString(owner?.instanceId) ?? `${String(owner?.domain ?? "unknown")}:${String(owner?.pid ?? "unknown")}`;
}

function identityComparable(identity) {
  if (!identity?.exists) return undefined;
  const device = identityToken(identity.device);
  const inode = identityToken(identity.inode);
  if (device != null && inode != null && inode !== "0") return `inode:${device}:${inode}`;
  return comparablePath(identity.realPath ?? identity.path);
}

function comparablePath(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function safeString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function safeIdentityValue(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return undefined;
}

function identityToken(value) {
  const safe = safeIdentityValue(value);
  return safe == null ? undefined : String(safe);
}

function safeCode(value, fallback) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(value) ? value : fallback;
}
