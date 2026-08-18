import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import { createCapabilityVerifier } from "./capability-verifier.ts";
import { createCapabilityStore, type CapabilityRevisionPublishInput } from "./capability-store.ts";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createStore(
  options: {
    readonly referenced?: boolean;
    readonly realVerifier?: boolean;
    readonly mcpToolRegistryPool?: Parameters<
      typeof createCapabilityStore
    >[0]["mcpToolRegistryPool"];
  } = {},
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
      ...(options.mcpToolRegistryPool === undefined
        ? {}
        : { mcpToolRegistryPool: options.mcpToolRegistryPool }),
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
  it("upgrades a valid v1 manifest and keeps a recovery backup", async () => {
    const { directory, store } = await createStore();
    const created = await store.create({ definition: httpDefinition, credentials: {} });
    const root = join(directory, "capabilities", created.manifest.id);
    await writeFile(
      join(root, "capability.json"),
      `${JSON.stringify({ ...created.manifest, schemaVersion: "pragma.capability/v1" })}\n`,
    );

    await expect(store.get(created.manifest.id)).resolves.toMatchObject({
      manifest: { schemaVersion: "pragma.capability/v2" },
    });
    await expect(
      readFile(join(root, "migration-backups", "capability.v1.json"), "utf8"),
    ).resolves.toContain("pragma.capability/v1");
  });

  it("leaves an over-limit v1 capability unchanged with an actionable diagnostic", async () => {
    const { directory, store } = await createStore();
    const created = await store.create({ definition: httpDefinition, credentials: {} });
    const root = join(directory, "capabilities", created.manifest.id);
    const legacyManifest = { ...created.manifest, schemaVersion: "pragma.capability/v1" };
    await writeFile(join(root, "capability.json"), `${JSON.stringify(legacyManifest)}\n`);
    await writeFile(
      join(root, "revisions", "000001", "definition.json"),
      `${JSON.stringify({ ...httpDefinition, name: "x".repeat(51) })}\n`,
    );

    await expect(store.get(created.manifest.id)).rejects.toMatchObject({
      code: "config_invalid",
      message: expect.stringContaining("name"),
    });
    await expect(store.list()).resolves.toEqual([]);
    await expect(readFile(join(root, "capability.json"), "utf8")).resolves.toContain(
      "pragma.capability/v1",
    );
  });

  it("replays an interrupted v1 manifest migration and rejects future schemas", async () => {
    const { directory, store } = await createStore();
    const created = await store.create({ definition: httpDefinition, credentials: {} });
    const root = join(directory, "capabilities", created.manifest.id);
    const legacyManifest = { ...created.manifest, schemaVersion: "pragma.capability/v1" };
    await writeFile(join(root, "capability.json"), `${JSON.stringify(legacyManifest)}\n`);
    await writeFile(
      join(root, "v1-to-v2.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.capability-manifest-migration/v1",
        sourceSchema: "pragma.capability/v1",
        targetSchema: "pragma.capability/v2",
        targetManifest: created.manifest,
      })}\n`,
    );

    await expect(store.get(created.manifest.id)).resolves.toMatchObject({
      manifest: { schemaVersion: "pragma.capability/v2" },
    });
    await expect(readFile(join(root, "v1-to-v2.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeFile(
      join(root, "capability.json"),
      `${JSON.stringify({ ...created.manifest, schemaVersion: "pragma.capability/v99" })}\n`,
    );
    await expect(store.get(created.manifest.id)).rejects.toMatchObject({ code: "config_invalid" });
    await expect(readFile(join(root, "capability.json"), "utf8")).resolves.toContain(
      "pragma.capability/v99",
    );
  });

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
    await expect(
      store.getSkillDocument({ id: capability.manifest.id, revision: 1 }),
    ).resolves.toEqual({
      capabilityId: capability.manifest.id,
      revision: 1,
      entryPath: "SKILL.md",
      content: "---\nname: repo-review\ndescription: Review a repository.\n---\n\n# Repo review\n",
    });
  });

  it("imports a ZIP whose Skill is wrapped in one top-level directory", async () => {
    const { directory, store } = await createStore();
    const archive = join(directory, "repo-review.zip");
    await writeFile(
      archive,
      zipSync({
        "repo-review/SKILL.md": strToU8(
          "---\nname: repo-review\ndescription: Review a repository.\n---\n",
        ),
        "repo-review/references/checklist.md": strToU8("Check tests.\n"),
        "__MACOSX/repo-review/._SKILL.md": strToU8("metadata"),
      }),
    );

    const capability = await store.importSkill({ sourcePath: archive });

    expect(capability.manifest.name).toBe("repo-review");
    await expect(store.listSkillFiles({ id: capability.manifest.id })).resolves.toEqual([
      { path: "references/checklist.md", size: 13 },
      { path: "SKILL.md", size: 60 },
    ]);
    await expect(
      store.getSkillFile({
        id: capability.manifest.id,
        path: "references/checklist.md",
      }),
    ).resolves.toMatchObject({
      capabilityId: capability.manifest.id,
      revision: 1,
      path: "references/checklist.md",
      content: "Check tests.\n",
    });
  });

  it("updates Skill files in a new revision while preserving identity and configuration", async () => {
    const { directory, store } = await createStore();
    const originalSource = join(directory, "original-skill");
    const updatedSource = join(directory, "updated-skill");
    await mkdir(originalSource);
    await mkdir(join(updatedSource, "assets"), { recursive: true });
    await writeFile(
      join(originalSource, "SKILL.md"),
      "---\nname: stable-name\ndescription: Stable description.\n---\n\nOriginal.\n",
    );
    await writeFile(
      join(updatedSource, "SKILL.md"),
      "---\nname: changed-name\ndescription: Changed description.\n---\n\nUpdated.\n",
    );
    await writeFile(join(updatedSource, "assets", "raw.bin"), new Uint8Array([0xff, 0xfe]));

    const original = await store.importSkill({ sourcePath: originalSource });
    if (original.definition.kind !== "skill") throw new Error("Expected a Skill capability.");
    const updated = await store.updateSkill({
      id: original.manifest.id,
      sourcePath: updatedSource,
    });

    expect(updated.manifest).toMatchObject({
      id: original.manifest.id,
      runtimeKey: original.manifest.runtimeKey,
      name: "stable-name",
      latestRevision: 2,
      createdAt: original.manifest.createdAt,
    });
    expect(updated.definition).toMatchObject({
      kind: "skill",
      name: "stable-name",
      description: "Stable description.",
    });
    expect(updated.definition).not.toMatchObject({ contentHash: original.definition.contentHash });
    await expect(
      store.getSkillDocument({ id: original.manifest.id, revision: 1 }),
    ).resolves.toMatchObject({ content: expect.stringContaining("Original.") });
    await expect(
      store.getSkillDocument({ id: original.manifest.id, revision: 2 }),
    ).resolves.toMatchObject({ content: expect.stringContaining("Updated.") });
    await expect(
      store.getSkillFile({ id: original.manifest.id, revision: 2, path: "assets/raw.bin" }),
    ).resolves.toMatchObject({ content: null, size: 2 });
  });

  it("reports corrupted or missing Skill package files with capability errors", async () => {
    const { directory, store } = await createStore();
    const source = join(directory, "source-skill");
    await mkdir(source);
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: readable\ndescription: Readable Skill.\n---\n",
    );
    const capability = await store.importSkill({ sourcePath: source });

    await expect(
      store.getSkillFile({ id: capability.manifest.id, path: "missing.md" }),
    ).rejects.toMatchObject({
      code: "config_invalid",
      message: "The Skill file no longer exists.",
    });

    await rm(
      join(directory, "capabilities", capability.manifest.id, "revisions", "000001", "payload"),
      { recursive: true },
    );
    await expect(store.listSkillFiles({ id: capability.manifest.id })).rejects.toMatchObject({
      code: "config_invalid",
      message: "Skill readable has unreadable package files.",
    });
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
    const publish = vi.fn(async (input: CapabilityRevisionPublishInput) => await input.commit());
    store.setRevisionPublisher({ publish });
    const updated = await store.update({
      id: created.manifest.id,
      definition: { ...httpDefinition, description: "Updated customer records." },
      credentials: {},
    });

    expect(updated.manifest.latestRevision).toBe(2);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]![0]).toMatchObject({
      current: { manifest: { latestRevision: 1 } },
      candidate: { manifest: { latestRevision: 2 } },
    });
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

  it("imports one Bundle capability identity with exact historical revisions idempotently", async () => {
    const { store } = await createStore();
    const logicalId = "00000000-0000-4000-8000-000000000190";
    const revisionOne = { ...httpDefinition, description: "Revision one." };
    const revisionTwo = { ...httpDefinition, description: "Revision two." };

    const imported = await store.importBundleRevisions({
      logicalId,
      revisions: [
        { revision: 2, definition: revisionTwo },
        { revision: 1, definition: revisionOne },
      ],
    });
    const reorderedRevisionTwo = {
      tools: revisionTwo.tools,
      timeoutMs: revisionTwo.timeoutMs,
      auth: revisionTwo.auth,
      baseUrl: revisionTwo.baseUrl,
      description: revisionTwo.description,
      name: revisionTwo.name,
      kind: revisionTwo.kind,
    };
    const repeated = await store.importBundleRevisions({
      logicalId,
      revisions: [
        { revision: 1, definition: revisionOne },
        { revision: 2, definition: reorderedRevisionTwo },
      ],
    });

    expect(repeated.manifest.id).toBe(imported.manifest.id);
    expect(repeated.manifest.origin).toEqual({ kind: "pragma-bundle", logicalId });
    expect((await store.get(imported.manifest.id, 1)).definition.description).toBe("Revision one.");
    expect((await store.get(imported.manifest.id, 2)).definition.description).toBe("Revision two.");
    await expect(store.list()).resolves.toHaveLength(1);
    await expect(
      store.importBundleRevisions({
        logicalId,
        revisions: [{ revision: 2, definition: { ...revisionTwo, description: "Conflict." } }],
      }),
    ).rejects.toMatchObject({ code: "bundle_identity_conflict" });
  });

  it("blocks deletion while an Expert references the capability", async () => {
    const { store } = await createStore({ referenced: true });
    const capability = await store.create({ definition: httpDefinition, credentials: {} });

    await expect(store.remove(capability.manifest.id)).rejects.toMatchObject({
      code: "capability_referenced",
    });
  });

  it("publishes the same revision when retry makes it ready", async () => {
    const { directory, store } = await createStore();
    const created = await store.create({ definition: httpDefinition, credentials: {} });
    await writeFile(
      join(directory, "capabilities", created.manifest.id, "health.json"),
      `${JSON.stringify({
        revision: 1,
        status: "needs_attention",
        checkedAt: "2026-07-11T00:00:00.000Z",
        diagnostic: { code: "offline", message: "Offline", retryable: true },
      })}\n`,
    );
    const publish = vi.fn(async (input: CapabilityRevisionPublishInput) => await input.commit());
    store.setRevisionPublisher({ publish });

    const retried = await store.retry(created.manifest.id);

    expect(retried).toMatchObject({
      manifest: { latestRevision: 1 },
      health: { revision: 1, status: "ready" },
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]![0]).toMatchObject({
      current: { health: { status: "needs_attention" } },
      candidate: { health: { status: "ready" } },
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

  it("returns a successful HTTP response as test output", async () => {
    const { store } = await createStore();
    const capability = await store.create({
      definition: httpDefinition,
      credentials: { "service-auth": "secret" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: "42", name: "Ada" })),
    );

    await expect(
      store.test({
        id: capability.manifest.id,
        toolName: "get_customer",
        input: { path: { id: "42" } },
      }),
    ).resolves.toMatchObject({
      ok: true,
      code: "success",
      output: { id: "42", name: "Ada" },
    });
  });

  it("calls a selected MCP tool and disposes its connection", async () => {
    const call = vi.fn(async (input: unknown) => ({ structuredContent: { echoed: input } }));
    const dispose = vi.fn(async () => undefined);
    const { store } = await createStore({
      mcpToolRegistryPool: {
        acquire: async () => ({
          registry: {
            tools: [
              {
                serverId: "capability",
                serverName: "Echo server",
                name: "echo",
                description: "Echo input.",
                inputSchema: { type: "object" },
                call,
              },
            ],
          },
          stats: {
            openedConnections: 1,
            reusedConnections: 0,
            coalescedConnections: 0,
          },
          release: dispose,
        }),
        close: async () => undefined,
      },
    });
    const capability = await store.create({
      definition: {
        kind: "mcp_server",
        name: "Echo server",
        description: "Echo input.",
        connection: { transport: "stdio", command: "node", args: [], env: {}, secretEnv: {} },
        timeoutMs: 30_000,
        tools: [
          {
            name: "echo",
            description: "Echo input.",
            inputSchema: { type: "object" },
            schemaHash: "a".repeat(64),
          },
        ],
      },
      credentials: {},
    });

    await expect(
      store.test({ id: capability.manifest.id, toolName: "echo", input: { value: "hello" } }),
    ).resolves.toMatchObject({
      ok: true,
      output: { echoed: { value: "hello" } },
      capability: { health: { status: "ready" } },
    });
    expect(call).toHaveBeenCalledWith({ value: "hello" }, undefined);
    expect(dispose).toHaveBeenCalledOnce();
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
