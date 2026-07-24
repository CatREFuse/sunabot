import {
  readCommandInvocationV1,
  validCommandInvocationIdV1,
  type CommandInvocationV1
} from "../../packages/contracts/messaging/commands.js";

export type CommandInvocation = CommandInvocationV1;

export interface CommandDefinition<Context, Result = void> {
  id: string;
  names: string[];
  handler: (context: Context, invocation: CommandInvocation) => Promise<Result>;
}

export interface CommandMatch<Context, Result = void> extends CommandInvocation {
  definition: CommandDefinition<Context, Result>;
}

export function commandInvocationSnapshot(invocation: CommandInvocation): CommandInvocation {
  const snapshot = readCommandInvocationV1({
    id: invocation.id,
    invokedName: invocation.invokedName,
    args: invocation.args,
    rawText: invocation.rawText
  });
  if (!snapshot) throw new Error("Invalid command invocation.");
  return snapshot;
}

export class CommandRouter<Context, Result = void> {
  private readonly definitionsByName = new Map<string, CommandDefinition<Context, Result>>();
  private readonly definitionsById = new Map<string, CommandDefinition<Context, Result>>();

  constructor(definitions: Array<CommandDefinition<Context, Result>>) {
    for (const definition of definitions) {
      if (!validCommandInvocationIdV1(definition.id)) throw new Error("Command id is invalid.");
      if (this.definitionsById.has(definition.id)) {
        throw new Error(`Duplicate command id: ${definition.id}`);
      }
      if (!definition.names.length) throw new Error(`Command ${definition.id} requires at least one name.`);
      for (const rawName of definition.names) {
        const name = normalizeCommandName(rawName);
        if (!name) throw new Error(`Command ${definition.id} contains an empty name.`);
        if (this.definitionsByName.has(name)) {
          throw new Error(`Duplicate command name: ${rawName}`);
        }
        this.definitionsByName.set(name, definition);
      }
      this.definitionsById.set(definition.id, definition);
    }
  }

  match(text: string, botNames: string[] = []): CommandMatch<Context, Result> | undefined {
    const parsed = parseCommandText(text);
    if (!parsed) return undefined;
    if (!parsed.botName) return undefined;
    if (parsed.botName && !botNames.some((name) => normalizeCommandName(name) === normalizeCommandName(parsed.botName))) {
      return undefined;
    }
    const definition = this.definitionsByName.get(normalizeCommandName(parsed.name));
    if (!definition) return undefined;
    const invocation = readCommandInvocationV1({
      id: definition.id,
      invokedName: parsed.name,
      args: parsed.args,
      rawText: text
    });
    if (!invocation) throw new Error("Matched command invocation exceeds durable limits.");
    return { ...invocation, definition };
  }

  restore(invocation: CommandInvocation): CommandMatch<Context, Result> {
    const definition = this.definitionsById.get(invocation.id);
    if (!definition) throw new Error(`Unknown command id: ${invocation.id}`);
    const snapshot = commandInvocationSnapshot(invocation);
    if (!parseCommandText(snapshot.rawText)?.botName) {
      throw new Error("Command invocation must target a bot.");
    }
    return {
      ...snapshot,
      definition
    };
  }

  dispatch(match: CommandMatch<Context, Result>, context: Context) {
    return match.definition.handler(context, commandInvocationSnapshot(match));
  }
}

function parseCommandText(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") && !trimmed.startsWith("／")) return undefined;
  const commandText = trimmed.slice(1);
  const tokenMatch = commandText.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  if (!tokenMatch) return undefined;
  const token = tokenMatch[1] ?? "";
  const atIndex = token.lastIndexOf("@");
  const name = atIndex > 0 ? token.slice(0, atIndex) : token;
  const botName = atIndex > 0 ? token.slice(atIndex + 1) : "";
  if (!name || (atIndex > 0 && !botName)) return undefined;
  return {
    name,
    botName,
    args: (tokenMatch[2] ?? "").trim()
  };
}

function normalizeCommandName(value: string) {
  return value
    .trim()
    .replace(/^[／/]+/, "")
    .toLocaleLowerCase("en-US");
}
