import { createIntegrationError, type IntegrationError } from "@pragma/shared/integration";
import { Command, CommanderError, Option } from "commander";
import { isAbsolute } from "node:path";

export type OutputFormat = "text" | "json" | "jsonl";
export type ColorMode = "auto" | "always" | "never";
export type InteractiveMode = "auto" | "always" | "never";
export type ExecutorKind = "team" | "expert" | "flow";

export interface GlobalCliOptions {
  readonly format: OutputFormat;
  readonly color: ColorMode;
  readonly interactive: InteractiveMode;
}

export type ParsedCommand =
  | { readonly kind: "help"; readonly text?: string | undefined }
  | { readonly kind: "version" }
  | { readonly kind: "doctor" }
  | { readonly kind: "completion"; readonly shell: CompletionShell }
  | {
      readonly kind: "source-init";
      readonly directory: string;
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly kind: "source-add";
      readonly directory: string;
      readonly bundlePath: string;
    }
  | { readonly kind: "source-upgrade"; readonly directory: string }
  | {
      readonly kind: "executor-discover";
      readonly executorKind: ExecutorKind;
      readonly selector?: string | undefined;
      readonly project?: string | undefined;
      readonly query?: string | undefined;
      readonly status?: ExecutorStatus | undefined;
      readonly limit: number;
      readonly cursor?: string | undefined;
    }
  | {
      readonly kind: "executor-describe";
      readonly executorKind: ExecutorKind;
      readonly ref: string;
      readonly revision?: number | undefined;
    }
  | {
      readonly kind: "executor-run";
      readonly executorKind: ExecutorKind;
      readonly ref: string;
      readonly workspace: string;
      readonly prompt?: string | undefined;
      readonly inputPath?: string | undefined;
      readonly inputJsonPath?: string | undefined;
      readonly project?: string | undefined;
      readonly revision?: number | undefined;
      readonly expectedFingerprint?: string | undefined;
      readonly requestId?: string | undefined;
      readonly detach: boolean;
    }
  | {
      readonly kind: "mission-list";
      readonly status?: MissionStatusFilter | undefined;
      readonly executor?: string | undefined;
      readonly limit: number;
      readonly cursor?: string | undefined;
    }
  | {
      readonly kind: "mission-get";
      readonly missionId: string;
      readonly view: MissionView;
      readonly limit: number;
      readonly cursor?: string | undefined;
    }
  | {
      readonly kind: "mission-watch";
      readonly missionId: string;
      readonly after?: string | undefined;
      readonly replay?: number | undefined;
      readonly until?: "terminal" | "input-required" | undefined;
    }
  | {
      readonly kind: "mission-resume";
      readonly missionId: string;
      readonly project?: string | undefined;
      readonly revision?: number | undefined;
      readonly expectedFingerprint?: string | undefined;
      readonly requestId?: string | undefined;
      readonly detach?: boolean | undefined;
    }
  | {
      readonly kind: "mission-send" | "mission-steer";
      readonly missionId: string;
      readonly prompt?: string | undefined;
      readonly inputPath?: string | undefined;
      readonly expectedExecutionId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly wait: boolean;
      readonly detach: boolean;
      readonly ackTimeoutSeconds: number;
    }
  | {
      readonly kind: "mission-respond";
      readonly missionId: string;
      readonly interactionId: string;
      readonly answer?: string | undefined;
      readonly choices?: readonly string[] | undefined;
      readonly answersPath?: string | undefined;
      readonly requestId?: string | undefined;
      readonly wait: boolean;
      readonly detach: boolean;
      readonly ackTimeoutSeconds: number;
    }
  | {
      readonly kind: "mission-interrupt";
      readonly missionId: string;
      readonly expectedExecutionId?: string | undefined;
      readonly reason?: string | undefined;
      readonly requestId?: string | undefined;
      readonly wait: boolean;
      readonly detach: boolean;
      readonly ackTimeoutSeconds: number;
    }
  | {
      readonly kind: "queue-remove";
      readonly missionId: string;
      readonly requestIdToRemove: string;
      readonly requestId?: string | undefined;
      readonly ackTimeoutSeconds: number;
    }
  | {
      readonly kind: "queue-resume";
      readonly missionId: string;
      readonly requestId?: string | undefined;
      readonly ackTimeoutSeconds: number;
    }
  | {
      readonly kind: "queue-steer";
      readonly missionId: string;
      readonly requestIdToSteer: string;
      readonly expectedExecutionId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly wait: boolean;
      readonly detach: boolean;
      readonly ackTimeoutSeconds: number;
    }
  | {
      readonly kind: "board-list";
      readonly missionId: string;
      readonly limit: number;
      readonly cursor?: string | undefined;
    }
  | {
      readonly kind: "board-read";
      readonly missionId: string;
      readonly contextId: string;
      readonly start: number;
      readonly maxBytes: number;
    }
  | {
      readonly kind: "board-search";
      readonly missionId: string;
      readonly query: string;
      readonly caseSensitive: boolean;
      readonly contextLines: number;
      readonly maxResults: number;
    }
  | {
      readonly kind: "queue-list";
      readonly missionId: string;
      readonly limit: number;
      readonly cursor?: string | undefined;
    };

export interface ParsedCli {
  readonly options: GlobalCliOptions;
  readonly command: ParsedCommand;
}

export type CompletionShell = "bash" | "zsh" | "fish" | "powershell";
export type ExecutorStatus = "ready" | "needs_attention" | "unavailable";
export type MissionStatusFilter =
  "active" | "completed" | "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type MissionView = "summary" | "result" | "chat" | "work" | "events";

const DEFAULT_LIMIT = 50;
const DEFAULT_BOARD_MAX_BYTES = 64_000;

export const HELP_TEXT = `Usage: pragma <command> [options]

Commands:
  version
  doctor
  completion <bash|zsh|fish|powershell>
  source init|add|upgrade ...
  team discover [SELECTOR] | describe <REF>
  expert discover [SELECTOR] | describe <REF>
  flow discover [SELECTOR] | describe <REF>
  team run|expert run <REF> --workspace <ABSOLUTE_PATH> (--prompt <TEXT> | --input <FILE|->) [--request-id UUID]
  flow run <REF> --workspace <ABSOLUTE_PATH> --input-json <FILE|->
  mission list
  mission get <MISSION_ID> [--view summary|result|events]
  mission resume|watch <MISSION_ID>
  mission send|steer|respond|interrupt <MISSION_ID> ...
  mission board list|read|search <MISSION_ID> ...
  mission queue list|remove|resume|steer <MISSION_ID> ...

Mission control:
  send/respond/interrupt submit durable Inbox commands; --wait waits for execution.
  steer and queue steer are strict active-target operations and never enqueue a fallback.
  resume --project <ID> --revision <N> is the exact, one-time historical pin backfill path.
  --ack-timeout <SECONDS> controls command acknowledgement (default: 30).
  queue list reads the Core ExpertSession prompt queue, not the command Inbox.

Mission watch:
  --format text|jsonl only; --after <CURSOR> or --replay <COUNT>; --until terminal|input-required.
  Ctrl-C detaches the local watcher and leaves the Mission owner untouched.

Run semantics:
  run waits for a terminal result by default; --detach returns after the durable command is persisted.
  --request-id is optional; the CLI generates one when omitted. Reusing it with a different payload is a conflict.

Common examples:
  pragma expert discover "memory"
  pragma mission get <MISSION_ID> --view events --limit 20
  pragma expert run expert:<16-char-id> --workspace "$PWD" --prompt "Summarize this repository"
  pragma mission send <MISSION_ID> --prompt "Continue" --wait

Output:
  --format text|json|jsonl   Output protocol (default: text)
  --json                     Alias for --format json
  --stream-json              Alias for --format jsonl
`;

export class CliParseError extends Error {
  readonly error: IntegrationError;
  readonly format: OutputFormat;

  constructor(error: IntegrationError, format: OutputFormat) {
    super(error.message);
    this.name = "CliParseError";
    this.error = error;
    this.format = format;
  }
}

function commandHelpText(args: readonly string[]): string {
  const command = args[0];
  const subcommand = args[1];
  if (command === "version") {
    return `Usage: pragma version

Prints CLI, Desktop, wire, storage, and platform versions. Text is human-readable; JSON/JSONL are machine protocols.`;
  }
  if (command === "doctor") {
    return `Usage: pragma doctor

Checks credential and installation readiness. Text is human-readable; JSON/JSONL preserve the v2 result protocol.`;
  }
  if (command === "completion") {
    return `Usage: pragma completion bash|zsh|fish|powershell

Prints a shell completion script. Evaluate or install the returned script in the selected shell.`;
  }
  if (command === "source") {
    return `Usage: pragma source <command> [options]

Commands:
  init [DIR] --id SOURCE_ID --name NAME
  add BUNDLE [--directory DIR]
  upgrade [DIR]

init creates the readable Bundle Source directory format without initializing Git.
add interactively validates and copies one exported .pragma Bundle into a local Source Git work tree.
upgrade atomically upgrades a v1 Source to v2 and keeps a local backup.`;
  }
  if (command === "team" || command === "expert" || command === "flow") {
    if (subcommand === undefined) {
      return `Usage: pragma ${command} discover|describe|run [options]

Use ${command} discover --help, ${command} describe --help, or ${command} run --help for command-specific options.
Output: text by default; use --format=json or --format=jsonl for machine protocols.`;
    }
    if (subcommand === "discover") {
      return `Usage: pragma ${command} discover [SELECTOR] [options]

SELECTOR is an exact canonical ${command}:<ID> ref, or a case-insensitive name/description substring.
Use --query for a keyword search; do not combine it with SELECTOR.
Options: --project ID --status ready|needs_attention|unavailable --limit N --cursor CURSOR
Output: text table by default; use --format=json or --format=jsonl for machine protocols.

Example: pragma ${command} discover "memory"`;
    }
    if (subcommand === "describe") {
      return `Usage: pragma ${command} describe ${command}:<ID> [--revision N]

Prints the resolved executor descriptor. Use --format=json for automation.
The canonical ref is stable input for run; JSON is unchanged for scripts.

Example: pragma ${command} describe ${command}:abcdefghjkmnpqrs`;
    }
    if (subcommand === "run") {
      return `Usage: pragma ${command} run ${command}:<ID> --workspace ABSOLUTE_PATH (--prompt TEXT | --input FILE|-)

Runs to a terminal result by default; --detach returns after the durable command is persisted.
--request-id is optional and is generated when omitted. Reusing it with a different payload is a conflict.
Output: text keeps the agent result readable; --format=json or --format=jsonl preserves the v2 machine protocol.

Example: pragma ${command} run ${command}:abcdefghjkmnpqrs --workspace "$PWD" --prompt "Summarize this repository"`;
    }
  }
  if (command === "mission") {
    if (subcommand === "list") {
      return `Usage: pragma mission list [--status STATUS] [--executor REF] [--limit N] [--cursor CURSOR]

Lists Mission summaries. Text output includes Mission ID, status, executor, updated time, and workspace.
Use the printed continuation command to fetch the next page; JSON/JSONL output is protocol-only.

Example: pragma mission list --status active`;
    }
    if (subcommand === "get") {
      return `Usage: pragma mission get MISSION_ID [--view summary|result|events] [--limit N] [--cursor CURSOR]

summary is the compact default, result is the latest execution state, and events is an ascending durable event page.
chat and work are not available yet; use --view events or mission watch instead.
Output: text uses a view-specific renderer; JSON/JSONL preserve the v2 envelope.

Example: pragma mission get MISSION_ID --view events --limit 20`;
    }
    if (subcommand === "watch") {
      return `Usage: pragma mission watch MISSION_ID [--after CURSOR | --replay COUNT] [--until terminal|input-required]

Follows Mission events until the requested condition; Ctrl-C detaches locally. Text and jsonl are supported.

Example: pragma mission watch MISSION_ID --until terminal`;
    }
    if (subcommand === "board") {
      const boardCommand = args[2];
      if (boardCommand === "list") {
        return `Usage: pragma mission board list MISSION_ID [--limit N] [--cursor CURSOR]

Lists the shared Mission Board. Text output prints a continuation command when another page exists.`;
      }
      if (boardCommand === "read") {
        return `Usage: pragma mission board read MISSION_ID CONTEXT_ID [--start BYTE] [--offset BYTES]

Reads a bounded Board item range. Use --format=json for structured content and ranges.`;
      }
      if (boardCommand === "search") {
        return `Usage: pragma mission board search MISSION_ID QUERY [--case-sensitive] [--context-lines N] [--max-results N]

Searches the shared Mission Board without changing Mission state.`;
      }
      return `Usage: pragma mission board list|read|search MISSION_ID [options]

Use pragma mission board <command> --help for the exact options.`;
    }
    if (subcommand === "queue") {
      const queueCommand = args[2];
      if (queueCommand === "list") {
        return `Usage: pragma mission queue list MISSION_ID [--limit N] [--cursor CURSOR]

Shows the Core prompt queue with state, pending count, steer support, and full request IDs.
Use the printed continuation command for the next page.`;
      }
      if (queueCommand === "remove") {
        return `Usage: pragma mission queue remove MISSION_ID --request QUEUE_REQUEST_ID [--request-id REQUEST_ID] [--ack-timeout SECONDS]

Removes one queue item. --request is the queue item ID; --request-id is this command's idempotency ID.
Example: pragma mission queue remove MISSION_ID --request QUEUE_REQUEST_ID`;
      }
      if (queueCommand === "resume") {
        return `Usage: pragma mission queue resume MISSION_ID [--request-id REQUEST_ID] [--ack-timeout SECONDS]

Resumes a paused queue. The command is durable and idempotent by request ID plus payload hash.
Example: pragma mission queue resume MISSION_ID`;
      }
      if (queueCommand === "steer") {
        return `Usage: pragma mission queue steer MISSION_ID --request QUEUE_REQUEST_ID [--expected-execution EXECUTION_ID] [--request-id REQUEST_ID] [--wait | --detach] [--ack-timeout SECONDS]

Steers one queued item without fallback. --request is the queue item ID; --request-id is this command's idempotency ID.
Example: pragma mission queue steer MISSION_ID --request QUEUE_REQUEST_ID --detach`;
      }
      return `Usage: pragma mission queue list|remove|resume|steer MISSION_ID [options]

Queue mutations are durable and idempotent by request ID plus payload hash. --wait waits for execution; --detach returns after persistence.`;
    }
    if (subcommand === "resume") {
      return `Usage: pragma mission resume MISSION_ID [options]

Resumes a historical Mission after its executor binding is proven. Use --project PROJECT_ID and --revision N together for the one-time historical pin backfill; --expected-fingerprint optionally verifies that revision.
--detach returns after the resume command is durably persisted. The command is idempotent by request ID plus payload hash. Use --format=json for scripts and inspect the exit code.
Options: --project PROJECT_ID --revision N --expected-fingerprint SHA256 --request-id REQUEST_ID --detach

Example: pragma mission resume MISSION_ID --project PROJECT_ID --revision N --detach`;
    }
    if (["send", "steer", "respond", "interrupt"].includes(subcommand ?? "")) {
      const example =
        subcommand === "send"
          ? `pragma mission send MISSION_ID --prompt "Continue" --wait`
          : subcommand === "steer"
            ? `pragma mission steer MISSION_ID --prompt "Change direction" --wait`
            : subcommand === "respond"
              ? `pragma mission respond MISSION_ID --interaction INTERACTION_ID --answer "yes" --wait`
              : `pragma mission interrupt MISSION_ID --wait`;
      return `Usage: pragma mission ${subcommand} MISSION_ID [options]

The command is durable and idempotent by request ID plus payload hash. --wait waits for execution;
--detach returns after the command is durably persisted. Use --format=json for scripts and inspect the exit code.

Example: ${example}`;
    }
  }
  return HELP_TEXT;
}

export function parseCliArgv(argv: readonly string[]): ParsedCli {
  let parsedCommand: ParsedCommand | undefined;
  const program = createCliProgram((command) => {
    parsedCommand = command;
  });

  try {
    validateSeparatedOptionValues(argv, program);
    validateOptionOccurrences(argv, program);
    program.parse([...argv], { from: "user" });
  } catch (error) {
    const options = globalOptionsFrom(program);
    if (isHelpDisplay(error)) {
      const helpPath = commandPathForHelp(argv);
      return {
        options: helpOptions(options, argv),
        command: {
          kind: "help",
          ...(helpPath.length === 0 ? {} : { text: commandHelpText(helpPath) }),
        },
      };
    }
    if (error instanceof CliParseError) throw error;
    const message = normalizeCommanderError(error, argv);
    const globalFailure = isGlobalOptionFailure(message);
    throw new CliParseError(
      globalFailure ? createFormatError(message) : createUsageError(message),
      globalFailure ? formatForGlobalOptionError(argv) : options.format,
    );
  }

  const options = globalOptionsFrom(program);
  if (parsedCommand === undefined) return { options, command: { kind: "help" } };
  try {
    if (parsedCommand.kind === "mission-watch" && options.format === "json") {
      throw new CliParseError(
        createFormatError(
          "mission watch supports only --format text or --format jsonl; use mission get --view events for a one-shot JSON result.",
        ),
        options.format,
      );
    }
    validateRunOptions(options, parsedCommand);
    return { options, command: parsedCommand };
  } catch (error) {
    if (error instanceof CliParseError) throw error;
    throw new CliParseError(
      createUsageError(error instanceof Error ? error.message : "Invalid command arguments."),
      options.format,
    );
  }
}

type ParsedCommandSink = (command: ParsedCommand) => void;

interface CliOptionDefinition {
  readonly flags: string;
  readonly multiple?: boolean | undefined;
}

function createCliProgram(setCommand: ParsedCommandSink): Command {
  const program = configureCommand(new Command("pragma"));
  program
    .addOption(
      new Option("--format <format>").argParser(parseFormat).conflicts(["json", "streamJson"]),
    )
    .addOption(new Option("--json").conflicts(["format", "streamJson"]))
    .addOption(new Option("--stream-json").conflicts(["format", "json"]))
    .addOption(
      new Option("--color <mode>").argParser((value) =>
        parseEnum(value, ["auto", "always", "never"], "--color"),
      ),
    )
    .addOption(
      new Option("--interactive <mode>").argParser((value) =>
        parseEnum(value, ["auto", "always", "never"], "--interactive"),
      ),
    );

  configureCommand(program.command("help")).action(() => setCommand({ kind: "help" }));
  configureCommand(program.command("version")).action(() => setCommand({ kind: "version" }));
  configureCommand(program.command("doctor")).action(() => setCommand({ kind: "doctor" }));
  addLeaf(program, "completion", [], (positionals) => parseCompletion(positionals), setCommand);

  const source = addCommandGroup(program, "source", "source requires init, add, or upgrade.");
  addLeaf(
    source,
    "init",
    [{ flags: "--id <id>" }, { flags: "--name <name>" }],
    (positionals, values) => parseSourceCommand("init", positionals, values),
    setCommand,
  );
  addLeaf(
    source,
    "add",
    [{ flags: "--directory <directory>" }],
    (positionals, values) => parseSourceCommand("add", positionals, values),
    setCommand,
  );
  addLeaf(
    source,
    "upgrade",
    [],
    (positionals) => parseSourceCommand("upgrade", positionals, new Map()),
    setCommand,
  );

  for (const executorKind of ["team", "expert", "flow"] as const) {
    const executor = addCommandGroup(
      program,
      executorKind,
      `${executorKind} requires discover, describe, or run.`,
    );
    addLeaf(
      executor,
      "discover",
      [
        { flags: "--project <project>" },
        { flags: "--query <query>" },
        { flags: "--status <status>" },
        { flags: "--limit <limit>" },
        { flags: "--cursor <cursor>" },
      ],
      (positionals, values) => parseExecutorCommand(executorKind, "discover", positionals, values),
      setCommand,
    );
    addLeaf(
      executor,
      "describe",
      [{ flags: "--revision <revision>" }],
      (positionals, values) => parseExecutorCommand(executorKind, "describe", positionals, values),
      setCommand,
    );
    addLeaf(
      executor,
      "run",
      [
        { flags: "--workspace <workspace>" },
        { flags: "--prompt <prompt>" },
        { flags: "--input <path>" },
        { flags: "--input-json <path>" },
        { flags: "--project <project>" },
        { flags: "--revision <revision>" },
        { flags: "--expected-fingerprint <fingerprint>" },
        { flags: "--request-id <requestId>" },
        { flags: "--detach" },
      ],
      (positionals, values) => parseExecutorRunCommand(executorKind, positionals, values),
      setCommand,
    );
  }

  const mission = addCommandGroup(
    program,
    "mission",
    "mission requires list, get, resume, watch, send, steer, respond, interrupt, board, or queue.",
  );
  registerMissionCommands(mission, setCommand);
  return program;
}

function registerMissionCommands(mission: Command, setCommand: ParsedCommandSink): void {
  addLeaf(
    mission,
    "list",
    [
      { flags: "--status <status>" },
      { flags: "--executor <executor>" },
      { flags: "--limit <limit>" },
      { flags: "--cursor <cursor>" },
    ],
    (positionals, values) => parseMissionCommand("list", positionals, values),
    setCommand,
  );
  addLeaf(
    mission,
    "get",
    [{ flags: "--view <view>" }, { flags: "--limit <limit>" }, { flags: "--cursor <cursor>" }],
    (positionals, values) => parseMissionCommand("get", positionals, values),
    setCommand,
  );
  addLeaf(
    mission,
    "watch",
    [
      { flags: "--after <cursor>" },
      { flags: "--replay <count>" },
      { flags: "--until <condition>" },
    ],
    (positionals, values) => parseMissionCommand("watch", positionals, values),
    setCommand,
  );
  addLeaf(
    mission,
    "resume",
    [
      { flags: "--project <project>" },
      { flags: "--revision <revision>" },
      { flags: "--expected-fingerprint <fingerprint>" },
      { flags: "--request-id <requestId>" },
      { flags: "--detach" },
    ],
    (positionals, values) => parseMissionCommand("resume", positionals, values),
    setCommand,
  );

  const messageOptions: readonly CliOptionDefinition[] = [
    { flags: "--prompt <prompt>" },
    { flags: "--input <path>" },
    { flags: "--request-id <requestId>" },
    { flags: "--wait" },
    { flags: "--detach" },
    { flags: "--ack-timeout <seconds>" },
  ];
  addLeaf(
    mission,
    "send",
    messageOptions,
    (positionals, values) => parseMissionCommand("send", positionals, values),
    setCommand,
  );
  addLeaf(
    mission,
    "steer",
    [...messageOptions, { flags: "--expected-execution <executionId>" }],
    (positionals, values) => parseMissionCommand("steer", positionals, values),
    setCommand,
  );
  addLeaf(
    mission,
    "respond",
    [
      { flags: "--interaction <interactionId>" },
      { flags: "--answer <answer>" },
      { flags: "--choice <choice>", multiple: true },
      { flags: "--answers-json <path>" },
      { flags: "--request-id <requestId>" },
      { flags: "--wait" },
      { flags: "--detach" },
      { flags: "--ack-timeout <seconds>" },
    ],
    (positionals, values) => parseMissionCommand("respond", positionals, values),
    setCommand,
  );
  addLeaf(
    mission,
    "interrupt",
    [
      { flags: "--expected-execution <executionId>" },
      { flags: "--reason <reason>" },
      { flags: "--request-id <requestId>" },
      { flags: "--wait" },
      { flags: "--detach" },
      { flags: "--ack-timeout <seconds>" },
    ],
    (positionals, values) => parseMissionCommand("interrupt", positionals, values),
    setCommand,
  );

  const board = addCommandGroup(mission, "board", "mission board requires list, read, or search.");
  addLeaf(
    board,
    "list",
    [{ flags: "--limit <limit>" }, { flags: "--cursor <cursor>" }],
    (positionals, values) => parseBoardCommand(["list", ...positionals], values),
    setCommand,
  );
  addLeaf(
    board,
    "read",
    [{ flags: "--start <start>" }, { flags: "--offset <bytes>" }],
    (positionals, values) => parseBoardCommand(["read", ...positionals], values),
    setCommand,
  );
  addLeaf(
    board,
    "search",
    [
      { flags: "--case-sensitive" },
      { flags: "--context-lines <lines>" },
      { flags: "--max-results <count>" },
    ],
    (positionals, values) => parseBoardCommand(["search", ...positionals], values),
    setCommand,
  );

  const queue = addCommandGroup(
    mission,
    "queue",
    "mission queue requires list, remove, resume, or steer.",
  );
  addLeaf(
    queue,
    "list",
    [{ flags: "--limit <limit>" }, { flags: "--cursor <cursor>" }],
    (positionals, values) => parseQueueCommand(["list", ...positionals], values),
    setCommand,
  );
  addLeaf(
    queue,
    "remove",
    [
      { flags: "--request <requestId>" },
      { flags: "--request-id <requestId>" },
      { flags: "--ack-timeout <seconds>" },
    ],
    (positionals, values) => parseQueueCommand(["remove", ...positionals], values),
    setCommand,
  );
  addLeaf(
    queue,
    "resume",
    [{ flags: "--request-id <requestId>" }, { flags: "--ack-timeout <seconds>" }],
    (positionals, values) => parseQueueCommand(["resume", ...positionals], values),
    setCommand,
  );
  addLeaf(
    queue,
    "steer",
    [
      { flags: "--request <requestId>" },
      { flags: "--expected-execution <executionId>" },
      { flags: "--request-id <requestId>" },
      { flags: "--wait" },
      { flags: "--detach" },
      { flags: "--ack-timeout <seconds>" },
    ],
    (positionals, values) => parseQueueCommand(["steer", ...positionals], values),
    setCommand,
  );
}

function configureCommand(command: Command): Command {
  return command
    .helpCommand(false)
    .exitOverride()
    .showSuggestionAfterError(false)
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
}

function addCommandGroup(parent: Command, name: string, missingCommandMessage: string): Command {
  const command = configureCommand(parent.command(name));
  command.action(() => {
    throw new Error(missingCommandMessage);
  });
  return command;
}

function addLeaf(
  parent: Command,
  name: string,
  options: readonly CliOptionDefinition[],
  parse: (
    positionals: readonly string[],
    values: ReadonlyMap<string, OptionValue>,
  ) => ParsedCommand,
  setCommand: ParsedCommandSink,
): Command {
  const command = configureCommand(parent.command(name)).argument("[args...]");
  for (const definition of options) {
    const option = new Option(definition.flags);
    if (definition.multiple === true) option.argParser(collectOptionValues);
    command.addOption(option);
  }
  command.action((positionals: readonly string[] | undefined) => {
    setCommand(parse(positionals ?? [], commandOptionValues(command)));
  });
  return command;
}

function collectOptionValues(value: string, previous: readonly string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function commandOptionValues(command: Command): ReadonlyMap<string, OptionValue> {
  const values = new Map<string, OptionValue>();
  const parsed = command.opts() as Readonly<Record<string, unknown>>;
  for (const option of command.options) {
    const attribute = option.attributeName();
    if (command.getOptionValueSource(attribute) === undefined) continue;
    const name = option.long?.slice(2);
    const value = parsed[attribute];
    if (name === undefined) continue;
    if (typeof value === "string" || value === true) values.set(name, value);
    else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      values.set(name, value);
    }
  }
  return values;
}

function globalOptionsFrom(program: Command): GlobalCliOptions {
  const values = program.opts() as {
    readonly format?: OutputFormat | undefined;
    readonly json?: boolean | undefined;
    readonly streamJson?: boolean | undefined;
    readonly color?: ColorMode | undefined;
    readonly interactive?: InteractiveMode | undefined;
  };
  return {
    format: values.format ?? (values.json ? "json" : values.streamJson ? "jsonl" : "text"),
    color: values.color ?? "auto",
    interactive: values.interactive ?? "auto",
  };
}

function helpOptions(options: GlobalCliOptions, argv: readonly string[]): GlobalCliOptions {
  const inferredFormat = formatForGlobalOptionError(argv);
  return inferredFormat === "text" ? options : { ...options, format: inferredFormat };
}

function isHelpDisplay(error: unknown): boolean {
  return (
    error instanceof CommanderError &&
    error.exitCode === 0 &&
    (error.code === "commander.helpDisplayed" || error.code.includes("help"))
  );
}

function isGlobalOptionFailure(message: string): boolean {
  return /--(?:format|json|stream-json|color|interactive)\b/u.test(message);
}

function normalizeCommanderError(error: unknown, argv: readonly string[]): string {
  const message =
    error instanceof Error
      ? error.message.replace(/^error:\s*/iu, "")
      : "Invalid command arguments.";
  if (!(error instanceof CommanderError)) return message;
  if (error.code === "commander.unknownCommand") return unknownCommandMessage(argv);
  if (error.code === "commander.excessArguments") {
    const command = commandPathForHelp(argv)[0];
    if (
      command === "source" ||
      command === "team" ||
      command === "expert" ||
      command === "flow" ||
      command === "mission"
    ) {
      return unknownCommandMessage(argv);
    }
  }
  if (error.code === "commander.conflictingOption" && isGlobalOptionFailure(message)) {
    const flags = [...message.matchAll(/option ['`]([^'`]+)['`]/giu)].map((match) => match[1]);
    return `Output format flags ${flags[0] ?? ""} and ${flags[1] ?? ""} are mutually exclusive.`;
  }
  const unknownOption = message.match(/unknown option ['`](--[^'`]+)['`]/iu)?.[1];
  if (unknownOption !== undefined) return `Unknown option ${unknownOption}.`;
  const missingValue = message.match(/option ['`](--[^\s'`]+)[^'`]*['`] argument missing/iu)?.[1];
  if (missingValue !== undefined) return `Option ${missingValue} requires a value.`;
  return message;
}

function validateSeparatedOptionValues(argv: readonly string[], program: Command): void {
  const valueOptions = new Set<string>();
  collectValueOptions(program, valueOptions);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || token === "--") break;
    if (!valueOptions.has(token)) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Option ${token} requires a value.`);
    }
    index += 1;
  }
}

const REPEATABLE_OPTIONS = new Set(["--choice"]);

function validateOptionOccurrences(argv: readonly string[], program: Command): void {
  const knownOptions = new Set<string>();
  collectLongOptions(program, knownOptions);
  const occurrences = new Map<string, number>();

  for (const token of argv) {
    if (token === "--") break;
    if (!token.startsWith("--")) continue;

    const separator = token.indexOf("=");
    const optionName = separator === -1 ? token : token.slice(0, separator);
    if (!knownOptions.has(optionName)) continue;

    const count = (occurrences.get(optionName) ?? 0) + 1;
    occurrences.set(optionName, count);
    if (count > 1 && !REPEATABLE_OPTIONS.has(optionName)) {
      throw new Error(`Option ${optionName} may only be specified once.`);
    }
  }
}

function collectLongOptions(command: Command, target: Set<string>): void {
  for (const option of command.options) {
    if (option.long !== undefined) target.add(option.long);
  }
  for (const child of command.commands) collectLongOptions(child, target);
}

function collectValueOptions(command: Command, target: Set<string>): void {
  for (const option of command.options) {
    if (option.required && option.long !== undefined) target.add(option.long);
  }
  for (const child of command.commands) collectValueOptions(child, target);
}

function unknownCommandMessage(argv: readonly string[]): string {
  const path = commandPathForHelp(argv);
  const [command, subcommand, nestedCommand] = path;
  if (command === "source") return "source requires init, add, or upgrade.";
  if (command === "team" || command === "expert" || command === "flow") {
    return `${command} requires discover, describe, or run.`;
  }
  if (command === "mission" && subcommand === "board") {
    return "mission board requires list, read, or search.";
  }
  if (command === "mission" && subcommand === "queue") {
    return "mission queue requires list, remove, resume, or steer.";
  }
  if (command === "mission" && (subcommand !== undefined || nestedCommand !== undefined)) {
    return "mission requires list, get, resume, watch, send, steer, respond, interrupt, board, or queue.";
  }
  return `Unknown command: ${command ?? ""}`;
}

function commandPathForHelp(argv: readonly string[]): readonly string[] {
  const path: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || token === "--help" || token === "-h") continue;
    if (token === "--") break;
    if (token === "--json" || token === "--stream-json") continue;
    if (token === "--format" || token === "--color" || token === "--interactive") {
      index += 1;
      continue;
    }
    if (/^--(?:format|color|interactive)=/u.test(token)) continue;
    if (token.startsWith("-")) continue;
    path.push(token);
    if (path.length === 3) break;
  }
  return path;
}

function parseSourceCommand(
  subcommand: "init" | "add" | "upgrade",
  positionals: readonly string[],
  values: ReadonlyMap<string, OptionValue>,
): ParsedCommand {
  if (subcommand === "upgrade") {
    if (positionals.length > 1) throw new Error("source upgrade accepts at most one directory.");
    return { kind: "source-upgrade", directory: positionals[0] ?? "." };
  }
  if (subcommand === "init") {
    if (positionals.length > 1) throw new Error("source init accepts at most one directory.");
    return {
      kind: "source-init",
      directory: positionals[0] ?? ".",
      id: requiredOption(values, "id"),
      name: requiredOption(values, "name"),
    };
  }
  if (positionals.length !== 1) throw new Error("source add requires one Bundle path.");
  return {
    kind: "source-add",
    directory: optionalValue(values, "directory") ?? ".",
    bundlePath: positionals[0]!,
  };
}

function parseCompletion(args: readonly string[]): ParsedCommand {
  if (args.length !== 1) throw new Error("completion requires exactly one shell.");
  return {
    kind: "completion",
    shell: parseEnum(args[0], ["bash", "zsh", "fish", "powershell"], "shell") as CompletionShell,
  };
}

function parseExecutorCommand(
  command: ExecutorKind,
  subcommand: "discover" | "describe",
  positionals: readonly string[],
  values: ReadonlyMap<string, OptionValue>,
): ParsedCommand {
  if (subcommand === "discover") {
    if (positionals.length > 1)
      throw new Error(`${command} discover accepts at most one positional selector.`);
    const selector = positionals[0];
    const query = optionalValue(values, "query");
    if (selector !== undefined && query !== undefined) {
      throw new Error(`${command} discover cannot combine a selector with --query.`);
    }
    const selectorKind = selector?.match(/^(team|expert|flow):/u)?.[1];
    if (selectorKind !== undefined && selectorKind !== command) {
      throw new Error(
        `${command} discover selector ${selector} refers to a ${selectorKind} executor.`,
      );
    }
    return {
      kind: "executor-discover",
      executorKind: command,
      ...(selector === undefined ? {} : { selector }),
      project: optionalValue(values, "project"),
      ...(query === undefined ? {} : { query }),
      status: optionalEnum(values, "status", ["ready", "needs_attention", "unavailable"]) as
        ExecutorStatus | undefined,
      limit: optionalPositiveInteger(values, "limit") ?? DEFAULT_LIMIT,
      cursor: optionalValue(values, "cursor"),
    };
  }
  if (positionals.length !== 1) throw new Error(`${command} describe requires a resource ref.`);
  return {
    kind: "executor-describe",
    executorKind: command,
    ref: positionals[0]!,
    revision: optionalPositiveInteger(values, "revision"),
  };
}

function parseExecutorRunCommand(
  executorKind: ExecutorKind,
  positionals: readonly string[],
  values: ReadonlyMap<string, OptionValue>,
): Extract<ParsedCommand, { readonly kind: "executor-run" }> {
  if (positionals.length !== 1) {
    throw new Error(`${executorKind} run requires exactly one canonical executor ref.`);
  }
  const ref = positionals[0]!;
  if (!new RegExp(`^${executorKind}:[0-9a-hjkmnp-tv-z]{16}$`, "u").test(ref)) {
    throw new Error(`${executorKind} run requires a canonical ${executorKind}:<ID> ref.`);
  }
  const workspace = requiredOption(values, "workspace");
  if (!isAbsolute(workspace)) throw new Error("--workspace must be an absolute path.");
  const prompt = optionalValue(values, "prompt");
  const inputPath = optionalValue(values, "input");
  const inputJsonPath = optionalValue(values, "input-json");
  if (executorKind === "flow") {
    if (inputJsonPath === undefined) throw new Error("flow run requires --input-json.");
    if (prompt !== undefined || inputPath !== undefined) {
      throw new Error("flow run accepts --input-json only.");
    }
  } else {
    if (inputJsonPath !== undefined)
      throw new Error(`${executorKind} run does not accept --input-json.`);
    if ((prompt === undefined) === (inputPath === undefined)) {
      throw new Error(`${executorKind} run requires exactly one of --prompt or --input.`);
    }
    if (prompt !== undefined && prompt.trim() === "")
      throw new Error("--prompt must not be empty.");
  }
  const project = optionalValue(values, "project");
  const revision = optionalPositiveInteger(values, "revision");
  if (revision !== undefined && project === undefined) {
    throw new Error("--revision requires --project.");
  }
  const expectedFingerprint = optionalValue(values, "expected-fingerprint");
  if (expectedFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(expectedFingerprint)) {
    throw new Error("--expected-fingerprint must be 64 lowercase hexadecimal characters.");
  }
  if (expectedFingerprint !== undefined && project === undefined) {
    throw new Error("--expected-fingerprint requires --project.");
  }
  const requestId = optionalValue(values, "request-id");
  if (requestId !== undefined && !isUuid(requestId))
    throw new Error("--request-id must be a UUID.");
  return {
    kind: "executor-run",
    executorKind,
    ref,
    workspace,
    ...(prompt === undefined ? {} : { prompt }),
    ...(inputPath === undefined ? {} : { inputPath }),
    ...(inputJsonPath === undefined ? {} : { inputJsonPath }),
    ...(project === undefined ? {} : { project }),
    ...(revision === undefined ? {} : { revision }),
    ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
    ...(requestId === undefined ? {} : { requestId }),
    detach: values.get("detach") === true,
  };
}

function validateRunOptions(options: GlobalCliOptions, command: ParsedCommand): void {
  const detached = "detach" in command && command.detach === true;
  if (detached && options.interactive === "always") {
    throw new Error("--detach and --interactive always are mutually exclusive.");
  }
}

function parseMissionCommand(
  subcommand: "list" | "get" | "watch" | "resume" | "send" | "steer" | "respond" | "interrupt",
  positionals: readonly string[],
  values: ReadonlyMap<string, OptionValue>,
): ParsedCommand {
  if (subcommand === "list") {
    assertOnlyOptions(values, ["status", "executor", "limit", "cursor"], "mission list");
    if (positionals.length !== 0)
      throw new Error("mission list does not accept positional arguments.");
    return {
      kind: "mission-list",
      status: optionalEnum(values, "status", [
        "active",
        "completed",
        "queued",
        "running",
        "waiting",
        "succeeded",
        "failed",
        "cancelled",
      ]) as MissionStatusFilter | undefined,
      executor: optionalValue(values, "executor"),
      limit: optionalPositiveInteger(values, "limit") ?? DEFAULT_LIMIT,
      cursor: optionalValue(values, "cursor"),
    };
  }
  if (subcommand === "get") {
    assertOnlyOptions(values, ["view", "limit", "cursor"], "mission get");
    if (positionals.length !== 1) throw new Error("mission get requires a Mission ID.");
    return {
      kind: "mission-get",
      missionId: positionals[0]!,
      view: (optionalEnum(values, "view", ["summary", "result", "chat", "work", "events"]) ??
        "summary") as MissionView,
      limit: optionalPositiveInteger(values, "limit") ?? DEFAULT_LIMIT,
      cursor: optionalValue(values, "cursor"),
    };
  }
  if (subcommand === "watch") {
    assertOnlyOptions(values, ["after", "replay", "until"], "mission watch");
    if (positionals.length !== 1) throw new Error("mission watch requires a Mission ID.");
    const after = optionalValue(values, "after");
    const replay = optionalNonNegativeInteger(values, "replay");
    if (after !== undefined && replay !== undefined) {
      throw new Error("mission watch accepts either --after or --replay, not both.");
    }
    if (replay !== undefined && replay > 1_000) {
      throw new Error("--replay must be between 0 and 1000.");
    }
    return {
      kind: "mission-watch",
      missionId: positionals[0]!,
      ...(after === undefined ? {} : { after }),
      ...(replay === undefined ? {} : { replay }),
      until: optionalEnum(values, "until", ["terminal", "input-required"]) as
        "terminal" | "input-required" | undefined,
    };
  }
  if (subcommand === "resume") return parseMissionResumeCommand(positionals, values);
  if (subcommand === "send" || subcommand === "steer") {
    return parseMissionMessageCommand(subcommand, positionals, values);
  }
  if (subcommand === "respond") return parseMissionRespondCommand(positionals, values);
  return parseMissionInterruptCommand(positionals, values);
}

function parseMissionResumeCommand(
  positionals: readonly string[],
  values: ReadonlyMap<string, OptionValue>,
): ParsedCommand {
  assertOnlyOptions(
    values,
    ["project", "revision", "expected-fingerprint", "request-id", "detach"],
    "mission resume",
  );
  if (positionals.length !== 1) throw new Error("mission resume requires a Mission ID.");
  const project = optionalValue(values, "project");
  const revision = optionalPositiveInteger(values, "revision");
  if ((project === undefined) !== (revision === undefined)) {
    throw new Error("--project and --revision must be provided together.");
  }
  const expectedFingerprint = optionalValue(values, "expected-fingerprint");
  if (expectedFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(expectedFingerprint)) {
    throw new Error("--expected-fingerprint must be 64 lowercase hexadecimal characters.");
  }
  if (expectedFingerprint !== undefined && project === undefined) {
    throw new Error("--expected-fingerprint requires --project and --revision.");
  }
  const requestId = optionalRequestId(values, "request-id");
  const detach = values.get("detach") === true;
  return {
    kind: "mission-resume",
    missionId: positionals[0]!,
    ...(project === undefined ? {} : { project }),
    ...(revision === undefined ? {} : { revision }),
    ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(detach ? { detach: true } : {}),
  };
}

function parseMissionMessageCommand(
  subcommand: "send" | "steer",
  positionals: readonly string[],
  values: ReadonlyMap<string, OptionValue>,
): ParsedCommand {
  assertOnlyOptions(
    values,
    [
      "prompt",
      "input",
      ...(subcommand === "steer" ? ["expected-execution"] : []),
      "request-id",
      "wait",
      "detach",
      "ack-timeout",
    ],
    "mission " + subcommand,
  );
  if (positionals.length !== 1) throw new Error(`mission ${subcommand} requires a Mission ID.`);
  const prompt = optionalValue(values, "prompt");
  const inputPath = optionalValue(values, "input");
  if ((prompt === undefined) === (inputPath === undefined)) {
    throw new Error(`mission ${subcommand} requires exactly one of --prompt or --input.`);
  }
  if (prompt !== undefined && prompt.trim() === "") {
    throw new Error("--prompt must not be empty.");
  }
  const requestId = optionalRequestId(values, "request-id");
  const expectedExecutionId = optionalUuidOption(values, "expected-execution");
  const wait = values.get("wait") === true;
  const detach = values.get("detach") === true;
  if (wait && detach) throw new Error("--wait and --detach are mutually exclusive.");
  return {
    kind: subcommand === "send" ? "mission-send" : "mission-steer",
    missionId: positionals[0]!,
    ...(prompt === undefined ? {} : { prompt }),
    ...(inputPath === undefined ? {} : { inputPath }),
    ...(expectedExecutionId === undefined ? {} : { expectedExecutionId }),
    ...(requestId === undefined ? {} : { requestId }),
    wait,
    detach,
    ackTimeoutSeconds: parseAckTimeout(values),
  };
}

function parseMissionRespondCommand(
  positionals: readonly string[],
  values: ReadonlyMap<string, OptionValue>,
): ParsedCommand {
  assertOnlyOptions(
    values,
    [
      "interaction",
      "answer",
      "choice",
      "answers-json",
      "request-id",
      "wait",
      "detach",
      "ack-timeout",
    ],
    "mission respond",
  );
  if (positionals.length !== 1) throw new Error("mission respond requires a Mission ID.");
  const interactionId = requiredOption(values, "interaction");
  const answer = optionalValue(values, "answer");
  const choices = optionalValues(values, "choice");
  const answersPath = optionalValue(values, "answers-json");
  const supplied =
    Number(answer !== undefined) + Number(choices.length > 0) + Number(answersPath !== undefined);
  if (supplied !== 1) {
    throw new Error(
      "mission respond requires exactly one of --answer, --choice, or --answers-json.",
    );
  }
  if (answer !== undefined && answer.trim() === "") throw new Error("--answer must not be empty.");
  const requestId = optionalRequestId(values, "request-id");
  const wait = values.get("wait") === true;
  const detach = values.get("detach") === true;
  if (wait && detach) throw new Error("--wait and --detach are mutually exclusive.");
  return {
    kind: "mission-respond",
    missionId: positionals[0]!,
    interactionId,
    ...(answer === undefined ? {} : { answer }),
    ...(choices.length === 0 ? {} : { choices }),
    ...(answersPath === undefined ? {} : { answersPath }),
    ...(requestId === undefined ? {} : { requestId }),
    wait,
    detach,
    ackTimeoutSeconds: parseAckTimeout(values),
  };
}

function parseMissionInterruptCommand(
  positionals: readonly string[],
  values: ReadonlyMap<string, OptionValue>,
): ParsedCommand {
  assertOnlyOptions(
    values,
    ["request-id", "expected-execution", "reason", "wait", "detach", "ack-timeout"],
    "mission interrupt",
  );
  if (positionals.length !== 1) throw new Error("mission interrupt requires a Mission ID.");
  const requestId = optionalRequestId(values, "request-id");
  const expectedExecutionId = optionalUuidOption(values, "expected-execution");
  const reason = optionalValue(values, "reason");
  if (reason !== undefined && reason.trim() === "") throw new Error("--reason must not be empty.");
  const wait = values.get("wait") === true;
  const detach = values.get("detach") === true;
  if (wait && detach) throw new Error("--wait and --detach are mutually exclusive.");
  return {
    kind: "mission-interrupt",
    missionId: positionals[0]!,
    ...(expectedExecutionId === undefined ? {} : { expectedExecutionId }),
    ...(reason === undefined ? {} : { reason }),
    ...(requestId === undefined ? {} : { requestId }),
    wait,
    detach,
    ackTimeoutSeconds: parseAckTimeout(values),
  };
}

function parseBoardCommand(
  positionals: readonly string[],
  values: ReadonlyMap<string, OptionValue>,
): ParsedCommand {
  const subcommand = positionals[0];
  if (subcommand === "list") {
    assertOnlyOptions(values, ["limit", "cursor"], "mission board list");
    if (positionals.length !== 2) throw new Error("mission board list requires a Mission ID.");
    return {
      kind: "board-list",
      missionId: positionals[1]!,
      limit: optionalPositiveInteger(values, "limit") ?? DEFAULT_LIMIT,
      cursor: optionalValue(values, "cursor"),
    };
  }
  if (subcommand === "read") {
    assertOnlyOptions(values, ["start", "offset"], "mission board read");
    if (positionals.length !== 3)
      throw new Error("mission board read requires a Mission ID and context ID.");
    const maxBytes = optionalPositiveInteger(values, "offset") ?? DEFAULT_BOARD_MAX_BYTES;
    if (maxBytes > DEFAULT_BOARD_MAX_BYTES) {
      throw new Error(`--offset must be at most ${DEFAULT_BOARD_MAX_BYTES}.`);
    }
    return {
      kind: "board-read",
      missionId: positionals[1]!,
      contextId: positionals[2]!,
      start: optionalNonNegativeInteger(values, "start") ?? 0,
      maxBytes,
    };
  }
  if (subcommand === "search") {
    assertOnlyOptions(
      values,
      ["case-sensitive", "context-lines", "max-results"],
      "mission board search",
    );
    if (positionals.length !== 3)
      throw new Error("mission board search requires a Mission ID and query.");
    const contextLines = optionalNonNegativeInteger(values, "context-lines") ?? 2;
    if (contextLines > 2) throw new Error("--context-lines must be at most 2.");
    const maxResults = optionalPositiveInteger(values, "max-results") ?? 50;
    if (maxResults > 50) throw new Error("--max-results must be at most 50.");
    return {
      kind: "board-search",
      missionId: positionals[1]!,
      query: positionals[2]!,
      caseSensitive: values.get("case-sensitive") === true,
      contextLines,
      maxResults,
    };
  }
  throw new Error("mission board requires list, read, or search.");
}

function parseQueueCommand(
  positionals: readonly string[],
  values: ReadonlyMap<string, OptionValue>,
): ParsedCommand {
  const subcommand = positionals[0];
  if (subcommand === "list") {
    assertOnlyOptions(values, ["limit", "cursor"], "mission queue list");
    if (positionals.length !== 2) throw new Error("mission queue list requires a Mission ID.");
    return {
      kind: "queue-list",
      missionId: positionals[1]!,
      limit: optionalPositiveInteger(values, "limit") ?? DEFAULT_LIMIT,
      cursor: optionalValue(values, "cursor"),
    };
  }
  if (subcommand === "remove") {
    assertOnlyOptions(values, ["request", "request-id", "ack-timeout"], "mission queue remove");
    if (positionals.length !== 2) throw new Error("mission queue remove requires a Mission ID.");
    return {
      kind: "queue-remove",
      missionId: positionals[1]!,
      requestIdToRemove: requiredUuidOption(values, "request"),
      requestId: optionalRequestId(values, "request-id"),
      ackTimeoutSeconds: parseAckTimeout(values),
    };
  }
  if (subcommand === "resume") {
    assertOnlyOptions(values, ["request-id", "ack-timeout"], "mission queue resume");
    if (positionals.length !== 2) throw new Error("mission queue resume requires a Mission ID.");
    return {
      kind: "queue-resume",
      missionId: positionals[1]!,
      requestId: optionalRequestId(values, "request-id"),
      ackTimeoutSeconds: parseAckTimeout(values),
    };
  }
  if (subcommand === "steer") {
    assertOnlyOptions(
      values,
      ["request", "expected-execution", "request-id", "wait", "detach", "ack-timeout"],
      "mission queue steer",
    );
    if (positionals.length !== 2) throw new Error("mission queue steer requires a Mission ID.");
    const requestIdToSteer = requiredUuidOption(values, "request");
    const expectedExecutionId = optionalUuidOption(values, "expected-execution");
    const requestId = optionalRequestId(values, "request-id");
    const wait = values.get("wait") === true;
    const detach = values.get("detach") === true;
    if (wait && detach) throw new Error("--wait and --detach are mutually exclusive.");
    return {
      kind: "queue-steer",
      missionId: positionals[1]!,
      requestIdToSteer,
      ...(expectedExecutionId === undefined ? {} : { expectedExecutionId }),
      ...(requestId === undefined ? {} : { requestId }),
      wait,
      detach,
      ackTimeoutSeconds: parseAckTimeout(values),
    };
  }
  throw new Error("mission queue requires list, remove, resume, or steer.");
}

type OptionValue = string | true | readonly string[];

function assertOnlyOptions(
  values: ReadonlyMap<string, OptionValue>,
  allowed: readonly string[],
  command: string,
): void {
  const allowedSet = new Set(allowed);
  for (const name of values.keys()) {
    if (!allowedSet.has(name)) {
      throw new Error("Unknown option --" + name + " for " + command + ".");
    }
  }
}

function parseFormat(value: string): OutputFormat {
  if (value === "stream-json") return "jsonl";
  return parseEnum(value, ["text", "json", "jsonl"], "--format") as OutputFormat;
}

function parseEnum(value: string | undefined, allowed: readonly string[], label: string): string {
  if (value === undefined || !allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

function optionalValue(values: ReadonlyMap<string, OptionValue>, name: string): string | undefined {
  const value = values.get(name);
  return typeof value === "string" ? value : undefined;
}

function optionalValues(values: ReadonlyMap<string, OptionValue>, name: string): readonly string[] {
  const value = values.get(name);
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value : [];
}

function requiredOption(values: ReadonlyMap<string, OptionValue>, name: string): string {
  const value = optionalValue(values, name);
  if (value === undefined || value.trim() === "") throw new Error(`--${name} requires a value.`);
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function optionalEnum(
  values: ReadonlyMap<string, OptionValue>,
  name: string,
  allowed: readonly string[],
): string | undefined {
  const value = optionalValue(values, name);
  return value === undefined ? undefined : parseEnum(value, allowed, `--${name}`);
}

function optionalPositiveInteger(
  values: ReadonlyMap<string, OptionValue>,
  name: string,
): number | undefined {
  const value = optionalValue(values, name);
  if (value === undefined) return undefined;
  return parseInteger(value, name, false);
}

function optionalNonNegativeInteger(
  values: ReadonlyMap<string, OptionValue>,
  name: string,
): number | undefined {
  const value = optionalValue(values, name);
  if (value === undefined) return undefined;
  return parseInteger(value, name, true);
}

function optionalRequestId(
  values: ReadonlyMap<string, OptionValue>,
  name: string,
): string | undefined {
  const value = optionalValue(values, name);
  if (value !== undefined && !isUuid(value)) throw new Error(`--${name} must be a UUID.`);
  return value;
}

function requiredUuidOption(values: ReadonlyMap<string, OptionValue>, name: string): string {
  const value = requiredOption(values, name);
  if (!isUuid(value)) throw new Error(`--${name} must be a UUID.`);
  return value;
}

function optionalUuidOption(
  values: ReadonlyMap<string, OptionValue>,
  name: string,
): string | undefined {
  const value = optionalValue(values, name);
  if (value !== undefined && !isUuid(value)) {
    throw new Error("--" + name + " must be a UUID.");
  }
  return value;
}

function parseAckTimeout(values: ReadonlyMap<string, OptionValue>): number {
  const value = optionalPositiveInteger(values, "ack-timeout") ?? 30;
  if (value < 1 || value > 600) throw new Error("--ack-timeout must be between 1 and 600 seconds.");
  return value;
}

function parseInteger(value: string, name: string, allowZero: boolean): number {
  if (!/^\d+$/u.test(value)) throw new Error(`--${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed < 1)) {
    throw new Error(`--${name} is outside the supported range.`);
  }
  return parsed;
}

function createUsageError(message: string): IntegrationError {
  return createIntegrationError({ code: "INVALID_ARGUMENT", category: "usage", message });
}

function createFormatError(message: string): IntegrationError {
  return createIntegrationError({ code: "INVALID_FORMAT", category: "usage", message });
}

function formatForGlobalOptionError(argv: readonly string[]): OutputFormat {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") return "json";
    if (token === "--stream-json") return "jsonl";
    if (token === "--format=json" || (token === "--format" && argv[index + 1] === "json")) {
      return "json";
    }
    if (
      token === "--format=jsonl" ||
      token === "--format=stream-json" ||
      (token === "--format" && argv[index + 1] === "jsonl")
    ) {
      return "jsonl";
    }
  }
  return "text";
}
