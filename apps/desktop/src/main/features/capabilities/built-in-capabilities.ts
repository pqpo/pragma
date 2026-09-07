import { createHash, randomUUID } from "node:crypto";

import {
  PRAGMA_MANAGEMENT_CAPABILITY_REVISION,
  PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID,
  PRAGMA_MANAGEMENT_TOOL_DEFINITIONS,
  createPragmaManagementTools,
  type PragmaManagementToolPorts,
} from "@pragma/built-in-agents";
import {
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  EXECUTION_ID_ATTR,
  INVOCATION_ID_ATTR,
} from "@pragma/core";
import { z } from "zod";

import {
  CapabilitySchema,
  type Capability,
  type CapabilityTestRequest,
  type CapabilityTestResult,
} from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "./capability-store.ts";

const BUILT_IN_TIMESTAMP = "1970-01-01T00:00:00.000Z";

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
    latestRevision: PRAGMA_MANAGEMENT_CAPABILITY_REVISION,
    createdAt: BUILT_IN_TIMESTAMP,
    updatedAt: BUILT_IN_TIMESTAMP,
  },
  health: {
    revision: PRAGMA_MANAGEMENT_CAPABILITY_REVISION,
    status: "ready",
    checkedAt: BUILT_IN_TIMESTAMP,
  },
  definition: {
    kind: "mcp_server",
    name: "Pragma management tools",
    description:
      "Built-in Host tools for managing Pragma resources, evaluations, tasks, Automations, and reviewable knowledge revisions.",
    connection: { transport: "streamable-http", url: "http://pragma.invalid/builtin" },
    timeoutMs: 30_000,
    tools: PRAGMA_MANAGEMENT_TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
      schemaHash: schemaHash(inputSchema),
    })),
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
  ports: PragmaManagementToolPorts,
  approve: (input: {
    readonly toolName: string;
    readonly reason: string;
    readonly toolInput: unknown;
  }) => Promise<boolean>,
): Promise<CapabilityTestResult> {
  const toolName = input.toolName;
  const tool =
    toolName === undefined
      ? undefined
      : createPragmaManagementTools(ports).find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    return testFailure("tool_unavailable", "Choose an available built-in tool to test.");
  }
  if (
    tool.approval?.mode === "required" &&
    !(await approve({
      toolName: tool.name,
      reason: tool.approval.reason ?? "This management tool can change Desktop data.",
      toolInput: input.input,
    }))
  ) {
    return testFailure("approval_denied", "The management tool test was not run.");
  }
  const executionId = `capability-test:${randomUUID()}`;
  const invocationId = `capability-test:${randomUUID()}`;
  try {
    const result = await tool.call(input.input ?? {}, undefined, {
      toolCallId: `capability-test:${randomUUID()}`,
      runContext: {
        attributes: {
          [EXECUTION_ID_ATTR]: executionId,
          [INVOCATION_ID_ATTR]: invocationId,
          [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "capability-page",
        },
      },
    });
    return testSuccess("The built-in tool test succeeded.", result.details ?? result.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The management tool test failed.";
    return testFailure(error instanceof z.ZodError ? "invalid_input" : "request_failed", message);
  }
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
