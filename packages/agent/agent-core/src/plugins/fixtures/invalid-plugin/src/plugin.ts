import { definePluginEntry } from "@expertmesh/agent-core";

export function createInvalidPlugin(): void {
  definePluginEntry({
    setup: () => ({}),
  });
}
