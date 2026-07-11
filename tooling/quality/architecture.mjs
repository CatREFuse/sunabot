import fs from "node:fs";
import path from "node:path";
import { resolveProjectRoot } from "../shared/paths.mjs";

const root = resolveProjectRoot(import.meta.url);
const failures = [];

const requiredDirectories = [
  "apps/api",
  "apps/admin-web",
  "services/messaging",
  "services/conversations",
  "services/sessions",
  "services/reply",
  "services/orchestration",
  "services/memory",
  "services/media",
  "services/tools",
  "services/delivery",
  "services/agent",
  "adapters/onebot",
  "adapters/model",
  "adapters/codex",
  "adapters/sqlite",
  "adapters/filesystem",
  "packages/contracts",
  "packages/platform",
  "packages/testkit",
  "components",
  "deploy/docker",
  "deploy/native",
  "tooling/quality",
  "tests"
];

for (const relative of requiredDirectories) {
  if (!fs.existsSync(path.join(root, relative))) failures.push(`missing required directory: ${relative}`);
}

for (const obsolete of ["scripts", "web", "components/qq-runtime"]) {
  if (fs.existsSync(path.join(root, obsolete))) failures.push(`obsolete root remains: ${obsolete}`);
}

const lineBudgets = new Map([
  ["src/runtime.ts", 4_800],
  ["services/memory/memoryService.ts", 1_800],
  ["adapters/model/openaiProvider.ts", 1_650],
  ["apps/api/server.ts", 1_100]
]);
for (const [relative, maximum] of lineBudgets) {
  const lines = fs.readFileSync(path.join(root, relative), "utf8").split(/\r?\n/).length;
  if (lines > maximum) failures.push(`${relative} has ${lines} lines; debt ceiling is ${maximum}`);
}

for (const relative of walkFiles(root, ["src", "apps", "services", "adapters", "packages", "deploy", "tooling"])) {
  if (!/\.(?:ts|js|mjs|cjs|sh|ps1)$/.test(relative)) continue;
  const text = fs.readFileSync(path.join(root, relative), "utf8");
  if (/process\.cwd\s*\(/.test(text) && relative !== "tooling/quality/architecture.mjs") {
    failures.push(`${relative} derives paths from process.cwd()`);
  }
  if (relative.startsWith("services/") && /from\s+["'](?:\.\.\/)+adapters\//.test(text)) {
    failures.push(`${relative} imports an adapter; depend on a port instead`);
  }
}

const runtimeContract = JSON.parse(fs.readFileSync(path.join(root, "deploy/runtime-contract.json"), "utf8"));
if (runtimeContract.schemaVersion !== 1) failures.push("deploy/runtime-contract.json must declare schemaVersion 1");

if (failures.length) {
  console.error("Architecture gate failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("Architecture gate passed.");
}

function walkFiles(projectRoot, roots) {
  const output = [];
  for (const relativeRoot of roots) visit(relativeRoot);
  return output;

  function visit(relative) {
    const absolute = path.join(projectRoot, relative);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name).replaceAll("\\", "/");
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) output.push(child);
    }
  }
}
