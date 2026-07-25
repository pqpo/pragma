import { basename, extname } from "node:path";

import {
  InvocationHandoffSchema,
  type ContextInvocationHandoff,
  type HandoffContextReference,
  type InvocationHandoff,
} from "@pragma/shared";

import type { Expert } from "../../agent/expert-agent.ts";
import { ContextManager } from "../../agent/context-manager.ts";
import { StaticContextStore } from "../../context-system/static-context-store.ts";
import { encodePragmaPathSegment } from "../../storage/pragma-paths.ts";
import type {
  ExpertAgentManagedTool,
  ExpertAgentToolCallResult,
} from "../../tools/managed-tool.ts";
import type { ExecutionStore } from "../execution-store.ts";
import { ExecutionHandoffContextStore } from "./handoff-context-store.ts";

export const DEFAULT_HANDOFF_INLINE_LIMIT_BYTES = 32 * 1024;
export const DEFAULT_HANDOFF_SUMMARY_LIMIT_BYTES = 4 * 1024;

export interface HandoffServiceOptions {
  readonly executionId: string;
  readonly executions: ExecutionStore;
  readonly pragmaHome?: string | undefined;
  readonly inlineLimitBytes?: number | undefined;
  readonly summaryLimitBytes?: number | undefined;
}

export class HandoffService {
  readonly store: ExecutionHandoffContextStore;
  readonly inlineLimitBytes: number;
  readonly summaryLimitBytes: number;
  private readonly attempts = new Map<string, string>();

  constructor(private readonly options: HandoffServiceOptions) {
    this.store = new ExecutionHandoffContextStore(options.executionId, {
      ...(options.pragmaHome === undefined ? {} : { pragmaHome: options.pragmaHome }),
    });
    this.inlineLimitBytes = normalizeLimit(
      options.inlineLimitBytes,
      DEFAULT_HANDOFF_INLINE_LIMIT_BYTES,
    );
    this.summaryLimitBytes = normalizeLimit(
      options.summaryLimitBytes,
      DEFAULT_HANDOFF_SUMMARY_LIMIT_BYTES,
    );
  }

  withCapabilities(expert: Expert): Expert {
    const clone = Object.create(Object.getPrototypeOf(expert)) as Expert;
    Object.defineProperties(clone, Object.getOwnPropertyDescriptors(expert));
    const contextSystem = expert.contextSystem.extend({
      stores: [
        ["pragma.handoff", this.store],
        [
          "pragma.handoff-policy",
          new StaticContextStore([
            {
              id: "HANDOFF.md",
              content: createHandoffPolicy(this.inlineLimitBytes),
              metadata: {
                description: "Execution-scoped output handoff rules.",
                trigger: "always_on",
                priority: "critical",
                trustLevel: "system",
                sensitivity: "internal",
              },
            },
          ]),
        ],
      ],
      roots: [{ namespace: "pragma.handoff" }, { namespace: "pragma.handoff-policy" }],
    });
    Object.defineProperty(clone, "contextSystem", { value: contextSystem, enumerable: true });
    Object.defineProperty(clone, "contextManager", {
      value: new ContextManager({ agent: clone, contextSystem }),
    });
    Object.defineProperty(clone, "tools", {
      value: [...(expert.tools ?? []), this.createRegisterFileTool(expert)],
      enumerable: true,
    });
    return clone;
  }

  async beginInvocationAttempt(invocationId: string, attemptId: string): Promise<void> {
    await this.store.beginInvocationAttempt(invocationId, attemptId);
    this.attempts.set(invocationId, attemptId);
  }

  async normalize(invocationId: string, output: unknown): Promise<InvocationHandoff> {
    const attemptId = this.requireAttemptId(invocationId);
    const serialized = serializeOutput(output);
    const existing = await this.store.listReferencesForInvocation(invocationId, attemptId);
    if (serialized.bytes.byteLength <= this.inlineLimitBytes && existing.length === 0) {
      return InvocationHandoffSchema.parse({
        type: "inline",
        value: output === undefined ? null : output,
      });
    }

    const contexts = [...existing];
    if (serialized.bytes.byteLength > this.inlineLimitBytes) {
      const extension = serialized.mediaType === "application/json" ? "json" : "txt";
      const id = `invocations/${encodePragmaPathSegment(invocationId)}/output.${extension}`;
      const reference = await this.store.registerManaged({
        id,
        invocationId,
        attemptId,
        bytes: serialized.bytes,
        mediaType: serialized.mediaType,
        description: "Automatically externalized Invocation output.",
        idempotencyKey: `automatic-output:${invocationId}:${attemptId}`,
      });
      if (!contexts.some((candidate) => candidate.id === reference.id)) contexts.push(reference);
    }

    return InvocationHandoffSchema.parse({
      type: "context",
      summary: summarizeOutput(output, serialized.mediaType, this.summaryLimitBytes),
      contexts,
    });
  }

  async registerWorkspaceFile(input: {
    readonly invocationId: string;
    readonly toolCallId: string;
    readonly workspaceRoot: string;
    readonly path: string;
    readonly mediaType?: string | undefined;
    readonly description?: string | undefined;
  }): Promise<HandoffContextReference> {
    const attemptId = this.requireAttemptId(input.invocationId);
    const mediaType = input.mediaType ?? inferMediaType(input.path);
    const id = [
      "invocations",
      encodePragmaPathSegment(input.invocationId),
      "workspace",
      `${encodePragmaPathSegment(input.toolCallId)}-${basename(input.path)}`,
    ].join("/");
    const reference = await this.store.registerWorkspace({
      id,
      invocationId: input.invocationId,
      attemptId,
      workspaceRoot: input.workspaceRoot,
      relativePath: input.path,
      mediaType,
      ...(input.description === undefined ? {} : { description: input.description }),
      idempotencyKey: `workspace-file:${input.invocationId}:${attemptId}:${input.toolCallId}`,
    });
    await this.options.executions.appendEvent(
      this.options.executionId,
      input.invocationId,
      "handoff.file.registered",
      { attemptId, context: reference },
      `handoff-file-registered:${input.invocationId}:${attemptId}:${input.toolCallId}`,
    );
    return reference;
  }

  private createRegisterFileTool(
    expert: Expert,
  ): ExpertAgentManagedTool<"register_handoff_file", ExpertAgentToolCallResult> {
    return {
      name: "register_handoff_file",
      description:
        "Register an existing UTF-8 workspace file as this Invocation's large-output handoff without copying it.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: {
            type: "string",
            minLength: 1,
            description: "Path relative to the active Expert workspace.",
          },
          description: { type: "string", description: "Short description of the file." },
          mediaType: { type: "string", description: "Optional textual media type." },
        },
      },
      call: async (args, _signal, context) => {
        try {
          const record = readObject(args);
          const path = readRequiredString(record, "path");
          const execution = context?.execution;
          const invocationId = execution?.invocationId;
          if (
            invocationId === undefined ||
            execution === undefined ||
            execution.executionId !== this.options.executionId
          ) {
            throw new Error("register_handoff_file requires the active Execution context.");
          }
          const reference = await this.registerWorkspaceFile({
            invocationId,
            toolCallId: context?.toolCallId ?? `untracked-${encodePragmaPathSegment(path)}`,
            workspaceRoot: expert.workspace,
            path,
            ...(readOptionalString(record, "description") === undefined
              ? {}
              : { description: readOptionalString(record, "description") }),
            ...(readOptionalString(record, "mediaType") === undefined
              ? {}
              : { mediaType: readOptionalString(record, "mediaType") }),
          });
          return {
            text: `Registered handoff context: ${reference.namespace}/${reference.id}`,
            details: { context: reference },
          };
        } catch (error) {
          return {
            text: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
      },
    };
  }

  private requireAttemptId(invocationId: string): string {
    const attemptId = this.attempts.get(invocationId);
    if (attemptId === undefined) {
      throw new Error(`Handoff Invocation attempt is not active: ${invocationId}`);
    }
    return attemptId;
  }
}

export function unwrapInvocationHandoff(handoff: InvocationHandoff): unknown {
  return handoff.type === "inline" ? handoff.value : handoff;
}

export function isContextInvocationHandoff(value: unknown): value is ContextInvocationHandoff {
  const parsed = InvocationHandoffSchema.safeParse(value);
  return parsed.success && parsed.data.type === "context";
}

function serializeOutput(output: unknown): {
  readonly bytes: Uint8Array;
  readonly mediaType: "text/plain" | "application/json";
} {
  if (typeof output === "string") {
    return { bytes: Buffer.from(output, "utf8"), mediaType: "text/plain" };
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(output === undefined ? null : output);
  } catch (error) {
    throw new Error("Invocation output is not JSON-serializable.", { cause: error });
  }
  if (serialized === undefined) throw new Error("Invocation output is not JSON-serializable.");
  return { bytes: Buffer.from(serialized, "utf8"), mediaType: "application/json" };
}

function summarizeOutput(output: unknown, mediaType: string, limitBytes: number): string {
  if (typeof output !== "string") {
    return `Large ${mediaType} output is available through the attached handoff context.`;
  }
  const bytes = Buffer.from(output, "utf8");
  if (bytes.byteLength <= limitBytes) return output;
  let end = limitBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}\n\n[Handoff summary truncated.]`;
}

function inferMediaType(path: string): string {
  switch (extname(path).toLocaleLowerCase()) {
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".yaml":
    case ".yml":
    case ".txt":
      return "text/plain";
    default:
      return "text/plain";
  }
}

function createHandoffPolicy(limitBytes: number): string {
  return [
    "# Execution handoff",
    "",
    `Return small results normally. When a result is likely to exceed ${limitBytes} UTF-8 bytes, write it to a UTF-8 file in the active workspace, call register_handoff_file with its relative path, and return only a concise summary.`,
    "Use list_expert_context, read_expert_context, and search_expert_context to inspect handoffs from other Invocations.",
    "Do not paste a registered file's complete contents into the final response.",
  ].join("\n");
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error("Handoff byte limits must be positive safe integers.");
  }
  return normalized;
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("register_handoff_file input must be an object.");
  }
  return value as Record<string, unknown>;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = readOptionalString(record, key);
  if (value === undefined) throw new Error(`${key} must be a non-empty string.`);
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value.trim();
}
