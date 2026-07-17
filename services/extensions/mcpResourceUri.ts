import { MCP_VIRTUAL_WORKBENCH_ROOT } from "../../packages/contracts/extensions/agentRuntimeExtensions.js";

const MAX_MCP_RESOURCE_URI_BYTES = 8_192;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export function assertCanonicalMcpResourceUri(value: unknown) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > MAX_MCP_RESOURCE_URI_BYTES ||
      !isWellFormedUnicode(value) || CONTROL_CHARACTER_PATTERN.test(value)) {
    forbidden();
  }
  if (!/^file:/iu.test(value)) return value;
  if (!value.startsWith("file:///") || value.includes("?") || value.includes("#") || value.includes("\\")) forbidden();
  const encodedPath = value.slice("file:///".length);
  const encodedSegments = encodedPath.split("/");
  if (!encodedSegments.length || encodedSegments.some((segment) => !segment)) forbidden();
  const decodedSegments = encodedSegments.map((segment) => decodeSegment(segment));
  if (decodedSegments[0] !== "workbench") forbidden();
  const canonical = `file:///${decodedSegments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  if (canonical !== value || (canonical !== MCP_VIRTUAL_WORKBENCH_ROOT &&
      !canonical.startsWith(`${MCP_VIRTUAL_WORKBENCH_ROOT}/`))) forbidden();
  let parsed: URL;
  try {
    parsed = new URL(canonical);
  } catch {
    forbidden();
  }
  if (parsed.protocol !== "file:" || parsed.hostname || parsed.username || parsed.password || parsed.port ||
      parsed.search || parsed.hash || parsed.toString() !== canonical) forbidden();
  return canonical;
}

function decodeSegment(value: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    forbidden();
  }
  if (!decoded || decoded === "." || decoded === ".." || decoded.includes("%") || decoded.includes("/") ||
      decoded.includes("\\") || CONTROL_CHARACTER_PATTERN.test(decoded) || !isWellFormedUnicode(decoded)) {
    forbidden();
  }
  return decoded;
}

function isWellFormedUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function forbidden(): never {
  throw new Error("MCP_RESOURCE_URI_FORBIDDEN");
}
