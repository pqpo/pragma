import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import { createCapabilityVerifier } from "./capability-verifier.ts";
import type { CapabilityVerifier } from "./capability-verification.ts";
import { createCapabilityStore, type CapabilityRevisionPublishInput } from "./capability-store.ts";
import { scanSkillWorkingTree } from "./skill-revision-draft-store.ts";

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
    readonly mutations?: Parameters<typeof createCapabilityStore>[0]["mutations"];
    readonly verify?: CapabilityVerifier;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pragma-capabilities-"));
  directories.push(directory);
  const secrets = new Map<string, string>();
  const pendingCredentials = new Map<
    string,
    { capabilityId: string; values: Readonly<Record<string, string>> }
  >();
  const credentials: CapabilityCredentialStore = {
    overlay(id, values) {
      return {
        get: async (requestedId, name) =>
          requestedId === id && Object.hasOwn(values, name)
            ? values[name]
            : secrets.get(`${requestedId}/${name}`),
      };
    },
    async setMany(id, values) {
      for (const [name, value] of Object.entries(values)) secrets.set(`${id}/${name}`, value);
    },
    async prepareMany(capabilityId, values) {
      if (Object.keys(values).length === 0) return undefined;
      const mutationId = randomUUID();
      pendingCredentials.set(mutationId, { capabilityId, values });
      return { mutationId, capabilityId, previousRefs: [], nextRefs: [] };
    },
    async activate(prepared) {
      const pending = pendingCredentials.get(prepared.mutationId);
      if (pending === undefined) return;
      for (const [name, value] of Object.entries(pending.values))
        secrets.set(`${pending.capabilityId}/${name}`, value);
    },
    async finalize(prepared) {
      pendingCredentials.delete(prepared.mutationId);
    },
    async rollback(prepared) {
      pendingCredentials.delete(prepared.mutationId);
    },
    async pending(capabilityId) {
      const entry = [...pendingCredentials.entries()].find(
        ([, pending]) => pending.capabilityId === capabilityId,
      );
      return entry === undefined
        ? undefined
        : { mutationId: entry[0], capabilityId, previousRefs: [], nextRefs: [] };
    },
    async get(id, name) {
      return secrets.get(`${id}/${name}`);
    },
    async removeCapability(id) {
      for (const key of secrets.keys()) if (key.startsWith(`${id}/`)) secrets.delete(key);
    },
    async fingerprint(id) {
      return createHash("sha256")
        .update(
          JSON.stringify(
            [...secrets.entries()]
              .filter(([key]) => key.startsWith(`${id}/`))
              .toSorted(([left], [right]) => left.localeCompare(right)),
          ),
        )
        .digest("hex");
    },
  };
  let mutationTail = Promise.resolve();
  const withMutationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  return {
    directory,
    credentials,
    store: createCapabilityStore({
      capabilitiesPath: join(directory, "capabilities"),
      credentials,
      ...(options.mcpToolRegistryPool === undefined
        ? {}
        : { mcpToolRegistryPool: options.mcpToolRegistryPool }),
      verify:
        options.verify ??
        (options.realVerifier === true
          ? createCapabilityVerifier(credentials)
          : async (definition) => ({
              definition,
              health: { status: "ready" as const, checkedAt: "2026-07-11T00:00:00.000Z" },
            })),
      mutations: options.mutations ?? {
        publish: async (input) =>
          await withMutationLock(async () => {
            await input.validateCurrent?.();
            const prepared = await input.prepareCredentials?.();
            try {
              const result = await input.commit();
              if (prepared !== undefined) {
                await credentials.activate(prepared);
                await credentials.finalize(prepared);
              }
              return result;
            } catch (error) {
              if (prepared !== undefined) await credentials.rollback(prepared);
              throw error;
            }
          }),
        publishHealth: async (input) =>
          await withMutationLock(async () => {
            await input.validateCurrent?.();
            const prepared = await input.prepareCredentials?.();
            try {
              const result = await input.commit();
              if (prepared !== undefined) {
                await credentials.activate(prepared);
                await credentials.finalize(prepared);
              }
              return result;
            } catch (error) {
              if (prepared !== undefined) await credentials.rollback(prepared);
              throw error;
            }
          }),
        mutate: async (input) =>
          await withMutationLock(async () => {
            await input.validateCurrent?.();
            await input.commit();
          }),
      },
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
  it("upgrades a valid v1 manifest through v3 and keeps a recovery backup", async () => {
    const { directory, store } = await createStore();
    const created = await store.create({ definition: httpDefinition, credentials: {} });
    const root = join(directory, "capabilities", created.manifest.id);
    await writeFile(
      join(root, "capability.json"),
      `${JSON.stringify({ ...created.manifest, schemaVersion: "pragma.capability/v1" })}\n`,
    );

    await expect(store.get(created.manifest.id)).resolves.toMatchObject({
      manifest: { schemaVersion: "pragma.capability/v4" },
    });
    await expect(
      readFile(join(root, "migration-backups", "capability.v1.json"), "utf8"),
    ).resolves.toContain("pragma.capability/v1");
  });

  it("removes Bundle identity while upgrading a v2 manifest without changing its local ID", async () => {
    const { directory, store } = await createStore();
    const fixture = JSON.parse(
      await readFile(
        new URL("./test-fixtures/capability-manifest-v2.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const id = String(fixture["id"]);
    const root = join(directory, "capabilities", id);
    await mkdir(join(root, "revisions", "000001"), { recursive: true });
    await writeFile(join(root, "capability.json"), `${JSON.stringify(fixture)}\n`);
    await writeFile(
      join(root, "revisions", "000001", "definition.json"),
      `${JSON.stringify({ ...httpDefinition, name: fixture["name"] })}\n`,
    );
    await writeFile(
      join(root, "health.json"),
      `${JSON.stringify({
        revision: 1,
        status: "ready",
        checkedAt: fixture["updatedAt"],
      })}\n`,
    );

    const migrated = await store.get(id);
    expect(migrated.manifest).toMatchObject({
      schemaVersion: "pragma.capability/v4",
      id,
      latestRevision: 1,
    });
    expect("origin" in migrated.manifest).toBe(false);
    await expect(
      readFile(join(root, "migration-backups", "capability.v2.json"), "utf8"),
    ).resolves.toContain("fedcba9876543210");
  });

  it("replays an interrupted v2 to v3 manifest journal from a historical fixture", async () => {
    const { directory, store } = await createStore();
    const fixture = JSON.parse(
      await readFile(
        new URL("./test-fixtures/capability-manifest-v2.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const id = String(fixture["id"]);
    const root = join(directory, "capabilities", id);
    const targetManifest = {
      ...fixture,
      schemaVersion: "pragma.capability/v3",
    } as Record<string, unknown>;
    delete targetManifest["origin"];
    await mkdir(join(root, "revisions", "000001"), { recursive: true });
    await writeFile(join(root, "capability.json"), `${JSON.stringify(fixture)}\n`);
    await writeFile(
      join(root, "revisions", "000001", "definition.json"),
      `${JSON.stringify({ ...httpDefinition, name: fixture["name"] })}\n`,
    );
    await writeFile(
      join(root, "health.json"),
      `${JSON.stringify({ revision: 1, status: "ready", checkedAt: fixture["updatedAt"] })}\n`,
    );
    await writeFile(
      join(root, "manifest-to-v3.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.capability-manifest-migration/v2",
        sourceSchema: "pragma.capability/v2",
        targetSchema: "pragma.capability/v3",
        targetManifest,
      })}\n`,
    );

    await expect(store.get(id)).resolves.toMatchObject({
      manifest: { schemaVersion: "pragma.capability/v4", id },
    });
    await expect(readFile(join(root, "manifest-to-v3.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not guess an active revision when a legacy manifest ends in needs attention", async () => {
    const { directory, store } = await createStore();
    const created = await store.create({ definition: httpDefinition, credentials: {} });
    const root = join(directory, "capabilities", created.manifest.id);
    const legacyManifest = {
      ...created.manifest,
      schemaVersion: "pragma.capability/v3",
      latestRevision: 3,
    } as Record<string, unknown>;
    delete legacyManifest["activeRevision"];
    for (const revision of [2, 3]) {
      await mkdir(join(root, "revisions", String(revision).padStart(6, "0")), {
        recursive: true,
      });
      await writeFile(
        join(root, "revisions", String(revision).padStart(6, "0"), "definition.json"),
        `${JSON.stringify({ ...httpDefinition, name: `Failed revision ${revision}` })}\n`,
      );
    }
    await writeFile(join(root, "capability.json"), `${JSON.stringify(legacyManifest)}\n`);
    await writeFile(
      join(root, "health.json"),
      `${JSON.stringify({
        revision: 3,
        status: "needs_attention",
        checkedAt: "2026-07-11T00:03:00.000Z",
        diagnostic: { code: "offline", message: "Offline", retryable: true },
      })}\n`,
    );

    await expect(store.get(created.manifest.id)).resolves.toMatchObject({
      manifest: { schemaVersion: "pragma.capability/v4", latestRevision: 3 },
      health: { status: "needs_attention" },
    });
    expect((await store.get(created.manifest.id)).manifest.activeRevision).toBeUndefined();
    await expect(store.resolveActive(created.manifest.id)).rejects.toMatchObject({
      code: "capability_not_found",
    });
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
        targetManifest: { ...created.manifest, schemaVersion: "pragma.capability/v2" },
      })}\n`,
    );

    await expect(store.get(created.manifest.id)).resolves.toMatchObject({
      manifest: { schemaVersion: "pragma.capability/v4" },
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

  it("preserves executable bits when publishing an immutable Skill candidate", async () => {
    const { directory, store } = await createStore();
    const originalSource = join(directory, "original-executable-skill");
    const candidateSource = join(directory, "candidate-executable-skill");
    await mkdir(originalSource);
    await mkdir(join(candidateSource, "scripts"), { recursive: true });
    const skillDocument =
      "---\nname: executable-skill\ndescription: Executable Skill.\n---\n\nRun checks.\n";
    await writeFile(join(originalSource, "SKILL.md"), skillDocument);
    await writeFile(join(candidateSource, "SKILL.md"), skillDocument);
    await writeFile(join(candidateSource, "scripts", "verify.mjs"), "process.exit(0);\n");
    await chmod(join(candidateSource, "scripts", "verify.mjs"), 0o755);

    const original = await store.importSkill({ sourcePath: originalSource });
    if (original.definition.kind !== "skill") throw new Error("Expected a Skill capability.");
    const snapshot = await scanSkillWorkingTree(candidateSource);
    const published = await store.publishSkillRevisionCandidate({
      id: original.manifest.id,
      baseRevision: original.manifest.latestRevision,
      baseContentHash: original.definition.contentHash,
      sourcePath: candidateSource,
      candidateContentHash: snapshot.hash,
    });
    const replayed = await store.publishSkillRevisionCandidate({
      id: original.manifest.id,
      baseRevision: original.manifest.latestRevision,
      baseContentHash: original.definition.contentHash,
      sourcePath: candidateSource,
      candidateContentHash: snapshot.hash,
    });

    expect(published.manifest.latestRevision).toBe(2);
    expect(replayed.manifest.latestRevision).toBe(2);
    const executable = await stat(
      join(
        directory,
        "capabilities",
        original.manifest.id,
        "revisions",
        "000002",
        "payload",
        "scripts",
        "verify.mjs",
      ),
    );
    expect(executable.mode & 0o111).not.toBe(0);
  });

  it("publishes a reviewed new Skill candidate idempotently as revision 1", async () => {
    const { directory, store } = await createStore();
    const source = join(directory, "new-skill-candidate");
    await mkdir(join(source, "scripts"), { recursive: true });
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: reviewed-skill\ndescription: Reviewed Skill.\n---\n\nFollow it.\n",
    );
    await writeFile(join(source, "scripts", "verify.mjs"), "process.exit(0);\n");
    await chmod(join(source, "scripts", "verify.mjs"), 0o755);
    const snapshot = await scanSkillWorkingTree(source);
    const id = "0123456789abcdef";

    const published = await store.publishNewSkillRevisionCandidate({
      id,
      name: "reviewed-skill",
      description: "Reviewed Skill.",
      sourcePath: source,
      candidateContentHash: snapshot.hash,
    });
    const replayed = await store.publishNewSkillRevisionCandidate({
      id,
      name: "reviewed-skill",
      description: "Reviewed Skill.",
      sourcePath: source,
      candidateContentHash: snapshot.hash,
    });

    expect(published.manifest.latestRevision).toBe(1);
    expect("origin" in published.manifest).toBe(false);
    expect(replayed.manifest.latestRevision).toBe(1);
    const formalHash = createHash("sha256");
    for (const path of ["SKILL.md", "scripts/verify.mjs"]) {
      formalHash.update(path);
      formalHash.update(await readFile(join(source, ...path.split("/"))));
    }
    expect(published.definition.kind).toBe("skill");
    if (published.definition.kind !== "skill") throw new Error("Expected a Skill capability.");
    expect(published.definition.contentHash).toBe(formalHash.digest("hex"));
    expect(published.definition.contentHash).not.toBe(snapshot.hash);
    await expect(
      stat(
        join(
          directory,
          "capabilities",
          id,
          "revisions",
          "000001",
          "payload",
          "scripts",
          "verify.mjs",
        ),
      ),
    ).resolves.toMatchObject({ mode: expect.any(Number) });
    await store.remove(id, 1);
    expect((await store.list()).some((capability) => capability.manifest.id === id)).toBe(false);
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
    const publish = vi.fn(async (input: CapabilityRevisionPublishInput) => await input.commit());
    const { directory, store } = await createStore({
      mutations: {
        publish,
        publishHealth: async (input) => await input.commit(),
        mutate: async (input) => await input.commit(),
      },
    });
    const created = await store.create({
      definition: httpDefinition,
      credentials: { "service-auth": "top-secret" },
    });
    const updated = await store.update({
      id: created.manifest.id,
      baseRevision: created.manifest.latestRevision,
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

  it("keeps the previous revision active until replacement credentials are activated", async () => {
    const { credentials, store } = await createStore();
    const created = await store.create({
      definition: httpDefinition,
      credentials: { "service-auth": "initial" },
    });
    const activate = credentials.activate.bind(credentials);
    vi.spyOn(credentials, "activate").mockImplementation(async (prepared) => {
      await expect(store.resolveActive(created.manifest.id)).resolves.toMatchObject({
        manifest: { activeRevision: 1 },
        definition: { description: "Customer records." },
      });
      await activate(prepared);
    });

    const updated = await store.update({
      id: created.manifest.id,
      baseRevision: 1,
      definition: { ...httpDefinition, description: "Updated customer records." },
      credentials: { "service-auth": "replacement" },
    });

    expect(updated.manifest.latestRevision).toBe(2);
    await expect(store.resolveActive(created.manifest.id)).resolves.toMatchObject({
      manifest: { activeRevision: 1 },
      definition: { description: "Customer records." },
    });
  });

  it("removes a new Capability and its staged credentials when activation fails", async () => {
    const { credentials, store } = await createStore();
    vi.spyOn(credentials, "activate").mockRejectedValueOnce(new Error("activation failed"));

    await expect(
      store.create({
        definition: httpDefinition,
        credentials: { "service-auth": "must-not-survive" },
      }),
    ).rejects.toThrow("activation failed");

    await expect(store.list()).resolves.toEqual([]);
  });

  it("finishes activation when creation recovery finds a durable ready revision", async () => {
    const { directory, store } = await createStore();
    const created = await store.create({ definition: httpDefinition, credentials: {} });
    const root = join(directory, "capabilities", created.manifest.id);
    const inactiveManifest = { ...created.manifest } as Record<string, unknown>;
    delete inactiveManifest["activeRevision"];
    await writeFile(join(root, "capability.json"), `${JSON.stringify(inactiveManifest)}\n`);
    await writeFile(
      join(root, "creation.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.capability-creation/v1",
        capabilityId: created.manifest.id,
      })}\n`,
    );

    await expect(store.get(created.manifest.id)).resolves.toMatchObject({
      manifest: { activeRevision: 1 },
      health: { status: "ready" },
    });
    await expect(readFile(join(root, "creation.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not create a revision for a semantically unchanged definition", async () => {
    const { directory, store } = await createStore();
    const created = await store.create({ definition: httpDefinition, credentials: {} });
    const updated = await store.update({
      id: created.manifest.id,
      baseRevision: created.manifest.latestRevision,
      definition: { ...httpDefinition },
      credentials: {},
    });

    expect(updated.manifest.latestRevision).toBe(1);
    await expect(
      readFile(
        join(
          directory,
          "capabilities",
          created.manifest.id,
          "revisions",
          "000002",
          "definition.json",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not rotate credentials or health for an identical save", async () => {
    const { directory, credentials, store } = await createStore();
    const created = await store.create({
      definition: httpDefinition,
      credentials: { "service-auth": "same-secret" },
    });
    const prepareMany = vi.spyOn(credentials, "prepareMany");

    const saved = await store.update({
      id: created.manifest.id,
      baseRevision: created.manifest.latestRevision,
      definition: httpDefinition,
      credentials: { "service-auth": "same-secret" },
    });

    expect(saved.manifest.latestRevision).toBe(1);
    expect(prepareMany).not.toHaveBeenCalled();
    await expect(
      readFile(join(directory, "capabilities", created.manifest.id, "revisions", "000002")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an update based on a stale capability revision", async () => {
    const { store } = await createStore();
    const created = await store.create({ definition: httpDefinition, credentials: {} });

    await expect(
      store.update({
        id: created.manifest.id,
        baseRevision: created.manifest.latestRevision + 1,
        definition: { ...httpDefinition, description: "Stale update." },
        credentials: {},
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("rejects the stale result of concurrent credential-only updates", async () => {
    let verificationCount = 0;
    let concurrentVerifications = 0;
    let releaseConcurrent!: () => void;
    const concurrentReady = new Promise<void>((resolve) => {
      releaseConcurrent = resolve;
    });
    const verify: CapabilityVerifier = async (definition) => {
      verificationCount += 1;
      if (verificationCount > 1) {
        concurrentVerifications += 1;
        if (concurrentVerifications === 2) releaseConcurrent();
        await concurrentReady;
      }
      return {
        definition,
        health: { status: "ready", checkedAt: "2026-07-11T00:00:00.000Z" },
      };
    };
    const { store } = await createStore({ verify });
    const created = await store.create({
      definition: httpDefinition,
      credentials: { "service-auth": "initial" },
    });

    const results = await Promise.allSettled([
      store.update({
        id: created.manifest.id,
        baseRevision: 1,
        definition: httpDefinition,
        credentials: { "service-auth": "first" },
      }),
      store.update({
        id: created.manifest.id,
        baseRevision: 1,
        definition: httpDefinition,
        credentials: { "service-auth": "second" },
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "revision_conflict" },
    });
    await expect(store.get(created.manifest.id)).resolves.toMatchObject({
      manifest: { latestRevision: 1 },
    });
  });

  it("blocks deletion while an Expert references the capability", async () => {
    const { store } = await createStore({ referenced: true });
    const capability = await store.create({ definition: httpDefinition, credentials: {} });

    await expect(store.remove(capability.manifest.id)).rejects.toMatchObject({
      code: "capability_referenced",
    });
  });

  it("publishes the same revision when retry makes it ready", async () => {
    const publish = vi.fn(async (input: CapabilityRevisionPublishInput) => await input.commit());
    const { directory, store } = await createStore({
      mutations: {
        publish,
        publishHealth: async (input) => await input.commit(),
        mutate: async (input) => await input.commit(),
      },
    });
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

    const retried = await store.retry(created.manifest.id, created.manifest.latestRevision);

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

  it("keeps resolving the previous active revision while the latest revision needs attention", async () => {
    let verification = 0;
    const { store } = await createStore({
      verify: async (definition) => ({
        definition,
        health:
          verification++ === 0
            ? { status: "ready", checkedAt: "2026-07-11T00:00:00.000Z" }
            : {
                status: "needs_attention",
                checkedAt: "2026-07-11T00:01:00.000Z",
                diagnostic: { code: "offline", message: "Offline", retryable: true },
              },
      }),
    });
    const created = await store.create({ definition: httpDefinition, credentials: {} });
    const updated = await store.update({
      id: created.manifest.id,
      baseRevision: 1,
      definition: { ...httpDefinition, name: "Updated HTTP service" },
      credentials: {},
    });

    expect(updated).toMatchObject({
      manifest: { latestRevision: 2, activeRevision: 1 },
      health: { status: "needs_attention" },
    });
    await expect(store.resolveActive(created.manifest.id)).resolves.toMatchObject({
      manifest: { latestRevision: 1, activeRevision: 1 },
      definition: { name: httpDefinition.name },
    });
  });

  it("activates the latest revision when retry recovers a needs-attention candidate", async () => {
    const healthStates = ["ready", "needs_attention", "ready"] as const;
    let verification = 0;
    const { store } = await createStore({
      verify: async (definition) => {
        const status = healthStates[verification++] ?? "ready";
        return {
          definition,
          health:
            status === "ready"
              ? { status, checkedAt: "2026-07-11T00:00:00.000Z" }
              : {
                  status,
                  checkedAt: "2026-07-11T00:01:00.000Z",
                  diagnostic: { code: "offline", message: "Offline", retryable: true },
                },
        };
      },
    });
    const created = await store.create({ definition: httpDefinition, credentials: {} });
    const failed = await store.update({
      id: created.manifest.id,
      baseRevision: 1,
      definition: { ...httpDefinition, name: "Recovered HTTP service" },
      credentials: {},
    });

    const recovered = await store.retry(created.manifest.id, failed.manifest.latestRevision);

    expect(recovered).toMatchObject({
      manifest: { latestRevision: 2, activeRevision: 2 },
      health: { revision: 2, status: "ready" },
    });
    await expect(store.resolveActive(created.manifest.id)).resolves.toMatchObject({
      manifest: { latestRevision: 2, activeRevision: 2 },
      definition: { name: "Recovered HTTP service" },
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
      expectedRevision: capability.manifest.latestRevision,
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
        expectedRevision: capability.manifest.latestRevision,
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
      store.test({
        id: capability.manifest.id,
        expectedRevision: capability.manifest.latestRevision,
        toolName: "echo",
        input: { value: "hello" },
      }),
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
      store.test({
        id: capability.manifest.id,
        expectedRevision: capability.manifest.latestRevision,
        input: { left: 2, right: 4 },
      }),
    ).resolves.toMatchObject({ ok: true, output: { result: 6 } });

    const broken = await store.update({
      id: capability.manifest.id,
      baseRevision: capability.manifest.latestRevision,
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
      store.test({
        id: broken.manifest.id,
        expectedRevision: broken.manifest.latestRevision,
        input: { left: 1, right: 1 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "invalid_output",
      capability: { health: { status: "needs_attention" } },
    });
  });
});
