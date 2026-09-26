import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type PragmaResource } from "../ast/pragma-dsl.schema.ts";
import { type PragmaCompileHost } from "../runtime/registries.ts";
import {
  type PragmaResourceInspection,
  type PragmaRuntimeProfileContribution,
} from "../runtime/resource-adapters.ts";
import { sha256, stableStringify } from "./compiler-hash.ts";
import { type IndexedResource, PragmaDslError } from "./project-contracts.ts";

export async function verifyRuntimeEnvironment(
  inspection: PragmaResourceInspection<PragmaRuntimeProfileContribution>,
  runtimes: PragmaCompileHost["runtimes"],
  requireRegistry: boolean,
): Promise<PragmaResourceInspection<PragmaRuntimeProfileContribution>> {
  if (inspection.health.status !== "ready" || inspection.contribution === undefined) {
    return inspection;
  }
  try {
    if (runtimes === undefined) {
      if (!requireRegistry) return inspection;
      throw new Error("A Runtime registry is required to verify RuntimeProfile availability.");
    }
    const resolvedRuntime = await runtimes.bind({
      runtimeId: inspection.contribution.runtimeId,
    });
    const runtime = resolvedRuntime.adapter;
    const canUse = await runtime.canUse();
    if (!canUse.usable) {
      throw new Error(canUse.reason ?? `Runtime is unavailable: ${runtime.descriptor.id}`);
    }
    const models =
      runtime.listModels === undefined
        ? undefined
        : [...(await runtime.listModels())].sort((left, right) => left.id.localeCompare(right.id));
    const selection = inspection.contribution.models?.default;
    const defaultModel = selection?.model.modelId;
    const defaultProvider = selection?.model.providerId;
    const defaultThinkingLevel = selection?.thinkingLevel;
    if (defaultModel !== undefined && models !== undefined) {
      const selectedModel = models.find(
        (model) =>
          model.id === defaultModel &&
          (defaultProvider === undefined || model.provider.id === defaultProvider),
      );
      if (selectedModel === undefined) {
        throw new Error(
          `Runtime model is unavailable for ${runtime.descriptor.id}: ${defaultModel}`,
        );
      }
      if (
        defaultThinkingLevel !== undefined &&
        !selectedModel.thinking?.supportedLevels.some(
          (level) => level.value === defaultThinkingLevel,
        )
      ) {
        throw new Error(
          `Runtime thinking level is unavailable for ${runtime.descriptor.id}/${defaultModel}: ${defaultThinkingLevel}`,
        );
      }
    } else if (defaultThinkingLevel !== undefined) {
      throw new Error(
        `Runtime thinking level requires a discoverable model for ${runtime.descriptor.id}.`,
      );
    }
    return {
      ...inspection,
      health: {
        ...inspection.health,
        verificationFingerprint: sha256(
          stableStringify({
            adapter: inspection.health.verificationFingerprint,
            runtime: runtime.descriptor,
            availability: canUse,
            models,
          }),
        ),
      },
    };
  } catch (error) {
    return {
      ref: inspection.ref,
      health: {
        ...inspection.health,
        status: "needs_attention",
        verificationFingerprint: undefined,
        issues: [
          {
            severity: "error",
            code: "environment.runtime_unavailable",
            message: error instanceof Error ? error.message : String(error),
            path: ["spec", "config", "runtimeId"],
          },
        ],
      },
    };
  }
}

export async function hashArtifactPath(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isFile()) return sha256(await readFile(path));
  if (!info.isDirectory()) throw new Error(`Artifact is not a regular file or directory: ${path}`);
  const entries = await readdir(path, { withFileTypes: true });
  const unsupported = entries.find((entry) => !entry.isFile() && !entry.isDirectory());
  if (unsupported !== undefined) {
    throw new Error(`Artifact contains a non-regular entry: ${resolve(path, unsupported.name)}`);
  }
  const hashes = await Promise.all(
    entries.map(async (entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      hash: await hashArtifactPath(resolve(path, entry.name)),
    })),
  );
  return sha256(
    stableStringify(hashes.toSorted((left, right) => left.name.localeCompare(right.name))),
  );
}

export async function resolveRootRuntime(
  resource: PragmaResource,
  resources: ReadonlyMap<string, IndexedResource>,
  resolveRuntime: (ref: string) => Promise<PragmaRuntimeProfileContribution>,
  host: PragmaCompileHost,
): Promise<string | undefined> {
  if (host.rootExecutionOverride !== undefined) return host.rootExecutionOverride.runtimeId;
  if (resource.kind === "Expert") {
    return resource.spec.runtime === undefined
      ? await host.runtimes?.getDefaultRuntimeId()
      : (await resolveRuntime(resource.spec.runtime.ref)).runtimeId;
  }
  if (resource.kind === "ExpertTeam") {
    const coordinator = resources.get(resource.spec.coordinator.ref)?.resource;
    if (coordinator?.kind !== "Expert") {
      throw new PragmaDslError(
        `ExpertTeam coordinator not found: ${resource.spec.coordinator.ref}`,
      );
    }
    return coordinator.spec.runtime === undefined
      ? await host.runtimes?.getDefaultRuntimeId()
      : (await resolveRuntime(coordinator.spec.runtime.ref)).runtimeId;
  }
  return await host.runtimes?.getDefaultRuntimeId();
}

export async function resolveRootModelSelection(
  resource: PragmaResource,
  resources: ReadonlyMap<string, IndexedResource>,
  resolveRuntime: (ref: string) => Promise<PragmaRuntimeProfileContribution>,
  host: PragmaCompileHost,
) {
  if (host.rootModelSelectionOverride !== undefined) {
    return host.rootModelSelectionOverride;
  }
  if (host.rootExecutionOverride !== undefined) {
    return host.rootExecutionOverride.modelSelection;
  }
  if (resource.kind === "Expert") {
    return resource.spec.runtime === undefined
      ? host.defaultModelSelection
      : (await resolveRuntime(resource.spec.runtime.ref)).models?.default;
  }
  if (resource.kind === "ExpertTeam") {
    const coordinator = resources.get(resource.spec.coordinator.ref)?.resource;
    if (coordinator?.kind !== "Expert") return undefined;
    return coordinator.spec.runtime === undefined
      ? host.defaultModelSelection
      : (await resolveRuntime(coordinator.spec.runtime.ref)).models?.default;
  }
  return undefined;
}
