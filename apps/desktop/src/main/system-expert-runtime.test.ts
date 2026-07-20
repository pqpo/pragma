import { createStaticRuntimeResolver, defineRuntimeDriver } from "@pragma/core";
import { describe, expect, it } from "vitest";

import {
  resolveSystemExpertRuntimeDefaults,
  withRuntimeDefaults,
} from "./system-expert-runtime.ts";

describe("system Expert Runtime defaults", () => {
  it("pins the first configured PI model instead of falling through to PI agent defaults", async () => {
    const runtimes = createStaticRuntimeResolver({
      defaultRuntimeId: "pi",
      runtimes: [runtime("pi", "cloud-pi-agent")],
    });

    await expect(
      resolveSystemExpertRuntimeDefaults(runtimes, undefined, undefined),
    ).resolves.toEqual({
      runtimeId: "pi",
      modelSelection: { model: { providerId: "provider", modelId: "configured-model" } },
    });
  });

  it("uses a mission model override without changing the configured Runtime", async () => {
    const runtimes = createStaticRuntimeResolver({
      defaultRuntimeId: "pi",
      runtimes: [runtime("pi", "cloud-pi-agent"), runtime("codex", "codex-local")],
    });
    const defaults = await resolveSystemExpertRuntimeDefaults(
      runtimes,
      {
        runtimeId: "codex",
        providerId: "openai",
        modelId: "gpt-test",
      },
      {
        providerId: "openai",
        modelId: "gpt-test",
        thinkingLevel: "high",
      },
    );
    const scoped = withRuntimeDefaults(runtimes, defaults);

    expect(await scoped.getDefaultRuntimeId()).toBe("codex");
    expect(defaults.modelSelection).toEqual({
      model: { providerId: "openai", modelId: "gpt-test" },
      thinkingLevel: "high",
    });
  });
});

function runtime(id: string, kind: string) {
  return defineRuntimeDriver({
    descriptor: { id, kind, displayName: id },
    canUse: () => ({ usable: true }),
    listModels: async () => [
      {
        id: id === "pi" ? "configured-model" : "gpt-test",
        displayName: "Model",
        provider: {
          kind: id === "pi" ? ("registered" as const) : ("runtime-managed" as const),
          id: id === "pi" ? "provider" : "openai",
          displayName: "Provider",
        },
      },
    ],
    createSession: () => ({}),
    startTurn: () => ({ outputText: "" }),
    mapEvent: () => ({ events: [] }),
  });
}
