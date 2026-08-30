import {
  createIntegrationError,
  integrationErrorExitCode,
  type IntegrationError,
} from "@pragma/local-host/wire";
import type { AgentMessageUsage, JsonValue } from "@pragma/shared";
import type { LocalHostRunApplicationOutcome, MissionWatchResult } from "@pragma/local-host";

import {
  codeForError,
  DoctorFailure,
  runDoctorCommand,
  selectPrimaryDoctorCode,
  type DoctorDependencies,
} from "./commands/doctor.ts";
import { toIntegrationError } from "./commands/errors.ts";
import { executeReadOnlyCommand } from "./commands/readonly.ts";
import { executeMutationCommand } from "./commands/mutations.ts";
import { startExecutorRun } from "./commands/run.ts";
import type { CliLocalHost } from "./commands/types.ts";
import { createCliLocalHost } from "./composition/default.ts";
import { CliInputError, readProcessStdin } from "./input.ts";
import { CliParseError, parseCliArgv, type ParsedCommand } from "./parser/argv.ts";
import {
  collectHumanInteraction,
  createSystemTerminalPort,
  type TerminalPort,
} from "./terminal.ts";
import { createProcessSignalPort, type SignalPort } from "./signal.ts";
import {
  createV2StreamPresenter,
  presentFailure,
  presentAccepted,
  presentInputRequired,
  presentRunFailure,
  presentRunOutcome,
  presentSuccess,
  renderWatchEventText,
  type CliIo,
  type CliRunPresentationOutcome,
} from "./presenters/index.ts";
import { CLI_VERSION } from "./version.ts";

export type { CliIo, CliLocalHost };
export { CLI_VERSION };
export { codeForError, selectPrimaryDoctorCode };

export type CliDependencies = Readonly<
  DoctorDependencies & {
    readonly localHost?: CliLocalHost;
    readonly readStdin?: (() => Promise<Uint8Array>) | undefined;
    readonly terminal?: TerminalPort | undefined;
    readonly signals?: SignalPort | undefined;
  }
>;

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  const startedAt = new Date();
  let requestId: string = globalThis.crypto.randomUUID();
  let parsed;
  try {
    parsed = parseCliArgv(argv);
  } catch (error) {
    const parseError =
      error instanceof CliParseError
        ? error
        : new CliParseError(toIntegrationError(error, "INVALID_ARGUMENT"), "text");
    const integrationError = parseError.error;
    presentFailure(
      {
        io,
        format: parseError.format,
        requestId,
        command: "cli.parse",
        cliVersion: CLI_VERSION,
        startedAt,
      },
      integrationError,
    );
    return integrationErrorExitCode(integrationError.code);
  }

  if ("requestId" in parsed.command && parsed.command.requestId !== undefined) {
    requestId = parsed.command.requestId;
  }

  const context = {
    requestId,
    cliVersion: CLI_VERSION,
    startedAt,
    localHost: createCliLocalHost(dependencies),
    format: parsed.options.format,
    interactive: parsed.options.interactive,
    terminal: dependencies.terminal ?? createSystemTerminalPort(),
  };
  const command = commandName(parsed.command);
  let runStreamPresenter: ReturnType<typeof createV2StreamPresenter> | undefined;
  try {
    if (parsed.command.kind === "executor-run") {
      runStreamPresenter =
        parsed.options.format === "jsonl"
          ? createV2StreamPresenter({
              io,
              format: parsed.options.format,
              requestId,
              command,
              cliVersion: CLI_VERSION,
              startedAt,
            })
          : undefined;
      let activeHandle: Awaited<ReturnType<typeof startExecutorRun>> | undefined;
      const terminal = context.terminal;
      if (parsed.options.interactive === "always" && !terminal.isControllingTerminal()) {
        throw createIntegrationError({
          code: "INTERACTIVE_TTY_REQUIRED",
          category: "usage",
          message: "--interactive always requires a controlling terminal.",
        });
      }
      const useTerminalInteraction =
        !parsed.command.detach &&
        (parsed.options.interactive === "always" ||
          (parsed.options.interactive === "auto" &&
            parsed.options.format === "text" &&
            terminal.isControllingTerminal()));
      let interrupting = false;
      let terminalCommitted = false;
      const removeSignalHandler = (dependencies.signals ?? createProcessSignalPort()).onInterrupt(
        () => {
          if (terminalCommitted || interrupting) return;
          interrupting = true;
          void activeHandle?.cancel("SIGINT");
        },
      );
      try {
        if (parsed.options.format === "text") {
          const requestIdNote =
            parsed.command.requestId === undefined
              ? " (generated; reuse with --request-id for an exact retry)"
              : " (provided)";
          io.writeStderr(`Request ID: ${requestId}${requestIdNote}\n`);
        }
        const handle = await startExecutorRun(parsed.command, context, {
          readStdin: dependencies.readStdin ?? readProcessStdin,
          onHumanInteraction: useTerminalInteraction
            ? async (request) => ({
                kind: "respond" as const,
                response: (await collectHumanInteraction(terminal, request)).interaction,
              })
            : async () => ({ kind: "checkpoint" as const }),
          onEvent: (event) => {
            runStreamPresenter?.emit({
              type: event.type,
              data: event.data,
              eventId: event.eventId,
              replayable: event.replayable,
              cursor: event.cursor,
              emittedAt: event.occurredAt,
              ...(activeHandle?.missionId === undefined
                ? {}
                : { missionId: activeHandle.missionId }),
              ...(activeHandle?.executionId === undefined
                ? {}
                : { executionId: activeHandle.executionId }),
            });
          },
        });
        activeHandle = handle;
        if (parsed.options.format === "text") {
          io.writeStderr(
            `Mission ID: ${handle.missionId}\nExecution ID: ${handle.executionId ?? "unknown"}\n`,
          );
        }
        if (interrupting) void handle.cancel("SIGINT");
        const rawOutcome = await handle.outcome;
        terminalCommitted = true;
        const outcome = interrupting
          ? {
              status: "interrupted" as const,
              missionId: rawOutcome.missionId,
              executionId: rawOutcome.executionId,
              ...(rawOutcome.usage === undefined ? {} : { usage: rawOutcome.usage }),
            }
          : rawOutcome;
        const presentation = normalizeRunOutcome(outcome, handle.request);
        if (runStreamPresenter === undefined) {
          presentRunOutcome(
            {
              io,
              format: parsed.options.format,
              requestId,
              command,
              cliVersion: CLI_VERSION,
              startedAt,
            },
            presentation,
          );
        } else {
          runStreamPresenter.finalize(presentation);
        }
        return interrupting ? 130 : runOutcomeExitCode(outcome);
      } finally {
        removeSignalHandler();
      }
    }
    const presentationInput = {
      io,
      format: parsed.options.format,
      requestId,
      command,
      cliVersion: CLI_VERSION,
      startedAt,
      continuationCommand: (cursor: string) => continuationCommandFor(parsed.command, cursor),
    } as const;
    if (parsed.command.kind === "mission-watch") {
      if (context.localHost.watchMission === undefined) {
        throw createIntegrationError({
          code: "DEPENDENCY_UNAVAILABLE",
          category: "dependency",
          message: "Mission watch is unavailable in this Host composition.",
        });
      }
      runStreamPresenter =
        parsed.options.format === "jsonl" ? createV2StreamPresenter(presentationInput) : undefined;
      const abortController = new AbortController();
      let signalRequested = false;
      let streamCommitted = false;
      const removeSignalHandler = (dependencies.signals ?? createProcessSignalPort()).onInterrupt(
        () => {
          if (streamCommitted || signalRequested) return;
          signalRequested = true;
          abortController.abort();
        },
      );
      try {
        const result = await context.localHost.watchMission({
          missionId: parsed.command.missionId,
          ...(parsed.command.after === undefined ? {} : { after: parsed.command.after }),
          ...(parsed.command.replay === undefined ? {} : { replay: parsed.command.replay }),
          ...(parsed.command.until === undefined ? {} : { until: parsed.command.until }),
          signal: abortController.signal,
          onEvent: async (event) => {
            if (runStreamPresenter !== undefined) {
              runStreamPresenter.emit({
                type: event.type,
                data: event.data,
                missionId: event.missionId,
                executionId: event.executionId,
                eventId: event.eventId,
                replayable: event.replayable,
                cursor: event.cursor,
                emittedAt: event.occurredAt,
              });
            } else {
              io.writeStdout(renderWatchEventText(event));
            }
          },
        });
        streamCommitted = true;
        if (result.status === "detached") {
          const detachedEvent = {
            missionId: result.missionId,
            missionContinues: true,
            lastCursor: result.lastCursor,
          } as const;
          if (runStreamPresenter !== undefined) {
            runStreamPresenter.emit({
              type: "watch.detached",
              data: detachedEvent,
              missionId: result.missionId,
              replayable: false,
            });
          } else {
            io.writeStdout(renderWatchEventText({ type: "watch.detached", data: detachedEvent }));
          }
        } else if (runStreamPresenter === undefined) {
          io.writeStdout(renderWatchCompletionText(result));
        }
        if (runStreamPresenter !== undefined) {
          runStreamPresenter.finalize({
            status: "succeeded",
            missionId: result.missionId,
            result: watchResultData(result),
            lastCursor: result.lastCursor,
          });
        }
        return 0;
      } finally {
        removeSignalHandler();
      }
    }
    if (isMutationCommand(parsed.command)) {
      const mutation = await executeMutationCommand(
        parsed.command,
        context,
        dependencies.readStdin ?? readProcessStdin,
      );
      if (mutation.status === "input_required") {
        presentInputRequired(presentationInput, mutation.result);
        return 3;
      }
      if (mutation.detached) presentAccepted(presentationInput, mutation.result);
      else presentSuccess(presentationInput, mutation.result);
    } else {
      const result =
        parsed.command.kind === "doctor"
          ? await runDoctorCommand(dependencies)
          : await executeReadOnlyCommand(parsed.command, context);
      if (parsed.command.kind === "mission-resume" && isInputRequiredResult(result)) {
        presentInputRequired(presentationInput, result);
        return 3;
      }
      if (parsed.command.kind === "mission-resume" && parsed.command.detach) {
        presentAccepted(presentationInput, result);
      } else {
        presentSuccess(presentationInput, result);
      }
    }
    return 0;
  } catch (error) {
    const integrationError =
      error instanceof DoctorFailure
        ? error.error
        : error instanceof CliInputError
          ? createIntegrationError({
              code:
                parsed.command.kind === "executor-run" && parsed.command.executorKind === "flow"
                  ? "INPUT_SCHEMA_INVALID"
                  : "INVALID_ARGUMENT",
              category: "usage",
              message: error.message,
            })
          : toIntegrationError(error);
    const presentationInput = {
      io,
      format: parsed.options.format,
      requestId,
      command,
      cliVersion: CLI_VERSION,
      startedAt,
    } as const;
    if (parsed.command.kind === "executor-run") {
      if (runStreamPresenter !== undefined) {
        runStreamPresenter.finalize({ status: "failed", error: integrationError });
      } else {
        presentRunFailure(presentationInput, integrationError);
      }
    } else if (runStreamPresenter !== undefined) {
      runStreamPresenter.finalize({ status: "failed", error: integrationError });
    } else {
      presentFailure(presentationInput, integrationError, {
        textToStdout: parsed.command.kind === "doctor",
      });
    }
    return integrationErrorExitCode(integrationError.code);
  }
}

function isInputRequiredResult(value: JsonValue): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { readonly status?: unknown }).status === "input_required"
  );
}

function watchResultData(result: MissionWatchResult): JsonValue {
  return {
    missionId: result.missionId,
    status: result.status,
    missionContinues: result.missionContinues,
    lastCursor: result.lastCursor,
    ...(result.until === undefined ? {} : { until: result.until }),
  };
}

function renderWatchCompletionText(result: MissionWatchResult): string {
  const until = result.until === undefined ? "watch" : `--until ${result.until}`;
  return `Mission ${result.missionId} reached ${until}; cursor ${result.lastCursor}.\n`;
}

function runOutcomeExitCode(outcome: {
  readonly status: "accepted" | "succeeded" | "input_required" | "failed" | "interrupted";
  readonly error?: IntegrationError | undefined;
}): number {
  if (outcome.status === "accepted" || outcome.status === "succeeded") return 0;
  if (outcome.status === "input_required") return 3;
  if (outcome.status === "interrupted") return 130;
  return integrationErrorExitCode(outcome.error?.code ?? "INTERNAL_ERROR");
}

function normalizeRunOutcome(
  outcome: LocalHostRunApplicationOutcome | CliInterruptedOutcome,
  request?: {
    readonly executor: CliRunPresentationOutcome["executor"];
    readonly workspace: CliRunPresentationOutcome["workspace"];
  },
): CliRunPresentationOutcome {
  const pinned = {
    ...(request?.executor === undefined ? {} : { executor: request.executor }),
    ...(request?.workspace === undefined ? {} : { workspace: request.workspace }),
  };
  if (outcome.status === "accepted") return { ...outcome, ...pinned };
  if (outcome.status === "succeeded") {
    return { ...outcome, ...pinned, result: outcome.result ?? null };
  }
  if (outcome.status === "input_required") {
    return {
      status: outcome.status,
      missionId: outcome.missionId,
      executionId: outcome.executionId,
      ...pinned,
      ...(outcome.interaction === undefined ? {} : { interaction: outcome.interaction }),
      ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
    };
  }
  if (outcome.status === "failed") {
    return {
      status: outcome.status,
      missionId: outcome.missionId,
      executionId: outcome.executionId,
      ...pinned,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
    };
  }
  return {
    status: "interrupted",
    missionId: outcome.missionId,
    executionId: outcome.executionId,
    ...pinned,
    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
  };
}

type CliInterruptedOutcome = {
  readonly status: "interrupted";
  readonly missionId?: string | undefined;
  readonly executionId?: string | undefined;
  readonly usage?: AgentMessageUsage | undefined;
  readonly result?: JsonValue | undefined;
  readonly interaction?: unknown | undefined;
  readonly error?: IntegrationError | undefined;
};

function commandName(command: ParsedCommand): string {
  switch (command.kind) {
    case "help":
      return "help";
    case "version":
      return "version";
    case "doctor":
      return "doctor";
    case "completion":
      return "completion";
    case "executor-discover":
      return `${command.executorKind}.discover`;
    case "executor-describe":
      return `${command.executorKind}.describe`;
    case "executor-run":
      return `${command.executorKind}.run`;
    case "mission-list":
      return "mission.list";
    case "mission-get":
      return "mission.get";
    case "mission-watch":
      return "mission.watch";
    case "mission-resume":
      return "mission.resume";
    case "mission-send":
      return "mission.send";
    case "mission-steer":
      return "mission.steer";
    case "mission-respond":
      return "mission.respond";
    case "mission-interrupt":
      return "mission.interrupt";
    case "queue-remove":
      return "mission.queue.remove";
    case "queue-resume":
      return "mission.queue.resume";
    case "queue-steer":
      return "mission.queue.steer";
    case "board-list":
      return "mission.board.list";
    case "board-read":
      return "mission.board.read";
    case "board-search":
      return "mission.board.search";
    case "queue-list":
      return "mission.queue.list";
  }
}

function continuationCommandFor(command: ParsedCommand, cursor: string): string {
  const encodedCursor = shellArgument(cursor);
  switch (command.kind) {
    case "executor-discover":
      return [
        "pragma",
        command.executorKind,
        "discover",
        ...(command.selector === undefined ? [] : [shellArgument(command.selector)]),
        ...(command.query === undefined ? [] : ["--query", shellArgument(command.query)]),
        ...(command.project === undefined ? [] : ["--project", shellArgument(command.project)]),
        ...(command.status === undefined ? [] : ["--status", command.status]),
        "--limit",
        String(command.limit),
        "--cursor",
        encodedCursor,
      ].join(" ");
    case "mission-list":
      return [
        "pragma",
        "mission",
        "list",
        ...(command.status === undefined ? [] : ["--status", command.status]),
        ...(command.executor === undefined ? [] : ["--executor", shellArgument(command.executor)]),
        "--limit",
        String(command.limit),
        "--cursor",
        encodedCursor,
      ].join(" ");
    case "mission-get":
      return [
        "pragma",
        "mission",
        "get",
        shellArgument(command.missionId),
        "--view",
        command.view,
        "--limit",
        String(command.limit),
        "--cursor",
        encodedCursor,
      ].join(" ");
    case "queue-list":
      return [
        "pragma",
        "mission",
        "queue",
        "list",
        shellArgument(command.missionId),
        "--limit",
        String(command.limit),
        "--cursor",
        encodedCursor,
      ].join(" ");
    case "board-list":
      return [
        "pragma",
        "mission",
        "board",
        "list",
        shellArgument(command.missionId),
        "--limit",
        String(command.limit),
        "--cursor",
        encodedCursor,
      ].join(" ");
    default:
      return `pragma ${commandName(command).replaceAll(".", " ")} --cursor ${encodedCursor}`;
  }
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function isMutationCommand(command: ParsedCommand): command is Extract<
  ParsedCommand,
  {
    readonly kind:
      | "mission-send"
      | "mission-steer"
      | "mission-respond"
      | "mission-interrupt"
      | "queue-remove"
      | "queue-resume"
      | "queue-steer";
  }
> {
  return (
    command.kind === "mission-send" ||
    command.kind === "mission-steer" ||
    command.kind === "mission-respond" ||
    command.kind === "mission-interrupt" ||
    command.kind === "queue-remove" ||
    command.kind === "queue-resume" ||
    command.kind === "queue-steer"
  );
}

export type { IntegrationError };
