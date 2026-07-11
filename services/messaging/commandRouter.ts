export interface CommandInvocation {
  id: string;
  invokedName: string;
  args: string;
  rawText: string;
}

export interface CommandDefinition<Context, Result = void> {
  id: string;
  names: string[];
  handler: (context: Context, invocation: CommandInvocation) => Promise<Result>;
}

export interface CommandMatch<Context, Result = void> extends CommandInvocation {
  definition: CommandDefinition<Context, Result>;
}

export class CommandRouter<Context, Result = void> {
  private readonly definitionsByName = new Map<string, CommandDefinition<Context, Result>>();

  constructor(definitions: Array<CommandDefinition<Context, Result>>) {
    for (const definition of definitions) {
      if (!definition.id.trim()) throw new Error("Command id is required.");
      if (!definition.names.length) throw new Error(`Command ${definition.id} requires at least one name.`);
      for (const rawName of definition.names) {
        const name = normalizeCommandName(rawName);
        if (!name) throw new Error(`Command ${definition.id} contains an empty name.`);
        if (this.definitionsByName.has(name)) {
          throw new Error(`Duplicate command name: ${rawName}`);
        }
        this.definitionsByName.set(name, definition);
      }
    }
  }

  match(text: string, botNames: string[] = []): CommandMatch<Context, Result> | undefined {
    const parsed = parseCommandText(text);
    if (!parsed) return undefined;
    if (parsed.botName && !botNames.some((name) => normalizeCommandName(name) === normalizeCommandName(parsed.botName))) {
      return undefined;
    }
    const definition = this.definitionsByName.get(normalizeCommandName(parsed.name));
    if (!definition) return undefined;
    return {
      id: definition.id,
      invokedName: parsed.name,
      args: parsed.args,
      rawText: text,
      definition
    };
  }

  dispatch(match: CommandMatch<Context, Result>, context: Context) {
    return match.definition.handler(context, {
      id: match.id,
      invokedName: match.invokedName,
      args: match.args,
      rawText: match.rawText
    });
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
