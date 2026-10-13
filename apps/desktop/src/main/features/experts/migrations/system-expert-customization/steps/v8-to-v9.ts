import { isDeepStrictEqual } from "node:util";
import { PragmaToolBindingSchema } from "@pragma/interpreter/ast";
import type { SystemExpertCustomizationConfigV8 } from "../schemas/v8.ts";

// The actual v8 writer's default tools; exact matching preserves user-authored bindings.
const V8_DEFAULT_PRAGMA_TOOLS = [
  {
    adapter: "pragma.tool.call@v1",
    target: {
      ref: "expert:0000000000st0rev",
    },
    tool: {
      name: "call_store_revision_agent",
      description:
        "Required first step for managed knowledge changes. Delegate complete requirements and an existing draftId to the Store Revision Agent; formal content is read-only, and only drafts may be edited. Continue the same Agent conversation and draft after a review is returned for changes.",
      approval: "ask",
    },
  },
  {
    adapter: "pragma.tool.call@v1",
    target: {
      ref: "expert:0000000000sk1rev",
    },
    tool: {
      name: "call_skill_revision_agent",
      description:
        "Required first step for managed Skill changes. Delegate complete requirements and an existing draftId to the Skill Revision Agent; formal packages are read-only, and only drafts may be edited. Continue the same Agent conversation and draft after a review is returned for changes.",
      approval: "ask",
    },
  },
];
const V9_DEFAULT_PRAGMA_TOOLS = [
  PragmaToolBindingSchema.parse({
    adapter: "pragma.tool.delegate@v1",
    targets: [{ ref: "expert:0000000000st0rev" }, { ref: "expert:0000000000sk1rev" }],
    policy: { maxConcurrency: 4, maxDepth: 3, runtimes: {} },
  }),
];
const APPROVAL_RANK = { none: 0, ask: 1, required: 2 } as const;
function strongest(modes: readonly (keyof typeof APPROVAL_RANK)[]) {
  return modes.reduce(
    (result, mode) => (APPROVAL_RANK[mode] > APPROVAL_RANK[result] ? mode : result),
    "none",
  );
}
export function migrateV8ToV9(source: SystemExpertCustomizationConfigV8) {
  return {
    schemaVersion: 9 as const,
    customizations: source.customizations.map((customization) => {
      if (
        customization.ref !== "expert:0000000000pragma" ||
        !isDeepStrictEqual(customization.resourceTools, V8_DEFAULT_PRAGMA_TOOLS)
      )
        return customization;
      const { call_store_revision_agent, call_skill_revision_agent, ...approvals } =
        customization.toolApprovals;
      const mode = strongest([
        call_store_revision_agent ?? "ask",
        call_skill_revision_agent ?? "ask",
      ]);
      return {
        ...customization,
        resourceTools: V9_DEFAULT_PRAGMA_TOOLS,
        toolApprovals: {
          ...approvals,
          spawn_expert: strongest([mode, approvals.spawn_expert ?? "none"]),
          continue_expert: strongest([mode, approvals.continue_expert ?? "none"]),
        },
      };
    }),
  };
}
