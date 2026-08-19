import type { LocalHostApplicationPort } from "@pragma/local-host";

export const CLI_VERSION = "0.0.0";

export type CliIo = Readonly<{
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
}>;

/** The future composition root injects this application port; CLI parsing never owns business logic. */
export type CliLocalHost = LocalHostApplicationPort;

export function runCli(argv: readonly string[], io: CliIo): number {
  const [command] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.writeStdout("Usage: pragma <command>\n\nCommands:\n  version\n  help\n");
    return 0;
  }

  if (command === "version") {
    io.writeStdout(`pragma ${CLI_VERSION}\n`);
    return 0;
  }

  io.writeStderr(`Unknown command: ${command}\nRun 'pragma --help' for usage.\n`);
  return 2;
}
