import type { AppConfig } from "../types.js";
import {
  SCHEDULED_TASK_CALLBACK_PROMPT_FILE,
  SCHEDULED_TASK_CALLBACK_PROMPT_ID
} from "../../services/agent/scheduledTaskPrompt.js";
import {
  ensurePromptTextFile,
  migrateConversationEmojiVariables,
  migrateConversationVoicePrompt,
  migrateGroupReplyOrchestratorResultVariable,
  migrateMemoryPerspectivePrompt,
  migratePromptTimeContext,
  migrateScheduledTaskAgentLoopPrompt,
  migrateSelfieReferenceSelectionPrompt,
  migrateSelfieResponseSchemaPrompt,
  migrateToneEmojiMarkerRule,
  migrateUserGroupOrchestratorResultSchema,
  readPromptTextFile
} from "../../services/agent/promptWorkspace.js";
import { migrateGroupReplyTopicReasoning } from "../../services/agent/groupReplyTopicReasoningMigration.js";
import {
  migrateToneBubbleCountGuidancePrompt,
  migrateToneSegmentedReplyPrompt
} from "../../services/agent/tonePromptMigration.js";
import { migrateConversationWebFetchPrompt } from "../../services/agent/webFetchPromptMigration.js";
import { migrateConversationBashToolsPrompt } from "../../services/agent/bashToolPromptMigration.js";
import {
  migrateConversationBashWorkbenchPrompt,
  migrateConversationConfigurationIndexPrompt
} from "../../services/agent/bashWorkbenchPromptMigration.js";
import { migrateConversationChatMediaPrompt } from "../../services/agent/chatMediaPromptMigration.js";
import { migrateConversationCodexOutputPrompt } from "../../services/agent/codexOutputPromptMigration.js";
import { migrateConversationPromptCacheLayout } from "../../services/agent/promptCacheLayoutMigration.js";
import {
  CONVERSATION_MESSAGE_32_MIGRATION_VERSION,
  migrateConversationMessage32Prompt
} from "../../services/agent/conversationHistoryPromptMigration.js";
import {
  migrateConversationDirectorPrompt,
  migrateDirectorScheduleSchemaPrompt
} from "../../services/agent/directorPromptMigration.js";
import {
  migrateDreamCanonicalOutputContractPrompt,
  migrateDreamMemoryContractPrompt,
  migrateDreamMinimalContractPrompt,
  migrateDreamRawIdentityPrompt,
  migrateDreamSchemaPrompt
} from "../../services/agent/dreamPromptMigration.js";
import { migrateConversationInboundMessagePrompt } from "../../services/agent/inboundMessagePromptMigration.js";
import { migrateRecoverableOutputErrorPrompt } from "../../services/agent/recoverableOutputErrorPromptMigration.js";
import {
  migrateConversationReferenceToolDescriptions,
  migrateOrchestratorReferenceResolutionPrompt
} from "../../services/agent/referencePromptMigration.js";
import { ensureAirPromptWorkspace } from "../../services/agent/airPromptWorkspace.js";
import { parseFinalPromptTemplate } from "../../services/agent/promptSystem.js";
import {
  runPromptMigrationRegistry,
  type PromptMigrationDefinition
} from "../../services/agent/promptMigrationRegistry.js";
import {
  DIRECTOR_DAILY_PLAN_PROMPT_FILE,
  DIRECTOR_DAILY_PLAN_PROMPT_ID,
  DIRECTOR_SCHEDULE_REVISION_PROMPT_FILE,
  DIRECTOR_SCHEDULE_REVISION_PROMPT_ID
} from "../../services/director/public.js";
import { DREAM_PROMPT_FILE, DREAM_PROMPT_ID } from "../../services/memory/public.js";
import {
  ADMIN_RUNTIME_PROMPT_DEFAULTS,
  CONVERSATION_REPLY_PROMPT_FILE,
  GROUP_CHAT_SUMMARY_PROMPT_FILE,
  GROUP_CONVERSATION_REPLY_PROMPT_FILE,
  PRIVATE_CONVERSATION_REPLY_PROMPT_FILE,
  SELFIE_PROMPT_FILE,
  TONE_PROMPT_FILE,
  runtimePromptDefaultContent
} from "./runtimeContracts.js";

export async function ensureRuntimePromptWorkspace(config: AppConfig) {
  const selfiePromptDefault = runtimePromptDefaultContent(config, "image.selfie-rewrite");
  const legacyConversationPrompt = await readPromptTextFile(
    config,
    "system",
    CONVERSATION_REPLY_PROMPT_FILE,
    ""
  );
  await Promise.all([
    ensurePromptTextFile(
      config,
      "system",
      PRIVATE_CONVERSATION_REPLY_PROMPT_FILE,
      legacyConversationPrompt || ADMIN_RUNTIME_PROMPT_DEFAULTS["conversation.private-reply"] || ""
    ),
    ensurePromptTextFile(
      config,
      "system",
      GROUP_CONVERSATION_REPLY_PROMPT_FILE,
      legacyConversationPrompt || ADMIN_RUNTIME_PROMPT_DEFAULTS["conversation.group-reply"] || ""
    ),
    ensurePromptTextFile(config, "system", TONE_PROMPT_FILE, ADMIN_RUNTIME_PROMPT_DEFAULTS["conversation.tone-rewrite"] ?? ""),
    ensurePromptTextFile(config, "system", config.bot.memory.workMemoryCompressOutPrompt, ADMIN_RUNTIME_PROMPT_DEFAULTS["memory.compress-out"] ?? ""),
    ensurePromptTextFile(config, "system", config.bot.orchestrator.promptFile, ADMIN_RUNTIME_PROMPT_DEFAULTS["orchestrator.user-group"] ?? ""),
    ensurePromptTextFile(config, "system", GROUP_CHAT_SUMMARY_PROMPT_FILE, ADMIN_RUNTIME_PROMPT_DEFAULTS["conversation.group-summary"] ?? ""),
    ensurePromptTextFile(config, "system", SCHEDULED_TASK_CALLBACK_PROMPT_FILE, ADMIN_RUNTIME_PROMPT_DEFAULTS[SCHEDULED_TASK_CALLBACK_PROMPT_ID] ?? ""),
    ...([
      [DIRECTOR_DAILY_PLAN_PROMPT_FILE, DIRECTOR_DAILY_PLAN_PROMPT_ID],
      [DIRECTOR_SCHEDULE_REVISION_PROMPT_FILE, DIRECTOR_SCHEDULE_REVISION_PROMPT_ID],
      [DREAM_PROMPT_FILE, DREAM_PROMPT_ID]
    ] as const).map(([file, id]) => ensurePromptTextFile(
      config,
      "system",
      file,
      ADMIN_RUNTIME_PROMPT_DEFAULTS[id] ?? ""
    )),
    ensurePromptTextFile(config, "persona", SELFIE_PROMPT_FILE, selfiePromptDefault)
  ]);

  await ensureAirPromptWorkspace(config);
  return runPromptMigrationRegistry(config, runtimePromptMigrations(config, selfiePromptDefault));
}

export function planRuntimePromptMigrations(config: AppConfig) {
  return runPromptMigrationRegistry(
    config,
    runtimePromptMigrations(config, runtimePromptDefaultContent(config, "image.selfie-rewrite")),
    { dryRun: true }
  );
}

function runtimePromptMigrations(config: AppConfig, selfiePromptDefault: string) {
  const definitions: PromptMigrationDefinition[] = [];
  const id = (kind: string, scope: "system" | "persona", file: string) => (
    `${kind}:${scope}:${file.replace(/[^A-Za-z0-9._/-]/g, "_")}`
  );
  const add = (
    kind: string,
    scope: "system" | "persona",
    file: string,
    run: () => Promise<unknown>,
    dependencies: readonly string[] = []
  ) => {
    const migrationId = id(kind, scope, file);
    definitions.push({
      id: migrationId,
      scope,
      files: [file],
      dependencies,
      backupPolicy: "once",
      run,
      verify: async () => {
        const content = await readPromptTextFile(config, scope, file, "");
        if (!content) throw new Error(`Prompt migration produced an empty template: ${migrationId}`);
        parseFinalPromptTemplate(content);
      }
    });
    return migrationId;
  };

  const timeFiles = [
    PRIVATE_CONVERSATION_REPLY_PROMPT_FILE,
    GROUP_CONVERSATION_REPLY_PROMPT_FILE,
    TONE_PROMPT_FILE,
    config.bot.memory.workMemoryCompressOutPrompt,
    config.bot.orchestrator.promptFile,
    GROUP_CHAT_SUMMARY_PROMPT_FILE,
    SCHEDULED_TASK_CALLBACK_PROMPT_FILE,
    DIRECTOR_DAILY_PLAN_PROMPT_FILE,
    DIRECTOR_SCHEDULE_REVISION_PROMPT_FILE
  ] as const;
  const timeIds = new Map(timeFiles.map((file) => [
    file,
    add("time-context-v1", "system", file, () => migratePromptTimeContext(config, "system", file))
  ]));
  const selfieTimeId = add(
    "time-context-v1",
    "persona",
    SELFIE_PROMPT_FILE,
    () => migratePromptTimeContext(config, "persona", SELFIE_PROMPT_FILE)
  );
  const dependency = (file: string) => [requiredMigrationId(timeIds, file)];

  for (const file of [DIRECTOR_DAILY_PLAN_PROMPT_FILE, DIRECTOR_SCHEDULE_REVISION_PROMPT_FILE]) {
    add("director-schema-v1", "system", file, () => migrateDirectorScheduleSchemaPrompt(config, file), dependency(file));
  }
  const dreamFlexId = add(
    "dream-flex-contract-v3",
    "system",
    DREAM_PROMPT_FILE,
    () => migrateDreamSchemaPrompt(config, DREAM_PROMPT_FILE)
  );
  const dreamMemoryId = add(
    "dream-memory-contract-v5",
    "system",
    DREAM_PROMPT_FILE,
    () => migrateDreamMemoryContractPrompt(config, DREAM_PROMPT_FILE),
    [dreamFlexId]
  );
  const dreamRawIdentityId = add(
    "dream-raw-identity-v1",
    "system",
    DREAM_PROMPT_FILE,
    () => migrateDreamRawIdentityPrompt(config, DREAM_PROMPT_FILE),
    [dreamMemoryId]
  );
  const dreamOutputV6Id = add(
    "dream-output-contract-v6",
    "system",
    DREAM_PROMPT_FILE,
    () => migrateDreamCanonicalOutputContractPrompt(config, DREAM_PROMPT_FILE),
    [dreamRawIdentityId]
  );
  const dreamMinimalV8Id = add(
    "dream-minimal-contract-v8",
    "system",
    DREAM_PROMPT_FILE,
    () => migrateDreamMinimalContractPrompt(config, DREAM_PROMPT_FILE),
    [dreamOutputV6Id]
  );
  const dreamNoVisibleReasonId = add(
    "dream-no-visible-reason-v2",
    "system",
    DREAM_PROMPT_FILE,
    () => migrateDreamMinimalContractPrompt(config, DREAM_PROMPT_FILE),
    [dreamMinimalV8Id]
  );
  const dreamSourcePartitionId = add(
    "dream-source-partition-self-check-v1",
    "system",
    DREAM_PROMPT_FILE,
    () => migrateDreamMinimalContractPrompt(config, DREAM_PROMPT_FILE),
    [dreamMinimalV8Id]
  );
  const dreamMinimalV9Id = add(
    "dream-minimal-contract-v9",
    "system",
    DREAM_PROMPT_FILE,
    () => migrateDreamMinimalContractPrompt(config, DREAM_PROMPT_FILE),
    [dreamNoVisibleReasonId, dreamSourcePartitionId]
  );
  add(
    "dream-minimal-contract-v9-repair-v1",
    "system",
    DREAM_PROMPT_FILE,
    () => migrateDreamMinimalContractPrompt(config, DREAM_PROMPT_FILE),
    [dreamMinimalV9Id]
  );
  add(
    "scheduled-agent-loop-v2",
    "system",
    SCHEDULED_TASK_CALLBACK_PROMPT_FILE,
    () => migrateScheduledTaskAgentLoopPrompt(
      config,
      SCHEDULED_TASK_CALLBACK_PROMPT_FILE,
      ADMIN_RUNTIME_PROMPT_DEFAULTS[SCHEDULED_TASK_CALLBACK_PROMPT_ID] ?? ""
    ),
    dependency(SCHEDULED_TASK_CALLBACK_PROMPT_FILE)
  );
  const groupTopicReasoningId = add(
    "group-topic-reasoning-v1",
    "system",
    GROUP_CONVERSATION_REPLY_PROMPT_FILE,
    () => migrateGroupReplyTopicReasoning(config, GROUP_CONVERSATION_REPLY_PROMPT_FILE),
    dependency(GROUP_CONVERSATION_REPLY_PROMPT_FILE)
  );
  const groupOrchestratorId = add(
    "group-orchestrator-result-v1",
    "system",
    GROUP_CONVERSATION_REPLY_PROMPT_FILE,
    () => migrateGroupReplyOrchestratorResultVariable(config, GROUP_CONVERSATION_REPLY_PROMPT_FILE),
    [groupTopicReasoningId]
  );
  add(
    "user-group-result-schema-v1",
    "system",
    config.bot.orchestrator.promptFile,
    () => migrateUserGroupOrchestratorResultSchema(
      config,
      config.bot.orchestrator.promptFile,
      ADMIN_RUNTIME_PROMPT_DEFAULTS["orchestrator.user-group"] ?? ""
    ),
    dependency(config.bot.orchestrator.promptFile)
  );
  add(
    "group-reference-resolution-v1",
    "system",
    config.bot.orchestrator.promptFile,
    () => migrateOrchestratorReferenceResolutionPrompt(config, config.bot.orchestrator.promptFile),
    dependency(config.bot.orchestrator.promptFile)
  );
  const selfieReferenceId = add(
    "selfie-reference-v1",
    "persona",
    SELFIE_PROMPT_FILE,
    () => migrateSelfieReferenceSelectionPrompt(config, SELFIE_PROMPT_FILE, selfiePromptDefault),
    [selfieTimeId]
  );
  add(
    "selfie-response-schema-v2",
    "persona",
    SELFIE_PROMPT_FILE,
    () => migrateSelfieResponseSchemaPrompt(config, SELFIE_PROMPT_FILE),
    [selfieReferenceId]
  );

  for (const [file, promptId] of [
    [PRIVATE_CONVERSATION_REPLY_PROMPT_FILE, "conversation.private-reply"],
    [GROUP_CONVERSATION_REPLY_PROMPT_FILE, "conversation.group-reply"]
  ] as const) {
    const emojiId = add(
      "conversation-emoji-v2",
      "system",
      file,
      () => migrateConversationEmojiVariables(config, file),
      file === GROUP_CONVERSATION_REPLY_PROMPT_FILE ? [groupOrchestratorId] : dependency(file)
    );
    const voiceId = add(
      "conversation-voice-v2",
      "system",
      file,
      () => migrateConversationVoicePrompt(config, file, ADMIN_RUNTIME_PROMPT_DEFAULTS[promptId] ?? ""),
      [emojiId]
    );
    const webFetchId = add(
      "conversation-webfetch-v1",
      "system",
      file,
      () => migrateConversationWebFetchPrompt(config, file, ADMIN_RUNTIME_PROMPT_DEFAULTS[promptId] ?? ""),
      [voiceId]
    );
    const directorId = add(
      "conversation-director-v1",
      "system",
      file,
      () => migrateConversationDirectorPrompt(config, file, ADMIN_RUNTIME_PROMPT_DEFAULTS[promptId] ?? ""),
      [webFetchId]
    );
    const inboundId = add(
      "conversation-inbound-v1",
      "system",
      file,
      () => migrateConversationInboundMessagePrompt(config, file),
      [directorId]
    );
    const bashToolsId = add(
      "conversation-bash-tools-v1",
      "system",
      file,
      () => migrateConversationBashToolsPrompt(
        config,
        file,
        ADMIN_RUNTIME_PROMPT_DEFAULTS[promptId] ?? ""
      ),
      [inboundId]
    );
    const bashWorkbenchId = add(
      "conversation-bash-workbench-v7",
      "system",
      file,
      () => migrateConversationBashWorkbenchPrompt(config, file),
      [bashToolsId]
    );
    const configurationIndexId = add(
      "conversation-configuration-index-v5",
      "system",
      file,
      () => migrateConversationConfigurationIndexPrompt(config, file),
      [bashWorkbenchId]
    );
    const chatMediaId = add(
      "conversation-chat-media-v4",
      "system",
      file,
      () => migrateConversationChatMediaPrompt(config, file),
      [configurationIndexId]
    );
    const recoverableId = add(
      "recoverable-output-v1",
      "system",
      file,
      () => migrateRecoverableOutputErrorPrompt(config, file),
      [chatMediaId]
    );
    const codexOutputId = add(
      "conversation-codex-output-v1",
      "system",
      file,
      () => migrateConversationCodexOutputPrompt(config, file),
      [recoverableId]
    );
    const referenceToolsId = add(
      "conversation-reference-tools-v1",
      "system",
      file,
      () => migrateConversationReferenceToolDescriptions(config, file),
      [codexOutputId]
    );
    const cacheLayoutId = add(
      "conversation-cache-layout-v1",
      "system",
      file,
      () => migrateConversationPromptCacheLayout(config, file),
      [referenceToolsId]
    );
    add(
      CONVERSATION_MESSAGE_32_MIGRATION_VERSION,
      "system",
      file,
      () => migrateConversationMessage32Prompt(config, file),
      [cacheLayoutId]
    );
  }

  const toneRecoverableId = add(
    "recoverable-output-v1",
    "system",
    TONE_PROMPT_FILE,
    () => migrateRecoverableOutputErrorPrompt(config, TONE_PROMPT_FILE),
    dependency(TONE_PROMPT_FILE)
  );
  const toneEmojiId = add(
    "tone-emoji-v2",
    "system",
    TONE_PROMPT_FILE,
    () => migrateToneEmojiMarkerRule(config, TONE_PROMPT_FILE),
    [toneRecoverableId]
  );
  const toneSegmentedId = add(
    "tone-segmented-v1",
    "system",
    TONE_PROMPT_FILE,
    () => migrateToneSegmentedReplyPrompt(config, TONE_PROMPT_FILE),
    [toneEmojiId]
  );
  add(
    "tone-bubble-count-guidance-v1",
    "system",
    TONE_PROMPT_FILE,
    () => migrateToneBubbleCountGuidancePrompt(config, TONE_PROMPT_FILE),
    [toneSegmentedId]
  );

  add(
    "memory-perspective-v7",
    "system",
    config.bot.memory.workMemoryCompressOutPrompt,
    () => migrateMemoryPerspectivePrompt(
      config,
      config.bot.memory.workMemoryCompressOutPrompt,
      ADMIN_RUNTIME_PROMPT_DEFAULTS["memory.compress-out"] ?? ""
    ),
    dependency(config.bot.memory.workMemoryCompressOutPrompt)
  );
  return definitions;
}

function requiredMigrationId(ids: Map<string, string>, file: string) {
  const value = ids.get(file);
  if (!value) throw new Error(`Missing time-context migration for ${file}`);
  return value;
}
