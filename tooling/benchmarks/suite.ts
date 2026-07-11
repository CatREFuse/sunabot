import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runAttachmentScenario,
  runImagesScenario,
  runLogsScenario,
  runMemoryScenario,
  runMessagesScenario,
  runQueueScenario,
  runSoakScenario
} from "./scenarios.js";
import type {
  BenchmarkComparison,
  BenchmarkProfile,
  BenchmarkReport,
  BenchmarkScenarioName,
  RunBenchmarkOptions,
  ScenarioReport
} from "./types.js";

const ALL_SCENARIOS: BenchmarkScenarioName[] = [
  "messages",
  "logs",
  "memory",
  "queue",
  "attachment",
  "images",
  "soak"
];

export async function runBenchmarkSuite(options: RunBenchmarkOptions): Promise<BenchmarkReport> {
  validateProfile(options.profile);
  const startedAt = new Date().toISOString();
  const workspace = await isolatedWorkspace();
  const selected = options.scenarios ?? ALL_SCENARIOS;
  const scenarios: ScenarioReport[] = [];
  try {
    for (const name of selected) {
      const scenarioRoot = path.join(workspace, name);
      await fsp.mkdir(scenarioRoot, { recursive: true });
      scenarios.push(await runScenario(name, scenarioRoot, options.profile));
    }

    const failures = evaluateChecks(scenarios);
    failures.push(...evaluateBudgets(scenarios, options.profile));
    const comparison = options.baselineReport
      ? compareBenchmarkReports(
          scenarios,
          options.baselineReport,
          options.maxRegressionPercent ?? 20
        )
      : undefined;
    if (comparison) failures.push(...comparison.regressions);

    const report: BenchmarkReport = {
      schemaVersion: 1,
      suite: "sunabot-capacity-baseline",
      profile: options.profile.name,
      seed: options.profile.seed,
      startedAt,
      finishedAt: new Date().toISOString(),
      environment: benchmarkEnvironment(),
      scenarios,
      status: failures.length ? "failed" : "passed",
      failures,
      ...(comparison ? { comparison } : {})
    };
    if (options.outputPath) await writeBenchmarkReport(options.outputPath, report);
    return report;
  } finally {
    if (!options.keepWorkspace) await fsp.rm(workspace, { recursive: true, force: true });
  }
}

export async function writeBenchmarkReport(outputPath: string, report: BenchmarkReport) {
  const resolved = path.resolve(outputPath);
  await fsp.mkdir(path.dirname(resolved), { recursive: true });
  await fsp.writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readBenchmarkReport(filePath: string): Promise<BenchmarkReport> {
  const parsed = JSON.parse(await fsp.readFile(path.resolve(filePath), "utf8")) as Partial<BenchmarkReport>;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.suite !== "sunabot-capacity-baseline" ||
    !Array.isArray(parsed.scenarios)
  ) {
    throw new Error(`Unsupported benchmark report: ${filePath}`);
  }
  return parsed as BenchmarkReport;
}

export function compareBenchmarkReports(
  currentScenarios: ScenarioReport[],
  baseline: BenchmarkReport,
  maxRegressionPercent: number
): BenchmarkComparison {
  if (!Number.isFinite(maxRegressionPercent) || maxRegressionPercent < 0) {
    throw new Error("maxRegressionPercent must be a non-negative number.");
  }
  const regressions: string[] = [];
  const upperFactor = 1 + maxRegressionPercent / 100;
  const lowerFactor = 1 - maxRegressionPercent / 100;
  for (const current of currentScenarios) {
    const previous = baseline.scenarios.find((scenario) => scenario.name === current.name);
    if (!previous) continue;
    const currentPhase = current.phases[current.primaryPhase];
    const previousPhase = previous.phases[previous.primaryPhase];
    if (!currentPhase || !previousPhase) continue;
    regressionIfHigher(
      regressions,
      `${current.name}.${current.primaryPhase}.p95`,
      currentPhase.latencyMs.p95,
      previousPhase.latencyMs.p95,
      upperFactor
    );
    regressionIfLower(
      regressions,
      `${current.name}.${current.primaryPhase}.throughput`,
      currentPhase.throughputPerSecond,
      previousPhase.throughputPerSecond,
      lowerFactor
    );
    regressionIfHigher(
      regressions,
      `${current.name}.rssPeakBytes`,
      current.resources.rssPeakBytes,
      previous.resources.rssPeakBytes,
      upperFactor
    );
    regressionIfHigher(
      regressions,
      `${current.name}.workspaceGrowthBytes`,
      current.storage.workspaceGrowthBytes,
      previous.storage.workspaceGrowthBytes,
      upperFactor
    );
  }
  return {
    baselineProfile: baseline.profile,
    maxRegressionPercent,
    regressions
  };
}

function runScenario(name: BenchmarkScenarioName, root: string, profile: BenchmarkProfile) {
  switch (name) {
    case "messages": return runMessagesScenario(root, profile);
    case "logs": return runLogsScenario(root, profile);
    case "memory": return runMemoryScenario(root, profile);
    case "queue": return runQueueScenario(root, profile);
    case "attachment": return runAttachmentScenario(root, profile);
    case "images": return runImagesScenario(root, profile);
    case "soak": return runSoakScenario(root, profile);
  }
}

function evaluateChecks(scenarios: ScenarioReport[]) {
  const failures: string[] = [];
  for (const scenario of scenarios) {
    for (const [name, passed] of Object.entries(scenario.checks)) {
      if (!passed) failures.push(`${scenario.name}.${name} failed`);
    }
    const phase = scenario.phases[scenario.primaryPhase];
    if (!phase || phase.operations <= 0) failures.push(`${scenario.name} has no primary phase samples`);
  }
  return failures;
}

function evaluateBudgets(scenarios: ScenarioReport[], profile: BenchmarkProfile) {
  const failures: string[] = [];
  const budgets = profile.budgets;
  if (!budgets) return failures;
  budget(
    failures,
    scenarios,
    "messages",
    "persist",
    "latencyMs.p95",
    budgets.messagesPersistP95Ms
  );
  budget(
    failures,
    scenarios,
    "memory",
    "recall",
    "latencyMs.p95",
    budgets.memoryRecallP95Ms
  );
  const queue = scenarios.find((scenario) => scenario.name === "queue");
  if (queue && budgets.queueEventLoopP99Ms !== undefined && queue.eventLoop.p99Ms > budgets.queueEventLoopP99Ms) {
    failures.push(`queue.eventLoop.p99Ms ${queue.eventLoop.p99Ms} exceeds ${budgets.queueEventLoopP99Ms}`);
  }
  budget(
    failures,
    scenarios,
    "images",
    "list",
    "latencyMs.p95",
    budgets.imageListP95Ms
  );
  return failures;
}

function budget(
  failures: string[],
  scenarios: ScenarioReport[],
  scenarioName: BenchmarkScenarioName,
  phaseName: string,
  metric: "latencyMs.p95",
  limit: number | undefined
) {
  if (limit === undefined) return;
  const scenario = scenarios.find((candidate) => candidate.name === scenarioName);
  const phase = scenario?.phases[phaseName];
  if (phase && phase.latencyMs.p95 > limit) {
    failures.push(`${scenarioName}.${phaseName}.${metric} ${phase.latencyMs.p95} exceeds ${limit}`);
  }
}

async function isolatedWorkspace() {
  const temporaryRoot = await fsp.realpath(os.tmpdir());
  const workspace = await fsp.mkdtemp(path.join(temporaryRoot, "sunabot-benchmark-"));
  const relative = path.relative(temporaryRoot, workspace);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    await fsp.rm(workspace, { recursive: true, force: true });
    throw new Error("Benchmark workspace escaped the operating-system temporary directory.");
  }
  return workspace;
}

function benchmarkEnvironment() {
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem()
  };
}

function validateProfile(profile: BenchmarkProfile) {
  positive(profile.messages.hotMessageCount, "messages.hotMessageCount");
  positive(profile.messages.activeConversations, "messages.activeConversations");
  if (!profile.logs.checkpoints.length) throw new Error("logs.checkpoints must not be empty.");
  for (const checkpoint of profile.logs.checkpoints) positive(checkpoint, "logs.checkpoints");
  positive(profile.logs.queryIterations, "logs.queryIterations");
  positive(profile.memory.records, "memory.records");
  positive(profile.memory.recallIterations, "memory.recallIterations");
  positive(profile.queue.backlog, "queue.backlog");
  positive(profile.queue.sessions, "queue.sessions");
  positive(profile.attachment.characters, "attachment.characters");
  positive(profile.attachment.queryIterations, "attachment.queryIterations");
  positive(profile.attachment.queryConcurrency, "attachment.queryConcurrency");
  positive(profile.images.files, "images.files");
  positive(profile.images.listIterations, "images.listIterations");
  positive(profile.soak.durationMs, "soak.durationMs");
  positive(profile.soak.tickIntervalMs, "soak.tickIntervalMs");
  positive(profile.soak.cacheLimit, "soak.cacheLimit");
}

function positive(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
}

function regressionIfHigher(
  failures: string[],
  metric: string,
  current: number,
  baseline: number,
  factor: number
) {
  if (baseline > 0 && current > baseline * factor) {
    failures.push(`${metric} regressed from ${baseline} to ${current}`);
  }
}

function regressionIfLower(
  failures: string[],
  metric: string,
  current: number,
  baseline: number,
  factor: number
) {
  if (baseline > 0 && current < baseline * factor) {
    failures.push(`${metric} regressed from ${baseline} to ${current}`);
  }
}
