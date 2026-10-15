import {
  ExecutorDescriptorSchema,
  ExecutorSummaryDescriptorSchema,
  MissionListRequestSchema,
  ExecutorListRequestSchema,
  createIntegrationError,
  IntegrationErrorSchema,
  MissionListDiagnosticsPageSchema,
  type IntegrationError,
  type IntegrationWarning,
  type MissionListRequest,
  type ExecutorListRequest,
  type JsonValue,
} from "@pragma/shared/integration";
import { paginateIntegrationItems } from "./integration-pagination.ts";

/** Keep unavailable-owner facts and fail-closed semantics on the same Host query snapshot. */
export function queryIntegrationMissionsWithDiagnostics(
  value: {
    readonly items: readonly unknown[];
    readonly diagnostics: readonly IntegrationError[];
    readonly warnings: readonly IntegrationWarning[];
  },
  request: MissionListRequest,
) {
  if (value.items.length === 0 && value.diagnostics.length > 0) {
    const first = value.diagnostics[0]!;
    throw IntegrationErrorSchema.parse({
      ...first,
      details: { ...first.details, diagnostics: value.diagnostics },
    });
  }
  const page = queryIntegrationMissions(value.items, request);
  return value.diagnostics.length === 0 && value.warnings.length === 0
    ? page
    : MissionListDiagnosticsPageSchema.parse({
        ...page,
        schemaVersion: "pragma.mission-list-page/v2",
        items: page.items.map(asJsonValue),
        partial: value.diagnostics.length > 0,
        diagnostics: value.diagnostics,
        warnings: [
          ...value.warnings,
          ...value.diagnostics.map((issue) => ({
            code: "MISSION_UNAVAILABLE",
            message: issue.message,
            details: { ...issue.details, errorCode: issue.code },
          })),
        ],
      });
}

export function queryIntegrationMissions(items: readonly unknown[], request: MissionListRequest) {
  if (!MissionListRequestSchema.safeParse(request).success)
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "Invalid Mission list filters or pagination parameters.",
    });
  const filtered = items
    .filter((item) => matchesMission(item, request))
    .toSorted(
      (a, b) =>
        compare(stringField(b, "updatedAt") ?? "", stringField(a, "updatedAt") ?? "") ||
        compare(
          stringField(a, "missionId") ?? stringField(a, "id") ?? "",
          stringField(b, "missionId") ?? stringField(b, "id") ?? "",
        ),
    );
  return paginateIntegrationItems(
    filtered,
    { limit: request.limit, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) },
    "mission.list",
    {
      status: request.status,
      executor: request.executor,
      query: request.query,
      workspace: request.workspace,
    },
  );
}

export function queryIntegrationExecutors(items: readonly unknown[], request: ExecutorListRequest) {
  if (!ExecutorListRequestSchema.safeParse(request).success)
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "Invalid Executor list filters or pagination parameters.",
    });
  const filtered = items
    .map((item) => normalizeIntegrationExecutor(item, request.executorKind))
    .filter((item) => matchesExecutor(item, request))
    .toSorted((a, b) =>
      compare(
        referenceText(isRecord(a) ? a["ref"] : undefined) ?? "",
        referenceText(isRecord(b) ? b["ref"] : undefined) ?? "",
      ),
    );
  if (request.selector !== undefined && filtered.length === 0)
    throw createIntegrationError({
      code: "EXECUTOR_NOT_FOUND",
      category: "not_found",
      message: `Executor not found: ${request.selector}.`,
    });
  const page = paginateIntegrationItems(
    filtered,
    { limit: request.limit, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) },
    `${request.executorKind}.discover`,
    {
      selector: request.selector,
      query: request.query,
      status: request.status,
      project: request.project,
      maxContentBytes: request.maxContentBytes,
    },
  );
  return request.maxContentBytes === undefined
    ? page
    : { ...page, items: page.items.map(summarizeIntegrationExecutor) };
}

export function fullIntegrationItems(
  value: unknown,
  keys: readonly string[] = ["items"],
): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (
    isRecord(value) &&
    value["nextCursor"] === undefined &&
    !["pragma.list-page/v1", "pragma.mission-list-page/v2"].includes(String(value["schemaVersion"]))
  ) {
    for (const key of keys) if (Array.isArray(value[key])) return value[key];
  }
  throw createIntegrationError({
    code: "PROTOCOL_VERSION_UNSUPPORTED",
    category: "protocol",
    message: "Expected a complete list; use the explicit Host paged query contract.",
  });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}
function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}
function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
function referenceText(value: unknown): string | undefined {
  return typeof value === "string"
    ? value
    : isRecord(value) && typeof value["kind"] === "string" && typeof value["id"] === "string"
      ? `${value["kind"]}:${value["id"]}`
      : undefined;
}

export function normalizeIntegrationExecutor(
  value: unknown,
  expectedKind: ExecutorListRequest["executorKind"],
): JsonValue {
  const direct = ExecutorDescriptorSchema.safeParse(value);
  if (direct.success) return asJsonValue(direct.data);
  if (!isRecord(value)) return asJsonValue(value);

  const rawKind = value["kind"];
  const kind =
    rawKind === "team" || rawKind === "expert" || rawKind === "flow" ? rawKind : expectedKind;
  const rawRef = value["ref"];
  const ref = typeof rawRef === "string" ? rawRef : undefined;
  const id = ref?.startsWith(`${kind}:`) ? ref.slice(kind.length + 1) : undefined;
  if (id === undefined || !/^[0-9a-hjkmnp-tv-z]{16}$/u.test(id)) return asJsonValue(value);

  const origin =
    value["origin"] === "built-in"
      ? "built_in"
      : value["origin"] === "project"
        ? "project"
        : "installed";
  const availability = recordField(value, "availability");
  const descriptor: Record<string, unknown> = {
    schemaVersion: "pragma.integration-executor/v1",
    ref: { kind, id },
    name: stringField(value, "name") ?? "(name unavailable)",
    description: stringField(value, "description") ?? "",
    source: origin,
    availability: {
      status:
        availability?.["status"] === "needs_attention" || availability?.["status"] === "unavailable"
          ? availability["status"]
          : "ready",
      blockingCodes: Array.isArray(availability?.["blockingCodes"])
        ? availability["blockingCodes"]
        : [],
    },
    workspace: recordField(value, "workspace") ?? { required: true, allowNonGitDirectory: true },
    capabilities: recordField(value, "capabilities") ?? {
      interactive: true,
      resumable: true,
      steerable: kind !== "flow",
      supportsQueue: kind !== "flow",
    },
  };
  if (value["inputSchema"] !== undefined) descriptor["inputSchema"] = value["inputSchema"];
  const project = recordField(value, "project");
  if (project !== undefined) descriptor["project"] = project;
  const parsed = ExecutorDescriptorSchema.safeParse(descriptor);
  return parsed.success ? asJsonValue(parsed.data) : asJsonValue(value);
}

function matchesExecutor(value: JsonValue, command: ExecutorListRequest): boolean {
  if (!isRecord(value)) return false;
  const ref = referenceText(value["ref"]);
  const kind = ref?.split(":", 1)[0] ?? value["kind"];
  if (kind !== command.executorKind) return false;
  if (command.selector !== undefined) {
    if (isCanonicalExecutorRef(command.selector)) return ref === command.selector;
    const haystack = [stringField(value, "name"), stringField(value, "description")]
      .filter((item): item is string => item !== undefined)
      .join(" ")
      .toLocaleLowerCase();
    if (!haystack.includes(command.selector.toLocaleLowerCase())) return false;
  }
  if (command.query !== undefined) {
    const haystack = [ref, stringField(value, "name"), stringField(value, "description")]
      .filter((item): item is string => item !== undefined)
      .join(" ")
      .toLocaleLowerCase();
    if (!haystack.includes(command.query.toLocaleLowerCase())) return false;
  }
  if (
    command.status !== undefined &&
    recordField(value, "availability")?.["status"] !== command.status
  ) {
    return false;
  }
  if (
    command.project !== undefined &&
    recordField(value, "project")?.["projectId"] !== command.project
  ) {
    return false;
  }
  return true;
}

function matchesMission(value: unknown, command: MissionListRequest): boolean {
  if (!isRecord(value)) return false;
  const execution = recordField(value, "execution");
  const status = stringField(value, "status") ?? stringField(execution, "status");
  const lifecycleStatus = stringField(value, "lifecycleStatus");
  if (
    command.status !== undefined &&
    status !== command.status &&
    lifecycleStatus !== command.status
  ) {
    return false;
  }
  if (command.executor !== undefined) {
    const executorValue = value["executor"];
    const ref =
      referenceText(isRecord(executorValue) ? executorValue["ref"] : undefined) ??
      referenceText(executorValue);
    if (ref !== command.executor) return false;
  }
  if (
    command.query !== undefined &&
    !(stringField(value, "title") ?? "").toLowerCase().includes(command.query.toLowerCase())
  )
    return false;
  const workspace = recordField(value, "workspace");
  if (
    command.workspace !== undefined &&
    (stringField(workspace, "canonicalPath") ?? stringField(workspace, "path")) !==
      command.workspace
  )
    return false;
  return true;
}

function isCanonicalExecutorRef(value: string): boolean {
  return /^(team|expert|flow):[0-9a-hjkmnp-tv-z]{16}$/u.test(value);
}

export function summarizeIntegrationExecutor(value: unknown): JsonValue {
  const parsed = ExecutorDescriptorSchema.safeParse(value);
  if (!parsed.success) return asJsonValue(value);
  const descriptor = parsed.data;
  const { inputSchema, ...rest } = descriptor;
  return asJsonValue(
    ExecutorSummaryDescriptorSchema.parse({
      ...rest,
      schemaVersion: "pragma.integration-executor-summary/v1",
      description: descriptor.description.slice(0, 500),
      ...(descriptor.description.length > 500 ? { descriptionTruncated: true } : {}),
      ...(inputSchema === undefined && descriptor.description.length <= 500
        ? {}
        : {
            schemaReadCommand: `pragma ${descriptor.ref.kind} describe ${descriptor.ref.kind}:${descriptor.ref.id} --json --output-view full`,
          }),
    }),
  );
}
