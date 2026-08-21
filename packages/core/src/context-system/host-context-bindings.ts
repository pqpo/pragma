import type { Expert } from "../agent/expert-agent.ts";
import { ContextManager } from "../agent/context-manager.ts";
import type { ExpertAgentContextStoreRegistrationInput } from "./context-system.ts";

export type HostContextBindings = readonly ExpertAgentContextStoreRegistrationInput[];

export type HostContextBindingsResolver = () => HostContextBindings | Promise<HostContextBindings>;

/**
 * Returns a stable in-process identity for the registered Host Context surface.
 * Store contents are intentionally excluded; this only detects binding changes that require a
 * Runtime Session to be reopened with a new ContextSystem.
 */
export function hostContextBindingsFingerprint(bindings: HostContextBindings | undefined): string {
  return JSON.stringify(
    [...(bindings ?? [])]
      .map((binding) => ({
        namespace: binding.namespace,
        storeName: binding.storeName ?? "",
        required: binding.required ?? false,
        mutationApproval: binding.mutationApproval ?? "required",
        overflowTarget: binding.overflowTarget ?? false,
      }))
      .sort((left, right) => left.namespace.localeCompare(right.namespace)),
  );
}

/** Mounts Host-owned Context stores without introducing a Host package dependency in Core. */
export function withHostContextBindings(
  expert: Expert,
  bindings: HostContextBindings | undefined,
): Expert {
  if (bindings === undefined || bindings.length === 0) return expert;

  const clone = Object.create(Object.getPrototypeOf(expert)) as Expert;
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(expert));
  const contextSystem = expert.contextSystem.extend({});
  for (const binding of bindings) {
    const result = contextSystem.register(binding);
    if (!result.ok) throw new TypeError(result.error.message);
  }
  Object.defineProperty(clone, "contextSystem", { value: contextSystem, enumerable: true });
  Object.defineProperty(clone, "contextManager", {
    value: new ContextManager({ agent: clone, contextSystem }),
  });
  return clone;
}
