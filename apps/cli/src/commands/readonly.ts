import {
  BoardListResultSchema,
  BoardReadResultSchema,
  BoardSearchResultSchema,
  ExecutorDescriptorSchema,
  type JsonValue,
} from "@pragma/local-host/wire";
import { unsupportedMissionView } from "@pragma/local-host";
import type { HumanInteractionRequestEnvelope } from "@pragma/local-host/wire";

import type { ParsedCommand } from "../parser/argv.ts";
import { HELP_TEXT } from "../parser/argv.ts";
import { detectInstalledDesktopVersion } from "../desktop-version.ts";
import { toIntegrationError } from "./errors.ts";
import { collectHumanInteraction } from "../terminal.ts";
import type { CliCommandContext } from "./types.ts";
import {
  asJsonValue,
  hostPage,
  isRecord,
  pageItems,
  recordField,
  stringField,
  type CursorScope,
} from "./utils.ts";

export async function executeReadOnlyCommand(
  command: ParsedCommand,
  context: CliCommandContext,
): Promise<JsonValue> {
  switch (command.kind) {
    case "help":
      return { help: command.text ?? HELP_TEXT };
    case "version":
      return await versionResult(context.cliVersion);
    case "completion":
      return { shell: command.shell, script: completionScript(command.shell) };
    case "doctor":
      throw new Error("doctor must be handled by the doctor command.");
    case "source-init":
    case "source-add":
      throw new Error("Source commands must be handled by the Source command.");
    case "executor-discover":
      return await discoverExecutors(command, context);
    case "executor-describe":
      return await describeExecutor(command, context);
    case "executor-run":
      throw new Error("executor run must be handled by the run command.");
    case "mission-list":
      return await listMissions(command, context);
    case "mission-get":
      return await getMission(command, context);
    case "mission-watch":
      throw new Error("Mission watch must be handled by the streaming command.");
    case "mission-resume":
      return await resumeMission(command, context);
    case "mission-send":
    case "mission-steer":
    case "mission-respond":
    case "mission-interrupt":
    case "queue-remove":
    case "queue-resume":
    case "queue-steer":
      throw new Error("Mission mutation commands must be handled by the mutation command.");
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

async function resumeMission(
  command: Extract<ParsedCommand, { readonly kind: "mission-resume" }>,
  context: CliCommandContext,
): Promise<JsonValue> {
  if (context.localHost.resumeMission === undefined) {
    throw toIntegrationError({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Mission resume is unavailable in this Host composition.",
    });
  }
  if (context.interactive === "always" && !context.terminal.isControllingTerminal()) {
    throw toIntegrationError({
      code: "INTERACTIVE_TTY_REQUIRED",
      message: "--interactive always requires a controlling terminal.",
    });
  }
  const useTerminalInteraction =
    context.interactive === "always" ||
    (context.interactive === "auto" &&
      context.format === "text" &&
      context.terminal.isControllingTerminal());
  const onHumanInteraction = useTerminalInteraction
    ? async (request: HumanInteractionRequestEnvelope) => ({
        kind: "respond" as const,
        response: (await collectHumanInteraction(context.terminal, request)).interaction,
      })
    : undefined;
  return asJsonValue(
    await context.localHost.resumeMission({
      missionId: command.missionId,
      ...(command.project === undefined || command.revision === undefined
        ? {}
        : { project: { projectId: command.project, revision: command.revision } }),
      ...(command.expectedFingerprint === undefined
        ? {}
        : { expectedFingerprint: command.expectedFingerprint }),
      ...(command.requestId === undefined ? {} : { requestId: command.requestId }),
      ...(command.detach === undefined ? {} : { detach: command.detach }),
      ...(onHumanInteraction === undefined ? {} : { onHumanInteraction }),
    }),
  );
}

export async function versionResult(
  cliVersion: string,
  detectDesktopVersion: () => Promise<string | undefined> = detectInstalledDesktopVersion,
): Promise<JsonValue> {
  const desktopBundleVersion = (await detectDesktopVersion()) ?? "unknown";
  return {
    cliVersion,
    desktopBundleVersion,
    wireVersion: "pragma.integration/v2",
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
  if (command.selector !== undefined && descriptors.length === 0) {
    throw toIntegrationError({
      code: "EXECUTOR_NOT_FOUND",
      message: `Executor not found: ${command.selector}.`,
    });
  }
  const result = paginateOrHost(
    descriptors,
    page.hostPaged,
    page.nextCursor,
    command.limit,
    command.cursor,
    {
      command: `${command.executorKind}.discover`,
      filters: {
        selector: command.selector,
        query: command.query,
        status: command.status,
        project: command.project,
      },
    },
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
    {
      command: "mission.list",
      filters: { status: command.status, executor: command.executor },
    },
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
  if (command.view === "chat" || command.view === "work") {
    throw unsupportedMissionView(command.view);
  }
  return asJsonValue(
    await context.localHost.queryMission({
      missionId: command.missionId,
      view: command.view,
      limit: command.limit,
      ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
    }),
  );
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
    { command: "mission.board.list", filters: { missionId: command.missionId } },
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
    {
      command: "mission.board.search",
      filters: {
        missionId: command.missionId,
        query: command.query,
        maxResults: command.maxResults,
        caseSensitive: command.caseSensitive,
        contextLines: command.contextLines,
      },
    },
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
  const raw = await context.localHost.listMissionQueue(command.missionId);
  const page = hostPage(raw, ["items", "queue"]);
  const result = paginateOrHost(
    page.items.map(asJsonValue),
    page.hostPaged,
    page.nextCursor,
    command.limit,
    command.cursor,
    { command: "mission.queue.list", filters: { missionId: command.missionId } },
  );
  const projection = isRecord(raw) ? (isRecord(raw["queue"]) ? raw["queue"] : raw) : undefined;
  return {
    missionId: command.missionId,
    ...(typeof projection?.["sessionId"] === "string"
      ? { sessionId: projection["sessionId"] }
      : {}),
    ...(projection?.["state"] === "idle" ||
    projection?.["state"] === "running" ||
    projection?.["state"] === "paused"
      ? { state: projection["state"] }
      : {}),
    ...(typeof projection?.["pendingCount"] === "number"
      ? { pendingCount: projection["pendingCount"] }
      : {}),
    ...(typeof projection?.["pausedAfterRequestId"] === "string"
      ? { pausedAfterRequestId: projection["pausedAfterRequestId"] }
      : {}),
    ...(typeof projection?.["supportsSteer"] === "boolean"
      ? { supportsSteer: projection["supportsSteer"] }
      : {}),
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

function matchesMission(
  value: unknown,
  command: Extract<ParsedCommand, { readonly kind: "mission-list" }>,
): boolean {
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
  return true;
}

function isCanonicalExecutorRef(value: string): boolean {
  return /^(team|expert|flow):[0-9a-hjkmnp-tv-z]{16}$/u.test(value);
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
  scope: CursorScope,
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
    return pageItems(items, limit, cursor, scope);
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
      return completionBashScript();
    case "zsh":
      return completionZshScript();
    case "fish":
      return completionFishScript();
    case "powershell":
      return completionPowerShellScript();
  }
}

function completionBashScript(): string {
  return replaceShellDollar(
    String.raw`
_pragma_complete() {
  local cur candidates
  cur="__PRAGMA_DOLLAR__{COMP_WORDS[COMP_CWORD]}"
  candidates="version doctor completion team expert flow mission source --format --json --stream-json --color --interactive --help"
  case "__PRAGMA_DOLLAR__{COMP_WORDS[1]}" in
    team|expert|flow)
      case "__PRAGMA_DOLLAR__{COMP_WORDS[2]}" in
        discover) candidates="--project --query --status --limit --cursor --format --json --stream-json --color --interactive --help" ;;
        run) candidates="--workspace --prompt --input --input-json --project --revision --expected-fingerprint --request-id --detach --format --json --stream-json --color --interactive --help" ;;
        describe) candidates="--revision --format --json --stream-json --color --interactive --help" ;;
        *) candidates="discover describe run --format --json --stream-json --color --interactive --help" ;;
      esac
      ;;
    mission)
      case "__PRAGMA_DOLLAR__{COMP_WORDS[2]}" in
        list) candidates="--status --executor --limit --cursor --format --json --stream-json --color --interactive --help" ;;
        get) candidates="--view --limit --cursor --format --json --stream-json --color --interactive --help" ;;
        board) candidates="list read search --format --json --stream-json --color --interactive --help" ;;
        queue)
          case "__PRAGMA_DOLLAR__{COMP_WORDS[3]}" in
            list) candidates="--limit --cursor --format --json --stream-json --color --interactive --help" ;;
            remove) candidates="--request --request-id --ack-timeout --format --json --stream-json --color --interactive --help" ;;
            resume) candidates="--request-id --ack-timeout --format --json --stream-json --color --interactive --help" ;;
            steer) candidates="--request --request-id --expected-execution --wait --detach --ack-timeout --format --json --stream-json --color --interactive --help" ;;
            *) candidates="list remove resume steer --format --json --stream-json --color --interactive --help" ;;
          esac
          ;;
        watch) candidates="--after --replay --until --format --stream-json --color --interactive --help" ;;
        resume) candidates="--project --revision --expected-fingerprint --request-id --detach --format --json --stream-json --color --interactive --help" ;;
        send) candidates="--prompt --input --request-id --wait --detach --ack-timeout --format --json --stream-json --color --interactive --help" ;;
        steer) candidates="--prompt --input --expected-execution --request-id --wait --detach --ack-timeout --format --json --stream-json --color --interactive --help" ;;
        respond) candidates="--interaction --answer --choice --answers-json --request-id --wait --detach --ack-timeout --format --json --stream-json --color --interactive --help" ;;
        interrupt) candidates="--expected-execution --reason --request-id --wait --detach --ack-timeout --format --json --stream-json --color --interactive --help" ;;
        *) candidates="list get resume watch send steer respond interrupt board queue --format --json --stream-json --color --interactive --help" ;;
      esac
      ;;
    source)
      case "__PRAGMA_DOLLAR__{COMP_WORDS[2]}" in
        init) candidates="--id --name --format --json --stream-json --color --interactive --help" ;;
        add) candidates="--directory --format --json --stream-json --color --interactive --help" ;;
        *) candidates="init add --format --json --stream-json --color --interactive --help" ;;
      esac
      ;;
  esac
  COMPREPLY=( $(compgen -W "__PRAGMA_DOLLAR__candidates" -- "__PRAGMA_DOLLAR__cur") )
}
complete -F _pragma_complete pragma
`,
    "\n",
  );
}

function completionZshScript(): string {
  return replaceShellDollar(
    String.raw`#compdef pragma
_pragma() {
  local state
  _arguments -C \
    '1:command:(version doctor completion team expert flow mission source)' \
    '*:argument:->argument'
  case __PRAGMA_DOLLAR__state in
    argument)
      case __PRAGMA_DOLLAR__words[2] in
        team|expert|flow)
          if (( CURRENT == 3 )); then
            _describe command 'discover describe run'
          else
            case __PRAGMA_DOLLAR__words[3] in
              discover) _describe option '--project --query --status --limit --cursor --format --json --stream-json --color --interactive --help' ;;
              describe) _describe option '--revision --format --json --stream-json --color --interactive --help' ;;
              run) _describe option '--workspace --prompt --input --input-json --project --revision --expected-fingerprint --request-id --detach --format --json --stream-json --color --interactive --help' ;;
              *) _describe option '--format --json --stream-json --color --interactive --help' ;;
            esac
          fi
          ;;
        mission)
          if (( CURRENT == 3 )); then
            _describe command 'list get resume watch send steer respond interrupt board queue'
          else
            case __PRAGMA_DOLLAR__words[3] in
              list) _describe option '--status --executor --limit --cursor --format --json --stream-json --color --interactive --help' ;;
              get) _describe option '--view --limit --cursor --format --json --stream-json --color --interactive --help' ;;
              board) _describe command 'list read search' ;;
              queue)
                if (( CURRENT == 4 )); then _describe command 'list remove resume steer';
                else
                  case __PRAGMA_DOLLAR__words[4] in
                    list) _describe option '--limit --cursor --format --json --stream-json --color --interactive --help' ;;
                    remove) _describe option '--request --request-id --ack-timeout --format --json --stream-json --color --interactive --help' ;;
                    resume) _describe option '--request-id --ack-timeout --format --json --stream-json --color --interactive --help' ;;
                    steer) _describe option '--request --request-id --expected-execution --wait --detach --ack-timeout --format --json --stream-json --color --interactive --help' ;;
                  esac
                fi
                ;;
              watch) _describe option '--after --replay --until --format --stream-json --color --interactive --help' ;;
              resume) _describe option '--project --revision --expected-fingerprint --request-id --detach --format --json --stream-json --color --interactive --help' ;;
              respond) _describe option '--interaction --answer --choice --answers-json --request-id --wait --detach --ack-timeout --format --json --stream-json --color --interactive --help' ;;
              send) _describe option '--prompt --input --request-id --wait --detach --ack-timeout --format --json --stream-json --color --interactive --help' ;;
              steer) _describe option '--prompt --input --expected-execution --request-id --wait --detach --ack-timeout --format --json --stream-json --color --interactive --help' ;;
              *) _describe option '--format --json --stream-json --color --interactive --help' ;;
            esac
          fi
          ;;
        source)
          if (( CURRENT == 3 )); then
            _describe command 'init add'
          else
            case __PRAGMA_DOLLAR__words[3] in
              init) _describe option '--id --name --format --json --stream-json --color --interactive --help' ;;
              add) _describe option '--directory --format --json --stream-json --color --interactive --help' ;;
            esac
          fi
          ;;
      esac
      ;;
  esac
}
compdef _pragma pragma
`,
    "\n",
  );
}

function completionFishScript(): string {
  return replaceShellDollar(
    String.raw`function __pragma_mission_queue
  set -l tokens (commandline -opc)
  if contains mission __PRAGMA_DOLLAR__tokens
    if contains queue __PRAGMA_DOLLAR__tokens
      return 0
    end
  end
  return 1
end

function __pragma_discover
  set -l tokens (commandline -opc)
  contains discover __PRAGMA_DOLLAR__tokens
end

function __pragma_describe
  set -l tokens (commandline -opc)
  contains describe __PRAGMA_DOLLAR__tokens
end

function __pragma_run
  set -l tokens (commandline -opc)
  contains run __PRAGMA_DOLLAR__tokens
end

function __pragma_mission_list
  set -l tokens (commandline -opc)
  if contains mission __PRAGMA_DOLLAR__tokens; and contains list __PRAGMA_DOLLAR__tokens
    if contains queue __PRAGMA_DOLLAR__tokens; or contains board __PRAGMA_DOLLAR__tokens
      return 1
    end
    return 0
  end
  return 1
end

function __pragma_mission_get
  set -l tokens (commandline -opc)
  if contains mission __PRAGMA_DOLLAR__tokens; and contains get __PRAGMA_DOLLAR__tokens
    if contains queue __PRAGMA_DOLLAR__tokens; or contains board __PRAGMA_DOLLAR__tokens
      return 1
    end
    return 0
  end
  return 1
end

function __pragma_mission_watch
  set -l tokens (commandline -opc)
  if contains mission __PRAGMA_DOLLAR__tokens; and contains watch __PRAGMA_DOLLAR__tokens
    return 0
  end
  return 1
end

function __pragma_global_options
  if __pragma_mission_watch
    return 1
  end
  return 0
end

function __pragma_mission_resume
  set -l tokens (commandline -opc)
  if contains mission __PRAGMA_DOLLAR__tokens; and contains resume __PRAGMA_DOLLAR__tokens
    if contains queue __PRAGMA_DOLLAR__tokens
      return 1
    end
    return 0
  end
  return 1
end

function __pragma_mission_send
  set -l tokens (commandline -opc)
  if contains mission __PRAGMA_DOLLAR__tokens; and contains send __PRAGMA_DOLLAR__tokens
    if contains queue __PRAGMA_DOLLAR__tokens
      return 1
    end
    return 0
  end
  return 1
end

function __pragma_mission_steer
  set -l tokens (commandline -opc)
  if contains mission __PRAGMA_DOLLAR__tokens; and contains steer __PRAGMA_DOLLAR__tokens
    if contains queue __PRAGMA_DOLLAR__tokens
      return 1
    end
    return 0
  end
  return 1
end

function __pragma_mission_respond
  set -l tokens (commandline -opc)
  if contains mission __PRAGMA_DOLLAR__tokens; and contains respond __PRAGMA_DOLLAR__tokens
    return 0
  end
  return 1
end

function __pragma_mission_interrupt
  set -l tokens (commandline -opc)
  if contains mission __PRAGMA_DOLLAR__tokens; and contains interrupt __PRAGMA_DOLLAR__tokens
    return 0
  end
  return 1
end

function __pragma_queue_list
  set -l tokens (commandline -opc)
  if __pragma_mission_queue; and contains list __PRAGMA_DOLLAR__tokens
    return 0
  end
  return 1
end

function __pragma_queue_remove
  set -l tokens (commandline -opc)
  if __pragma_mission_queue; and contains remove __PRAGMA_DOLLAR__tokens
    return 0
  end
  return 1
end

function __pragma_queue_resume
  set -l tokens (commandline -opc)
  if __pragma_mission_queue; and contains resume __PRAGMA_DOLLAR__tokens
    return 0
  end
  return 1
end

function __pragma_queue_steer
  set -l tokens (commandline -opc)
  if __pragma_mission_queue; and contains steer __PRAGMA_DOLLAR__tokens
    return 0
  end
  return 1
end

complete -c pragma -f -n '__fish_use_subcommand' -a 'version doctor completion team expert flow mission source'
complete -c pragma -f -n '__fish_seen_subcommand_from team expert flow' -a 'discover describe run'
complete -c pragma -f -n '__fish_seen_subcommand_from source' -a 'init add'
complete -c pragma -f -n '__fish_seen_subcommand_from source; and __fish_seen_subcommand_from init' -a '--id --name --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__fish_seen_subcommand_from source; and __fish_seen_subcommand_from add' -a '--directory --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__fish_seen_subcommand_from mission' -a 'list get resume watch send steer respond interrupt board queue'
complete -c pragma -f -n '__pragma_mission_queue' -a 'list remove resume steer'
complete -c pragma -f -n '__fish_seen_subcommand_from board' -a 'list read search'
complete -c pragma -f -n '__pragma_discover' -a '--project --query --status --limit --cursor --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_describe' -a '--revision --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_run' -a '--workspace --prompt --input --input-json --project --revision --expected-fingerprint --request-id --detach --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_mission_list' -a '--status --executor --limit --cursor --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_mission_get' -a '--view --limit --cursor --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_mission_watch' -a '--after --replay --until --format --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_mission_resume' -a '--project --revision --expected-fingerprint --request-id --detach --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_mission_send' -a '--prompt --input --request-id --wait --detach --ack-timeout --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_mission_steer' -a '--prompt --input --expected-execution --request-id --wait --detach --ack-timeout --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_mission_respond' -a '--interaction --answer --choice --answers-json --request-id --wait --detach --ack-timeout --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_mission_interrupt' -a '--expected-execution --reason --request-id --wait --detach --ack-timeout --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_queue_list' -a '--limit --cursor --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_queue_remove' -a '--request --request-id --ack-timeout --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_queue_resume' -a '--request-id --ack-timeout --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_queue_steer' -a '--request --request-id --expected-execution --wait --detach --ack-timeout --format --json --stream-json --color --interactive --help'
complete -c pragma -f -n '__pragma_global_options' -a '--format --json --stream-json --color --interactive --help'
`,
    "\n",
  );
}

function completionPowerShellScript(): string {
  return replaceShellDollar(
    String.raw`Register-ArgumentCompleter -CommandName pragma -ScriptBlock {
  param(__PRAGMA_DOLLAR__wordToComplete, __PRAGMA_DOLLAR__commandAst, __PRAGMA_DOLLAR__cursorPosition)
  __PRAGMA_DOLLAR__tokens = @(__PRAGMA_DOLLAR__commandAst.CommandElements | ForEach-Object { __PRAGMA_DOLLAR___.ToString().Trim([char]39, [char]34) })
  __PRAGMA_DOLLAR__globalOptions = @('--format','--json','--stream-json','--color','--interactive','--help')
  __PRAGMA_DOLLAR__watchGlobalOptions = @('--format','--stream-json','--color','--interactive','--help')
  __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('version','doctor','completion','team','expert','flow','mission','source')
  if (__PRAGMA_DOLLAR__tokens.Count -ge 2) {
    switch (__PRAGMA_DOLLAR__tokens[1]) {
      'team' {
        if (__PRAGMA_DOLLAR__tokens -contains 'discover') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--project','--query','--status','--limit','--cursor') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'describe') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--revision') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'run') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--workspace','--prompt','--input','--input-json','--project','--revision','--expected-fingerprint','--request-id','--detach') }
        else { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('discover','describe','run') }
      }
      'expert' {
        if (__PRAGMA_DOLLAR__tokens -contains 'discover') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--project','--query','--status','--limit','--cursor') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'describe') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--revision') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'run') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--workspace','--prompt','--input','--input-json','--project','--revision','--expected-fingerprint','--request-id','--detach') }
        else { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('discover','describe','run') }
      }
      'flow' {
        if (__PRAGMA_DOLLAR__tokens -contains 'discover') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--project','--query','--status','--limit','--cursor') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'describe') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--revision') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'run') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--workspace','--prompt','--input','--input-json','--project','--revision','--expected-fingerprint','--request-id','--detach') }
        else { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('discover','describe','run') }
      }
      'mission' {
        if (__PRAGMA_DOLLAR__tokens -contains 'queue') {
          if (__PRAGMA_DOLLAR__tokens -contains 'list') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--limit','--cursor') }
          elseif (__PRAGMA_DOLLAR__tokens -contains 'remove') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--request','--request-id','--ack-timeout') }
          elseif (__PRAGMA_DOLLAR__tokens -contains 'resume') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--request-id','--ack-timeout') }
          elseif (__PRAGMA_DOLLAR__tokens -contains 'steer') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--request','--request-id','--expected-execution','--wait','--detach','--ack-timeout') }
          else { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('list','remove','resume','steer') }
        }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'list') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--status','--executor','--limit','--cursor') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'get') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--view','--limit','--cursor') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'watch') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__watchGlobalOptions + @('--after','--replay','--until') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'resume') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--project','--revision','--expected-fingerprint','--request-id','--detach') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'send') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--prompt','--input','--request-id','--wait','--detach','--ack-timeout') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'steer') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--prompt','--input','--expected-execution','--request-id','--wait','--detach','--ack-timeout') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'respond') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--interaction','--answer','--choice','--answers-json','--request-id','--wait','--detach','--ack-timeout') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'interrupt') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--expected-execution','--reason','--request-id','--wait','--detach','--ack-timeout') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'board') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('list','read','search') }
        else { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('list','get','resume','watch','send','steer','respond','interrupt','board','queue') }
      }
      'source' {
        if (__PRAGMA_DOLLAR__tokens -contains 'init') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--id','--name') }
        elseif (__PRAGMA_DOLLAR__tokens -contains 'add') { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('--directory') }
        else { __PRAGMA_DOLLAR__candidates = __PRAGMA_DOLLAR__globalOptions + @('init','add') }
      }
    }
  }
  __PRAGMA_DOLLAR__candidates | Where-Object { __PRAGMA_DOLLAR___.ToString() -like "__PRAGMA_DOLLAR__wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new(__PRAGMA_DOLLAR___.ToString(), __PRAGMA_DOLLAR___.ToString(), 'ParameterValue', __PRAGMA_DOLLAR___.ToString())
  }
}
`,
    "\n",
  );
}

function replaceShellDollar(script: string, separator: string): string {
  return script.replaceAll("__PRAGMA_DOLLAR__", "$").trimStart() + separator;
}
