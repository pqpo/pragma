import type { Expert } from "../agent/expert-agent.ts";
import { ContextManager } from "../agent/context-manager.ts";
import type { ExpertAgentContextStoreRegistrationInput } from "./context-system.ts";

export type HostContextBindings = readonly ExpertAgentContextStoreRegistrationInput[];

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
