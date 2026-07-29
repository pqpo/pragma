import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../i18n/index.ts";
import {
  canonicalRuntimeDisplayName,
  runtimeDisplayName,
} from "./runtime-display.ts";

const legacyBuiltInRuntime = { id: "pi", displayName: "PI Runtime" };

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("runtime display names", () => {
  it("replaces a legacy built-in Runtime name in every supported locale", async () => {
    expect(runtimeDisplayName(i18n.t, legacyBuiltInRuntime)).toBe("Built-in Runtime");

    await i18n.changeLanguage("zh-Hans");
    expect(runtimeDisplayName(i18n.t, legacyBuiltInRuntime)).toBe("内置运行时");

    await i18n.changeLanguage("zh-Hant");
    expect(runtimeDisplayName(i18n.t, legacyBuiltInRuntime)).toBe("內建執行階段");
  });

  it("uses a locale-neutral canonical name for generated resources", () => {
    expect(canonicalRuntimeDisplayName(legacyBuiltInRuntime)).toBe("Built-in Runtime");
    expect(canonicalRuntimeDisplayName({ id: "codex", displayName: "Codex" })).toBe("Codex");
  });
});
