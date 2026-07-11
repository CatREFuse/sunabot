export const architectureDebtAllowances = [
  ...["session-event", "tool-job", "outbox"].map((target) => ({
    id: `durable-codec:${target}`,
    rule: "durable-codec",
    source: "services/sessions/sessionStore.ts",
    target,
    reason: "The durable queue schema is versioned at selected callers, but the persistence boundary does not yet require encode/decode codecs for every payload family.",
    tracking: "CONTRACT-001, CONTRACT-003",
    decision: "docs/architecture/project-structure-plan.md#fixed-collaboration-protocol"
  })),

  ...[
    ["src/runtime.ts", 4_800, "MODULE-001 through MODULE-005"],
    ["adapters/model/openaiProvider.ts", 1_650, "MODULE-006"],
    ["services/media/attachments/cache.ts", 1_500, "MODULE-007"],
    ["services/sessions/sessionStore.ts", 1_400, "CONTRACT-003, DATA-003"],
    ["services/media/attachments/service.ts", 1_300, "MODULE-007"],
    ["adapters/codex/codexTool.ts", 1_200, "MODULE-006"],
    ["src/admin/configService.ts", 900, "MODULE-008, MODULE-009"]
  ].map(([source, ceiling, tracking]) => ({
    id: `file-lines:${source}`,
    rule: "file-lines",
    source,
    ceiling,
    reason: "Legacy file exceeds the 800-line target; the ceiling prevents further growth while it is split.",
    tracking,
    decision: "docs/architecture/project-structure-plan.md#completion-criteria"
  })),

  ...[
    ["src/runtime.ts", "SunaRuntime", 3_200, "MODULE-001 through MODULE-005"],
    ["adapters/model/openaiProvider.ts", "OpenAIProvider", 700, "MODULE-006"],
    ["services/media/attachments/cache.ts", "CacheStore", 850, "MODULE-007"],
    ["services/sessions/sessionStore.ts", "SessionStore", 1_000, "CONTRACT-003, DATA-003"],
    ["services/sessions/sessionCoordinator.ts", "SessionCoordinator", 650, "DATA-003"],
    ["services/media/attachments/service.ts", "AttachmentService", 800, "MODULE-007"]
  ].map(([source, symbol, ceiling, tracking]) => ({
    id: `class-lines:${source}:${symbol}`,
    rule: "class-lines",
    source,
    symbol,
    ceiling,
    reason: "Legacy class exceeds the 500-line target; the ceiling prevents further growth while responsibilities are extracted.",
    tracking,
    decision: "docs/architecture/project-structure-plan.md#completion-criteria"
  }))
];
