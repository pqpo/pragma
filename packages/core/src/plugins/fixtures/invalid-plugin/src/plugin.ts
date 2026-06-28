import { definePluginEntry } from "@expertmesh/core";

export function createInvalidPlugin(): void {
  definePluginEntry({
    setup: () => ({}),
  });
}
