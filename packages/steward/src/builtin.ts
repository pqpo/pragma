import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  Expert,
  ExpertAgentManagedTool,
  ExpertAgentToolCallResult,
  RuntimeResolver,
  RuntimeModelSelection,
} from "@pragma/core";
import {
  loadPragmaProject,
  formatPragmaYaml,
  parsePragmaYaml,
  type CompiledResource,
  type PragmaCompileOptions,
  type PragmaAdapterHost,
  type PragmaBindingRecord,
} from "@pragma/interpreter";
import {
  PragmaBundleSchema,
  PragmaExpertResourceSchema,
  type PragmaExpertResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";

import { BUILT_IN_STEWARD_FILES } from "./builtin.generated.ts";

export const BUILT_IN_STEWARD_REF = "expert:steward@1.0.0" as const;

export function builtInStewardResource(): PragmaExpertResource {
  return PragmaExpertResourceSchema.parse(
    parsePragmaYaml(BUILT_IN_STEWARD_FILES["experts/steward@1.0.0.pragma.yaml"]!),
  );
}

export function builtInStewardFingerprint(
  expertResource?: PragmaExpertResource,
  additionalResources: readonly PragmaResource[] = [],
): string {
  const hash = createHash("sha256");
  for (const [path, source] of Object.entries(BUILT_IN_STEWARD_FILES).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(path);
    hash.update("\0");
    hash.update(customizedBuiltInSource(path, source, expertResource, additionalResources));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function materializeBuiltInSteward(
  root: string,
  expertResource?: PragmaExpertResource,
  additionalResources: readonly PragmaResource[] = [],
): Promise<string> {
  const targetRoot = join(root, builtInStewardFingerprint(expertResource, additionalResources));
  for (const [relativePath, source] of Object.entries(BUILT_IN_STEWARD_FILES)) {
    const target = join(targetRoot, relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(
      target,
      customizedBuiltInSource(relativePath, source, expertResource, additionalResources),
      { mode: 0o600 },
    );
  }
  return join(targetRoot, "pragma.yaml");
}

export async function compileBuiltInSteward(options: {
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
  readonly tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[];
}): Promise<CompiledResource<Expert>> {
  const entry = await materializeBuiltInSteward(
    options.definitionStateRoot,
    options.expertResource,
    options.additionalResources,
  );
  const project = await loadPragmaProject(entry, { rootDir: dirname(entry) });
  return await project.compile<Expert>(BUILT_IN_STEWARD_REF, {
    workspace: options.workspace,
    pragmaHome: options.pragmaHome,
    environmentId: "desktop-system-expert",
    runtimes: options.runtimes,
    ...(options.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: options.defaultModelSelection }),
    ...(options.rootExecutionOverride === undefined
      ? {}
      : { rootExecutionOverride: options.rootExecutionOverride }),
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
    adapterHost: stewardAdapterHost(dirname(entry), options.tools, options.adapterHost),
  });
}

function stewardAdapterHost(
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
    environmentId: "desktop-system-expert",
    projectRoot,
    async resolveBinding(ref): Promise<PragmaBindingRecord | undefined> {
      const builtIn =
        ref === "binding:pragma.steward-host"
          ? { ref, revision: "1", fingerprint, value: { contribution: { tools } } }
          : undefined;
      return builtIn ?? (await external?.resolveBinding(ref));
    },
    async resolveArtifact(source) {
      if (external !== undefined) return await external.resolveArtifact(source);
      throw new Error(`Unexpected external Steward artifact: ${JSON.stringify(source)}`);
    },
    async resolveSecret(ref) {
      return await external?.resolveSecret(ref);
    },
  };
}

function customizedBuiltInSource(
  path: string,
  source: string,
  expertResource: PragmaExpertResource | undefined,
  additionalResources: readonly PragmaResource[],
): string {
  if (path === "experts/steward@1.0.0.pragma.yaml" && expertResource !== undefined) {
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
