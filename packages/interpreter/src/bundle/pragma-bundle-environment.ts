import type { RuntimeResolver } from "@pragma/core";

import type { PragmaBundleRequirement } from "../ast/pragma-bundle.schema.ts";
import type { PragmaArtifactRecord, PragmaBindingRecord } from "../runtime/resource-adapters.ts";
import type { PragmaCompileHost, PragmaPluginResolver } from "../runtime/registries.ts";
import { stableStringify } from "../compiler/compiler-hash.ts";

export interface PragmaBundleRequirementInspection {
  readonly requirementId: string;
  readonly status: "ready" | "needs_binding" | "unsupported";
  readonly message?: string | undefined;
  readonly candidates?: readonly PragmaBundleBindingCandidate[] | undefined;
}

export interface PragmaBundleBindingCandidate {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface PragmaBundleBindingContribution {
  readonly bindings?: readonly PragmaBindingRecord[] | undefined;
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  readonly artifacts?: readonly PragmaArtifactRecord[] | undefined;
  readonly runtimes?: RuntimeResolver | undefined;
  readonly plugins?: PragmaPluginResolver | undefined;
}

export interface PragmaBundleBindingHost {
  readonly inspect: (input: {
    readonly requirement: PragmaBundleRequirement;
    readonly payload: ReadonlyMap<string, Uint8Array>;
  }) => Promise<PragmaBundleRequirementInspection>;
  /** This is the only bundle API allowed to materialize or persist Host assets. */
  readonly bind: (input: {
    readonly requirement: PragmaBundleRequirement;
    readonly candidateId?: string | undefined;
    readonly payload: ReadonlyMap<string, Uint8Array>;
  }) => Promise<PragmaBundleBindingContribution>;
}

export interface PragmaEnvironmentBindingOverlay {
  readonly bindings: ReadonlyMap<string, PragmaBindingRecord>;
  readonly secrets: ReadonlyMap<string, string>;
  readonly artifacts: ReadonlyMap<string, PragmaArtifactRecord>;
  readonly runtimes?: RuntimeResolver | undefined;
  readonly plugins?: PragmaPluginResolver | undefined;
}

export function createEmptyPragmaEnvironmentBindingOverlay(): PragmaEnvironmentBindingOverlay {
  return {
    bindings: new Map(),
    secrets: new Map(),
    artifacts: new Map(),
  };
}

export function mergePragmaBindingContributions(
  contributions: readonly PragmaBundleBindingContribution[],
): PragmaEnvironmentBindingOverlay {
  const bindings = new Map<string, PragmaBindingRecord>();
  const secrets = new Map<string, string>();
  const artifacts = new Map<string, PragmaArtifactRecord>();
  let runtimes: RuntimeResolver | undefined;
  let plugins: PragmaPluginResolver | undefined;
  for (const contribution of contributions) {
    for (const binding of contribution.bindings ?? []) {
      const existing = bindings.get(binding.ref);
      if (existing !== undefined && existing.fingerprint !== binding.fingerprint) {
        throw new Error(`Conflicting bundle binding contributions for ${binding.ref}.`);
      }
      bindings.set(binding.ref, binding);
    }
    for (const [ref, value] of Object.entries(contribution.secrets ?? {})) {
      const existing = secrets.get(ref);
      if (existing !== undefined && existing !== value) {
        throw new Error(`Conflicting bundle secret contributions for ${ref}.`);
      }
      secrets.set(ref, value);
    }
    for (const artifact of contribution.artifacts ?? []) {
      const key = stableStringify(artifact.source);
      const existing = artifacts.get(key);
      if (existing !== undefined && existing.contentHash !== artifact.contentHash) {
        throw new Error(`Conflicting bundle artifact contributions for ${key}.`);
      }
      artifacts.set(key, artifact);
    }
    if (contribution.runtimes !== undefined) {
      if (runtimes !== undefined && runtimes !== contribution.runtimes) {
        throw new Error("Multiple bundle Runtime resolver contributions cannot be merged.");
      }
      runtimes = contribution.runtimes;
    }
    if (contribution.plugins !== undefined) {
      if (plugins !== undefined && plugins !== contribution.plugins) {
        throw new Error("Multiple bundle plugin resolver contributions cannot be merged.");
      }
      plugins = contribution.plugins;
    }
  }
  return {
    bindings,
    secrets,
    artifacts,
    ...(runtimes === undefined ? {} : { runtimes }),
    ...(plugins === undefined ? {} : { plugins }),
  };
}

export function applyPragmaEnvironmentBindingOverlay(
  host: PragmaCompileHost,
  overlay: PragmaEnvironmentBindingOverlay,
): PragmaCompileHost {
  const baseAdapterHost = host.adapterHost;
  return {
    ...host,
    ...(overlay.runtimes === undefined ? {} : { runtimes: overlay.runtimes }),
    ...(overlay.plugins === undefined ? {} : { plugins: overlay.plugins }),
    adapterHost: {
      environmentId: baseAdapterHost?.environmentId ?? host.environmentId ?? "default",
      projectRoot: baseAdapterHost?.projectRoot ?? host.projectRoot ?? host.workspace,
      async resolveBinding(ref) {
        return overlay.bindings.get(ref) ?? (await baseAdapterHost?.resolveBinding(ref));
      },
      async resolveSecret(ref) {
        return overlay.secrets.get(ref) ?? (await baseAdapterHost?.resolveSecret(ref));
      },
      async resolveArtifact(source) {
        const value = overlay.artifacts.get(stableStringify(source));
        if (value !== undefined) return value;
        if (baseAdapterHost === undefined) {
          throw new Error(`No artifact resolver configured for: ${stableStringify(source)}`);
        }
        return await baseAdapterHost.resolveArtifact(source);
      },
    },
  };
}
