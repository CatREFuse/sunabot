import type { NormalReplyConfig } from "../types.js";
import { exactKeys, integer, object } from "./configValidation.js";

export function validateNormalReplyConfig(input: unknown): NormalReplyConfig {
  const value = object(input, "normalReply");
  exactKeys(value, ["maxRetries"], "normalReply");
  return {
    maxRetries: integer(value.maxRetries, "normalReply.maxRetries", 0, 10)
  };
}
