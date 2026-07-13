import fs from "node:fs/promises";
import path from "node:path";

export async function readNodeVersionContractInputs(root) {
  const [
    contract,
    schema,
    componentLock,
    packageJson,
    packageLock,
    nodeVersionFile,
    nvmrc,
    workflow,
    dockerfile,
    nativeStart,
    buildRelease
  ] = await Promise.all([
    readJson(path.join(root, "deploy/runtime-contract.json")),
    readJson(path.join(root, "deploy/runtime-contract.schema.json")),
    readJson(path.join(root, "components/component.lock.json")),
    readJson(path.join(root, "package.json")),
    readJson(path.join(root, "package-lock.json")),
    fs.readFile(path.join(root, ".node-version"), "utf8"),
    fs.readFile(path.join(root, ".nvmrc"), "utf8"),
    fs.readFile(path.join(root, ".github/workflows/verify.yml"), "utf8"),
    fs.readFile(path.join(root, "deploy/docker/Dockerfile"), "utf8"),
    fs.readFile(path.join(root, "deploy/native/bin/start-sunabot.sh"), "utf8"),
    fs.readFile(path.join(root, "tooling/runtime/build-release.mjs"), "utf8")
  ]);
  return {
    contract,
    schema,
    componentLock,
    packageJson,
    packageLock,
    nodeVersionFile,
    nvmrc,
    workflow,
    dockerfile,
    nativeStart,
    buildRelease
  };
}

export function validateNodeVersionEntrypoints(input) {
  const errors = [];
  const expected = String(input.contract?.nodeVersion ?? "").trim();
  const nodeComponent = input.componentLock?.components?.node;
  expect(/^\d+\.\d+\.\d+$/.test(expected), "runtime contract must pin an exact Node version");
  expect(input.schema?.properties?.nodeVersion?.const === expected,
    "runtime contract schema must fix the exact Node version");
  expect(input.nodeVersionFile.trim() === expected, ".node-version must match the runtime contract");
  expect(input.nvmrc.trim() === expected, ".nvmrc must match the runtime contract");
  expect(input.packageJson?.engines?.node === expected,
    "package engines.node must equal the exact runtime contract Node version");
  expect(input.packageLock?.packages?.[""]?.engines?.node === expected,
    "package-lock root engines.node must equal the exact runtime contract Node version");
  expect(nodeComponent?.version === expected, "component lock Node version must match the runtime contract");
  expect(
    typeof nodeComponent?.image === "string" && nodeComponent.image.includes(`node:${expected}-`),
    "component lock Node image tag must contain the exact runtime contract version"
  );
  expect(
    /^\s*node-version-file:\s*\.node-version\s*$/m.test(input.workflow),
    "CI setup-node must read .node-version"
  );
  expect(
    input.dockerfile.includes(`ARG NODE_VERSION=${expected}`),
    "Dockerfile NODE_VERSION must match the runtime contract"
  );
  expect(
    input.dockerfile.includes(`ARG NODE_IMAGE=${nodeComponent?.image}@${nodeComponent?.digest}`),
    "Dockerfile Node image and digest must match the component lock"
  );
  expect(
    input.dockerfile.includes("process.versions.node") && input.dockerfile.includes('"$NODE_VERSION"'),
    "Docker build must assert the Node binary version"
  );
  expect(
    input.nativeStart.includes("actual_node")
      && input.nativeStart.includes("expected_node")
      && input.nativeStart.includes('[[ "$actual_node" != "$expected_node" ]]'),
    "Native start must reject a Node version different from the runtime contract"
  );
  expect(
    input.buildRelease.includes("process.versions.node !== contract.nodeVersion")
      && input.buildRelease.includes("nodeVersion: contract.nodeVersion"),
    "Native release build and manifest must use the runtime contract Node version"
  );
  return errors;

  function expect(condition, message) {
    if (!condition) errors.push(message);
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
