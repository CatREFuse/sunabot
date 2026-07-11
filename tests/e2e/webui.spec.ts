import { expect, test } from "@playwright/test";
import { installMockApi, modelCatalog } from "./mock-api";

test("模型下拉目录、推理强度联动与分区保存", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/settings/providers");

  await expect(page.getByRole("heading", { name: "模型服务" })).toBeVisible();
  const modelSelect = page.getByLabel("模型").first();
  await expect(modelSelect).toBeVisible();
  await expect(modelSelect.locator("option")).toHaveText([
    ...modelCatalog.map((model) => model.label),
    "自定义"
  ]);

  await page.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByText("[CONNECTED · gpt-5.6-sol · 128MS]", { exact: true })).toBeVisible();
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
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await expect.poll(() => state.patchRequests.length).toBe(1);
  expect(state.patchRequests[0]?.section).toBe("providers");
  expect(state.config.providers.items[0]).toMatchObject({
    label: "Codex Primary",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra"
  });
  await expect(page.getByText("[SAVED]", { exact: true })).toBeVisible();

  await page.goto("/settings/tools");
  const codexModelSelect = page.getByLabel("模型");
  await expect(codexModelSelect.locator("option")).toHaveText(modelCatalog.map((model) => model.label));
  await expect(page.getByLabel("可执行文件")).toHaveValue("auto");
  await expect(page.getByLabel("启用 Codex")).toBeChecked();
  await expect(page.getByLabel("默认质量")).toHaveValue("high");
  await codexModelSelect.selectOption("gpt-5.5");
  await page.getByLabel("默认质量").selectOption("auto");
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await expect.poll(() => state.patchRequests.length).toBe(2);
  expect(state.patchRequests[1]?.section).toBe("tools");
  expect(state.config.bot.tools.codex.model).toBe("gpt-5.5");
  expect(state.config.bot.tools.generateImg.quality).toBe("auto");

  await page.getByRole("button", { name: "添加 Key" }).click();
  await page.getByLabel("Tavily API Key 1").fill("tvly-e2e-secret-1234567890");
  await expect(page.getByLabel("Tavily Key 环境变量")).toHaveValue("TAVILY_API_KEY");
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await expect.poll(() => state.patchRequests.length).toBe(3);
  expect(state.config.bot.tools.websearch.tavilyApiKeys).toEqual(["tvly-e2e-secret-1234567890"]);
  await expect(page.getByLabel("Tavily API Key 1")).toHaveCount(0);
  await expect(page.getByText("1 个已保存", { exact: true })).toBeVisible();
  await expect(page.locator(".key-pool__identity").getByText("[SAVED]", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "添加 Key" }).click();
  await page.getByLabel("Tavily API Key 1").fill("tvly-e2e-secret-2-1234567890");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => state.patchRequests.length).toBe(4);
  expect(state.config.bot.tools.websearch.tavilyApiKeys).toHaveLength(2);

  await page.getByRole("button", { name: "删除 Key 1" }).click();
  await expect(page.getByText("[PENDING DELETE]", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => state.patchRequests.length).toBe(5);
  expect(state.config.bot.tools.websearch.tavilyApiKeys).toEqual(["tvly-e2e-secret-2-1234567890"]);
});

test("提示词库列出全部文件并支持快捷保存与冲突恢复", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/prompts/persona.soul");

  await expect(page.getByRole("heading", { name: "核心人格" })).toBeVisible();
  const fileList = page.locator("aside").filter({ has: page.getByLabel("搜索文件") });
  await expect(fileList.getByRole("button")).toHaveCount(12);
  const editor = page.getByLabel("提示词正文");
  await expect(editor).toHaveValue(/冷静、诚实、可靠/);

  await editor.fill("清醒、可靠、坦诚。\n");
  await editor.press("Control+s");
  await expect.poll(() => state.fileWrites.length).toBe(1);
  await expect(page.getByText("[SAVED]", { exact: true })).toBeVisible();

  const serverFile = state.files.find((file) => file.id === "persona.soul");
  expect(serverFile).toBeDefined();
  if (!serverFile) return;
  serverFile.revision = "persona.soul-server-r2";
  await editor.fill("保留本地版本。\n");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("[CONFLICT · SERVER VERSION CHANGED]", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "保留本地内容" }).click();
  await expect(editor).toHaveValue("保留本地版本。\n");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => state.fileWrites.length).toBe(3);
  await expect(page.getByText("[SAVED]", { exact: true })).toBeVisible();

  await editor.fill("尚未保存。\n");
  await page.getByRole("link", { name: "设置" }).click();
  await expect(page.getByRole("heading", { name: "放弃未保存的修改？" })).toBeVisible();
  await page.getByRole("button", { name: "继续编辑" }).click();
  await expect(page).toHaveURL(/\/prompts\/persona\.soul$/);
});

test("最终请求支持消息组、排序、结构测试和 JSON 存储同步", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/prompts/conversation.reply");

  await expect(page.getByRole("heading", { name: "对话回复" })).toBeVisible();
  const systemPrompt = page.getByRole("textbox", { name: "system 提示词" });
  await expect(systemPrompt).toBeVisible();
  await expect(page.getByRole("tab", { name: "消息组 2" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "user 消息" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "输出格式" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Function Call" })).toBeVisible();
  await expect(page.getByLabel("完整请求 JSON")).toHaveCount(0);

  await systemPrompt.click();
  await systemPrompt.press("Control+End");
  await systemPrompt.type("\n@当前用户");
  await page.getByRole("option", { name: /当前用户/ }).click();
  await expect(systemPrompt).toHaveValue(/@\{user\.input\}/);

  await page.getByRole("tab", { name: "消息组 2" }).click();
  await expect(page.getByLabel("消息组变量")).toHaveValue("messages_64");
  await page.getByRole("button", { name: "后移消息 2" }).click();

  await page.getByRole("tab", { name: "user 消息" }).click();
  await expect(page.getByRole("textbox", { name: "user 提示词" })).toBeVisible();
  await expect(
    page.getByRole("tabpanel", { name: "user 消息" }).getByText("@{user.input}", { exact: true })
  ).toBeVisible();

  await page.getByRole("button", { name: "测试 OpenAI 格式" }).click();
  await expect(page.getByText("[VALID] 符合 OpenAI 请求结构", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Function Call" }).click();
  await page.getByLabel("名称").first().fill("workspace_bash_v2");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("[SAVED]", { exact: true })).toBeVisible();

  const saved = state.files.find((file) => file.id === "conversation.reply");
  expect(saved).toBeDefined();
  const document = JSON.parse(saved?.content ?? "{}");
  expect(document.messages[0].content).toContain("@{user.input}");
  expect(document.messages[2]).toBe("@{messages_64}");
  expect(document.tools[0].function.name).toBe("workspace_bash_v2");
  expect(document.response_format).toEqual({ type: "text" });
});

test("最终提示词槽位在窄窗口使用 Tab、宽窗口纵向并列", async ({ page }) => {
  const state = await installMockApi(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/prompts/conversation.reply");

  const tablist = page.getByRole("tablist", { name: "最终提示词槽位" });
  const dragHandle = page.locator('[aria-label="拖动消息 2 排序"]');
  const moveButton = page.getByRole("button", { name: "后移消息 1" });
  await expect(tablist).toBeVisible();
  await expect(dragHandle).toBeHidden();
  await expect(moveButton).toBeVisible();
  await expect(page.locator(".prompt-workspace__panel:visible")).toHaveCount(1);
  await page.getByRole("tab", { name: "输出格式" }).click();
  await expect(page.getByRole("tabpanel", { name: "输出格式" })).toBeVisible();

  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect(tablist).toBeHidden();
  await expect(dragHandle).toBeVisible();
  await expect(moveButton).toBeHidden();
  const visiblePanels = page.locator(".prompt-workspace__panel:visible");
  await expect(visiblePanels).toHaveCount(5);
  const layout = await visiblePanels.evaluateAll((panels) => panels.map((panel) => {
    const rect = panel.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), height: Math.round(rect.height), scrolls: panel.scrollHeight > panel.clientHeight };
  }));
  expect(new Set(layout.map((panel) => panel.x)).size).toBe(5);
  expect(new Set(layout.map((panel) => panel.y)).size).toBe(1);
  expect(layout.every((panel) => panel.height > 700)).toBe(true);
  expect(layout.some((panel) => panel.scrolls)).toBe(true);

  await dragHandle.dragTo(page.getByRole("tabpanel", { name: "user 消息" }));
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("[SAVED]", { exact: true })).toBeVisible();
  const saved = state.files.find((file) => file.id === "conversation.reply");
  expect(JSON.parse(saved?.content ?? "{}").messages[2]).toBe("@{messages_64}");
});

test("管理员账号密码建立 HttpOnly 会话且不写入浏览器存储", async ({ page }) => {
  await installMockApi(page, { requiredToken: "session-secret" });

  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
  await page.getByLabel("管理员账号").fill("admin");
  await page.getByLabel("管理员密码").fill("session-secret");
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "登录" }).click();
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
  await expect(page.getByRole("status", { name: "正在输入" })).toBeVisible();
  await page.getByRole("button", { name: "查看请求日志" }).last().click();
  await expect(page.getByRole("heading", { name: "请求日志" })).toBeVisible();
  await expect(page.getByText("runtime.action · reply.started", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await page.reload();
  await expect(page.getByRole("heading", { name: "产品讨论群" })).toBeVisible();
  await page.goto("/settings/memory");
  await expect(page.getByRole("heading", { name: "记忆处理" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "产品讨论群" })).toBeVisible();
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

test("记忆页区分称呼与昵称、显示事件范围并保留称呼编辑", async ({ page }) => {
  const state = await installMockApi(page);
  await page.goto("/memory");

  const sourceTabs = page.getByRole("navigation", { name: "记忆类别" });
  await expect(sourceTabs.getByRole("button")).toHaveText(["全部", "工作记忆", "长期记忆", "用户画像"]);
  await expect(page.getByText("称呼 猫老师", { exact: true })).toBeVisible();
  await expect(page.getByText("QQ 昵称 猫老师原昵称", { exact: true })).toBeVisible();
  await expect(page.getByText("群名片 猫老师 · 群 10001", { exact: true })).toBeVisible();
  await expect(page.getByText(/发生 .* 至 .*/)).toBeVisible();

  const filter = page.getByLabel("筛选记忆");
  await filter.fill("猫老师");
  const profileRow = page.locator("article").filter({ hasText: "称呼 猫老师" });
  await expect(profileRow).toBeVisible();
  await expect(page.locator("article")).toHaveCount(1);

  await profileRow.getByRole("button", { name: "编辑记忆" }).click();
  await expect(page.getByLabel("称呼")).toHaveValue("猫老师");
  await page.getByLabel("正文").fill("正文已经更新。");
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await expect.poll(() => state.memoryWrites.length).toBe(1);
  expect(state.memoryWrites[0]).toMatchObject({
    method: "PUT",
    body: {
      source: "user_profile",
      id: "profile-1",
      text: "正文已经更新。",
      userId: "20002",
      addressName: "猫老师"
    }
  });
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

  await page.goto("/prompts/persona.soul");
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

test("设置离开确认沿用应用弹层并可继续编辑", async ({ page }) => {
  await installMockApi(page);
  await page.goto("/settings/bot");
  await page.getByLabel("管理员称呼").fill("新的管理员称呼");

  await page.getByRole("link", { name: "状态", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "放弃未保存的设置？" });
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: "继续编辑" }).click();
  await expect(page).toHaveURL(/\/settings\/bot$/);
  await expect(page.getByLabel("管理员称呼")).toHaveValue("新的管理员称呼");

  await page.getByRole("link", { name: "状态", exact: true }).click();
  await page.getByRole("button", { name: "放弃并离开" }).click();
  await expect(page).toHaveURL(/\/overview$/);
});

test("图像页只保留历史、预览、下载和可见错误", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
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

  await page.getByRole("button", { name: "预览 月球基地的清晨" }).click();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible();
  await expect(page.getByRole("button", { name: "复用参数" })).toHaveCount(0);
  await page.getByRole("button", { name: "关闭预览" }).click();

  const downloadStarted = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载图片 image-1" }).click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toBe("image-1.png");
  await expect(page.getByText("[DOWNLOADED]", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeHidden();

  state.imageHistoryError = "历史加载失败";
  await page.getByRole("button", { name: "刷新历史" }).click();
  await expect(page.getByText("[ERROR: 历史加载失败]", { exact: true })).toBeVisible();
});
