const MCP_LOG_MAX_BYTES = 1024 * 1024;
const MCP_LOG_MAX_DEPTH = 8;
const MCP_LOG_MAX_NODES = 2_048;
const MCP_LOG_MAX_PROPERTIES = 128;
const MCP_LOG_MAX_CONTENT_TYPES = 128;

/**
 * MCP results are untrusted server output. Request logs keep only a bounded
 * structural summary and never copy server-controlled values.
 */
export function mcpToolLogSummary(value: unknown) {
  try {
    const state = { bytes: 0, nodes: 0, truncated: false };
    estimateMcpLogBytes(value, state, 0, new WeakSet<object>());
    const descriptors = ownDataDescriptors(value);
    const isError = descriptors?.isError?.value === true;
    const content = descriptors?.content?.value;
    const contentTypes: string[] = [];
    let contentCount = 0;
    if (Array.isArray(content)) {
      contentCount = Math.min(content.length, MCP_LOG_MAX_NODES);
      if (content.length > MCP_LOG_MAX_NODES) state.truncated = true;
      for (let index = 0; index < Math.min(content.length, MCP_LOG_MAX_CONTENT_TYPES); index += 1) {
        const type = ownDataDescriptors(content[index])?.type?.value;
        const normalized = type === "text" || type === "image" || type === "audio" ||
          type === "resource" || type === "resource_link"
          ? type
          : "unknown";
        if (!contentTypes.includes(normalized)) contentTypes.push(normalized);
      }
    }
    return {
      status: isError ? "error" : "received",
      isError,
      contentCount,
      contentTypes,
      byteCount: Math.min(state.bytes, MCP_LOG_MAX_BYTES),
      truncated: state.truncated || state.bytes >= MCP_LOG_MAX_BYTES
    };
  } catch {
    return {
      status: "uninspectable",
      isError: false,
      contentCount: 0,
      contentTypes: [] as string[],
      byteCount: 0,
      truncated: true
    };
  }
}

function ownDataDescriptors(value: unknown): Record<string, PropertyDescriptor> | undefined {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.fromEntries(Object.entries(descriptors).filter(([, descriptor]) => "value" in descriptor));
}

function estimateMcpLogBytes(
  value: unknown,
  state: { bytes: number; nodes: number; truncated: boolean },
  depth: number,
  seen: WeakSet<object>
) {
  if (state.bytes >= MCP_LOG_MAX_BYTES || state.nodes >= MCP_LOG_MAX_NODES || depth > MCP_LOG_MAX_DEPTH) {
    state.truncated = true;
    return;
  }
  state.nodes += 1;
  if (typeof value === "string") {
    state.bytes = Math.min(MCP_LOG_MAX_BYTES, state.bytes + Buffer.byteLength(value, "utf8"));
    return;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    state.bytes = Math.min(MCP_LOG_MAX_BYTES, state.bytes + String(value).length);
    return;
  }
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
  const object = value as object;
  if (seen.has(object)) {
    state.truncated = true;
    return;
  }
  seen.add(object);
  const descriptors = Object.getOwnPropertyDescriptors(object);
  const entries = Object.entries(descriptors);
  if (entries.length > MCP_LOG_MAX_PROPERTIES) state.truncated = true;
  for (const [property, descriptor] of entries.slice(0, MCP_LOG_MAX_PROPERTIES)) {
    if (!("value" in descriptor)) continue;
    state.bytes = Math.min(MCP_LOG_MAX_BYTES, state.bytes + Buffer.byteLength(property, "utf8"));
    estimateMcpLogBytes(descriptor.value, state, depth + 1, seen);
    if (state.bytes >= MCP_LOG_MAX_BYTES || state.nodes >= MCP_LOG_MAX_NODES) {
      state.truncated = true;
      break;
    }
  }
}
