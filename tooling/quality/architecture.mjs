import { resolveProjectRoot } from "../shared/paths.mjs";
import { auditArchitecture, formatArchitectureResult } from "./architecture/audit.mjs";

const root = resolveProjectRoot(import.meta.url);
const result = auditArchitecture(root);

const output = formatArchitectureResult(result);
if (result.failures.length) {
  console.error(output);
  process.exitCode = 1;
} else {
  console.log(output);
}
