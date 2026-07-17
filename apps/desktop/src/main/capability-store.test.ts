import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import { createCapabilityVerifier } from "./capability-verifier.ts";
import { createCapabilityStore } from "./capability-store.ts";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createStore(
  options: { readonly referenced?: boolean; readonly realVerifier?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pragma-capabilities-"));
  directories.push(directory);
  const secrets = new Map<string, string>();
  const credentials: CapabilityCredentialStore = {
    async setMany(id, values) {
      for (const [name, value] of Object.entries(values)) secrets.set(`${id}/${name}`, value);
    },
    async get(id, name) {
      return secrets.get(`${id}/${name}`);
    },
    async removeCapability(id) {
      for (const key of secrets.keys()) if (key.startsWith(`${id}/`)) secrets.delete(key);
    },
    async fingerprint() {
      return "a".repeat(64);
    },
  };
  return {
    directory,
    store: createCapabilityStore({
      capabilitiesPath: join(directory, "capabilities"),
      credentials,
      verify:
        options.realVerifier === true
          ? createCapabilityVerifier(credentials)
          : async (definition) => ({
              definition,
              health: { status: "ready" as const, checkedAt: "2026-07-11T00:00:00.000Z" },
            }),
      isReferenced: async () => options.referenced ?? false,
    }),
  };
}

const httpDefinition = {
  kind: "http_service" as const,
  name: "Customer API",
  description: "Customer records.",
  baseUrl: "https://api.example.test/v1",
  auth: { type: "bearer" as const, credentialRef: "service-auth" },
  timeoutMs: 30_000,
  tools: [
    {
      name: "get_customer",
      description: "Get a customer.",
      method: "GET" as const,
      path: "/customers/{id}",
      parameters: [
        { name: "id", location: "path" as const, required: true, type: "string" as const },
      ],
    },
  ],
};

const codeDefinition = {
  kind: "code_service" as const,
  name: "Calculator",
  description: "Add numbers.",
  language: "javascript" as const,
  timeoutMs: 2_000,
  tool: {
    name: "add",
    description: "Add two numbers.",
    inputSchema: {
      type: "object" as const,
      properties: { left: { type: "number" as const }, right: { type: "number" as const } },
      required: ["left", "right"],
      additionalProperties: false as const,
    },
    outputSchema: {
      type: "object" as const,
      properties: { result: { type: "number" as const } },
      required: ["result"],
      additionalProperties: false as const,
    },
    source: "function main(input) { return { result: input.left + input.right }; }",
  },
};

describe("capability store", () => {
  it("copies a Skill package into an immutable revision", async () => {
    const { directory, store } = await createStore();
    const source = join(directory, "source-skill");
    await mkdir(join(source, "references"), { recursive: true });
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: repo-review\ndescription: Review a repository.\n---\n\n# Repo review\n",
    );
    await writeFile(join(source, "references", "checklist.md"), "Check tests.\n");

    const capability = await store.importSkill({ sourcePath: source });

    expect(capability).toMatchObject({
      manifest: { kind: "skill", latestRevision: 1, name: "repo-review" },
      health: { status: "ready" },
      definition: { kind: "skill", entryPath: "SKILL.md" },
    });
    await expect(
      readFile(
        join(
          directory,
          "capabilities",
          capability.manifest.id,
          "revisions",
          "000001",
          "payload",
          "references",
          "checklist.md",
        ),
        "utf8",
      ),
    ).resolves.toBe("Check tests.\n");
  });

  it("rejects ZIP path traversal", async () => {
    const { directory, store } = await createStore();
    const archive = join(directory, "unsafe.zip");
    await writeFile(
      archive,
      zipSync({ "SKILL.md": strToU8("# Skill"), "../outside.txt": strToU8("unsafe") }),
    );

    await expect(
      store.importSkill({ sourcePath: archive, name: "Unsafe", description: "Unsafe." }),
    ).rejects.toMatchObject({
      code: "import_invalid",
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects symbolic links in Skill directories",
    async () => {
      const { directory, store } = await createStore();
      const source = join(directory, "linked-skill");
      await mkdir(source);
      await writeFile(join(source, "SKILL.md"), "---\nname: linked\ndescription: Linked.\n---\n");
      await writeFile(join(directory, "outside.txt"), "outside");
      await symlink(join(directory, "outside.txt"), join(source, "outside.txt"));

      await expect(store.importSkill({ sourcePath: source })).rejects.toMatchObject({
        code: "import_invalid",
      });
    },
  );

  it("creates fixed revisions and keeps credentials out of definitions", async () => {
    const { directory, store } = await createStore();
    const created = await store.create({
      definition: httpDefinition,
      credentials: { "service-auth": "top-secret" },
    });
    const updated = await store.update({
      id: created.manifest.id,
      definition: { ...httpDefinition, description: "Updated customer records." },
      credentials: {},
    });

    expect(updated.manifest.latestRevision).toBe(2);
    await expect(store.get(created.manifest.id, 1)).resolves.toMatchObject({
      definition: { description: "Customer records." },
    });
    const firstDefinition = await readFile(
      join(
        directory,
        "capabilities",
        created.manifest.id,
        "revisions",
        "000001",
        "definition.json",
      ),
      "utf8",
    );
    expect(firstDefinition).not.toContain("top-secret");
  });

  it("blocks deletion while an Expert references the capability", async () => {
    const { store } = await createStore({ referenced: true });
    const capability = await store.create({ definition: httpDefinition, credentials: {} });

    await expect(store.remove(capability.manifest.id)).rejects.toMatchObject({
      code: "capability_referenced",
    });
  });

  it("records an explicit HTTP test failure as needs attention", async () => {
    const { store } = await createStore();
    const capability = await store.create({
      definition: httpDefinition,
      credentials: { "service-auth": "secret" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })),
    );

    const result = await store.test({
      id: capability.manifest.id,
      toolName: "get_customer",
      input: { path: { id: "42" } },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "upstream_5xx",
      capability: { health: { status: "needs_attention" } },
    });
  });

  it("previews code without persisting it", async () => {
    const { store } = await createStore();

    await expect(
      store.previewCode({ definition: codeDefinition, input: { left: 2, right: 4 } }),
    ).resolves.toMatchObject({ ok: true, output: { result: 6 } });
    await expect(store.list()).resolves.toEqual([]);
  });

  it("rejects code revisions that do not compile", async () => {
    const { store } = await createStore({ realVerifier: true });

    await expect(
      store.create({
        definition: {
          ...codeDefinition,
          tool: { ...codeDefinition.tool, source: "const missingMain = true;" },
        },
        credentials: {},
      }),
    ).rejects.toMatchObject({ code: "config_invalid" });
    await expect(store.list()).resolves.toEqual([]);
  });

  it("tests saved code and records output contract failures", async () => {
    const { store } = await createStore();
    const capability = await store.create({ definition: codeDefinition, credentials: {} });

    await expect(
      store.test({ id: capability.manifest.id, input: { left: 2, right: 4 } }),
    ).resolves.toMatchObject({ ok: true, output: { result: 6 } });

    const broken = await store.update({
      id: capability.manifest.id,
      definition: {
        ...codeDefinition,
        tool: {
          ...codeDefinition.tool,
          source: "function main() { return { result: 'wrong' }; }",
        },
      },
      credentials: {},
    });
    await expect(
      store.test({ id: broken.manifest.id, input: { left: 1, right: 1 } }),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_output",
      capability: { health: { status: "needs_attention" } },
    });
  });
});
