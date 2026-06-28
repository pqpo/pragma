import { definePluginEntry } from "@expertmesh/core";

export function createMissingManifestPlugin(): void {
  definePluginEntry({
    setup: () => ({}),
  });
}
