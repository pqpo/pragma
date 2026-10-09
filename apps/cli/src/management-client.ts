import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Command, CommanderError } from "commander";
import {
  callManagementCommand,
  describeManagementCommand,
  MANAGEMENT_COMMAND_ENDPOINT_ENV,
} from "@pragma/local-host/management";
import {
  MANAGEMENT_COMMAND_PROTOCOL,
  ManagementCommandSchema,
  ManagementCommandRequestSchema,
  RequestIdSchema,
  type ManagementCommand,
  managementCommandError,
  integrationErrorExitCode,
  type ManagementCommandRequest,
  type ManagementCommandResult,
} from "@pragma/shared/integration";
import { readBoundedJson, readProcessStdin } from "./input.ts";
import { toIntegrationError } from "./commands/errors.ts";

interface CommandIo {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

export function isManagementCliArgv(argv: readonly string[]): boolean {
  let index = 0;
  while (argv[index]?.startsWith("-")) {
    const option = argv[index]!.split("=", 1)[0];
    if (["--format", "--color", "--interactive"].includes(option!))
      index += argv[index]!.includes("=") ? 1 : 2;
    else if (["--json", "--stream-json"].includes(option!)) index += 1;
    else return false;
  }
  return argv[index] === "manage";
}

export async function runManagementCli(
  argv: readonly string[],
  io: CommandIo,
  options: {
    readonly endpoint?: string | undefined;
    readonly readStdin?: (() => Promise<Uint8Array>) | undefined;
    readonly execute?:
      ((request: ManagementCommandRequest) => Promise<ManagementCommandResult>) | undefined;
  } = {},
): Promise<number> {
  const requestIdDefault = randomUUID();
  let help = "";
  let requestId: string = requestIdDefault;
  let activeCommand: ManagementCommand | undefined;
  let outputFormat = "json";
  const parser = new Command("pragma").exitOverride().configureOutput({
    writeOut: (text) => {
      help += text;
    },
    writeErr: () => undefined,
  });
  parser
    .description("Execution-authorized Pragma management commands")
    .option("--format <format>", "Output format: json or text")
    .option("--json", "Alias for --format json")
    .option("--stream-json", "Streaming is unavailable for management commands")
    .option("--color <mode>", "Accepted common CLI display setting")
    .option("--interactive <mode>", "Approvals are owned by the active Execution")
    .on("option:format", (value: string) => {
      outputFormat = value;
    })
    .on("option:json", () => {
      outputFormat = "json";
    });
  const management = parser
    .command("manage")
    .description("Manage Pragma resources in the owning Execution");
  const groups = new Map<string, Command>();
  let resultCode = 0;
  for (const name of ManagementCommandSchema.options) {
    const parts = name.split(".");
    const actionName = parts.pop()!;
    let area = management;
    let key = "manage";
    for (const part of parts) {
      key += `.${part}`;
      let child = groups.get(key);
      if (child === undefined) {
        child = area.command(part);
        groups.set(key, child);
      }
      area = child;
    }
    const info = describeManagementCommand(name);
    area
      .command(actionName)
      .description(info.description)
      .option("--input <path>", "JSON request object; use - for stdin")
      .option(
        "--request-id <uuid>",
        "Stable identity; reuse only for the identical request",
        requestIdDefault,
      )
      .option("--format <format>", "Output format: json or text", "json")
      .on("option:request-id", (value: string) => {
        activeCommand = name;
        requestId = RequestIdSchema.safeParse(value).data ?? requestIdDefault;
      })
      .on("option:format", (value: string) => {
        outputFormat = value;
      })
      .addHelpText(
        "after",
        () =>
          `\nInput Schema (loaded only by this help):\n${JSON.stringify(info.inputSchema, null, 2)}\n\nExample:\n  pragma manage ${name.replaceAll(".", " ")} --input request.json --format json\n`,
      )
      .action(async (_localArgs, command: Command) => {
        const args = command.optsWithGlobals() as {
          input?: string;
          requestId: string;
          format: string;
          json?: boolean;
          streamJson?: boolean;
        };
        activeCommand = name;
        requestId = RequestIdSchema.safeParse(args.requestId).data ?? requestIdDefault;
        outputFormat = args.json ? "json" : args.format;
        if (args.streamJson)
          throw managementCommandError(
            "INVALID_FORMAT",
            "Management commands support --format json or text.",
          );
        if (outputFormat !== "json" && outputFormat !== "text")
          throw managementCommandError("INVALID_FORMAT", "Use --format json or text.");
        if (args.input !== undefined && args.input !== "-") {
          const root = process.env["PRAGMA_EXECUTION_WORKSPACE"];
          if (root !== undefined) {
            const canonicalRoot = await realpath(root);
            const canonicalInput = await realpath(args.input);
            const path = relative(canonicalRoot, canonicalInput);
            if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`))
              throw managementCommandError(
                "WORKSPACE_ACCESS_DENIED",
                "The input file is outside the authorized Mission workspace.",
              );
          }
        }
        const input =
          args.input === undefined
            ? {}
            : await readBoundedJson(args.input, options.readStdin ?? readProcessStdin);
        const request = ManagementCommandRequestSchema.parse({
          protocol: MANAGEMENT_COMMAND_PROTOCOL,
          requestId: args.requestId,
          command: name,
          input,
        });
        const result =
          options.execute === undefined
            ? await callManagementCommand({
                request,
                endpoint: options.endpoint ?? process.env[MANAGEMENT_COMMAND_ENDPOINT_ENV],
              })
            : await options.execute(request);
        resultCode = result.exitCode;
        io.writeStdout(
          `${outputFormat === "json" ? JSON.stringify(result) : JSON.stringify(result.result ?? result.error, null, 2)}\n`,
        );
      });
  }
  try {
    await parser.parseAsync([...argv], { from: "user" });
    if (help) io.writeStdout(help);
    return resultCode;
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      io.writeStdout(help);
      return 0;
    }
    const failure = toIntegrationError(error, "INVALID_ARGUMENT");
    const result = {
      protocol: MANAGEMENT_COMMAND_PROTOCOL,
      requestId,
      ...(activeCommand === undefined ? {} : { command: activeCommand }),
      status: "failed",
      exitCode: integrationErrorExitCode(failure.code),
      error: failure,
    };
    io.writeStdout(
      `${outputFormat === "text" ? JSON.stringify(failure, null, 2) : JSON.stringify(result)}\n`,
    );
    return integrationErrorExitCode(failure.code);
  }
}
