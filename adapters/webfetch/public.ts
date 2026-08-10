import {
  WebFetchService,
  type WebFetchServiceOptions
} from "../../services/webfetch/public.js";
import {
  extractWebContent,
  webContentIsSufficient
} from "./defuddleExtractor.js";
import { HttpDynamicRendererClient } from "./dynamicRendererClient.js";
import { fetchSafeHtml } from "./safeHttpFetcher.js";
import { parseWebUrl, resolveWebTarget } from "./urlPolicy.js";

export * from "./defuddleExtractor.js";
export * from "./dynamicRendererClient.js";
export * from "./safeHttpFetcher.js";
export * from "./urlPolicy.js";

export type WebFetchCompositionOptions = Partial<Omit<WebFetchServiceOptions, "now">> & {
  now?: () => Date;
};

export function createWebFetchService(options: WebFetchCompositionOptions = {}) {
  return new WebFetchService({
    renderer: options.renderer ?? new HttpDynamicRendererClient(),
    staticFetch: options.staticFetch ?? ((url, fetchOptions) => fetchSafeHtml(url, fetchOptions)),
    extract: options.extract ?? extractWebContent,
    contentIsSufficient: options.contentIsSufficient ?? webContentIsSufficient,
    canonicalizeUrl: options.canonicalizeUrl ?? ((url) => parseWebUrl(url).href),
    validateRenderedUrl: options.validateRenderedUrl ?? (async (url) => resolveWebTarget(url).url.href),
    now: options.now
  });
}

let defaultService: WebFetchService | undefined;

export function defaultWebFetchService() {
  defaultService ??= createWebFetchService();
  return defaultService;
}
