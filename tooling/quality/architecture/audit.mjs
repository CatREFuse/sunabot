import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { architectureDebtAllowances } from "./debts.mjs";

export const ARCHITECTURE_RULES = [
  "structure",
  "path-drift",
  "service-boundary",
  "contracts-boundary",
  "public-api",
  "executable-cycle",
  "durable-codec",
  "tool-registry",
  "size-budget",
  "runtime-contract"
];

const REQUIRED_DIRECTORIES = [
  "apps/api",
  "apps/admin-web",
  "services/messaging",
  "services/conversations",
  "services/sessions",
  "services/reply",
  "services/orchestration",
  "services/memory",
  "services/media",
  "services/tools",
  "services/delivery",
  "services/agent",
  "adapters/onebot",
  "adapters/model",
  "adapters/codex",
  "adapters/sqlite",
  "adapters/filesystem",
  "packages/contracts",
  "packages/platform",
  "packages/testkit",
  "components",
  "deploy/docker",
  "deploy/native",
  "tooling/quality",
  "tests"
];

const CODE_ROOTS = ["src", "apps/api", "services", "adapters", "packages", "deploy", "tooling"];
const BUDGET_ROOTS = ["src", "apps/api", "services", "adapters", "packages"];
const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$)/;
const PUBLIC_ENTRY = /^(?:public|index)\.[cm]?[jt]sx?$/;

const DURABLE_SINKS = [
  {
    id: "session-event",
    table: /\bsession_events\b/i,
    jsonColumn: /\bpayload_json\b/i,
    entity: /(?:session.*event|event.*payload)/i
  },
  {
    id: "tool-job",
    table: /\btool_jobs\b/i,
    jsonColumn: /\b(?:original_request|arguments|result|error)_json\b/i,
    entity: /(?:tool.*job|job.*payload)/i
  },
  {
    id: "outbox",
    table: /\boutbox\b/i,
    jsonColumn: /\bpayload_json\b/i,
    entity: /outbox/i
  }
];

export function auditArchitecture(projectRoot, overrides = {}) {
  const root = path.resolve(projectRoot);
  const rules = new Set(overrides.rules ?? ARCHITECTURE_RULES);
  const allowances = overrides.debtAllowances ?? architectureDebtAllowances;
  const requiredDirectories = overrides.requiredDirectories ?? REQUIRED_DIRECTORIES;
  const obsoleteRoots = overrides.obsoleteRoots ?? ["scripts", "web", "components/qq-runtime"];
  const codeRoots = overrides.codeRoots ?? CODE_ROOTS;
  const budgetRoots = overrides.budgetRoots ?? BUDGET_ROOTS;
  const fileBudget = overrides.fileBudget ?? 800;
  const classBudget = overrides.classBudget ?? 500;
  const toolRegistryPath = overrides.toolRegistryPath ?? "services/tools/toolRegistry.ts";
  const runtimeContractPath = overrides.runtimeContractPath === undefined
    ? "deploy/runtime-contract.json"
    : overrides.runtimeContractPath;
  const enforceStaleDebt = overrides.enforceStaleDebt ?? true;

  const failures = [];
  const debts = [];
  const consumedAllowances = new Set();
  const sourceFiles = loadSources(root, codeRoots);
  const sourceIndex = new Map(sourceFiles.map((source) => [source.relative, source]));

  const report = (violation) => {
    const allowance = allowances.find((candidate) => matchesAllowance(candidate, violation));
    if (!allowance) {
      failures.push(violation.message);
      return;
    }
    consumedAllowances.add(allowance.id);
    if (allowance.ceiling != null && violation.actual > allowance.ceiling) {
      failures.push(
        `${violation.message}; tracked debt ceiling ${allowance.ceiling} was exceeded (${allowance.tracking})`
      );
      return;
    }
    debts.push({ ...violation, allowance });
  };

  if (rules.has("structure")) {
    for (const relative of requiredDirectories) {
      if (!fs.existsSync(path.join(root, relative))) report({
        rule: "structure",
        source: relative,
        message: `missing required directory: ${relative}`
      });
    }
    for (const relative of obsoleteRoots) {
      if (fs.existsSync(path.join(root, relative))) report({
        rule: "structure",
        source: relative,
        message: `obsolete root remains: ${relative}`
      });
    }
  }

  const importsByFile = new Map();
  for (const source of sourceFiles) {
    const imports = collectImports(source);
    importsByFile.set(source.relative, imports);

    if (rules.has("path-drift") && usesProcessCwd(source.ast)) {
      report({
        rule: "path-drift",
        source: source.relative,
        message: `${source.relative} derives paths from process.cwd()`
      });
    }

    for (const reference of imports) {
      const target = resolveReference(root, source, reference.specifier, sourceIndex);
      const targetLabel = target.relative ?? `external:${reference.specifier}`;

      if (rules.has("service-boundary") && source.relative.startsWith("services/") && target.relative) {
        if (isForbiddenServiceTarget(target.relative)) report({
          rule: "service-boundary",
          source: source.relative,
          target: target.relative,
          message: `${source.relative}:${reference.line} imports forbidden boundary ${target.relative}`
        });
      }

      if (rules.has("contracts-boundary") && source.relative.startsWith("packages/contracts/")) {
        const reason = forbiddenContractDependency(target, reference.specifier);
        if (reason) report({
          rule: "contracts-boundary",
          source: source.relative,
          target: targetLabel,
          message: `${source.relative}:${reference.line} ${reason}: ${targetLabel}`
        });
      }

      if (rules.has("public-api") && source.relative.startsWith("services/") && target.relative) {
        const sourceService = serviceName(source.relative);
        const targetService = serviceName(target.relative);
        if (sourceService && targetService && sourceService !== targetService && !isPublicServiceEntry(target.relative)) {
          report({
            rule: "public-api",
            source: source.relative,
            target: target.relative,
            message: `${source.relative}:${reference.line} deep-imports ${target.relative}; cross-service imports must use public.ts or index.ts`
          });
        }
      }
    }

    if (rules.has("contracts-boundary") && source.relative.startsWith("packages/contracts/") && usesProcessEnvironment(source)) {
      report({
        rule: "contracts-boundary",
        source: source.relative,
        target: "process.env",
        message: `${source.relative} reads process environment from a contract module`
      });
    }
  }

  if (rules.has("executable-cycle")) {
    for (const cycle of findExecutableCycles(root, sourceFiles, sourceIndex, importsByFile)) {
      report({
        rule: "executable-cycle",
        source: cycle[0],
        target: cycle.join(" -> "),
        message: `executable import cycle: ${cycle.join(" -> ")}`
      });
    }
  }

  if (rules.has("durable-codec")) checkDurableCodecCoverage(root, sourceFiles, sourceIndex, report);
  if (rules.has("tool-registry")) checkToolRegistry(root, toolRegistryPath, sourceIndex, report);
  if (rules.has("size-budget")) checkSizeBudgets(root, budgetRoots, fileBudget, classBudget, report);

  if (rules.has("runtime-contract") && runtimeContractPath) {
    const absolute = path.join(root, runtimeContractPath);
    if (!fs.existsSync(absolute)) {
      report({
        rule: "runtime-contract",
        source: runtimeContractPath,
        message: `missing runtime contract: ${runtimeContractPath}`
      });
    } else {
      try {
        const contract = JSON.parse(fs.readFileSync(absolute, "utf8"));
        if (contract.schemaVersion !== 2) report({
          rule: "runtime-contract",
          source: runtimeContractPath,
          message: `${runtimeContractPath} must declare schemaVersion 2`
        });
      } catch (error) {
        report({
          rule: "runtime-contract",
          source: runtimeContractPath,
          message: `${runtimeContractPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }

  if (enforceStaleDebt) {
    for (const allowance of allowances) {
      if (!rules.has(allowance.rule) || consumedAllowances.has(allowance.id)) continue;
      failures.push(`stale architecture debt allowance ${allowance.id}; remove or update the explicit allowance`);
    }
  }

  return {
    failures: unique(failures),
    debts: debts.sort((left, right) => left.allowance.id.localeCompare(right.allowance.id))
  };
}

export function formatArchitectureResult(result) {
  const output = [];
  if (result.failures.length) {
    output.push("Architecture gate failed:");
    output.push(...result.failures.map((failure) => `- ${failure}`));
  } else {
    output.push(`Architecture gate passed${result.debts.length ? ` with ${result.debts.length} tracked debt item(s)` : ""}.`);
  }
  if (result.debts.length) {
    output.push("Active architecture debt (explicitly allowlisted; no silent skips):");
    output.push(...result.debts.map(formatDebt));
  }
  return output.join("\n");
}

function formatDebt(debt) {
  const { allowance } = debt;
  const measurement = debt.actual == null
    ? ""
    : ` actual=${debt.actual}, target=${debt.targetBudget}, ceiling=${allowance.ceiling}`;
  const target = debt.target ? ` -> ${debt.target}` : "";
  return `- [${debt.rule}] ${debt.source}${target}${debt.symbol ? `#${debt.symbol}` : ""};${measurement} tracking=${allowance.tracking}; reason=${allowance.reason}`;
}

function loadSources(root, roots) {
  const relatives = walkFiles(root, roots)
    .filter((relative) => SOURCE_EXTENSION.test(relative))
    .filter((relative) => !TEST_FILE.test(relative));
  return relatives.map((relative) => {
    const absolute = path.join(root, relative);
    const text = fs.readFileSync(absolute, "utf8");
    return {
      absolute,
      relative,
      text,
      ast: ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, scriptKind(relative))
    };
  });
}

function collectImports(source) {
  const imports = [];
  const add = (specifier, executable, node) => imports.push({
    specifier,
    executable,
    line: source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast)).line + 1
  });
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, importDeclarationIsExecutable(node), node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, exportDeclarationIsExecutable(node), node);
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)) {
      add(node.moduleReference.expression.text, !node.isTypeOnly, node);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        add(node.arguments[0].text, true, node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source.ast);
  return imports;
}

function importDeclarationIsExecutable(node) {
  if (!node.importClause) return true;
  if (node.importClause.isTypeOnly) return false;
  if (node.importClause.name) return true;
  const bindings = node.importClause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function exportDeclarationIsExecutable(node) {
  if (node.isTypeOnly) return false;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return true;
  return node.exportClause.elements.some((element) => !element.isTypeOnly);
}

function resolveReference(root, source, specifier, sourceIndex) {
  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) return { external: true };
  const base = path.resolve(path.dirname(source.absolute), specifier.split(/[?#]/, 1)[0]);
  for (const absolute of resolutionCandidates(base)) {
    const relative = normalize(path.relative(root, absolute));
    if (sourceIndex.has(relative)) return { relative, source: sourceIndex.get(relative) };
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return { relative };
  }
  return { relative: normalize(path.relative(root, rewriteJsExtension(base))) };
}

function resolutionCandidates(base) {
  const candidates = [base, rewriteJsExtension(base)];
  const extension = path.extname(base);
  if (!extension) {
    for (const suffix of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
      candidates.push(`${base}${suffix}`);
      candidates.push(path.join(base, `index${suffix}`));
    }
  }
  return unique(candidates);
}

function rewriteJsExtension(file) {
  return file.replace(/\.(?:mjs|cjs|js|jsx)$/i, (extension) => ({
    ".mjs": ".mts",
    ".cjs": ".cts",
    ".jsx": ".tsx"
  })[extension.toLowerCase()] ?? ".ts");
}

function isForbiddenServiceTarget(relative) {
  return relative.startsWith("adapters/")
    || relative.startsWith("deploy/")
    || relative.startsWith("tooling/")
    || relative.startsWith("src/admin/")
    || relative.startsWith("apps/admin-web/")
    || relative.startsWith("admin/");
}

function forbiddenContractDependency(target, specifier) {
  if (target.relative && /^(?:services|adapters|src)\//.test(target.relative)) {
    return "contract module depends on application or infrastructure code";
  }
  if (!target.external) return undefined;
  if (/^(?:fastify|@fastify\/)/.test(specifier)) return "contract module depends on Fastify";
  if (/sqlite/i.test(specifier)) return "contract module depends on SQLite";
  if (/^(?:dotenv|dotenv\/config)$/.test(specifier)) return "contract module depends on environment loading";
  return undefined;
}

function usesProcessEnvironment(source) {
  return /\bprocess\s*\.\s*env\b/.test(source.text)
    || /\bprocess\s*\[\s*["']env["']\s*\]/.test(source.text)
    || /\bprocess\s*\.\s*loadEnvFile\s*\(/.test(source.text);
}

function usesProcessCwd(ast) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "process"
      && node.expression.name.text === "cwd") {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

function serviceName(relative) {
  const match = /^services\/([^/]+)\//.exec(relative);
  return match?.[1];
}

function isPublicServiceEntry(relative) {
  const match = /^services\/[^/]+\/(.+)$/.exec(relative);
  return Boolean(match && PUBLIC_ENTRY.test(match[1]));
}

function findExecutableCycles(root, sourceFiles, sourceIndex, importsByFile) {
  const graph = new Map(sourceFiles.map((source) => [source.relative, []]));
  for (const source of sourceFiles) {
    const targets = graph.get(source.relative);
    for (const reference of importsByFile.get(source.relative) ?? []) {
      if (!reference.executable) continue;
      const target = resolveReference(root, source, reference.specifier, sourceIndex);
      if (target.relative && graph.has(target.relative)) targets.push(target.relative);
    }
  }

  const cycles = [];
  const state = new Map();
  const stack = [];
  const stackIndex = new Map();
  const seen = new Set();
  const visit = (node) => {
    state.set(node, 1);
    stackIndex.set(node, stack.length);
    stack.push(node);
    for (const target of graph.get(node) ?? []) {
      if (!state.has(target)) visit(target);
      else if (state.get(target) === 1) {
        const cycle = [...stack.slice(stackIndex.get(target)), target];
        const key = canonicalCycle(cycle.slice(0, -1));
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      }
    }
    stack.pop();
    stackIndex.delete(node);
    state.set(node, 2);
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return cycles;
}

function canonicalCycle(nodes) {
  const rotations = nodes.map((_, index) => [...nodes.slice(index), ...nodes.slice(0, index)].join(" -> "));
  return rotations.sort()[0] ?? "";
}

function checkDurableCodecCoverage(root, sourceFiles, sourceIndex, report) {
  for (const source of sourceFiles) {
    for (const sink of DURABLE_SINKS) {
      if (!sink.table.test(source.text) || !sink.jsonColumn.test(source.text)) continue;
      const contractImports = collectContractImportBindings(root, source, sourceIndex);
      const calls = collectCalls(source.ast);
      const hasEncode = calls.some((call) => contractImports.bindings.has(call.root)
        && /encode/i.test(call.name)
        && sink.entity.test(call.name));
      const hasDecode = calls.some((call) => contractImports.bindings.has(call.root)
        && /decode/i.test(call.name)
        && sink.entity.test(call.name));
      const versionedSource = [...contractImports.sources].some((relative) => {
        const contract = sourceIndex.get(relative);
        return contract && /\bschemaVersion\s*:\s*1\b/.test(contract.text);
      });
      if (hasEncode && hasDecode && versionedSource) continue;
      report({
        rule: "durable-codec",
        source: source.relative,
        target: sink.id,
        message: `${source.relative} persists ${sink.id} JSON without an imported versioned contract codec used for both encode and decode`
      });
    }
  }
}

function collectContractImportBindings(root, source, sourceIndex) {
  const bindings = new Set();
  const sources = new Set();
  for (const statement of source.ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const target = resolveReference(root, source, statement.moduleSpecifier.text, sourceIndex);
    if (!target.relative?.startsWith("packages/contracts/")) continue;
    sources.add(target.relative);
    const clause = statement.importClause;
    if (clause?.name) bindings.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bindings.add(clause.namedBindings.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) bindings.add(element.name.text);
    }
  }
  return { bindings, sources };
}

function collectCalls(ast) {
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = expressionName(node.expression);
      if (name) calls.push({ name, root: name.split(".", 1)[0] });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return calls;
}

function expressionName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return `${expressionName(expression.expression)}.${expression.name.text}`;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)) {
    return `${expressionName(expression.expression)}.${expression.argumentExpression.text}`;
  }
  return "";
}

function checkToolRegistry(root, relative, sourceIndex, report) {
  const source = sourceIndex.get(normalize(relative));
  if (!source) {
    report({ rule: "tool-registry", source: relative, message: `missing ToolRegistry source: ${relative}` });
    return;
  }
  let catalog;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "catalog") {
      catalog = unwrapExpression(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source.ast);
  if (!catalog || !ts.isArrayLiteralExpression(catalog)) {
    report({ rule: "tool-registry", source: relative, message: `${relative} must declare a statically auditable catalog array` });
    return;
  }

  const names = new Map();
  for (const [index, element] of catalog.elements.entries()) {
    const entry = unwrapExpression(element);
    if (!entry || !ts.isObjectLiteralExpression(entry)) {
      report({ rule: "tool-registry", source: relative, target: String(index), message: `${relative} catalog entry ${index} is not statically auditable` });
      continue;
    }
    const properties = objectProperties(entry);
    const definition = properties.get("definition");
    const execution = properties.get("execution") ?? properties.get("executor");
    const mode = execution ? staticString(execution.initializer, source, sourceIndex, root) : undefined;
    const name = properties.get("name")
      ? staticString(properties.get("name").initializer, source, sourceIndex, root)
      : undefined;
    const label = name ?? `entry ${index}`;
    if (definition && !execution) report({
      rule: "tool-registry",
      source: relative,
      target: label,
      message: `${relative} tool ${label} has a model definition without execution`
    });
    if (definition && mode === "external") report({
      rule: "tool-registry",
      source: relative,
      target: label,
      message: `${relative} tool ${label} has a model definition but is marked external`
    });
    if (!definition && mode && mode !== "external") report({
      rule: "tool-registry",
      source: relative,
      target: label,
      message: `${relative} tool ${label} declares ${mode} execution without a model definition`
    });
    if (execution && !mode && properties.has("execution")) report({
      rule: "tool-registry",
      source: relative,
      target: label,
      message: `${relative} tool ${label} execution mode is not statically auditable`
    });
    if (name) {
      if (names.has(name)) report({
        rule: "tool-registry",
        source: relative,
        target: name,
        message: `${relative} contains duplicate tool name ${name}`
      });
      names.set(name, index);
    }
  }
}

function objectProperties(node) {
  const output = new Map();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) continue;
    const name = propertyName(property.name);
    if (name) output.set(name, property);
  }
  return output;
}

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ? node.text : undefined;
}

function unwrapExpression(node) {
  let current = node;
  while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))) {
    current = current.expression;
  }
  return current;
}

function staticString(node, source, sourceIndex, root, seen = new Set()) {
  const expression = unwrapExpression(node);
  if (!expression) return undefined;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (!ts.isIdentifier(expression) || seen.has(`${source.relative}:${expression.text}`)) return undefined;
  seen.add(`${source.relative}:${expression.text}`);
  for (const statement of source.ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === expression.text && declaration.initializer) {
          return staticString(declaration.initializer, source, sourceIndex, root, seen);
        }
      }
    }
    if (ts.isImportDeclaration(statement) && statement.importClause && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const bindings = statement.importClause.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const imported = bindings.elements.find((element) => element.name.text === expression.text);
      if (!imported) continue;
      const target = resolveReference(root, source, statement.moduleSpecifier.text, sourceIndex);
      const targetSource = target.relative ? sourceIndex.get(target.relative) : undefined;
      if (!targetSource) return undefined;
      const targetName = imported.propertyName?.text ?? imported.name.text;
      return staticExportedString(targetName, targetSource, sourceIndex, root, seen);
    }
  }
  return undefined;
}

function staticExportedString(name, source, sourceIndex, root, seen) {
  for (const statement of source.ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return staticString(declaration.initializer, source, sourceIndex, root, seen);
      }
    }
  }
  return undefined;
}

function checkSizeBudgets(root, roots, fileBudget, classBudget, report) {
  for (const relative of walkFiles(root, roots).filter((file) => SOURCE_EXTENSION.test(file) && !TEST_FILE.test(file))) {
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    const lines = text.split(/\r\n|\r|\n/).length;
    if (lines >= fileBudget) report({
      rule: "file-lines",
      source: relative,
      actual: lines,
      targetBudget: `<${fileBudget}`,
      message: `${relative} has ${lines} lines; file target is <${fileBudget}`
    });

    const ast = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, scriptKind(relative));
    const visit = (node) => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const start = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
        const end = ast.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        const classLines = end - start + 1;
        const symbol = node.name?.text ?? `<anonymous@${start}>`;
        if (classLines >= classBudget) report({
          rule: "class-lines",
          source: relative,
          symbol,
          actual: classLines,
          targetBudget: `<${classBudget}`,
          message: `${relative}#${symbol} has ${classLines} lines; class target is <${classBudget}`
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
}

function matchesAllowance(allowance, violation) {
  if (allowance.rule !== violation.rule) return false;
  for (const key of ["source", "target", "symbol"]) {
    if (allowance[key] != null && allowance[key] !== violation[key]) return false;
  }
  return true;
}

function walkFiles(root, roots) {
  const output = [];
  for (const relativeRoot of roots) visit(normalize(relativeRoot));
  return output;

  function visit(relative) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = normalize(path.join(relative, entry.name));
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") visit(child);
      else if (entry.isFile()) output.push(child);
    }
  }
}

function scriptKind(relative) {
  if (/\.tsx$/i.test(relative)) return ts.ScriptKind.TSX;
  if (/\.(?:js|mjs|cjs)$/i.test(relative)) return ts.ScriptKind.JS;
  if (/\.jsx$/i.test(relative)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

function normalize(value) {
  return value.replaceAll("\\", "/");
}

function unique(values) {
  return [...new Set(values)];
}
