#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const releaseRoot = "/srv/sunabot";
const contract = JSON.parse(
  await fs.readFile(path.join(releaseRoot, "deploy/runtime-contract.json"), "utf8")
);
const port = Number(process.env.SUNABOT_PORT || contract.network.admin.port);
const onebotPort = Number(process.env.SUNABOT_ONEBOT_PORT || contract.network.onebot.internalPort);
const result = {
  ok: false,
  runtimeId: contract.runtimeId,
  service: "core",
  layers: {
    apiHttp: false,
    onebotHttp: false
  }
};

try {
  const [apiResponse, onebotResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}${contract.health.livenessPath}`, {
      signal: AbortSignal.timeout(3_000)
    }),
    fetch(`http://127.0.0.1:${onebotPort}/healthz`, {
      signal: AbortSignal.timeout(3_000)
    })
  ]);
  result.layers.apiHttp = apiResponse.ok;
  result.layers.onebotHttp = onebotResponse.status === 204;
  result.ok = result.layers.apiHttp && result.layers.onebotHttp;
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
}

if (!result.ok || process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (!result.ok) process.exitCode = 1;
