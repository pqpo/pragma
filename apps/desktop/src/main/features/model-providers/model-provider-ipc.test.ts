import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as localHost from "@pragma/local-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installModelProviderHandlers } from "./model-provider-ipc.ts";
import { createTestSecretStore } from "../credentials/test-secret-store.ts";
import { testProviderModel } from "./model-connectivity.ts";
import {
  createModelProviderStore,
  ModelProviderStoreError,
  type ModelProviderStore,
} from "./model-provider-store.ts";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    electron.handlers.set(channel, handler);
  }),
}));

vi.mock("electron", () => ({ ipcMain: { handle: electron.handle } }));
vi.mock("./model-connectivity.ts", () => ({ testProviderModel: vi.fn() }));
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(testProviderModel).mockReset();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("model provider IPC", () => {
  beforeEach(() => {
    electron.handlers.clear();
    electron.handle.mockClear();
  });

  it.each([true, false])(
    "persists a connection result (ok=%s) while recovering a pending migration",
    async (ok) => {
      const directory = await mkdtemp(join(tmpdir(), "pragma-model-provider-ipc-"));
      directories.push(directory);
      const configPath = join(directory, "model-providers.json");
      const { secretStore } = createTestSecretStore(join(directory, "secret-store"));
      const store = createModelProviderStore({ configPath, secretStore });
      const provider = await store.create({
        presetId: "qwen",
        name: "Qwen / Bailian",
        protocol: "openai-completions",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKey: "secret",
        requiresApiKey: true,
        models: [
          {
            kind: "embedding",
            id: "qwen3.7-text-embedding-flash",
            name: "qwen3.7-text-embedding-flash",
            api: "openai-embeddings",
            maxInputTokens: 128000,
            maxBatchInputs: 32,
            cost: { input: 0 },
            capabilitiesSource: "manual",
          },
        ],
      });
      const result = {
        ok,
        code: ok ? ("success" as const) : ("request_failed" as const),
        message: ok ? "Embedding ready." : "Connection failed.",
      };
      vi.mocked(testProviderModel).mockImplementationOnce(async () => {
        // Keep the real IPC/store/filesystem path; substitute only the remote probe.
        const read = localHost.readStoredModelProviderConfig;
        vi.spyOn(localHost, "readStoredModelProviderConfig").mockImplementationOnce(
          async (path) => {
            const current = await read(path);
            await writeFile(
              `${path}.state-migration.json`,
              JSON.stringify({
                schemaVersion: "pragma.state-migration/v1",
                resource: { family: "pragma.model-providers", id: "model-providers.json" },
                fromVersion: 6,
                toVersion: 7,
                documents: { "model-providers.json": current },
              }),
            );
            return current;
          },
        );
        return result;
      });
      installModelProviderHandlers(store);
      const testConnection = electron.handlers.get("model-providers:test")!;
      await expect(
        testConnection({}, { providerId: provider.id, modelId: provider.models[0]!.id }),
      ).resolves.toEqual(result);
      expect(testProviderModel).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: expect.objectContaining({ id: provider.id, apiKey: "secret" }),
          model: expect.objectContaining({ kind: "embedding", maxInputTokens: 128000 }),
        }),
      );
      const saved = JSON.parse(await readFile(configPath, "utf8")) as { providers: unknown[] };
      expect(saved.providers[0]).toMatchObject({
        revision: provider.revision,
        verification: {
          status: ok ? "verified" : "failed",
          code: result.code,
          message: result.message,
          revision: provider.revision,
        },
        models: [expect.objectContaining({ maxInputTokens: 128000, maxBatchInputs: 32 })],
      });
      await expect(access(`${configPath}.state-migration.json`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(`${configPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("returns an actionable discovery result when the edited provider was removed", async () => {
    const resolveDiscoveryApiKey = vi
      .fn()
      .mockRejectedValue(
        new ModelProviderStoreError("provider_not_found", "The provider no longer exists."),
      );
    installModelProviderHandlers({ resolveDiscoveryApiKey } as unknown as ModelProviderStore);

    const discover = electron.handlers.get("model-providers:discover");
    expect(discover).toBeDefined();

    await expect(
      discover?.(
        {},
        {
          presetId: "openai",
          protocol: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          providerId: "00000000-0000-4000-8000-000000000001",
        },
      ),
    ).resolves.toEqual({
      ok: false,
      models: [],
      message:
        "This provider was removed while it was being configured. Return to the provider list and add or select it again.",
      source: "manual",
    });
  });
});
