import { cac } from "cac";

export interface BasicExampleCliOptions {
  readonly turns: readonly string[];
  readonly runtimeSessionId: string | undefined;
  readonly systemSessionId: string | undefined;
}

export interface WorkspaceDocumentsExampleCliOptions {
  readonly query: string;
  readonly workspace: string | undefined;
  readonly documents: string | undefined;
}

export function readBasicExampleCli(defaultQuery: string): BasicExampleCliOptions {
  const cli = cac("expertmesh-example-basic");

  cli
    .command("[query...]", "Task query to send to the ExpertAgent.")
    .option("--turn <query>", "Task query to submit. Repeat this option for multi-turn tests.")
    .option("--runtime-session-id <id>", "Resume or create the runtime session with this id.")
    .option("--system-session-id <id>", "Use a fixed ExpertMesh system session id.");
  cli.help();

  const parsed = cli.parse();
  exitAfterHelpOrVersion(parsed.options);

  return {
    turns: readBasicTurns(parsed.args, parsed.options.turn, defaultQuery),
    runtimeSessionId: readStringOption(parsed.options.runtimeSessionId),
    systemSessionId: readStringOption(parsed.options.systemSessionId),
  };
}

export function readWorkspaceDocumentsExampleCli(
  defaultQuery: string,
): WorkspaceDocumentsExampleCliOptions {
  const cli = cac("expertmesh-example-workspace-documents");

  cli
    .command("[query...]", "Task query to send to the ExpertAgent.")
    .option("--workspace <dir>", "Workspace directory available to the ExpertAgent.")
    .option("--documents <dir>", "Markdown document directory for FileSystemDocumentStore.");
  cli.help();

  const parsed = cli.parse();
  exitAfterHelpOrVersion(parsed.options);

  return {
    query: readQueryArgument(parsed.args, defaultQuery),
    workspace: readStringOption(parsed.options.workspace),
    documents: readStringOption(parsed.options.documents),
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
