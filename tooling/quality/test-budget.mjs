import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const MAX_TEST_LOC = 82_000;
const codeFile = /\.(?:ts|vue|mjs|js|cjs|sh)$/;
const testFile = /(?:^|\/)(?:tests|packages\/testkit)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.(?:ts|js|mjs|cjs)$/;
const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((path) => path && existsSync(path) && codeFile.test(path) && testFile.test(path));
const lines = paths.reduce(
  (total, path) => total + (readFileSync(path, "utf8").match(/\n/g)?.length ?? 0),
  0
);

console.log(JSON.stringify({ ok: lines <= MAX_TEST_LOC, files: paths.length, lines, maxLines: MAX_TEST_LOC }));
if (lines > MAX_TEST_LOC) process.exitCode = 1;
