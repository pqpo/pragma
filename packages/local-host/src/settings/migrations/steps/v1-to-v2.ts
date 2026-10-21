import { DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS } from "@pragma/shared";

import type { DesktopSettingsV1 } from "../schemas/v1.ts";
import { DesktopSettingsV1Schema } from "../schemas/v1.ts";

export const desktopSettingsV1ToV2Step = {
  fromVersion: 1,
  toVersion: 2,
  inputSchema: DesktopSettingsV1Schema,
  migrate(value: DesktopSettingsV1) {
    return {
      ...value,
      schemaVersion: 2 as const,
      agentContextWindow: DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
    };
  },
} as const;
