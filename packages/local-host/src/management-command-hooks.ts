import { join } from "node:path";
import { z } from "zod";
import {
  createPragmaLogger,
  registerExecutionCommandSession,
  type ExpertAgentPluginHooks,
  type ExpertAgentPluginTaskSubmitContext,
} from "@pragma/core";
import type { PragmaManagementToolPorts, PragmaManagementHostScope } from "@pragma/built-in-agents";
import {
  ManagementCommandRequestSchema,
  type ManagementCommand,
  managementCommandError,
} from "@pragma/shared/integration";
import { createManagementCommandApplication } from "./management-commands.ts";
import { MANAGEMENT_COMMAND_ENDPOINT_ENV } from "./management-command-client.ts";

/** Per-native-Session lease. The active binding is read at invocation time, never captured from the first turn. */
export function createManagementCommandHooks(options: {
  readonly ports: PragmaManagementToolPorts;
  readonly scope: PragmaManagementHostScope;
  readonly allowedCommands: readonly ManagementCommand[];
  readonly commandDirectory: string;
  readonly commandsForAgent?:
    ((agent: import("@pragma/core").Expert) => readonly ManagementCommand[]) | undefined;
  readonly authorize?: Parameters<typeof createManagementCommandApplication>[0]["authorize"];
}): ExpertAgentPluginHooks {
  const active = new Map<string, ExpertAgentPluginTaskSubmitContext>();
  return {
    async beforeSessionCreate(context) {
      if (context.resources === undefined || context.privateStateDirectory === undefined)
        throw new Error("Runtime has no command-channel lifecycle or private storage owner.");
      const allowedCommands = options.commandsForAgent?.(context.agent) ?? options.allowedCommands;
      if (allowedCommands.length === 0) return undefined;
      const logger =
        context.logger ??
        createPragmaLogger(context.agent.loggerProvider, { component: "host.management" });
      const app = createManagementCommandApplication({
        ...options,
        allowedCommands,
        receiptsRoot: join(context.privateStateDirectory, "management-commands", "v1"),
      });
      const sessionId = context.systemSessionId;
      const registration = await context.resources.acquire(
        "Host execution command channel",
        async () =>
          await registerExecutionCommandSession({
            logger,
            inputSchema: z.toJSONSchema(ManagementCommandRequestSchema),
            async execute(input, transportSignal) {
              const request = ManagementCommandRequestSchema.parse(input);
              const current = active.get(sessionId);
              if (
                current?.executionContext === undefined ||
                current.signal === undefined ||
                current.signal.aborted
              )
                return {
                  protocol: request.protocol,
                  requestId: request.requestId,
                  command: request.command,
                  status: "failed",
                  exitCode: 6,
                  error: managementCommandError("PERMISSION_DENIED", "No active owning Execution."),
                };
              const original = context.context;
              const runContext = {
                ...original,
                attributes: {
                  ...original?.attributes,
                  "execution.executionId": current.executionContext.executionId,
                  "execution.invocationId": current.executionContext.invocationId,
                },
              };
              return await app.execute(request, {
                agent: context.agent,
                executionContext: current.executionContext,
                humanInteractionHandler: context.humanInteractionHandler,
                runContext,
                logger: current.logger ?? logger,
                state: current.toolState ?? { runId: current.runId },
                signal: AbortSignal.any([current.signal, transportSignal]),
              });
            },
          }),
        async (lease) => {
          active.delete(sessionId);
          await lease.dispose();
        },
      );
      return {
        processEnvironment: {
          set: {
            [MANAGEMENT_COMMAND_ENDPOINT_ENV]: registration.url,
            PRAGMA_EXECUTION_WORKSPACE: options.scope.workspacePath,
            PATH: `${options.commandDirectory}${process.platform === "win32" ? ";" : ":"}${context.processEnvironment.PATH ?? ""}`,
          },
        },
      };
    },
    beforeTaskSubmit(context) {
      active.set(context.session.systemSessionId, context);
    },
    afterTaskSubmit(context) {
      active.delete(context.session.systemSessionId);
    },
    beforeSessionDestroy(context) {
      active.delete(context.session.systemSessionId);
    },
  };
}
