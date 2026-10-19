import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLocalHostRuntimeConfiguration } from "@pragma/local-host/deployment";
import * as codex from "@pragma/runtime-codex";
import { createProductionLocalHost } from "../src/composition/default.ts";

describe("CLI saved Runtime composition", () => {
  it("restores a real pre-shared CLI binding exactly without creating new legacy bindings", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("./fixtures/pre-shared-runtime-binding.json", import.meta.url),
        "utf8",
      ),
    );
    const home = await mkdtemp(join(tmpdir(), "pragma-cli-legacy-runtime-"));
    vi.stubEnv("PRAGMA_HOME", home);
    const create = codex.createCodexRuntime;
    const listModels = vi.fn(async () => fixture.models);
    vi.spyOn(codex, "createCodexRuntime").mockImplementation((options) =>
      create({ ...options, listModels }),
    );
    const host = createProductionLocalHost();
    try {
      const resolver = host.runtimeResolver();
      const restored = await resolver.resolve({ binding: fixture.binding });
      expect(restored.binding).toEqual(fixture.binding);
      expect(restored.adapter.descriptor).toEqual(fixture.descriptor);
      const current = await resolver.bind({ runtimeId: "codex" });
      expect(current.adapter.descriptor.id).toBe("codex");
      expect(current.binding.fingerprint).not.toBe(fixture.binding.fingerprint);
      const discoveryCalls = listModels.mock.calls.length;
      await expect(
        resolver.resolve({
          binding: current.binding,
          modelSelection: { model: { providerId: "openai", modelId: "unavailable-model" } },
        }),
      ).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
        details: { diagnosticCode: "model_unavailable" },
      });
      expect(listModels.mock.calls).toHaveLength(discoveryCalls + 1);

      await expect(
        resolver.resolve({ binding: { ...fixture.binding, fingerprint: "invalid" } }),
      ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      await expect(
        resolver.resolve({ binding: { ...fixture.binding, revision: 2 } }),
      ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    } finally {
      await host.dispose?.();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps immutable Runtime identity, configured model selection and environment policy", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-cli-saved-runtime-"));
    const factory = vi.spyOn(codex, "createCodexRuntime");
    vi.stubEnv("PRAGMA_HOME", home);
    vi.stubEnv("PRAGMA_CONFIG_SECRET_CANARY", "must-not-inherit");
    const host = createProductionLocalHost();
    try {
      const configuration = createLocalHostRuntimeConfiguration({ pragmaHome: home });
      const first = await configuration.environments.create({
        schemaVersion: "pragma.runtime-environment/v1",
        origin: "registered",
        id: "saved-codex",
        displayName: "Saved Codex",
        adapter: { id: "pragma.runtime.codex", version: "v1" },
        config: {},
      });
      const resolver = host.runtimeResolver();
      const resolved = await resolver.bind({ runtimeId: first.runtimeId });
      expect(resolved.binding).toEqual({
        runtimeId: first.runtimeId,
        revision: first.revision,
        fingerprint: first.fingerprint,
      });
      expect(resolved.adapter.descriptor.id).toBe("saved-codex");
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxMode: "workspace-write", approvalPolicy: "on-request" }),
      );
      expect(factory.mock.calls.at(-1)?.[0]?.env).not.toHaveProperty("PRAGMA_CONFIG_SECRET_CANARY");
      await configuration.environments.update({
        definition: { ...first.definition, displayName: "Changed" },
        expectedRevision: first.revision,
      });
      expect((await resolver.resolve({ binding: resolved.binding })).binding).toEqual(
        resolved.binding,
      );
      await expect(resolver.bind({ runtimeId: "missing-runtime" })).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
      });
      const provider = await configuration.modelProviders.create({
        presetId: "ollama",
        name: "Saved models",
        protocol: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
        requiresApiKey: false,
        apiKey: "",
        models: [
          {
            kind: "generation",
            id: "configured-model",
            name: "Configured model",
            reasoning: false,
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            capabilitiesSource: "manual",
          },
        ],
      });
      const selected = { model: { providerId: provider.id, modelId: "configured-model" } };
      expect(
        (await resolver.bind({ runtimeId: "pi", modelSelection: selected })).adapter.descriptor.id,
      ).toBe("pi");
      await expect(
        resolver.bind({
          runtimeId: "pi",
          modelSelection: { model: { ...selected.model, modelId: "missing-model" } },
        }),
      ).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
        details: { diagnosticCode: "model_unavailable" },
      });
    } finally {
      await host.dispose?.();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });
});
