import { createLoggerProvider, type PragmaLoggerProvider } from "@pragma/core";
import type { PragmaLogLevel, PragmaLogRecord } from "@pragma/shared";

/**
 * CLI-owned logger sink. Core's default console provider intentionally keeps
 * its existing process-wide semantics; the CLI injects this provider so
 * structured diagnostics never share the result stream on stdout.
 */
export function createLocalHostStderrLoggerProvider(
  options: {
    readonly minimumLevel?: PragmaLogLevel | "silent" | undefined;
    readonly write?: ((line: string) => void) | undefined;
  } = {},
): PragmaLoggerProvider {
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  return createLoggerProvider({
    minimumLevel: options.minimumLevel ?? "info",
    host: { kind: "cli", pid: process.pid },
    handler: {
      write: (record: PragmaLogRecord) => write(`${JSON.stringify(record)}\n`),
    },
  });
}
