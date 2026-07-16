// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigDoctorService } from "../../src/admin/configDoctor.js";
import { ConfigService } from "../../src/admin/configService.js";
import { AdminMutationMutex, AdminRecoveryState } from "../../src/admin/mutation.js";
import { defaultConfig } from "../../src/config.js";
import type { AppConfig } from "../../src/types.js";

let root = "";
let configPath = "";
let originalConfigPath: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-config-doctor-"));
  configPath = path.join(root, "sunabot.json");
  originalConfigPath = process.env.SUNABOT_CONFIG;
  process.env.SUNABOT_CONFIG = configPath;
});

afterEach(async () => {
  if (originalConfigPath == null) delete process.env.SUNABOT_CONFIG;
  else process.env.SUNABOT_CONFIG = originalConfigPath;
  await fs.rm(root, { recursive: true, force: true });
});

describe("ConfigDoctorService", () => {
  it("finds missing schema fields and creates a deterministic proposal", async () => {
    const document = structuredClone(defaultConfig()) as Partial<AppConfig>;
    delete document.schemaVersion;
    delete document.normalReply;
    await writeDocument(document);
    const doctor = createDoctor();

    const report = await doctor.scan();

    expect(report.status).toBe("repairable");
    expect(report.proposal?.source).toBe("rules");
    expect(report.proposal?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/schemaVersion", action: "add" }),
      expect.objectContaining({ path: "/normalReply/maxRetries", action: "add" })
    ]));
  });

  it("keeps invalid JSON local and refuses an AI request", async () => {
    await fs.writeFile(configPath, "{\"normalReply\": undefined}", "utf8");
    const runModel = vi.fn();
    const doctor = createDoctor({ runModel });

    const report = await doctor.scan();

    expect(report.status).toBe("manual");
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "CONFIG_JSON_INVALID", repairable: false })
    ]));
    await expect(doctor.propose(report.sourceRevision)).rejects.toMatchObject({
      code: "CONFIG_DOCTOR_MANUAL_REQUIRED"
    });
    expect(runModel).not.toHaveBeenCalled();
  });

  it("repairs a trailing comma locally without sending the raw document to AI", async () => {
    const text = `${JSON.stringify(defaultConfig(), null, 2).replace(/\n}$/, ",\n}")}\n`;
    await fs.writeFile(configPath, text, "utf8");
    const runModel = vi.fn();
    const doctor = createDoctor({ runModel });

    const scan = await doctor.scan();

    expect(scan.status).toBe("repairable");
    expect(scan.issues).toContainEqual(expect.objectContaining({ id: "CONFIG_TRAILING_COMMA" }));
    await doctor.apply({ proposalId: scan.proposal!.id, sourceRevision: scan.sourceRevision });
    await expect(fs.readFile(configPath, "utf8").then(JSON.parse)).resolves.toMatchObject({ schemaVersion: 1 });
    expect(runModel).not.toHaveBeenCalled();
  });

  it("repairs a UTF-8 BOM together with trailing commas", async () => {
    const trailing = `${JSON.stringify(defaultConfig(), null, 2).replace(/\n}$/, ",\n}")}\n`;
    await fs.writeFile(configPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(trailing)]));
    const doctor = createDoctor();

    const scan = await doctor.scan();

    expect(scan.status).toBe("repairable");
    expect(scan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "CONFIG_BOM" }),
      expect.objectContaining({ id: "CONFIG_TRAILING_COMMA" })
    ]));
    expect(scan.proposal?.changes.filter((change) => change.path === "/")).toHaveLength(2);
    await doctor.apply({ proposalId: scan.proposal!.id, sourceRevision: scan.sourceRevision });
    const repaired = await fs.readFile(configPath);
    expect([...repaired.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(() => JSON.parse(repaired.toString("utf8"))).not.toThrow();
  });

  it("blocks duplicate keys and unsupported future schema versions", async () => {
    const duplicate = JSON.stringify(defaultConfig(), null, 2)
      .replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,');
    await fs.writeFile(configPath, duplicate, "utf8");
    const doctor = createDoctor();
    await expect(doctor.scan()).resolves.toMatchObject({
      status: "manual",
      issues: [expect.objectContaining({ id: "CONFIG_DUPLICATE_KEY" })]
    });

    await writeDocument({ ...defaultConfig(), schemaVersion: 2 });
    await expect(doctor.scan()).resolves.toMatchObject({
      status: "manual",
      issues: [expect.objectContaining({ id: "CONFIG_SCHEMA_VERSION_UNSUPPORTED" })]
    });
  });

  it("fails closed for unsafe configuration files", async () => {
    const doctor = createDoctor();
    const cases: Array<{ content: string | Buffer; id: string }> = [
      { content: Buffer.from([0xc3, 0x28]), id: "CONFIG_ENCODING_INVALID" },
      { content: "{\"schemaVersion\":1}\0", id: "CONFIG_NUL_INVALID" },
      { content: "[]", id: "CONFIG_ROOT_INVALID" },
      { content: Buffer.alloc(512 * 1024 + 1, 0x20), id: "CONFIG_FILE_TOO_LARGE" }
    ];
    for (const item of cases) {
      await fs.writeFile(configPath, item.content);
      await expect(doctor.scan()).resolves.toMatchObject({
        status: "manual",
        issues: expect.arrayContaining([expect.objectContaining({ id: item.id })])
      });
    }

    const target = path.join(root, "target.json");
    await writeDocument(defaultConfig());
    await fs.rename(configPath, target);
    await fs.symlink(target, configPath);
    await expect(doctor.scan()).resolves.toMatchObject({
      status: "manual",
      issues: [expect.objectContaining({ id: "CONFIG_PATH_UNSAFE" })]
    });
  });

  it("returns a manual report for excessively deep or complex JSON", async () => {
    const doctor = createDoctor();
    const deep = `${'{"nested":'.repeat(15_000)}0${"}".repeat(15_000)}`;
    await fs.writeFile(configPath, deep, "utf8");
    await expect(doctor.scan()).resolves.toMatchObject({
      status: "manual",
      issues: [expect.objectContaining({ id: "CONFIG_STRUCTURE_TOO_DEEP" })]
    });

    const entries = Array.from({ length: 5_000 }, (_, index) => `"key${index}":${index}`).join(",");
    await fs.writeFile(configPath, `{${entries}}`, "utf8");
    await expect(doctor.scan()).resolves.toMatchObject({
      status: "manual",
      issues: [expect.objectContaining({ id: "CONFIG_STRUCTURE_TOO_COMPLEX" })]
    });
  });

  it("redacts secrets, identities and paths before invoking the model", async () => {
    const document = structuredClone(defaultConfig());
    delete (document as Partial<AppConfig>).schemaVersion;
    document.bot.adminQq = "3971235731";
    document.bot.tools.websearch.tavilyApiKey = "secret-tavily-value";
    document.providers.items.push({
      ...document.providers.items[1]!,
      id: "internal-provider",
      label: "Internal Provider",
      kind: "openai-compatible",
      modelSource: "custom",
      baseUrl: "https://internal.example.test/private?token=hidden"
    });
    document.persona.avatarPath = "/private/agent/path";
    await writeDocument(document);
    const runModel = vi.fn(async () => JSON.stringify({ summary: "结构正常", operations: [] }));
    const doctor = createDoctor({ runModel });
    const scan = await doctor.scan();

    await doctor.propose(scan.sourceRevision);

    const payload = JSON.stringify(runModel.mock.calls[0]?.[0]?.request ?? {});
    expect(payload).not.toContain("secret-tavily-value");
    expect(payload).not.toContain("3971235731");
    expect(payload).not.toContain("internal.example.test");
    expect(payload).not.toContain("/private/agent/path");
    expect(payload).toContain("[redacted");
    expect(runModel.mock.calls[0]?.[0]?.request.tools).toEqual([]);
    expect(runModel.mock.calls[0]?.[0]?.request.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { strict: true }
    });
  });

  it("does not send arbitrary issue keys to the model and keeps manual status", async () => {
    const document = structuredClone(defaultConfig()) as AppConfig & Record<string, unknown>;
    delete (document as Partial<AppConfig>).schemaVersion;
    document["secret-key-name-sentinel"] = "ignored";
    await writeDocument(document);
    const runModel = vi.fn(async () => JSON.stringify({ summary: "no changes", operations: [] }));
    const doctor = createDoctor({ runModel });

    const scan = await doctor.scan();
    expect(scan.status).toBe("manual");
    expect(scan.proposal).toBeUndefined();
    const report = await doctor.propose(scan.sourceRevision);

    expect(report.status).toBe("manual");
    expect(report.proposal).toBeUndefined();
    expect(JSON.stringify(runModel.mock.calls[0]?.[0]?.request)).not.toContain("secret-key-name-sentinel");
  });

  it("lets AI repair an allowed invalid type without exposing its raw value", async () => {
    const document = structuredClone(defaultConfig());
    (document.bot as unknown as Record<string, unknown>).pokeOnNoReply = "sensitive-invalid-value";
    await writeDocument(document);
    const runModel = vi.fn(async () => JSON.stringify({
      summary: "修复布尔字段",
      operations: [{
        op: "replace",
        path: "/bot/pokeOnNoReply",
        valueJson: "false",
        reason: "恢复为布尔值"
      }]
    }));
    const doctor = createDoctor({ runModel });
    const scan = await doctor.scan();

    expect(scan.status).toBe("manual");
    expect(scan.issues).toContainEqual(expect.objectContaining({ path: "/bot/pokeOnNoReply" }));
    const proposal = await doctor.propose(scan.sourceRevision);

    expect(proposal.status).toBe("repairable");
    expect(proposal.proposal?.changes).toContainEqual(expect.objectContaining({ path: "/bot/pokeOnNoReply" }));
    expect(JSON.stringify(runModel.mock.calls[0]?.[0]?.request)).not.toContain("sensitive-invalid-value");
  });

  it("collects multiple invalid fields and derives the quote mirror repair", async () => {
    const document = structuredClone(defaultConfig());
    (document.bot as unknown as Record<string, unknown>).pokeOnNoReply = "invalid-poke";
    (document.bot as unknown as Record<string, unknown>).quoteGroupReplies = "invalid-quote";
    document.onebot.quoteGroupReplies = true;
    await writeDocument(document);
    const runModel = vi.fn(async () => JSON.stringify({
      summary: "repair invalid booleans",
      operations: [
        { op: "replace", path: "/bot/pokeOnNoReply", valueJson: "false", reason: "deceptive reason" },
        { op: "replace", path: "/bot/quoteGroupReplies", valueJson: "false", reason: "deceptive reason" }
      ]
    }));
    const doctor = createDoctor({ runModel });
    const scan = await doctor.scan();

    expect(scan.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/bot/pokeOnNoReply" }),
      expect.objectContaining({ path: "/bot/quoteGroupReplies" })
    ]));
    const proposal = await doctor.propose(scan.sourceRevision);

    expect(proposal.status).toBe("repairable");
    expect(proposal.proposal?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/bot/pokeOnNoReply", summary: expect.stringContaining("false") }),
      expect.objectContaining({ path: "/bot/quoteGroupReplies", summary: expect.stringContaining("false") }),
      expect.objectContaining({ path: "/onebot/quoteGroupReplies", summary: expect.stringContaining("false") })
    ]));
    expect(proposal.proposal?.changes.some((change) => change.summary.includes("deceptive reason"))).toBe(false);
  });

  it("rejects an allowlisted AI change when that field is not an active issue", async () => {
    const document = structuredClone(defaultConfig());
    delete (document as Partial<AppConfig>).schemaVersion;
    await writeDocument(document);
    const doctor = createDoctor({
      runModel: vi.fn(async () => JSON.stringify({
        summary: "unrelated behavior change",
        operations: [{
          op: "replace",
          path: "/broadcastStorm/enabled",
          valueJson: "false",
          reason: "unrelated"
        }]
      }))
    });
    const scan = await doctor.scan();

    await expect(doctor.propose(scan.sourceRevision)).rejects.toMatchObject({
      code: "CONFIG_DOCTOR_AI_OUTPUT_INVALID"
    });
  });

  it("rejects AI patches outside the allowlist", async () => {
    const document = structuredClone(defaultConfig());
    delete (document as Partial<AppConfig>).schemaVersion;
    await writeDocument(document);
    const doctor = createDoctor({
      runModel: vi.fn(async () => JSON.stringify({
        summary: "修改端口",
        operations: [{ op: "replace", path: "/server/port", valueJson: "9999", reason: "test" }]
      }))
    });
    const scan = await doctor.scan();

    await expect(doctor.propose(scan.sourceRevision)).rejects.toMatchObject({
      code: "CONFIG_DOCTOR_AI_OUTPUT_INVALID"
    });
  });

  it("rejects prototype-polluting JSON pointers from AI", async () => {
    const document = structuredClone(defaultConfig());
    delete (document as Partial<AppConfig>).schemaVersion;
    await writeDocument(document);
    const doctor = createDoctor({
      runModel: vi.fn(async () => JSON.stringify({
        summary: "invalid",
        operations: [{ op: "add", path: "/bot/__proto__/enabled", valueJson: "true", reason: "test" }]
      }))
    });
    const scan = await doctor.scan();

    await expect(doctor.propose(scan.sourceRevision)).rejects.toMatchObject({
      code: "CONFIG_DOCTOR_PATCH_INVALID"
    });
    expect(({} as { enabled?: boolean }).enabled).toBeUndefined();
  });

  it("rejects oversized, duplicate and remove operations from AI", async () => {
    const document = structuredClone(defaultConfig());
    (document.bot as unknown as Record<string, unknown>).pokeOnNoReply = "invalid";
    await writeDocument(document);

    const oversized = createDoctor({
      runModel: vi.fn(async () => JSON.stringify({ summary: "x".repeat(70_000), operations: [] }))
    });
    const scan = await oversized.scan();
    await expect(oversized.propose(scan.sourceRevision)).rejects.toMatchObject({
      code: "CONFIG_DOCTOR_AI_OUTPUT_INVALID"
    });

    const duplicate = createDoctor({
      runModel: vi.fn(async () => JSON.stringify({
        summary: "duplicate",
        operations: [
          { op: "replace", path: "/bot/pokeOnNoReply", valueJson: "false", reason: "one" },
          { op: "replace", path: "/bot/pokeOnNoReply", valueJson: "true", reason: "two" }
        ]
      }))
    });
    await expect(duplicate.propose(scan.sourceRevision)).rejects.toMatchObject({
      code: "CONFIG_DOCTOR_AI_OUTPUT_INVALID"
    });

    const remove = createDoctor({
      runModel: vi.fn(async () => JSON.stringify({
        summary: "remove",
        operations: [{ op: "remove", path: "/bot/pokeOnNoReply", valueJson: "null", reason: "remove" }]
      }))
    });
    await expect(remove.propose(scan.sourceRevision)).rejects.toMatchObject({
      code: "CONFIG_DOCTOR_AI_OUTPUT_INVALID"
    });

    const tooMany = createDoctor({
      runModel: vi.fn(async () => JSON.stringify({
        summary: "too many",
        operations: Array.from({ length: 17 }, () => ({
          op: "replace",
          path: "/bot/pokeOnNoReply",
          valueJson: "false",
          reason: "many"
        }))
      }))
    });
    await expect(tooMany.propose(scan.sourceRevision)).rejects.toMatchObject({
      code: "CONFIG_DOCTOR_AI_OUTPUT_INVALID"
    });

    const tooDeep = createDoctor({
      runModel: vi.fn(async () => JSON.stringify({
        summary: "too deep",
        operations: [{
          op: "replace",
          path: `/${Array.from({ length: 13 }, () => "nested").join("/")}`,
          valueJson: "false",
          reason: "deep"
        }]
      }))
    });
    await expect(tooDeep.propose(scan.sourceRevision)).rejects.toMatchObject({
      code: "CONFIG_DOCTOR_PATCH_INVALID"
    });
  });

  it("applies a server-side proposal, retains a backup and hot reloads", async () => {
    const document = structuredClone(defaultConfig()) as Partial<AppConfig>;
    delete document.schemaVersion;
    delete document.normalReply;
    await writeDocument(document);
    let active = defaultConfig();
    const commit = vi.fn((candidate: AppConfig) => { active = structuredClone(candidate); });
    const configService = new ConfigService({
      mutex: new AdminMutationMutex(),
      getActiveConfig: () => active,
      doctorBackupRoot: path.join(root, "backups"),
      prepareApply: async (candidate) => ({ commit: () => commit(candidate) })
    });
    const doctor = new ConfigDoctorService({ configPath, configService, getActiveConfig: () => active });
    const scan = await doctor.scan();

    const result = await doctor.apply({
      proposalId: scan.proposal!.id,
      sourceRevision: scan.sourceRevision
    });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as AppConfig;
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.normalReply).toEqual({ maxRetries: 3 });
    expect(commit).toHaveBeenCalledOnce();
    expect(result.backupPath).toMatch(/^backups\//);
    await expect(fs.readFile(path.join(root, result.backupPath), "utf8")).resolves.toContain("\"server\"");
    const backupDirectory = path.dirname(path.join(root, result.backupPath));
    const manifest = JSON.parse(await fs.readFile(path.join(backupDirectory, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ schemaVersion: 1, source: "rules", beforeSha256: scan.sourceRevision });
    expect((await fs.stat(path.join(root, result.backupPath))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(backupDirectory, "manifest.json"))).mode & 0o777).toBe(0o600);
  });

  it("repairs the file without hot-applying unrelated disk changes", async () => {
    const document = structuredClone(defaultConfig());
    delete (document as Partial<AppConfig>).schemaVersion;
    document.providers.items[0]!.reasoningEffort = "low";
    await writeDocument(document);
    let active = defaultConfig();
    const configService = new ConfigService({
      mutex: new AdminMutationMutex(),
      getActiveConfig: () => active,
      doctorBackupRoot: path.join(root, "backups"),
      prepareApply: async (candidate) => ({ commit: () => { active = structuredClone(candidate); } })
    });
    const doctor = new ConfigDoctorService({ configPath, configService, getActiveConfig: () => active });
    const scan = await doctor.scan();

    const result = await doctor.apply({
      proposalId: scan.proposal!.id,
      sourceRevision: scan.sourceRevision
    });

    expect(result.restartRequired).toBe(true);
    expect(active.providers.items[0]!.reasoningEffort).toBe("medium");
    const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as AppConfig;
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.providers.items[0]!.reasoningEffort).toBe("low");
  });

  it("ignores legacy provider defaults that are supplied during normalization", async () => {
    const document = structuredClone(defaultConfig());
    const provider = document.providers.items[0]! as Partial<(typeof document.providers.items)[number]>;
    delete provider.modelSource;
    delete provider.multimodal;
    delete provider.reasoningEffort;
    await writeDocument(document);

    const report = await createDoctor().scan();

    expect(report.status).toBe("healthy");
    expect(report.issues).toEqual([]);
  });

  it("rejects a proposal when the source file changed after scanning", async () => {
    const document = structuredClone(defaultConfig());
    delete (document as Partial<AppConfig>).schemaVersion;
    await writeDocument(document);
    const doctor = createDoctor();
    const scan = await doctor.scan();
    document.normalReply.maxRetries = 4;
    await writeDocument(document);

    await expect(doctor.apply({
      proposalId: scan.proposal!.id,
      sourceRevision: scan.sourceRevision
    })).rejects.toMatchObject({ code: "CONFIG_REVISION_CONFLICT", statusCode: 409 });
  });

  it("serializes concurrent applies through the shared mutation mutex", async () => {
    const document = structuredClone(defaultConfig());
    delete (document as Partial<AppConfig>).schemaVersion;
    await writeDocument(document);
    let active = defaultConfig();
    const commit = vi.fn((candidate: AppConfig) => { active = structuredClone(candidate); });
    const configService = new ConfigService({
      mutex: new AdminMutationMutex(),
      getActiveConfig: () => active,
      doctorBackupRoot: path.join(root, "backups"),
      prepareApply: async (candidate) => ({ commit: () => commit(candidate) })
    });
    const doctor = new ConfigDoctorService({ configPath, configService, getActiveConfig: () => active });
    const scan = await doctor.scan();
    const request = { proposalId: scan.proposal!.id, sourceRevision: scan.sourceRevision };

    const results = await Promise.allSettled([doctor.apply(request), doctor.apply(request)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "CONFIG_REVISION_CONFLICT", statusCode: 409 });
    expect(commit).toHaveBeenCalledOnce();
  });

  it("expires server-side proposals after ten minutes", async () => {
    const document = structuredClone(defaultConfig());
    delete (document as Partial<AppConfig>).schemaVersion;
    await writeDocument(document);
    let now = Date.parse("2026-07-16T10:00:00.000Z");
    const doctor = createDoctor({ now: () => now });
    const scan = await doctor.scan();
    now += 10 * 60_000 + 1;

    await expect(doctor.apply({
      proposalId: scan.proposal!.id,
      sourceRevision: scan.sourceRevision
    })).rejects.toMatchObject({ code: "CONFIG_DOCTOR_PROPOSAL_EXPIRED", statusCode: 409 });
  });

  it("rate limits consecutive AI diagnostics", async () => {
    const document = structuredClone(defaultConfig());
    delete (document as Partial<AppConfig>).schemaVersion;
    await writeDocument(document);
    const runModel = vi.fn(async () => JSON.stringify({ summary: "ok", operations: [] }));
    const doctor = createDoctor({ runModel });
    const scan = await doctor.scan();
    await doctor.propose(scan.sourceRevision);

    await expect(doctor.propose(scan.sourceRevision)).rejects.toMatchObject({
      code: "CONFIG_DOCTOR_AI_RATE_LIMITED",
      statusCode: 429
    });
    expect(runModel).toHaveBeenCalledOnce();
  });

  it("restores the exact source bytes when the runtime commit fails", async () => {
    const document = structuredClone(defaultConfig()) as Partial<AppConfig>;
    delete document.schemaVersion;
    delete document.normalReply;
    const original = `${JSON.stringify(document)}\n`;
    await fs.writeFile(configPath, original, "utf8");
    let active = defaultConfig();
    const prepareApply = vi.fn(async (candidate: AppConfig) => ({
      commit: prepareApply.mock.calls.length === 1
        ? () => { throw new Error("commit failed"); }
        : () => { active = structuredClone(candidate); }
    }));
    const configService = new ConfigService({
      mutex: new AdminMutationMutex(),
      getActiveConfig: () => active,
      doctorBackupRoot: path.join(root, "backups"),
      prepareApply
    });
    const doctor = new ConfigDoctorService({ configPath, configService, getActiveConfig: () => active });
    const scan = await doctor.scan();

    await expect(doctor.apply({
      proposalId: scan.proposal!.id,
      sourceRevision: scan.sourceRevision
    })).rejects.toThrow("commit failed");

    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(original);
    expect(prepareApply).toHaveBeenCalledTimes(2);
  });

  it("runs runtime verification before creating a backup or changing the file", async () => {
    const document = structuredClone(defaultConfig());
    delete (document as Partial<AppConfig>).schemaVersion;
    const original = `${JSON.stringify(document, null, 2)}\n`;
    await fs.writeFile(configPath, original, "utf8");
    const commit = vi.fn();
    const configService = new ConfigService({
      mutex: new AdminMutationMutex(),
      getActiveConfig: defaultConfig,
      doctorBackupRoot: path.join(root, "backups"),
      prepareApply: async () => ({
        verify: () => { throw new Error("runtime changed"); },
        commit
      })
    });
    const doctor = new ConfigDoctorService({ configPath, configService, getActiveConfig: defaultConfig });
    const scan = await doctor.scan();

    await expect(doctor.apply({
      proposalId: scan.proposal!.id,
      sourceRevision: scan.sourceRevision
    })).rejects.toThrow("runtime changed");

    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(original);
    await expect(fs.stat(path.join(root, "backups"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("rechecks the source after runtime verification and before persisting", async () => {
    const document = structuredClone(defaultConfig());
    delete (document as Partial<AppConfig>).schemaVersion;
    const original = `${JSON.stringify(document, null, 2)}\n`;
    await fs.writeFile(configPath, original, "utf8");
    const external = { ...document, normalReply: { maxRetries: 6 } };
    const externalRaw = `${JSON.stringify(external, null, 2)}\n`;
    const commit = vi.fn();
    const backupRoot = path.join(root, "backups");
    const configService = new ConfigService({
      mutex: new AdminMutationMutex(),
      getActiveConfig: defaultConfig,
      doctorBackupRoot: backupRoot,
      prepareApply: async () => ({
        verify: () => fs.writeFile(configPath, externalRaw, "utf8"),
        commit
      })
    });
    const doctor = new ConfigDoctorService({ configPath, configService, getActiveConfig: defaultConfig });
    const scan = await doctor.scan();

    await expect(doctor.apply({
      proposalId: scan.proposal!.id,
      sourceRevision: scan.sourceRevision
    })).rejects.toMatchObject({ code: "CONFIG_REVISION_CONFLICT", statusCode: 409 });

    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(externalRaw);
    await expect(fs.readdir(backupRoot)).resolves.toEqual([]);
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects a symbolic-link parent in the backup path", async () => {
    const document = structuredClone(defaultConfig());
    delete (document as Partial<AppConfig>).schemaVersion;
    const original = `${JSON.stringify(document, null, 2)}\n`;
    await fs.writeFile(configPath, original, "utf8");
    const outside = path.join(root, "outside");
    const linked = path.join(root, "linked-backups");
    await fs.mkdir(outside);
    await fs.symlink(outside, linked);
    const commit = vi.fn();
    const configService = new ConfigService({
      mutex: new AdminMutationMutex(),
      getActiveConfig: defaultConfig,
      doctorBackupRoot: path.join(linked, "config-doctor"),
      prepareApply: async () => ({ commit })
    });
    const doctor = new ConfigDoctorService({ configPath, configService, getActiveConfig: defaultConfig });
    const scan = await doctor.scan();

    await expect(doctor.apply({
      proposalId: scan.proposal!.id,
      sourceRevision: scan.sourceRevision
    })).rejects.toMatchObject({ code: "CONFIG_DOCTOR_BACKUP_PATH_UNSAFE", statusCode: 409 });

    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(original);
    await expect(fs.readdir(outside)).resolves.toEqual([]);
    expect(commit).not.toHaveBeenCalled();
  });

  it("enters recovery-required state when runtime rollback also fails", async () => {
    const document = structuredClone(defaultConfig());
    delete (document as Partial<AppConfig>).schemaVersion;
    const original = `${JSON.stringify(document, null, 2)}\n`;
    await fs.writeFile(configPath, original, "utf8");
    const recoveryState = new AdminRecoveryState();
    const prepareApply = vi.fn(async () => ({
      commit: () => { throw new Error(prepareApply.mock.calls.length === 1 ? "commit failed" : "rollback failed"); }
    }));
    const configService = new ConfigService({
      mutex: new AdminMutationMutex(),
      recoveryState,
      getActiveConfig: defaultConfig,
      doctorBackupRoot: path.join(root, "backups"),
      prepareApply
    });
    const doctor = new ConfigDoctorService({ configPath, configService, getActiveConfig: defaultConfig });
    const scan = await doctor.scan();

    await expect(doctor.apply({
      proposalId: scan.proposal!.id,
      sourceRevision: scan.sourceRevision
    })).rejects.toMatchObject({ code: "CONFIG_RECOVERY_REQUIRED", statusCode: 503 });

    expect(recoveryState.get()).toContain("rollback failed");
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(original);
  });
});

function createDoctor(options: {
  runModel?: ConstructorParameters<typeof ConfigDoctorService>[0]["runModel"];
  now?: () => number;
} = {}) {
  let active = defaultConfig();
  const configService = new ConfigService({
    mutex: new AdminMutationMutex(),
    getActiveConfig: () => active,
    doctorBackupRoot: path.join(root, "backups"),
    prepareApply: async (candidate) => ({ commit: () => { active = structuredClone(candidate); } })
  });
  return new ConfigDoctorService({
    configPath,
    configService,
    getActiveConfig: () => active,
    runModel: options.runModel,
    now: options.now
  });
}

async function writeDocument(document: unknown) {
  await fs.writeFile(configPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}
