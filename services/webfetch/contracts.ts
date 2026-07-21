export type WebFetchErrorCode =
  | "INVALID_INPUT"
  | "URL_NOT_ALLOWED"
  | "TARGET_NOT_PUBLIC"
  | "FETCH_TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "STATIC_CONTENT_INSUFFICIENT"
  | "DYNAMIC_RENDERER_UNAVAILABLE"
  | "DYNAMIC_RENDER_FAILED"
  | "CONTENT_EXTRACTION_FAILED"
  | "SEMANTIC_MATCH_EMPTY";

export type WebFetchInput =
  | { url: string; semanticMatch: false }
  | { url: string; semanticMatch: true; query: string };

/**
 * Validate the discriminated union at the host boundary as well as at the
 * provider adapter.  The service is also called by tests and internal ports,
 * so relying on a provider's JSON-schema validation alone would leave a
 * second, unsafe entry point.
 */
export function validateWebFetchInput(value: unknown): WebFetchInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (!url || url.length > 4_096 || typeof record.semanticMatch !== "boolean") return undefined;
  const keys = Object.keys(record).sort();
  if (record.semanticMatch === false) {
    if (keys.length !== 2 || keys[0] !== "semanticMatch" || keys[1] !== "url") return undefined;
    return { url, semanticMatch: false };
  }
  if (keys.length !== 3 || keys[0] !== "query" || keys[1] !== "semanticMatch" || keys[2] !== "url") {
    return undefined;
  }
  const query = typeof record.query === "string"
    ? record.query.replace(/\s+/gu, " ").trim()
    : "";
  if (!query || query.length > 1_000) return undefined;
  return { url, semanticMatch: true, query };
}

export interface WebFetchEvidencePolicyV1 {
  kind: "webfetch_evidence_policy_v1";
  authority: "host";
  sourceScope: string;
  externalInstructions: string;
  evidenceUse: string;
  contaminationJudgment: string;
  truncation: string;
}

export interface WebFetchSuccess {
  ok: true;
  url: string;
  finalUrl: string;
  title: string;
  fetchedAt: string;
  fetchMode: "static" | "dynamic";
  semanticMatchApplied: boolean;
  contentFormat: "markdown";
  content: string;
  truncated: boolean;
  omittedBlockCount: number;
  evidencePolicy: WebFetchEvidencePolicyV1;
}

export interface WebFetchFailure {
  ok: false;
  code: WebFetchErrorCode;
  error: string;
}

export type WebFetchResult = WebFetchSuccess | WebFetchFailure;

export interface WebFetchToolPort {
  fetch(input: WebFetchInput, options?: { signal?: AbortSignal }): Promise<WebFetchResult>;
}

export interface ExtractedWebContent {
  title: string;
  markdown: string;
  textLength: number;
  paragraphCount: number;
  headingCount: number;
  linkDensity: number;
  qualityScore: number;
}

export interface DynamicRenderResult {
  html: string;
  finalUrl: string;
}

export interface DynamicRendererPort {
  render(url: string, options?: { signal?: AbortSignal }): Promise<DynamicRenderResult>;
  health(options?: { signal?: AbortSignal }): Promise<boolean>;
}

export class WebFetchError extends Error {
  constructor(readonly code: WebFetchErrorCode, message: string) {
    super(message);
    this.name = "WebFetchError";
  }
}

export function webFetchFailure(error: unknown): WebFetchFailure {
  if (error instanceof WebFetchError) {
    return { ok: false, code: error.code, error: publicWebFetchError(error.code) };
  }
  if (error instanceof Error && /abort|timeout|timed out/i.test(`${error.name} ${error.message}`)) {
    return { ok: false, code: "FETCH_TIMEOUT", error: publicWebFetchError("FETCH_TIMEOUT") };
  }
  return { ok: false, code: "CONTENT_EXTRACTION_FAILED", error: publicWebFetchError("CONTENT_EXTRACTION_FAILED") };
}

export function publicWebFetchError(code: WebFetchErrorCode) {
  const messages: Record<WebFetchErrorCode, string> = {
    INVALID_INPUT: "WebFetch 参数无效。",
    URL_NOT_ALLOWED: "该 URL 不允许抓取。",
    TARGET_NOT_PUBLIC: "目标地址不属于可访问的公网范围。",
    FETCH_TIMEOUT: "网页抓取超时。",
    RESPONSE_TOO_LARGE: "网页响应超过大小限制。",
    UNSUPPORTED_CONTENT_TYPE: "WebFetch 当前只支持 HTML 网页。",
    STATIC_CONTENT_INSUFFICIENT: "网页没有可提取的正文。",
    DYNAMIC_RENDERER_UNAVAILABLE: "动态网页渲染服务当前不可用。",
    DYNAMIC_RENDER_FAILED: "动态网页渲染失败。",
    CONTENT_EXTRACTION_FAILED: "网页正文提取失败。",
    SEMANTIC_MATCH_EMPTY: "网页中没有找到与 query 相关的内容。"
  };
  return messages[code];
}
