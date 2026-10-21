# 统一 Agent 管理与设置

## 目标与角色

已认证管理台管理员在 `/agents` 完成 Agent 切换、创建、启停、删除、身份和 QQ 接入设置。仅使用隔离合成 API 数据，不调用外部模型，不操作生产 QQ。

## 操作与预期

1. `/agents` 与 `/agents/persona` 显示统一设置页面，包含 Agent 选择、创建入口及当前 Agent 的启停、删除和运行摘要，原独立管理页面不再加载。
2. 分区导航、主导航、会话工具入口和概览接入入口均使用 `/agents/...`。旧 `/agent-settings/:section?` 保留查询参数与 hash 跳转到对应新地址。
3. 全局 Agent 下拉菜单只切换 Agent，不再显示“管理 Agent”。点击外部与 Escape 仍能关闭菜单。
4. 切换 Agent 和创建、删除前完成当前已确认配置保存；保存失败时保留当前内容并显示错误，不执行创建或删除。
5. 创建继续支持头像和配置导入；删除继续要求输入“确认删除”，默认普拉娜不提供删除动作。失败显示明确错误，不假报成功。
6. QQ 接入、身份、提示词、记忆及其他设置继续绑定当前 Agent；旧响应不能覆盖新 Agent，其他 Agent 数据保持不变。
7. 桌面和手机的深浅色页面无横向溢出，操作与状态可见，弹窗可关闭，复杂表单继续在弹窗内。

## 验证

组件测试覆盖生命周期错误与保存失败、身份隔离；浏览器验证新路由、旧地址跳转、创建和删除、下拉菜单、QQ 接入和设置自动保存。执行受影响单元测试、harness、完整 verify、light/dark 视觉检查和独立质量评审。管理员账密重设通过既有认证 API 或本机凭据 CLI 单独核验，密码不写入本用例、日志或 Git。

## 2026-10-21 验收结果

- 33 项受影响单元、6 项定向浏览器测试通过；独立评审执行 21 项检查，其中 4 项为隔离目录中的私有状态夹具，其余与专项测试重叠。
- 4 项 light/dark 视觉场景通过，统一页面、创建弹窗和 QQ 接入的 1440×900、390×844 共 12 张截图完成独立视觉检查。
- `npm run verify` 两次运行均在既有用例超时处停止：首轮 3 项 Dream 恢复用例超时，第二轮 Dream 全部通过，但表情完整性 1 项超时。未修改这些用例或超时阈值；Dream 独立 23/23、表情完整性独立 13/13 通过。隔离 unit 合并复测结果为 3,212 通过、1 项既有跳过，包含上述 4 项私有夹具。
- 按 verify 原顺序完成后续阶段，串行命令链退出 0：harness 43、integration 43、Skill sandbox 13、backup 45、migration 153、runtime smoke 84、完整 E2E 55 项通过；runtime contract、architecture、check、benchmark、build 通过。本次不声称单次 verify 命令退出 0。
- 生产只更新 9 个前端源码路径和 98 个静态文件，保留旧哈希资源，入口 HTML 最后原子替换；已有源码及静态资源回滚副本。所有公开构建资源逐个 HTTP 校验，三条新旧深链接返回同一构建 HTML。Core PID 与启动标识未变，无服务重启。
- 真实浏览器确认旧地址跳转、管理入口合并、下拉菜单去重、普拉娜与阿罗娜身份切换及 QQ 接入。管理员新凭据通过 API 和浏览器登录验证。更新后两个 QQ 的登录及在线探测均为 true。
- 本次没有调用外部模型或向真实 QQ 发送消息；不涵盖长期在线、断线补发和 arm64 实机验收。

私有证据位于 `workspace/runtime/tmp/ecs-assets/`：`unified-verify-final.log`、`unified-dream-retry.log`、`unified-emoji-retry.log`、`unified-verify-rest.log`、`unified-e2e-final.log`、`unified-visual-final.log`、`unified-agents-review.md`、`unified-deployment-result.json` 与 `unified-agents-live.png`；不加入 Git。
