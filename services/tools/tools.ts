import { listToolMetadata, type ToolMetadata } from "./toolRegistry.js";

export type SunaTool = ToolMetadata;

export const defaultTools: SunaTool[] = listToolMetadata();

export { TOOL_CALL_TIMEOUT_MS } from "./toolConstants.js";
