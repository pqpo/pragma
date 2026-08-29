import { createIntegrationError, type IntegrationError } from "@pragma/local-host/wire";
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
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "doctor" }
  | { readonly kind: "completion"; readonly shell: CompletionShell }
  | {
      readonly kind: "executor-discover";
      readonly executorKind: ExecutorKind;
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
  team discover|describe <REF>
  expert discover|describe <REF>
  flow discover|describe <REF>
  team run|expert run <REF> --workspace <ABSOLUTE_PATH> (--prompt <TEXT> | --input <FILE|->)
  flow run <REF> --workspace <ABSOLUTE_PATH> --input-json <FILE|->
  mission list|get|resume|watch <MISSION_ID>
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

export function parseCliArgv(argv: readonly string[]): ParsedCli {
  let global: ReturnType<typeof parseGlobalOptions>;
  try {
    global = parseGlobalOptions(argv);
  } catch (error) {
    if (error instanceof CliParseError) throw error;
    throw new CliParseError(
      createFormatError(error instanceof Error ? error.message : "Invalid global options."),
      formatForGlobalOptionError(argv),
    );
  }
  const { options, args, helpRequested } = global;
  if (helpRequested || args.length === 0) return { options, command: { kind: "help" } };

  const [command, ...rest] = args;
  if (command === undefined) return { options, command: { kind: "help" } };

  try {
    const parsedCommand = parseCommand(command, rest);
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

function parseGlobalOptions(argv: readonly string[]): {
  readonly options: GlobalCliOptions;
  readonly args: readonly string[];
  readonly helpRequested: boolean;
} {
  let format: OutputFormat = "text";
  let formatSource: string | undefined;
  let color: ColorMode = "auto";
  let interactive: InteractiveMode = "auto";
  let helpRequested = false;
  let optionsTerminated = false;
  const args: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (optionsTerminated) {
      args.push(token);
      continue;
    }
    if (token === "--") {
      optionsTerminated = true;
      args.push(token);
      continue;
    }
    if (token === "--help" || token === "-h") {
      helpRequested = true;
      continue;
    }
    if (token === "--json" || token === "--stream-json") {
      const nextFormat = token === "--json" ? "json" : "jsonl";
      if (formatSource !== undefined) {
        throw new CliParseError(
          createFormatError(
            `Output format flags ${formatSource} and ${token} are mutually exclusive.`,
          ),
          format,
        );
      }
      format = nextFormat;
      formatSource = token;
      continue;
    }
    if (token === "--format" || token.startsWith("--format=")) {
      const value = token === "--format" ? argv[++index] : token.slice("--format=".length);
      if (value === undefined || value.length === 0) {
        throw new CliParseError(createFormatError("--format requires a value."), format);
      }
      if (formatSource !== undefined) {
        throw new CliParseError(
          createFormatError(
            `Output format flags ${formatSource} and --format are mutually exclusive.`,
          ),
          format,
        );
      }
      format = parseFormat(value);
      formatSource = "--format";
      continue;
    }
    if (token === "--color" || token.startsWith("--color=")) {
      const value = token === "--color" ? argv[++index] : token.slice("--color=".length);
      color = parseEnum(value, ["auto", "always", "never"], "--color") as ColorMode;
      continue;
    }
    if (token === "--interactive" || token.startsWith("--interactive=")) {
      const value =
        token === "--interactive" ? argv[++index] : token.slice("--interactive=".length);
      interactive = parseEnum(
        value,
        ["auto", "always", "never"],
        "--interactive",
      ) as InteractiveMode;
      continue;
    }
    args.push(token);
  }

  return { options: { format, color, interactive }, args, helpRequested };
}

function parseCommand(command: string, args: readonly string[]): ParsedCommand {
  switch (command) {
    case "help":
      ensureNoArguments(args, "help");
      return { kind: "help" };
    case "version":
      ensureNoArguments(args, "version");
      return { kind: "version" };
    case "doctor":
      ensureNoArguments(args, "doctor");
      return { kind: "doctor" };
    case "completion":
      return parseCompletion(args);
    case "team":
    case "expert":
    case "flow":
      return parseExecutorCommand(command, args);
    case "mission":
      return parseMissionCommand(args);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function parseCompletion(args: readonly string[]): ParsedCommand {
  const { positionals } = parseOptions(args, {}, "completion");
  if (positionals.length !== 1) throw new Error("completion requires exactly one shell.");
  return {
    kind: "completion",
    shell: parseEnum(
      positionals[0],
      ["bash", "zsh", "fish", "powershell"],
      "shell",
    ) as CompletionShell,
  };
}

function parseExecutorCommand(command: ExecutorKind, args: readonly string[]): ParsedCommand {
  if (args[0] === "run") return parseExecutorRunCommand(command, args.slice(1));
  const { positionals, values } = parseOptions(
    args,
    {
      project: "value",
      query: "value",
      status: "value",
      limit: "value",
      cursor: "value",
      revision: "value",
    },
    command,
  );
  const subcommand = positionals[0];
  if (subcommand !== "discover" && subcommand !== "describe") {
    throw new Error(`${command} requires discover or describe.`);
  }
  if (subcommand === "discover") {
    if (positionals.length !== 1)
      throw new Error(`${command} discover does not accept positional arguments.`);
    return {
      kind: "executor-discover",
      executorKind: command,
      project: optionalValue(values, "project"),
      query: optionalValue(values, "query"),
      status: optionalEnum(values, "status", ["ready", "needs_attention", "unavailable"]) as
        ExecutorStatus | undefined,
      limit: optionalPositiveInteger(values, "limit") ?? DEFAULT_LIMIT,
      cursor: optionalValue(values, "cursor"),
    };
  }
  if (positionals.length !== 2) throw new Error(`${command} describe requires a resource ref.`);
  return {
    kind: "executor-describe",
    executorKind: command,
    ref: positionals[1]!,
    revision: optionalPositiveInteger(values, "revision"),
  };
}

function parseExecutorRunCommand(
  executorKind: ExecutorKind,
  args: readonly string[],
): Extract<ParsedCommand, { readonly kind: "executor-run" }> {
  const { positionals, values } = parseOptions(
    args,
    {
      workspace: "value",
      prompt: "value",
      input: "value",
      "input-json": "value",
      project: "value",
      revision: "value",
      "expected-fingerprint": "value",
      "request-id": "value",
      detach: "flag",
    },
    `${executorKind} run`,
  );
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

function parseMissionCommand(args: readonly string[]): ParsedCommand {
  const { positionals, values } = parseOptions(
    args,
    {
      status: "value",
      executor: "value",
      limit: "value",
      cursor: "value",
      view: "value",
      after: "value",
      replay: "value",
      until: "value",
      start: "value",
      offset: "value",
      "case-sensitive": "flag",
      "context-lines": "value",
      "max-results": "value",
      project: "value",
      revision: "value",
      "expected-fingerprint": "value",
      prompt: "value",
      input: "value",
      "request-id": "value",
      wait: "flag",
      detach: "flag",
      "ack-timeout": "value",
      "expected-execution": "value",
      interaction: "value",
      answer: "value",
      choice: "value",
      "answers-json": "value",
      reason: "value",
      request: "value",
    },
    "mission",
  );
  const subcommand = positionals[0];
  if (subcommand === "list") {
    assertOnlyOptions(values, ["status", "executor", "limit", "cursor"], "mission list");
    if (positionals.length !== 1)
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
    if (positionals.length !== 2) throw new Error("mission get requires a Mission ID.");
    return {
      kind: "mission-get",
      missionId: positionals[1]!,
      view: (optionalEnum(values, "view", ["summary", "result", "chat", "work", "events"]) ??
        "summary") as MissionView,
      limit: optionalPositiveInteger(values, "limit") ?? DEFAULT_LIMIT,
      cursor: optionalValue(values, "cursor"),
    };
  }
  if (subcommand === "watch") {
    assertOnlyOptions(values, ["after", "replay", "until"], "mission watch");
    if (positionals.length !== 2) throw new Error("mission watch requires a Mission ID.");
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
      missionId: positionals[1]!,
      ...(after === undefined ? {} : { after }),
      ...(replay === undefined ? {} : { replay }),
      until: optionalEnum(values, "until", ["terminal", "input-required"]) as
        "terminal" | "input-required" | undefined,
    };
  }
  if (subcommand === "board") return parseBoardCommand(positionals.slice(1), values);
  if (subcommand === "queue") return parseQueueCommand(positionals.slice(1), values);
  if (subcommand === "resume") return parseMissionResumeCommand(positionals.slice(1), values);
  if (subcommand === "send" || subcommand === "steer") {
    return parseMissionMessageCommand(subcommand, positionals.slice(1), values);
  }
  if (subcommand === "respond") return parseMissionRespondCommand(positionals.slice(1), values);
  if (subcommand === "interrupt") return parseMissionInterruptCommand(positionals.slice(1), values);
  throw new Error(
    "mission requires list, get, resume, watch, send, steer, respond, interrupt, board, or queue.",
  );
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

type OptionType = "flag" | "value";
type OptionValue = string | true | readonly string[];

function parseOptions(
  args: readonly string[],
  allowed: Readonly<Record<string, OptionType>>,
  command: string,
): {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, OptionValue>;
} {
  const positionals: string[] = [];
  const values = new Map<string, OptionValue>();
  let optionsTerminated = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (optionsTerminated || !token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      optionsTerminated = true;
      continue;
    }
    const withoutPrefix = token.slice(2);
    const equalIndex = withoutPrefix.indexOf("=");
    const name = equalIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, equalIndex);
    const inlineValue = equalIndex === -1 ? undefined : withoutPrefix.slice(equalIndex + 1);
    const optionType = allowed[name];
    if (optionType === undefined) throw new Error(`Unknown option --${name} for ${command}.`);
    if (optionType === "flag") {
      if (inlineValue !== undefined) throw new Error(`Option --${name} does not accept a value.`);
      if (values.has(name)) throw new Error(`Option --${name} may only be specified once.`);
      values.set(name, true);
      continue;
    }
    const value = inlineValue ?? args[++index];
    if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) {
      throw new Error(`Option --${name} requires a value.`);
    }
    const existing = values.get(name);
    if (name === "choice" && existing !== undefined) {
      values.set(name, [
        ...(typeof existing === "string" ? [existing] : Array.isArray(existing) ? existing : []),
        value,
      ]);
    } else {
      if (existing !== undefined) throw new Error(`Option --${name} may only be specified once.`);
      values.set(name, value);
    }
  }
  return { positionals, values };
}

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

function ensureNoArguments(args: readonly string[], command: string): void {
  const { positionals, values } = parseOptions(args, {}, command);
  if (positionals.length !== 0 || values.size !== 0)
    throw new Error(`${command} does not accept arguments.`);
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
