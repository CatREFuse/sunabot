export interface SunaTool {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
}

export { TOOL_CALL_TIMEOUT_MS } from "./toolConstants.js";
import { listToolMetadata } from "./toolRegistry.js";

export const defaultTools: SunaTool[] = listToolMetadata();
