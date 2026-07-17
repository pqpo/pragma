import { definePluginEntry, readExpertAgentPluginManifest } from "../../../expert-agent-plugin.ts";

export function createInvalidPlugin(): void {
  definePluginEntry({
    manifest: readExpertAgentPluginManifest(new URL("../plugin.json", import.meta.url)),
    setup: () => ({}),
  });
}
