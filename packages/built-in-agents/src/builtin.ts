import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  Expert,
  ExpertAgentManagedTool,
  ExpertAgentToolCallResult,
  RuntimeResolver,
  RuntimeModelSelection,
} from "@pragma/core";
import { withFileLock } from "@pragma/core";
import {
  loadPragmaProject,
  formatPragmaYaml,
  parsePragmaYaml,
  type CompiledResource,
  type PragmaCompileOptions,
  type PragmaAdapterHost,
  type PragmaBindingRecord,
  type PragmaBlueprintCacheStore,
  type PragmaProject,
} from "@pragma/interpreter";
import {
  PragmaBindingRefSchema,
  PragmaBundleSchema,
  PragmaCapabilityRefSchema,
  PragmaExpertIdSchema,
  PragmaExpertRefSchema,
  PragmaExpertResourceSchema,
  PragmaSemanticResourceIdSchema,
  type PragmaExpertResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";

import { BUILT_IN_AGENT_FILES } from "./builtin.generated.ts";

export const BUILT_IN_PRAGMA_ID = PragmaExpertIdSchema.parse(
  "0000000000pragma",
) as "0000000000pragma";
export const MEMORY_CURATOR_ID = PragmaExpertIdSchema.parse(
  "0000000000mem0ry",
) as "0000000000mem0ry";
export const MEMORY_CURATOR_SKILL_DRAFT_CAPABILITY_ID = "0000000000skdrft" as const;
export const PRAGMA_MANAGEMENT_CAPABILITY_ID = PragmaSemanticResourceIdSchema.parse(
  "0000000000manage",
) as "0000000000manage";
export const PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID =
  "00000000-0000-4000-8000-000000000101" as const;
export const STORE_REVISION_EXPERT_ID = PragmaExpertIdSchema.parse(
  "0000000000st0rev",
) as "0000000000st0rev";
export const SKILL_REVISION_EXPERT_ID = PragmaExpertIdSchema.parse(
  "0000000000sk1rev",
) as "0000000000sk1rev";
export const SKILL_EVALUATION_EXPERT_ID = PragmaExpertIdSchema.parse(
  "0000000000sk1eva",
) as "0000000000sk1eva";
export const EVALUATION_JUDGE_EXPERT_ID = PragmaExpertIdSchema.parse(
  "00000000000j0dg3",
) as "00000000000j0dg3";
export const BUILT_IN_PRAGMA_REF = PragmaExpertRefSchema.parse(
  `expert:${BUILT_IN_PRAGMA_ID}`,
) as `expert:${typeof BUILT_IN_PRAGMA_ID}`;
export const MEMORY_CURATOR_REF = PragmaExpertRefSchema.parse(
  `expert:${MEMORY_CURATOR_ID}`,
) as `expert:${typeof MEMORY_CURATOR_ID}`;
export const MEMORY_CURATOR_SKILL_DRAFT_CAPABILITY_REF = PragmaCapabilityRefSchema.parse(
  `capability:${MEMORY_CURATOR_SKILL_DRAFT_CAPABILITY_ID}`,
) as `capability:${typeof MEMORY_CURATOR_SKILL_DRAFT_CAPABILITY_ID}`;
export const MEMORY_CURATOR_SKILL_DRAFT_BINDING_REF = PragmaBindingRefSchema.parse(
  "binding:pragma.memory-curator-skill-draft",
) as "binding:pragma.memory-curator-skill-draft";
export const PRAGMA_MANAGEMENT_CAPABILITY_REF = PragmaCapabilityRefSchema.parse(
  `capability:${PRAGMA_MANAGEMENT_CAPABILITY_ID}`,
) as `capability:${typeof PRAGMA_MANAGEMENT_CAPABILITY_ID}`;
export const PRAGMA_MANAGEMENT_BINDING_REF = PragmaBindingRefSchema.parse(
  "binding:pragma.management",
) as "binding:pragma.management";

export function pragmaManagementCapabilityResource(): PragmaResource {
  return parsePragmaYaml(
    BUILT_IN_AGENT_FILES["capabilities/0000000000manage.pragma.yaml"]!,
  ) as PragmaResource;
}
export const STORE_REVISION_EXPERT_REF = PragmaExpertRefSchema.parse(
  `expert:${STORE_REVISION_EXPERT_ID}`,
) as `expert:${typeof STORE_REVISION_EXPERT_ID}`;
export const SKILL_REVISION_EXPERT_REF = PragmaExpertRefSchema.parse(
  `expert:${SKILL_REVISION_EXPERT_ID}`,
) as `expert:${typeof SKILL_REVISION_EXPERT_ID}`;
export const SKILL_EVALUATION_EXPERT_REF = PragmaExpertRefSchema.parse(
  `expert:${SKILL_EVALUATION_EXPERT_ID}`,
) as `expert:${typeof SKILL_EVALUATION_EXPERT_ID}`;
export const EVALUATION_JUDGE_EXPERT_REF = PragmaExpertRefSchema.parse(
  `expert:${EVALUATION_JUDGE_EXPERT_ID}`,
) as `expert:${typeof EVALUATION_JUDGE_EXPERT_ID}`;

export const BUILT_IN_AGENT_REFS = [
  BUILT_IN_PRAGMA_REF,
  MEMORY_CURATOR_REF,
  STORE_REVISION_EXPERT_REF,
  SKILL_REVISION_EXPERT_REF,
  SKILL_EVALUATION_EXPERT_REF,
  EVALUATION_JUDGE_EXPERT_REF,
] as const;

export type BuiltInAgentRef = (typeof BUILT_IN_AGENT_REFS)[number];

const BUILT_IN_AGENT_PATHS: Readonly<Record<BuiltInAgentRef, string>> = {
  [BUILT_IN_PRAGMA_REF]: "experts/0000000000pragma.pragma.yaml",
  [MEMORY_CURATOR_REF]: "experts/0000000000mem0ry.pragma.yaml",
  [STORE_REVISION_EXPERT_REF]: "experts/0000000000st0rev.pragma.yaml",
  [SKILL_REVISION_EXPERT_REF]: "experts/0000000000sk1rev.pragma.yaml",
  [SKILL_EVALUATION_EXPERT_REF]: "experts/0000000000sk1eva.pragma.yaml",
  [EVALUATION_JUDGE_EXPERT_REF]: "experts/00000000000j0dg3.pragma.yaml",
};
const PRAGMA_SKILL_PREFIX = "skills/author-pragma-dsl/";
const BUILT_IN_AGENT_DEPENDENCY_PATHS: Readonly<Record<BuiltInAgentRef, readonly string[]>> = {
  [BUILT_IN_PRAGMA_REF]: [
    BUILT_IN_AGENT_PATHS[BUILT_IN_PRAGMA_REF],
    "capabilities/1h2j3k4m5n6p7q8r.pragma.yaml",
    "capabilities/2h3j4k5m6n7p8q9r.pragma.yaml",
    ...Object.keys(BUILT_IN_AGENT_FILES).filter((path) => path.startsWith(PRAGMA_SKILL_PREFIX)),
  ],
  [MEMORY_CURATOR_REF]: [
    BUILT_IN_AGENT_PATHS[MEMORY_CURATOR_REF],
    "capabilities/0000000000skdrft.pragma.yaml",
  ],
  [STORE_REVISION_EXPERT_REF]: [
    BUILT_IN_AGENT_PATHS[STORE_REVISION_EXPERT_REF],
    "capabilities/0000000000manage.pragma.yaml",
  ],
  [SKILL_REVISION_EXPERT_REF]: [BUILT_IN_AGENT_PATHS[SKILL_REVISION_EXPERT_REF]],
  [SKILL_EVALUATION_EXPERT_REF]: [BUILT_IN_AGENT_PATHS[SKILL_EVALUATION_EXPERT_REF]],
  [EVALUATION_JUDGE_EXPERT_REF]: [BUILT_IN_AGENT_PATHS[EVALUATION_JUDGE_EXPERT_REF]],
};
const builtInProjectCache = new Map<string, Promise<PragmaProject>>();

export function builtInAgentResource(ref: BuiltInAgentRef): PragmaExpertResource {
  return PragmaExpertResourceSchema.parse(
    parsePragmaYaml(BUILT_IN_AGENT_FILES[BUILT_IN_AGENT_PATHS[ref]]!),
  );
}

export function builtInAgentFingerprint(
  ref: BuiltInAgentRef,
  expertResource?: PragmaExpertResource,
  additionalResources: readonly PragmaResource[] = [],
): string {
  const hash = createHash("sha256");
  hash.update(ref);
  hash.update("\0");
  for (const [path, source] of builtInAgentSourceEntries(
    ref,
    expertResource,
    additionalResources,
  )) {
    hash.update(path);
    hash.update("\0");
    hash.update(source);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function materializeBuiltInAgentBundle(
  root: string,
  expertResource?: PragmaExpertResource,
  additionalResources: readonly PragmaResource[] = [],
): Promise<string> {
  const fingerprint = builtInBundleFingerprint(expertResource, additionalResources);
  const targetRoot = join(root, fingerprint);
  const complete = join(targetRoot, ".complete");
  await withFileLock(`${targetRoot}.lock`, async () => {
    if (await exists(complete)) return;
    for (const [relativePath, source] of Object.entries(BUILT_IN_AGENT_FILES)) {
      const target = join(targetRoot, relativePath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(
        target,
        customizedBuiltInSource(relativePath, source, expertResource, additionalResources),
        { mode: 0o600 },
      );
    }
    await writeFile(complete, `${fingerprint}\n`, { mode: 0o600 });
  });
  return join(targetRoot, "pragma.yaml");
}

export async function compileBuiltInAgent(options: {
  readonly ref: BuiltInAgentRef;
  readonly environmentId: string;
  readonly definitionStateRoot: string;
  readonly workspace: string;
  readonly pragmaHome: string;
  readonly runtimes: RuntimeResolver;
  readonly defaultModelSelection?: RuntimeModelSelection | undefined;
  readonly expertResource?: PragmaExpertResource | undefined;
  readonly additionalResources?: readonly PragmaResource[] | undefined;
  readonly rootExecutionOverride?: PragmaCompileOptions["rootExecutionOverride"];
  readonly plugins?: PragmaCompileOptions["plugins"];
  readonly adapterHost?: PragmaCompileOptions["adapterHost"];
  readonly tools?: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined;
  readonly loggerProvider?: PragmaCompileOptions["loggerProvider"];
  readonly blueprintCache?: PragmaBlueprintCacheStore | undefined;
}): Promise<CompiledResource<Expert>> {
  const entry = await materializeBuiltInAgent(
    options.definitionStateRoot,
    options.ref,
    options.expertResource,
    options.additionalResources,
  );
  let projectPromise = builtInProjectCache.get(entry);
  if (projectPromise === undefined) {
    projectPromise = loadPragmaProject(entry, {
      rootDir: dirname(entry),
      sourceIdentity: builtInAgentFingerprint(
        options.ref,
        options.expertResource,
        options.additionalResources,
      ),
      blueprintCache: options.blueprintCache,
    });
    builtInProjectCache.set(entry, projectPromise);
    void projectPromise.catch(() => {
      if (builtInProjectCache.get(entry) === projectPromise) builtInProjectCache.delete(entry);
    });
    while (builtInProjectCache.size > 16) {
      const oldest = builtInProjectCache.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === entry) break;
      builtInProjectCache.delete(oldest);
    }
  }
  const project = await projectPromise;
  return await project.compile<Expert>(options.ref, {
    workspace: options.workspace,
    pragmaHome: options.pragmaHome,
    environmentId: options.environmentId,
    runtimes: options.runtimes,
    loggerProvider: options.loggerProvider,
    ...(options.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: options.defaultModelSelection }),
    ...(options.rootExecutionOverride === undefined
      ? {}
      : { rootExecutionOverride: options.rootExecutionOverride }),
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
    adapterHost: builtInAgentAdapterHost(
      options.environmentId,
      dirname(entry),
      options.tools ?? [],
      options.adapterHost,
    ),
  });
}

async function materializeBuiltInAgent(
  root: string,
  ref: BuiltInAgentRef,
  expertResource?: PragmaExpertResource,
  additionalResources: readonly PragmaResource[] = [],
): Promise<string> {
  const fingerprint = builtInAgentFingerprint(ref, expertResource, additionalResources);
  const targetRoot = join(root, fingerprint);
  const complete = join(targetRoot, ".complete");
  await withFileLock(`${targetRoot}.lock`, async () => {
    if (await exists(complete)) return;
    for (const [relativePath, source] of builtInAgentSourceEntries(
      ref,
      expertResource,
      additionalResources,
    )) {
      const target = join(targetRoot, relativePath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, source, { mode: 0o600 });
    }
    await writeFile(complete, `${fingerprint}\n`, { mode: 0o600 });
  });
  return join(targetRoot, "pragma.yaml");
}

function builtInBundleFingerprint(
  expertResource?: PragmaExpertResource,
  additionalResources: readonly PragmaResource[] = [],
): string {
  const hash = createHash("sha256");
  for (const [path, source] of Object.entries(BUILT_IN_AGENT_FILES).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(path);
    hash.update("\0");
    hash.update(customizedBuiltInSource(path, source, expertResource, additionalResources));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function builtInAgentAdapterHost(
  environmentId: string,
  projectRoot: string,
  tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[],
  external?: PragmaCompileOptions["adapterHost"],
): PragmaAdapterHost {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        tools.map((tool) => ({
          name: tool.name,
          inputSchema: tool.inputSchema,
          approval: tool.approval?.mode,
        })),
      ),
    )
    .digest("hex");
  return {
    environmentId,
    projectRoot,
    async resolveBinding(ref): Promise<PragmaBindingRecord | undefined> {
      const builtIn =
        ref === "binding:pragma.default-agent-host"
          ? { ref, revision: "1", fingerprint, value: { contribution: { tools } } }
          : undefined;
      return builtIn ?? (await external?.resolveBinding(ref));
    },
    async resolveArtifact(source) {
      if (external !== undefined) return await external.resolveArtifact(source);
      throw new Error(`Unexpected external Pragma artifact: ${JSON.stringify(source)}`);
    },
    async resolveSecret(ref) {
      return await external?.resolveSecret(ref);
    },
  };
}

function builtInAgentSourceEntries(
  ref: BuiltInAgentRef,
  expertResource: PragmaExpertResource | undefined,
  additionalResources: readonly PragmaResource[],
): readonly (readonly [string, string])[] {
  const dependencyPaths = new Set(BUILT_IN_AGENT_DEPENDENCY_PATHS[ref]);
  const root = PragmaBundleSchema.parse(parsePragmaYaml(BUILT_IN_AGENT_FILES["pragma.yaml"]!));
  const rootSource = formatPragmaYaml({
    ...root,
    imports: root.imports.filter((entry) => dependencyPaths.has(entry.replace(/^\.\//u, ""))),
    resources: [...root.resources, ...additionalResources],
  });
  const entries: (readonly [string, string])[] = [["pragma.yaml", rootSource]];
  for (const path of [...dependencyPaths].toSorted((left, right) => left.localeCompare(right))) {
    const source = BUILT_IN_AGENT_FILES[path];
    if (source === undefined) throw new Error(`Missing built-in Agent dependency: ${path}`);
    entries.push([
      path,
      customizedBuiltInSource(path, source, expertResource, additionalResources),
    ]);
  }
  return entries;
}

function customizedBuiltInSource(
  path: string,
  source: string,
  expertResource: PragmaExpertResource | undefined,
  additionalResources: readonly PragmaResource[],
): string {
  if (path === "experts/0000000000pragma.pragma.yaml" && expertResource !== undefined) {
    return formatPragmaYaml(PragmaExpertResourceSchema.parse(expertResource));
  }
  if (path === "pragma.yaml" && additionalResources.length > 0) {
    const bundle = PragmaBundleSchema.parse(parsePragmaYaml(source));
    return formatPragmaYaml({
      ...bundle,
      resources: [...bundle.resources, ...additionalResources],
    });
  }
  return source;
}
