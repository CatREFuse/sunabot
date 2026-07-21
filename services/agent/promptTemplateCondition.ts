const MAX_CONDITION_EXPRESSION_CHARS = 512;
const MAX_CONDITION_TOKENS = 128;
const MAX_CONDITION_DEPTH = 32;

type PromptConditionPrimitive = string | number | boolean | null;
type PromptConditionOperator = "&&" | "||" | "==" | "!=" | "===" | "!==" | "<" | "<=" | ">" | ">=" | "!";

type PromptConditionExpression =
  | { kind: "literal"; value: PromptConditionPrimitive }
  | { kind: "variable"; name: string }
  | { kind: "not"; value: PromptConditionExpression }
  | {
      kind: "binary";
      operator: Exclude<PromptConditionOperator, "!">;
      left: PromptConditionExpression;
      right: PromptConditionExpression;
    };

type PromptConditionToken =
  | { kind: "literal"; value: PromptConditionPrimitive; at: number }
  | { kind: "identifier"; value: string; at: number }
  | { kind: "operator"; value: PromptConditionOperator; at: number }
  | { kind: "leftParen" | "rightParen" | "eof"; at: number };

interface PromptMarkupTag {
  start: number;
  end: number;
  raw: string;
  name: string;
  kind: "open" | "close" | "selfClosing";
  condition?: {
    expression: string;
    start: number;
    end: number;
  };
}

export class PromptConditionError extends Error {
  constructor(
    public readonly code: "PROMPT_CONDITION_INVALID" | "PROMPT_CONDITION_TAG_INVALID" | "PROMPT_CONDITION_VALUE_INVALID",
    message: string,
    public readonly variable?: string
  ) {
    super(message);
    this.name = "PromptConditionError";
  }
}

export function validatePromptConditionals(content: string) {
  transformPromptConditionals(content, (expression) => {
    parsePromptConditionExpression(expression);
    return true;
  });
}

export function extractPromptConditionalVariables(content: string) {
  const variables: string[] = [];
  const seen = new Set<string>();
  transformPromptConditionals(content, (expression) => {
    collectPromptConditionVariables(parsePromptConditionExpression(expression), variables, seen);
    return true;
  });
  return variables;
}

export function renderPromptConditionals(
  content: string,
  resolve: (name: string) => unknown
) {
  return transformPromptConditionals(content, (expression) => (
    evaluatePromptConditionExpression(parsePromptConditionExpression(expression), resolve)
  ));
}

function transformPromptConditionals(
  content: string,
  evaluate: (expression: string) => boolean
): string {
  let rendered = "";
  let cursor = 0;
  while (cursor < content.length) {
    const opening = findNextConditionalTag(content, cursor);
    if (!opening) return rendered + content.slice(cursor);
    rendered += content.slice(cursor, opening.start);
    const enabled = evaluate(decodeConditionAttribute(opening.condition!.expression));
    if (opening.kind === "selfClosing") {
      if (enabled) rendered += stripConditionAttribute(opening);
      cursor = opening.end;
      continue;
    }
    const closing = findClosingTag(content, opening);
    const inner = content.slice(opening.end, closing.start);
    if (enabled) {
      rendered += stripConditionAttribute(opening);
      rendered += transformPromptConditionals(inner, evaluate);
      rendered += closing.raw;
    }
    cursor = closing.end;
  }
  return rendered;
}

function findNextConditionalTag(content: string, from: number) {
  let cursor = from;
  while (cursor < content.length) {
    const start = content.indexOf("<", cursor);
    if (start < 0) return undefined;
    const tag = readMarkupTag(content, start);
    if (!tag) {
      if (/^<\s*[A-Za-z][\w:.-]*[^>]*\bs-if\b/u.test(content.slice(start))) {
        throw conditionTagError("s-if 标签起始语法无效。");
      }
      cursor = start + 1;
      continue;
    }
    if (tag.condition) return tag;
    cursor = tag.end;
  }
  return undefined;
}

function findClosingTag(content: string, opening: PromptMarkupTag) {
  let depth = 1;
  let cursor = opening.end;
  while (cursor < content.length) {
    const start = content.indexOf("<", cursor);
    if (start < 0) break;
    const tag = readMarkupTag(content, start);
    if (!tag) {
      cursor = start + 1;
      continue;
    }
    cursor = tag.end;
    if (tag.name !== opening.name) continue;
    if (tag.kind === "open") depth += 1;
    if (tag.kind === "close") depth -= 1;
    if (depth === 0) return tag;
  }
  throw conditionTagError(`<${opening.name}> 的 s-if 条件块缺少闭合标签。`);
}

function readMarkupTag(content: string, start: number): PromptMarkupTag | undefined {
  let quote = "";
  let end = -1;
  for (let index = start + 1; index < content.length; index += 1) {
    const character = content[index]!;
    if (quote) {
      if (character === quote && content[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") {
      end = index + 1;
      break;
    }
    if (character === "\n" || character === "\r") return undefined;
  }
  if (end < 0 || quote) return undefined;
  const raw = content.slice(start, end);
  const closing = raw.match(/^<\s*\/\s*([A-Za-z][\w:.-]*)\s*>$/u);
  if (closing) {
    return { start, end, raw, name: closing[1]!, kind: "close" };
  }
  const opening = raw.match(/^<\s*([A-Za-z][\w:.-]*)/u);
  if (!opening) return undefined;
  const selfClosing = /\/\s*>$/u.test(raw);
  const tag: PromptMarkupTag = {
    start,
    end,
    raw,
    name: opening[1]!,
    kind: selfClosing ? "selfClosing" : "open"
  };
  if (/\s+s-if(?:\s*=|\s|\/?>)/u.test(raw)) tag.condition = parseConditionAttribute(raw, opening[0].length);
  return tag;
}

function parseConditionAttribute(raw: string, start: number) {
  let cursor = start;
  let condition: PromptMarkupTag["condition"];
  while (cursor < raw.length) {
    const whitespaceStart = cursor;
    while (/\s/u.test(raw[cursor] ?? "")) cursor += 1;
    if (raw[cursor] === ">" || (raw[cursor] === "/" && /^\/\s*>$/u.test(raw.slice(cursor)))) break;
    const name = raw.slice(cursor).match(/^([A-Za-z_:][\w:.-]*)/u)?.[1];
    if (!name) throw conditionTagError("s-if 标签属性语法无效。");
    cursor += name.length;
    while (/\s/u.test(raw[cursor] ?? "")) cursor += 1;
    if (raw[cursor] !== "=") throw conditionTagError(`s-if 标签属性 ${name} 缺少值。`);
    cursor += 1;
    while (/\s/u.test(raw[cursor] ?? "")) cursor += 1;
    const quote = raw[cursor];
    if (quote !== '"' && quote !== "'") throw conditionTagError(`s-if 标签属性 ${name} 必须使用引号。`);
    cursor += 1;
    const valueStart = cursor;
    while (cursor < raw.length && raw[cursor] !== quote) cursor += 1;
    if (cursor >= raw.length) throw conditionTagError(`s-if 标签属性 ${name} 缺少结束引号。`);
    const value = raw.slice(valueStart, cursor);
    cursor += 1;
    if (name !== "s-if") continue;
    if (condition) throw conditionTagError("同一标签只能包含一个 s-if 属性。");
    condition = { expression: value, start: whitespaceStart, end: cursor };
  }
  if (!condition) throw conditionTagError("s-if 标签属性语法无效。");
  return condition;
}

function stripConditionAttribute(tag: PromptMarkupTag) {
  const condition = tag.condition!;
  return `${tag.raw.slice(0, condition.start)}${tag.raw.slice(condition.end)}`
    .replace(/\s+(\/?>)$/u, "$1");
}

function decodeConditionAttribute(value: string) {
  return value.replace(/&(amp|quot|apos|lt|gt);/gu, (_token, entity: string) => ({
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">"
  })[entity] ?? _token);
}

function parsePromptConditionExpression(value: string) {
  if (!value.trim()) throw conditionExpressionError("s-if 表达式不能为空。");
  if (value.length > MAX_CONDITION_EXPRESSION_CHARS) {
    throw conditionExpressionError(`s-if 表达式最多 ${MAX_CONDITION_EXPRESSION_CHARS} 个字符。`);
  }
  const parser = new PromptConditionParser(tokenizePromptCondition(value));
  return parser.parse();
}

class PromptConditionParser {
  private cursor = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly PromptConditionToken[]) {}

  parse() {
    const expression = this.parseOr();
    const token = this.peek();
    if (token.kind !== "eof") throw conditionExpressionError(`s-if 表达式在第 ${token.at + 1} 个字符附近无效。`);
    return expression;
  }

  private parseOr(): PromptConditionExpression {
    let left = this.parseAnd();
    while (this.matchOperator("||")) {
      left = { kind: "binary", operator: "||", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): PromptConditionExpression {
    let left = this.parseEquality();
    while (this.matchOperator("&&")) {
      left = { kind: "binary", operator: "&&", left, right: this.parseEquality() };
    }
    return left;
  }

  private parseEquality(): PromptConditionExpression {
    let left = this.parseComparison();
    while (true) {
      const operator = this.matchAnyOperator(["===", "!==", "==", "!="] as const);
      if (!operator) return left;
      left = { kind: "binary", operator, left, right: this.parseComparison() };
    }
  }

  private parseComparison(): PromptConditionExpression {
    let left = this.parseUnary();
    while (true) {
      const operator = this.matchAnyOperator(["<=", ">=", "<", ">"] as const);
      if (!operator) return left;
      left = { kind: "binary", operator, left, right: this.parseUnary() };
    }
  }

  private parseUnary(): PromptConditionExpression {
    if (this.matchOperator("!")) return { kind: "not", value: this.parseUnary() };
    return this.parsePrimary();
  }

  private parsePrimary(): PromptConditionExpression {
    const token = this.peek();
    if (token.kind === "literal") {
      this.cursor += 1;
      return { kind: "literal", value: token.value };
    }
    if (token.kind === "identifier") {
      this.cursor += 1;
      return { kind: "variable", name: token.value };
    }
    if (token.kind === "leftParen") {
      this.cursor += 1;
      this.depth += 1;
      if (this.depth > MAX_CONDITION_DEPTH) throw conditionExpressionError("s-if 表达式括号嵌套过深。");
      const expression = this.parseOr();
      this.depth -= 1;
      if (this.peek().kind !== "rightParen") throw conditionExpressionError("s-if 表达式缺少右括号。");
      this.cursor += 1;
      return expression;
    }
    throw conditionExpressionError(`s-if 表达式在第 ${token.at + 1} 个字符附近缺少值。`);
  }

  private matchOperator(value: PromptConditionOperator) {
    const token = this.peek();
    if (token.kind !== "operator" || token.value !== value) return false;
    this.cursor += 1;
    return true;
  }

  private matchAnyOperator<const T extends readonly PromptConditionOperator[]>(values: T): T[number] | undefined {
    const token = this.peek();
    if (token.kind !== "operator" || !values.includes(token.value)) return undefined;
    this.cursor += 1;
    return token.value as T[number];
  }

  private peek() {
    return this.tokens[this.cursor] ?? this.tokens[this.tokens.length - 1]!;
  }
}

function tokenizePromptCondition(value: string) {
  const tokens: PromptConditionToken[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    if (/\s/u.test(value[cursor]!)) {
      cursor += 1;
      continue;
    }
    const at = cursor;
    const operator = (["!==", "===", "&&", "||", "==", "!=", "<=", ">=", "<", ">", "!"] as const)
      .find((candidate) => value.startsWith(candidate, cursor));
    if (operator) {
      tokens.push({ kind: "operator", value: operator, at });
      cursor += operator.length;
      continue;
    }
    if (value[cursor] === "(") {
      tokens.push({ kind: "leftParen", at });
      cursor += 1;
      continue;
    }
    if (value[cursor] === ")") {
      tokens.push({ kind: "rightParen", at });
      cursor += 1;
      continue;
    }
    const quote = value[cursor];
    if (quote === '"' || quote === "'") {
      const parsed = readStringLiteral(value, cursor, quote);
      tokens.push({ kind: "literal", value: parsed.value, at });
      cursor = parsed.end;
      continue;
    }
    const number = value.slice(cursor).match(/^-?(?:\d+(?:\.\d+)?|\.\d+)/u)?.[0];
    if (number) {
      const parsed = Number(number);
      if (!Number.isFinite(parsed)) throw conditionExpressionError("s-if 数字字面量无效。");
      tokens.push({ kind: "literal", value: parsed, at });
      cursor += number.length;
      continue;
    }
    const identifier = value.slice(cursor).match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/u)?.[0];
    if (identifier) {
      if (identifier === "true" || identifier === "false") {
        tokens.push({ kind: "literal", value: identifier === "true", at });
      } else if (identifier === "null") {
        tokens.push({ kind: "literal", value: null, at });
      } else {
        tokens.push({ kind: "identifier", value: identifier, at });
      }
      cursor += identifier.length;
      continue;
    }
    throw conditionExpressionError(`s-if 表达式在第 ${cursor + 1} 个字符包含不支持的语法。`);
  }
  if (tokens.length > MAX_CONDITION_TOKENS) throw conditionExpressionError("s-if 表达式过于复杂。");
  tokens.push({ kind: "eof", at: value.length });
  return tokens;
}

function readStringLiteral(value: string, start: number, quote: string) {
  let decoded = "";
  for (let cursor = start + 1; cursor < value.length; cursor += 1) {
    const character = value[cursor]!;
    if (character === quote) return { value: decoded, end: cursor + 1 };
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    cursor += 1;
    if (cursor >= value.length) break;
    const escaped = value[cursor]!;
    decoded += ({ n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"', "'": "'" } as Record<string, string>)[escaped] ?? escaped;
  }
  throw conditionExpressionError("s-if 字符串字面量缺少结束引号。");
}

function collectPromptConditionVariables(
  expression: PromptConditionExpression,
  variables: string[],
  seen: Set<string>
) {
  if (expression.kind === "variable") {
    if (!seen.has(expression.name)) {
      seen.add(expression.name);
      variables.push(expression.name);
    }
    return;
  }
  if (expression.kind === "not") {
    collectPromptConditionVariables(expression.value, variables, seen);
    return;
  }
  if (expression.kind !== "binary") return;
  collectPromptConditionVariables(expression.left, variables, seen);
  collectPromptConditionVariables(expression.right, variables, seen);
}

function evaluatePromptConditionExpression(
  expression: PromptConditionExpression,
  resolve: (name: string) => unknown
): boolean {
  const result = evaluatePromptConditionValue(expression, resolve);
  if (typeof result !== "boolean") throw conditionValueError("s-if 表达式的最终结果必须是 boolean。");
  return result;
}

function evaluatePromptConditionValue(
  expression: PromptConditionExpression,
  resolve: (name: string) => unknown
): PromptConditionPrimitive {
  if (expression.kind === "literal") return expression.value;
  if (expression.kind === "variable") return conditionPrimitive(resolve(expression.name), expression.name);
  if (expression.kind === "not") {
    const value = evaluatePromptConditionValue(expression.value, resolve);
    if (typeof value !== "boolean") throw conditionValueError("s-if 的 ! 只能用于 boolean。");
    return !value;
  }
  if (expression.operator === "&&" || expression.operator === "||") {
    const left = evaluatePromptConditionValue(expression.left, resolve);
    if (typeof left !== "boolean") throw conditionValueError(`s-if 的 ${expression.operator} 两侧必须是 boolean。`);
    if (expression.operator === "&&" && !left) return false;
    if (expression.operator === "||" && left) return true;
    const right = evaluatePromptConditionValue(expression.right, resolve);
    if (typeof right !== "boolean") throw conditionValueError(`s-if 的 ${expression.operator} 两侧必须是 boolean。`);
    return right;
  }
  const left = evaluatePromptConditionValue(expression.left, resolve);
  const right = evaluatePromptConditionValue(expression.right, resolve);
  if (expression.operator === "==" || expression.operator === "===") return left === right;
  if (expression.operator === "!=" || expression.operator === "!==") return left !== right;
  if (typeof left === "number" && typeof right === "number") {
    if (expression.operator === "<") return left < right;
    if (expression.operator === "<=") return left <= right;
    if (expression.operator === ">") return left > right;
    return left >= right;
  }
  if (typeof left === "string" && typeof right === "string") {
    if (expression.operator === "<") return left < right;
    if (expression.operator === "<=") return left <= right;
    if (expression.operator === ">") return left > right;
    return left >= right;
  }
  throw conditionValueError(`s-if 的 ${expression.operator} 两侧必须是同类型 number 或 string。`);
}

function conditionPrimitive(value: unknown, name: string): PromptConditionPrimitive {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) throw conditionValueError(`s-if 变量 ${name} 不是有限数字。`, name);
    return value;
  }
  throw conditionValueError(`s-if 变量 ${name} 必须是 boolean、string、number 或 null。`, name);
}

function conditionExpressionError(message: string) {
  return new PromptConditionError("PROMPT_CONDITION_INVALID", message);
}

function conditionTagError(message: string) {
  return new PromptConditionError("PROMPT_CONDITION_TAG_INVALID", message);
}

function conditionValueError(message: string, variable?: string) {
  return new PromptConditionError("PROMPT_CONDITION_VALUE_INVALID", message, variable);
}
