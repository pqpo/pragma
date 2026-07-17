import { definePluginEntry, readExpertAgentPluginManifest } from "@pragma/core";

export default definePluginEntry({
  manifest: readExpertAgentPluginManifest(new URL("../plugin.json", import.meta.url)),
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
