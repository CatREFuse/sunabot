// @vitest-environment node
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { percentile, summarizeLatencies } from "../../tooling/benchmarks/metrics.js";
import { benchmarkProfiles, testBenchmarkProfile } from "../../tooling/benchmarks/profiles.js";
import {
  compareBenchmarkReports,
  readBenchmarkReport,
  runBenchmarkSuite
} from "../../tooling/benchmarks/suite.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.SUNABOT_WORKSPACE;
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("performance and capacity benchmark gate", () => {
  it("keeps the full profile aligned with GATE-004 capacity targets", () => {
    const full = benchmarkProfiles.full;
    expect(full).toBeDefined();
    expect(full?.messages).toEqual({ hotMessageCount: 2_000, activeConversations: 80 });
    expect(full?.logs.checkpoints).toEqual([100_000, 1_000_000]);
    expect(full?.memory.records).toBe(100_000);
    expect(full?.queue.backlog).toBe(100_000);
    expect(full?.attachment.characters).toBe(20_000_000);
    expect(full?.images.files).toBe(10_000);
    expect(full?.soak.durationMs).toBe(72 * 60 * 60 * 1_000);
  });

  it("calculates deterministic nearest-rank latency percentiles", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
    expect(summarizeLatencies([5, 1, 3, 2, 4])).toMatchObject({
      samples: 5,
      min: 1,
      p50: 3,
      p95: 5,
      p99: 5,
      max: 5,
      mean: 3
    });
  });

  it("runs every scenario in temporary SQLite workspaces without touching SUNABOT_WORKSPACE", async () => {
    const root = await temporaryRoot();
    const production = path.join(root, "production-workspace");
    const marker = path.join(production, "do-not-touch.txt");
    const reportPath = path.join(root, "artifacts", "benchmark.json");
    await fsp.mkdir(production, { recursive: true });
    await fsp.writeFile(marker, "sentinel", "utf8");
    process.env.SUNABOT_WORKSPACE = production;

    const report = await runBenchmarkSuite({
      profile: testBenchmarkProfile,
      outputPath: reportPath
    });

    expect(report.status).toBe("passed");
    expect(report.scenarios.map((scenario) => scenario.name)).toEqual([
      "messages",
      "logs",
      "memory",
      "queue",
      "attachment",
      "images",
      "soak"
    ]);
    for (const scenario of report.scenarios) {
      expect(scenario.phases[scenario.primaryPhase]?.operations).toBeGreaterThan(0);
      expect(scenario.resources.rssPeakBytes).toBeGreaterThan(0);
      expect(scenario.storage.workspaceGrowthBytes).toBeGreaterThan(0);
      expect(scenario.eventLoop.p99Ms).toBeGreaterThanOrEqual(0);
    }
    expect(await fsp.readFile(marker, "utf8")).toBe("sentinel");
    expect(JSON.stringify(report)).not.toContain(production);
    expect(await readBenchmarkReport(reportPath)).toMatchObject({
      schemaVersion: 1,
      suite: "sunabot-capacity-baseline",
      profile: "test"
    });
  }, 20_000);

  it("reports comparable p95, throughput, RSS and storage regressions", async () => {
    const report = await runBenchmarkSuite({
      profile: testBenchmarkProfile,
      scenarios: ["messages"]
    });
    const baseline = structuredClone(report);
    const phase = baseline.scenarios[0]?.phases.persist;
    const current = report.scenarios[0]?.phases.persist;
    if (!phase || !current) throw new Error("Missing message benchmark phase.");
    phase.latencyMs.p95 = Math.max(0.000_001, current.latencyMs.p95 / 10);
    phase.throughputPerSecond = current.throughputPerSecond * 10;
    baseline.scenarios[0]!.resources.rssPeakBytes = 1;
    baseline.scenarios[0]!.storage.workspaceGrowthBytes = 1;

    const comparison = compareBenchmarkReports(report.scenarios, baseline, 5);
    expect(comparison.regressions).toEqual(expect.arrayContaining([
      expect.stringContaining("messages.persist.p95"),
      expect.stringContaining("messages.persist.throughput"),
      expect.stringContaining("messages.rssPeakBytes"),
      expect.stringContaining("messages.workspaceGrowthBytes")
    ]));
  });
});

async function temporaryRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sunabot-benchmark-test-"));
  roots.push(root);
  return root;
}
