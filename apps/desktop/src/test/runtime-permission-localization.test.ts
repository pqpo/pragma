import { createAntigravityRuntime } from "@pragma/runtime-antigravity";
import { createClaudeCodeRuntime } from "@pragma/runtime-claude-code";
import { createCodexRuntime } from "@pragma/runtime-codex";
import { createOpenCodeRuntime } from "@pragma/runtime-opencode";
import { createPiRuntime } from "@pragma/runtime-pi";
import { createQoderCliRuntime } from "@pragma/runtime-qodercli";
import { describe, expect, it } from "vitest";

import { i18n } from "../renderer/src/i18n/index.ts";

const runtimes = [
  createAntigravityRuntime(),
  createClaudeCodeRuntime(),
  createCodexRuntime(),
  createOpenCodeRuntime(),
  createPiRuntime(),
  createQoderCliRuntime(),
];

describe.each(["en", "zh-Hans", "zh-Hant"])("runtime permission translations in %s", (lng) => {
  it.each(runtimes)("covers the actual $descriptor.kind catalog", ({ descriptor }) => {
    expect(descriptor.permissionModes).toBeDefined();
    for (const mode of descriptor.permissionModes!.modes) {
      const keys = [
        i18n.exists(`permissionModeTitles.${descriptor.kind}.${mode.id}`, { ns: "studio", lng })
          ? `permissionModeTitles.${descriptor.kind}.${mode.id}`
          : `permissionModeLabels.${mode.id}`,
        `permissionModeDescriptions.${descriptor.kind}.${mode.id}`,
        ...(mode.reason ? [`permissionModeReasons.${descriptor.kind}.${mode.id}`] : []),
      ];
      for (const key of keys) {
        // Read the locale directly so English fallback cannot hide missing translations.
        const value: unknown = i18n.getResource(lng, "studio", key);
        expect(value, key).toBeTypeOf("string");
        expect(value, key).not.toBe("");
        if (lng !== "en") expect(value, key).not.toBe(i18n.getResource("en", "studio", key));
      }
    }
  });
});
