import { definePluginEntry } from "@expertmesh/agent-core";

export function createMissingManifestPlugin(): void {
  definePluginEntry({
    setup: () => ({}),
  });
}
