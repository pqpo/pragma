import { inspectAssetReadiness } from "../asset-transfer/asset-transfer-readiness.ts";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { type PragmaResource, type PragmaResourceRef } from "@pragma/interpreter/ast";

import type {
  DesktopRuntimeAvailability,
  PragmaBundleDependencyReadiness,
  PragmaBundleInstallation,
} from "../../../shared/contracts/index.ts";
import {
  parseDesktopCapabilityBindingRef,
  parseDesktopContextBindingRef,
} from "../../platform/bindings/desktop-binding-ref.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import type { PluginStore } from "../plugins/plugin-store.ts";

interface RuntimeDependency {
  readonly requirementId?: string | undefined;
  readonly resourceRef?: string | undefined;
  readonly name?: string | undefined;
  readonly runtimeId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly thinkingLevel?: string | undefined;
}

export async function collectCapabilities(
  resources: readonly PragmaResource[],
  store: CapabilityStore,
) {
  const result = [];
  for (const resource of resources) {
    if (resource.kind !== "Capability") continue;
    const binding = parseDesktopCapabilityBindingRef(resource.spec.binding ?? "");
    const capability =
      binding === undefined ? undefined : await store.resolveActive(binding).catch(() => undefined);
    result.push({ resource, capability });
  }
  return result;
}

export async function collectContexts(
  resources: readonly PragmaResource[],
  store: ContextStoreStore,
) {
  const stores = await store.list();
  return resources.flatMap((resource) => {
    if (resource.kind !== "ContextStore") return [];
    const id = parseDesktopContextBindingRef(resource.spec.binding ?? "");
    return [{ resource, store: stores.find((candidate) => candidate.id === id) }];
  });
}

export function runtimeDependencyAvailable(
  runtime: DesktopRuntimeAvailability,
  dependency: RuntimeDependency,
): boolean {
  if (
    dependency.runtimeId === undefined ||
    runtime.id !== dependency.runtimeId ||
    runtime.status !== "available"
  ) {
    return false;
  }
  if (dependency.providerId === undefined && dependency.modelId === undefined) return true;
  return (
    runtime.models?.some(
      (model) =>
        model.provider.id === dependency.providerId &&
        model.id === dependency.modelId &&
        (dependency.thinkingLevel === undefined ||
          model.thinking?.supportedLevels.some(
            (level) => level.value === dependency.thinkingLevel,
          )),
    ) === true
  );
}

export async function inspectPendingDependencies(
  resources: readonly PragmaResource[],
  options: {
    readonly capabilities: CapabilityStore;
    readonly contextStores: ContextStoreStore;
    readonly plugins: PluginStore;
    readonly runtimes: readonly DesktopRuntimeAvailability[];
    readonly checkContextContent?: boolean | undefined;
  },
): Promise<PragmaBundleInstallation["pending"]> {
  return readinessToPending(await inspectAssetReadiness(resources, options));
}

export function readinessToPending(
  readiness: readonly PragmaBundleDependencyReadiness[],
): PragmaBundleInstallation["pending"] {
  return readiness
    .filter((dependency) => dependency.status !== "ready")
    .map((dependency) => ({
      id: dependency.id,
      kind: dependency.kind,
      resourceRef: dependency.resourceRef,
      name: dependency.name,
      message: dependency.message,
      ...(dependency.capabilityKind === undefined
        ? {}
        : { capabilityKind: dependency.capabilityKind }),
      status: dependency.status,
      code: dependency.code,
      action: dependency.action,
      ...(dependency.targetId === undefined ? {} : { targetId: dependency.targetId }),
    }));
}

export function pendingBinding(installationId: string, ref: string) {
  return `binding:bundle-pending.${installationId.replaceAll("-", "")}.${sha256(ref).slice(0, 12)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isPortableValue(value: unknown): boolean {
  if (typeof value === "string") {
    return !isAbsolute(value) && !/^[a-z]:[\\/]/i.test(value) && !value.startsWith("~/");
  }
  if (Array.isArray(value)) return value.every(isPortableValue);
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).every(isPortableValue);
  }
  return true;
}

export function mergePendingMetadata(
  inspected: readonly PragmaBundleInstallation["pending"][number][],
  previous: readonly PragmaBundleInstallation["pending"][number][],
): PragmaBundleInstallation["pending"] {
  const previousById = new Map(previous.map((dependency) => [dependency.id, dependency]));
  const previousByScope = new Map<string, PragmaBundleInstallation["pending"][number][]>();
  for (const dependency of previous) {
    const key = `${dependency.kind}\0${dependency.resourceRef}`;
    previousByScope.set(key, [...(previousByScope.get(key) ?? []), dependency]);
  }
  return deduplicatePending(
    inspected.map((dependency) => {
      const candidates = previousByScope.get(`${dependency.kind}\0${dependency.resourceRef}`) ?? [];
      const prior =
        previousById.get(dependency.id) ??
        (candidates.length === 1
          ? candidates[0]
          : candidates.find((candidate) => candidate.name === dependency.name));
      if (prior === undefined) return dependency;
      return {
        ...dependency,
        id: prior.id,
        ...(dependency.capabilityKind !== undefined || prior.capabilityKind === undefined
          ? {}
          : { capabilityKind: prior.capabilityKind }),
      };
    }),
  );
}

export function assertUniqueResolutionRefs(
  values: readonly { readonly resourceRef: PragmaResourceRef }[],
  label: string,
): void {
  if (new Set(values.map((value) => value.resourceRef)).size !== values.length) {
    throw new Error(`${label} setup contains duplicate resource bindings.`);
  }
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function deduplicatePending(
  pending: readonly PragmaBundleInstallation["pending"][number][],
): PragmaBundleInstallation["pending"] {
  const result = new Map<string, PragmaBundleInstallation["pending"][number]>();
  for (const dependency of pending) {
    const key = `${dependency.kind}:${dependency.id}`;
    if (!result.has(key)) result.set(key, dependency);
  }
  return [...result.values()];
}
