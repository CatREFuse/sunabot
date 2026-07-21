import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveProjectPath } from "../../src/config.js";
import type { AppConfig } from "../../src/types.js";
import { DIRECTOR_SEED_FILE } from "./types.js";

export const DEFAULT_DIRECTOR_SEED = [
  "# 日常导演种子剧本",
  "",
  "## 连续性",
  "保持角色已经定义的身份、关系、职责和世界观，不改写核心设定。",
  "",
  "## 日常舞台",
  "角色每天会处理自己的学习、工作、休息和社交安排，并保留合理的空白时间。",
  "",
  "## 关联人物",
  "只使用角色设定中已经存在的人物；缺少资料时安排独处活动。",
  "",
  "## 日常菜单",
  "整理资料、处理职责、短暂休息、吃饭、散步、阅读、与熟人交流。",
  "",
  "## 循环",
  "工作日保持稳定节奏，周末增加休息与兴趣活动；偶发变化只能轻微调整当天安排。",
  "",
  "## 分享边界",
  "每天选择一至三件自然的小事分享，分享必须与当天已安排的活动一致，并附带一张符合现场的自拍。",
  ""
].join("\n");

export async function readDirectorSeed(config: AppConfig) {
  const workspace = resolveProjectPath(config.persona.agentWorkspace);
  if (!workspace) return DEFAULT_DIRECTOR_SEED;
  try {
    const content = await fs.readFile(path.join(workspace, DIRECTOR_SEED_FILE), "utf8");
    const normalized = content.trim();
    return normalized || DEFAULT_DIRECTOR_SEED;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_DIRECTOR_SEED;
    throw error;
  }
}

export function directorSeedHash(seed: string) {
  return createHash("sha256").update(seed, "utf8").digest("hex");
}
