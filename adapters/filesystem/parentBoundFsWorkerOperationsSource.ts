/** Fixed mutation and recovery operations composed into the parent-bound worker. */
export const PARENT_BOUND_FS_WORKER_OPERATIONS_SOURCE = String.raw`
function operationNames(operationToken) {
  const value = token(operationToken);
  return {
    intent: basename(".bound-intent-" + value + ".json"),
    temporary: basename(".bound-new-" + value),
    evidence: basename(".bound-new-evidence-" + value + ".json"),
    quarantine: basename(".bound-quarantine-" + value),
    failed: basename(".bound-failed-" + value)
  };
}

function descriptorFromObject(object) {
  const operation = object.operation;
  if (operation !== "atomic_replace" && operation !== "create_if_missing") fail("BOUND_PROTOCOL_INVALID");
  const target = basename(object.target);
  const contentSha256 = digest(object.contentSha256);
  const contentBytes = byteLength(object.contentBytes);
  const fileMode = mode(object.mode);
  if (fileMode !== 0o600) fail("BOUND_PROTOCOL_INVALID");
  const expectedTarget = object.expectedTarget === null ? null : object.expectedTarget;
  if (expectedTarget !== null) expectedIdentity(expectedTarget);
  if (operation === "create_if_missing" && expectedTarget !== null) fail("BOUND_PROTOCOL_INVALID");
  return { operation, target, contentSha256, contentBytes, mode: fileMode, expectedTarget };
}

function fingerprintDescriptor(descriptor) {
  return sha256(Buffer.from(JSON.stringify(descriptor)));
}

function validateFingerprint(value, descriptor) {
  const fingerprint = digest(value);
  if (fingerprintDescriptor(descriptor) !== fingerprint) fail("BOUND_PROTOCOL_INVALID");
  return fingerprint;
}

function intentValue(descriptor, operationToken, commandFingerprint, initialTarget) {
  return {
    version: 1,
    token: operationToken,
    fingerprint: commandFingerprint,
    operation: descriptor.operation,
    target: descriptor.target,
    contentSha256: descriptor.contentSha256,
    contentBytes: descriptor.contentBytes,
    mode: descriptor.mode,
    expectedTarget: descriptor.expectedTarget,
    initialTarget
  };
}

function parseIntent(value, descriptor, operationToken, commandFingerprint) {
  const object = exactObject(value, [
    "version", "token", "fingerprint", "operation", "target", "contentSha256", "contentBytes",
    "mode", "expectedTarget", "initialTarget"
  ]);
  if (object.version !== 1 || object.token !== operationToken || object.fingerprint !== commandFingerprint) {
    fail("BOUND_RECOVERY_REQUIRED");
  }
  const stored = descriptorFromObject(object);
  if (fingerprintDescriptor(stored) !== commandFingerprint || JSON.stringify(stored) !== JSON.stringify(descriptor)) {
    fail("BOUND_RECOVERY_REQUIRED");
  }
  if (!sameWireIdentity(object.initialTarget, descriptor.expectedTarget)) fail("BOUND_RECOVERY_REQUIRED");
  return object;
}

function evidenceValue(operationToken, commandFingerprint, identity) {
  return {
    version: 1,
    token: operationToken,
    fingerprint: commandFingerprint,
    identity: serializeIdentity(identity)
  };
}

function parseEvidence(value, operationToken, commandFingerprint) {
  const object = exactObject(value, ["version", "token", "fingerprint", "identity"]);
  if (object.version !== 1 || object.token !== operationToken || object.fingerprint !== commandFingerprint) {
    fail("BOUND_RECOVERY_REQUIRED");
  }
  const identity = expectedIdentity(object.identity);
  if (identity.kind !== "file" || identity.nlink !== 1n) fail("BOUND_RECOVERY_REQUIRED");
  return identity;
}

async function verifyNewFile(name, identity, descriptor) {
  const before = await fs.lstat(name, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.dev !== identity.dev ||
      before.ino !== identity.ino || before.size !== BigInt(descriptor.contentBytes) ||
      (before.mode & 0o777n) !== BigInt(descriptor.mode) || (before.nlink !== 1n && before.nlink !== 2n)) {
    fail("BOUND_RECOVERY_REQUIRED");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(name, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail("BOUND_RECOVERY_REQUIRED");
    }
    const content = await handle.readFile();
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await fs.lstat(name, { bigint: true });
    if (afterHandle.dev !== before.dev || afterHandle.ino !== before.ino || afterHandle.size !== before.size ||
        afterPath.dev !== before.dev || afterPath.ino !== before.ino || afterPath.size !== before.size ||
        content.length !== descriptor.contentBytes || sha256(content) !== descriptor.contentSha256) {
      fail("BOUND_RECOVERY_REQUIRED");
    }
    return afterPath;
  } finally {
    await handle.close();
  }
}

async function removeNewFile(name, identity, descriptor) {
  await verifyNewFile(name, identity, descriptor);
  await fs.unlink(name);
  if (await lstatOptional(name)) fail("BOUND_RECOVERY_REQUIRED");
}

async function readOperationState(descriptor, operationToken, commandFingerprint) {
  const names = operationNames(operationToken);
  const intentStat = await lstatOptional(names.intent);
  if (!intentStat) return { names, intent: null, evidence: null };
  const intentFile = await readStrictJson(names.intent);
  parseIntent(intentFile.value, descriptor, operationToken, commandFingerprint);
  const evidenceStat = await lstatOptional(names.evidence);
  if (!evidenceStat) return { names, intent: intentFile, evidence: null };
  const evidenceFile = await readStrictJson(names.evidence);
  return {
    names,
    intent: intentFile,
    evidence: { file: evidenceFile, identity: parseEvidence(evidenceFile.value, operationToken, commandFingerprint) }
  };
}

async function atomicReplace(command) {
  const object = exactObject(command, [
    "op", "target", "contentBase64", "mode", "expectedTarget", "faultAt", "operationToken",
    "commandFingerprint", "contentSha256", "responseMode"
  ]);
  const content = decodeContent(object.contentBase64);
  const descriptor = descriptorFromObject({
    operation: "atomic_replace",
    target: object.target,
    contentSha256: object.contentSha256,
    contentBytes: content.length,
    mode: object.mode,
    expectedTarget: object.expectedTarget
  });
  if (sha256(content) !== descriptor.contentSha256) fail("BOUND_CONTENT_INVALID");
  const operationToken = token(object.operationToken);
  const commandFingerprint = validateFingerprint(object.commandFingerprint, descriptor);
  configuredResponse(object.responseMode);
  const fault = configuredFault(object.faultAt, [
    "after_target_rename", "after_target_verify", "after_evidence_verify", "after_fsync",
    "before_response", "recovery_failure"
  ]);
  const names = operationNames(operationToken);
  const currentTarget = await lstatOptional(descriptor.target);
  if (descriptor.expectedTarget === null) {
    if (currentTarget) fail("EEXIST");
  } else {
    const expected = expectedIdentity(descriptor.expectedTarget);
    if (!currentTarget || expected.kind !== "file" || expected.nlink !== 1n ||
        !sameIdentity(currentTarget, expected)) fail("BOUND_SOURCE_CHANGED");
  }
  await writeStrictJson(
    names.intent,
    intentValue(descriptor, operationToken, commandFingerprint, currentTarget ? serializeIdentity(currentTarget) : null)
  );
  await syncCwd();
  const temporary = await writeExclusive(names.temporary, content, descriptor.mode);
  await writeStrictJson(names.evidence, evidenceValue(operationToken, commandFingerprint, temporary));
  await syncCwd();
  if (descriptor.expectedTarget !== null) {
    const expected = expectedIdentity(descriptor.expectedTarget);
    await fs.link(descriptor.target, names.quarantine);
    const linkedTarget = await fs.lstat(descriptor.target, { bigint: true });
    const linkedBackup = await fs.lstat(names.quarantine, { bigint: true });
    if (!matchesOriginal(linkedTarget, expected) || !matchesOriginal(linkedBackup, expected) ||
        linkedTarget.nlink !== 2n || linkedBackup.nlink !== 2n) fail("BOUND_TARGET_CHANGED");
  }
  await fs.rename(names.temporary, descriptor.target);
  injectFault(fault, "after_target_rename");
  if (fault === "recovery_failure") fail("BOUND_INJECTED_FAULT");
  const targetStat = await verifyNewFile(
    descriptor.target,
    expectedIdentity(serializeIdentity(temporary)),
    descriptor
  );
  injectFault(fault, "after_target_verify");
  if (descriptor.expectedTarget !== null) {
    const retained = await fs.lstat(names.quarantine, { bigint: true });
    const expected = expectedIdentity(descriptor.expectedTarget);
    if (!matchesOriginal(retained, expected) || retained.nlink !== 1n) fail("BOUND_REPLACE_EVIDENCE_CHANGED");
  }
  injectFault(fault, "after_evidence_verify");
  await syncCwd();
  injectFault(fault, "after_fsync");
  injectFault(fault, "before_response");
  return {
    identity: serializeIdentity(targetStat),
    quarantine: descriptor.expectedTarget === null ? null : names.quarantine
  };
}

async function createIfMissing(command) {
  const object = exactObject(command, [
    "op", "target", "contentBase64", "mode", "faultAt", "operationToken", "commandFingerprint",
    "contentSha256", "responseMode"
  ]);
  const content = decodeContent(object.contentBase64);
  const descriptor = descriptorFromObject({
    operation: "create_if_missing",
    target: object.target,
    contentSha256: object.contentSha256,
    contentBytes: content.length,
    mode: object.mode,
    expectedTarget: null
  });
  if (sha256(content) !== descriptor.contentSha256) fail("BOUND_CONTENT_INVALID");
  const operationToken = token(object.operationToken);
  const commandFingerprint = validateFingerprint(object.commandFingerprint, descriptor);
  const responseMode = configuredResponse(object.responseMode, ["pause_after_link"]);
  const fault = configuredFault(object.faultAt, ["cleanup_failure"]);
  const names = operationNames(operationToken);
  const existing = await lstatOptional(descriptor.target);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1n ||
        (existing.mode & 0o777n) !== 0o600n) fail("BOUND_TARGET_INVALID");
    return { created: false, identity: serializeIdentity(existing) };
  }
  await writeStrictJson(
    names.intent,
    intentValue(descriptor, operationToken, commandFingerprint, null)
  );
  await syncCwd();
  const temporary = await writeExclusive(names.temporary, content, descriptor.mode);
  await writeStrictJson(names.evidence, evidenceValue(operationToken, commandFingerprint, temporary));
  await syncCwd();
  try {
    await fs.link(names.temporary, descriptor.target);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") fail("BOUND_SOURCE_CHANGED");
    throw error;
  }
  await verifyNewFile(names.temporary, expectedIdentity(serializeIdentity(temporary)), descriptor);
  await verifyNewFile(descriptor.target, expectedIdentity(serializeIdentity(temporary)), descriptor);
  if (responseMode === "pause_after_link") await new Promise(() => undefined);
  if (fault === "cleanup_failure") fail("BOUND_RECOVERY_REQUIRED");
  await fs.unlink(names.temporary);
  const finalStat = await fs.lstat(descriptor.target, { bigint: true });
  if (!finalStat.isFile() || finalStat.dev !== temporary.dev || finalStat.ino !== temporary.ino ||
      finalStat.nlink !== 1n) fail("BOUND_WRITE_IDENTITY_CHANGED");
  await syncCwd();
  return { created: true, identity: serializeIdentity(finalStat) };
}

async function recoverOperation(command) {
  const object = exactObject(command, [
    "op", "operation", "target", "mode", "expectedTarget", "operationToken", "commandFingerprint",
    "contentSha256", "contentBytes", "faultAt"
  ]);
  const descriptor = descriptorFromObject(object);
  const operationToken = token(object.operationToken);
  const commandFingerprint = validateFingerprint(object.commandFingerprint, descriptor);
  const fault = configuredFault(object.faultAt, ["before_recovery"]);
  injectFault(fault, "before_recovery");
  const state = await readOperationState(descriptor, operationToken, commandFingerprint);
  const companionStats = await Promise.all([
    lstatOptional(state.names.temporary), lstatOptional(state.names.evidence),
    lstatOptional(state.names.quarantine), lstatOptional(state.names.failed)
  ]);
  if (!state.intent) {
    if (companionStats.some(Boolean)) fail("BOUND_RECOVERY_REQUIRED");
    return { recovered: true };
  }
  if (!state.evidence) {
    if (companionStats.some(Boolean)) fail("BOUND_RECOVERY_REQUIRED");
    const target = await lstatOptional(descriptor.target);
    if (descriptor.expectedTarget === null) {
      if (target) fail("BOUND_RECOVERY_REQUIRED");
    } else if (!target || !matchesOriginal(target, expectedIdentity(descriptor.expectedTarget)) || target.nlink !== 1n) {
      fail("BOUND_RECOVERY_REQUIRED");
    }
    await removeEvidence(state.names.intent, state.intent.identity);
    await syncCwd();
    return { recovered: true };
  }
  const newIdentity = state.evidence.identity;
  if (descriptor.operation === "atomic_replace") {
    const expected = descriptor.expectedTarget === null ? null : expectedIdentity(descriptor.expectedTarget);
    let targetStat = await lstatOptional(descriptor.target);
    let quarantineStat = await lstatOptional(state.names.quarantine);
    const temporaryStat = await lstatOptional(state.names.temporary);
    const failedStat = await lstatOptional(state.names.failed);
    if (temporaryStat) await removeNewFile(state.names.temporary, newIdentity, descriptor);
    if (failedStat) await removeNewFile(state.names.failed, newIdentity, descriptor);
    if (expected) {
      if (targetStat && matchesOriginal(targetStat, expected)) {
        if (quarantineStat) {
          if (!matchesOriginal(quarantineStat, expected) || quarantineStat.dev !== targetStat.dev ||
              quarantineStat.ino !== targetStat.ino) fail("BOUND_RECOVERY_REQUIRED");
          await fs.unlink(state.names.quarantine);
          quarantineStat = null;
        }
      } else {
        if (!quarantineStat || !matchesOriginal(quarantineStat, expected)) fail("BOUND_RECOVERY_REQUIRED");
        if (targetStat) await removeNewFile(descriptor.target, newIdentity, descriptor);
        targetStat = await lstatOptional(descriptor.target);
        if (targetStat) fail("BOUND_RECOVERY_REQUIRED");
        await moveKnownEntry(
          state.names.quarantine,
          descriptor.target,
          expectedIdentity(serializeIdentity(quarantineStat))
        );
        quarantineStat = null;
      }
      const restored = await fs.lstat(descriptor.target, { bigint: true });
      if (!matchesOriginal(restored, expected) || restored.nlink !== 1n) fail("BOUND_RECOVERY_REQUIRED");
    } else {
      if (quarantineStat) fail("BOUND_RECOVERY_REQUIRED");
      if (targetStat) await removeNewFile(descriptor.target, newIdentity, descriptor);
      if (await lstatOptional(descriptor.target)) fail("BOUND_RECOVERY_REQUIRED");
    }
  } else {
    if (await lstatOptional(state.names.quarantine) || await lstatOptional(state.names.failed)) {
      fail("BOUND_RECOVERY_REQUIRED");
    }
    if (await lstatOptional(descriptor.target)) await removeNewFile(descriptor.target, newIdentity, descriptor);
    if (await lstatOptional(state.names.temporary)) await removeNewFile(state.names.temporary, newIdentity, descriptor);
    if (await lstatOptional(descriptor.target)) fail("BOUND_RECOVERY_REQUIRED");
  }
  await removeEvidence(state.names.evidence, state.evidence.file.identity);
  await removeEvidence(state.names.intent, state.intent.identity);
  await syncCwd();
  return { recovered: true };
}

async function finalizeOperation(command) {
  const object = exactObject(command, [
    "op", "operation", "target", "mode", "expectedTarget", "operationToken", "commandFingerprint",
    "contentSha256", "contentBytes", "resultIdentity", "created", "responseMode"
  ]);
  const descriptor = descriptorFromObject(object);
  const operationToken = token(object.operationToken);
  const commandFingerprint = validateFingerprint(object.commandFingerprint, descriptor);
  configuredResponse(object.responseMode);
  if (typeof object.created !== "boolean") fail("BOUND_PROTOCOL_INVALID");
  const resultIdentity = expectedIdentity(object.resultIdentity);
  if (resultIdentity.kind !== "file") fail("BOUND_PROTOCOL_INVALID");
  const names = operationNames(operationToken);
  const intentStat = await lstatOptional(names.intent);
  const evidenceStat = await lstatOptional(names.evidence);
  const targetStat = await fs.lstat(descriptor.target, { bigint: true });
  if (!sameIdentity(targetStat, resultIdentity)) fail("BOUND_RECOVERY_REQUIRED");
  if (descriptor.operation === "atomic_replace" || object.created) {
    await verifyNewFile(descriptor.target, resultIdentity, descriptor);
  }
  if (await lstatOptional(names.temporary) || await lstatOptional(names.failed)) fail("BOUND_RECOVERY_REQUIRED");
  if (descriptor.operation === "atomic_replace" && descriptor.expectedTarget !== null) {
    const retained = await fs.lstat(names.quarantine, { bigint: true });
    if (!matchesOriginal(retained, expectedIdentity(descriptor.expectedTarget)) || retained.nlink !== 1n) {
      fail("BOUND_RECOVERY_REQUIRED");
    }
  } else if (await lstatOptional(names.quarantine)) {
    fail("BOUND_RECOVERY_REQUIRED");
  }
  if (!intentStat) {
    if (evidenceStat) {
      const evidence = await readStrictJson(names.evidence);
      const identity = parseEvidence(evidence.value, operationToken, commandFingerprint);
      if (identity.dev !== resultIdentity.dev || identity.ino !== resultIdentity.ino) fail("BOUND_RECOVERY_REQUIRED");
      await removeEvidence(names.evidence, evidence.identity);
      await syncCwd();
    }
    return { finalized: true };
  }
  const intent = await readStrictJson(names.intent);
  parseIntent(intent.value, descriptor, operationToken, commandFingerprint);
  if (!evidenceStat) fail("BOUND_RECOVERY_REQUIRED");
  const evidence = await readStrictJson(names.evidence);
  const evidenceIdentity = parseEvidence(evidence.value, operationToken, commandFingerprint);
  if (evidenceIdentity.dev !== resultIdentity.dev || evidenceIdentity.ino !== resultIdentity.ino) {
    fail("BOUND_RECOVERY_REQUIRED");
  }
  await removeEvidence(names.intent, intent.identity);
  await syncCwd();
  await removeEvidence(names.evidence, evidence.identity);
  await syncCwd();
  return { finalized: true };
}
`;
