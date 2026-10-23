import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { z } from "zod";
import {
  BUILT_IN_SKILLS,
  builtInSkillCapability,
  type PragmaManagedResourceQueryPort,
} from "@pragma/built-in-agents";
import { canonicalPragmaResourceRef, type PragmaResource } from "@pragma/interpreter/ast";
import {
  IntegrationErrorSchema,
  MANAGED_RESOURCE_QUERY_SCHEMAS,
  ManagedSkillSummarySchema,
  ManagedKnowledgeSummarySchema,
  managementCommandError,
  JsonObjectSchema,
  type JsonValue,
  type ManagedResourceCommand,
  type ManagedResourceContinuation,
  type ManagedResourceQuery,
  type ManagedResourceQueryResult,
  type ManagedResourceContentSchema,
  type ManagedSkillTargetSchema,
  type ManagedKnowledgeTargetSchema,
} from "@pragma/shared/integration";
import type { CapabilityStore } from "./deployment/capabilities/capability-store.ts";
import type { ContextStoreStore } from "./deployment/context-stores/context-store-store.ts";
import { CapabilityStoreError } from "./resources/capability-reader.ts";
import { ContextStoreStoreError } from "./resources/context-store-reader.ts";
import {
  classifyHostCapabilityResource,
  classifyHostContextResource,
} from "./deployment/bindings.ts";
import { paginateManagementItems } from "./management-pagination.ts";

// Leave room for the command envelope and error diagnostics below the 256 KiB tool limit.
const MAX_QUERY_BYTES = 128 * 1024;
type Input = Record<string, JsonValue | undefined>;
type Content = z.infer<typeof ManagedResourceContentSchema>;

export function createManagedResourceQueryPort(options: {
  readonly capabilities: Pick<CapabilityStore, "list" | "get" | "getSkillFile" | "listSkillFiles">;
  readonly knowledge: Pick<ContextStoreStore, "get" | "getSnapshot" | "withRevisionLock">;
  readonly resources: () => Promise<readonly PragmaResource[]>;
}): PragmaManagedResourceQueryPort {
  const skill = async (input: z.infer<typeof ManagedSkillTargetSchema>) => {
    const latest = await options.capabilities.get(input.capabilityId);
    if (latest.definition.kind !== "skill")
      throw managementCommandError("INVALID_ARGUMENT", "The capability is not a Skill.");
    const revision =
      input.revision === "active"
        ? latest.manifest.activeRevision
        : (input.revision ?? latest.manifest.latestRevision);
    if (revision === undefined)
      throw managementCommandError(
        "NOT_FOUND",
        "This Skill has no active revision. Read its latest formal revision instead.",
      );
    const selected =
      revision === latest.manifest.latestRevision
        ? latest
        : await options.capabilities.get(input.capabilityId, revision);
    if (selected.definition.kind !== "skill")
      throw managementCommandError("INVALID_ARGUMENT", "The selected revision is not a Skill.");
    assertHash(input.contentHash, selected.definition.contentHash);
    const identity = {
      capabilityId: input.capabilityId,
      revision,
      contentHash: selected.definition.contentHash,
    };
    return {
      identity,
      summary: ManagedSkillSummarySchema.parse({
        ...identity,
        name: selected.definition.name,
        description: selected.definition.description,
        managedBy: latest.managedBy ?? "user",
        status: selected.health.status,
        latestRevision: latest.manifest.latestRevision,
        activeRevision: latest.manifest.activeRevision ?? null,
      }),
    };
  };
  const knowledge = async (input: z.infer<typeof ManagedKnowledgeTargetSchema>) =>
    await options.knowledge.withRevisionLock(input.storeId, async () => {
      const store = await options.knowledge.get(input.storeId);
      const snapshot = await options.knowledge.getSnapshot(
        input.storeId,
        input.revision ?? store.contentRevision,
      );
      assertHash(input.snapshotHash, snapshot.snapshotHash);
      return {
        snapshot,
        identity: {
          storeId: store.id,
          revision: snapshot.revision,
          snapshotHash: snapshot.snapshotHash,
        },
        summary: ManagedKnowledgeSummarySchema.parse({
          storeId: store.id,
          name: store.name,
          description: store.description,
          type: store.type,
          status: store.status,
          revision: snapshot.revision,
          snapshotHash: snapshot.snapshotHash,
          writeApprovalMode: store.writeApprovalMode,
        }),
      };
    });
  const definitions = async (kind: "skill" | "knowledge", id: string) => {
    const resources = (await options.resources()).filter((resource) =>
      kind === "skill"
        ? classifyHostCapabilityResource(resource)?.id === id
        : classifyHostContextResource(resource) === id,
    );
    const builtin = kind === "skill" ? BUILT_IN_SKILLS.find((entry) => entry.id === id) : undefined;
    if (
      builtin !== undefined &&
      !resources.some((resource) => canonicalPragmaResourceRef(resource) === builtin.ref)
    )
      resources.push(builtin.resource);
    resources.sort((a, b) => compare(canonicalPragmaResourceRef(a), canonicalPragmaResourceRef(b)));
    return {
      dslRefs: resources.map(canonicalPragmaResourceRef),
      source: resources.map((resource) => stringify(resource)).join("---\n"),
    };
  };

  const execute = async (request: ManagedResourceQuery): Promise<ManagedResourceQueryResult> => {
    switch (request.command) {
      case "skill.list": {
        const input = MANAGED_RESOURCE_QUERY_SCHEMAS[request.command].input.parse(request.input);
        const stored = await options.capabilities.list({ failOnUnreadable: true });
        const all = new Map(
          stored
            .filter((entry) => entry.definition.kind === "skill")
            .map((entry) => [entry.manifest.id, entry]),
        );
        for (const builtin of BUILT_IN_SKILLS)
          all.set(builtin.id, builtInSkillCapability(builtin.id)!);
        const items = [...all.values()]
          .map((entry) => {
            if (entry.definition.kind !== "skill")
              throw managementCommandError("INTERNAL_ERROR", "Unexpected capability type.");
            return ManagedSkillSummarySchema.parse({
              capabilityId: entry.manifest.id,
              name: entry.definition.name,
              description: entry.definition.description,
              managedBy: entry.managedBy ?? "user",
              status: entry.health.status,
              latestRevision: entry.manifest.latestRevision,
              activeRevision: entry.manifest.activeRevision ?? null,
              revision: entry.manifest.latestRevision,
              contentHash: entry.definition.contentHash,
            });
          })
          .filter(
            (entry) =>
              matches(input.query, [entry.capabilityId, entry.name, entry.description]) &&
              (input.status === undefined || entry.status === input.status) &&
              (input.managedBy === undefined || entry.managedBy === input.managedBy),
          )
          .sort((a, b) => compare(a.name, b.name) || compare(a.capabilityId, b.capabilityId));
        return page(request.command, input, items);
      }
      case "skill.get": {
        const input = MANAGED_RESOURCE_QUERY_SCHEMAS[request.command].input.parse(request.input);
        const target = await skill(input);
        const base = {
          schemaVersion: "pragma.managed-skill/v1" as const,
          ...target.summary,
          view: input.view,
        };
        if (input.view === "summary") return base;
        if (input.view === "definition") {
          const definition = await definitions("skill", input.capabilityId);
          return contentResult(
            request.command,
            { ...input, ...target.identity },
            definition.source,
            (data, continuation) => ({
              ...base,
              dslRefs: definition.dslRefs,
              data,
              ...continuation,
            }),
          );
        }
        const file = await options.capabilities.getSkillFile({
          id: input.capabilityId,
          revision: target.identity.revision,
          path: "SKILL.md",
        });
        return contentResult(
          request.command,
          { ...input, ...target.identity },
          file.content,
          (data, continuation) => ({
            ...base,
            path: "SKILL.md",
            sizeBytes: file.size,
            data,
            ...continuation,
          }),
        );
      }
      case "skill.files.list": {
        const input = MANAGED_RESOURCE_QUERY_SCHEMAS[request.command].input.parse(request.input);
        const target = await skill(input);
        const items = (
          await options.capabilities.listSkillFiles({
            id: input.capabilityId,
            revision: target.identity.revision,
          })
        )
          .map((entry) => ({
            path: entry.path,
            size: entry.size,
            ...(entry.kind === undefined ? {} : { isDirectory: entry.kind === "directory" }),
          }))
          .filter((entry) => matches(input.query, [entry.path]))
          .sort((a, b) => compare(a.path, b.path));
        return page(request.command, { ...input, ...target.identity }, items, target.identity);
      }
      case "skill.files.read": {
        const input = MANAGED_RESOURCE_QUERY_SCHEMAS[request.command].input.parse(request.input);
        const target = await skill(input);
        const files = await options.capabilities.listSkillFiles({
          id: input.capabilityId,
          revision: target.identity.revision,
        });
        if (!files.some((entry) => entry.path === input.path && entry.kind !== "directory"))
          throw managementCommandError(
            "NOT_FOUND",
            "The file does not exist in this formal Skill package.",
          );
        const file = await options.capabilities.getSkillFile({
          id: input.capabilityId,
          revision: target.identity.revision,
          path: input.path,
        });
        return contentResult(
          request.command,
          { ...input, ...target.identity },
          file.content,
          (data, continuation) => ({
            schemaVersion: "pragma.managed-skill-file/v1",
            ...target.identity,
            path: input.path,
            sizeBytes: file.size,
            data,
            ...continuation,
          }),
        );
      }
      case "knowledge-store.get": {
        const input = MANAGED_RESOURCE_QUERY_SCHEMAS[request.command].input.parse(request.input);
        const target = await knowledge(input);
        const base = {
          schemaVersion: "pragma.managed-knowledge-store/v1" as const,
          ...target.summary,
          view: input.view,
        };
        if (input.view === "summary") return base;
        const definition = await definitions("knowledge", input.storeId);
        return contentResult(
          request.command,
          { ...input, ...target.identity },
          definition.source,
          (data, continuation) => ({ ...base, dslRefs: definition.dslRefs, data, ...continuation }),
        );
      }
      case "knowledge-store.documents.list": {
        const input = MANAGED_RESOURCE_QUERY_SCHEMAS[request.command].input.parse(request.input);
        const target = await knowledge(input);
        const items = target.snapshot.files
          .filter((file) => matches(input.query, [file.id, file.metadata.description ?? ""]))
          .map((file) => ({
            documentId: file.id,
            description: file.metadata.description ?? "",
            sizeChars: file.content.length,
          }))
          .sort((a, b) => compare(a.documentId, b.documentId));
        return page(request.command, { ...input, ...target.identity }, items, target.identity);
      }
      case "knowledge-store.documents.search": {
        const input = MANAGED_RESOURCE_QUERY_SCHEMAS[request.command].input.parse(request.input);
        const target = await knowledge(input);
        const query = input.query.toLowerCase();
        const files = [...target.snapshot.files].sort((a, b) => compare(a.id, b.id));
        function* items() {
          for (const file of files) {
            if (input.scope !== "content" && file.id.toLowerCase().includes(query))
              yield {
                documentId: file.id,
                matchType: "path" as const,
                snippet: snippet(file.id, query),
              };
            if (input.scope === "path") continue;
            let start = 0;
            let lineNumber = 1;
            for (;;) {
              const end = file.content.indexOf("\n", start);
              const line = file.content.slice(start, end === -1 ? undefined : end);
              if (line.toLowerCase().includes(query))
                yield {
                  documentId: file.id,
                  matchType: "content" as const,
                  line: lineNumber,
                  snippet: snippet(line, query),
                };
              if (end === -1) break;
              start = end + 1;
              lineNumber++;
            }
          }
        }
        return page(request.command, { ...input, ...target.identity }, items, target.identity);
      }
      case "knowledge-store.documents.read": {
        const input = MANAGED_RESOURCE_QUERY_SCHEMAS[request.command].input.parse(request.input);
        const target = await knowledge(input);
        const file = target.snapshot.files.find((entry) => entry.id === input.documentId);
        if (file === undefined)
          throw managementCommandError(
            "NOT_FOUND",
            "The document does not exist in this formal snapshot.",
          );
        return contentResult(
          request.command,
          { ...input, ...target.identity },
          file.content,
          (data, continuation) => ({
            schemaVersion: "pragma.managed-knowledge-document/v1",
            ...target.identity,
            documentId: file.id,
            metadata: compactInput(file.metadata),
            data,
            ...continuation,
          }),
        );
      }
    }
  };
  return {
    async execute(request) {
      const input = MANAGED_RESOURCE_QUERY_SCHEMAS[request.command].input.safeParse(request.input);
      if (!input.success)
        throw managementCommandError("INVALID_ARGUMENT", "Invalid resource query.", {
          issues: input.error.issues,
        });
      try {
        const result = await execute(request);
        const output = MANAGED_RESOURCE_QUERY_SCHEMAS[request.command].output.safeParse(result);
        if (!output.success)
          throw managementCommandError(
            "INTERNAL_ERROR",
            "The Host returned an invalid resource query result.",
          );
        return output.data;
      } catch (error) {
        const known = IntegrationErrorSchema.safeParse(error);
        if (known.success) {
          if (known.data.code === "CURSOR_EXPIRED") {
            const recovery =
              "capabilityId" in request.input
                ? { command: "skill.get", input: { capabilityId: request.input.capabilityId } }
                : "storeId" in request.input
                  ? { command: "knowledge-store.get", input: { storeId: request.input.storeId } }
                  : { command: request.command, input: {} };
            throw managementCommandError("CURSOR_EXPIRED", known.data.message, {
              recovery: { ...recovery, requestIdPolicy: "new" },
            });
          }
          throw error;
        }
        if (error instanceof z.ZodError)
          throw managementCommandError("STORAGE_CORRUPTED", "Invalid stored resource data.", {
            issues: error.issues,
          });
        if (error instanceof CapabilityStoreError || error instanceof ContextStoreStoreError) {
          const code =
            error.code === "capability_not_found" ||
            error.code === "store_not_found" ||
            error.code === "content_not_found"
              ? "NOT_FOUND"
              : error.code === "config_invalid"
                ? "STORAGE_CORRUPTED"
                : error.code === "invalid_entry"
                  ? "INVALID_ARGUMENT"
                  : "DEPENDENCY_UNAVAILABLE";
          throw managementCommandError(code, error.message);
        }
        if (error instanceof Error && error.name === "PragmaManagementCursorError") {
          throw managementCommandError(
            error.message === "cursor_expired" ? "CURSOR_EXPIRED" : "CURSOR_INVALID",
            "Restart this listing without cursor.",
            {
              recovery: {
                command: request.command,
                input: compactInput({ ...request.input, cursor: undefined }),
                requestIdPolicy: "new",
              },
            },
          );
        }
        throw error;
      }
    },
  };
}

function page<T>(
  command: ManagedResourceCommand,
  input: Input & { limit: number; cursor?: string | undefined },
  items: T[] | (() => Iterable<T>),
  identity: Input = {},
): ManagedResourceQueryResult {
  const { cursor, limit: requestedLimit, ...rest } = input;
  const filters = Object.fromEntries(Object.entries(rest).sort(([a], [b]) => compare(a, b)));
  let limit = requestedLimit;
  for (;;) {
    const result = paginateManagementItems({
      items: typeof items === "function" ? items() : items,
      scope: command,
      // Search streams are immutable within their pinned snapshot; do not materialize all hits.
      fingerprintValue: typeof items === "function" ? identity : items,
      filters,
      cursor,
      limit,
    });
    const value = {
      schemaVersion: "pragma.managed-resource-page/v1",
      ...identity,
      ...result,
      ...(result.nextCursor === undefined
        ? {}
        : {
            continuation: { command, input: compactInput({ ...input, cursor: result.nextCursor }) },
          }),
    };
    if (bytes(value) <= MAX_QUERY_BYTES)
      return MANAGED_RESOURCE_QUERY_SCHEMAS[command].output.parse(value);
    if (limit === 1)
      throw managementCommandError(
        "INVALID_ARGUMENT",
        "One result exceeds the query output budget. Use a narrower query.",
      );
    limit = Math.max(1, Math.floor(limit / 2));
  }
}

function contentResult(
  command: ManagedResourceCommand,
  input: Input & { offset: number; limitChars: number },
  source: string | null,
  build: (
    data: Content,
    continuation: { continuation?: ManagedResourceContinuation },
  ) => ManagedResourceQueryResult,
): ManagedResourceQueryResult {
  if (source === null && input["expectedSha256"] !== undefined)
    throw managementCommandError(
      "CURSOR_EXPIRED",
      "The previously readable text is no longer available. Discover the resource again.",
    );
  if (source === null)
    return build(
      {
        content: null,
        readable: false,
        unavailableReason: "binary_or_unsupported_encoding",
        offset: 0,
        totalChars: 0,
        complete: true,
      },
      {},
    );
  const offset = input.offset;
  if (
    offset > source.length ||
    (offset > 0 &&
      isLowSurrogate(source.charCodeAt(offset)) &&
      isHighSurrogate(source.charCodeAt(offset - 1)))
  )
    throw managementCommandError(
      "INVALID_ARGUMENT",
      "Invalid content offset. Copy the returned continuation input.",
    );
  let count = input.limitChars;
  const sha256 = createHash("sha256").update(source).digest("hex");
  assertHash(
    typeof input["expectedSha256"] === "string" ? input["expectedSha256"] : undefined,
    sha256,
  );
  for (;;) {
    let end = Math.min(source.length, offset + count);
    if (
      end < source.length &&
      isHighSurrogate(source.charCodeAt(end - 1)) &&
      isLowSurrogate(source.charCodeAt(end))
    )
      end--;
    // A range of one UTF-16 unit still makes progress across a complete surrogate pair.
    if (end === offset && end < source.length) end = Math.min(source.length, offset + 2);
    const complete = end === source.length;
    const result = build(
      {
        content: source.slice(offset, end),
        readable: true,
        offset,
        totalChars: source.length,
        sha256,
        complete,
      },
      complete
        ? {}
        : {
            continuation: {
              command,
              input: compactInput({ ...input, expectedSha256: sha256, offset: end }),
            },
          },
    );
    if (bytes(result) <= MAX_QUERY_BYTES) return result;
    if (count === 1)
      throw managementCommandError(
        "INVALID_ARGUMENT",
        "Resource metadata exceeds the query output budget.",
      );
    count = Math.max(1, Math.floor(count / 2));
  }
}

function assertHash(expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected !== actual)
    throw managementCommandError(
      "CURSOR_EXPIRED",
      "The requested content identity changed. Discover the resource again with a new request ID.",
    );
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function compactInput(value: Input): z.infer<typeof JsonObjectSchema> {
  return JsonObjectSchema.parse(
    Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)),
  );
}
function matches(query: string | undefined, values: string[]): boolean {
  return (
    query === undefined || values.some((value) => value.toLowerCase().includes(query.toLowerCase()))
  );
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
function snippet(source: string, query: string): string {
  const match = source.toLowerCase().indexOf(query);
  let originalOffset = 0;
  let foldedOffset = 0;
  // Lowercasing can expand a code point (İ → i + combining dot); slice by the original offset.
  for (const character of source) {
    const nextFoldedOffset = foldedOffset + character.toLowerCase().length;
    if (nextFoldedOffset > match) break;
    originalOffset += character.length;
    foldedOffset = nextFoldedOffset;
  }
  let start = Math.max(0, originalOffset - 100);
  if (isLowSurrogate(source.charCodeAt(start))) start++;
  let end = Math.min(source.length, start + 400);
  if (isHighSurrogate(source.charCodeAt(end - 1))) end--;
  return source.slice(start, end);
}
