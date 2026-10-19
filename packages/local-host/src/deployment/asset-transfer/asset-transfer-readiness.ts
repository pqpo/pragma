import { capabilityToolNames } from "../capabilities/capability-revision-coordinator.ts";
import { resolveCapabilityForBinding } from "../capabilities/capability-verification.ts";
import {
  PRAGMA_MANAGEMENT_BINDING_REF,
  PRAGMA_MANAGEMENT_CAPABILITY_REF,
  PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID,
} from "@pragma/built-in-agents";
import { canonicalPragmaResourceRef, type PragmaResource } from "@pragma/interpreter/ast";
import type {
  Capability,
  DesktopRuntimeAvailability,
  PragmaBundleDependencyReadiness as AssetDependencyReadiness,
} from "../../deployment-contracts/index.ts";
import { parseDesktopCapabilityBindingRef, parseDesktopContextBindingRef } from "../bindings.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import type { PluginStore } from "../plugins/plugin-store.ts";

export async function inspectAssetReadiness(
  resources: readonly PragmaResource[],
  options: {
    readonly capabilities: CapabilityStore;
    readonly contextStores: ContextStoreStore;
    readonly plugins: PluginStore;
    readonly runtimes: readonly DesktopRuntimeAvailability[];
    readonly checkContextContent?: boolean | undefined;
  },
): Promise<AssetDependencyReadiness[]> {
  const readiness: AssetDependencyReadiness[] = [];
  const resolvedCapabilities = new Map<string, Capability>();
  for (const resource of resources) {
    const ref = canonicalPragmaResourceRef(resource);
    if (resource.kind === "Capability") {
      if (
        ref === PRAGMA_MANAGEMENT_CAPABILITY_REF &&
        resource.spec.binding === PRAGMA_MANAGEMENT_BINDING_REF
      ) {
        readiness.push({
          id: `capability:${ref}`,
          kind: "capability",
          resourceRef: ref,
          name: resource.metadata.name,
          status: "ready",
          code: "ready",
          action: "none",
          message: "The built-in Pragma management Capability is available.",
          capabilityKind: "mcp_server",
          targetId: PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID,
        });
        continue;
      }
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
          const capability = await resolveCapabilityForBinding(options.capabilities, binding);
          resolvedCapabilities.set(ref, capability);
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
              ? "Complete capability setup before using this asset."
              : "Capability is ready.",
            capabilityKind: capability.definition.kind,
            targetId: binding,
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
            message: "Choose or restore the capability required by this asset.",
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
          message: "Choose or restore the knowledge base required by this asset.",
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
          message: "Choose or restore the knowledge base required by this asset.",
        });
      }
    } else if (resource.kind === "RuntimeProfile") {
      const config =
        typeof resource.spec.config === "object" && resource.spec.config !== null
          ? (resource.spec.config as Record<string, unknown>)
          : {};
      const candidates = options.runtimes.filter(
        (candidate) => candidate.id === config["runtimeId"],
      );
      const runtime =
        candidates.length === 1
          ? candidates.find((candidate) => {
              if (candidate.id !== config["runtimeId"] || candidate.status !== "available")
                return false;
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
            })
          : undefined;
      if (runtime === undefined) {
        readiness.push({
          id: `runtime:${ref}`,
          kind: "runtime",
          resourceRef: ref,
          name: resource.metadata.name,
          status: "missing",
          code:
            candidates.length > 1
              ? "binding_ambiguous"
              : candidates.length === 0
                ? "runtime_missing"
                : candidates[0]!.status !== "available"
                  ? "runtime_unavailable"
                  : candidates[0]!.modelDiscoveryError !== undefined
                    ? "model_discovery_failed"
                    : candidates[0]!.models === undefined
                      ? "model_catalog_unavailable"
                      : !candidates[0]!.models.some(
                            (model) =>
                              model.provider.id === config["providerId"] &&
                              model.id === config["model"],
                          )
                        ? "model_missing"
                        : "thinking_level_unavailable",
          action: "choose_runtime",
          message:
            candidates.length > 1
              ? "Multiple Runtime Environments match this identity. Resolve the ambiguity."
              : candidates[0]?.modelDiscoveryError !== undefined
                ? "The Runtime model catalog could not be loaded. Check authentication and connectivity before choosing a replacement."
                : (candidates[0]?.reason ?? "Choose a compatible local Runtime and model."),
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
  for (const expert of resources) {
    if (expert.kind !== "Expert") continue;
    for (const reference of expert.spec.capabilities) {
      const capability = resolvedCapabilities.get(reference.ref);
      const dependency = readiness.find(
        (value) => value.kind === "capability" && value.resourceRef === reference.ref,
      );
      if (capability === undefined || dependency?.status !== "ready") continue;
      const tools = new Set(capabilityToolNames(capability));
      if (
        (reference.kind === "skill") !== (capability.definition.kind === "skill") ||
        (reference.kind === "tools" && (reference.tools ?? []).some((tool) => !tools.has(tool)))
      ) {
        Object.assign(dependency, {
          status: "action_required",
          code: "capability_incompatible",
          action: "choose_capability",
          message: `The capability cannot satisfy ${expert.metadata.name}'s declared tools or Skill requirements.`,
        });
      }
    }
  }
  return deduplicateReadiness(readiness);
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

function deduplicateReadiness(
  readiness: readonly AssetDependencyReadiness[],
): AssetDependencyReadiness[] {
  const result = new Map<string, AssetDependencyReadiness>();
  for (const dependency of readiness) {
    const key = `${dependency.kind}:${dependency.id}`;
    if (!result.has(key)) result.set(key, dependency);
  }
  return [...result.values()];
}
