import type { BigIntStats } from "node:fs";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { StaticContextStore, type ExpertAgentContextStore } from "@pragma/core";
import { FileSystemContextStore } from "@pragma/context-filesystem";
import { MemoryRecallScopeSchema } from "@pragma/memory";
import {
  MISSION_BOARD_GUIDE,
  MISSION_BOARD_GUIDE_ID,
  MISSION_BOARD_SHARED_NAMESPACE,
} from "@pragma/mission-board";
import { canonicalPragmaResourceRef, type PragmaResource } from "@pragma/interpreter/ast";

import {
  isUserFacingMissionOrigin,
  MissionContextStoreContentSchema,
  MissionContextStoreDescriptorSchema,
  MissionContextStoreEntrySchema,
  MissionContextStoreSearchMatchSchema,
  type GetMissionContextStore,
  type ListMissionContextStoreEntries,
  type Mission,
  type MissionContextStoreContent,
  type MissionContextStoreDescriptor,
  type MissionContextStoreEntry,
  type MissionContextStoreScope,
  type MissionContextStoreSearchMatch,
  type ReadMissionContextStoreEntry,
  type SearchMissionContextStore,
} from "../../../shared/contracts/index.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import type { DesktopMemoryPlane } from "../memory/desktop-memory-plane.ts";
import {
  defineTeamMemoryScopes,
  inspectTeamMemoryScopes,
} from "../memory/team-memory-scope-catalog.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { MissionRunner } from "./mission-runner.ts";
import type { MissionStore } from "./mission-store.ts";

const MEMORY_STORE_ID = "memory";
const MISSION_BOARD_STORE_ID = MISSION_BOARD_SHARED_NAMESPACE;
const MISSION_BOARD_SCOPE_ID = "mission-board:shared";
const MAX_IMAGE_PREVIEW_BYTES = 5_000_000;
const BOARD_ALL_FILE_PATTERNS = ["*", "**/*"] as const;
const BOARD_TEXT_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".tsv",
  ".log",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
] as const;
const BOARD_TEXT_FILE_PATTERNS = BOARD_TEXT_EXTENSIONS.flatMap((extension) => [
  `*${extension}`,
  `**/*${extension}`,
]);

type ScopeRole = MissionContextStoreScope["role"];

const SCOPE_ROLE_RANK: Readonly<Record<ScopeRole, number>> = {
  root: 0,
  coordinator: 1,
  "flow-step": 2,
  member: 3,
  delegated: 4,
  observed: 5,
};

interface ScopeCandidate {
  readonly expertId: string;
  readonly name: string;
  readonly role: ScopeRole;
}

export interface MissionContextStoreBrowserService {
  get(input: GetMissionContextStore): Promise<MissionContextStoreDescriptor>;
  list(input: ListMissionContextStoreEntries): Promise<readonly MissionContextStoreEntry[]>;
  read(input: ReadMissionContextStoreEntry): Promise<MissionContextStoreContent>;
  search(input: SearchMissionContextStore): Promise<readonly MissionContextStoreSearchMatch[]>;
}

export function createMissionContextStoreBrowserService(options: {
  readonly missions: MissionStore;
  readonly project: PragmaProjectStore;
  readonly systemExperts: DesktopSystemExpertRegistry;
  readonly memory: DesktopMemoryPlane;
  readonly runner: Pick<MissionRunner, "getWork">;
}): MissionContextStoreBrowserService {
  const resolveMemoryScopes = async (mission: Mission) => {
    const { candidates, participated } = await collectScopeCandidates(mission, options);
    const rootRef = missionRootRef(mission);
    const teamDefinition =
      rootRef.type === "pragma.expert-team"
        ? defineTeamMemoryScopes({
            teamId: rootRef.id,
            teamName: mission.executor.name,
            teamParticipation: "participated",
            experts: candidates.map((candidate) => ({
              ...candidate,
              role: teamExpertScopeRole(candidate.role),
              participation: participated.has(candidate.expertId) ? "participated" : "available",
            })),
            projectId: mission.project.id,
          })
        : undefined;
    return { candidates, participated, rootRef, teamDefinition };
  };

  const memoryCatalog = async (input: GetMissionContextStore) => {
    assertSupportedStore(input.storeId);
    const mission = await userMission(options.missions, input.missionId);
    const { candidates, participated, rootRef, teamDefinition } =
      await resolveMemoryScopes(mission);
    if (teamDefinition !== undefined) {
      const catalog = await inspectTeamMemoryScopes(teamDefinition, options.memory);
      return { mission, rootRef, scopes: catalog.scopes, defaultScopeId: catalog.defaultScopeId };
    }
    const scopes = await Promise.all(
      candidates.map(async (candidate) => ({
        id: `expert:${candidate.expertId}`,
        expertId: candidate.expertId,
        name: candidate.name,
        role: candidate.role,
        participation: participated.has(candidate.expertId) ? "participated" : "available",
        availability: await scopeAvailability(options.memory, {
          rootRef,
          expertId: candidate.expertId,
          projectId: mission.project.id,
        }),
      })),
    );
    const defaultScope =
      scopes.find((scope) => scope.role === "root" || scope.role === "coordinator") ?? scopes[0];
    if (defaultScope === undefined) throw codedError("context_store_scope_unavailable");
    return { mission, rootRef, scopes, defaultScopeId: defaultScope.id };
  };

  const openMemory = async (
    input:
      ListMissionContextStoreEntries | ReadMissionContextStoreEntry | SearchMissionContextStore,
  ): Promise<ExpertAgentContextStore> => {
    if (input.storeId !== MEMORY_STORE_ID) throw codedError("context_store_not_found");
    const mission = await userMission(options.missions, input.missionId);
    const { candidates, rootRef, teamDefinition } = await resolveMemoryScopes(mission);
    if (teamDefinition !== undefined) {
      const view = teamDefinition.views.get(input.scopeId);
      if (view === undefined) throw codedError("context_store_scope_not_found");
      return await options.memory.createContextStoreView(view);
    }
    const scope = candidates.find((candidate) => `expert:${candidate.expertId}` === input.scopeId);
    if (scope === undefined) throw codedError("context_store_scope_not_found");
    return await options.memory.createContextStoreView({
      rootRef,
      expertRef: { type: "pragma.expert", id: scope.expertId },
      projectId: mission.project.id,
    });
  };

  return {
    async get(input) {
      assertSupportedStore(input.storeId);
      if (input.storeId === MISSION_BOARD_STORE_ID) {
        const mission = await userMission(options.missions, input.missionId);
        const rootRef = missionRootRef(mission);
        return MissionContextStoreDescriptorSchema.parse({
          schemaVersion: "pragma.desktop-mission-context-store/v2",
          missionId: mission.id,
          storeId: MISSION_BOARD_STORE_ID,
          namespace: MISSION_BOARD_SHARED_NAMESPACE,
          name: "Mission Board",
          readOnly: true,
          searchable: true,
          root: { ...rootRef, name: mission.title },
          defaultScopeId: MISSION_BOARD_SCOPE_ID,
          scopes: [
            {
              id: MISSION_BOARD_SCOPE_ID,
              expertId: rootRef.id,
              name: mission.title,
              role: "root",
              participation: "participated",
              availability: "available",
            },
          ],
        });
      }

      const resolved = await memoryCatalog(input);
      return MissionContextStoreDescriptorSchema.parse({
        schemaVersion: "pragma.desktop-mission-context-store/v2",
        missionId: resolved.mission.id,
        storeId: MEMORY_STORE_ID,
        namespace: "memory",
        name: "Memory ContextStore",
        readOnly: true,
        searchable: true,
        root: {
          ...resolved.rootRef,
          name: resolved.mission.executor.name,
        },
        defaultScopeId: resolved.defaultScopeId,
        scopes: resolved.scopes,
      });
    },

    async list(input) {
      if (input.storeId === MISSION_BOARD_STORE_ID) {
        assertMissionBoardScope(input.scopeId);
        const mission = await userMission(options.missions, input.missionId);
        const result = await (await openBoardStore(options.missions, mission)).listContext({});
        return MissionContextStoreEntrySchema.array().parse([
          boardGuideEntry(),
          ...unwrap(result)
            .filter((entry) => entry.id !== MISSION_BOARD_GUIDE_ID)
            .map(withBoardPreview),
        ]);
      }
      const result = await (await openMemory(input)).listContext({});
      return MissionContextStoreEntrySchema.array().parse(unwrap(result));
    },

    async read(input) {
      if (input.storeId === MISSION_BOARD_STORE_ID) {
        assertMissionBoardScope(input.scopeId);
        const mission = await userMission(options.missions, input.missionId);
        return MissionContextStoreContentSchema.parse(
          await readBoardEntry(options.missions, mission, input),
        );
      }
      const result = await (
        await openMemory(input)
      ).readContext({
        id: input.id,
        start: input.start,
        offset: input.maxBytes,
      });
      return MissionContextStoreContentSchema.parse(unwrap(result));
    },

    async search(input) {
      if (input.storeId === MISSION_BOARD_STORE_ID) {
        assertMissionBoardScope(input.scopeId);
        const mission = await userMission(options.missions, input.missionId);
        return MissionContextStoreSearchMatchSchema.array().parse(
          await searchBoard(options.missions, mission, input),
        );
      }
      const store = await openMemory(input);
      const searchInput = {
        query: input.query,
        maxResults: input.maxResults,
        contextLines: input.contextLines,
        caseSensitive: input.caseSensitive,
      };
      const [content, paths] = await Promise.all([
        store.searchContext(searchInput),
        store.searchContext({ ...searchInput, scope: "path" }),
      ]);
      const merged = [...unwrap(content), ...unwrap(paths)];
      const unique = [
        ...new Map(
          merged.map((match) => [
            `${match.id}\0${match.matchType ?? "content"}\0${match.lineNumber ?? 0}\0${match.line}`,
            match,
          ]),
        ).values(),
      ].slice(0, input.maxResults);
      return MissionContextStoreSearchMatchSchema.array().parse(unique);
    },
  };
}

async function openBoardStore(
  missions: MissionStore,
  mission: Mission,
): Promise<FileSystemContextStore> {
  await mkdir(boardRoot(missions, mission.id), { recursive: true });
  return new FileSystemContextStore({
    rootDir: boardRoot(missions, mission.id),
    include: BOARD_ALL_FILE_PATTERNS,
  });
}

function boardGuideStore(): StaticContextStore {
  return new StaticContextStore([
    {
      id: MISSION_BOARD_GUIDE_ID,
      content: MISSION_BOARD_GUIDE,
      metadata: {
        description: "Mission Board usage guide and whiteboard conventions.",
        trigger: "always_on",
        priority: "critical",
        trustLevel: "system",
        sensitivity: "internal",
      },
    },
  ]);
}

function boardGuideEntry(): MissionContextStoreEntry {
  return {
    id: MISSION_BOARD_GUIDE_ID,
    metadata: {
      description: "Mission Board usage guide and whiteboard conventions.",
      trigger: "always_on",
      priority: "critical",
      trustLevel: "system",
      sensitivity: "internal",
    },
    sizeBytes: Buffer.byteLength(MISSION_BOARD_GUIDE, "utf8"),
    mediaType: "text/markdown",
    previewKind: "text",
  };
}

function withBoardPreview(entry: MissionContextStoreEntry): MissionContextStoreEntry {
  return { ...entry, ...boardPreview(entry.id) };
}

function boardPreview(id: string): {
  readonly mediaType: string;
  readonly previewKind: "text" | "image" | "unsupported";
} {
  const extension = extname(id).toLowerCase();
  const textMediaTypes: Readonly<Record<string, string>> = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".log": "text/plain",
    ".xml": "application/xml",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".jsx": "text/javascript",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
  };
  const imageMediaTypes: Readonly<Record<string, string>> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
  };
  const textMediaType = textMediaTypes[extension];
  if (textMediaType !== undefined) return { mediaType: textMediaType, previewKind: "text" };
  const imageMediaType = imageMediaTypes[extension];
  if (imageMediaType !== undefined) return { mediaType: imageMediaType, previewKind: "image" };
  return { mediaType: "application/octet-stream", previewKind: "unsupported" };
}

async function readBoardEntry(
  missions: MissionStore,
  mission: Mission,
  input: ReadMissionContextStoreEntry,
): Promise<MissionContextStoreContent> {
  if (input.id === MISSION_BOARD_GUIDE_ID) {
    const result = await boardGuideStore().readContext({
      id: input.id,
      start: input.start,
      offset: input.maxBytes,
    });
    return { ...unwrap(result), ...boardPreview(input.id), contentEncoding: "utf8" };
  }

  const preview = boardPreview(input.id);
  if (preview.previewKind === "text") {
    const result = await (
      await openBoardStore(missions, mission)
    ).readContext({
      id: input.id,
      start: input.start,
      offset: input.maxBytes,
    });
    return { ...unwrap(result), ...preview, contentEncoding: "utf8" };
  }
  if (preview.previewKind === "unsupported") {
    const summary = await boardEntrySummary(missions, mission, input.id);
    return {
      ...summary,
      ...preview,
      content: "",
      contentEncoding: "utf8",
      contentRange: {
        requestedStartOffset: 0,
        startOffset: 0,
        endOffset: 0,
        nextStartOffset: 0,
        truncated: false,
        ...(summary.sizeBytes === undefined ? {} : { sizeBytes: summary.sizeBytes }),
      },
    };
  }
  if (input.start !== 0) throw codedError("invalid_input", "Image previews must start at byte 0.");
  // An image must cross IPC as one valid payload. maxBytes only bounds chunked text reads.
  const { filePath, fileStats } = await statBoardEntry(missions, mission, input.id);
  if (Number(fileStats.size) > MAX_IMAGE_PREVIEW_BYTES) {
    throw codedError("preview_too_large", "This image is too large to preview.");
  }
  const content = await readFile(filePath);
  if (content.byteLength > MAX_IMAGE_PREVIEW_BYTES) {
    throw codedError("preview_too_large", "This image is too large to preview.");
  }
  const sizeBytes = content.byteLength;
  const revision = `${fileStats.mtimeNs}:${fileStats.size}`;
  return {
    id: input.id,
    metadata: { trigger: "manual", priority: "normal" },
    revision,
    etag: revision,
    sizeBytes,
    ...preview,
    content: content.toString("base64"),
    contentEncoding: "base64",
    contentRange: {
      requestedStartOffset: 0,
      startOffset: 0,
      endOffset: sizeBytes,
      nextStartOffset: sizeBytes,
      truncated: false,
      sizeBytes,
      maxBytes: MAX_IMAGE_PREVIEW_BYTES,
    },
  };
}

async function boardEntrySummary(
  missions: MissionStore,
  mission: Mission,
  id: string,
): Promise<MissionContextStoreEntry> {
  const { fileStats } = await statBoardEntry(missions, mission, id);
  const revision = `${fileStats.mtimeNs}:${fileStats.size}`;
  return {
    id,
    metadata: { trigger: "manual", priority: "normal" },
    revision,
    etag: revision,
    sizeBytes: Number(fileStats.size),
  };
}

async function statBoardEntry(
  missions: MissionStore,
  mission: Mission,
  id: string,
): Promise<{
  readonly filePath: string;
  readonly fileStats: BigIntStats;
}> {
  try {
    const filePath = await resolveBoardEntryPath(boardRoot(missions, mission.id), id);
    const fileStats = await stat(filePath, { bigint: true });
    if (!fileStats.isFile()) throw codedError("context_not_found", `Context not found: ${id}`);
    return { filePath, fileStats };
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) {
      throw codedError("context_not_found", `Context not found: ${id}`);
    }
    throw cause;
  }
}

async function searchBoard(
  missions: MissionStore,
  mission: Mission,
  input: SearchMissionContextStore,
): Promise<readonly MissionContextStoreSearchMatch[]> {
  const rootDir = boardRoot(missions, mission.id);
  await mkdir(rootDir, { recursive: true });
  const textStore = new FileSystemContextStore({ rootDir, include: BOARD_TEXT_FILE_PATTERNS });
  const allFilesStore = new FileSystemContextStore({ rootDir, include: BOARD_ALL_FILE_PATTERNS });
  const searchInput = {
    query: input.query,
    maxResults: input.maxResults,
    contextLines: input.contextLines,
    caseSensitive: input.caseSensitive,
  };
  const [guide, content, paths] = await Promise.all([
    boardGuideStore().searchContext(searchInput),
    textStore.searchContext(searchInput),
    allFilesStore.searchContext({ ...searchInput, scope: "path" }),
  ]);
  return MissionContextStoreSearchMatchSchema.array().parse(
    [
      ...new Map(
        [...unwrap(guide), ...unwrap(content), ...unwrap(paths)].map((match) => [
          `${match.id}\0${match.matchType ?? "content"}\0${match.lineNumber ?? 0}\0${match.line}`,
          match,
        ]),
      ).values(),
    ].slice(0, input.maxResults),
  );
}

function boardRoot(missions: MissionStore, missionId: string): string {
  const missionRoot = missions.storagePath?.(missionId);
  if (missionRoot === undefined) throw codedError("context_store_unavailable");
  return join(missionRoot, "board", "shared");
}

async function resolveBoardEntryPath(rootDir: string, id: string): Promise<string> {
  if (
    id.trim() !== id ||
    id.length === 0 ||
    id.includes("\\") ||
    isAbsolute(id) ||
    id.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw codedError("invalid_input", `Invalid Mission Board item id: ${id}`);
  }
  const [canonicalRoot, canonicalFile] = await Promise.all([
    realpath(rootDir),
    realpath(resolve(rootDir, id)),
  ]);
  const nested = relative(canonicalRoot, canonicalFile);
  if (nested === "" || nested.startsWith("..") || nested.startsWith(sep)) {
    throw codedError("permission_denied", `Mission Board item is outside the shared board: ${id}`);
  }
  return canonicalFile;
}

async function collectScopeCandidates(
  mission: Mission,
  options: {
    readonly project: PragmaProjectStore;
    readonly systemExperts: DesktopSystemExpertRegistry;
    readonly runner: Pick<MissionRunner, "getWork">;
  },
): Promise<{
  readonly candidates: readonly ScopeCandidate[];
  readonly participated: ReadonlySet<string>;
}> {
  const project = await options.project.openRevision(mission.project.revision);
  const rootSystemResource = options.systemExperts.getResource(mission.executor.ref);
  const resources = [
    ...project.listResources(),
    ...(rootSystemResource === undefined ? [] : [rootSystemResource]),
    ...options.systemExperts.getAdditionalResources(mission.executor.ref),
  ];
  const byRef = new Map(
    resources.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
  );
  const scopes = new Map<string, ScopeCandidate>();
  const visited = new Set<string>();

  const addExpert = (
    resource: Extract<PragmaResource, { readonly kind: "Expert" }>,
    role: ScopeRole,
  ) => {
    const current = scopes.get(resource.metadata.id);
    if (current === undefined || roleRank(role) < roleRank(current.role)) {
      scopes.set(resource.metadata.id, {
        expertId: resource.metadata.id,
        name: resource.metadata.name,
        role,
      });
    }
  };
  const visit = (ref: string, role: ScopeRole): void => {
    const resource = byRef.get(ref);
    if (resource === undefined) return;
    if (resource.kind === "Expert") {
      addExpert(resource, role);
      if (visited.has(ref)) return;
      visited.add(ref);
      for (const tool of resource.spec.tools) {
        for (const target of [
          ...(tool.target === undefined ? [] : [tool.target]),
          ...(tool.targets ?? []),
        ]) {
          visit(target.ref, "delegated");
        }
      }
      return;
    }
    if (resource.kind === "ExpertTeam") {
      if (visited.has(ref)) return;
      visited.add(ref);
      visit(resource.spec.coordinator.ref, "coordinator");
      for (const member of resource.spec.members) visit(member.ref, "member");
      return;
    }
    if (resource.kind === "Flow") {
      if (visited.has(ref)) return;
      visited.add(ref);
      for (const step of Object.values(resource.spec.graph.steps)) {
        if (step.expert !== undefined) visit(step.expert.ref, "flow-step");
        if (step.team !== undefined) visit(step.team.ref, "flow-step");
        if (step.flow !== undefined) visit(step.flow.ref, "flow-step");
      }
    }
  };

  visit(
    mission.executor.ref,
    mission.executor.kind === "expert"
      ? "root"
      : mission.executor.kind === "team"
        ? "coordinator"
        : "flow-step",
  );

  const work = await options.runner.getWork(mission.id);
  const participated = new Set(
    (work?.records ?? []).flatMap((record) =>
      record.executorId === undefined ? [] : [record.executorId],
    ),
  );
  const names = new Map(
    resources.map((resource) => [resource.metadata.id, resource.metadata.name]),
  );
  for (const record of work?.records ?? []) {
    if (record.executorId === undefined || scopes.has(record.executorId)) continue;
    const valid = MemoryRecallScopeSchema.safeParse({
      rootRef: missionRootRef(mission),
      expertRef: { type: "pragma.expert", id: record.executorId },
    });
    if (!valid.success) continue;
    scopes.set(record.executorId, {
      expertId: record.executorId,
      name: names.get(record.executorId) ?? record.title ?? record.executorId,
      role: "observed",
    });
  }

  if (scopes.size === 0 && mission.executor.kind === "expert") {
    const expertId = mission.executor.ref.slice("expert:".length);
    scopes.set(expertId, { expertId, name: mission.executor.name, role: "root" });
  }
  return {
    candidates: [...scopes.values()].toSorted(
      (left, right) =>
        roleRank(left.role) - roleRank(right.role) || left.name.localeCompare(right.name),
    ),
    participated,
  };
}

function missionRootRef(mission: Mission) {
  const type =
    mission.executor.kind === "team"
      ? "pragma.expert-team"
      : mission.executor.kind === "flow"
        ? "pragma.flow"
        : "pragma.expert";
  const expectedPrefix = `${mission.executor.kind}:`;
  if (!mission.executor.ref.startsWith(expectedPrefix)) {
    throw codedError(
      "invalid_mission_executor_ref",
      `Mission executor kind ${mission.executor.kind} does not match ${mission.executor.ref}.`,
    );
  }
  return MemoryRecallScopeSchema.shape.rootRef.parse({
    type,
    id: mission.executor.ref.slice(expectedPrefix.length),
  });
}

async function scopeAvailability(
  memory: DesktopMemoryPlane,
  input: {
    readonly rootRef: ReturnType<typeof missionRootRef>;
    readonly expertId: string;
    readonly projectId: string;
  },
): Promise<MissionContextStoreScope["availability"]> {
  const view = {
    rootRef: input.rootRef,
    expertRef: { type: "pragma.expert", id: input.expertId },
    projectId: input.projectId,
  } as const;
  return await memory.getContextStoreViewStatus(view);
}

async function userMission(missions: MissionStore, missionId: string): Promise<Mission> {
  const mission = await missions.get(missionId);
  if (!isUserFacingMissionOrigin(mission.origin)) throw codedError("mission_not_found");
  return mission;
}

function assertSupportedStore(storeId: string): void {
  if (storeId !== MEMORY_STORE_ID && storeId !== MISSION_BOARD_STORE_ID) {
    throw codedError("context_store_not_found");
  }
}

function assertMissionBoardScope(scopeId: string): void {
  if (scopeId !== MISSION_BOARD_SCOPE_ID) throw codedError("context_store_scope_not_found");
}

function unwrap<T>(result: import("@pragma/core").ExpertAgentContextResult<T>): T {
  if (result.ok) return result.value;
  throw codedError(result.error.code, result.error.message);
}

function codedError(code: string, message = code): Error {
  const error = new Error(message);
  Object.assign(error, { code });
  return error;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function roleRank(role: ScopeRole): number {
  return SCOPE_ROLE_RANK[role];
}

function teamExpertScopeRole(role: ScopeRole): Exclude<ScopeRole, "root"> {
  if (role === "root") {
    throw codedError(
      "invalid_team_scope_role",
      "The root role is not valid for an Expert inside a Team Memory catalog.",
    );
  }
  return role;
}
