import {
  BoardListResultSchema,
  BoardReadResultSchema,
  BoardSearchResultSchema,
  ExecutorDescriptorSchema,
  type JsonValue,
} from "@pragma/local-host/wire";

import type { ParsedCommand } from "../parser/argv.ts";
import { HELP_TEXT } from "../parser/argv.ts";
import { toIntegrationError } from "./errors.ts";
import type { CliCommandContext } from "./types.ts";
import { asJsonValue, hostPage, isRecord, pageItems, recordField, stringField } from "./utils.ts";

export async function executeReadOnlyCommand(
  command: ParsedCommand,
  context: CliCommandContext,
): Promise<JsonValue> {
  switch (command.kind) {
    case "help":
      return { help: HELP_TEXT };
    case "version":
      return versionResult(context.cliVersion);
    case "completion":
      return { shell: command.shell, script: completionScript(command.shell) };
    case "doctor":
      throw new Error("doctor must be handled by the doctor command.");
    case "executor-discover":
      return await discoverExecutors(command, context);
    case "executor-describe":
      return await describeExecutor(command, context);
    case "mission-list":
      return await listMissions(command, context);
    case "mission-get":
      return await getMission(command, context);
    case "board-list":
      return await listBoard(command, context);
    case "board-read":
      return await readBoard(command, context);
    case "board-search":
      return await searchBoard(command, context);
    case "queue-list":
      return await listQueue(command, context);
  }
}

export function versionResult(cliVersion: string): JsonValue {
  return {
    cliVersion,
    desktopBundleVersion: process.env["PRAGMA_DESKTOP_BUNDLE_VERSION"] ?? "unknown",
    wireVersion: "pragma.integration/v1",
    storageMajor: 1,
    installSource: process.env["npm_config_global"] === "true" ? "npm-global" : "workspace",
    platform: process.platform,
    arch: process.arch,
  };
}

async function discoverExecutors(
  command: Extract<ParsedCommand, { readonly kind: "executor-discover" }>,
  context: CliCommandContext,
): Promise<JsonValue> {
  const page = hostPage(await context.localHost.listExecutors());
  const descriptors = page.items
    .map((item) => normalizeExecutor(item, command.executorKind))
    .filter((item) => matchesExecutor(item, command));
  const result = paginateOrHost(
    descriptors,
    page.hostPaged,
    page.nextCursor,
    command.limit,
    command.cursor,
  );
  return {
    kind: command.executorKind,
    items: result.items,
    ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
  };
}

async function describeExecutor(
  command: Extract<ParsedCommand, { readonly kind: "executor-describe" }>,
  context: CliCommandContext,
): Promise<JsonValue> {
  const descriptors = hostPage(await context.localHost.listExecutors()).items.map((item) =>
    normalizeExecutor(item, command.executorKind),
  );
  const match = descriptors.find((descriptor) => {
    const record = isRecord(descriptor) ? descriptor : undefined;
    const ref = record === undefined ? undefined : referenceText(record["ref"]);
    const project = recordField(descriptor, "project");
    return (
      ref === command.ref &&
      (command.revision === undefined || project?.["revision"] === command.revision)
    );
  });
  if (match === undefined) {
    throw toIntegrationError({
      code: "EXECUTOR_NOT_FOUND",
      message: `Executor not found: ${command.ref}.`,
    });
  }
  return match;
}

async function listMissions(
  command: Extract<ParsedCommand, { readonly kind: "mission-list" }>,
  context: CliCommandContext,
): Promise<JsonValue> {
  const page = hostPage(await context.localHost.listMissions());
  const filtered = page.items.filter((mission) => matchesMission(mission, command));
  const result = paginateOrHost(
    filtered,
    page.hostPaged,
    page.nextCursor,
    command.limit,
    command.cursor,
  );
  return {
    items: result.items.map(asJsonValue),
    ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
  };
}

async function getMission(
  command: Extract<ParsedCommand, { readonly kind: "mission-get" }>,
  context: CliCommandContext,
): Promise<JsonValue> {
  const mission = await context.localHost.getMission(command.missionId);
  if (command.view === "summary") return asJsonValue(mission);
  if (isRecord(mission) && mission[command.view] !== undefined) {
    return asJsonValue(mission[command.view]);
  }
  return asJsonValue(mission);
}

async function listBoard(
  command: Extract<ParsedCommand, { readonly kind: "board-list" }>,
  context: CliCommandContext,
): Promise<JsonValue> {
  const page = hostPage(await context.localHost.listSharedBoard(command.missionId), [
    "items",
    "entries",
  ]);
  const items = page.items.map((item) => mapBoardItem(item));
  const result = paginateOrHost(
    items,
    page.hostPaged,
    page.nextCursor,
    command.limit,
    command.cursor,
  );
  return asJsonValue(
    BoardListResultSchema.parse({
      schemaVersion: "pragma.board-list/v1",
      missionId: command.missionId,
      items: result.items,
      ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
    }),
  );
}

async function readBoard(
  command: Extract<ParsedCommand, { readonly kind: "board-read" }>,
  context: CliCommandContext,
): Promise<JsonValue> {
  const raw = await context.localHost.readSharedBoard(
    command.missionId,
    command.contextId,
    command.start,
    command.maxBytes,
  );
  if (isRecord(raw) && raw["schemaVersion"] === "pragma.board-read/v1") {
    const rawItem = isRecord(raw["item"]) ? raw["item"] : undefined;
    mapBoardItem(
      rawItem,
      rawItem !== undefined && typeof rawItem["content"] === "string" ? rawItem["content"] : "",
    );
    return asJsonValue(BoardReadResultSchema.parse(raw));
  }
  const record = isRecord(raw) ? raw : {};
  const content = typeof record["content"] === "string" ? record["content"] : "";
  const mappedRange = mapContentRange(record["contentRange"], content);
  return asJsonValue(
    BoardReadResultSchema.parse({
      schemaVersion: "pragma.board-read/v1",
      missionId: command.missionId,
      item: {
        ...mapBoardItem(raw, content),
        content,
        contentRange: mappedRange,
      },
    }),
  );
}

async function searchBoard(
  command: Extract<ParsedCommand, { readonly kind: "board-search" }>,
  context: CliCommandContext,
): Promise<JsonValue> {
  // The Local Host owns the Board search implementation and shared scope; the
  // CLI forwards the frozen search options through the M3 port.
  const raw = await context.localHost.searchSharedBoard(
    command.missionId,
    command.query,
    command.maxResults,
    { caseSensitive: command.caseSensitive, contextLines: command.contextLines },
  );
  const page = hostPage(raw, ["matches", "items"]);
  const matches = page.items.map((match) => {
    const record = isRecord(match) ? match : {};
    const itemSource = record["item"] ?? match;
    const lineNumber =
      typeof record["lineNumber"] === "number" ? record["lineNumber"] : record["line"];
    const line =
      typeof record["line"] === "string"
        ? record["line"]
        : typeof record["snippet"] === "string"
          ? record["snippet"]
          : "";
    return {
      item: mapBoardItem(itemSource),
      ...(typeof lineNumber === "number" ? { line: lineNumber } : {}),
      snippet: line,
    };
  });
  const result = paginateOrHost(
    matches,
    page.hostPaged,
    page.nextCursor,
    command.maxResults,
    undefined,
  );
  return asJsonValue(
    BoardSearchResultSchema.parse({
      schemaVersion: "pragma.board-search/v1",
      missionId: command.missionId,
      query: command.query,
      matches: result.items,
      ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
    }),
  );
}

async function listQueue(
  command: Extract<ParsedCommand, { readonly kind: "queue-list" }>,
  context: CliCommandContext,
): Promise<JsonValue> {
  const page = hostPage(await context.localHost.listMissionQueue(command.missionId), [
    "items",
    "operations",
    "queue",
  ]);
  const result = paginateOrHost(
    page.items.map(asJsonValue),
    page.hostPaged,
    page.nextCursor,
    command.limit,
    command.cursor,
  );
  return {
    missionId: command.missionId,
    items: result.items,
    ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
  };
}

function normalizeExecutor(
  value: unknown,
  expectedKind: Extract<ParsedCommand, { readonly kind: "executor-discover" }>["executorKind"],
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
    name: stringField(value, "name") ?? ref,
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

function matchesExecutor(
  value: JsonValue,
  command: Extract<ParsedCommand, { readonly kind: "executor-discover" }>,
): boolean {
  if (!isRecord(value)) return false;
  const ref = referenceText(value["ref"]);
  const kind = ref?.split(":", 1)[0] ?? value["kind"];
  if (kind !== command.executorKind) return false;
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

function matchesMission(
  value: unknown,
  command: Extract<ParsedCommand, { readonly kind: "mission-list" }>,
): boolean {
  if (!isRecord(value)) return false;
  const executor = recordField(value, "executor");
  const execution = recordField(value, "execution");
  const status = stringField(value, "lifecycleStatus") ?? stringField(execution, "status");
  if (command.status !== undefined && status !== command.status) return false;
  if (command.executor !== undefined) {
    const ref = stringField(executor, "ref") ?? referenceText(executor?.["ref"]);
    if (ref !== command.executor) return false;
  }
  return true;
}

function mapBoardItem(value: unknown, content = ""): Record<string, unknown> {
  if (!isRecord(value)) {
    return {
      id: "unknown",
      namespace: "mission-board",
      trigger: "manual",
      priority: "normal",
      revision: "unknown",
      sizeBytes: Buffer.byteLength(content, "utf8"),
    };
  }
  const namespace = stringField(value, "namespace");
  const scopeId = stringField(value, "scopeId");
  const storeId = stringField(value, "storeId");
  const metadata = recordField(value, "metadata") ?? value;
  const metadataNamespace = stringField(metadata, "namespace");
  const metadataScopeId = stringField(metadata, "scopeId");
  if (
    value["private"] === true ||
    (namespace !== undefined && namespace !== "mission-board") ||
    (scopeId !== undefined && scopeId !== "mission-board:shared") ||
    (storeId !== undefined && storeId !== "mission-board") ||
    metadata["private"] === true ||
    (metadataNamespace !== undefined && metadataNamespace !== "mission-board") ||
    (metadataScopeId !== undefined && metadataScopeId !== "mission-board:shared") ||
    metadata["sensitivity"] === "private"
  ) {
    throw toIntegrationError({
      code: "PERMISSION_DENIED",
      message: "Private Mission Board namespaces are not readable.",
    });
  }
  const trigger = metadata["trigger"];
  const priority = metadata["priority"];
  return {
    id: stringField(value, "id") ?? "unknown",
    namespace: "mission-board",
    ...(typeof metadata["description"] === "string"
      ? { description: metadata["description"] }
      : {}),
    trigger: trigger === "always_on" || trigger === "model_decision" ? trigger : "manual",
    priority:
      priority === "critical" || priority === "high" || priority === "low" ? priority : "normal",
    revision: stringField(value, "revision") ?? stringField(value, "etag") ?? "unknown",
    sizeBytes:
      typeof value["sizeBytes"] === "number"
        ? value["sizeBytes"]
        : Buffer.byteLength(content, "utf8"),
  };
}

function mapContentRange(value: unknown, content: string): Record<string, number> {
  const record = isRecord(value) ? value : {};
  const start =
    typeof record["start"] === "number"
      ? record["start"]
      : typeof record["startOffset"] === "number"
        ? record["startOffset"]
        : 0;
  const end =
    typeof record["end"] === "number"
      ? record["end"]
      : typeof record["endOffset"] === "number"
        ? record["endOffset"]
        : start + Buffer.byteLength(content, "utf8");
  const totalBytes =
    typeof record["totalBytes"] === "number"
      ? record["totalBytes"]
      : typeof record["sizeBytes"] === "number"
        ? record["sizeBytes"]
        : end;
  const nextStart =
    typeof record["nextStart"] === "number"
      ? record["nextStart"]
      : typeof record["nextStartOffset"] === "number"
        ? record["nextStartOffset"]
        : end;
  return { start, end, totalBytes, ...(nextStart < totalBytes ? { nextStart } : {}) };
}

function paginateOrHost<T>(
  items: readonly T[],
  hostPaged: boolean,
  hostNextCursor: string | undefined,
  limit: number,
  cursor: string | undefined,
): { readonly items: readonly T[]; readonly nextCursor?: string | undefined } {
  if (hostPaged) {
    if (cursor !== undefined) {
      throw toIntegrationError({
        code: "CURSOR_INVALID",
        message: "This Host query does not accept a client cursor.",
      });
    }
    return {
      items: items.slice(0, limit),
      ...(hostNextCursor === undefined ? {} : { nextCursor: hostNextCursor }),
    };
  }
  try {
    return pageItems(items, limit, cursor);
  } catch {
    throw toIntegrationError({
      code: "CURSOR_INVALID",
      message: "The cursor is invalid for this query.",
    });
  }
}

function referenceText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  const kind = value["kind"];
  const id = value["id"];
  return typeof kind === "string" && typeof id === "string" ? `${kind}:${id}` : undefined;
}

function completionScript(
  shell: Extract<ParsedCommand, { readonly kind: "completion" }>["shell"],
): string {
  switch (shell) {
    case "bash":
      return `_pragma_complete() {\n  COMPREPLY=( $(compgen -W "version doctor completion team expert flow mission" -- "${"$"}2") )\n}\ncomplete -F _pragma_complete pragma\n`;
    case "zsh":
      return `#compdef pragma\n_arguments '1:command:(version doctor completion team expert flow mission)'\n`;
    case "fish":
      return `complete -c pragma -f -a 'version doctor completion team expert flow mission'\n`;
    case "powershell":
      return `Register-ArgumentCompleter -CommandName pragma -ScriptBlock { param(${"$"}wordToComplete)\n  'version','doctor','completion','team','expert','flow','mission' | Where-Object { ${"$"}_ -like "${"$"}wordToComplete*" }\n}\n`;
  }
}
