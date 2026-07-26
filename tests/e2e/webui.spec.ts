import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { installMockApi, modelCatalog } from "./mock-api";

test("Agent 可新增、隔离切换并运行独立 NapCat QQ Docker", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/agents");

  await expect(page.getByRole("heading", { name: "Agent", exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "选择 阿罗娜" }).click();
  await expect(page.getByRole("heading", { name: "阿罗娜", exact: true })).toBeVisible();
  await expect(page.getByText("阿罗娜主账号", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新增", exact: true }).click();
  const createAgent = page.getByRole("dialog", { name: "新增 Agent" });
  await createAgent.getByLabel("名称").fill("圣娅");
  await createAgent.getByLabel("Agent ID").fill("seia");
  await createAgent.getByRole("button", { name: "创建 Agent", exact: true }).click();
  await expect(page.getByRole("heading", { name: "圣娅", exact: true })).toBeVisible();
  expect(state.agents.some((agent) => agent.id === "seia")).toBe(true);

  await page.getByRole("button", { name: "新建 NapCat QQ Docker", exact: true }).click();
  const createAccount = page.getByRole("dialog", { name: "新建 NapCat QQ Docker" });
  await createAccount.getByLabel("名称").fill("圣娅主账号");
  await createAccount.getByRole("button", { name: "新建", exact: true }).click();
  await expect(page.getByText("圣娅主账号", { exact: true })).toBeVisible();
  const createdAccount = state.agents.find((agent) => agent.id === "seia")?.accounts[0];
  expect(createdAccount).toMatchObject({
    desiredState: "running",
    observedState: "missing",
    reconcileRequired: true,
    runtimeReady: false,
    connected: false,
    lastError: null
  });
  await expect(page.getByText("需要处理", { exact: true })).toBeVisible();
  const run = page.getByRole("button", { name: "运行", exact: true });
  await expect(run).toBeEnabled();
  await run.click();
  expect(createdAccount).toMatchObject({
    desiredState: "running",
    observedState: "running",
    reconcileRequired: false,
    runtimeReady: true
  });
  await expect(page.getByText("待登录", { exact: true })).toBeVisible();
  const login = page.getByRole("button", { name: "登录", exact: true });
  await expect(login).toBeEnabled();
  await login.click();
  await expect(page.getByRole("heading", { name: "QQ 登录" })).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: "选择 阿罗娜" }).click();
  const promptRequest = page.waitForRequest((request) => request.url().includes("/api/agent-files?agentId=arona"));
  await page.getByRole("link", { name: "Agent 提示词", exact: true }).click();
  await promptRequest;
});

test("新建和移除 QQ Docker 会显示进行中状态", async ({ page }) => {
  await installMockApi(page);
  await page.goto("/agents");
  await page.getByRole("button", { name: "选择 阿罗娜" }).click();

  let releaseCreate: () => void = () => undefined;
  const createPending = new Promise<void>((resolve) => { releaseCreate = resolve; });
  await page.route("**/api/agents/arona/accounts", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await createPending;
    await route.fallback();
  });

  await page.getByRole("button", { name: "新建 NapCat QQ Docker", exact: true }).click();
  const createAccount = page.getByRole("dialog", { name: "新建 NapCat QQ Docker" });
  await createAccount.getByLabel("名称").fill("阿罗娜备用账号");
  await createAccount.getByRole("button", { name: "新建", exact: true }).click();
  await expect(page.getByRole("button", { name: "新建中", exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "新建中", exact: true }).first()).toBeDisabled();
  await expect(page.locator(".qq-docker-spinner").first()).toHaveCSS("animation-name", /^qq-docker-spin-/);
  releaseCreate();
  await expect(page.getByText("阿罗娜备用账号", { exact: true })).toBeVisible();

  let releaseRemove: () => void = () => undefined;
  const removePending = new Promise<void>((resolve) => { releaseRemove = resolve; });
  await page.route("**/api/agents/arona/accounts/qq_arona_main", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await removePending;
    await route.fallback();
  });

  await page.getByRole("button", { name: "移除 阿罗娜主账号" }).click();
  await expect(page.getByText("移除中", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "正在移除 阿罗娜主账号" })).toBeDisabled();
  await expect(page.locator(".qq-docker-spinner")).toHaveCSS("animation-name", /^qq-docker-spin-/);
  releaseRemove();
  await expect(page.getByText("阿罗娜主账号", { exact: true })).toHaveCount(0);
});

test("删除 Bot 需要输入确认删除", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/agents");
  await page.getByRole("button", { name: "选择 阿罗娜" }).click();
  await page.getByRole("button", { name: "删除 Bot", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "删除 Bot" });
  await expect(dialog.getByRole("button", { name: "删除 Bot", exact: true })).toBeDisabled();
  await dialog.getByLabel("输入「确认删除」以继续").fill("确认删除");
  await dialog.getByRole("button", { name: "删除 Bot", exact: true }).click();

  await expect(page.getByRole("heading", { name: "普拉娜", exact: true })).toBeVisible();
  expect(state.agents.some((agent) => agent.id === "arona")).toBe(false);
});

test("Agent 身份页可设置 WebUI 头像并立即刷新", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/agent-settings/persona");

  await expect(page.getByText("WebUI 头像", { exact: true })).toBeVisible();
  await expect(page.getByLabel("管理员 QQ")).toBeVisible();
  await expect(page.getByLabel("管理员称呼")).toBeVisible();
  const source = await sharp({
    create: { width: 900, height: 600, channels: 4, background: "#d71921" }
  }).png().toBuffer();
  await page.getByLabel("选择 WebUI 头像").setInputFiles({
    name: "plana.png",
    mimeType: "image/png",
    buffer: source
  });

  const cropDialog = page.getByRole("dialog", { name: "裁剪头像" });
  await expect(cropDialog).toBeVisible();
  await cropDialog.getByLabel("缩放头像").fill("1.4");
  const cropCanvas = cropDialog.getByLabel("头像裁剪区域");
  const bounds = await cropCanvas.boundingBox();
  if (!bounds) throw new Error("Missing avatar crop canvas bounds");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 28, bounds.y + bounds.height / 2);
  await page.mouse.up();
  await cropDialog.getByRole("button", { name: "使用头像", exact: true }).click();
  await expect(page.getByText("头像已更新", { exact: true })).toBeVisible();
  expect(state.avatarUpdates).toHaveLength(1);
  expect(state.avatarUpdates[0]).toMatchObject({ agentId: "plana", fileName: "avatar.png" });
  const encoded = state.avatarUpdates[0]!.dataBase64.split(",")[1];
  const cropped = await sharp(Buffer.from(encoded!, "base64")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(cropped.info).toMatchObject({ width: 384, height: 384, channels: 4 });
  expect(pixelAlpha(cropped.data, cropped.info.width, cropped.info.channels, 0, 0)).toBe(0);
  expect(pixelAlpha(cropped.data, cropped.info.width, cropped.info.channels, 192, 192)).toBe(255);
  await expect(page.getByAltText("普拉娜的头像").first()).toHaveAttribute(
    "src",
    "/api/agents/plana/avatar?v=assets%2Favatar-1.png"
  );
});

test("Agent 设置只保留有效且唯一的配置入口", async ({ page }) => {
  const state = await installMockApi(page);

  for (const viewport of [
    { width: 1_024, height: 768 },
    { width: 1_440, height: 900 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/overview");
    const navigation = page.getByRole("navigation", { name: "主导航" });
    await page.getByRole("button", { name: /^当前 Agent：/ }).click();
    const menu = page.getByRole("listbox", { name: "Agent" });
    await expect(menu).toBeVisible();
    const overflow = await navigation.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }));
    expect(overflow.scrollWidth).toBe(overflow.clientWidth);
    expect((await menu.boundingBox())?.width).toBeGreaterThanOrEqual(256);
  }

  await page.goto("/agent-settings/persona");
  await expect(page.getByText("Agent ID", { exact: true })).toBeVisible();
  await expect(page.getByText("工作目录", { exact: true })).toBeVisible();
  await expect(page.getByText("记忆上限", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);

  await page.goto("/agent-settings/memory");
  await expect(page.getByLabel("工作记忆上限")).toHaveCount(1);

  await page.goto("/agent-settings/tools");
  await expect(page.getByLabel("启用 Native Bash")).toBeVisible();
  await expect(page.getByLabel("启用 Docker Bash")).toBeVisible();
  await expect(page.getByLabel("启用 Codex")).toBeVisible();
  await page.getByRole("tab", { name: "运行参数", exact: true }).click();
  await expect(page.getByLabel("启动 Codex Worker")).toHaveCount(0);

  await page.goto("/agent-settings/bash");
  await expect(page.getByLabel("启用 Native Bash")).toHaveCount(0);
  await expect(page.getByLabel("启用 Docker Bash")).toHaveCount(0);
  await expect(page.getByLabel("严格审批")).toBeVisible();
  await expect(page.getByLabel("对抗审批 Agent")).toBeVisible();
  await expect(page.getByLabel("管理员身份门禁")).toHaveCount(0);
  await expect(page.getByLabel("管理员私聊后端")).toHaveCount(0);

  await page.goto("/agent-settings/orchestrator");
  const groupReply = page.getByLabel("启用群聊回复", { exact: true });
  await groupReply.uncheck();
  await page.getByRole("link", { name: "状态", exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect.poll(() => state.config.onebot.autoReplyUserGroup).toBe(false);
  await expect(page.getByRole("dialog", { name: "放弃未保存的设置？" })).toHaveCount(0);
  await page.goto("/agent-settings/orchestrator");
  await expect(groupReply).not.toBeChecked();
});

function pixelAlpha(data: Buffer, width: number, channels: number, x: number, y: number) {
  return data[(y * width + x) * channels + 3];
}

test("QQ 账号可在 WebUI 退出、扫码并实时刷新二维码", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/overview");

  await page.getByRole("button", { name: "QQ 账号", exact: true }).click();
  await expect(page.getByRole("heading", { name: "QQ 登录" })).toBeVisible();
  await expect(page.getByLabel("QQ 登录").getByText("QQ 123456", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "退出 QQ", exact: true }).click();
  await expect(page.getByText("确认退出当前 QQ？", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认退出", exact: true }).click();
  await expect(page.getByText("等待扫码", { exact: true })).toBeVisible();
  await expect(page.getByAltText("QQ 登录二维码")).toBeVisible();

  const previousVersion = state.qrVersion;
  await page.getByRole("button", { name: "刷新二维码", exact: true }).click();
  await expect.poll(() => state.qrVersion).toBeGreaterThan(previousVersion);
  await expect(page.getByText(/更新于/)).toBeVisible();
});

test("状态页展示 Token 缓存、日历与小时分布，并安全处理未报告缓存", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/overview");

  const section = page.getByLabel("Token 消耗统计");
  const summary = section.getByLabel("今日 Token 统计");
  await expect(section).toContainText("16.1K");
  await expect(summary.locator(".token-card--hero strong")).toHaveAttribute("title", "16,100");
  await expect(summary.locator(".token-card__exact")).toHaveCount(0);
  await expect(page.locator(".count-card small")).toHaveCount(0);
  await expect(page.locator(".count-card strong").first()).toHaveAttribute("title", "128");
  const metricFonts = await summary.locator(".token-card strong").evaluateAll((elements) => elements.map((element) => getComputedStyle(element).fontFamily));
  expect(metricFonts.every((font) => font.includes("Doto Variable"))).toBe(true);
  const countFonts = await page.locator(".count-card strong").evaluateAll((elements) => elements.map((element) => getComputedStyle(element).fontFamily));
  expect(countFonts.every((font) => font.includes("Doto Variable"))).toBe(true);
  const runtimeState = page.locator(".runtime-card__state");
  await expect(runtimeState).toHaveText("ONLINE");
  expect(await runtimeState.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Doto Variable");
  await expect(summary.getByText("缓存输入", { exact: true })).toBeVisible();
  await expect(summary.getByText("7.2K", { exact: true })).toBeVisible();
  await expect(summary.getByText("缓存率", { exact: true })).toBeVisible();
  await expect(summary).toContainText(/56(?:\.1)?%/);
  await expect(section.getByLabel("筛选 Token 模型")).toContainText("gpt-5.4-mini");
  await expect(section.getByLabel("筛选 Token 功能")).toContainText("编排器");
  const hourly = section.getByLabel("今日每小时 Token 总量与输入缓存率");
  await expect(hourly).toBeVisible();
  await section.getByRole("button", { name: "日", exact: true }).click();
  const calendar = section.getByLabel("每日 Token 消耗日历");
  await expect(calendar).toBeVisible();
  await section.getByLabel("筛选 Token 模型").selectOption("gpt-5.4-mini");
  await section.getByLabel("筛选 Token 功能").selectOption("memory");
  await expect.poll(() => state.tokenUsageRequests.at(-1)).toContain("model=gpt-5.4-mini&behavior=memory");
  await expect(summary).toContainText("4K");
  await expect(section).not.toContainText(/NaN|Infinity/);

  state.tokenUsage.today = {
    date: state.tokenUsage.today.date,
    input: 0,
    cachedInput: 0,
    cacheRate: null,
    output: 0,
    total: 0,
    requests: 1
  };
  state.tokenUsage.days = [{ ...state.tokenUsage.today }];
  state.tokenUsage.hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    input: 0,
    cachedInput: 0,
    cacheRate: null,
    output: 0,
    total: 0,
    requests: 0
  }));
  await page.reload();

  const emptyRate = page.getByLabel("今日 Token 统计").locator("article").filter({ hasText: "缓存率" });
  await expect(emptyRate.getByText("--", { exact: true }).first()).toBeVisible();
  const emptyHourly = page.getByLabel("今日每小时 Token 总量与输入缓存率");
  await expect(emptyHourly).toBeVisible();
  await expect(emptyHourly.locator("polyline")).toHaveCount(0);
  await expect(emptyHourly).not.toContainText(/NaN|Infinity/);
  expect(await page.getByLabel("Token 消耗统计").innerHTML()).not.toMatch(/NaN|Infinity/);
});

test("日志使用纵向时间轴、结构化用量与原始响应，并同时显示原始 ID 与中文名", async ({ page }) => {
  await installMockApi(page);
  await page.goto("/logs");

  const terminal = page.getByLabel("Bot 活动终端");
  await expect(terminal).toContainText("[message.private] 收到私聊消息");
  await page.getByRole("button", { name: "请求日志", exact: true }).click();
  const list = page.getByLabel("请求日志列表");
  await expect(list.locator(".request-list__timeline")).toBeVisible();
  await expect(list.locator(".request-list__marker").first()).toBeVisible();
  await expect(list.getByText("Codex 异步任务", { exact: true })).toBeVisible();
  await expect(list.getByText("codex.tool.complete", { exact: true })).toBeVisible();
  await expect(list.getByText("Responses 模型调用", { exact: true }).first()).toBeVisible();
  await expect(list.getByText("responses.complete", { exact: true }).first()).toBeVisible();
  await expect(list.getByText("兼容模型调用", { exact: true })).toBeVisible();
  await expect(list.getByText("chat.completions.complete", { exact: true })).toBeVisible();
  await expect(list.getByText("Anthropic 模型调用", { exact: true })).toBeVisible();
  await expect(list.getByText("anthropic.messages.complete", { exact: true })).toBeVisible();
  await expect(list.getByText("Gemini 模型调用", { exact: true })).toBeVisible();
  await expect(list.getByText("gemini.generate-content.complete", { exact: true })).toBeVisible();

  const codexCli = list.locator("article").filter({ hasText: "codex.tool.complete" });
  await expect(codexCli.getByText("缓存输入", { exact: true })).toBeVisible();
  await expect(codexCli.getByLabel("Token 用量").getByTitle("80 TOKEN")).toBeVisible();
  await expect(codexCli.getByText("80%", { exact: true })).toBeVisible();

  const anthropic = list.locator("article").filter({ hasText: "anthropic.messages.complete" });
  await expect(anthropic.getByText("缓存输入", { exact: true })).toBeVisible();
  await expect(anthropic.getByText("缓存率", { exact: true })).toBeVisible();
  await expect(anthropic.locator(".request-usage small")).toHaveCount(0);
  await anthropic.getByText("响应体", { exact: true }).click();
  await anthropic.locator("summary").filter({ hasText: /^usage/ }).click();
  await expect(anthropic.getByText("cache_creation_input_tokens", { exact: true })).toBeVisible();
  await expect(anthropic.getByText("cache_read_input_tokens", { exact: true })).toBeVisible();

  await list.getByText("请求体", { exact: true }).click();
  await expect(list.getByText("model", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
});

test("退出登录只在设置页提供", async ({ page }) => {
  await installMockApi(page);
  await page.goto("/overview");

  await expect(page.locator("nav").getByRole("button", { name: "退出登录" })).toHaveCount(0);
  await expect(page.locator("aside").getByRole("button", { name: "退出登录" })).toHaveCount(0);
  await page.getByRole("link", { name: "系统设置", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "退出管理台？" })).toBeVisible();
  await page.getByRole("button", { name: "退出登录", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
});

test("账户安全可修改管理员密码并保持当前登录", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/settings/security");

  await expect(page.getByRole("heading", { name: "管理员密码", exact: true })).toBeVisible();
  await page.getByLabel("当前密码").fill("session-secret");
  await page.getByLabel("新密码", { exact: true }).fill("new-session-secret-2026");
  await page.getByLabel("确认新密码").fill("different-session-secret");
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  await expect(page.getByText("两次输入的新密码不一致。", { exact: true })).toBeVisible();
  expect(state.passwordChanges).toHaveLength(0);

  await page.getByLabel("当前密码").fill("wrong-session-secret");
  await page.getByLabel("确认新密码").fill("new-session-secret-2026");
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  await expect(page.getByText("当前密码不正确。", { exact: true })).toBeVisible();

  await page.getByLabel("当前密码").fill("session-secret");
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  await expect(page.getByText("密码已更新", { exact: true })).toBeVisible();
  expect(state.passwordChanges).toHaveLength(1);
  await expect(page.getByLabel("当前密码")).toHaveValue("");
  await expect(page.getByLabel("新密码", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("确认新密码")).toHaveValue("");
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeHidden();
});

test("Web Chat 以管理员身份发送并保持独立的网页消息流", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/web-chat");

  const heading = page.getByRole("heading", { name: "与普拉娜对话", exact: true });
  await expect(heading).toBeVisible();
  await expect(page.getByLabel("Web Chat 消息").getByText("服务在线，今天已经处理 18 次模型请求。", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("继续检查网页投递");
  await page.getByRole("button", { name: "发送", exact: true }).click();

  await expect(page.getByLabel("Web Chat 消息").getByText("收到，网页会话保持在线。", { exact: true })).toBeVisible();
  expect(state.webChatRequests).toEqual(["继续检查网页投递"]);

  const titleStyle = await heading.evaluate((element) => {
    const style = getComputedStyle(element);
    return { family: style.fontFamily, size: Number.parseFloat(style.fontSize) };
  });
  expect(titleStyle.family).toContain("Space Grotesk");
  expect(titleStyle.size).toBe(40);
  const messageRadii = await page.getByLabel("Web Chat 消息").locator("article")
    .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).borderRadius));
  expect(messageRadii.every((radius) => radius === "0px")).toBe(true);
  const sendButtonStyle = await page.getByRole("button", { name: "发送", exact: true }).evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, borderWidth: style.borderTopWidth };
  });
  expect(sendButtonStyle.borderWidth).toBe("0px");
  expect(sendButtonStyle.background).toBe("rgba(0, 0, 0, 0)");
});

test("自拍参考图可预览、编辑备注、删除和逐图备注上传", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/images");

  await expect(page.getByText("3 / 9 张", { exact: true })).toBeVisible();
  const manager = page.getByRole("region", { name: "自拍参考图" });
  await expect(manager).toBeVisible();
  await expect(manager.getByText("素材库最多 9 张，每次自拍选用 1–3 张", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "自拍参考图" })).toHaveCount(0);

  await manager.getByRole("button", { name: "编辑备注 常服正面" }).click();
  const editDialog = page.getByRole("dialog", { name: "编辑图片备注" });
  await editDialog.getByLabel("01-neutral-face.png 的备注").fill("泳装");
  await editDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(manager.getByText("备注已保存", { exact: true })).toBeVisible();
  expect(state.selfieReferences[0]?.note).toBe("泳装");

  await manager.getByRole("button", { name: "查看原图 泳装" }).first().click();
  const preview = page.getByRole("dialog", { name: "自拍参考图预览" });
  await expect(preview).toBeVisible();
  await expect(preview.locator('img[src*="variant=original"]')).toBeVisible();
  await preview.getByRole("button", { name: "关闭预览" }).click();

  await manager.getByRole("button", { name: "删除 泳装" }).click();
  await expect(page.getByRole("heading", { name: "删除这张参考图？" })).toBeVisible();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(manager.getByText("参考图已删除", { exact: true })).toBeVisible();
  await expect(manager.locator("article")).toHaveCount(2);
  expect(state.selfieReferences).toHaveLength(2);

  await manager.locator('input[type="file"]').setInputFiles({
    name: "replacement.png",
    mimeType: "image/png",
    buffer: Buffer.from("replacement-image")
  });
  const uploadDialog = page.getByRole("dialog", { name: "填写图片备注" });
  await uploadDialog.getByLabel("replacement.png 的备注").fill("女仆装");
  await uploadDialog.getByRole("button", { name: "保存并上传", exact: true }).click();
  await expect(manager.getByText("1 张已保存", { exact: true })).toBeVisible();
  expect(state.selfieReferences).toHaveLength(3);
  expect(state.selfieReferences.at(-1)?.note).toBe("女仆装");
  expect(state.patchRequests).toHaveLength(0);

  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "运行状态" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "放弃未保存的设置？" })).toHaveCount(0);
});

test("Provider 创建时固定类型并支持模型拉取与多模态探测", async ({ page }) => {
  await installMockApi(page);
  await page.goto("/settings/providers");

  await page.getByRole("button", { name: "新增 Provider" }).click();
  await expect(page.getByRole("heading", { name: "选择 Provider 类型" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^创建 / })).toHaveCount(7);
  await page.getByRole("button", { name: "创建 Anthropic 官方" }).click();
  await expect(page.locator('span[aria-label="Provider 类型"]')).toHaveText("Anthropic 官方");
  await expect(page.getByLabel("Base URL")).toHaveAttribute("readonly", "");
  await expect(page.getByRole("combobox", { name: "协议" })).toHaveCount(0);
  await page.getByRole("button", { name: "拉取模型" }).click();
  await expect(page.getByText("已读取 7 个模型", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "探测多模态" }).click();
  await expect(page.getByText("支持图片", { exact: true }).last()).toBeVisible();
});

test("模型下拉目录、推理强度联动与字段确认", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/settings/providers");

  await expect(page.getByRole("heading", { name: "模型服务" })).toBeVisible();
  const modelSelect = page.getByRole("combobox", { name: "模型", exact: true }).first();
  await expect(modelSelect).toBeVisible();
  await expect(modelSelect.locator("option")).toHaveText([
    ...modelCatalog.map((model) => model.label),
    "自定义"
  ]);

  await page.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByText("连接成功 · gpt-5.6-sol · 128 ms", { exact: true })).toBeVisible();
  expect(state.patchRequests).toHaveLength(0);
  await page.getByRole("button", { name: "复制 Provider" }).click();
  await expect(page.getByRole("button", { name: /Codex 副本/ })).toBeVisible();
  await page.getByRole("button", { name: "删除 Provider" }).click();
  await expect(page.getByRole("button", { name: /Codex 副本/ })).toHaveCount(0);

  const effortSelect = page.getByLabel("推理强度").first();
  await modelSelect.selectOption("gpt-5.6-luna");
  await expect(effortSelect.locator("option")).toHaveText(["low", "medium", "high", "xhigh", "max"]);
  await expect(effortSelect).toHaveValue("medium");

  await modelSelect.selectOption("gpt-5.6-sol");
  await expect(effortSelect.locator("option")).toHaveText(["low", "medium", "high", "xhigh", "max", "ultra"]);
  await effortSelect.selectOption("ultra");
  await page.getByLabel("名称").fill("Codex Primary");
  await page.locator('[data-confirm-label="确认 Provider 名称"]').click();

  await expect.poll(() => state.config.providers.items[0]?.label).toBe("Codex Primary");
  expect(state.patchRequests.at(-1)?.section).toBe("providers");
  expect(state.config.providers.items[0]).toMatchObject({
    label: "Codex Primary",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra"
  });
  await expect(page.locator('[data-slot="settings-auto-save-status"]')).toHaveCount(0);

  await page.goto("/agent-settings/tools");
  await page.getByRole("tab", { name: "运行参数", exact: true }).click();
  const codexModelSelect = page.getByRole("combobox", { name: "模型", exact: true });
  await expect(codexModelSelect.locator("option")).toHaveText(modelCatalog.map((model) => model.label));
  await expect(page.getByLabel("可执行文件")).toHaveValue("auto");
  await expect(page.getByText("已启用", { exact: true })).toBeVisible();
  await expect(page.getByLabel("默认质量")).toHaveValue("high");
  await codexModelSelect.selectOption("gpt-5.5");
  await page.getByLabel("默认质量").selectOption("auto");

  await expect.poll(() => state.config.bot.tools.codex.model).toBe("gpt-5.5");
  expect(state.patchRequests.at(-1)?.section).toBe("tools");
  expect(state.config.bot.tools.codex.model).toBe("gpt-5.5");
  expect(state.config.bot.tools.generateImg.quality).toBe("auto");

  await page.getByRole("button", { name: "添加 Key" }).click();
  await page.getByLabel("Tavily API Key 1").fill("tvly-e2e-secret-1234567890");
  await page.locator('[data-confirm-label="确认 Tavily API Key 1"]').click();
  await expect(page.getByLabel("Tavily Key 环境变量")).toHaveValue("TAVILY_API_KEY");

  await expect.poll(() => state.config.bot.tools.websearch.tavilyApiKeys).toEqual(["tvly-e2e-secret-1234567890"]);
  expect(state.config.bot.tools.websearch.tavilyApiKeys).toEqual(["tvly-e2e-secret-1234567890"]);
  await expect(page.getByLabel("Tavily API Key 1")).toHaveCount(0);
  await expect(page.getByText("1 个已配置", { exact: true })).toBeVisible();
  await expect(page.locator(".key-pool__identity").getByText("已配置", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "添加 Key" }).click();
  await page.getByLabel("Tavily API Key 1").fill("tvly-e2e-secret-2-1234567890");
  await page.locator('[data-confirm-label="确认 Tavily API Key 1"]').click();
  await expect.poll(() => state.config.bot.tools.websearch.tavilyApiKeys).toHaveLength(2);

  await page.getByRole("button", { name: "删除 Key 1" }).click();
  await expect.poll(() => state.config.bot.tools.websearch.tavilyApiKeys).toEqual(["tvly-e2e-secret-2-1234567890"]);
  await expect(page.getByText("1 个已配置", { exact: true })).toBeVisible();
});

test("防抖时间、回复开关、名称和命令前缀只在回复行为分区编辑", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/agent-settings/bot");

  await expect(page.getByRole("heading", { name: "回复行为" })).toBeVisible();
  await expect(page.getByLabel("启用私聊")).toBeChecked();
  await expect(page.getByLabel("启用 Bot 群聊")).not.toBeChecked();
  await page.getByLabel("启用私聊").uncheck();
  await page.getByLabel("启用 Bot 群聊").check();
  await expect(page.getByLabel("启用私聊")).not.toBeChecked();
  await expect(page.getByLabel("启用 Bot 群聊")).toBeChecked();
  await page.getByLabel("输入防抖时间（秒）").fill("7.5");
  await page.locator('[data-confirm-label="确认输入防抖时间"]').click();
  await page.getByLabel("过滤名单").fill("20001, 20002, 20001");
  await page.locator('[data-confirm-label="确认过滤名单"]').click();
  await page.getByLabel("名称").fill("普拉娜, Plana, Arona");
  await page.locator('[data-confirm-label="确认名称"]').click();
  await page.getByLabel("命令前缀").fill("/suna, /sunabot");
  await page.locator('[data-confirm-label="确认命令前缀"]').click();

  await expect.poll(() => state.config.onebot.commandPrefixes).toEqual(["/suna", "/sunabot"]);
  await expect.poll(() => new Set(state.patchRequests.map((request) => request.section))).toEqual(new Set(["bot", "onebot"]));
  expect(state.config.bot.replyDebounceMs).toBe(7_500);
  expect(state.config.bot.quoteGroupReplyExcludedUserIds).toEqual(["20001", "20002"]);
  expect(state.config.onebot).toMatchObject({
    autoReplyPrivate: false,
    autoReplyBotGroup: true,
    mentionNames: ["普拉娜", "Plana", "Arona"],
    commandPrefixes: ["/suna", "/sunabot"]
  });

  await page.goto("/settings/onebot");
  await expect(page.getByLabel("启用私聊")).toHaveCount(0);
  await expect(page.getByLabel("启用 Bot 群聊")).toHaveCount(0);
  await expect(page.getByLabel("名称")).toHaveCount(0);
  await expect(page.getByLabel("命令前缀")).toHaveCount(0);
  await expect(page.getByLabel("过滤名单")).toHaveCount(0);
});

test("Agent 可独立配置语气处理并打开提示词", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/agent-settings/tone");

  await expect(page.getByRole("heading", { name: "语气处理" })).toBeVisible();
  await page.getByLabel("启用语气处理").check();
  await page.getByLabel("分段回复").check();
  await page.getByLabel("Provider").selectOption("codex");
  await page.getByRole("combobox", { name: "模型", exact: true }).selectOption("gpt-5.5");
  await page.getByLabel("推理强度").selectOption("high");
  await page.getByLabel("随机性（Temperature）").fill("1.1");
  await page.locator('[data-confirm-label="确认随机性"]').click();
  await page.getByLabel("最大输出 Token").fill("3200");
  await page.locator('[data-confirm-label="确认最大输出 Token"]').click();
  await page.getByLabel("失败重试次数").fill("4");
  await page.locator('[data-confirm-label="确认失败重试次数"]').click();

  await expect.poll(() => state.config.bot.tone.maxRetries).toBe(4);
  expect(state.patchRequests.at(-1)?.section).toBe("tone");
  expect(state.config.bot.tone).toMatchObject({
    enabled: true,
    segmentedReply: true,
    followMainModel: false,
    providerId: "codex",
    model: "gpt-5.5",
    reasoningEffort: "high",
    temperature: 1.1,
    maxOutputTokens: 3200,
    maxRetries: 4
  });

  await page.getByLabel("主模型跟随").check();
  await expect(page.getByLabel("Provider")).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "模型", exact: true })).toBeDisabled();
  await expect(page.getByLabel("推理强度")).toBeDisabled();
  await expect(page.getByLabel("随机性（Temperature）")).toHaveValue("0.7");
  await expect(page.getByLabel("最大输出 Token")).toHaveValue("2400");
  await expect(page.getByLabel("失败重试次数")).toHaveValue("3");
  await expect(page.getByLabel("随机性（Temperature）")).toBeDisabled();
  await expect(page.getByLabel("最大输出 Token")).toBeDisabled();
  await expect(page.getByLabel("失败重试次数")).toBeDisabled();
  await expect.poll(() => state.config.bot.tone.followMainModel).toBe(true);
  expect(state.config.bot.tone).toMatchObject({
    providerId: "codex",
    model: "gpt-5.5",
    reasoningEffort: "high",
    temperature: 1.1,
    maxOutputTokens: 3200,
    maxRetries: 4
  });

  await page.getByRole("link", { name: "编辑正文" }).click();
  await expect(page).toHaveURL(/\/system-prompts\/conversation\.tone-rewrite$/);
  await expect(page.getByRole("heading", { name: "语气改写" })).toBeVisible();
  await expect(page.getByRole("button", { name: "变量表", exact: true })).toBeHidden();
  const variableTable = page.getByRole("table", { name: "提示词变量表" });
  await expect(variableTable.getByText("@{tone.input}", { exact: true })).toBeVisible();
  await expect(variableTable.getByText("@{tone.output_contract}", { exact: true })).toBeVisible();
  await expect(variableTable.getByText("@{tone.available_assets}", { exact: true })).toBeVisible();
});

test("系统设置可配置广播风暴嗅探参数", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/settings/broadcastStorm");

  await expect(page.getByRole("heading", { name: "广播风暴" })).toBeVisible();
  await expect(page.getByLabel("广播风暴嗅探")).toBeChecked();
  await expect(page.getByLabel("检测窗口（分钟）")).toHaveValue("2");
  await expect(page.getByLabel("回复次数")).toHaveValue("3");
  await expect(page.getByLabel("静默时长（分钟）")).toHaveValue("1");
  await expect(page.getByLabel("补充嗅探账号")).toHaveValue("");

  await page.getByLabel("检测窗口（分钟）").fill("5");
  await page.locator('[data-confirm-label="确认检测窗口"]').click();
  await page.getByLabel("回复次数").fill("6");
  await page.locator('[data-confirm-label="确认回复次数"]').click();
  await page.getByLabel("静默时长（分钟）").fill("7");
  await page.locator('[data-confirm-label="确认静默时长"]').click();
  await page.getByLabel("补充嗅探账号").fill("10001, 20002");
  await page.locator('[data-confirm-label="确认补充嗅探账号"]').click();

  await expect.poll(() => state.config.broadcastStorm.cooldownMinutes).toBe(7);
  expect(state.patchRequests.at(-1)).toMatchObject({
    section: "broadcastStorm",
    body: {
      value: {
        enabled: true,
        windowMinutes: 5,
        replyThreshold: 6,
        cooldownMinutes: 7,
        additionalQqIds: ["10001", "20002"]
      }
    }
  });
  expect(state.config.broadcastStorm).toEqual({
    enabled: true,
    windowMinutes: 5,
    replyThreshold: 6,
    cooldownMinutes: 7,
    additionalQqIds: ["10001", "20002"]
  });
});

test("系统设置可配置回复重试次数", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/settings/normalReply");

  await expect(page.getByRole("heading", { name: "回复重试" })).toBeVisible();
  await expect(page.getByLabel("失败重试次数")).toHaveValue("3");

  await page.getByLabel("失败重试次数").fill("6");
  await page.locator('[data-confirm-label="确认失败重试次数"]').click();

  await expect.poll(() => state.config.normalReply.maxRetries).toBe(6);
  expect(state.patchRequests.at(-1)).toMatchObject({
    section: "normalReply",
    body: { value: { maxRetries: 6 } }
  });
  expect(state.config.normalReply).toEqual({ maxRetries: 6 });
});

test("旧版系统配置缺少回复重试时仍可打开设置页", async ({ page }) => {
  const state = await installMockApi(page);
  delete (state.config as Partial<typeof state.config>).normalReply;

  await page.goto("/settings/normalReply");

  await expect(page.getByRole("heading", { name: "回复重试" })).toBeVisible();
  await expect(page.getByLabel("失败重试次数")).toHaveValue("3");
  await expect(page.getByText('"undefined" is not valid JSON', { exact: true })).toHaveCount(0);
});

test("连接监控按字段确认且失败时保留当前输入", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/settings/onebot");

  await page.getByLabel("聚合窗口（秒）").fill("90");
  await page.locator('[data-confirm-label="确认聚合窗口"]').click();
  await page.getByLabel("服务运行状态").uncheck();
  await page.getByLabel("Bark URL", { exact: true }).fill("https://api.day.app/example-device");
  await page.locator('[data-confirm-label="确认 Bark URL"]').click();

  await expect.poll(() => state.monitoringSettings.aggregationWindowSeconds).toBe(90);
  expect(state.monitoringSettings.serverEventsEnabled).toBe(false);
  expect(state.monitoringSettings.barkConfigured).toBe(true);
  await expect(page.getByRole("button", { name: "保存监控设置" })).toHaveCount(0);
  await expect(page.locator("span.inline-state").filter({ hasText: "已配置" })).toBeVisible();

  state.nextMonitoringError = "聚合窗口无效。";
  await page.getByLabel("聚合窗口（秒）").fill("91");
  await page.locator('[data-confirm-label="确认聚合窗口"]').click();
  await expect(page.getByText("聚合窗口无效。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("聚合窗口（秒）")).toHaveValue("91");
});

test("配置医生独立检查、显式 AI 诊断并只提交方案标识", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/overview");

  const desktopNavigation = page.getByRole("navigation", { name: "主导航" });
  const desktopItems = await desktopNavigation.getByRole("link").evaluateAll((links) => (
    links.map((link) => link.getAttribute("href") ?? "")
  ));
  expect(desktopItems.indexOf("/settings")).toBeLessThan(desktopItems.indexOf("/config-doctor"));
  expect(desktopItems.indexOf("/config-doctor")).toBeLessThan(desktopItems.indexOf("/system-prompts"));
  expect(desktopItems.indexOf("/system-prompts")).toBeLessThan(desktopItems.indexOf("/releases"));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "更多", exact: true }).click();
  const moreDialog = page.getByRole("dialog", { name: "更多" });
  const mobileItems = await moreDialog.getByRole("link").evaluateAll((links) => (
    links.map((link) => link.getAttribute("href") ?? "")
  ));
  expect(mobileItems.indexOf("/settings")).toBeLessThan(mobileItems.indexOf("/config-doctor"));
  expect(mobileItems.indexOf("/config-doctor")).toBeLessThan(mobileItems.indexOf("/system-prompts"));
  expect(mobileItems.indexOf("/system-prompts")).toBeLessThan(mobileItems.indexOf("/releases"));
  await moreDialog.getByRole("button", { name: "关闭", exact: true }).click();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/config-doctor");
  await expect(page.getByRole("heading", { name: "配置医生", exact: true })).toBeVisible();
  await expect(page.getByText("发现 1 项可修复问题", { exact: true })).toBeVisible();
  await expect(page.getByText("本地规则 · 可修复", { exact: true })).toBeVisible();
  await expect(page.getByText("/normalReply/maxRetries", { exact: true }).first()).toBeVisible();
  await expect.poll(() => state.doctorRequests).toEqual([
    { method: "GET", path: "/api/config-doctor/scan" }
  ]);
  expect(state.patchRequests).toEqual([]);

  await page.getByRole("button", { name: "AI 诊断", exact: true }).click();
  await expect(page.getByText("AI 诊断已完成", { exact: true })).toBeVisible();
  await expect(page.getByText("AI 诊断 · 可修复", { exact: true })).toBeVisible();
  await expect.poll(() => state.doctorRequests.filter((request) => request.path.endsWith("/propose")).length).toBe(1);
  expect(state.doctorRequests.find((request) => request.path.endsWith("/propose"))?.body).toEqual({
    sourceRevision: "doctor-r1"
  });

  await page.getByRole("button", { name: "一键修复", exact: true }).click();
  let repairDialog = page.getByRole("dialog", { name: "修复全部配置？" });
  await expect(repairDialog).toBeVisible();
  await repairDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(repairDialog).toBeHidden();
  expect(state.doctorRequests.filter((request) => request.path.endsWith("/apply"))).toEqual([]);

  await page.getByRole("button", { name: "一键修复", exact: true }).click();
  repairDialog = page.getByRole("dialog", { name: "修复全部配置？" });
  await repairDialog.getByRole("button", { name: "确认修复", exact: true }).click();
  await expect(page.getByText("配置正常", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "配置已修复", exact: true })).toBeVisible();

  const applyRequest = state.doctorRequests.find((request) => request.path.endsWith("/apply"));
  expect(applyRequest?.body).toEqual({
    proposalId: "doctor-ai-r1",
    sourceRevision: "doctor-r1"
  });
  expect(Object.keys(applyRequest?.body as Record<string, unknown>).sort()).toEqual([
    "proposalId",
    "sourceRevision"
  ]);
  expect(state.patchRequests).toEqual([]);
  expect(state.doctorRequests.filter((request) => request.path.endsWith("/scan"))).toHaveLength(2);
});

test("版本页面展示当前版本与更新日志", async ({ page }) => {
  await installMockApi(page);
  const initialRequest = page.waitForRequest((request) => request.url().endsWith("/api/releases"));

  await page.goto("/releases");
  expect((await initialRequest).method()).toBe("GET");

  await expect(page.getByRole("heading", { name: "版本更新", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "v0.1.3", exact: true })).toBeVisible();
  await expect(page.getByText("当前发行", { exact: true })).toBeVisible();
  await expect(page.getByText("2026年7月25日", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "更新日志", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "工作区", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "升级", exact: true })).toBeVisible();

  const refreshRequest = page.waitForRequest((request) => request.url().endsWith("/api/releases"));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  expect((await refreshRequest).method()).toBe("GET");
});

test("语音设置按 Agent 保存在线服务、语言和音色资料", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/voice");

  await expect(page.getByRole("heading", { name: "语音", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "在线语音服务", exact: true })).toBeVisible();
  await page.getByLabel("服务地址").fill("https://voice.example/v1");
  await page.getByLabel("模型").fill("voice-model");
  await page.getByRole("button", { name: "保存设置", exact: true }).first().click();
  await expect.poll(() => state.voiceProfiles.plana?.provider.baseUrl).toBe("https://voice.example/v1");
  await expect.poll(() => state.voiceProfiles.plana?.provider.model).toBe("voice-model");
  await page.getByRole("button", { name: "检测连接", exact: true }).click();
  await expect.poll(() => state.voiceServiceRequests).toEqual(["check"]);
  await expect(page.getByText("在线语音服务可用", { exact: true })).toBeVisible();

  await expect(page.getByText("kivo-plana-ja.wav", { exact: true })).toBeVisible();
  await page.getByLabel("启用语音").uncheck();
  await page.getByRole("button", { name: "保存设置", exact: true }).last().click();
  await expect.poll(() => state.voiceProfiles.plana?.enabled).toBe(false);

  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "添加音频", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加English参考音频" });
  await dialog.getByLabel("选择参考音频").setInputFiles({
    name: "plana-en.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("RIFF0000WAVE")
  });
  await dialog.getByRole("textbox").fill("Good morning, Sensei.");
  await dialog.getByRole("button", { name: "保存并上传", exact: true }).click();

  await expect(page.getByTitle("plana-en.wav")).toBeVisible();
  expect(state.voiceProfiles.plana?.languages.en?.referenceText).toBe("Good morning, Sensei.");
});

test("工具目录支持启停、全局说明和继承说明恢复", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/agent-settings/tools");

  await expect(page.getByRole("tab", { name: "工具目录", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("搜索工具")).toBeVisible();
  await expect(page.getByLabel(/^启用 /)).toHaveCount(24);
  for (const name of [
    "assistant_text",
    "no_reply",
    "memory_recall",
    "read_air",
    "knowledge_search",
    "websearch",
    "webfetch",
    "generate_img",
    "selfie",
    "read_file",
    "write_file",
    "export_chat_media",
    "import_chat_emoji",
    "send_file",
    "send_voice_message",
    "native_bash",
    "docker_bash",
    "codex",
    "activate_skill",
    "read_skill_resource",
    "run_skill_script",
    "cron",
    "system_config",
    "call_director"
  ]) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("system.time", { exact: true })).toHaveCount(0);
  await expect(page.getByText("onebot.send_message", { exact: true })).toHaveCount(0);
  await expect(page.getByText("provider.test", { exact: true })).toHaveCount(0);

  for (const [id, title] of [["docker_bash", "Docker Bash"], ["codex", "Codex"]] as const) {
    const row = page.locator("article").filter({ has: page.getByText(id, { exact: true }) });
    await expect(row.getByText("配置已启用", { exact: true })).toBeVisible();
    await expect(row.getByText("能力可用", { exact: true })).toHaveCount(0);
    await expect(row.getByText("运行环境异常", { exact: true })).toHaveCount(0);
    await row.getByLabel(`启用 ${title}`).uncheck({ force: true });
    await expect(row.getByText("配置已停用", { exact: true })).toBeVisible();
    await expect(row.getByText("能力可用", { exact: true })).toHaveCount(0);
    await expect(row.getByText("运行环境异常", { exact: true })).toHaveCount(0);
    await row.getByLabel(`启用 ${title}`).check({ force: true });
  }

  const nativeBashRow = page.locator("article").filter({ has: page.getByText("native_bash", { exact: true }) });
  await expect(nativeBashRow.getByText("管理员私聊与 Web Chat 可用", { exact: true })).toBeVisible();
  await expect(nativeBashRow.getByText("Native Bash 可用", { exact: true })).toBeVisible();
  const dockerBashRow = page.locator("article").filter({ has: page.getByText("docker_bash", { exact: true }) });
  await expect(dockerBashRow.getByText("全部允许会话可用", { exact: true })).toBeVisible();
  await expect(dockerBashRow.getByText("Docker Bash 已启动", { exact: true })).toBeVisible();
  await dockerBashRow.getByRole("button", { name: "查看 Docker Bash 详情" }).click();
  const bashDialog = page.getByRole("dialog", { name: "Docker Bash" });
  await expect(bashDialog.getByText("适用会话", { exact: true })).toBeVisible();
  await expect(bashDialog.locator("dt").filter({ hasText: /^Docker Bash$/ })).toBeVisible();
  await bashDialog.getByRole("button", { name: "关闭工具详情" }).click();
  await expect(page.locator('[data-slot="settings-auto-save-status"]')).toHaveCount(0);
  await expect(page.getByLabel("启用 Native Bash")).toBeChecked();
  await expect(page.getByLabel("启用 Docker Bash")).toBeChecked();
  await expect(page.getByLabel("启用 Codex")).toBeChecked();

  for (const id of ["activate_skill", "read_skill_resource"] as const) {
    const row = page.locator("article").filter({ has: page.getByText(id, { exact: true }) });
    await expect(row.getByText("能力可用", { exact: true })).toHaveCount(0);
    await expect(row.getByText("运行环境异常", { exact: true })).toHaveCount(0);
  }
  const unavailableSkillRow = page.locator("article").filter({ has: page.getByText("run_skill_script", { exact: true }) });
  await expect(unavailableSkillRow.getByText("运行环境异常", { exact: true })).toBeVisible();
  await expect(unavailableSkillRow.getByText("当前环境没有可用的 Skill 脚本审计执行器。", { exact: true })).toBeVisible();

  const websearchToggle = page.getByLabel("启用 网页搜索");
  await websearchToggle.scrollIntoViewIfNeeded();
  await websearchToggle.uncheck();
  await expect(websearchToggle).not.toBeChecked();
  await page.getByRole("button", { name: "查看 行动中消息 详情" }).click();
  let dialog = page.getByRole("dialog", { name: "行动中消息" });
  await expect(dialog.getByRole("table", { name: "工具参数" })).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "text", exact: true })).toBeVisible();
  const defaultDescription = await dialog.getByLabel("模型描述").inputValue();
  await dialog.getByLabel("模型描述").fill("在多轮任务中及时同步当前进展。");
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭工具详情" }).click();

  await expect.poll(() => state.config.bot.tools.overrides.assistant_text?.description).toBe("在多轮任务中及时同步当前进展。");
  expect(state.patchRequests.map((request) => request.section)).toContain("tools");
  expect(state.config.bot.tools.overrides).toMatchObject({
    assistant_text: { description: "在多轮任务中及时同步当前进展。" },
    websearch: { enabled: false }
  });

  await page.getByRole("button", { name: "查看 行动中消息 详情" }).click();
  dialog = page.getByRole("dialog", { name: "行动中消息" });
  await expect(dialog.getByLabel("模型描述")).toHaveValue("在多轮任务中及时同步当前进展。");
  await dialog.getByRole("button", { name: "恢复继承说明" }).click();
  await expect(dialog.getByLabel("模型描述")).toHaveValue(defaultDescription);
  await dialog.getByRole("button", { name: "关闭工具详情" }).click();

  await expect.poll(() => state.config.bot.tools.overrides.assistant_text?.description).toBeUndefined();
  expect(state.config.bot.tools.overrides.assistant_text?.description).toBeUndefined();
  expect(state.config.bot.tools.overrides.websearch).toEqual({ enabled: false });

  await page.reload();
  await expect(page.getByLabel("启用 网页搜索")).not.toBeChecked();
  await page.getByRole("button", { name: "查看 行动中消息 详情" }).click();
  await expect(page.getByRole("dialog", { name: "行动中消息" }).getByLabel("模型描述"))
    .toHaveValue(defaultDescription);

  await page.getByRole("button", { name: "关闭工具详情" }).click();
  await page.getByRole("tab", { name: "运行参数", exact: true }).click();
  await expect(page.getByText("已启用", { exact: true })).toBeVisible();
  await expect(page.getByLabel("单轮工具调用上限")).toHaveValue("20");
});

test("no_reply 与回复行为共用戳一戳设置", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/agent-settings/tools");

  await page.getByRole("button", { name: "查看 静默结束 详情" }).click();
  let dialog = page.getByRole("dialog", { name: "静默结束" });
  await dialog.getByLabel("no_reply 时戳一戳").check();
  await dialog.getByRole("button", { name: "关闭工具详情" }).click();

  await expect.poll(() => state.config.bot.pokeOnNoReply).toBe(true);
  expect(state.patchRequests[0]?.section).toBe("bot");
  expect(state.config.bot.pokeOnNoReply).toBe(true);

  await page.goto("/agent-settings/bot");
  await expect(page.getByLabel("no_reply 时戳一戳")).toBeChecked();
  await page.getByLabel("no_reply 时戳一戳").uncheck();
  await expect.poll(() => state.config.bot.pokeOnNoReply).toBe(false);

  await page.goto("/agent-settings/tools");
  await page.getByRole("button", { name: "查看 静默结束 详情" }).click();
  dialog = page.getByRole("dialog", { name: "静默结束" });
  await expect(dialog.getByLabel("no_reply 时戳一戳")).not.toBeChecked();
});

test("提示词库列出全部文件并支持快捷保存与冲突恢复", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/agent-prompts/persona.soul");

  await expect(page.getByRole("heading", { name: "核心人格" })).toBeVisible();
  const fileList = page.locator("aside").filter({ has: page.getByLabel("搜索文件") });
  await expect(fileList.getByRole("button")).toHaveCount(8);
  await expect(fileList.getByRole("button", { name: /自拍提示词改写/ })).toBeVisible();
  await page.getByLabel("覆盖系统提示词").check();
  await expect(fileList.getByRole("button")).toHaveCount(18);
  expect(state.promptOverrides.plana).toBe(true);
  const editor = page.getByLabel("提示词正文");
  await expect(editor).toContainText("冷静、诚实、可靠");

  await editor.fill("清醒、可靠、坦诚。\n");
  await editor.press("Control+s");
  await expect.poll(() => state.fileWrites.length).toBe(1);
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();

  const serverFile = state.files.find((file) => file.id === "persona.soul");
  expect(serverFile).toBeDefined();
  if (!serverFile) return;
  serverFile.revision = "persona.soul-server-r2";
  await editor.fill("保留本地版本。\n");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const conflictAlert = page.getByRole("alert", { name: "版本冲突" });
  await expect(conflictAlert).toContainText("服务器版本已更新");
  await expect(conflictAlert).toContainText("保留当前内容后可再次保存，或加载服务器版本并放弃当前修改。");

  await conflictAlert.getByRole("button", { name: "保留当前内容" }).click();
  await expect(editor).toContainText("保留本地版本。");
  await expect(conflictAlert).toBeHidden();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => state.fileWrites.length).toBe(3);
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();

  serverFile.revision = "persona.soul-server-r3";
  serverFile.content = "服务器最新内容。\n";
  await editor.fill("将被服务器版本替换。\n");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(conflictAlert).toBeVisible();
  await conflictAlert.getByRole("button", { name: "加载服务器版本" }).click();
  await expect(editor).toContainText("服务器最新内容。");
  await expect(conflictAlert).toBeHidden();
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();

  await editor.fill("尚未保存。\n");
  await page.getByRole("link", { name: "系统设置" }).click();
  await expect(page.getByRole("heading", { name: "放弃未保存的修改？" })).toBeVisible();
  await page.getByRole("button", { name: "继续编辑" }).click();
  await expect(page).toHaveURL(/\/agent-prompts\/persona\.soul$/);

  await page.getByRole("link", { name: "系统设置" }).click();
  await page.getByRole("button", { name: "保存并离开" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect.poll(() => state.files.find((item) => item.id === "persona.soul")?.content).toBe("尚未保存。\n");
});

test("宽屏提示词可调整变量表宽度", async ({ page }) => {
  await installMockApi(page);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto("/agent-prompts/persona.soul");

  const promptEditor = page.getByLabel("提示词正文");
  await promptEditor.fill("# 标题\n**重点**与*斜体*\n> 引用\n<context>@{bot.name}</context>\n```text\n代码块\n```");
  await expect(promptEditor).toHaveAttribute("contenteditable", "true");
  await expect(promptEditor).toHaveAttribute("data-language", "markdown");
  await expect(page.locator(".prompt-field__editor .cm-lineNumbers .cm-gutterElement").filter({ hasText: "7" })).toBeVisible();
  await expect(page.locator(".prompt-field__editor .cm-prompt-variable")).toHaveText("@{bot.name}");
  await expect(page.locator(".prompt-field__editor textarea, .prompt-field__highlight")).toHaveCount(0);

  const splitter = page.getByRole("separator", { name: "调整可用变量宽度" });
  const variableTable = page.getByRole("table", { name: "提示词变量表" });
  const editorCard = page.locator(".prompt-editor__workspace > .prompt-field");
  const variableCard = page.locator(".prompt-editor__variables");
  await expect(splitter).toBeVisible();
  const initialBox = await variableTable.boundingBox();
  expect(initialBox).not.toBeNull();

  const [editorBox, editorContentBox, splitterBox, variableBox] = await Promise.all([
    editorCard.boundingBox(),
    editorCard.locator(".prompt-field__editor").boundingBox(),
    splitter.boundingBox(),
    variableCard.boundingBox()
  ]);
  expect(editorBox).not.toBeNull();
  expect(editorContentBox).not.toBeNull();
  expect(splitterBox).not.toBeNull();
  expect(variableBox).not.toBeNull();
  expect(Math.abs((editorBox!.x + editorBox!.width) - splitterBox!.x)).toBeLessThan(1);
  expect(Math.abs((splitterBox!.x + splitterBox!.width) - variableBox!.x)).toBeLessThan(1);
  expect(splitterBox!.width).toBe(16);
  expect(editorContentBox!.height / editorBox!.height).toBeGreaterThan(0.98);
  const cardStyles = await Promise.all([editorCard, variableCard].map((card) => card.evaluate((element) => ({
    borderWidth: getComputedStyle(element).borderTopWidth,
    borderRadius: getComputedStyle(element).borderRadius
  }))));
  expect(cardStyles).toEqual([
    { borderWidth: "1px", borderRadius: "4px" },
    { borderWidth: "1px", borderRadius: "8px" }
  ]);

  await promptEditor.press("ControlOrMeta+a");
  const selectionStyle = await page.locator(".prompt-field__editor .cm-selectionBackground").first().evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    contentLayers: element.closest(".prompt-field__editor")?.querySelectorAll(".cm-content").length ?? 0,
    legacyLayers: element.closest(".prompt-field__editor")?.querySelectorAll("textarea, .prompt-field__highlight").length ?? 0
  }));
  expect(selectionStyle.background).toContain("215, 25, 33");
  expect(selectionStyle.contentLayers).toBe(1);
  expect(selectionStyle.legacyLayers).toBe(0);
  await promptEditor.press("ArrowLeft");

  await splitter.focus();
  await splitter.press("ArrowLeft");
  const expandedBox = await variableTable.boundingBox();
  expect(expandedBox?.width).toBeGreaterThan(initialBox?.width ?? 0);

  await splitter.dblclick();
  await expect(splitter).toHaveAttribute("aria-valuenow", "336");

  const editor = page.getByLabel("提示词正文");
  await editor.fill(`${Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 行`).join("\n")}\n@{persona.preference}\n@{persona.preference}\n`);
  const scroller = editor.locator("xpath=..");
  await scroller.evaluate((element) => { element.scrollTop = 240; });
  const scrollTop = await scroller.evaluate((element) => element.scrollTop);
  await variableTable.getByRole("button", { name: /persona\.agents/ }).click();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  const referencedVariable = variableTable.getByRole("button", { name: /persona\.preference/ });
  await expect(referencedVariable).toContainText("×2");
  await expect(variableTable).toContainText("已引用 2 / 10");
});

test("最终请求支持消息组、排序、结构测试和 JSON 存储同步", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/system-prompts/conversation.private-reply");

  await expect(page.getByRole("heading", { name: "单聊回复" })).toBeVisible();
  const systemPrompt = page.getByRole("textbox", { name: "system 提示词" });
  await expect(systemPrompt).toBeVisible();
  await expect(page.getByRole("tab", { name: "消息组 2" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "user 消息" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "输出格式" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Function Call" })).toBeVisible();
  await expect(page.getByLabel("完整请求 JSON")).toHaveCount(0);

  await page.getByTitle("插入变量时自动添加 XML 标签").click();
  await systemPrompt.click();
  await systemPrompt.press("ControlOrMeta+ArrowDown");
  await systemPrompt.type("\n@当前用户");
  await page.getByRole("option", { name: /当前用户/ }).click();
  await expect(systemPrompt).toContainText("<user_input>@{user.input}</user_input>");

  await page.getByRole("tab", { name: "消息组 2" }).click();
  await expect(page.getByLabel("消息组变量")).toHaveValue("messages_64");
  await page.getByRole("button", { name: "后移消息 2" }).click();

  await page.getByRole("tab", { name: "user 消息" }).click();
  await expect(page.getByRole("textbox", { name: "user 提示词" })).toBeVisible();

  await page.getByRole("button", { name: "测试 OpenAI 格式" }).click();
  await expect(page.getByText("符合 OpenAI 请求结构", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Function Call" }).click();
  await page.getByLabel("名称").first().fill("workspace_bash_v2");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();

  const saved = state.files.find((file) => file.id === "conversation.private-reply");
  expect(saved).toBeDefined();
  const document = JSON.parse(saved?.content ?? "{}");
  expect(document.messages[0].content).toContain("<user_input>@{user.input}</user_input>");
  expect(document.messages[2]).toBe("@{messages_64}");
  expect(document.tools[0].function.name).toBe("workspace_bash_v2");
  expect(document.response_format).toEqual({ type: "text" });
});

test("最终提示词在不同宽度保持单槽位双栏编辑", async ({ page }) => {
  const state = await installMockApi(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/system-prompts/conversation.private-reply");

  const tablist = page.getByRole("tablist", { name: "最终提示词槽位" });
  const dragHandle = page.locator('[aria-label="拖动消息 2 排序"]');
  const moveButton = page.getByRole("button", { name: "后移消息 1" });
  await expect(tablist).toBeVisible();
  await expect(dragHandle).toBeHidden();
  await expect(moveButton).toBeVisible();
  await expect(page.locator(".prompt-workspace__panel:visible")).toHaveCount(1);
  const variablePanel = page.locator(".prompt-editor__variables");
  await expect(variablePanel).toBeVisible();
  await expect(page.getByRole("separator", { name: "调整可用变量宽度" })).toBeHidden();
  await expect(page.getByRole("button", { name: "变量表", exact: true })).toBeHidden();
  const variableTable = variablePanel;
  const conversationVariable = variableTable.getByRole("button", { name: /conversation\.messages/ });
  await conversationVariable.locator(".variable-context__token").hover();
  await expect(page.getByRole("tooltip")).toContainText("当前消息之前可直接发送给模型的会话消息");
  await page.getByRole("tab", { name: "输出格式" }).click();
  await expect(page.getByRole("tabpanel", { name: "输出格式" })).toBeVisible();

  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect(tablist).toBeVisible();
  await expect(dragHandle).toBeHidden();
  await page.getByRole("tab", { name: "system 消息" }).click();
  await expect(moveButton).toBeVisible();
  const visiblePanels = page.locator(".prompt-workspace__panel:visible");
  await expect(visiblePanels).toHaveCount(1);
  await expect(page.getByText("可用变量", { exact: true })).toBeVisible();
  await expect(page.getByRole("separator", { name: "调整可用变量宽度" })).toBeVisible();
  const systemPrompt = page.getByRole("textbox", { name: "system 提示词" });
  const beforeInsert = `${Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
  await systemPrompt.fill(beforeInsert);
  const systemScroller = systemPrompt.locator("xpath=..");
  await systemScroller.evaluate((element) => { element.scrollTop = 320; });
  const scrollTop = await systemScroller.evaluate((element) => element.scrollTop);
  await variableTable.getByRole("button", { name: /@\{conversation\.messages\}/ }).click();
  await expect.poll(() => systemScroller.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  await systemPrompt.press("ControlOrMeta+ArrowDown");
  await expect(systemPrompt).toContainText("@{conversation.messages}");

  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  const saved = state.files.find((file) => file.id === "conversation.private-reply");
  expect(JSON.parse(saved?.content ?? "{}").messages).toContain("@{messages_64}");
});

test("管理员账号密码建立 HttpOnly 会话且不写入浏览器存储", async ({ page }) => {
  await installMockApi(page, { requiredToken: "session-secret" });

  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "Sunabot", exact: true })).toBeVisible();
  await expect(page.getByText("管理 Agent、QQ 账号、会话与记忆", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
  await expect(page.getByText(/SECURE SESSION|ADMIN ACCESS|HttpOnly|浏览器存储/i)).toHaveCount(0);
  await page.getByLabel("管理员账号").fill("admin");
  await page.getByLabel("管理员密码").fill("session-secret");
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await reloaded;
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeHidden();
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.includes("admin")))).toEqual([]);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes("admin")))).toEqual([]);
});

test("生产构建支持深链接刷新与浏览器返回", async ({ page }) => {
  await installMockApi(page);
  await page.goto("/conversations/group%3A10001");
  await expect(page.getByRole("heading", { name: "产品讨论群" })).toBeVisible();
  await expect(page.getByText("模型目录已更新。", { exact: true })).toBeVisible();
  const messageTrace = page.getByLabel("消息来源与工具");
  await expect(messageTrace).toContainText("来源text");
  await expect(messageTrace.getByText("memory_recall", { exact: true })).toHaveCount(1);
  await expect(messageTrace.getByText("websearch", { exact: true })).toBeVisible();
  await expect(messageTrace.getByRole("button", { name: "查看请求日志" })).toBeVisible();
  await expect(page.getByRole("status", { name: "正在输入" })).toBeVisible();
  await messageTrace.getByRole("button", { name: "查看请求日志" }).click();
  await expect(page.getByRole("heading", { name: "请求日志" })).toBeVisible();
  await expect(page.getByText("开始生成回复", { exact: true })).toBeVisible();
  await expect(page.getByText("reply.started", { exact: true })).toBeVisible();
  const logSearch = page.getByLabel("搜索请求日志");
  await logSearch.fill("alpha");
  const matchedLog = page.getByLabel("请求日志列表").locator("article");
  await expect(matchedLog).toHaveCount(1);
  await expect(matchedLog).toContainText("完整最终提示词 Alpha");
  await logSearch.fill("BETA");
  await expect(matchedLog).toHaveCount(1);
  await expect(matchedLog).toContainText("模型返回正文 Beta");
  await logSearch.fill("没有结果");
  await expect(page.getByText("没有匹配的请求日志", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await page.reload();
  await expect(page.getByRole("heading", { name: "产品讨论群" })).toBeVisible();
  await page.goto("/agent-settings/memory");
  await expect(page.getByRole("heading", { name: "记忆处理" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "产品讨论群" })).toBeVisible();
});

test("每个会话都有独立设置侧栏且 Agent 总开关优先", async ({ page }) => {
  const state = await installMockApi(page);
  state.config.bot.tools.overrides.websearch = { enabled: false };
  await page.goto("/conversations");

  await expect(page.getByRole("button", { name: /^设置 / })).toHaveCount(2);
  await page.getByRole("button", { name: "设置 产品讨论群", exact: true }).click();
  await expect(page).toHaveURL(/\/conversations\/group%3A10001$/);
  const settingsDialog = page.getByRole("dialog", { name: "会话设置" });
  const settingsPanel = page.locator('[data-slot="conversation-side-panel"]');
  await expect(settingsDialog).toBeVisible();
  await expect(settingsPanel).toBeVisible();
  await settingsPanel.getByRole("checkbox", { name: "编排器 自动判断是否参与群聊", exact: true }).uncheck();
  await expect.poll(() => state.conversationReplyRequests.at(-1)).toEqual({
    conversationId: "group:10001",
    replyEnabled: true,
    orchestratorEnabled: false
  });
  await settingsPanel.getByLabel("启动", { exact: true }).uncheck();
  await expect.poll(() => state.conversationReplyRequests.at(-1)).toEqual({
    conversationId: "group:10001",
    replyEnabled: false,
    orchestratorEnabled: false
  });

  await settingsPanel.getByRole("button", { name: "工具权限", exact: true }).click();
  await expect(settingsPanel.getByLabel("启用 网页搜索")).toBeDisabled();
  expect(await settingsPanel.getByText("Agent 已停用", { exact: true }).count()).toBeGreaterThan(0);
  await settingsPanel.getByLabel("启用 读取文件").uncheck();
  await expect.poll(() => state.conversationToolRequests.at(-1)).toEqual({
    conversationId: "group:10001",
    disabledTools: ["read_file"]
  });

  await settingsPanel.getByLabel("启用 读取文件").check();
  await expect.poll(() => state.conversationToolRequests.at(-1)).toEqual({
    conversationId: "group:10001",
    disabledTools: []
  });
  await settingsPanel.getByRole("link", { name: "Agent 总开关", exact: true }).click();
  await expect(page).toHaveURL(/\/agent-settings\/tools/);

  await page.goto("/web-chat");
  await page.getByRole("link", { name: "会话设置", exact: true }).click();
  await expect(page).toHaveURL(/\/conversations\/web%3Aadmin\/settings\/tools/);
  await expect(page.getByRole("button", { name: "回复", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("启用 读取文件")).toBeChecked();

  await page.reload();
  await expect(page.getByRole("heading", { name: "会话设置", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "返回会话", exact: true }).click();
  await expect(page.getByRole("heading", { name: "与普拉娜对话", exact: true })).toBeVisible();
});

test("独立会话设置自动同步并在失败时保留当前输入", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/conversations/group%3A10001/settings/general");
  await expect(page.getByRole("heading", { name: "会话设置", exact: true })).toBeVisible();

  await page.getByLabel("允许回复", { exact: true }).uncheck();
  await page.getByRole("link", { name: "返回会话", exact: true }).click();
  await expect(page).toHaveURL(/\/conversations\/group%3A10001$/);
  await expect.poll(() => state.conversationReplyRequests.at(-1)).toEqual({
    conversationId: "group:10001",
    replyEnabled: false,
    orchestratorEnabled: true,
    orchestratorResponseTimeOverrideEnabled: false,
    orchestratorResponseTimeMs: 60_000
  });
  await expect(page.getByRole("dialog", { name: "放弃未保存的设置？" })).toHaveCount(0);

  await page.goto("/conversations/group%3A10001/settings/tools");
  await expect(page.getByLabel("启用 读取文件")).toBeEnabled();
  state.nextConversationToolError = "工具权限同步失败。";
  await page.getByLabel("启用 读取文件").uncheck();
  await page.getByRole("link", { name: "返回会话", exact: true }).click();

  await expect(page).toHaveURL(/\/conversations\/group%3A10001\/settings\/tools$/);
  await expect(page.getByText("工具权限同步失败。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("启用 读取文件")).not.toBeChecked();
  await expect(page.getByRole("button", { name: /保存|放弃/ })).toHaveCount(0);
});

test("群聊会话开启编排器时间覆盖后可设置独立响应时间", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/conversations/group%3A10001/settings/general");

  const override = page.getByLabel("编排器时间覆盖", { exact: true });
  await expect(override).not.toBeChecked();
  await expect(page.getByLabel("编排器响应时间")).toHaveCount(0);

  await override.check();
  const responseTime = page.getByLabel("编排器响应时间");
  await expect(responseTime).toHaveValue("60");
  await responseTime.fill("15");
  await responseTime.press("Tab");

  await expect.poll(() => state.conversationReplySettings["group:10001"]).toMatchObject({
    orchestratorResponseTimeOverrideEnabled: true,
    orchestratorResponseTimeMs: 15_000
  });
});

test("路由按需加载对应脚本分块", async ({ page }) => {
  await installMockApi(page);
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "状态" })).toBeVisible();

  const lateChunks: string[] = [];
  await page.route("**/assets/*.js", async (route) => {
    lateChunks.push(route.request().url());
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue();
  });

  await page.getByRole("link", { name: "日志", exact: true }).click();
  await expect(page.getByRole("heading", { name: "日志" })).toBeVisible();
  await page.getByRole("link", { name: "图像", exact: true }).click();
  await expect(page.getByRole("heading", { name: "图像" })).toBeVisible();
  expect(lateChunks.some((url) => /\/LogsView-[^/]+\.js$/u.test(url))).toBe(true);
  expect(lateChunks.some((url) => /\/ImagesView-[^/]+\.js$/u.test(url))).toBe(true);
});

test("浅色、深色与系统主题可切换并持久化", async ({ page }) => {
  await installMockApi(page);
  await page.goto("/overview");

  await page.getByRole("button", { name: "深色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sunabot.theme"))).toBe("dark");

  await page.getByRole("button", { name: "浅色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: "系统" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sunabot.theme"))).toBe("system");
});

test("记忆页分页并区分称呼与昵称、显示事件范围和保留称呼编辑", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/memory");

  const sourceTabs = page.getByRole("tablist", { name: "记忆类别" });
  const sortField = page.getByLabel("排序字段");
  await expect(sourceTabs.getByRole("tab")).toHaveCount(4);
  await expect(page.getByRole("tabpanel", { name: "工作记忆" })).toContainText("WebUI 使用 Vue 3、TypeScript 与 Tailwind。");
  await expect(page.getByRole("tabpanel", { name: "工作记忆" })).not.toContainText("sunabot-workmemory:item");
  await page.getByRole("button", { name: "操作日志", exact: true }).click();
  const operationLogDialog = page.getByRole("dialog", { name: "操作日志" });
  await expect(operationLogDialog).toBeVisible();
  await expect(operationLogDialog.getByLabel("记忆操作日志列表").locator("li")).toHaveCount(3);
  await expect(operationLogDialog).toContainText("工作记忆 · 追加");
  await expect(operationLogDialog).toContainText("group:10001 · user_group");
  await expect(operationLogDialog).toContainText("participant_binding_unresolved");
  await operationLogDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(operationLogDialog).toHaveCount(0);
  await expect(sortField).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新增记忆", exact: true })).toHaveCount(0);
  await sourceTabs.getByRole("tab", { name: "梦境", exact: true }).click();
  await expect(sortField).toHaveCount(0);
  await expect(page.getByRole("tabpanel", { name: "梦境" })).toBeVisible();
  await expect(page.getByText(/Asia\/Shanghai/)).toBeVisible();
  await expect(page.getByText(/我沿着潮湿的石阶走进旧车站/)).toBeVisible();
  await expect(page.getByText("合并 2 · 归档 1 · 转存 1", { exact: true })).toBeVisible();
  await expect(page.getByText("已微调", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "立即做梦", exact: true }).click();
  await expect(page.getByText("梦境已完成", { exact: true })).toBeVisible();
  expect(state.dreamTriggers).toBe(1);
  await expect(page.getByText(/我在雨后的图书馆里寻找一页/)).toBeVisible();
  await expect(page.getByLabel("搜索记忆")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "记忆分页" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新增记忆", exact: true })).toHaveCount(0);

  await sourceTabs.getByRole("tab", { name: "工作记忆", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "工作记忆" })).toBeVisible();
  await expect(page.getByLabel("搜索记忆")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "记忆分页" })).toHaveCount(0);
  await expect(sortField).toHaveCount(0);
  const memoryRows = page.getByRole("button", { name: "查看长期记忆详情" });
  await expect(memoryRows).toHaveCount(0);

  await sourceTabs.getByRole("tab", { name: "长期记忆", exact: true }).click();
  const pagination = page.getByRole("navigation", { name: "记忆分页" });
  await expect(pagination).toContainText("21 条 · 1 / 2");
  await expect(memoryRows).toHaveCount(20);
  await sortField.selectOption("lastRecalledAt");
  await expect(page.getByText("召回 4 次 · 跨 3 天", { exact: true })).toBeVisible();
  await expect(page.getByText(/最近召回/)).toBeVisible();
  await pagination.getByRole("button", { name: "下一页" }).click();
  await expect(memoryRows).toHaveCount(1);
  await expect(memoryRows).toContainText("分页测试记忆 20");
  await page.getByRole("button", { name: "当前新到旧，切换为旧到新" }).click();
  await expect(pagination).toContainText("1 / 2");

  await sourceTabs.getByRole("tab", { name: "用户画像", exact: true }).click();
  await sortField.selectOption("createdAt");
  await expect(page.getByRole("navigation", { name: "记忆分页" })).toHaveCount(0);
  const profileRows = page.getByRole("button", { name: "查看用户画像详情" });
  await expect(profileRows).toContainText("猫老师、老师");
  await expect(profileRows).toContainText("猫老师原昵称");

  const filter = page.getByLabel("搜索记忆");
  await filter.fill("猫老师");
  const profileRow = page.getByRole("button", { name: "查看用户画像详情" }).filter({ hasText: "猫老师、老师" });
  await expect(profileRow).toBeVisible();
  await expect(profileRows).toHaveCount(1);

  await profileRow.click();
  const profileInspector = page.getByRole("complementary", { name: "记忆详情", exact: true }).filter({ visible: true });
  await expect(profileInspector).toContainText("猫老师");
  await expect(profileInspector).toContainText("10001");
  await profileInspector.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByLabel("称呼")).toHaveValue("猫老师、老师");
  await page.getByLabel("正文").fill("正文已经更新。");
  await page.getByRole("button", { name: "保存更改", exact: true }).click();

  await expect.poll(() => state.memoryWrites.length).toBe(1);
  expect(state.memoryWrites[0]).toMatchObject({
    method: "PUT",
    body: {
      source: "user_profile",
      id: "profile-1",
      text: "正文已经更新。",
      addressNames: ["猫老师", "老师"]
    }
  });
});

test("记忆移动详情切换到桌面布局时释放模态门禁", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMockApi(page);
  await page.goto("/memory");
  await page.getByRole("tab", { name: "长期记忆", exact: true }).click();
  await page.getByRole("button", { name: "查看长期记忆详情" }).first().click();

  const mobileInspector = page.getByRole("dialog", { name: "移动记忆详情" });
  await expect(mobileInspector).toBeVisible();
  await expect(page.locator("#app")).toHaveAttribute("inert", "");

  await page.setViewportSize({ width: 1440, height: 900 });

  await expect(mobileInspector).toHaveCount(0);
  await expect(page.locator("#app")).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("complementary", { name: "记忆详情", exact: true })).toBeVisible();
});

test("移动端主题入口、触控目标与键盘焦点可用", async ({ page }) => {
  await installMockApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/overview");

  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    const style = element ? getComputedStyle(element) : null;
    return {
      tag: element?.tagName ?? "",
      outlineStyle: style?.outlineStyle ?? "none",
      outlineWidth: Number.parseFloat(style?.outlineWidth ?? "0")
    };
  });
  expect(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]).toContain(focus.tag);
  expect(focus.outlineStyle).not.toBe("none");
  expect(focus.outlineWidth).toBeGreaterThanOrEqual(2);

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await expect(page.getByRole("button", { name: "浅色" })).toBeVisible();
  await page.getByRole("button", { name: "深色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const undersizedTargets = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")]
    .filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { label: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName, width: rect.width, height: rect.height };
    })
    .filter(({ width, height }) => width < 43.5 || height < 43.5));
  expect(undersizedTargets).toEqual([]);
});

test("平板宽度使用单工作区并保留完整导航", async ({ page }) => {
  await installMockApi(page);
  await page.setViewportSize({ width: 768, height: 1024 });

  await page.goto("/conversations/group%3A10001");
  await expect(page.getByRole("button", { name: "返回会话列表" })).toBeVisible();
  await expect(page.getByLabel("搜索会话")).toBeHidden();
  await expect(page.getByRole("button", { name: "更多", exact: true })).toBeVisible();

  await page.goto("/agent-prompts/persona.soul");
  await expect(page.getByRole("button", { name: "返回文件列表" })).toBeVisible();
  await expect(page.getByLabel("提示词正文")).toBeVisible();
  await expect(page.getByLabel("搜索文件")).toBeHidden();

  await page.goto("/settings/providers");
  await expect(page.locator("label").filter({ hasText: "设置分区" }).getByRole("combobox")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "设置分区" })).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("弹层约束焦点、支持 Escape 并恢复触发位置", async ({ page }) => {
  await installMockApi(page);
  await page.goto("/overview");

  const trigger = page.getByRole("button", { name: "诊断", exact: true });
  await trigger.focus();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "诊断" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#app")).toHaveAttribute("inert", "");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#app")).not.toHaveAttribute("inert", "");
  await expect(trigger).toBeFocused();
});

test("设置按字段确认、离开时刷新队列并在失败时保留输入", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/agent-settings/persona");
  await page.getByLabel("管理员称呼").fill("新的管理员称呼");
  await page.locator('[data-confirm-label="确认管理员称呼"]').click();

  await page.getByRole("link", { name: "状态", exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect.poll(() => state.config.bot.adminName).toBe("新的管理员称呼");
  await expect(page.getByRole("dialog", { name: "放弃未保存的设置？" })).toHaveCount(0);

  await page.goto("/agent-settings/persona");
  await expect(page.getByLabel("管理员称呼")).toHaveValue("新的管理员称呼");
  state.nextPatchError = "管理员称呼保存失败。";
  await page.getByLabel("管理员称呼").fill("保存失败时保留");
  await page.locator('[data-confirm-label="确认管理员称呼"]').click();
  await page.getByRole("link", { name: "状态", exact: true }).click();
  await expect(page).toHaveURL(/\/agent-settings\/persona$/);
  await expect(page.getByText("管理员称呼保存失败。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("管理员称呼")).toHaveValue("保存失败时保留");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
});

test("图像页提供自拍参考图、历史、预览、下载和可见错误", async ({ page }) => {
  const requests: string[] = [];
  const placeholderRequests: string[] = [];
  page.on("request", (request) => {
    requests.push(new URL(request.url()).pathname);
    if (request.url().includes("variant=placeholder")) placeholderRequests.push(request.url());
  });
  const state = await installMockApi(page);
  await page.goto("/images");

  await expect(page.getByRole("heading", { name: "生成历史" })).toBeVisible();
  await expect(page.getByLabel("Prompt")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "生成图像" })).toHaveCount(0);
  await expect(page.getByText("[NO IMAGE]", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "复用参数" })).toHaveCount(0);
  expect(requests).toContain("/api/images");
  expect(requests).not.toContain("/api/config");
  expect(requests).not.toContain("/api/playground/image");
  await expect(page.locator('.authenticated-image[data-state="ready"]').first()).toBeVisible();
  const placeholderCount = placeholderRequests.filter((url) => url.includes("image-1.png")).length;
  const historyRequestsBeforeOverview = requests.filter((pathname) => pathname === "/api/images").length;
  await page.getByRole("link", { name: "状态", exact: true }).click();
  await expect(page.getByRole("heading", { name: "运行状态" })).toBeVisible();
  const historyRequestsAfterOverview = requests.filter((pathname) => pathname === "/api/images").length;
  expect(historyRequestsAfterOverview).toBe(historyRequestsBeforeOverview);
  await page.getByRole("link", { name: "图像", exact: true }).click();
  await expect(page.getByRole("heading", { name: "生成历史" })).toBeVisible();
  expect(requests.filter((pathname) => pathname === "/api/images")).toHaveLength(historyRequestsAfterOverview);
  expect(placeholderRequests.filter((url) => url.includes("image-1.png"))).toHaveLength(placeholderCount);

  await page.getByRole("button", { name: "预览 月球基地的清晨" }).click();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible();
  await expect(page.getByRole("button", { name: "复用参数" })).toHaveCount(0);
  await page.getByRole("button", { name: "关闭预览" }).click();

  const downloadStarted = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载图片 image-1" }).click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toBe("image-1.png");
  await expect(page.getByText("已下载", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeHidden();

  state.imageHistoryError = "历史加载失败";
  await page.getByRole("button", { name: "刷新历史" }).click();
  await expect(page.getByText("历史加载失败", { exact: true })).toBeVisible();
});
