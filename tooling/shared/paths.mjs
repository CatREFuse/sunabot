import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveProjectRoot(metaUrl) {
  let current = path.dirname(fileURLToPath(metaUrl));
  while (true) {
    if (existsSync(path.join(current, "package.json")) && existsSync(path.join(current, "AGENTS.md"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("无法从脚本位置解析 sunabot 项目根目录。");
    current = parent;
  }
}

export function resolveWorkspace(projectRoot, options = {}) {
  const configured = process.env.SUNABOT_WORKSPACE?.trim();
  if (!configured) {
    if (options.requireExplicit) {
      throw new Error("生产运行必须显式设置 SUNABOT_WORKSPACE。");
    }
    return path.join(projectRoot, "workspace");
  }
  return path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.resolve(projectRoot, configured);
}

