import type {
  LocalHostRunApplicationHandle,
  LocalHostRunEvent,
  LocalHostRunRequest,
} from "@pragma/local-host";
import { createIntegrationError } from "@pragma/local-host/wire";
import type { HumanInteractionRequestEnvelope } from "@pragma/local-host/wire";

import { readBoundedJson, readBoundedUtf8 } from "../input.ts";
import type { ParsedCommand } from "../parser/argv.ts";
import type { InteractiveMode } from "../parser/argv.ts";
import type { CliCommandContext } from "./types.ts";

export async function startExecutorRun(
  command: Extract<ParsedCommand, { readonly kind: "executor-run" }>,
  context: CliCommandContext,
  options: {
    readonly readStdin?: (() => Promise<Uint8Array>) | undefined;
    readonly onEvent?: ((event: LocalHostRunEvent) => void) | undefined;
    readonly interactive?: InteractiveMode | undefined;
    readonly onHumanInteraction?:
      | ((request: HumanInteractionRequestEnvelope) => Promise<
          | { readonly kind: "respond"; readonly response: unknown }
          | { readonly kind: "checkpoint" }
        >)
      | undefined;
  } = {},
): Promise<LocalHostRunApplicationHandle> {
  const run = context.localHost.run;
  if (run === undefined) {
    throw createIntegrationError({
      code: "DEPENDENCY_UNAVAILABLE",
      category: "dependency",
      message: "Local Host run composition is unavailable.",
    });
  }
  const workspace = await context.localHost.resolveWorkspace(command.workspace);
  const input = await readRunInput(command, options.readStdin);
  const request: LocalHostRunRequest = {
    requestId: context.requestId,
    command: `${command.executorKind}.run`,
    executor: { kind: command.executorKind, id: command.ref.slice(command.executorKind.length + 1) },
    workspace,
    ...(command.prompt === undefined ? {} : { prompt: command.prompt }),
    ...(input.kind === "prompt" ? { prompt: input.value } : { input: input.value }),
    ...(command.project === undefined ? {} : {
      project: {
        projectId: command.project,
        ...(command.revision === undefined ? {} : { revision: command.revision }),
      },
    }),
    ...(command.expectedFingerprint === undefined
      ? {}
      : { expectedFingerprint: command.expectedFingerprint }),
    detach: command.detach,
  };
  return await run.start(request, {
    onEvent: options.onEvent,
    ...(options.onHumanInteraction === undefined ? {} : { onHumanInteraction: options.onHumanInteraction }),
  });
}

async function readRunInput(
  command: Extract<ParsedCommand, { readonly kind: "executor-run" }>,
  readStdin: (() => Promise<Uint8Array>) | undefined,
): Promise<{ readonly kind: "prompt"; readonly value: string } | { readonly kind: "json"; readonly value: Record<string, unknown> }> {
  if (command.executorKind === "flow") {
    return { kind: "json", value: await readBoundedJson(command.inputJsonPath!, readStdin) };
  }
  if (command.prompt !== undefined) return { kind: "prompt", value: command.prompt };
  return { kind: "prompt", value: await readBoundedUtf8(command.inputPath!, readStdin) };
}
