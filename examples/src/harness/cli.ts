import { cac } from "cac";

export interface BasicExampleCliOptions {
  readonly turns: readonly string[];
}

export interface WorkspaceContextsExampleCliOptions {
  readonly query: string;
  readonly workspace: string | undefined;
  readonly context: string | undefined;
}

export function readBasicExampleCli(defaultQuery: string): BasicExampleCliOptions {
  const cli = cac("pragma-example-basic");

  cli
    .command("[query...]", "Task query to send to the ExpertAgent.")
    .option("--turn <query>", "Independent task query. Repeat to start multiple Workflows.");
  cli.help();

  const parsed = cli.parse();
  exitAfterHelpOrVersion(parsed.options);

  return {
    turns: readBasicTurns(parsed.args, parsed.options.turn, defaultQuery),
  };
}

export function readWorkspaceContextsExampleCli(
  defaultQuery: string,
): WorkspaceContextsExampleCliOptions {
  const cli = cac("pragma-example-workspace-context");

  cli
    .command("[query...]", "Task query to send to the ExpertAgent.")
    .option("--workspace <dir>", "Workspace directory available to the ExpertAgent.")
    .option("--context <dir>", "Markdown context directory for FileSystemContextStore.");
  cli.help();

  const parsed = cli.parse();
  exitAfterHelpOrVersion(parsed.options);

  return {
    query: readQueryArgument(parsed.args, defaultQuery),
    workspace: readStringOption(parsed.options.workspace),
    context: readStringOption(parsed.options.context),
  };
}

function exitAfterHelpOrVersion(options: Readonly<Record<string, unknown>>): void {
  if (options.help === true || options.version === true) {
    process.exit(0);
  }
}

function readQueryArgument(args: readonly unknown[], defaultQuery: string): string {
  const query = args
    .filter((arg): arg is string => typeof arg === "string")
    .join(" ")
    .trim();

  return query.length > 0 ? query : defaultQuery;
}

function readBasicTurns(
  args: readonly unknown[],
  turnOption: unknown,
  defaultQuery: string,
): readonly string[] {
  const turns = readStringListOption(turnOption);

  if (turns.length > 0) {
    return turns;
  }

  return [readQueryArgument(args, defaultQuery)];
}

function readStringListOption(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  const stringValue = readStringOption(value);

  return stringValue === undefined ? [] : [stringValue];
}

function readStringOption(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}
