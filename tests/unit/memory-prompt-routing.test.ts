// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SunaRuntime } from "../../src/runtime.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const workspaceDir = path.join(process.cwd(), "workspace/agents/plana");
const runtime = new SunaRuntime(createAdminTestConfig("/tmp/sunabot-memory-prompt-test"), {
  attachmentService: {} as never
});

const promptFiles = [
  ["memory.compress-in", "work_memory_compress_in.json"],
  ["memory.compress-out", "work_memory_compress_out.json"],
  ["memory.user-profile", "user_profile_prompt.json"]
] as const;

describe("memory prompt routing contract", () => {
  it.each(promptFiles)("keeps %s aligned with %s", async (id, fileName) => {
    const workspacePrompt = await fs.readFile(path.join(workspaceDir, fileName), "utf8");
    expect(JSON.parse(workspacePrompt)).toEqual(JSON.parse(runtime.defaultPromptContent(id)));
  });

  it("routes timeline events to working and long-term memory", async () => {
    const compressIn = await readPrompt("work_memory_compress_in.json");
    const compressOut = await readPrompt("work_memory_compress_out.json");

    expect(compressIn).toContain("工作记忆只记录发生过或正在发生的事件");
    expect(compressIn).toContain("即使稳定也不得写入工作记忆");
    expect(compressOut).toContain("长期记忆只记录发生了什么");
    expect(compressOut).toContain("纯用户属性记录必须丢弃");
  });

  it("routes every durable person attribute to the user profile", async () => {
    const userProfile = await readPrompt("user_profile_prompt.json");

    expect(userProfile).toContain("所有与人本身有关的属性都归入用户画像");
    expect(userProfile).toContain("userName 只保存 payload 中当前观测到的 QQ 昵称或显示名");
    expect(userProfile).toContain("addressName 只保存普拉娜回复该用户时使用的明确称呼");
    expect(userProfile).toContain("不要保留一次性事件的过程和结果");
  });
});

async function readPrompt(fileName: string) {
  const document = JSON.parse(await fs.readFile(path.join(workspaceDir, fileName), "utf8"));
  return document.messages.find((message: { role?: string }) => message.role === "system")?.content ?? "";
}
