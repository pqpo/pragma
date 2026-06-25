import { definePluginEntry } from "@expertmesh/agent-core";

export default definePluginEntry({
  setup: () => ({
    toolApprovals: [
      {
        toolName: "delete_workspace_note",
        approval: {
          mode: "required",
          reason: "Deleting workspace notes requires explicit approval.",
        },
      },
    ],
  }),
});
