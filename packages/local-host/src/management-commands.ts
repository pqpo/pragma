import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  createPragmaManagementTools,
  PRAGMA_MANAGEMENT_TOOL_DEFINITIONS,
  PragmaManagementErrorSchema,
  type PragmaManagementToolPorts,
  type PragmaManagementHostScope,
} from "@pragma/built-in-agents";
import {
  executeExecutionTool,
  mergeExpertAgentToolApprovals,
  isHumanInteractionCheckpointError,
  resolveToolPolicy,
  withFileLock,
  type Expert,
  type ExpertAgentHumanInteractionHandler,
  type ExpertAgentRunContext,
  type ExpertToolExecutionContext,
  type ExecutionToolRuntimeState,
  type PragmaLogger,
} from "@pragma/core";
import {
  MANAGEMENT_COMMAND_PROTOCOL,
  ManagementCommandRequestSchema,
  ManagementCommandResultSchema,
  managementCommandError,
  integrationErrorExitCode,
  type ManagementCommand,
  type ManagementCommandRequest,
  type ManagementCommandResult,
  type IntegrationErrorCode,
  IntegrationErrorSchema,
  ManagementFlowRecoveryInputSchema,
  ManagementChangesRecoveryInputSchema,
} from "@pragma/shared/integration";

import { managementCommandTargetId } from "./pragma-project-port.ts";
import {
  CommandOwnerSchema,
  commandOwnerPath,
  readCommandOwner as readOwner,
  readCommandState,
  type CommandOwner,
} from "./management-command-ownership.ts";

export const MANAGEMENT_COMMAND_TOOLS = {
  "flow.draft.create": "create_flow_draft",
  "flow.draft.get": "get_flow_draft",
  "flow.draft.update": "update_flow_draft",
  "flow.draft.validate": "validate_flow_draft",
  "flow.draft.prepare": "prepare_flow_draft",
  "flow.draft.discard": "discard_flow_draft",
  "flow.draft.recover": "recover_flow_draft",
  "dsl.resources.list": "list_dsl_resources",
  "dsl.resources.read": "read_dsl_resource",
  "dsl.options.list": "list_expert_options",
  "dsl.ids.allocate": "allocate_dsl_resource_ids",
  "dsl.changes.read": "read_prepared_dsl_change",
  "dsl.changes.commit": "commit_dsl_changes",
  "dsl.changes.recover": "recover_dsl_change",
} as const satisfies Record<ManagementCommand, string>;

const recoveryDefinitions = {
  "flow.draft.recover": {
    name: "recover_flow_draft",
    description:
      "Recover an unowned legacy Flow draft into the current Mission/Context after explicit approval. Preserves the original draft.",
    schema: ManagementFlowRecoveryInputSchema,
  },
  "dsl.changes.recover": {
    name: "recover_dsl_change",
    description:
      "Recover an unowned legacy prepared change into the current Mission/Context after explicit approval. Publication still needs separate commit approval.",
    schema: ManagementChangesRecoveryInputSchema,
  },
} as const;
export function describeManagementCommand(command: ManagementCommand) {
  if (command === "flow.draft.recover" || command === "dsl.changes.recover") {
    const definition = recoveryDefinitions[command];
    return {
      command,
      description: definition.description,
      inputSchema: z.toJSONSchema(definition.schema),
    };
  }
  const tool = PRAGMA_MANAGEMENT_TOOL_DEFINITIONS.find(
    (item) => item.name === MANAGEMENT_COMMAND_TOOLS[command],
  )!;
  return { command, description: tool.description, inputSchema: tool.inputSchema };
}

const ReceiptSchema = z
  .object({
    schemaVersion: z.literal("pragma.management-request/v1"),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
    origin: ManagementCommandResultSchema.shape.origin,
    state: z.enum(["pending", "completed"]),
    result: ManagementCommandResultSchema.optional(),
  })
  .strict()
  .refine((receipt) => (receipt.state === "completed") === (receipt.result !== undefined));

/** Same handlers and execution pipeline for both Host surfaces. No argv-owned authority. */
export function createManagementCommandApplication(options: {
  readonly ports: PragmaManagementToolPorts;
  readonly scope: PragmaManagementHostScope;
  readonly receiptsRoot: string;
  readonly allowedCommands: readonly ManagementCommand[];
  readonly ownershipLockRoot?: string | undefined;
  /** Trusted Host lookup of existing private owner records, including other Runtime Sessions. */
  readonly findOwner?:
    ((id: string, signal: AbortSignal) => Promise<CommandOwner | undefined>) | undefined;
  readonly authorize?: ((request: ManagementCommandRequest) => Promise<void>) | undefined;
}) {
  return {
    async execute(
      request: ManagementCommandRequest,
      context: {
        readonly agent: Expert;
        readonly executionContext: ExpertToolExecutionContext;
        readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
        readonly runContext: ExpertAgentRunContext;
        readonly logger: PragmaLogger;
        readonly state: ExecutionToolRuntimeState;
        readonly signal: AbortSignal;
      },
    ): Promise<ManagementCommandResult> {
      request = ManagementCommandRequestSchema.parse(request);
      const fail = (
        code: IntegrationErrorCode,
        message: string,
        details?: Record<string, unknown>,
      ): ManagementCommandResult =>
        ManagementCommandResultSchema.parse({
          protocol: MANAGEMENT_COMMAND_PROTOCOL,
          requestId: request.requestId,
          command: request.command,
          status: "failed",
          exitCode: integrationErrorExitCode(code),
          error: managementCommandError(code, message, details),
        });
      try {
        context.signal.throwIfAborted();
        await context.executionContext.assertOwnership?.();
        await options.authorize?.(request);
        const contextId = context.runContext.attributes?.["execution.contextId"];
        if (typeof contextId !== "string" || contextId.length === 0)
          return fail("PERMISSION_DENIED", "A command requires a trusted Runtime Context.");
        const owner = { missionId: options.scope.missionId, contextId };
        const recovery =
          request.command === "flow.draft.recover" || request.command === "dsl.changes.recover";
        const sameOwner = (record: CommandOwner) =>
          record.missionId === owner.missionId && record.contextId === owner.contextId;
        const findOwner = async (id: string) => {
          const local = await readOwner(options.receiptsRoot, id);
          return local ?? (await options.findOwner?.(id, context.signal));
        };
        const assertTarget = async (input: unknown, allowUnowned = false) => {
          if (typeof input !== "object" || input === null) return;
          const data = input as Record<string, unknown>;
          const targetKey =
            request.command.startsWith("flow.draft.") && request.command !== "flow.draft.create"
              ? "draftId"
              : request.command.startsWith("dsl.changes.")
                ? "changeSetId"
                : undefined;
          const id = targetKey === undefined ? undefined : data[targetKey];
          if (typeof id !== "string") return;
          const record = await findOwner(id);
          if (record !== undefined && !sameOwner(record))
            throw managementCommandError(
              "PERMISSION_DENIED",
              "The draft or prepared change is owned by another Mission or Runtime Context.",
            );
          if (record === undefined && !allowUnowned)
            throw managementCommandError(
              "PERMISSION_DENIED",
              "This target has no command ownership record. Recover legacy data explicitly before continuing.",
              {
                reason: "unowned_target",
                recovery: {
                  command: targetKey === "draftId" ? "flow.draft.recover" : "dsl.changes.recover",
                  targetId: id,
                },
              },
            );
        };
        const claimOwner = async (id: string) => {
          const lock = join(
            options.ownershipLockRoot ?? join(options.receiptsRoot, "ownership-locks"),
            `${createHash("sha256").update(id).digest("hex")}.lock`,
          );
          await withFileLock(lock, async () => {
            context.signal.throwIfAborted();
            await context.executionContext.assertOwnership?.();
            const existing = await findOwner(id);
            if (existing !== undefined && !sameOwner(existing))
              throw managementCommandError(
                "PERMISSION_DENIED",
                "The command target is already owned by another Mission or Runtime Context.",
              );
            await writeOwner(options.receiptsRoot, id, owner);
          });
        };
        if (!options.allowedCommands.includes(request.command))
          return fail(
            "PERMISSION_DENIED",
            "This command is not authorized for the current Execution.",
          );
        const name = MANAGEMENT_COMMAND_TOOLS[request.command];
        // Model-visible allowlists differ from explicit command grants; deny policy still applies.
        const identity = JSON.stringify([options.scope.missionId, contextId, request.requestId]);
        const operationId = createHash("sha256").update(identity).digest("hex");
        const project = options.ports.project;
        const ports =
          project === undefined
            ? options.ports
            : {
                ...options.ports,
                project: {
                  ...project,
                  createFlowDraft: async (input: Parameters<typeof project.createFlowDraft>[0]) => {
                    await claimOwner(managementCommandTargetId(operationId));
                    return await project.createFlowDraft({ ...input, operationId });
                  },
                  updateFlowDraft: (input: Parameters<typeof project.updateFlowDraft>[0]) =>
                    project.updateFlowDraft({
                      ...input,
                      operationId,
                      commandResultsRoot: join(options.receiptsRoot, "mutations"),
                    }),
                  prepareFlowDraft: async (
                    input: Parameters<typeof project.prepareFlowDraft>[0],
                  ) => {
                    await claimOwner(managementCommandTargetId(operationId));
                    return await project.prepareFlowDraft({ ...input, operationId });
                  },
                },
              };
        const tools = [...createPragmaManagementTools(ports, options.scope)];
        for (const [command, definition] of Object.entries(recoveryDefinitions)) {
          tools.push({
            name: definition.name,
            description: definition.description,
            inputSchema: z.toJSONSchema(definition.schema),
            approval: { mode: "required", reason: definition.description },
            call: async (args) => {
              const input = definition.schema.parse(args);
              if (project === undefined)
                throw managementCommandError(
                  "DEPENDENCY_UNAVAILABLE",
                  "The Project recovery port is unavailable.",
                );
              await assertTarget(input, true);
              const id = "draftId" in input ? input.draftId : input.changeSetId;
              // Existing parser/business reads validate historical data without rewriting it.
              try {
                if ("draftId" in input) await project.getFlowDraft(input.draftId);
                else await project.getChangeSet(input.changeSetId, options.scope.missionId);
              } catch (error) {
                if (error instanceof z.ZodError) {
                  const future = error.issues.some((issue) => issue.path.at(-1) === "apiVersion");
                  throw managementCommandError(
                    future ? "STORAGE_VERSION_UNSUPPORTED" : "STORAGE_CORRUPTED",
                    "The legacy target cannot be safely read. Its original data was preserved.",
                  );
                }
                if (error instanceof SyntaxError)
                  throw managementCommandError(
                    "STORAGE_CORRUPTED",
                    "The legacy target is not valid JSON. Its original data was preserved.",
                  );
                throw error;
              }
              await claimOwner(id);
              const details = { command, recovered: true, ...input };
              return { text: JSON.stringify(details), details };
            },
          });
        }
        const effective = resolveToolPolicy({
          tools: tools.map((tool) => ({ name: tool.name, source: "managed" as const, tool })),
          context: context.runContext,
          policy: context.agent.toolPolicy,
        });
        const tool = effective.tools.find((item) => item.name === name)?.tool;
        if (tool === undefined)
          return fail("PERMISSION_DENIED", "The effective tool policy denies this command.");
        if (
          recovery &&
          (options.findOwner === undefined || options.ownershipLockRoot === undefined)
        )
          return fail(
            "DEPENDENCY_UNAVAILABLE",
            "This Host has not configured the trusted legacy ownership recovery boundary.",
          );
        if (recovery)
          recoveryDefinitions[request.command as keyof typeof recoveryDefinitions].schema.parse(
            request.input,
          );
        await assertTarget(request.input, recovery);
        const path = join(options.receiptsRoot, `${operationId}.json`);
        const payloadHash = createHash("sha256")
          .update(canonicalJson({ command: request.command, input: request.input }))
          .digest("hex");
        return await withFileLock(`${path}.lock`, async () => {
          context.signal.throwIfAborted();
          await context.executionContext.assertOwnership?.();
          const existing = await readCommandState(
            path,
            ReceiptSchema,
            "pragma.management-request/v1",
          );
          if (existing !== undefined) {
            if (existing.payloadHash !== payloadHash)
              return fail(
                "IDEMPOTENCY_CONFLICT",
                "This requestId already owns a different payload.",
              );
            if (existing.result !== undefined) return existing.result;
            // Only original commit receipts and inherently idempotent reads/discard can replay an uncertain call.
            if (!replaySafe(request.command))
              return fail(
                "COMMAND_RESULT_TIMEOUT",
                "The previous process stopped with an uncertain result. Inspect the draft before issuing a new mutation.",
                {
                  requestId: request.requestId,
                  recovery: "Inspect the original draft; do not blindly repeat this mutation.",
                },
              );
          }
          const origin = existing?.origin ?? {
            ...owner,
            executionId: context.executionContext.executionId,
            invocationId: context.executionContext.invocationId,
          };
          await save(path, {
            schemaVersion: "pragma.management-request/v1",
            state: "pending",
            payloadHash,
            origin,
          });
          const result = await executeExecutionTool({
            ...context,
            tool: {
              ...tool,
              label: tool.name,
              call: async (args, signal, callContext) => {
                // Revalidate any input changed by the approval handler before touching a target.
                await assertTarget(args, recovery);
                return await tool.call(args, signal, callContext);
              },
              approval: mergeExpertAgentToolApprovals(
                mergeExpertAgentToolApprovals(
                  tool.approval,
                  context.agent.executionToolApprovals?.[tool.name],
                ),
                context.agent.tools?.find((candidate) => candidate.name === tool.name)?.approval,
              ),
            },
            toolCallId: operationId,
            args: request.input,
          });
          const payload = result.details;
          if (!result.isError && typeof payload === "object" && payload !== null) {
            const data = payload as Record<string, unknown>;
            const changeSet = data["changeSet"];
            const id =
              data["draftId"] ??
              data["changeSetId"] ??
              (typeof changeSet === "object" && changeSet !== null && "changeSetId" in changeSet
                ? changeSet.changeSetId
                : undefined);
            if (typeof id === "string") await claimOwner(id);
          }
          const error = PragmaManagementErrorSchema.safeParse(payload);
          const invalid = isInvalidResult(payload, request.command);
          let response: ManagementCommandResult;
          if (result.isError) {
            if (error.success) {
              response = fail(managementCode(error.data.code), error.data.message, {
                managementError: error.data,
              });
              response = ManagementCommandResultSchema.parse({ ...response, result: error.data });
            } else response = fail("PERMISSION_DENIED", result.text);
          } else
            response = ManagementCommandResultSchema.parse({
              protocol: MANAGEMENT_COMMAND_PROTOCOL,
              requestId: request.requestId,
              command: request.command,
              status: invalid ? "invalid" : "succeeded",
              exitCode: invalid ? 10 : 0,
              result: payload ?? { text: result.text },
            });
          response = { ...response, origin };
          await save(path, {
            schemaVersion: "pragma.management-request/v1",
            state: "completed",
            payloadHash,
            origin,
            result: response,
          });
          return response;
        });
      } catch (error) {
        if (isHumanInteractionCheckpointError(error))
          return ManagementCommandResultSchema.parse({
            protocol: MANAGEMENT_COMMAND_PROTOCOL,
            requestId: request.requestId,
            command: request.command,
            status: "input_required",
            exitCode: 0,
            result: {
              control: "human_checkpoint",
              executionId: context.executionContext.executionId,
            },
          });
        const known = IntegrationErrorSchema.safeParse(error);
        if (known.success) return fail(known.data.code, known.data.message, known.data.details);
        if (context.signal.aborted)
          return fail("INTERRUPTED", "The owning Execution was interrupted.");
        if (error instanceof z.ZodError)
          return fail("INVALID_ARGUMENT", "The command input is invalid.", {
            diagnostics: error.issues,
          });
        return fail(
          "COMMAND_REJECTED",
          error instanceof Error ? error.message : "The command could not complete.",
        );
      }
    },
  };
}
function replaySafe(command: ManagementCommand): boolean {
  return command !== "dsl.ids.allocate";
}
function isInvalidResult(value: unknown, command: ManagementCommand): boolean {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    result["status"] === "invalid" ||
    ((command === "flow.draft.validate" || command === "flow.draft.prepare") &&
      Array.isArray(result["diagnostics"]) &&
      result["diagnostics"].some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "severity" in item &&
          item.severity !== "warning",
      ))
  );
}
function managementCode(
  code: z.infer<typeof PragmaManagementErrorSchema>["code"],
): IntegrationErrorCode {
  switch (code) {
    case "invalid_input":
    case "response_too_large":
      return "INVALID_ARGUMENT";
    case "not_found":
      return "NOT_FOUND";
    case "revision_conflict":
    case "already_attached":
      return "IDEMPOTENCY_CONFLICT";
    case "cursor_invalid":
      return "CURSOR_INVALID";
    case "cursor_expired":
      return "CURSOR_EXPIRED";
    case "unavailable":
      return "DEPENDENCY_UNAVAILABLE";
    case "permission_denied":
      return "PERMISSION_DENIED";
    case "internal_error":
      return "INTERNAL_ERROR";
  }
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
async function save(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, `${JSON.stringify(ReceiptSchema.parse(value))}\n`, {
    mode: 0o600,
  });
  await rename(`${path}.tmp`, path);
}

async function writeOwner(
  root: string,
  id: string,
  owner: { readonly missionId: string; readonly contextId: string },
): Promise<void> {
  const path = commandOwnerPath(root, id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const value = CommandOwnerSchema.parse({
    schemaVersion: "pragma.management-command-owner/v1",
    ...owner,
  });
  // A replay may encounter the same record, but cannot reassign another owner's target.
  await withFileLock(`${path}.lock`, async () => {
    const prior = await readOwner(root, id);
    if (
      prior !== undefined &&
      (prior.missionId !== owner.missionId || prior.contextId !== owner.contextId)
    )
      throw managementCommandError(
        "PERMISSION_DENIED",
        "The command target already has another owner.",
      );
    await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  });
}
