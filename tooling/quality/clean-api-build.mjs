import fs from "node:fs/promises";
import path from "node:path";
import { resolveProjectRoot } from "../shared/paths.mjs";

const root = resolveProjectRoot(import.meta.url);
const output = path.resolve(root, "dist");
if (path.dirname(output) !== root || path.basename(output) !== "dist") {
  throw new Error(`Refusing to clean unexpected build output: ${output}`);
}
await fs.rm(output, { recursive: true, force: true });
