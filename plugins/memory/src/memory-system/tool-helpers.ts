import { type ExpertAgentToolCallResult } from "@pragma/core";

import type { MemoryEvidenceReference } from "./types.ts";

export function errorResult(prefix: string, error: unknown): ExpertAgentToolCallResult {
  return {
    text: `${prefix}: ${isErrorRecord(error) ? error.message : "unknown error"}`,
    isError: true,
    details: { error },
  };
}

export function readStringParam(params: unknown, key: string, subject: string): string {
  const value = readParam(params, key);

  if (typeof value === "string") {
    return value;
  }

  throw new Error(`${subject} requires string parameter "${key}".`);
}

export function readOptionalStringParam(
  params: unknown,
  key: string,
  subject: string,
): string | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  throw new Error(`${subject} parameter "${key}" must be a string when provided.`);
}

export function readOptionalStringArrayParam(
  params: unknown,
  key: string,
  subject: string,
): readonly string[] | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${subject} parameter "${key}" must be an array of strings.`);
  }

  return [...value];
}

export function readOptionalBooleanParam(
  params: unknown,
  key: string,
  subject: string,
): boolean | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`${subject} parameter "${key}" must be a boolean when provided.`);
}

export function readOptionalEvidenceParam(
  params: unknown,
  key: string,
  subject: string,
): readonly MemoryEvidenceReference[] | undefined {
  const value = readParam(params, key);

  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`${subject} parameter "${key}" must be an array when provided.`);
  }

  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.type !== "string" || typeof item.id !== "string") {
      throw new Error(`${subject} parameter "${key}" item ${index} requires string type and string id.`);
    }

    return {
      type: item.type as MemoryEvidenceReference["type"],
      id: item.id,
      label: typeof item.label === "string" ? item.label : undefined,
      uri: typeof item.uri === "string" ? item.uri : undefined,
    };
  });
}

export function createDefaultEvidence(scope: {
  readonly workflowRunId?: string | undefined;
  readonly taskRunId?: string | undefined;
  readonly runtimeSessionId?: string | undefined;
}): readonly MemoryEvidenceReference[] {
  if (scope.runtimeSessionId !== undefined) {
    return [{ type: "session", id: scope.runtimeSessionId }];
  }

  if (scope.taskRunId !== undefined) {
    return [{ type: "task", id: scope.taskRunId }];
  }

  if (scope.workflowRunId !== undefined) {
    return [{ type: "run", id: scope.workflowRunId }];
  }

  return [];
}

export function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    additionalProperties: false,
    required: [...required],
  };
}

export function stringSchema(description: string): Record<string, unknown> {
  return {
    type: "string",
    description,
  };
}

export function stringArraySchema(description: string): Record<string, unknown> {
  return {
    type: "array",
    description,
    items: {
      type: "string",
    },
  };
}

export function booleanSchema(description: string): Record<string, unknown> {
  return {
    type: "boolean",
    description,
  };
}

export function evidenceArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    description: "Optional evidence references.",
    items: objectSchema(
      {
        type: stringSchema("Evidence type."),
        id: stringSchema("Evidence id."),
        label: stringSchema("Optional evidence label."),
        uri: stringSchema("Optional evidence uri."),
      },
      ["type", "id"],
    ),
  };
}

export function enumSchema(values: readonly string[], description?: string): Record<string, unknown> {
  return {
    type: "string",
    enum: [...values],
    ...(description === undefined ? {} : { description }),
  };
}

export function readParam(params: unknown, key: string): unknown {
  if (typeof params === "object" && params !== null && key in params) {
    return (params as Record<string, unknown>)[key];
  }

  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrorRecord(value: unknown): value is { readonly message: string } {
  return isRecord(value) && typeof value.message === "string";
}
