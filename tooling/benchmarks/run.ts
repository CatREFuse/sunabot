import path from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkProfile, benchmarkProfiles } from "./profiles.js";
import { readBenchmarkReport, runBenchmarkSuite } from "./suite.js";
import type { BenchmarkScenarioName } from "./types.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.listProfiles) {
    console.log(Object.keys(benchmarkProfiles).join("\n"));
    return;
  }
  const profile = benchmarkProfile(args.profile);
  const outputPath = path.resolve(
    args.outputPath ?? path.join(projectRoot, "benchmark-results", `${profile.name}.json`)
  );
  const baselineReport = args.baselinePath
    ? await readBenchmarkReport(args.baselinePath)
    : undefined;
  const report = await runBenchmarkSuite({
    profile,
    scenarios: args.scenarios,
    outputPath,
    baselineReport,
    maxRegressionPercent: args.maxRegressionPercent,
    keepWorkspace: args.keepWorkspace
  });

  console.log(`benchmark profile=${report.profile} status=${report.status}`);
  for (const scenario of report.scenarios) {
    const phase = scenario.phases[scenario.primaryPhase];
    console.log(
      `${scenario.name}: throughput=${phase?.throughputPerSecond ?? 0}/s ` +
      `p95=${phase?.latencyMs.p95 ?? 0}ms p99=${phase?.latencyMs.p99 ?? 0}ms ` +
      `event-loop-p99=${scenario.eventLoop.p99Ms}ms rss-peak=${scenario.resources.rssPeakBytes}`
    );
  }
  console.log(`report=${outputPath}`);
  for (const failure of report.failures) console.error(`FAILED: ${failure}`);
  if (report.status === "failed") process.exitCode = 1;
}

interface ParsedArguments {
  profile: string;
  scenarios?: BenchmarkScenarioName[];
  outputPath?: string;
  baselinePath?: string;
  maxRegressionPercent?: number;
  keepWorkspace: boolean;
  listProfiles: boolean;
}

function parseArguments(values: string[]): ParsedArguments {
  const result: ParsedArguments = {
    profile: "ci",
    keepWorkspace: false,
    listProfiles: false
  };
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--profile") result.profile = requiredValue(values, ++index, argument);
    else if (argument === "--scenario") {
      result.scenarios = requiredValue(values, ++index, argument)
        .split(",")
        .map((value) => scenarioName(value.trim()));
    } else if (argument === "--output") result.outputPath = requiredValue(values, ++index, argument);
    else if (argument === "--baseline") result.baselinePath = requiredValue(values, ++index, argument);
    else if (argument === "--max-regression-percent") {
      result.maxRegressionPercent = Number(requiredValue(values, ++index, argument));
    } else if (argument === "--keep-workspace") result.keepWorkspace = true;
    else if (argument === "--list-profiles") result.listProfiles = true;
    else throw new Error(`Unknown benchmark argument: ${argument}`);
  }
  return result;
}

function requiredValue(values: string[], index: number, option: string) {
  const value = values[index];
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}

function scenarioName(value: string): BenchmarkScenarioName {
  const names: BenchmarkScenarioName[] = ["messages", "logs", "memory", "queue", "attachment", "images", "soak"];
  if (!names.includes(value as BenchmarkScenarioName)) {
    throw new Error(`Unknown benchmark scenario: ${value}`);
  }
  return value as BenchmarkScenarioName;
}
