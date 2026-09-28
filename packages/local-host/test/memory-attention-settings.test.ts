import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PragmaPaths } from "@pragma/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecretStore, type OsKeychain } from "../src/secrets/secret-store.ts";
import { createMemoryAttentionSettingsStore } from "../src/memory-attention-settings.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragma-attention-settings-"));
  roots.push(root);
  const values = new Map<string, Uint8Array>();
  const keychain: OsKeychain = {
    inspect: async () => ({ status: "ready", backend: "macos-keychain" }),
    get: async (service, account) => values.get(`${service}:${account}`) ?? null,
    set: async (service, account, value) => {
      values.set(`${service}:${account}`, value);
    },
    delete: async (service, account) => {
      values.delete(`${service}:${account}`);
    },
  };
  const paths = new PragmaPaths({ pragmaHome: root });
  const secrets = createSecretStore({
    root: paths.secretStoreRoot(),
    dataRoot: paths.dataRoot(),
    keychain,
  });
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      model: "jev",
      answers: { valid: { type: "noul", noul: 1 } },
      usage: { input_tokens: 3, output_tokens: 1 },
    }),
  );
  const settings = createMemoryAttentionSettingsStore({
    pragmaHome: root,
    secrets,
    fetch: fetcher,
  });
  return { root, paths, secrets, settings, fetcher };
}
describe("Attention settings and credentials", () => {
  it("shares configuration through encrypted SecretRefs and rotates keys without leaking them", async () => {
    const f = await fixture();
    expect(await f.settings.status()).toEqual({
      revision: 0,
      configured: false,
      state: "disabled",
    });
    await f.settings.update({ expectedRevision: 0, apiKey: "private-first-key" });
    const first = await f.settings.get();
    const otherHost = createMemoryAttentionSettingsStore({
      pragmaHome: f.root,
      secrets: f.secrets,
    });
    expect(await otherHost.status()).toEqual({ revision: 1, configured: true, state: "ready" });
    expect(await readFile(f.paths.memoryAttentionSettings(), "utf8")).not.toContain(
      "private-first-key",
    );
    await f.settings.update({ expectedRevision: 1, apiKey: "private-second-key" });
    await expect(f.secrets.get(first.secretRef!)).rejects.toMatchObject({
      code: "SECRET_NOT_FOUND",
    });
    await f.settings.update({ expectedRevision: 2, apiKey: null });
    expect(await otherHost.status()).toEqual({ revision: 3, configured: false, state: "disabled" });
  });
  it("keeps the previous key on failed validation and rejects stale updates", async () => {
    const f = await fixture();
    await f.settings.update({ expectedRevision: 0, apiKey: "first-key" });
    f.fetcher.mockResolvedValueOnce(new Response("do not persist this", { status: 401 }));
    await expect(f.settings.update({ expectedRevision: 1, apiKey: "invalid-key" })).rejects.toThrow(
      "attention_auth_invalid",
    );
    expect((await f.settings.get()).revision).toBe(1);
    await expect(f.settings.update({ expectedRevision: 0, apiKey: null })).rejects.toThrow(
      "attention_settings_conflict",
    );
  });
  it("replays a credential rotation journal after the new credential has been written", async () => {
    const f = await fixture();
    await f.settings.update({ expectedRevision: 0, apiKey: "old-key" });
    const previous = await f.settings.get();
    await writeFile(
      `${f.paths.memoryAttentionSettings()}.journal`,
      JSON.stringify({
        schemaVersion: "pragma.memory-attention-settings-journal/v1",
        previous,
        providerId: "memory-attention-jev:crash-test",
      }),
    );
    const ref = await f.secrets.put({
      owner: { kind: "model-provider", providerId: "memory-attention-jev:crash-test" },
      value: Buffer.from("new-key"),
    });
    expect(await f.settings.get()).toMatchObject({ revision: 2, secretRef: ref });
    expect(await f.settings.get()).toMatchObject({ revision: 2, secretRef: ref });
    await expect(f.secrets.get(previous.secretRef!)).rejects.toMatchObject({
      code: "SECRET_NOT_FOUND",
    });
  });
  it("does not wake permanent errors on restart and ignores diagnostics for an old generation", async () => {
    const f = await fixture();
    await f.settings.update({ expectedRevision: 0, apiKey: "key" });
    await f.settings.recordDiagnostic("attention_auth_invalid", 1);
    await f.settings.recordDiagnostic(undefined, 1);
    expect(await f.settings.status()).toMatchObject({
      state: "needs_attention",
      errorCode: "attention_auth_invalid",
    });
    await f.settings.update({ expectedRevision: 1, apiKey: "repaired-key" });
    await f.settings.recordDiagnostic("attention_auth_invalid", 1);
    expect(await f.settings.status()).toMatchObject({ state: "ready" });
  });
});
