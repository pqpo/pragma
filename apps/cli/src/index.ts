import {
  createIntegrationError,
  integrationErrorExitCode,
  type IntegrationError,
} from "@pragma/local-host/wire";
import type { AgentMessageUsage, JsonValue } from "@pragma/shared";
import type { LocalHostRunApplicationOutcome } from "@pragma/local-host";

import {
  codeForError,
  DoctorFailure,
  runDoctorCommand,
  selectPrimaryDoctorCode,
  type DoctorDependencies,
} from "./commands/doctor.ts";
import { toIntegrationError } from "./commands/errors.ts";
import { executeReadOnlyCommand } from "./commands/readonly.ts";
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
  presentRunFailure,
  presentRunOutcome,
  presentSuccess,
  type CliIo,
  type CliRunPresentationOutcome,
} from "./presenters/index.ts";

export const CLI_VERSION = "0.0.0";

export type { CliIo, CliLocalHost };
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

  if (parsed.command.kind === "executor-run" && parsed.command.requestId !== undefined) {
    requestId = parsed.command.requestId;
  }

  const context = {
    requestId,
    cliVersion: CLI_VERSION,
    startedAt,
    localHost: createCliLocalHost(dependencies),
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
      const terminal = dependencies.terminal ?? createSystemTerminalPort();
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
              replayable: event.replayable,
              cursor: event.cursor,
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
    const result =
      parsed.command.kind === "doctor"
        ? await runDoctorCommand(dependencies)
        : await executeReadOnlyCommand(parsed.command, context);
    presentSuccess(
      {
        io,
        format: parsed.options.format,
        requestId,
        command,
        cliVersion: CLI_VERSION,
        startedAt,
      },
      result,
    );
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
    } else {
      presentFailure(presentationInput, integrationError, {
        textToStdout: parsed.command.kind === "doctor",
      });
    }
    return integrationErrorExitCode(integrationError.code);
  }
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

export type { IntegrationError };
