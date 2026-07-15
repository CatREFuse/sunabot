# 功能—代码文件索引

[返回当前系统规范索引](./index.md)

## 10. 功能—代码文件索引

| 功能 | 主要代码 |
| --- | --- |
| 服务启动入口 | `apps/api/main.ts` |
| Node 版本一致性门禁 | `.node-version`, `.nvmrc`, `tooling/runtime/node-version-contract.mjs`, `tooling/runtime/validate-contract.mjs` |
| 出站代理解析与安装 | `packages/platform/proxy.mjs`, `deploy/runtime-contract.json` |
| API 组合、生命周期、静态站点与错误映射 | `apps/api/server.ts` |
| 管理鉴权 API | `apps/api/plugins/authRoutes.ts` |
| Provider、Codex 授权与配置 API | `apps/api/plugins/providerConfigRoutes.ts` |
| Agent 注册、账号调和与头像 API | `apps/api/plugins/agentRoutes.ts`, `services/agents/agentRegistry.ts`, `services/agents/accountRuntimeReconciler.ts`, `tooling/runtime/account-runtime-daemon.mjs` |
| 多 Agent 运行时与配置热更新 | `services/agents/agentRuntimeManager.ts`, `src/admin/agentConfigService.ts`, `packages/platform/runtimeAgentContext.ts` |
| OneBot 管理 API | `apps/api/plugins/onebotRoutes.ts` |
| 记忆管理 API | `apps/api/plugins/memoryRoutes.ts` |
| 状态、readiness 与监控 API | `apps/api/plugins/monitoringRoutes.ts`, `tooling/runtime/probe.mjs` |
| 会话与会话日志 API | `apps/api/plugins/conversationRoutes.ts` |
| Web Chat 管理员会话与浏览器 delivery | `services/webChat/`, `apps/api/plugins/conversationRoutes.ts` |
| 图片、缩略图、Token/模型调用统计、请求日志与图片测试 API | `apps/api/plugins/mediaRoutes.ts`, `apps/api/plugins/conversationRoutes.ts`, `src/modelCallStats.ts`, `src/requestLog.ts`, `adapters/sqlite/modelCallStore.ts` |
| Agent 文件与工具目录 API | `apps/api/plugins/agentToolRoutes.ts`, `services/tools/toolRegistry.ts` |
| 自拍参考图 API 与受控文件仓库 | `apps/api/plugins/selfieReferenceRoutes.ts`, `src/admin/selfieReferences.ts` |
| 配置加载、默认值、路径解析 | `src/config.ts`, `src/types.ts` |
| SQLite schema、业务数据与模型聚合 | `adapters/sqlite/applicationDataSchema.ts`, `adapters/sqlite/applicationDataStore.ts`, `adapters/sqlite/modelCallStore.ts` |
| 旧数据、workspace、首次运行与单 Agent 迁移门禁 | `packages/platform/multiAgentMigrationGate.mjs`, `tooling/shared/safe-absolute-path.mjs`, `tooling/workspace/init-workspace.mjs`, `tooling/runtime/first-run-state.mjs`, `tooling/migrations/migrate-to-sqlite.mjs`, `tooling/migrations/migrate-workspace-layout.mjs`, `tooling/migrations/migrate-single-agent-to-multi-agent.mjs` |
| SQLite 恢复点、迁移恢复与 journal | `tooling/workspace/sqlite-recovery.mjs`, `tooling/migrations/sqlite-migration-recovery.mjs`, `tooling/migrations/sqlite-legacy-import.mjs` |
| OneBot 连接、事件和 action | `adapters/onebot/onebotGateway.ts`, `adapters/onebot/qqMedia.ts` |
| 回复运行时、上下文、投递与群聊总结 | `src/runtime.ts`, `src/runtime/reply.ts`, `src/runtime/replyContext.ts`, `src/runtime/delivery.ts`, `src/runtime/intake.ts` |
| 会话事件、turn、工具任务、outbox | `services/sessions/`, `packages/contracts/session/runtimeMessages.ts` |
| 群聊门控、广播风暴嗅探与编排策略 | `services/orchestration/groupReplyPolicy.ts`, `services/orchestration/broadcastStormDetector.ts`, `services/agents/agentRuntimeManager.ts` |
| 命令路由与钩子 | `services/messaging/commandRouter.ts`, `services/messaging/hookBus.ts` |
| Provider、模型发现、多模态探测与工具循环 | `adapters/model/openaiProvider.ts`, `adapters/model/providerDiscovery.ts`, `adapters/model/provider/`, `services/tools/` |
| Codex 异步工具 | `adapters/codex/codexTool.ts` |
| 联网搜索 | `adapters/model/webSearchTool.ts`, `adapters/model/webSearchSettings.ts` |
| Bash、图像生成、历史媒体解析、自拍 | `services/tools/bashTool.ts`, `services/tools/generateImgTool.ts`, `src/runtime/reply.ts`, `adapters/model/provider/imageInput.ts`, `services/tools/selfieTool.ts` |
| 图片重试和外发 | `adapters/model/imageGenerationRetry.ts`, `services/delivery/outboundMedia.ts` |
| 人格、公共系统提示词与 Agent 覆盖 | `services/agent/`, `src/admin/agentFiles.ts`, `services/agents/agentRegistry.ts` |
| 记忆 CRUD、合并、召回和批次 | `services/memory/` |
| 记忆调度 | `services/memory/memoryScheduler.ts` |
| 附件接入、解析、缓存和上下文 | `services/media/attachments/` |
| 会话目录和显示名 | `services/conversations/conversationDirectory.ts`, `services/conversations/senderName.ts` |
| 管理配置和 Agent 文件 | `src/admin/` |
| 管理台路由和页面 | `apps/admin-web/src/router.ts`, `apps/admin-web/src/views/` |
| 管理台组件和状态 | `apps/admin-web/src/components/`, `apps/admin-web/src/composables/` |
| Agent 管理与全局切换 | `apps/admin-web/src/views/AgentsView.vue`, `apps/admin-web/src/components/agents/`, `apps/admin-web/src/composables/useAgents.ts`, `apps/admin-web/src/composables/agentScope.ts` |
| Agent 工具目录设置 | `apps/admin-web/src/components/settings/ToolsSettingsForm.vue`, `apps/admin-web/src/components/settings/ToolCatalogSettings.vue`, `apps/admin-web/src/components/settings/ToolDetailDialog.vue`, `apps/admin-web/src/components/settings/ToolRuntimeSettings.vue`, `apps/admin-web/src/composables/useToolCatalog.ts` |
| 自拍参考图设置 | `apps/admin-web/src/views/ImagesView.vue`, `apps/admin-web/src/components/settings/SelfieReferenceSettings.vue`, `apps/admin-web/src/components/settings/SelfieReferenceDialog.vue`, `apps/admin-web/src/composables/useSelfieReferences.ts` |
| 日志与群聊模型调用统计 | `apps/admin-web/src/components/logs/ModelCallStatsPanel.vue`, `apps/admin-web/src/views/LogsView.vue`, `apps/admin-web/src/components/conversations/ConversationThread.vue` |
| 统一运行入口、模式选择与发行打包 | `sunabot.sh`, `tooling/runtime/launcher.mjs`, `tooling/runtime/launcher-core.mjs`, `tooling/runtime/build-release.mjs` |
| Core 与 NapCat Docker 编排 | `deploy/docker/compose.yml`, `deploy/docker/Dockerfile`, `deploy/docker/Dockerfile.napcat`, `tooling/runtime/launcher.mjs` |
| macOS/WSL/Linux Native Core | `tooling/runtime/launcher.mjs`, `tooling/runtime/macos.mjs` |
| 全 Agent SQLite 恢复点 | `tooling/workspace/sqlite-recovery.mjs`, `tooling/workspace/sqlite-recovery-cli.mjs` |
| 单元与集成测试 | `tests/unit/`, `tests/integration/` |
| 浏览器与生产测试 | `tests/e2e/`, `playwright.config.ts` |
