import {
  PRAGMA_MANAGEMENT_BINDING_REF,
  PRAGMA_MANAGEMENT_CAPABILITY_REF,
  PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID,
} from "@pragma/built-in-agents";
import { canonicalPragmaResourceRef, type PragmaResource } from "@pragma/interpreter/ast";
import type {
  DesktopRuntimeAvailability,
  PragmaBundleDependencyReadiness as AssetDependencyReadiness,
} from "../../../shared/contracts/index.ts";
import {
  parseDesktopCapabilityBindingRef,
  parseDesktopContextBindingRef,
} from "../../platform/bindings/desktop-binding-ref.ts";
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
          const capability = await options.capabilities
            .resolveActive(binding)
            .catch(async (error) => {
              const latest = await options.capabilities.get(binding);
              if (latest.health.status === "ready") throw error;
              return latest;
            });
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
