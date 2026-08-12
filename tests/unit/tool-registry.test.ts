import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import { createTurnToolState } from "../../adapters/model/provider/turnToolState.js";
import type { ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import type { OpenAIToolDefinition } from "../../services/agent/promptSystem.js";
import { defaultFinalPromptTemplate } from "../../services/agent/promptDefaults.js";
import { sendFileTool } from "../../services/tools/sendConversationAssetTool.js";
import { AGENT_TOOL_NAMES } from "../../src/types.js";
import {
  isProviderToolAvailable,
  listToolMetadata,
  providerToolExecutionMode,
  resolveProviderToolDefinitions
} from "../../services/tools/toolRegistry.js";

describe("ToolRegistry", () => {
  it("uses one canonical name for metadata and the model definition", () => {
    const metadata = listToolMetadata();
    const definitions = resolveProviderToolDefinitions({
      bash: {
        enabled: true,
        workspacePath: "/fixture/agent-workspace",
        backend: "native",
        accessMode: "isolated",
        strictMode: true,
        isAdmin: false,
        userRequest: "生成并发送报告",
        isCurrent: () => true,
        audit: vi.fn(),
        approvalContext: {
          backend: "native",
          agentId: "plana",
          accountId: "primary",
          transport: "onebot",
          conversationId: "private:171419991",
          userId: "171419991"
        }
      }
    });
    const names = definitions.map((definition) => String(definition.name));

    expect(metadata.some((tool) => tool.name === "native_bash")).toBe(true);
    expect(metadata.some((tool) => tool.name === "docker_bash")).toBe(false);
    expect(metadata.some((tool) => tool.name === "bash.run")).toBe(false);
    expect(metadata.map((tool) => tool.name)).toEqual(
      AGENT_TOOL_NAMES.filter((name) => name !== "add_workmemory" && name !== "add_user_profile")
    );
    expect(metadata.some((tool) => tool.name === "add_workmemory")).toBe(false);
    expect(metadata.some((tool) => tool.name === "add_user_profile")).toBe(false);
    expect(metadata.some((tool) => tool.name === "system.time")).toBe(false);
    expect(metadata.some((tool) => tool.name === "onebot.send_message")).toBe(false);
    expect(metadata.some((tool) => tool.name === "provider.test")).toBe(false);
    expect(names).toEqual(["native_bash"]);
    expect(providerToolExecutionMode("native_bash")).toBe("inline");
    expect(providerToolExecutionMode("docker_bash" as never)).toBeUndefined();
  });

  it("does not expose disabled provider tools", () => {
    expect(resolveProviderToolDefinitions({})).toEqual([]);
  });

  it("always exposes add_workmemory in ordinary host-bound turns without a settings switch", () => {
    const options = {
      workingMemory: { execute: vi.fn() },
      disabledTools: ["add_workmemory"] as const,
      bot: {
        tools: {
          overrides: { add_workmemory: { enabled: false } }
        }
      }
    } as unknown as ProviderCompleteOptions;
    expect(resolveProviderToolDefinitions(options, []).map((tool) => tool.name))
      .toEqual(["add_workmemory"]);
    expect(isProviderToolAvailable("add_workmemory", options)).toBe(true);
    expect(listToolMetadata(options).some((tool) => tool.name === "add_workmemory")).toBe(false);
  });

  it("always exposes add_user_profile in ordinary host-bound turns without a settings switch", () => {
    const options = {
      userProfile: { execute: vi.fn() },
      disabledTools: ["add_user_profile"] as const,
      bot: {
        tools: {
          overrides: { add_user_profile: { enabled: false } }
        }
      }
    } as unknown as ProviderCompleteOptions;
    expect(resolveProviderToolDefinitions(options, []).map((tool) => tool.name))
      .toEqual(["add_user_profile"]);
    expect(isProviderToolAvailable("add_user_profile", options)).toBe(true);
    expect(listToolMetadata(options).some((tool) => tool.name === "add_user_profile")).toBe(false);
  });

  it("applies the conversation selection after the Agent master switch", async () => {
    const options = {
      onAssistantText: vi.fn(),
      allowNoReply: true,
      disabledTools: ["assistant_text"] as const
    } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, [
      staleTool("assistant_text"),
      staleTool("no_reply")
    ]);

    expect(definitions.map((definition) => definition.name)).toEqual(["no_reply"]);
    expect(providerToolExecutionMode("assistant_text", options)).toBeUndefined();
    expect(isProviderToolAvailable("assistant_text", options)).toBe(false);
    expect(listToolMetadata(options, [staleTool("assistant_text")]).find((tool) => tool.name === "assistant_text"))
      .toMatchObject({ enabled: true, available: true, effectiveEnabled: false });

    const [forged] = await executor.execute([{
      type: "function_call",
      name: "assistant_text",
      call_id: "call-disabled-by-conversation",
      arguments: JSON.stringify({ text: "should not send" })
    }], options, definitions);
    expect(JSON.parse(String(forged?.output))).toEqual({
      ok: false,
      error: "Unsupported tool: assistant_text"
    });
    expect(options.onAssistantText).not.toHaveBeenCalled();
  });

  it("keeps API-only Bash capability metadata separate from executable Provider options", () => {
    const bash = listToolMetadata({ bashAvailable: true }).find((tool) => tool.name === "native_bash");

    expect(bash).toMatchObject({ available: true });
    expect(resolveProviderToolDefinitions({ bashAvailable: true })).toEqual([]);
  });

  it("classifies workbench file access as a session scope instead of a runtime failure", () => {
    const metadata = listToolMetadata();

    for (const name of ["read_file", "write_file"] as const) {
      expect(metadata.find((tool) => tool.name === name)).toMatchObject({
        available: false,
        unavailabilityKind: "session",
        accessLabel: "管理员 QQ 私聊可用",
        accessDescription: "Web Chat、群聊和普通用户私聊不可用。"
      });
    }
  });

  it("describes cron as available in every group chat", () => {
    expect(listToolMetadata().find((tool) => tool.name === "cron")).toMatchObject({
      unavailabilityKind: "session",
      accessLabel: "全部群聊、管理员私聊与 Web Chat 可用",
      accessDescription: "群聊成员均可使用；私聊与 Web Chat 仅管理员可用。"
    });
  });

  it("keeps Skill capability separate from inventory and never exposes empty-enum Provider tools", () => {
    const capabilityOnly = {
      skillCapabilities: {
        activate: true,
        readResource: true,
        runScript: false,
        skillIds: []
      }
    };
    const metadata = listToolMetadata(capabilityOnly);

    expect(metadata.find((tool) => tool.name === "activate_skill"))
      .toMatchObject({ available: true, effectiveEnabled: false });
    expect(metadata.find((tool) => tool.name === "read_skill_resource"))
      .toMatchObject({ available: true, effectiveEnabled: false });
    expect(metadata.find((tool) => tool.name === "run_skill_script")).toMatchObject({
      available: false,
      effectiveEnabled: false,
      availabilityReason: "当前环境没有可用的 Skill 脚本审计执行器。"
    });
    expect(resolveProviderToolDefinitions(capabilityOnly)).toEqual([]);
    expect(isProviderToolAvailable("activate_skill", capabilityOnly)).toBe(false);

    const withInventory = {
      skills: {
        skillIds: ["approved"],
        activate: vi.fn(),
        readResource: vi.fn()
      }
    };
    expect(resolveProviderToolDefinitions(withInventory).map((tool) => tool.name))
      .toEqual(["activate_skill", "read_skill_resource"]);
    expect(listToolMetadata(withInventory).find((tool) => tool.name === "activate_skill"))
      .toMatchObject({ available: true, effectiveEnabled: true });
  });

  it("exposes assistant_text only when the runtime can deliver intermediate text", () => {
    expect(resolveProviderToolDefinitions({ onAssistantText: () => undefined }).map((tool) => tool.name))
      .toEqual(["assistant_text"]);
    expect(providerToolExecutionMode("assistant_text")).toBe("inline");
  });

  it("exposes send_file only with current-conversation delivery and keeps voice unavailable", async () => {
    const send = async () => ({
      ok: true as const,
      queued: true as const,
      kind: "file" as const,
      name: "report.pdf",
      byteLength: 123
    });
    const options = {
      conversationAssets: { enabled: true, send }
    } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, [
      staleTool("send_file"),
      staleTool("send_voice_message")
    ]);

    expect(definitions.map((definition) => definition.name)).toEqual(["send_file"]);
    expect(definitions[0]).toMatchObject({
      strict: true,
      parameters: sendFileTool.parameters
    });
    expect((definitions[0]?.parameters as Record<string, any>).properties.task).toBeUndefined();
    expect(providerToolExecutionMode("send_file", options)).toBe("inline");
    expect(listToolMetadata(options, [staleTool("send_file")]).find((tool) => tool.name === "send_file"))
      .toMatchObject({ available: true, effectiveEnabled: true, execution: "inline" });
    expect(listToolMetadata(options).find((tool) => tool.name === "send_voice_message"))
      .toMatchObject({ available: false, effectiveEnabled: false });

    const [fileOutput] = await executor.execute([{
      type: "function_call",
      name: "send_file",
      call_id: "call-send-file",
      arguments: JSON.stringify({ path: "exports/report.pdf", kind: "file", name: null })
    }], options, definitions);
    expect(JSON.parse(String(fileOutput?.output))).toMatchObject({
      ok: true,
      queued: true,
      kind: "file",
      name: "report.pdf"
    });

    let forgedSideEffects = 0;
    const forgedOptions = {
      conversationAssets: {
        enabled: true,
        send: async () => { forgedSideEffects += 1; return { ok: true }; }
      }
    } satisfies ProviderCompleteOptions;
    const forgedDefinitions = executor.resolveDefinitions(forgedOptions, [staleTool("send_file")]);
    const [forgedOutput] = await executor.execute([{
      type: "function_call",
      name: "send_file",
      call_id: "call-send-file-forged-target",
      arguments: JSON.stringify({
        path: "exports/report.pdf",
        kind: "file",
        name: null,
        accountId: "account-b",
        groupId: 602
      })
    }], forgedOptions, forgedDefinitions);
    expect(JSON.parse(String(forgedOutput?.output))).toEqual({
      ok: false,
      error: "send_file arguments contain unsupported fields."
    });
    expect(forgedSideEffects).toBe(0);

    for (const [label, argumentsValue] of [
      ["missing-name", { path: "exports/report.pdf", kind: "file" }],
      ["blank-name", { path: "exports/report.pdf", kind: "file", name: "   " }],
      ["long-name", { path: "exports/report.pdf", kind: "file", name: "a".repeat(256) }],
      ["unsafe-name", { path: "exports/report.pdf", kind: "file", name: "other/report.pdf" }]
    ] as const) {
      const [invalidOutput] = await executor.execute([{
        type: "function_call",
        name: "send_file",
        call_id: `call-send-file-${label}`,
        arguments: JSON.stringify(argumentsValue)
      }], forgedOptions, forgedDefinitions);
      expect(JSON.parse(String(invalidOutput?.output))).toMatchObject({ ok: false });
    }
    expect(forgedSideEffects).toBe(0);

    const [voiceOutput] = await executor.execute([{
      type: "function_call",
      name: "send_voice_message",
      call_id: "call-send-voice",
      arguments: JSON.stringify({ path: "audio/reply.amr" })
    }], options, definitions);
    expect(JSON.parse(String(voiceOutput?.output))).toEqual({
      ok: false,
      error: "Tool send_voice_message is unavailable."
    });
  });

  it("injects send_file into legacy non-empty prompts while preserving an explicit off switch", () => {
    const executor = new RegistryProviderToolExecutor();
    const available = {
      conversationAssets: { enabled: true, send: async () => ({ ok: true }) }
    } satisfies ProviderCompleteOptions;

    expect(executor.resolveDefinitions(available, [staleTool("assistant_text")]))
      .toEqual([expect.objectContaining({ name: "send_file", strict: true })]);

    const disabled = {
      ...available,
      bot: {
        tools: {
          overrides: { send_file: { enabled: false } }
        }
      }
    } as unknown as ProviderCompleteOptions;
    expect(executor.resolveDefinitions(disabled, [staleTool("assistant_text")])).toEqual([]);
    expect(listToolMetadata(disabled, [staleTool("assistant_text")]).find((tool) => tool.name === "send_file"))
      .toMatchObject({ configuredEnabled: false, enabled: false, available: true, effectiveEnabled: false });
  });

  it("allows send_file with another inline tool in the same batch", async () => {
    const sentFiles: unknown[] = [];
    const sentText: string[] = [];
    const options = {
      conversationAssets: {
        enabled: true,
        send: async (input: unknown) => {
          sentFiles.push(input);
          return { ok: true };
        }
      },
      onAssistantText: async (text: string) => { sentText.push(text); }
    } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, [staleTool("send_file"), staleTool("assistant_text")]);

    const outputs = await executor.execute([{
      type: "function_call",
      name: "send_file",
      call_id: "call-send-file-mixed",
      arguments: JSON.stringify({ path: "exports/report.pdf", kind: "file", name: null })
    }, {
      type: "function_call",
      name: "assistant_text",
      call_id: "call-assistant-text-mixed-with-file",
      arguments: JSON.stringify({ text: "文件已加入发送队列。" })
    }], options, definitions);

    expect(outputs.map((output) => JSON.parse(String(output.output)))).toEqual([
      { ok: true },
      { ok: true, delivered: true, textLength: 10 }
    ]);
    expect(sentFiles).toHaveLength(1);
    expect(sentText).toEqual(["文件已加入发送队列。"]);
  });

  it("injects no_reply into legacy reply prompts and accepts it as a terminal call", async () => {
    const used: string[] = [];
    const options = {
      allowNoReply: true,
      onToolCall: (name: string) => used.push(name)
    } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, []);
    const call = {
      type: "function_call" as const,
      name: "no_reply",
      call_id: "call-no-reply",
      arguments: "{}"
    };

    expect(definitions).toEqual([
      expect.objectContaining({
        name: "no_reply",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
          required: []
        }
      })
    ]);
    expect(listToolMetadata(options, []).find((tool) => tool.name === "no_reply")).toMatchObject({
      promptEnabled: true,
      enabled: true,
      available: true,
      effectiveEnabled: true,
      execution: "inline"
    });
    await expect(executor.noReplyTurn([call], options, definitions)).resolves.toEqual({ kind: "no_reply" });
    expect(used).toEqual(["no_reply"]);
  });

  it("allows no_reply alongside another inline tool", async () => {
    const delivered: string[] = [];
    const used: string[] = [];
    const options = {
      allowNoReply: true,
      onAssistantText: (text: string) => { delivered.push(text); },
      onToolCall: (name: string) => { used.push(name); }
    } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, [staleTool("assistant_text")]);
    const calls = [{
      type: "function_call" as const,
      name: "no_reply",
      call_id: "call-no-reply-mixed",
      arguments: "{}"
    }, {
      type: "function_call" as const,
      name: "assistant_text",
      call_id: "call-assistant-text-mixed",
      arguments: JSON.stringify({ text: "不应发送" })
    }];

    await expect(executor.noReplyTurn(calls, options, definitions)).resolves.toEqual({ kind: "no_reply" });
    const outputs = await executor.execute(calls, options, definitions);
    expect(outputs.map((output) => JSON.parse(String(output.output)))).toEqual([
      { ok: true },
      { ok: true, delivered: true, textLength: 4 }
    ]);
    expect(delivered).toEqual(["不应发送"]);
    expect(used).toEqual(["no_reply", "no_reply", "assistant_text"]);
  });

  it("allows no_reply after an ordinary tool was accepted in an earlier model round", async () => {
    const executor = new RegistryProviderToolExecutor();
    const state = createTurnToolState();
    const options = {
      allowNoReply: true,
      memory: {
        enabled: true,
        recall: async () => ({ ok: true })
      }
    } satisfies ProviderCompleteOptions;
    const definitions = executor.resolveDefinitions(options, [staleTool("memory_recall")]);
    const [memoryOutput] = await executor.execute([{
      type: "function_call",
      name: "memory_recall",
      call_id: "call-memory",
      arguments: JSON.stringify({ query: "current context", limit: 3 })
    }], options, definitions, state);
    const noReplyCall = {
      type: "function_call" as const,
      name: "no_reply",
      call_id: "call-late-no-reply",
      arguments: "{}"
    };

    expect(JSON.parse(String(memoryOutput?.output))).toEqual({ ok: true });
    await expect(executor.noReplyTurn([noReplyCall], options, definitions, state))
      .resolves.toEqual({ kind: "no_reply" });
  });

  it("injects system_config for an authorized legacy prompt and locks its canonical schema", () => {
    const options = {
      systemConfig: {
        execute: async () => ({ ok: true }),
        mutationStaged: () => false
      }
    } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const [legacyDefinition] = executor.resolveDefinitions(options, []);
    const [staleDefinition] = executor.resolveDefinitions(options, [staleTool("system_config")]);
    const legacyParameters = legacyDefinition?.parameters as Record<string, any>;
    const staleParameters = staleDefinition?.parameters as Record<string, any>;

    expect(legacyDefinition?.name).toBe("system_config");
    expect(staleDefinition).toMatchObject({ name: "system_config", strict: true });
    expect(staleParameters.properties.operation.enum).toEqual([
      "get_settings",
      "get_status",
      "list_groups",
      "set_auto_reply",
      "set_orchestrator",
      "set_search",
      "set_group_reply"
    ]);
    expect(staleParameters.required).toEqual(expect.arrayContaining([
      "groupCursor",
      "groupLimit"
    ]));
    expect(staleParameters.properties.task).toBeUndefined();
    expect(staleParameters).toEqual(legacyParameters);
    expect(listToolMetadata(options, []).find((tool) => tool.name === "system_config")).toMatchObject({
      promptEnabled: true,
      available: true,
      effectiveEnabled: true,
      execution: "inline"
    });
  });

  it("does not expose or execute system_config without an authorized runtime port", async () => {
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions({}, [staleTool("system_config")]);
    const [output] = await executor.execute([{
      type: "function_call",
      name: "system_config",
      call_id: "call-forged-system-config",
      arguments: JSON.stringify({})
    }], {}, definitions);

    expect(definitions).toEqual([]);
    expect(listToolMetadata().find((tool) => tool.name === "system_config")).toMatchObject({
      available: false,
      effectiveEnabled: false
    });
    expect(JSON.parse(String(output?.output))).toEqual({
      ok: false,
      error: "Tool system_config is unavailable."
    });
  });

  it("allows a system_config call with another inline tool", async () => {
    const executed: unknown[] = [];
    const delivered: string[] = [];
    const onToolCall = vi.fn();
    const options = {
      systemConfig: {
        execute: async (input: unknown) => { executed.push(input); return { ok: true }; },
        mutationStaged: () => false
      },
      onAssistantText: (text: string) => { delivered.push(text); },
      onToolCall
    } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, [staleTool("assistant_text")]);
    const state = createTurnToolState();
    const outputs = await executor.execute([{
      type: "function_call",
      name: "system_config",
      call_id: "call-system-config-mixed",
      arguments: JSON.stringify({
        operation: "get_settings",
        replyScope: null,
        enabled: null,
        orchestratorEnabled: null,
        searchImplementation: null,
        conversationId: null,
        groupCursor: null,
        groupLimit: null
      })
    }, {
      type: "function_call",
      name: "assistant_text",
      call_id: "call-assistant-text-mixed-with-config",
      arguments: JSON.stringify({ text: "不应发送" })
    }], options, definitions, state);

    expect(outputs.map((output) => JSON.parse(String(output.output)))).toEqual([
      { ok: true },
      { ok: true, delivered: true, textLength: 4 }
    ]);
    expect(executed).toHaveLength(1);
    expect(delivered).toEqual(["不应发送"]);
    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(state.acceptedToolNames).toEqual(expect.arrayContaining(["system_config", "assistant_text"]));
  });

  it("allows later tool calls after a system configuration mutation is staged", async () => {
    const delivered: string[] = [];
    const onToolCall = vi.fn();
    const options = {
      systemConfig: {
        execute: async () => ({ ok: true }),
        mutationStaged: () => true
      },
      onAssistantText: (text: string) => { delivered.push(text); },
      onToolCall
    } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, [staleTool("assistant_text")]);
    const state = createTurnToolState();
    state.acceptedToolNames.push("system_config");
    const [output] = await executor.execute([{
      type: "function_call",
      name: "assistant_text",
      call_id: "call-after-system-config",
      arguments: JSON.stringify({ text: "不应发送" })
    }], options, definitions, state);

    expect(JSON.parse(String(output?.output)))
      .toEqual({ ok: true, delivered: true, textLength: 4 });
    expect(delivered).toEqual(["不应发送"]);
    expect(onToolCall).toHaveBeenCalledWith("assistant_text");
    expect(state.acceptedToolNames).toEqual(["system_config", "assistant_text"]);
  });

  it("forces dispatch_message into deferred definitions after prompt overrides", () => {
    const executor = new RegistryProviderToolExecutor();
    const [codex] = executor.resolveDefinitions({ asyncCodex: true }, [staleTool("codex")]);
    const parameters = codex?.parameters as Record<string, any>;

    expect(parameters.properties.dispatch_message).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 200
    });
    expect(parameters.properties.inputHandles).not.toHaveProperty("uniqueItems");
    expect(parameters.required).toContain("dispatch_message");
    expect(codex?.strict).toBe(true);
  });

  it("expands the same Codex tool for authorized Native administrator control", () => {
    const executor = new RegistryProviderToolExecutor();
    const options = {
      asyncCodex: true,
      codexControl: true
    } as ProviderCompleteOptions;
    const [codex] = executor.resolveDefinitions(options, [staleTool("codex")]);
    const parameters = codex?.parameters as Record<string, any>;

    expect(parameters.properties.action.enum).toEqual(["list_sessions", "start", "resume"]);
    expect(parameters.properties.thread_id).toBeDefined();
    expect(parameters.required).toContain("dispatch_message");
    const [defaultControl] = executor.resolveDefinitions(
      options,
      defaultFinalPromptTemplate("conversation.private-reply")?.tools
    );
    expect(defaultControl?.description).toContain(
      "Depending on the active schema"
    );
    expect(defaultControl?.description).toContain(
      "Remote SSH control"
    );

    const turn = executor.deferredTurn([{
      type: "function_call",
      name: "codex",
      call_id: "call-control",
      arguments: JSON.stringify({
        action: "list_sessions",
        ssh_host: null,
        task: null,
        workspace_path: null,
        thread_id: null,
        query: null,
        limit: 10,
        dispatch_message: "正在读取 Codex 会话。"
      })
    }], options, [codex!]);

    expect(turn?.toolCall.arguments).toMatchObject({
      action: "list_sessions",
      __sunabot_admin_authorized: true,
      __sunabot_control_authorized: true
    });
    expect(turn?.toolCall.arguments).not.toHaveProperty("dispatch_message");
  });

  it("keeps media-bearing administrator turns on the Codex worker schema", () => {
    const executor = new RegistryProviderToolExecutor();
    const options = {
      asyncCodex: true,
      codexControl: true,
      chatMedia: {
        export: vi.fn(),
        freezeCodexInputs: vi.fn()
      }
    } as ProviderCompleteOptions;
    const codex = executor.resolveDefinitions(options, [staleTool("codex")])
      .find((definition) => definition.name === "codex");
    const parameters = codex?.parameters as Record<string, any>;

    expect(parameters.properties.task).toMatchObject({ type: "string" });
    expect(parameters.properties.kind.enum).toEqual(["local", "research", "analysis"]);
    expect(parameters.properties.inputHandles).toBeDefined();
    expect(parameters.properties.action).toBeUndefined();
    expect(parameters.required).toEqual(expect.arrayContaining([
      "task",
      "kind",
      "inputHandles",
      "dispatch_message"
    ]));

    const turn = executor.deferredTurn([{
      type: "function_call",
      name: "codex",
      call_id: "call-worker-with-media",
      arguments: JSON.stringify({
        task: "读取当前附件并生成结果文件。",
        kind: "local",
        inputHandles: ["message:885282522:file:0"],
        dispatch_message: "正在处理附件。"
      })
    }], options, [codex!]);

    expect(turn?.toolCall.arguments).toMatchObject({
      task: "读取当前附件并生成结果文件。",
      kind: "local",
      inputHandles: ["message:885282522:file:0"],
      __sunabot_admin_authorized: true
    });
    expect(turn?.toolCall.arguments).not.toHaveProperty("__sunabot_control_authorized");
  });

  it("treats image tools as deferred only in asynchronous image turns", () => {
    const executor = new RegistryProviderToolExecutor();
    const base = {
      bot: { tools: { generateImg: {} } },
      asyncImage: true
    } as unknown as ProviderCompleteOptions;
    const [deferredImage] = executor.resolveDefinitions(base, [staleTool("generate_img")]);
    const deferredParameters = deferredImage?.parameters as Record<string, any>;
    const [inlineImage] = executor.resolveDefinitions({ ...base, asyncImage: false }, [staleTool("generate_img")]);
    const inlineParameters = inlineImage?.parameters as Record<string, any>;

    expect(providerToolExecutionMode("generate_img", { asyncImage: true })).toBe("deferred");
    expect(providerToolExecutionMode("generate_img", { asyncImage: false })).toBe("inline");
    expect(deferredParameters.required).toContain("dispatch_message");
    expect(inlineParameters.properties.dispatch_message).toBeUndefined();
    expect(inlineParameters.required).not.toContain("dispatch_message");
  });

  it("restores the canonical history-reference contract over stale prompt schemas", () => {
    const executor = new RegistryProviderToolExecutor();
    const options = {
      bot: { tools: { generateImg: {} } },
      asyncImage: true
    } as unknown as ProviderCompleteOptions;
    const definition = executor.resolveDefinitions(options, [staleTool("generate_img")])
      .find((item) => item.name === "generate_img");
    const parameters = definition?.parameters as Record<string, any>;

    expect(definition?.description).toContain("historical media handles");
    expect(parameters.properties.referenceMediaHandles).toMatchObject({
      type: ["array", "null"],
      maxItems: 4
    });
    expect(parameters.properties.referenceImageUrls).toMatchObject({
      type: ["array", "null"],
      maxItems: 4
    });
    expect(parameters.properties.referenceImagePaths).toMatchObject({
      type: ["array", "null"],
      maxItems: 4
    });
    expect(parameters.properties.referenceImagePaths.description).toContain(
      "prefix knowledge/ exactly once"
    );
    expect(parameters.properties.referenceImageSource.enum).toEqual([
      "none",
      "current",
      "previous_output",
      "history",
      "current_and_history"
    ]);
    expect(parameters.required).toEqual(expect.arrayContaining([
      "referenceMediaHandles",
      "referenceImagePaths",
      "referenceImageSource",
      "dispatch_message"
    ]));
    expect(parameters.properties.task).toBeUndefined();
  });

  it("restores the canonical history-reference contract for selfie", () => {
    const executor = new RegistryProviderToolExecutor();
    const options = {
      selfie: { enabled: true },
      asyncImage: true
    } as unknown as ProviderCompleteOptions;
    const definition = executor.resolveDefinitions(options, [staleTool("selfie")])
      .find((item) => item.name === "selfie");
    const parameters = definition?.parameters as Record<string, any>;

    expect(definition?.description).toContain("historical media handles");
    expect(definition?.description).toContain(
      "The generated image is saved and sent by the system after this tool completes"
    );
    expect(definition?.description).toContain("do not call send_file");
    expect(parameters.properties.referenceMediaHandles).toMatchObject({
      type: ["array", "null"],
      maxItems: 1
    });
    expect(parameters.properties.referenceImageUrls).toMatchObject({
      type: ["array", "null"],
      maxItems: 1
    });
    expect(parameters.properties.referenceImagePaths).toMatchObject({
      type: ["array", "null"],
      maxItems: 1
    });
    expect(parameters.properties.referenceImagePaths.description).toContain(
      "prefix knowledge/ exactly once"
    );
    expect(parameters.properties.referenceImageSource.enum).toEqual([
      "none",
      "current",
      "previous_output",
      "history",
      "current_and_history"
    ]);
    expect(parameters.required).toEqual(expect.arrayContaining([
      "referenceMediaHandles",
      "referenceImagePaths",
      "referenceImageSource",
      "dispatch_message"
    ]));
  });

  it("rejects more than one selfie chat reference in either strict schema field", async () => {
    const executor = new RegistryProviderToolExecutor();
    const options = {
      selfie: { enabled: true },
      asyncImage: true
    } as unknown as ProviderCompleteOptions;
    const definition = executor.resolveDefinitions(options, [staleTool("selfie")])
      .find((item) => item.name === "selfie");
    const app = Fastify();
    app.post("/validate-selfie", {
      schema: { body: definition?.parameters as Record<string, unknown> }
    }, async () => ({ ok: true }));
    const payload = {
      prompt: "自拍",
      size: null,
      resolution: "1K",
      quality: "high",
      referenceImageUrls: null,
      referenceImagePaths: null,
      referenceMediaHandles: null,
      referenceImageSource: "none",
      dispatch_message: "图片生成完成后发送"
    };

    try {
      const valid = await app.inject({
        method: "POST",
        url: "/validate-selfie",
        payload: { ...payload, referenceImageUrls: ["https://example.test/one.png"] }
      });
      expect(valid.statusCode).toBe(200);

      for (const field of ["referenceImageUrls", "referenceImagePaths", "referenceMediaHandles"] as const) {
        const invalid = await app.inject({
          method: "POST",
          url: "/validate-selfie",
          payload: { ...payload, [field]: ["first", "second"] }
        });
        expect(invalid.statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it("removes image tools when the delivery target cannot receive image tasks", () => {
    const options = {
      imageTools: false,
      asyncImage: true,
      bot: { tools: { generateImg: {} } },
      selfie: { enabled: true }
    } as unknown as ProviderCompleteOptions;

    expect(resolveProviderToolDefinitions(options, [
      staleTool("generate_img"),
      staleTool("selfie")
    ])).toEqual([]);
    expect(listToolMetadata(options).filter((tool) => ["generate_img", "selfie"].includes(tool.name)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "generate_img", available: false, effectiveEnabled: false }),
        expect.objectContaining({ name: "selfie", available: false, effectiveEnabled: false })
      ]));
  });

  it("applies global description overrides after prompt definitions", () => {
    const options = {
      bot: {
        tools: {
          websearch: {},
          generateImg: {},
          overrides: { websearch: { description: "Search using the configured live index." } }
        }
      }
    } as unknown as ProviderCompleteOptions;
    const [definition] = resolveProviderToolDefinitions(options, [staleTool("websearch")]);
    const [metadata] = listToolMetadata(options, [staleTool("websearch")])
      .filter((tool) => tool.name === "websearch");

    expect(definition?.description).toBe("Search using the configured live index.");
    expect(metadata).toMatchObject({
      description: "Search using the configured live index.",
      promptDescription: "Stale workspace definition.",
      descriptionSource: "override",
      enabled: true,
      available: true,
      effectiveEnabled: true
    });
    expect(metadata?.parameters).toMatchObject({
      properties: { task: { type: "string" } }
    });
  });

  it("lets an explicit enable restore a canonical tool omitted by the prompt", () => {
    const options = {
      bot: {
        tools: {
          websearch: {},
          generateImg: {},
          overrides: { websearch: { enabled: true } }
        }
      }
    } as unknown as ProviderCompleteOptions;

    expect(resolveProviderToolDefinitions(options, []).map((tool) => tool.name)).toEqual(["websearch"]);
    expect(listToolMetadata(options, []).find((tool) => tool.name === "websearch")).toMatchObject({
      configuredEnabled: true,
      promptEnabled: false,
      enabled: true,
      available: true,
      effectiveEnabled: true,
      descriptionSource: "default"
    });
  });

  it("ignores generic enabled overrides for direct-runtime tools", () => {
    const options = {
      asyncCodex: true,
      bot: {
        tools: {
          websearch: {},
          generateImg: {},
          overrides: { codex: { enabled: false, description: "Direct Codex description." } }
        }
      }
    } as unknown as ProviderCompleteOptions;

    expect(resolveProviderToolDefinitions(options, [staleTool("codex")])).toEqual([
      expect.objectContaining({ name: "codex", description: "Direct Codex description." })
    ]);
    expect(providerToolExecutionMode("codex", options)).toBe("deferred");
    expect(listToolMetadata(options, [staleTool("codex")]).find((tool) => tool.name === "codex"))
      .toMatchObject({ configuredEnabled: null, enabled: true });
  });

  it("does not dispatch or execute a deferred tool whose runtime capability is unavailable", async () => {
    const options = {
      asyncCodex: false,
      bot: { tools: { websearch: {}, generateImg: {} } }
    } as unknown as ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const call = {
      type: "function_call" as const,
      name: "codex",
      call_id: "call-unavailable",
      arguments: JSON.stringify({ task: "inspect", kind: "analysis", dispatch_message: "开始处理。" })
    };

    expect(providerToolExecutionMode("codex", options)).toBe("deferred");
    const definitions = executor.resolveDefinitions(options, [staleTool("codex")]);
    expect(definitions).toEqual([]);
    expect(executor.deferredTurn([call], options, definitions)).toBeNull();
    const [output] = await executor.execute([call], options, definitions);
    expect(JSON.parse(String(output?.output))).toEqual({ ok: false, error: "Tool codex is unavailable." });
  });

  it("does not expose or execute the unsupported custom image provider", async () => {
    const options = {
      asyncImage: true,
      bot: {
        tools: {
          websearch: {},
          generateImg: { provider: "custom" }
        }
      }
    } as unknown as ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, [staleTool("generate_img")]);
    const metadata = listToolMetadata(options, [staleTool("generate_img")])
      .find((tool) => tool.name === "generate_img");
    const call = {
      type: "function_call" as const,
      name: "generate_img",
      call_id: "call-custom-image",
      arguments: JSON.stringify({ prompt: "test", dispatch_message: "开始处理。" })
    };

    expect(definitions).toEqual([]);
    expect(metadata).toMatchObject({
      enabled: true,
      available: false,
      effectiveEnabled: false,
      availabilityReason: "当前图像生成 Provider 不可用。"
    });
    expect(executor.deferredTurn([call], options, definitions)).toBeNull();
    const [output] = await executor.execute([call], options, definitions);
    expect(JSON.parse(String(output?.output))).toEqual({
      ok: false,
      error: "Tool generate_img is unavailable."
    });
  });

  it("returns the effective deferred parameter schema in metadata", () => {
    const options = {
      asyncCodex: true,
      asyncImage: true,
      bot: { tools: { websearch: {}, generateImg: {} } }
    } as unknown as ProviderCompleteOptions;
    const metadata = listToolMetadata(options);
    const codex = metadata.find((tool) => tool.name === "codex");
    const image = metadata.find((tool) => tool.name === "generate_img");

    expect(codex).toMatchObject({ execution: "deferred", available: true, effectiveEnabled: true });
    expect((codex?.parameters.properties as Record<string, unknown>).dispatch_message).toBeDefined();
    expect(image?.execution).toBe("deferred");
    expect((image?.parameters.properties as Record<string, unknown>).dispatch_message).toBeDefined();
  });

  it("rejects an inline call omitted by the current prompt", async () => {
    const delivered: string[] = [];
    const used: string[] = [];
    const options = {
      onAssistantText: (text: string) => { delivered.push(text); },
      onToolCall: (name: string) => { used.push(name); }
    } as ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, []);
    const [output] = await executor.execute([{
      type: "function_call",
      name: "assistant_text",
      call_id: "call-undeclared-inline",
      arguments: JSON.stringify({ text: "undeclared" })
    }], options, definitions);

    expect(definitions).toEqual([]);
    expect(JSON.parse(String(output?.output))).toEqual({
      ok: false,
      error: "Tool assistant_text is not enabled for this prompt."
    });
    expect(delivered).toEqual([]);
    expect(used).toEqual([]);
  });

  it("reports accepted inline and deferred tool calls with assistant message sources", async () => {
    const used: string[] = [];
    const delivered: Array<{ text: string; source: string | undefined }> = [];
    const executor = new RegistryProviderToolExecutor();
    const inlineOptions = {
      onAssistantText: (text: string, source?: "text" | "assistant_text") => {
        delivered.push({ text, source });
      },
      onToolCall: (name: string) => used.push(name)
    } satisfies ProviderCompleteOptions;
    const inlineDefinitions = executor.resolveDefinitions(inlineOptions, [staleTool("assistant_text")]);

    await executor.execute([{
      type: "function_call",
      name: "assistant_text",
      call_id: "call-assistant-text",
      arguments: JSON.stringify({ text: "正在处理。" })
    }], inlineOptions, inlineDefinitions);

    const deferredOptions = {
      asyncCodex: true,
      onToolCall: (name: string) => used.push(name)
    } satisfies ProviderCompleteOptions;
    const deferredDefinitions = executor.resolveDefinitions(deferredOptions, [staleTool("codex")]);
    const deferred = executor.deferredTurn([{
      type: "function_call",
      name: "codex",
      call_id: "call-codex",
      arguments: JSON.stringify({
        task: "inspect",
        kind: "analysis",
        dispatch_message: "开始处理。"
      })
    }], deferredOptions, deferredDefinitions);

    expect(delivered).toEqual([{ text: "正在处理。", source: "assistant_text" }]);
    expect(used).toEqual(["assistant_text", "codex"]);
    expect(deferred).toMatchObject({
      kind: "deferred",
      toolCall: { name: "codex", callId: "call-codex" }
    });
  });

  it("rejects a deferred call omitted by the current prompt", async () => {
    const used: string[] = [];
    const options = {
      asyncCodex: true,
      onToolCall: (name: string) => { used.push(name); }
    } as ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, []);
    const call = {
      type: "function_call" as const,
      name: "codex",
      call_id: "call-undeclared-deferred",
      arguments: JSON.stringify({ task: "inspect", kind: "analysis", dispatch_message: "开始处理。" })
    };

    expect(definitions).toEqual([]);
    expect(executor.deferredTurn([call], options, definitions)).toBeNull();
    const [output] = await executor.execute([call], options, definitions);
    expect(JSON.parse(String(output?.output))).toEqual({
      ok: false,
      error: "Tool codex is not enabled for this prompt."
    });
    expect(used).toEqual([]);
  });

  it("quarantines one invalid dynamic tool without removing valid tools", () => {
    const invalidName = `mcp_${"a".repeat(48)}`;
    const validName = `mcp_${"b".repeat(48)}`;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions({
      mcp: {
        definitions: () => [
          {
            type: "function",
            name: invalidName,
            description: "Invalid external tool",
            parameters: {
              type: "object",
              properties: {},
              oneOf: [{ required: [] }]
            }
          },
          {
            type: "function",
            name: validName,
            description: "Valid external tool",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: true
            }
          }
        ],
        describe: () => ({ serverId: "fixture", transport: "streamable_http" }),
        call: vi.fn()
      }
    }, []);

    expect(definitions.map((definition) => definition.name)).toEqual([validName]);
    expect(errorLog).toHaveBeenCalledWith(
      "[provider] invalid tool definition quarantined",
      expect.objectContaining({ tool: invalidName })
    );
    errorLog.mockRestore();
  });
});

function staleTool(name: string): OpenAIToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: "Stale workspace definition.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { task: { type: "string" } },
        required: ["task"]
      },
      strict: false
    }
  };
}
