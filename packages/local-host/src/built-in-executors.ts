import { join } from "node:path";

import {
  PragmaPaths,
  type Expert,
  type PragmaLoggerProvider,
  type RuntimeResolver,
} from "@pragma/core";
import {
  BUILT_IN_AGENT_REFS,
  builtInAgentResource,
  compileBuiltInAgent,
  type BuiltInAgentRef,
} from "@pragma/built-in-agents";
import type { PragmaAdapterHost, PragmaCompileOptions } from "@pragma/interpreter";
import {
  ExecutorDescriptorSchema,
  type ExecutorDescriptor,
  type ExecutorReference,
  type WorkspaceSelection,
} from "@pragma/shared/integration";

import type { LocalHostCoreExecutorDefinition } from "./core-run.ts";

type LocalHostBuiltInExecutorDefinition = Omit<LocalHostCoreExecutorDefinition, "definition"> & {
  readonly definition: Expert;
};

/**
 * Host-neutral catalog for the statically shipped Expert resources.
 * Project-backed Team/Flow resources are supplied by the Host catalog port;
 * this resolver deliberately does not guess or synthesize those resources.
 */
export function createLocalHostBuiltInExecutorResolver(options: {
  readonly pragmaHome?: string | undefined;
  readonly runtimes: RuntimeResolver;
  readonly environmentId?: string | undefined;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly adapterHost?: PragmaAdapterHost | undefined;
}): (input: {
  readonly ref: ExecutorReference;
  readonly workspace: WorkspaceSelection;
}) => Promise<LocalHostCoreExecutorDefinition | undefined> {
  const paths = new PragmaPaths({ pragmaHome: options.pragmaHome });
  const definitions = new Map<string, LocalHostBuiltInExecutorDefinition>();
  const refs = new Set<string>(BUILT_IN_AGENT_REFS);

  const resolveDefinition = async (
    builtInRef: BuiltInAgentRef,
    workspace: WorkspaceSelection,
    ancestors: ReadonlySet<string> = new Set(),
  ): Promise<LocalHostBuiltInExecutorDefinition> => {
    if (ancestors.has(builtInRef)) {
      throw new Error(`Cyclic built-in Expert dependency: ${builtInRef}`);
    }
    const key = `${builtInRef}\u0000${workspace.canonicalPath}`;
    const existing = definitions.get(key);
    if (existing !== undefined) return existing;
    const nextAncestors = new Set(ancestors).add(builtInRef);
    const created = await createDefinition({
      builtInRef,
      workspace,
      pragmaHome: paths.root,
      runtimes: options.runtimes,
      environmentId: options.environmentId ?? "cli",
      loggerProvider: options.loggerProvider,
      definitionStateRoot: join(paths.root, "cache", "built-in-agents", "definitions"),
      adapterHost: options.adapterHost,
      resolveExternalInvocable: async (ref) => {
        if (!refs.has(ref)) return undefined;
        const dependencyRef = ref as BuiltInAgentRef;
        const dependency = await resolveDefinition(dependencyRef, workspace, nextAncestors);
        return { resource: builtInAgentResource(dependencyRef), value: dependency.definition };
      },
    });
    definitions.set(key, created);
    return created;
  };

  return async ({ ref, workspace }) => {
    if (ref.kind !== "expert" || !refs.has(`expert:${ref.id}`)) return undefined;
    return await resolveDefinition(`expert:${ref.id}` as BuiltInAgentRef, workspace);
  };
}

export async function listLocalHostBuiltInExecutorDescriptors(options: {
  readonly runtimes: RuntimeResolver;
}): Promise<readonly ExecutorDescriptor[]> {
  const descriptors = await Promise.all(
    BUILT_IN_AGENT_REFS.map(async (ref) => await createBuiltInDescriptor(ref, options.runtimes)),
  );
  return descriptors;
}

async function createDefinition(options: {
  readonly builtInRef: BuiltInAgentRef;
  readonly workspace: WorkspaceSelection;
  readonly pragmaHome: string;
  readonly runtimes: RuntimeResolver;
  readonly environmentId: string;
  readonly definitionStateRoot: string;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly adapterHost?: PragmaAdapterHost | undefined;
  readonly resolveExternalInvocable?: PragmaCompileOptions["resolveExternalInvocable"];
}): Promise<LocalHostBuiltInExecutorDefinition> {
  const compiled = await compileBuiltInAgent({
    ref: options.builtInRef,
    environmentId: options.environmentId,
    definitionStateRoot: options.definitionStateRoot,
    workspace: options.workspace.canonicalPath,
    pragmaHome: options.pragmaHome,
    runtimes: options.runtimes,
    loggerProvider: options.loggerProvider,
    adapterHost: options.adapterHost,
    resolveExternalInvocable: options.resolveExternalInvocable,
  });
  return {
    descriptor: await createBuiltInDescriptor(options.builtInRef, options.runtimes),
    definition: compiled.value,
  };
}

async function createBuiltInDescriptor(
  ref: BuiltInAgentRef,
  runtimes: RuntimeResolver,
): Promise<ExecutorDescriptor> {
  const resource = builtInAgentResource(ref);
  let usable: boolean;
  try {
    const bound = await runtimes.bind({});
    usable = (await bound.adapter.canUse()).usable;
  } catch {
    usable = false;
  }
  return ExecutorDescriptorSchema.parse({
    schemaVersion: "pragma.integration-executor/v1",
    ref: { kind: "expert", id: ref.slice("expert:".length) },
    name: resource.metadata.name,
    description: resource.metadata.description,
    source: "built_in",
    availability: usable
      ? { status: "ready", blockingCodes: [] }
      : {
          status: "unavailable",
          blockingCodes: ["RUNTIME_UNAVAILABLE"],
        },
    workspace: { required: true, allowNonGitDirectory: true },
    capabilities: {
      interactive: true,
      resumable: true,
      steerable: false,
      supportsQueue: false,
    },
  });
}
