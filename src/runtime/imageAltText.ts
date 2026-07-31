import type { ReasoningEffort } from "../../packages/contracts/admin/public.js";
import type { InboundMessageV1 } from "../../packages/contracts/messaging/messages.js";
import type { OpenAIProvider, ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import { auxiliaryProviderCompleteOptions } from "./auxiliaryModelBudget.js";

const IMAGE_ALT_SYSTEM_PROMPT = [
  "你负责把图片转换成一条简洁、准确的中文替代文本。",
  "只描述看得见的主体、动作、场景、重要物品和清晰可辨的文字，不猜测身份或不可见信息。",
  "只输出一句话，以“一张”开头，不使用 Markdown，不超过 160 个汉字。"
].join("");

interface ImageAltTextRuntime {
  readonly config: {
    bot: {
      imageReader: {
        enabled: boolean;
        providerId: string;
        model: string;
        reasoningEffort?: ReasoningEffort;
      };
    };
  };
  getProviderForModel(
    model: string,
    requestedEffort?: ReasoningEffort,
    providerId?: string
  ): OpenAIProvider;
}

export async function populateInboundImageAltTexts(
  runtime: ImageAltTextRuntime,
  incoming: InboundMessageV1,
  options: ProviderCompleteOptions = {}
) {
  const settings = runtime.config.bot.imageReader;
  if (!settings.enabled) return;
  const targets = collectTargets(incoming).slice(0, 4);
  if (!targets.length) return;

  const provider = runtime.getProviderForModel(
    settings.model,
    settings.reasoningEffort,
    settings.providerId
  );
  const completionOptions = auxiliaryProviderCompleteOptions(options);
  for (const target of targets) {
    try {
      completionOptions.signal?.throwIfAborted();
      const result = await provider.complete(
        IMAGE_ALT_SYSTEM_PROMPT,
        [{
          role: "user",
          content: "请生成这张图片的替代文本。",
          imageUrls: [target.url]
        }],
        completionOptions
      );
      completionOptions.signal?.throwIfAborted();
      const altText = normalizeImageAltText(result);
      target.assets.forEach((asset) => {
        asset.altText = altText;
      });
    } catch (error) {
      if (completionOptions.signal?.aborted) {
        throw completionOptions.signal.reason ?? error;
      }
      console.error("[runtime] image alt text failed", { error });
    }
  }
}

function collectTargets(incoming: InboundMessageV1) {
  const byUrl = new Map<string, Array<InboundMessageV1["media"][number]>>();
  for (const asset of [
    ...incoming.media,
    ...incoming.quoteReferences.flatMap((quote) => quote.media ?? [])
  ]) {
    const url = asset.url?.trim();
    if (!url || asset.altText) continue;
    const assets = byUrl.get(url) ?? [];
    assets.push(asset);
    byUrl.set(url, assets);
  }
  return [...byUrl].map(([url, assets]) => ({ url, assets }));
}

export function normalizeImageAltText(value: string) {
  const text = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 160)
    .trim();
  if (!text) return "一张无法读取具体内容的图片";
  return text.startsWith("一张") ? text : `一张${text}`;
}
