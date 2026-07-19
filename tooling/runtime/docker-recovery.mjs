import process from "node:process";
import { createInterface } from "node:readline/promises";

const DOCKER_READY_TIMEOUT_MS = 60_000;
const DOCKER_READY_POLL_MS = 500;
const MISSING_DOCKER_OBJECT = /no such (?:container|object)\b/i;
const GENERIC_DOCKER_UNAVAILABLE_MESSAGE = "Docker Engine 不可用；请启动 Docker Desktop 或 Docker Engine。";

export async function resolveDockerUnavailableMessage(options) {
  try {
    const dockerContext = (await options.runCommand(
      "docker",
      ["context", "show"],
      { capture: true }
    )).trim();
    if (dockerContext === "colima") {
      return "Colima Docker Engine 未运行；请执行 colima start，等待终端显示 READY 后，再重新执行刚才的 Sunabot 命令。";
    }
  } catch {
    // Keep the generic guidance when the Docker CLI or its context is unavailable.
  }
  return GENERIC_DOCKER_UNAVAILABLE_MESSAGE;
}

export async function recoverStaleDockerOneoffs(options) {
  const staleContainerIds = await findStaleDockerOneoffs(options);
  if (staleContainerIds.length === 0) {
    return { repaired: false, staleContainerIds };
  }

  const dockerContext = (await options.runCommand(
    "docker",
    ["context", "show"],
    { capture: true }
  )).trim();
  const detail = staleContainerIds.join(", ");
  if ((options.platform ?? process.platform) !== "darwin" || dockerContext !== "colima") {
    throw new Error(
      `检测到 Docker 悬空的 Sunabot 探针容器：${detail}。请重启当前 Docker Engine 后重试。`
    );
  }
  if (!(options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY))) {
    throw new Error(
      `检测到 Docker 悬空的 Sunabot 探针容器：${detail}。当前命令没有交互终端，未自动重启 Colima；请执行 colima restart 后重试。`
    );
  }

  await options.runCommand("colima", ["status"], { capture: true });
  const confirm = options.confirm ?? confirmColimaRestart;
  const accepted = await confirm(
    `检测到 Docker 悬空的 Sunabot 探针容器（${detail}）。修复需要重启 Colima，会短暂中断其他 Docker 容器，它们将按各自的重启策略恢复。继续？[y/N] `
  );
  if (!accepted) {
    throw new Error("已取消 Colima 重启，Docker 悬空状态未处理。");
  }

  await options.runCommand("colima", ["restart"]);
  await waitForDocker(options);
  const remaining = await findStaleDockerOneoffs(options);
  if (remaining.length > 0) {
    throw new Error(`Colima 重启后仍存在 Docker 悬空记录：${remaining.join(", ")}。`);
  }
  (options.log ?? console.log)("Colima 已重启，Docker 悬空状态已清理。");
  return { repaired: true, staleContainerIds };
}

async function findStaleDockerOneoffs(options) {
  const output = await options.runCommand("docker", [
    "ps", "-a",
    "--filter", `label=io.sunabot.workspace-id=${options.identity}`,
    "--filter", "label=io.sunabot.component=napcat",
    "--filter", "label=com.docker.compose.oneoff=true",
    "--format", [
      "{{.ID}}",
      '{{.Label "io.sunabot.component"}}',
      "{{.State}}",
      '{{.Label "com.docker.compose.oneoff"}}'
    ].join("\t")
  ], { capture: true });
  const candidates = output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, component, state, oneoff] = line.split("\t");
    return { id, component, state, oneoff };
  }).filter((item) => item.id && item.component === "napcat" && item.oneoff?.toLowerCase() === "true");

  const stale = [];
  for (const candidate of candidates) {
    try {
      await options.runCommand(
        "docker",
        ["inspect", "--format", "{{.Id}}", candidate.id],
        { capture: true }
      );
    } catch (error) {
      if (!MISSING_DOCKER_OBJECT.test(message(error))) throw error;
      stale.push(candidate.id);
    }
  }
  return stale;
}

async function waitForDocker(options) {
  const delay = options.delay ?? wait;
  const deadline = Date.now() + (options.timeoutMs ?? DOCKER_READY_TIMEOUT_MS);
  let lastError;
  while (Date.now() < deadline) {
    try {
      await options.runCommand(
        "docker",
        ["info", "--format", "{{.ServerVersion}}"],
        { capture: true }
      );
      return;
    } catch (error) {
      lastError = error;
      await delay(DOCKER_READY_POLL_MS);
    }
  }
  throw new Error(`Colima 重启后 Docker Engine 未就绪：${message(lastError)}`);
}

async function confirmColimaRestart(prompt) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(prompt)).trim().toLowerCase();
    return ["y", "yes", "是", "确认", "继续"].includes(answer);
  } finally {
    readline.close();
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
