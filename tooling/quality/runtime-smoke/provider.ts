import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { boundedTimeout, isolateRuntimeEnvironment } from "./shared.js";
import type { SmokeContext } from "./types.js";

export async function runProviderSmoke(context: SmokeContext) {
  isolateRuntimeEnvironment(context);
  const [{ loadConfig, getDefaultProvider }, { OpenAIProvider }] = await Promise.all([
    import("../../../src/config.js"),
    import("../../../adapters/model/openaiProvider.js")
  ]);
  const loaded = await loadConfig();
  const selected = getDefaultProvider(loaded);
  if (!selected || selected.id !== context.provider.id) {
    throw new Error("运行时选择的 Provider 与隔离预检结果不一致。");
  }

  const marker = `sunabot-smoke-${new Date().toISOString()}-${nanoid(8)}`;
  const timeoutMs = boundedTimeout("SUNABOT_SMOKE_PROVIDER_TIMEOUT_MS", 120_000, 5_000, 300_000);
  const reply = await new OpenAIProvider(selected).complete(
    "你正在执行连接冒烟检查。请简短回复，且不要调用任何工具。",
    [{ role: "user", content: `请回复一段非空文本，检查标记：${marker}` }],
    { signal: AbortSignal.timeout(timeoutMs) }
  );
  const text = assertNonEmptyProviderReply(reply);
  return {
    model: selected.model,
    length: [...text].length,
    digest: crypto.createHash("sha256").update(text).digest("hex").slice(0, 12)
  };
}

export function assertNonEmptyProviderReply(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("模型返回内容为空。");
  return value.trim();
}
