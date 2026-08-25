import { integrationErrorExitCode, type IntegrationError } from "@pragma/local-host/wire";

import {
  codeForError,
  DoctorFailure,
  runDoctorCommand,
  selectPrimaryDoctorCode,
  type DoctorDependencies,
} from "./commands/doctor.ts";
import { toIntegrationError } from "./commands/errors.ts";
import { executeReadOnlyCommand } from "./commands/readonly.ts";
import type { CliLocalHost } from "./commands/types.ts";
import { createCliLocalHost } from "./composition/default.ts";
import { CliParseError, parseCliArgv, type ParsedCommand } from "./parser/argv.ts";
import { presentFailure, presentSuccess, type CliIo } from "./presenters/index.ts";

export const CLI_VERSION = "0.0.0";

export type { CliIo, CliLocalHost };
export { codeForError, selectPrimaryDoctorCode };

export type CliDependencies = Readonly<
  DoctorDependencies & {
    readonly localHost?: CliLocalHost;
  }
>;

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  const startedAt = new Date();
  const requestId = globalThis.crypto.randomUUID();
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

  const context = {
    requestId,
    cliVersion: CLI_VERSION,
    startedAt,
    localHost: createCliLocalHost(dependencies),
  };
  const command = commandName(parsed.command);
  try {
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
      error instanceof DoctorFailure ? error.error : toIntegrationError(error);
    presentFailure(
      {
        io,
        format: parsed.options.format,
        requestId,
        command,
        cliVersion: CLI_VERSION,
        startedAt,
      },
      integrationError,
      { textToStdout: parsed.command.kind === "doctor" },
    );
    return integrationErrorExitCode(integrationError.code);
  }
}

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
