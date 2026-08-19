import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  canonicalPragmaResourceRef,
  type PragmaResource,
  type PragmaResourceRef,
} from "@pragma/interpreter/ast";

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
    readonly checkContextContent?: boolean | undefined;
  },
): Promise<PragmaBundleInstallation["pending"]> {
  return readinessToPending(await inspectBundleReadiness(resources, options));
}

export async function inspectBundleReadiness(
  resources: readonly PragmaResource[],
  options: {
    readonly capabilities: CapabilityStore;
    readonly contextStores: ContextStoreStore;
    readonly plugins: PluginStore;
    readonly runtimes: readonly DesktopRuntimeAvailability[];
    readonly checkContextContent?: boolean | undefined;
  },
): Promise<PragmaBundleDependencyReadiness[]> {
  const readiness: PragmaBundleDependencyReadiness[] = [];
  for (const resource of resources) {
    const ref = canonicalPragmaResourceRef(resource);
    if (resource.kind === "Capability") {
      const binding = parseDesktopCapabilityBindingRef(resource.spec.binding ?? "");
      if (binding === undefined) {
        readiness.push({
          id: `capability:${ref}`,
          kind: "capability",
          resourceRef: ref,
          name: resource.metadata.name,
          status: "missing",
          code: "capability_missing",
          action: "choose_capability",
          message: "Choose or install a compatible capability.",
        });
      } else {
        try {
          const capability = await options.capabilities.get(binding.id, binding.revision);
          const diagnosticCode = capability.health.diagnostic?.code;
          const needsSetup = capability.health.status !== "ready";
          const status = needsSetup ? capabilityStatus(diagnosticCode) : "ready";
          readiness.push({
            id: `capability:${ref}`,
            kind: "capability",
            resourceRef: ref,
            name: resource.metadata.name,
            status,
            code: needsSetup ? (diagnosticCode ?? "capability_needs_attention") : "ready",
            action: needsSetup ? capabilityAction(diagnosticCode) : "none",
            message: needsSetup
              ? "Complete capability setup before using this Bundle."
              : "Capability is ready.",
            capabilityKind: capability.definition.kind,
            targetId: binding.id,
          });
        } catch (error) {
          const code = errorCode(error);
          readiness.push({
            id: `capability:${ref}`,
            kind: "capability",
            resourceRef: ref,
            name: resource.metadata.name,
            status: dependencyStatus(code),
            code,
            action: "choose_capability",
            message: "Choose or restore the capability required by this Bundle.",
          });
        }
      }
    } else if (resource.kind === "ContextStore") {
      const id = parseDesktopContextBindingRef(resource.spec.binding ?? "");
      if (id === undefined) {
        readiness.push({
          id: `context-store:${ref}`,
          kind: "context-store",
          resourceRef: ref,
          name: resource.metadata.name,
          status: "missing",
          code: "context_store_missing",
          action: "choose_knowledge_base",
          message: "Choose or restore the knowledge base required by this Bundle.",
        });
        continue;
      }
      try {
        await options.contextStores.resolve(id);
        if (options.checkContextContent !== false) {
          await options.contextStores.fingerprint(id);
        }
        readiness.push({
          id: `context-store:${ref}`,
          kind: "context-store",
          resourceRef: ref,
          name: resource.metadata.name,
          status: "ready",
          code: "ready",
          action: "none",
          message: "Knowledge base is ready.",
          targetId: id,
        });
      } catch (error) {
        readiness.push({
          id: `context-store:${ref}`,
          kind: "context-store",
          resourceRef: ref,
          name: resource.metadata.name,
          status: dependencyStatus(errorCode(error)),
          code: errorCode(error),
          action: "choose_knowledge_base",
          message: "Choose or restore the knowledge base required by this Bundle.",
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
        readiness.push({
          id: `runtime:${ref}`,
          kind: "runtime",
          resourceRef: ref,
          name: resource.metadata.name,
          status: "missing",
          code: "runtime_unavailable",
          action: "choose_runtime",
          message: "Choose a compatible local Runtime and model.",
        });
      } else {
        readiness.push({
          id: `runtime:${ref}`,
          kind: "runtime",
          resourceRef: ref,
          name: resource.metadata.name,
          status: "ready",
          code: "ready",
          action: "none",
          message: "Runtime is ready.",
          targetId: runtime.id,
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
        const ready = inspection.status === "ready";
        readiness.push({
          id: `plugin:${binding.ref}`,
          kind: "plugin",
          resourceRef: ref,
          name: binding.ref,
          status: ready ? "ready" : "action_required",
          code: ready ? "ready" : "plugin_needs_attention",
          action: ready ? "none" : "install_plugin",
          message: ready ? "Plugin is ready." : "Install or repair the required plugin.",
        });
      }
    }
  }
  return deduplicateReadiness(readiness);
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

function capabilityAction(code: string | undefined): "configure_capability" | "restore_or_replace" {
  if (code === undefined) return "configure_capability";
  return /invalid|schema|malformed|executable|runtime|path|file|process|not_found|unavailable/i.test(
    code,
  )
    ? "restore_or_replace"
    : "configure_capability";
}

function capabilityStatus(
  code: string | undefined,
): "missing" | "invalid" | "action_required" | "ready" {
  if (code === undefined) return "action_required";
  if (/executable|runtime|path|file|process|not_found|unavailable/i.test(code)) return "missing";
  if (/invalid|schema|malformed|unsupported/i.test(code)) return "invalid";
  return "action_required";
}

function dependencyStatus(code: string): "missing" | "invalid" {
  return /invalid|schema|malformed|config/i.test(code) ? "invalid" : "missing";
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9_.-]+$/i.test(code)) {
      return code.slice(0, 100).toLowerCase();
    }
  }
  return "dependency_unavailable";
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

function deduplicateReadiness(
  readiness: readonly PragmaBundleDependencyReadiness[],
): PragmaBundleDependencyReadiness[] {
  const result = new Map<string, PragmaBundleDependencyReadiness>();
  for (const dependency of readiness) {
    const key = `${dependency.kind}:${dependency.id}`;
    if (!result.has(key)) result.set(key, dependency);
  }
  return [...result.values()];
}
