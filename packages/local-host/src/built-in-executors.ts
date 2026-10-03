import { type PragmaLoggerProvider, type RuntimeResolver } from "@pragma/core";
import {
  BUILT_IN_AGENT_REFS,
  builtInAgentResource,
  type BuiltInAgentRef,
} from "@pragma/built-in-agents";
import type { PragmaAdapterHost } from "@pragma/interpreter";
import {
  ExecutorDescriptorSchema,
  type ExecutorDescriptor,
  type ExecutorReference,
  type WorkspaceSelection,
} from "@pragma/shared/integration";

import type { LocalHostCoreExecutorDefinition } from "./core-run.ts";
import { missionCompilationEnvironmentSnapshot } from "./missions/compile-service.ts";
import {
  createLocalHostNodeMissionCompiler,
  type LocalHostNodeMissionCompiler,
} from "./node-mission-compiler.ts";

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
  readonly compiler?: LocalHostNodeMissionCompiler | undefined;
}): (input: {
  readonly ref: ExecutorReference;
  readonly workspace: WorkspaceSelection;
  readonly purpose?: "execute" | "stop" | undefined;
}) => Promise<LocalHostCoreExecutorDefinition | undefined> {
  const compiler =
    options.compiler ??
    createLocalHostNodeMissionCompiler({
      pragmaHome: options.pragmaHome,
      runtimes: options.runtimes,
      environmentId: options.environmentId,
      loggerProvider: options.loggerProvider,
      ...(options.adapterHost === undefined
        ? {}
        : { resources: { adapterHost: () => options.adapterHost! } }),
    });
  const refs = new Set<string>(BUILT_IN_AGENT_REFS);
  return async ({ ref, workspace, purpose }) => {
    const exactRef = `${ref.kind}:${ref.id}`;
    if (ref.kind !== "expert" || !refs.has(exactRef)) return undefined;
    const resource = builtInAgentResource(exactRef as BuiltInAgentRef);
    const scope = compiler.service.createRequestScope({
      id: `resolve:${exactRef}`,
      // A logical source identity only: shipped resources need no project checkout.
      project: { id: "built_in", revision: 1 },
      executor: { kind: ref.kind, ref: exactRef, name: resource.metadata.name },
      workspace: { path: workspace.canonicalPath },
      contextMounts: [],
    });
    if (purpose === "stop") {
      const compiled = await compiler.compileForStop(scope);
      return {
        descriptor: await createBuiltInDescriptor(
          exactRef as BuiltInAgentRef,
          options.runtimes,
          true,
        ),
        definition: compiled.value,
      };
    }
    const prepared = await compiler.prepare(scope);
    const compilation = await prepared.ensureCompiled();
    return {
      descriptor: await createBuiltInDescriptor(
        exactRef as BuiltInAgentRef,
        options.runtimes,
        true,
      ),
      definition: compilation.compiled.value,
      environment: missionCompilationEnvironmentSnapshot(
        compilation.compiled,
        compilation.capabilities,
        compilation.secrets,
        compilation.plugins,
      ),
      compilation: {
        identity: compilation.identity,
        secrets: compilation.secrets,
        plugins: compilation.plugins,
        capabilities: compilation.capabilities,
        ...(compilation.definitionFingerprint === undefined
          ? {}
          : { definitionFingerprint: compilation.definitionFingerprint }),
      },
    };
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

async function createBuiltInDescriptor(
  ref: BuiltInAgentRef,
  runtimes: RuntimeResolver,
  preparedUsable?: boolean,
): Promise<ExecutorDescriptor> {
  const resource = builtInAgentResource(ref);
  let usable = preparedUsable ?? false;
  if (preparedUsable === undefined)
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
