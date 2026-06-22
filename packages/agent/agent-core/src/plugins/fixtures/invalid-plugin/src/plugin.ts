import { definePluginEntry } from "../../../expert-agent-plugin.ts";

export function createInvalidPlugin(): void {
  definePluginEntry({
    setup: () => ({}),
  });
}
