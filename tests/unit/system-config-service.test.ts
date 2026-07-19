// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { configRevision } from "../../src/admin/configRevision.js";
import {
  SystemConfigService,
  type SystemConfigRuntime,
  type SystemConfigServiceOptions
} from "../../src/admin/systemConfigService.js";
import type { SystemConfigInput, SystemConfigTurnContext } from "../../services/tools/systemConfigTool.js";
import type { AppConfig, ConversationRecord } from "../../src/types.js";

const AGENT_ID = "plana";
const STARTED_AT = "2026-07-16T00:00:00.000Z";
const SECRET_PATH = "/Users/private/sunabot/workspace/secrets/runtime.env";
const SECRET_PROVIDER_ENV = "PRIVATE_PROVIDER_TOKEN";
const SECRET_TAVILY_KEY = "tavily-raw-secret";
const SECRET_MESSAGE = "private conversation body";
const SECRET_DIAGNOSTIC = "private probe diagnostic";

describe("SystemConfigService", () => {
  it("returns safe settings without exposing secrets, paths, or conversation messages", async () => {
    const harness = createHarness("web:admin");

    const result = await execute(harness, systemInput("get_settings"));

    expect(result).toMatchObject({
      ok: true,
      operation: "get_settings",
      agent: { id: AGENT_ID, name: "普拉娜" },
      autoReply: { private: true, userGroup: true, botGroup: false },
      orchestrator: {
        enabled: false,
        scope: "ambient_group_replies",
        groupThreadClassifierControlled: false
      },
      tone: {
        enabled: false,
        followMainModel: false,
        providerId: null,
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
        temperature: 0.7,
        maxOutputTokens: 2400,
        maxRetries: 2
      },
      search: {
        implementation: "tavily",
        availableImplementations: ["tavily"],
        configuredEnabled: null,
        promptEnabled: true,
        credentialConfigured: true,
        effectiveEnabled: true
      },
      bash: {
        enabled: false,
        configuredEnabled: false,
        adminPrivateBackend: "native",
        configuredBackend: "native",
        auditModel: "gpt-5.4-mini",
        strictMode: true,
        available: true,
        effectiveEnabled: false,
        unavailableReason: "BASH_CONFIG_DISABLED",
        unavailableMessage: "Bash 未启用。",
        isolationRequired: "bubblewrap_or_equivalent",
        rawHostFallbackAllowed: false,
        dockerSocketAllowed: false
      },
      groups: {
        total: 2,
        truncated: false,
        items: [
          expect.objectContaining({
            conversationId: "group:101",
            accountId: "primary",
            groupId: 101,
            title: "公开群一",
            scope: "user_group"
          }),
          expect.objectContaining({
            conversationId: "account:secondary:group:202",
            accountId: "secondary",
            groupId: 202,
            title: "公开群二",
            scope: "user_group"
          })
        ]
      }
    });
    expect(result.system.providers.items[0]).toEqual(expect.objectContaining({
      id: "open-arona-codex",
      credentialConfigured: true
    }));
    expect(result.tools.configuredEnabled).toEqual({ websearch: null, selfie: false });

    const serialized = JSON.stringify(result);
    for (const secret of [
      SECRET_PATH,
      SECRET_PROVIDER_ENV,
      SECRET_TAVILY_KEY,
      SECRET_MESSAGE,
      "PRIVATE_ADMIN_QQ",
      "PRIVATE_SEARCH_DESCRIPTION",
      "PRIVATE_TOOL_DESCRIPTION",
      "PRIVATE_TAVILY_ENV",
      "provider-secret",
      "ONEBOT_PRIVATE_TOKEN"
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("messages");
    expect(serialized).not.toContain("lastText");
    expect(serialized).not.toContain("apiKeyEnv");
    expect(serialized).not.toContain("agentWorkspace");
  });

  it("paginates every known group by full conversation id without duplicates or mutations", async () => {
    const harness = createHarness("web:admin");
    const generated = [
      conversation({
        id: "account:secondary:group:900",
        accountId: "secondary",
        groupId: 900,
        groupName: "副账号群",
        scope: "bot_group"
      }),
      ...Array.from({ length: 256 }, (_, index) => conversation({
        id: `group:${index + 1}`,
        groupId: index + 1,
        groupName: `群 ${index + 1}`
      }))
    ];
    harness.records.splice(0, harness.records.length, ...generated.reverse());
    const expectedIds = generated.map((record) => record.id).sort(binaryCompare);
    const receivedIds: string[] = [];
    const turn = harness.service.createTurn(harness.context);
    let groupCursor: string | null = null;
    let pageCount = 0;

    do {
      const result = await turn.execute(systemInput("list_groups", {
        groupCursor,
        groupLimit: null
      })) as any;

      expect(result).toMatchObject({
        ok: true,
        operation: "list_groups",
        total: 257
      });
      expect(result.items.length).toBeLessThanOrEqual(50);
      expect(result.hasMore).toBe(result.nextCursor !== null);
      if (result.hasMore) {
        expect(result.nextCursor).toBe(result.items.at(-1)?.conversationId);
      }
      receivedIds.push(...result.items.map((item: any) => item.conversationId));
      groupCursor = result.nextCursor;
      pageCount += 1;
    } while (groupCursor !== null);

    expect(pageCount).toBe(6);
    expect(receivedIds).toEqual(expectedIds);
    expect(new Set(receivedIds).size).toBe(expectedIds.length);
    expect(receivedIds).toContain("account:secondary:group:900");
    expect(turn.mutationStaged()).toBe(false);
    expect(turn.stagedMutation()).toBeUndefined();

    await turn.commit();

    expect(harness.registryConfig).not.toHaveBeenCalled();
    expect(harness.registryGet).not.toHaveBeenCalled();
    expect(harness.readEnvelope).not.toHaveBeenCalled();
    expect(harness.patch).not.toHaveBeenCalled();
    expect(harness.setConversationReplyEnabled).not.toHaveBeenCalled();
  });

  it("uses binary keyset pagination for an unknown but valid cursor", async () => {
    const harness = createHarness();
    harness.records.splice(0, harness.records.length,
      conversation({ id: "group:2", groupId: 2 }),
      conversation({ id: "account:b:group:1", accountId: "b", groupId: 1 }),
      conversation({ id: "group:10", groupId: 10 }),
      conversation({ id: "account:a:group:2", accountId: "a", groupId: 2 })
    );

    const first = await execute(harness, systemInput("list_groups", { groupLimit: 100 }));
    const afterUnknown = await execute(harness, systemInput("list_groups", {
      groupCursor: "group:15",
      groupLimit: 100
    }));
    const afterLast = await execute(harness, systemInput("list_groups", {
      groupCursor: "group:9",
      groupLimit: 100
    }));

    expect(first.items.map((item: any) => item.conversationId)).toEqual([
      "account:a:group:2",
      "account:b:group:1",
      "group:10",
      "group:2"
    ]);
    expect(afterUnknown).toMatchObject({
      total: 4,
      hasMore: false,
      nextCursor: null,
      items: [expect.objectContaining({ conversationId: "group:2" })]
    });
    expect(afterLast).toMatchObject({
      total: 4,
      hasMore: false,
      nextCursor: null,
      items: []
    });
  });

  it("isolates list_groups by Agent and returns only safe group projections", async () => {
    const harness = createHarness();
    harness.records.push(
      conversation({ id: "group:777", scope: "private", title: "伪装私聊" }),
      conversation({ id: "private:888", scope: "user_group", title: "非法群记录" }),
      conversation({ id: "web:admin", scope: "bot_group", title: "非法 Web 记录" })
    );
    const otherRecord = conversation({
      id: "account:other:group:999",
      accountId: "other",
      groupId: 999,
      groupName: "其他 Agent 群"
    });
    const otherRuntime: SystemConfigRuntime = {
      ...harness.runtime,
      getConversationRecords: () => [structuredClone(otherRecord)]
    };
    harness.getRuntime.mockImplementation((agentId: string) =>
      agentId === "other-agent" ? otherRuntime : harness.runtime
    );

    const current = await execute(harness, systemInput("list_groups"));
    const otherContext = { ...harness.context, agentId: "other-agent" };
    const other = await harness.service.createTurn(otherContext)
      .execute(systemInput("list_groups")) as any;

    expect(current.items.map((item: any) => item.conversationId)).toEqual([
      "account:secondary:group:202",
      "group:101"
    ]);
    expect(other.items).toEqual([{
      conversationId: "account:other:group:999",
      accountId: "other",
      groupId: 999,
      title: "其他 Agent 群",
      scope: "user_group",
      replyEnabled: true,
      orchestratorEnabled: true,
      lastAt: "2026-07-16T00:01:00.000Z"
    }]);
    expect(Object.keys(current.items[0]).sort()).toEqual([
      "accountId",
      "conversationId",
      "groupId",
      "lastAt",
      "orchestratorEnabled",
      "replyEnabled",
      "scope",
      "title"
    ].sort());
    const serialized = JSON.stringify({ current, other });
    expect(serialized).not.toContain(SECRET_MESSAGE);
    expect(serialized).not.toContain("messages");
    expect(serialized).not.toContain("lastText");
    expect(harness.getRuntime).toHaveBeenCalledWith(AGENT_ID);
    expect(harness.getRuntime).toHaveBeenCalledWith("other-agent");
  });

  it("sanitizes runtime probe and status details", async () => {
    const harness = createHarness("web:admin");

    const result = await execute(harness, systemInput("get_status"));

    expect(result).toEqual({
      ok: true,
      operation: "get_status",
      agentId: AGENT_ID,
      startedAt: STARTED_AT,
      uptimeSeconds: 123,
      onebot: {
        connected: true,
        connections: 1,
        selfIds: ["10001"],
        accounts: [{ accountId: "primary", selfId: "10001", connectedAt: "2026-07-16T00:00:10.000Z" }],
        connectedAt: "2026-07-16T00:00:10.000Z",
        lastEventAt: "2026-07-16T00:01:00.000Z",
        lastMessageEventAt: "2026-07-16T00:01:01.000Z"
      },
      persona: { id: AGENT_ID, name: "普拉娜", memoryItems: 7 },
      provider: {
        defaultProviderId: "open-arona-codex",
        model: "gpt-5.5",
        imageModel: "gpt-image-2",
        apiKeyConfigured: true
      },
      bash: {
        enabled: false,
        configuredEnabled: false,
        adminPrivateBackend: "native",
        configuredBackend: "native",
        auditModel: "gpt-5.4-mini",
        strictMode: true,
        available: true,
        effectiveEnabled: false,
        unavailableReason: "BASH_CONFIG_DISABLED",
        unavailableMessage: "Bash 未启用。",
        isolationRequired: "bubblewrap_or_equivalent",
        rawHostFallbackAllowed: false,
        dockerSocketAllowed: false
      },
      recovery: { required: true },
      probe: {
        summary: { liveness: "pass", readiness: "warn", capability: "pass" },
        checks: [
          { id: "database", kind: "readiness", status: "pass", code: null },
          { id: "onebot", kind: "capability", status: "warn", code: "ONEBOT_OFFLINE" }
        ]
      }
    });

    const serialized = JSON.stringify(result);
    for (const secret of [SECRET_PATH, SECRET_PROVIDER_ENV, SECRET_DIAGNOSTIC, "ONEBOT_PRIVATE_TOKEN"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("message");
    expect(serialized).not.toContain("details");
    expect(serialized).not.toContain("baseUrl");
  });

  it.each([
    ["auto reply", systemInput("set_auto_reply", { replyScope: "private", enabled: false })],
    ["orchestrator", systemInput("set_orchestrator", { enabled: false })],
    ["search", systemInput("set_search", { enabled: true, searchImplementation: "tavily" })],
    ["Bash backend", systemInput("set_bash_admin_backend", { bashAdminBackend: "docker" })],
    ["group reply", systemInput("set_group_reply", { conversationId: "group:101", enabled: false })]
  ] as const)("rejects the Web Chat %s mutation before staging or reading configuration", async (_label, input) => {
    const harness = createHarness("web:admin");
    const turn = harness.service.createTurn(harness.context);

    await expect(turn.execute(input)).resolves.toEqual({
      ok: false,
      code: "SYSTEM_CONFIG_DURABLE_DELIVERY_REQUIRED",
      error: "Web Chat 暂不支持修改系统设置，请在管理员 QQ 私聊中操作。"
    });
    expect(turn.mutationStaged()).toBe(false);

    await turn.commit();

    expect(harness.registryConfig).not.toHaveBeenCalled();
    expect(harness.registryGet).not.toHaveBeenCalled();
    expect(harness.readEnvelope).not.toHaveBeenCalled();
    expect(harness.patch).not.toHaveBeenCalled();
    expect(harness.setConversationReplyEnabled).not.toHaveBeenCalled();
  });

  it("keeps Web Chat queries available after a rejected mutation and a rebuilt turn", async () => {
    const harness = createHarness("web:admin");
    const rejectedTurn = harness.service.createTurn(harness.context);

    await rejectedTurn.execute(systemInput("set_auto_reply", {
      replyScope: "all",
      enabled: false
    }));
    await rejectedTurn.commit();

    const settings = await rejectedTurn.execute(systemInput("get_settings"));
    const rebuiltService = new SystemConfigService(harness.options);
    const rebuiltTurn = rebuiltService.createTurn(harness.context);
    const status = await rebuiltTurn.execute(systemInput("get_status"));

    expect(settings).toMatchObject({ ok: true, operation: "get_settings" });
    expect(status).toMatchObject({ ok: true, operation: "get_status" });
    expect(rejectedTurn.mutationStaged()).toBe(false);
    expect(rebuiltTurn.mutationStaged()).toBe(false);
    expect(harness.patch).not.toHaveBeenCalled();
    expect(harness.setConversationReplyEnabled).not.toHaveBeenCalled();
  });

  it("permits only one staged mutation per turn and explains orchestrator scope", async () => {
    const harness = createHarness();
    const turn = harness.service.createTurn(harness.context);

    const first = await turn.execute(systemInput("set_orchestrator", { enabled: true }));
    const second = await turn.execute(systemInput("set_search", { enabled: true }));

    expect(first).toMatchObject({
      ok: true,
      operation: "set_orchestrator",
      staged: true,
      persisted: false,
      effectiveFrom: "next_turn",
      scope: "ambient_group_replies",
      groupThreadClassifierControlled: false,
      changes: ["orchestrator.enabled"]
    });
    expect(second).toEqual({
      ok: false,
      code: "SYSTEM_CONFIG_MUTATION_PENDING",
      error: "配置修改后请直接完成当前回复。"
    });
    expect(turn.mutationStaged()).toBe(true);
    expect(harness.patch).not.toHaveBeenCalled();

    await turn.commit();

    expect(turn.mutationStaged()).toBe(false);
    expect(harness.patch).toHaveBeenCalledOnce();
    expect(harness.patch).toHaveBeenCalledWith(AGENT_ID, "orchestrator", {
      revision: configRevision(harness.config),
      value: { ...harness.config.bot.orchestrator, enabled: true }
    });
  });

  it("discards a staged mutation without persisting it", async () => {
    const harness = createHarness();
    const turn = harness.service.createTurn(harness.context);

    await turn.execute(systemInput("set_auto_reply", { replyScope: "all", enabled: false }));
    expect(turn.mutationStaged()).toBe(true);

    turn.discard();
    await turn.commit();

    expect(turn.mutationStaged()).toBe(false);
    expect(harness.patch).not.toHaveBeenCalled();
  });

  it("exposes the normalized private-gate descriptor and rejects the whole turn without side effects", async () => {
    const harness = createHarness();
    const turn = harness.service.createTurn(harness.context);
    const input = systemInput("set_auto_reply", { replyScope: "private", enabled: false });

    await turn.execute(input);

    expect(turn.stagedMutation()).toEqual({
      action: "set_auto_reply",
      normalizedInput: input,
      closesCurrentPrivateReplyGate: true
    });

    turn.rejectTurn();

    expect(turn.turnRejected()).toBe(true);
    expect(turn.mutationStaged()).toBe(false);
    expect(turn.stagedMutation()).toBeUndefined();
    await expect(turn.commit()).rejects.toThrow("已拒绝的 system_config 回合不能提交配置");
    expect(harness.patch).not.toHaveBeenCalled();
  });

  it("does not mark unrelated mutations as closing the current private gate", async () => {
    const harness = createHarness();
    const turn = harness.service.createTurn(harness.context);
    const input = systemInput("set_orchestrator", { enabled: true });

    await turn.execute(input);

    expect(turn.stagedMutation()).toEqual({
      action: "set_orchestrator",
      normalizedInput: input,
      closesCurrentPrivateReplyGate: false
    });
    turn.discard();
  });

  it("stages autoReply all and commits the onebot section with the captured revision", async () => {
    const harness = createHarness();
    const turn = harness.service.createTurn(harness.context);

    const result = await turn.execute(systemInput("set_auto_reply", {
      replyScope: "all",
      enabled: false
    }));

    expect(result).toMatchObject({
      ok: true,
      staged: true,
      before: { private: true, userGroup: true, botGroup: false },
      after: { private: false, userGroup: false, botGroup: false },
      changes: ["autoReply.private", "autoReply.userGroup"]
    });
    expect(harness.patch).not.toHaveBeenCalled();

    await turn.commit();

    expect(harness.patch).toHaveBeenCalledWith(AGENT_ID, "onebot", {
      revision: configRevision(harness.config),
      value: {
        reverseWsPath: harness.config.onebot.reverseWsPath,
        accessTokenEnv: harness.config.onebot.accessTokenEnv,
        autoReplyPrivate: false,
        autoReplyUserGroup: false,
        autoReplyBotGroup: false,
        mentionNames: harness.config.onebot.mentionNames,
        commandPrefixes: harness.config.onebot.commandPrefixes
      }
    });
    expect(harness.patch.mock.calls[0]?.[2].value).not.toHaveProperty("quoteGroupReplies");
  });

  it("commits a Tavily search override without dropping other tool settings", async () => {
    const harness = createHarness();
    const turn = harness.service.createTurn(harness.context);

    const result = await turn.execute(systemInput("set_search", {
      enabled: true,
      searchImplementation: "tavily"
    }));

    expect(result).toMatchObject({
      ok: true,
      staged: true,
      before: { enabled: null, implementation: "tavily" },
      after: { enabled: true, implementation: "tavily" },
      changes: ["search.enabled"],
      availableImplementations: ["tavily"]
    });

    await turn.commit();

    const expectedTools = structuredClone(harness.config.bot.tools);
    expectedTools.overrides = {
      ...expectedTools.overrides,
      websearch: { ...expectedTools.overrides?.websearch, enabled: true }
    };
    expectedTools.websearch.provider = "tavily";
    expect(harness.patch).toHaveBeenCalledWith(AGENT_ID, "tools", {
      revision: configRevision(harness.config),
      value: expectedTools
    });
    expect(harness.patch.mock.calls[0]?.[2].value.websearch.tavilyApiKey).toBe(SECRET_TAVILY_KEY);
    expect(harness.patch.mock.calls[0]?.[2].value.overrides.selfie).toEqual({
      enabled: false,
      description: "PRIVATE_TOOL_DESCRIPTION"
    });
  });

  it("updates a known account-qualified group only after commit", async () => {
    const harness = createHarness();
    const turn = harness.service.createTurn(harness.context);
    const conversationId = "account:secondary:group:202";

    const result = await turn.execute(systemInput("set_group_reply", {
      conversationId,
      enabled: false,
      orchestratorEnabled: true
    }));

    expect(result).toMatchObject({
      ok: true,
      staged: true,
      persisted: false,
      conversationId,
      before: { replyEnabled: true, orchestratorEnabled: false },
      after: { replyEnabled: false, orchestratorEnabled: true }
    });
    expect(harness.setConversationReplyEnabled).not.toHaveBeenCalled();

    await turn.commit();

    expect(harness.setConversationReplyEnabled).toHaveBeenCalledOnce();
    expect(harness.setConversationReplyEnabled).toHaveBeenCalledWith({
      id: conversationId,
      replyEnabled: false,
      orchestratorEnabled: true
    });
    expect(harness.records.find((record) => record.id === conversationId)).toMatchObject({
      replyEnabled: false,
      orchestratorEnabled: true
    });
  });

  it("keeps set_group_reply available beyond the get_settings summary page", async () => {
    const harness = createHarness();
    const target = conversation({
      id: "account:secondary:group:999",
      accountId: "secondary",
      groupId: 999,
      groupName: "摘要外群聊"
    });
    harness.records.splice(0, harness.records.length,
      ...Array.from({ length: 100 }, (_, index) => conversation({
        id: `group:${index + 1}`,
        groupId: index + 1
      })),
      target
    );
    const settings = await execute(harness, systemInput("get_settings"));
    const turn = harness.service.createTurn(harness.context);

    expect(settings.groups).toMatchObject({ total: 101, truncated: true });
    expect(settings.groups.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: target.id })
    ]));

    await expect(turn.execute(systemInput("set_group_reply", {
      conversationId: target.id,
      enabled: false
    }))).resolves.toMatchObject({ ok: true, staged: true });
    await turn.commit();

    expect(harness.setConversationReplyEnabled).toHaveBeenCalledWith({
      id: target.id,
      replyEnabled: false
    });
  });

  it("rejects bare and unknown group identifiers without staging a mutation", async () => {
    const harness = createHarness();
    const turn = harness.service.createTurn(harness.context);

    await expect(turn.execute(systemInput("set_group_reply", {
      conversationId: "202",
      enabled: false
    }))).resolves.toMatchObject({
      ok: false,
      code: "SYSTEM_CONFIG_GROUP_INVALID"
    });
    await expect(turn.execute(systemInput("set_group_reply", {
      conversationId: "account:secondary:group:999",
      enabled: false
    }))).resolves.toMatchObject({
      ok: false,
      code: "SYSTEM_CONFIG_GROUP_NOT_FOUND"
    });

    expect(turn.mutationStaged()).toBe(false);
    await turn.commit();
    expect(harness.setConversationReplyEnabled).not.toHaveBeenCalled();
  });

  it("detects a concurrent group update before commit", async () => {
    const harness = createHarness();
    const turn = harness.service.createTurn(harness.context);

    await turn.execute(systemInput("set_group_reply", {
      conversationId: "group:101",
      enabled: false
    }));
    harness.records[0]!.orchestratorEnabled = false;

    await expect(turn.commit()).rejects.toMatchObject({
      code: "SYSTEM_CONFIG_REVISION_CONFLICT",
      message: "群聊设置已更新，请重新查询后再修改。"
    });
    expect(turn.mutationStaged()).toBe(true);
    expect(harness.setConversationReplyEnabled).not.toHaveBeenCalled();
    turn.discard();
  });

  it("returns a persisted no-op without staging or patching", async () => {
    const harness = createHarness();
    const turn = harness.service.createTurn(harness.context);

    const result = await turn.execute(systemInput("set_auto_reply", {
      replyScope: "private",
      enabled: true
    }));

    expect(result).toEqual({
      ok: true,
      operation: "set_auto_reply",
      staged: false,
      persisted: true,
      noOp: true,
      effectiveFrom: "current_turn",
      before: { private: true, userGroup: true, botGroup: false },
      after: { private: true, userGroup: true, botGroup: false },
      changes: []
    });
    expect(turn.mutationStaged()).toBe(false);
    await turn.commit();
    expect(harness.patch).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "native isolation unavailable",
      enabled: true,
      backend: "native" as const,
      available: false,
      reason: "BASH_NATIVE_ISOLATION_UNAVAILABLE",
      message: "Native 后端未通过 bubblewrap 或等价强隔离检查；Bash 已安全关闭，不会回退到宿主 Bash。可切换 Docker 后端后重新检查。"
    },
    {
      label: "docker isolation unavailable",
      enabled: true,
      backend: "docker" as const,
      available: false,
      reason: "BASH_DOCKER_ISOLATION_UNAVAILABLE",
      message: "Docker 后端未通过强隔离检查；Bash 已安全关闭，不会使用 Docker socket 或宿主 Bash 回退。"
    },
    {
      label: "configuration disabled",
      enabled: false,
      backend: "native" as const,
      available: true,
      reason: "BASH_CONFIG_DISABLED",
      message: "Bash 未启用。"
    },
    {
      label: "enabled with isolation",
      enabled: true,
      backend: "native" as const,
      available: true,
      reason: null,
      message: null
    }
  ])("reports Bash configured and effective state for $label", async ({
    enabled,
    backend,
    available,
    reason,
    message
  }) => {
    const harness = createHarness();
    harness.config.bot.bash.enabled = enabled;
    harness.config.bot.bash.adminPrivateBackend = backend;
    harness.runtime.resolveToolCapabilities = vi.fn(async () => ({ workspaceBash: available }));

    for (const operation of ["get_settings", "get_status"] as const) {
      const result = await execute(harness, systemInput(operation));
      expect(result.bash).toMatchObject({
        configuredEnabled: enabled,
        adminPrivateBackend: backend,
        available,
        effectiveEnabled: enabled && available,
        unavailableReason: reason,
        unavailableMessage: message,
        rawHostFallbackAllowed: false,
        dockerSocketAllowed: false
      });
    }
  });

  it("fails closed when the Bash capability resolver throws without exposing its error", async () => {
    const harness = createHarness();
    harness.config.bot.bash.enabled = true;
    harness.runtime.resolveToolCapabilities = vi.fn(async () => {
      throw new Error(`probe failed at ${SECRET_PATH}`);
    });

    const result = await execute(harness, systemInput("get_settings"));

    expect(result.bash).toMatchObject({
      available: false,
      effectiveEnabled: false,
      unavailableReason: "BASH_NATIVE_ISOLATION_UNAVAILABLE"
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_PATH);
  });

  it.each([
    ["BASH_AUDIT_UNAVAILABLE", "独立 Bash 审计不可用，Bash 已安全关闭。"],
    ["BASH_WORKBENCH_UNAVAILABLE", "当前 Agent workbench 不可用，Bash 已安全关闭。"]
  ] as const)("preserves the safe Bash capability reason %s", async (reason, message) => {
    const harness = createHarness();
    harness.config.bot.bash.enabled = true;
    harness.runtime.resolveToolCapabilities = vi.fn(async () => ({
      workspaceBash: false,
      workspaceBashReason: reason
    }));

    for (const operation of ["get_settings", "get_status"] as const) {
      const result = await execute(harness, systemInput(operation));
      expect(result.bash).toMatchObject({
        available: false,
        effectiveEnabled: false,
        unavailableReason: reason,
        unavailableMessage: message,
        unavailabilityKind: "runtime"
      });
    }
  });

  it("reports the disabled administrator identity gate as a session restriction", async () => {
    const harness = createHarness();
    harness.config.bot.bash.enabled = true;
    harness.config.bot.bash.adminOnly = false;
    harness.runtime.resolveToolCapabilities = vi.fn(async () => ({ workspaceBash: true }));

    const result = await execute(harness, systemInput("get_settings"));

    expect(result.bash).toMatchObject({
      configuredEnabled: true,
      available: false,
      effectiveEnabled: false,
      unavailableReason: "BASH_ADMIN_IDENTITY_DISABLED",
      unavailableMessage: "管理员身份门禁已关闭，所有会话均不可用。",
      unavailabilityKind: "session"
    });
  });

  it("stages only the administrator Bash backend preference and never claims capability", async () => {
    const harness = createHarness();
    harness.config.bot.bash.enabled = true;
    harness.runtime.resolveToolCapabilities = vi.fn(async () => ({ workspaceBash: false }));
    const turn = harness.service.createTurn(harness.context);

    const result = await turn.execute(systemInput("set_bash_admin_backend", {
      bashAdminBackend: "docker"
    }));

    expect(result).toMatchObject({
      ok: true,
      staged: true,
      persisted: false,
      before: { adminPrivateBackend: "native" },
      after: { adminPrivateBackend: "docker" },
      preferenceOnly: true,
      isolationCapabilityRequired: true
    });
    expect(result).not.toHaveProperty("effectiveEnabled");
    expect(harness.patch).not.toHaveBeenCalled();

    await turn.commit();

    expect(harness.patch).toHaveBeenCalledWith(AGENT_ID, "bash", {
      revision: configRevision(harness.config),
      value: { ...harness.config.bot.bash, adminPrivateBackend: "docker" }
    });
  });
});

function createHarness(conversationId = "private:10001") {
  const config = testConfig();
  const records = testRecords();
  const fieldStates = {
    "bot.tools.websearch.tavilyApiKeyEnv": { secretConfigured: true },
    "providers.items.open-arona-codex.apiKeyEnv": { secretConfigured: true }
  };
  const patch = vi.fn(async () => ({
    config: structuredClone(config),
    revision: configRevision(config),
    fieldStates
  }));
  const setConversationReplyEnabled = vi.fn((input: {
    id: string;
    replyEnabled?: boolean;
    orchestratorEnabled?: boolean;
  }) => {
    const index = records.findIndex((record) => record.id === input.id);
    if (index < 0) throw new Error("group missing");
    records[index] = {
      ...records[index]!,
      ...(input.replyEnabled == null ? {} : { replyEnabled: input.replyEnabled }),
      ...(input.orchestratorEnabled == null ? {} : { orchestratorEnabled: input.orchestratorEnabled })
    };
    return structuredClone(records[index]!);
  });
  const registryConfig = vi.fn(async () => structuredClone(config));
  const registryGet = vi.fn(async () => ({
    id: AGENT_ID,
    name: "普拉娜",
    enabled: true,
    workspace: SECRET_PATH,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    accounts: []
  }));
  const readEnvelope = vi.fn(async () => ({
    config: structuredClone(config),
    revision: configRevision(config),
    fieldStates
  }));
  const runtime: SystemConfigRuntime = {
    getConversationRecords: () => structuredClone(records),
    getPersonaStatus: () => ({
      id: AGENT_ID,
      name: "普拉娜",
      memoryItems: 7,
      workspace: SECRET_PATH,
      promptFiles: [SECRET_PATH]
    }),
    getProviderStatus: () => ({
      defaultProviderId: "open-arona-codex",
      model: "gpt-5.5",
      imageModel: "gpt-image-2",
      apiKeyConfigured: true,
      apiKeyEnv: SECRET_PROVIDER_ENV,
      baseUrl: SECRET_PATH
    }),
    resolveToolCapabilities: vi.fn(async () => ({ workspaceBash: true })),
    setConversationReplyEnabled
  };
  const getRuntime = vi.fn((_agentId: string) => runtime);
  const options = {
    registry: {
      config: registryConfig,
      get: registryGet
    },
    agentConfigService: {
      readEnvelope,
      patch
    },
    getRuntime,
    getOnebotStatus: () => ({
      connected: true,
      connections: 1,
      selfIds: [10001],
      accounts: [{
        accountId: "primary",
        selfId: 10001,
        connectedAt: "2026-07-16T00:00:10.000Z",
        token: "ONEBOT_PRIVATE_TOKEN"
      }],
      connectedAt: "2026-07-16T00:00:10.000Z",
      lastEventAt: "2026-07-16T00:01:00.000Z",
      lastMessageEventAt: "2026-07-16T00:01:01.000Z",
      accessToken: "ONEBOT_PRIVATE_TOKEN",
      socketPath: SECRET_PATH
    }),
    getRuntimeProbe: async () => ({
      summary: { liveness: "pass", readiness: "warn", capability: "pass", details: SECRET_DIAGNOSTIC },
      checks: [
        {
          id: "database",
          kind: "readiness",
          status: "pass",
          code: null,
          message: SECRET_DIAGNOSTIC,
          path: SECRET_PATH
        },
        {
          id: "onebot",
          kind: "capability",
          status: "warn",
          code: "ONEBOT_OFFLINE",
          details: { token: "ONEBOT_PRIVATE_TOKEN" }
        }
      ],
      rawConfig: config,
      diagnostic: SECRET_DIAGNOSTIC
    }),
    getRecoveryStatus: () => ({ required: true, message: SECRET_DIAGNOSTIC, path: SECRET_PATH }),
    startedAt: STARTED_AT,
    now: () => new Date("2026-07-16T00:02:03.000Z")
  } as unknown as SystemConfigServiceOptions;
  const context: SystemConfigTurnContext = {
    agentId: AGENT_ID,
    conversationId,
    promptToolNames: ["websearch", "system_config"]
  };

  return {
    config,
    context,
    getRuntime,
    patch,
    readEnvelope,
    records,
    registryConfig,
    registryGet,
    options,
    runtime,
    service: new SystemConfigService(options),
    setConversationReplyEnabled
  };
}

async function execute(harness: ReturnType<typeof createHarness>, input: SystemConfigInput) {
  return await harness.service.createTurn(harness.context).execute(input) as any;
}

function testConfig(): AppConfig {
  const config = defaultConfig();
  config.persona.agentWorkspace = SECRET_PATH;
  config.persona.systemPromptWorkspace = `${SECRET_PATH}/prompts`;
  config.providers.items = [
    {
      ...config.providers.items[0]!,
      apiKeyEnv: SECRET_PROVIDER_ENV,
      envFile: SECRET_PATH,
      baseUrl: "https://private.example.test/api?token=provider-secret"
    }
  ];
  config.providers.defaultProviderId = config.providers.items[0]!.id;
  config.bot.adminQq = "PRIVATE_ADMIN_QQ";
  config.bot.orchestrator.enabled = false;
  config.bot.tools.overrides = {
    websearch: { description: "PRIVATE_SEARCH_DESCRIPTION" },
    selfie: { enabled: false, description: "PRIVATE_TOOL_DESCRIPTION" }
  };
  config.bot.tools.websearch.tavilyApiKey = SECRET_TAVILY_KEY;
  config.bot.tools.websearch.tavilyApiKeys = [SECRET_TAVILY_KEY];
  config.bot.tools.websearch.tavilyApiKeyEnv = "PRIVATE_TAVILY_ENV";
  config.onebot.accessTokenEnv = "ONEBOT_PRIVATE_TOKEN";
  return config;
}

function testRecords(): ConversationRecord[] {
  return [
    conversation({
      id: "group:101",
      accountId: "primary",
      groupId: 101,
      groupName: "公开群一",
      title: "公开群一",
      replyEnabled: true,
      orchestratorEnabled: true
    }),
    conversation({
      id: "account:secondary:group:202",
      accountId: "secondary",
      groupId: 202,
      groupName: "公开群二",
      title: "公开群二",
      replyEnabled: true,
      orchestratorEnabled: false
    }),
    conversation({
      id: "private:303",
      scope: "private",
      title: "私聊",
      replyEnabled: true
    }),
    conversation({
      id: "group:not-numeric",
      groupId: 404,
      title: "非法群 ID",
      replyEnabled: true
    })
  ];
}

function conversation(overrides: Partial<ConversationRecord>): ConversationRecord {
  return {
    id: "group:1",
    scope: "user_group",
    title: "群聊",
    userId: 10001,
    groupId: 1,
    replyEnabled: true,
    orchestratorEnabled: true,
    messageCount: 1,
    lastAt: "2026-07-16T00:01:00.000Z",
    lastText: SECRET_MESSAGE,
    messages: [{
      id: "message-secret",
      role: "user",
      text: SECRET_MESSAGE,
      at: "2026-07-16T00:01:00.000Z"
    }],
    ...overrides
  };
}

function systemInput(
  operation: SystemConfigInput["operation"],
  overrides: Partial<SystemConfigInput> = {}
): SystemConfigInput {
  return {
    operation,
    replyScope: null,
    enabled: null,
    orchestratorEnabled: null,
    searchImplementation: null,
    bashAdminBackend: null,
    conversationId: null,
    groupCursor: null,
    groupLimit: null,
    ...overrides
  };
}

function binaryCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
