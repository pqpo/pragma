import { createHash, randomUUID } from "node:crypto";

import {
  LIST_KNOWLEDGE_REVISION_TARGETS_TOOL_NAME,
  START_KNOWLEDGE_REVISION_TOOL_NAME,
  PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID,
  PRAGMA_MANAGEMENT_TOOL_NAMES,
  type KnowledgeRevisionSubmissionPort,
} from "@pragma/built-in-agents";

import {
  CapabilitySchema,
  type Capability,
  type CapabilityTestRequest,
  type CapabilityTestResult,
} from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "./capability-store.ts";

const BUILT_IN_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const emptyInputSchema = { type: "object", properties: {}, additionalProperties: false } as const;
const submitInputSchema = {
  type: "object",
  properties: {
    targetRef: { type: "string" },
    prompt: { type: "string", minLength: 1, maxLength: 50_000 },
  },
  required: ["targetRef", "prompt"],
  additionalProperties: false,
} as const;

function schemaHash(inputSchema: unknown): string {
  return createHash("sha256").update(JSON.stringify(inputSchema)).digest("hex");
}

export const BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY: Capability = CapabilitySchema.parse({
  managedBy: "system",
  manifest: {
    schemaVersion: "pragma.capability/v2",
    id: PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID,
    runtimeKey: "pragma_management",
    name: "Pragma management tools",
    kind: "mcp_server",
    latestRevision: 1,
    createdAt: BUILT_IN_TIMESTAMP,
    updatedAt: BUILT_IN_TIMESTAMP,
  },
  health: { revision: 1, status: "ready", checkedAt: BUILT_IN_TIMESTAMP },
  definition: {
    kind: "mcp_server",
    name: "Pragma management tools",
    description:
      "Built-in Host tools for managing Pragma resources and work. Currently provides reviewable knowledge revision submission.",
    connection: { transport: "streamable-http", url: "http://pragma.invalid/builtin" },
    timeoutMs: 30_000,
    tools: PRAGMA_MANAGEMENT_TOOL_NAMES.map((name) => {
      const inputSchema =
        name === START_KNOWLEDGE_REVISION_TOOL_NAME ? submitInputSchema : emptyInputSchema;
      return {
        name,
        description: `Built-in knowledge revision operation: ${name}.`,
        inputSchema,
        schemaHash: schemaHash(inputSchema),
      };
    }),
  },
});

export async function listCapabilitiesWithBuiltIns(
  store: Pick<CapabilityStore, "list">,
): Promise<readonly Capability[]> {
  return [BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY, ...(await store.list())];
}

export function isBuiltInCapabilityId(id: string): boolean {
  return id === BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY.manifest.id;
}

export async function testBuiltInCapability(
  input: CapabilityTestRequest,
  port: KnowledgeRevisionSubmissionPort,
  approveSubmission: (input: {
    readonly targetRef: string;
    readonly prompt: string;
  }) => Promise<boolean>,
): Promise<CapabilityTestResult> {
  const toolName = input.toolName;
  if (toolName === undefined || !PRAGMA_MANAGEMENT_TOOL_NAMES.some((name) => name === toolName)) {
    return testFailure("tool_unavailable", "Choose an available built-in tool to test.");
  }
  const invocation = {
    executionId: `capability-test:${randomUUID()}`,
    invocationId: `capability-test:${randomUUID()}`,
    expertId: "capability-page",
    operationId: `capability-test:${randomUUID()}`,
  };
  if (toolName === LIST_KNOWLEDGE_REVISION_TARGETS_TOOL_NAME) {
    return testSuccess("The built-in tool test succeeded.", await port.listTargets(invocation));
  }
  if (toolName !== START_KNOWLEDGE_REVISION_TOOL_NAME) {
    return testFailure(
      "invalid_input",
      "This revision tool requires a live draft selected by an Agent execution.",
    );
  }

  const parsed = parseSubmitTestInput(input.input);
  if (!parsed.ok) return testFailure("invalid_input", parsed.message);
  if (!(await approveSubmission(parsed.value))) {
    return testFailure("approval_denied", "The revision request was not submitted.");
  }
  return testSuccess(
    "The built-in tool test succeeded.",
    await port.start({ ...invocation, ...parsed.value }),
  );
}

function parseSubmitTestInput(
  input: unknown,
):
  | { readonly ok: true; readonly value: { readonly targetRef: string; readonly prompt: string } }
  | { readonly ok: false; readonly message: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: "Test input must contain targetRef and prompt." };
  }
  const value = input as Record<string, unknown>;
  const targetRef = typeof value["targetRef"] === "string" ? value["targetRef"].trim() : "";
  const prompt = typeof value["prompt"] === "string" ? value["prompt"].trim() : "";
  if (targetRef.length === 0 || prompt.length === 0 || prompt.length > 50_000) {
    return { ok: false, message: "Test input must contain a targetRef and a non-empty prompt." };
  }
  return { ok: true, value: { targetRef, prompt } };
}

function testSuccess(message: string, output: unknown): CapabilityTestResult {
  return {
    ok: true,
    code: "success",
    message,
    capability: BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY,
    output,
  };
}

function testFailure(code: string, message: string): CapabilityTestResult {
  return { ok: false, code, message, capability: BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY };
}
