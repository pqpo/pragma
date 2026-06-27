import { definePluginEntry } from "@expertmesh/agent-core";

export default definePluginEntry({
  setup: () => ({
    toolApprovals: [
      {
        toolName: "delete_workspace_note",
        approval: {
          mode: "required",
          reason: "Deleting workspace notes requires explicit approval.",
          when: ({ input }) =>
            typeof input === "object" &&
            input !== null &&
            "path" in input &&
            typeof input.path === "string" &&
            input.path.endsWith(".md"),
        },
      },
    ],
  }),
});
