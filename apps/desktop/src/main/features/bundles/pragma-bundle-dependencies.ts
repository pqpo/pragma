import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  canonicalPragmaResourceRef,
  type PragmaResource,
  type PragmaResourceRef,
} from "@pragma/interpreter/ast";

import type {
  DesktopRuntimeAvailability,
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
      binding === undefined
        ? undefined
        : await store.get(binding.id, binding.revision).catch(() => undefined);
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

export async function collectPlugins(resources: readonly PragmaResource[], store: PluginStore) {
  const refs = unique(
    resources.flatMap((resource) =>
      resource.kind === "Expert" ? resource.spec.plugins.map((plugin) => plugin.ref) : [],
    ),
  );
  const result = [];
  for (const ref of refs) {
    const plugin = await store.get(ref).catch(() => undefined);
    const packageInfo =
      plugin === undefined ? undefined : await store.exportPackage(ref).catch(() => undefined);
    result.push({ ref, plugin, packageInfo });
  }
  return result;
}

export async function assertPortablePluginConfigs(
  resources: readonly PragmaResource[],
  plugins: readonly {
    readonly ref: string;
    readonly plugin: Awaited<ReturnType<PluginStore["get"]>> | undefined;
  }[],
  store: PluginStore,
): Promise<void> {
  for (const resource of resources) {
    if (resource.kind !== "Expert") continue;
    for (const binding of resource.spec.plugins) {
      const config = binding.config ?? {};
      if (!isPortableValue(config)) {
        throw new Error(`Plugin config contains a machine-local path: ${binding.ref}.`);
      }
      const plugin = plugins.find((candidate) => candidate.ref === binding.ref)?.plugin;
      if (plugin === undefined) {
        if (Object.keys(config).length > 0) {
          throw new Error(
            `Cannot verify whether plugin config contains secrets because ${binding.ref} is not installed.`,
          );
        }
        continue;
      }
      await store.assertPortableConfig(binding.ref, config);
    }
  }
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
  },
): Promise<PragmaBundleInstallation["pending"]> {
  const pending: PragmaBundleInstallation["pending"] = [];
  for (const resource of resources) {
    const ref = canonicalPragmaResourceRef(resource);
    if (resource.kind === "Capability") {
      const binding = parseDesktopCapabilityBindingRef(resource.spec.binding ?? "");
      if (binding === undefined) {
        pending.push({
          id: `capability:${ref}`,
          kind: "capability",
          resourceRef: ref,
          name: resource.metadata.name,
          message: "Choose or install a compatible capability.",
        });
      } else {
        try {
          const capability = await options.capabilities.get(binding.id, binding.revision);
          if (capability.health.status !== "ready") {
            pending.push({
              id: `capability:${ref}`,
              kind: "capability",
              resourceRef: ref,
              name: resource.metadata.name,
              message: capability.health.diagnostic?.message ?? "This capability needs attention.",
              capabilityKind: capability.definition.kind,
            });
          }
        } catch (error) {
          pending.push({
            id: `capability:${ref}`,
            kind: "capability",
            resourceRef: ref,
            name: resource.metadata.name,
            message: error instanceof Error ? error.message : "Capability is unavailable.",
          });
        }
      }
    } else if (resource.kind === "ContextStore") {
      const id = parseDesktopContextBindingRef(resource.spec.binding ?? "");
      try {
        if (id === undefined) throw new Error("Choose a knowledge base.");
        await options.contextStores.resolve(id);
      } catch (error) {
        pending.push({
          id: `context-store:${ref}`,
          kind: "context-store",
          resourceRef: ref,
          name: resource.metadata.name,
          message: error instanceof Error ? error.message : "Knowledge base is unavailable.",
        });
      }
    } else if (resource.kind === "RuntimeProfile") {
      const config =
        typeof resource.spec.config === "object" && resource.spec.config !== null
          ? (resource.spec.config as Record<string, unknown>)
          : {};
      const runtime = options.runtimes.find((candidate) => {
        if (candidate.id !== config["runtimeId"] || candidate.status !== "available") return false;
        if (config["providerId"] === undefined && config["model"] === undefined) return true;
        return candidate.models?.some(
          (model) =>
            model.provider.id === config["providerId"] &&
            model.id === config["model"] &&
            (config["thinkingLevel"] === undefined ||
              model.thinking?.supportedLevels.some(
                (level) => level.value === config["thinkingLevel"],
              )),
        );
      });
      if (runtime === undefined) {
        pending.push({
          id: `runtime:${ref}`,
          kind: "runtime",
          resourceRef: ref,
          name: resource.metadata.name,
          message: "Choose a compatible local Runtime and model.",
        });
      }
    } else if (resource.kind === "Expert") {
      for (const binding of resource.spec.plugins) {
        const inspection = await options.plugins
          .inspect({
            ref: binding.ref,
            config: binding.config,
            secretBindings: binding.secretBindings,
          })
          .catch((error: unknown) => ({
            status: "needs_attention" as const,
            issues: [
              {
                message: error instanceof Error ? error.message : "Plugin is unavailable.",
              },
            ],
          }));
        if (inspection.status !== "ready") {
          pending.push({
            id: `plugin:${binding.ref}`,
            kind: "plugin",
            resourceRef: ref,
            name: binding.ref,
            message: inspection.issues[0]?.message ?? "Plugin needs attention.",
          });
        }
      }
    }
  }
  return deduplicatePending(pending);
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
