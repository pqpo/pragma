import { definePluginEntry, readExpertAgentPluginManifest } from "../../../expert-agent-plugin.ts";

export function createMissingManifestPlugin(): void {
  definePluginEntry({
    manifest: readExpertAgentPluginManifest(new URL("../plugin.json", import.meta.url)),
    setup: () => ({}),
  });
}
