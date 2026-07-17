// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OpenAIProvider,
  ProviderCompleteOptions,
  ProviderTurnResult
} from "../../adapters/model/openaiProvider.js";
import { parseOneBotInboundMessage } from "../../adapters/onebot/inboundMessageAdapter.js";
import { closeApplicationDataStores } from "../../adapters/sqlite/applicationDataStore.js";
import type { MessagingPort } from "../../packages/contracts/messaging/messages.js";
import type { RenderedPromptRequest } from "../../services/agent/promptSystem.js";
import { SunaRuntime } from "../../src/runtime.js";
import { conversationRecordId } from "../../src/runtime/messagingAttachmentHelpers.js";
import type { ParsedIncomingMessage } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/requestLog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/requestLog.js")>()),
  appendRequestLog,
  appendRequestLogStrict: appendRequestLog
}));
vi.mock("../../services/memory/memoryService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/memory/memoryService.js")>()),
  recallMemory: vi.fn(async () => ({ ok: true, matches: [] })),
  readUserProfileForUser: vi.fn(async () => undefined)
}));

const dataRoot = "/Users/tanshow/Developer/sunabot-dev-workspaces/skill-mcp-w2/runtime-wiring";
const runtimes: SunaRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  closeApplicationDataStores();
  await fs.rm(dataRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("SunaRuntime Agent extension wiring", () => {
  it("injects prepared Skill/MCP context and ports into an ordinary provider turn", async () => {
    const skillPort = { skillIds: ["approved"], activate: vi.fn() };
    const mcpPort = { definitions: vi.fn(() => []), call: vi.fn() };
    const prepare = vi.fn(async () => ({
      systemTexts: ["approved Skill catalog"],
      requiredMcpFailures: [],
      skills: skillPort,
      mcp: mcpPort
    }));
    let receivedRequest!: RenderedPromptRequest;
    let receivedOptions!: ProviderCompleteOptions;
    const harness = await createHarness(prepare, async (request, options = {}) => {
      receivedRequest = request;
      receivedOptions = options;
      return { kind: "completed", text: "已完成" };
    });
    await harness.runtime.replyToIncoming(
      conversationRecordId(harness.incoming),
      harness.incoming,
      harness.gateway
    );
    expect(prepare).toHaveBeenCalledWith({
      agentId: "plana",
      conversationId: "private:171419991",
      accountId: "primary",
      transport: "onebot",
      userId: 171419991,
      confirmationTexts: ["hello"],
      selectedSkillIds: [],
      canApproveMcpTools: true,
      signal: undefined
    });
    expect(receivedRequest.messages.map((message) => message.content)).toEqual([
      "base system",
      "approved Skill catalog",
      "hello"
    ]);
    expect(receivedOptions.skills).toBe(skillPort);
    expect(receivedOptions.mcp).toBe(mcpPort);
  });

  it("keeps no-debounce extension selection on the current raw incoming text", async () => {
    const prepare = vi.fn(async () => ({ systemTexts: [], requiredMcpFailures: [] }));
    const harness = await createHarness(prepare, async () => ({ kind: "completed", text: "已完成" }));
    harness.incoming.text = "please use $direct-skill";
    await harness.runtime.replyToIncoming(
      conversationRecordId(harness.incoming),
      harness.incoming,
      harness.gateway
    );
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      confirmationTexts: ["please use $direct-skill"],
      selectedSkillIds: ["direct-skill"]
    }));
  });

  it("uses only ordered same-sender raw texts inside the frozen debounce batch", async () => {
    const prepare = vi.fn(async () => ({ systemTexts: [], requiredMcpFailures: [] }));
    const harness = await createHarness(prepare, async () => ({ kind: "completed", text: "已完成" }));
    const record = harness.runtime.conversationRecords.get(conversationRecordId(harness.incoming));
    if (!record?.messages[0]) throw new Error("missing test conversation");
    const base = record.messages[0];
    const triggerText = "please use $window-skill $dupe $Bad $bad--id";
    const followUpText = "also use $later-skill $dupe";
    const confirmationText = `/确认 MCP mcpa_${"a".repeat(24)}`;
    harness.incoming.text = "$incoming-only";
    record.messages = [
      { ...base, id: "old", sequence: 1, text: "$old-skill /确认 MCP mcpa_old", userId: harness.incoming.userId },
      {
        ...base,
        id: String(harness.incoming.messageId),
        sequence: 2,
        text: triggerText,
        userId: harness.incoming.userId,
        quoteReferences: [{ messageId: 80_001, text: "$quoted-skill /确认 MCP mcpa_quoted" }]
      },
      { ...base, id: "other-sender", sequence: 3, text: "$cross-sender", userId: 999_999 },
      { ...base, id: "follow-up", sequence: 4, text: followUpText, userId: harness.incoming.userId },
      { ...base, id: "confirmation", sequence: 5, text: confirmationText, userId: harness.incoming.userId },
      { ...base, id: "follow-up", sequence: 6, text: "$duplicate-message", userId: harness.incoming.userId },
      { ...base, id: "outside", sequence: 7, text: "$outside-skill", userId: harness.incoming.userId }
    ];
    record.messageCount = 7;

    await harness.runtime.replyToIncoming(
      conversationRecordId(harness.incoming),
      harness.incoming,
      harness.gateway,
      { captureSequence: 2, contextThroughSequence: 6 }
    );
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      confirmationTexts: [triggerText, followUpText, confirmationText],
      selectedSkillIds: ["window-skill", "dupe", "later-skill"]
    }));
    const preparedInput = prepare.mock.calls[0]?.[0];
    expect(JSON.stringify(preparedInput)).not.toMatch(
      /incoming-only|old-skill|cross-sender|quoted-skill|duplicate-message|outside-skill/u
    );
  });

  it("withholds all extension context and ports for even an empty prompt override", async () => {
    const prepare = vi.fn();
    let receivedRequest!: RenderedPromptRequest;
    let receivedOptions!: ProviderCompleteOptions;
    const harness = await createHarness(prepare, async (request, options = {}) => {
      receivedRequest = request;
      receivedOptions = options;
      return { kind: "completed", text: "已完成" };
    });
    await harness.runtime.replyToIncoming(
      conversationRecordId(harness.incoming),
      harness.incoming,
      harness.gateway,
      { promptOverride: "" }
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(receivedRequest.messages.map((message) => message.content)).toEqual(["base system", "hello"]);
    expect(receivedOptions.skills).toBeUndefined();
    expect(receivedOptions.mcp).toBeUndefined();
  });

  it("fails the current turn closed when a required MCP server is unavailable", async () => {
    const prepare = vi.fn(async () => ({
      systemTexts: [],
      requiredMcpFailures: ["required-server"]
    }));
    const complete = vi.fn(async (): Promise<ProviderTurnResult> => ({ kind: "completed", text: "unsafe" }));
    const harness = await createHarness(prepare, complete);
    await harness.runtime.replyToIncoming(
      conversationRecordId(harness.incoming),
      harness.incoming,
      harness.gateway
    );
    expect(complete).not.toHaveBeenCalled();
    expect(harness.gateway.send).toHaveBeenCalledWith(expect.objectContaining({
      text: "异常：所需 MCP 服务暂不可用。"
    }));
  });
});

async function createHarness(
  prepare: ReturnType<typeof vi.fn>,
  completeRequestTurn: (
    request: RenderedPromptRequest,
    options?: ProviderCompleteOptions
  ) => Promise<ProviderTurnResult>
) {
  await fs.mkdir(dataRoot, { recursive: true });
  const config = createAdminTestConfig(path.join(dataRoot, "workspace"));
  const runtime = new SunaRuntime(config, {
    attachmentService: {} as never,
    agentExtensions: {
      prepare,
      closeAgent: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    },
    replyDebounceMs: 0,
    resolveToolCapabilities: async () => ({ codex: false, workspaceBash: false })
  });
  runtimes.push(runtime);
  const provider = {
    completeRequestTurn: vi.fn(completeRequestTurn),
    generateImage: vi.fn()
  } as unknown as OpenAIProvider;
  const internals = runtime as unknown as {
    persona: NonNullable<SunaRuntime["persona"]>;
    getProvider(): OpenAIProvider;
    renderPromptRequest(): Promise<RenderedPromptRequest>;
    scheduleMemoryCompression(): void;
    scheduleAttachmentCacheRefresh(): void;
    persistConversationRecords(): void;
  };
  internals.persona = {
    id: "plana",
    name: "普拉娜",
    files: [],
    memoryItems: [],
    systemPrompt: "base system"
  };
  internals.getProvider = () => provider;
  internals.renderPromptRequest = async () => ({
    messages: [
      { role: "system", content: "base system" },
      { role: "user", content: "hello" }
    ],
    response_format: { type: "text" }
  });
  internals.scheduleMemoryCompression = () => undefined;
  internals.scheduleAttachmentCacheRefresh = () => undefined;
  internals.persistConversationRecords = () => undefined;
  const incoming = privateIncoming();
  runtime.recordIncomingMessage(incoming);
  return { runtime, incoming, gateway: fakeGateway() };
}

function privateIncoming(): ParsedIncomingMessage {
  const incoming = parseOneBotInboundMessage({
    post_type: "message",
    message_type: "private",
    message_id: 70_001,
    user_id: 171419991,
    self_id: 4004,
    time: 1_788_000_001,
    sender: { nickname: "admin" },
    message: "hello"
  });
  if (!incoming) throw new Error("test event did not produce an inbound message");
  return incoming;
}

function fakeGateway() {
  return {
    getStatus: vi.fn(() => ({ connected: true, connections: 1, selfIds: ["4004"] })),
    send: vi.fn(async () => ({ accepted: true as const })),
    resolveSender: vi.fn(async ({ userId }: { userId: number }) => ({ id: String(userId) })),
    getMessage: vi.fn(async () => ({
      text: "",
      media: [],
      attachments: [],
      replyMessageIds: [],
      sender: { id: "171419991" }
    })),
    poke: vi.fn(async () => ({ accepted: true as const }))
  } as unknown as MessagingPort;
}
