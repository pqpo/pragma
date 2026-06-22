import { definePluginEntry } from "../../../expert-agent-plugin.ts";

export function createMissingManifestPlugin(): void {
  definePluginEntry({
    setup: () => ({}),
  });
}
