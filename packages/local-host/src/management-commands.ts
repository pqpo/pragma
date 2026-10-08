import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
} from "@pragma/shared/integration";

export const MANAGEMENT_COMMAND_TOOLS = {
  "flow.draft.create": "create_flow_draft",
  "flow.draft.get": "get_flow_draft",
  "flow.draft.update": "update_flow_draft",
  "flow.draft.validate": "validate_flow_draft",
  "flow.draft.prepare": "prepare_flow_draft",
  "flow.draft.discard": "discard_flow_draft",
  "dsl.resources.list": "list_dsl_resources",
  "dsl.resources.read": "read_dsl_resource",
  "dsl.options.list": "list_expert_options",
  "dsl.ids.allocate": "allocate_dsl_resource_ids",
  "dsl.changes.read": "read_prepared_dsl_change",
  "dsl.changes.commit": "commit_dsl_changes",
} as const satisfies Record<ManagementCommand, string>;

export function describeManagementCommand(command: ManagementCommand) {
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
        const targetId = request.input["draftId"] ?? request.input["changeSetId"];
        if (typeof targetId === "string") {
          const record = await readOwner(options.receiptsRoot, targetId);
          if (
            record === undefined ||
            record.missionId !== owner.missionId ||
            record.contextId !== owner.contextId
          )
            return fail(
              "PERMISSION_DENIED",
              "The draft or prepared change is owned by another Mission or Runtime Context.",
            );
        }
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
                  createFlowDraft: (input: Parameters<typeof project.createFlowDraft>[0]) =>
                    project.createFlowDraft({ ...input, operationId }),
                  updateFlowDraft: (input: Parameters<typeof project.updateFlowDraft>[0]) =>
                    project.updateFlowDraft({
                      ...input,
                      operationId,
                      commandResultsRoot: join(options.receiptsRoot, "mutations"),
                    }),
                  prepareFlowDraft: (input: Parameters<typeof project.prepareFlowDraft>[0]) =>
                    project.prepareFlowDraft({ ...input, operationId }),
                },
              };
        const tools = createPragmaManagementTools(ports, options.scope);
        const effective = resolveToolPolicy({
          tools: tools.map((tool) => ({ name: tool.name, source: "managed" as const, tool })),
          context: context.runContext,
          policy: context.agent.toolPolicy,
        });
        const tool = effective.tools.find((item) => item.name === name)?.tool;
        if (tool === undefined)
          return fail("PERMISSION_DENIED", "The effective tool policy denies this command.");
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
            if (typeof id === "string") await writeOwner(options.receiptsRoot, id, owner);
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

const CommandOwnerSchema = z
  .object({
    schemaVersion: z.literal("pragma.management-command-owner/v1"),
    missionId: z.string().uuid(),
    contextId: z.string().min(1),
  })
  .strict();
function commandOwnerPath(root: string, id: string): string {
  return join(root, "owners", `${createHash("sha256").update(id).digest("hex")}.json`);
}
async function readCommandState<T>(
  path: string,
  schema: z.ZodType<T>,
  version: string,
): Promise<T | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw managementCommandError(
      "STORAGE_CORRUPTED",
      "The management command state is not valid JSON.",
    );
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    typeof value.schemaVersion === "string" &&
    value.schemaVersion !== version
  )
    throw managementCommandError(
      "STORAGE_VERSION_UNSUPPORTED",
      "This management command state version is not supported.",
    );
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw managementCommandError("STORAGE_CORRUPTED", "The management command state is invalid.");
  return parsed.data;
}
async function readOwner(root: string, id: string) {
  return await readCommandState(
    commandOwnerPath(root, id),
    CommandOwnerSchema,
    "pragma.management-command-owner/v1",
  );
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
