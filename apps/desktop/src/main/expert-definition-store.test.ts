import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createExpertDefinitionStore,
  ExpertDefinitionStoreError,
} from "./expert-definition-store.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "pragma-experts-"));
  directories.push(directory);
  return {
    expertsPath: join(directory, "experts"),
    store: createExpertDefinitionStore({ expertsPath: join(directory, "experts") }),
  };
}

async function downgradeExpertToV1(
  expertsPath: string,
  id: string,
  revisions: readonly number[],
  options: { readonly skills?: readonly unknown[] } = {},
): Promise<void> {
  const manifestPath = join(expertsPath, id, "expert.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, schemaVersion: "pragma.expert/v1" }, null, 2)}\n`,
    "utf8",
  );

  await Promise.all(
    revisions.flatMap((revision) => {
      const revisionPath = join(expertsPath, id, "revisions", revision.toString().padStart(6, "0"));
      return [
        rm(join(revisionPath, "capabilities.json"), { force: true }),
        writeFile(
          join(revisionPath, "skills.json"),
          `${JSON.stringify({ schemaVersion: 1, skills: options.skills ?? [] }, null, 2)}\n`,
          "utf8",
        ),
        writeFile(
          join(revisionPath, "mcp.json"),
          `${JSON.stringify({ schemaVersion: 1, servers: [] }, null, 2)}\n`,
          "utf8",
        ),
        writeFile(
          join(revisionPath, "tools.json"),
          `${JSON.stringify({ schemaVersion: 1, toolIds: [], approvals: createInput.toolApprovals }, null, 2)}\n`,
          "utf8",
        ),
      ];
    }),
  );
}

const createInput = {
  id: "market_analyst",
  name: "Market Analyst",
  description: "Analyzes market trends and consumer insights.",
  tags: ["research", "strategy"],
  version: "1.0.0",
  scope: "personal" as const,
  instructions: "Use evidence and state assumptions.",
  model: { runtimeId: "codex" as const, modelName: "gpt-4.1" },
  capabilities: [
    {
      kind: "tools" as const,
      capabilityId: "b4bda9e4-8f68-4f46-a4ef-fd4595512f22",
      revision: 1,
      toolNames: ["web-search"],
    },
  ],
  toolApprovals: { "web-search": "ask" as const },
  plugins: [],
  contextStoreMounts: [],
};

describe("expert definition store", () => {
  it("stores a modular expert revision without binding it to a workspace", async () => {
    const { expertsPath, store } = await createStore();

    const expert = await store.create(createInput);

    expect(expert).toMatchObject({
      id: "market_analyst",
      scope: "personal",
      revision: 1,
      instructions: "Use evidence and state assumptions.",
      capabilities: [expect.objectContaining({ toolNames: ["web-search"] })],
    });
    expect(await store.list()).toEqual([expect.objectContaining({ id: expert.id, revision: 1 })]);
    expect(await store.get(expert.id)).toEqual(expert);

    expect(await readFile(join(expertsPath, expert.id, "expert.json"), "utf8")).not.toContain(
      "workspace",
    );
    expect(
      await readFile(
        join(expertsPath, expert.id, "revisions", "000001", "capabilities.json"),
        "utf8",
      ),
    ).toContain("web-search");
  });

  it("creates a new revision for updates while keeping the expert ID stable", async () => {
    const { expertsPath, store } = await createStore();
    const created = await store.create(createInput);

    const updated = await store.update(created.id, {
      ...createInput,
      name: "Intel Analyst",
      description: "Builds evidence-based market intelligence.",
      version: "1.1.0",
      instructions: "Prioritize traceable sources.",
    });

    expect(updated).toMatchObject({
      id: created.id,
      revision: 2,
      name: "Intel Analyst",
    });
    expect(
      await readFile(
        join(expertsPath, created.id, "revisions", "000002", "instructions.md"),
        "utf8",
      ),
    ).toBe("Prioritize traceable sources.");
    expect((await store.get(created.id)).revision).toBe(2);
  });

  it("migrates legacy provider models to the PI runtime when reading an expert", async () => {
    const { expertsPath, store } = await createStore();
    const created = await store.create(createInput);
    const modelPath = join(expertsPath, created.id, "revisions", "000001", "model.json");
    const providerId = "5dbb6061-b5f2-4894-baaf-358af70651dc";
    await writeFile(
      modelPath,
      `${JSON.stringify({ schemaVersion: 1, model: { providerId, modelName: "deepseek-v4-flash" } }, null, 2)}\n`,
      "utf8",
    );

    await expect(store.get(created.id)).resolves.toMatchObject({
      model: { runtimeId: "pi", providerId, modelName: "deepseek-v4-flash" },
    });
    await expect(readFile(modelPath, "utf8")).resolves.toContain('"runtimeId": "pi"');
  });

  it("migrates every v1 revision to v2 before exposing stored experts", async () => {
    const { expertsPath, store } = await createStore();
    const created = await store.create(createInput);
    await store.update(created.id, {
      ...createInput,
      name: "Intel Analyst",
      version: "1.1.0",
    });
    await downgradeExpertToV1(expertsPath, created.id, [1, 2]);
    const migratedStore = createExpertDefinitionStore({ expertsPath });

    await expect(migratedStore.list()).resolves.toEqual([
      expect.objectContaining({
        schemaVersion: "pragma.expert/v2",
        id: created.id,
        revision: 2,
      }),
    ]);
    await expect(migratedStore.get(created.id)).resolves.toMatchObject({
      schemaVersion: "pragma.expert/v2",
      capabilities: [],
      toolApprovals: createInput.toolApprovals,
    });
    await expect(migratedStore.list()).resolves.toHaveLength(1);

    await expect(readFile(join(expertsPath, created.id, "expert.json"), "utf8")).resolves.toContain(
      '"schemaVersion": "pragma.expert/v2"',
    );
    for (const revision of ["000001", "000002"]) {
      await expect(
        readFile(join(expertsPath, created.id, "revisions", revision, "capabilities.json"), "utf8"),
      ).resolves.toContain('"capabilities": []');
    }
  });

  it("stops a v1 migration without changing the manifest when data needs manual conversion", async () => {
    const { expertsPath, store } = await createStore();
    const created = await store.create(createInput);
    await downgradeExpertToV1(expertsPath, created.id, [1], {
      skills: [{ type: "local", name: "legacy-skill" }],
    });
    const migratedStore = createExpertDefinitionStore({ expertsPath });

    await expect(migratedStore.list()).rejects.toMatchObject({
      code: "config_invalid",
      message: expect.stringContaining("legacy skills"),
    } satisfies Partial<ExpertDefinitionStoreError>);
    await expect(readFile(join(expertsPath, created.id, "expert.json"), "utf8")).resolves.toContain(
      '"schemaVersion": "pragma.expert/v1"',
    );
  });

  it("rejects updates for experts that do not exist", async () => {
    const { store } = await createStore();

    await expect(store.update(createInput.id, createInput)).rejects.toMatchObject({
      code: "expert_not_found",
    } satisfies Partial<ExpertDefinitionStoreError>);
  });

  it("deletes an expert and rejects repeated deletion", async () => {
    const { store } = await createStore();
    const created = await store.create(createInput);

    await store.remove(created.id);

    await expect(store.list()).resolves.toEqual([]);
    await expect(store.get(created.id)).rejects.toMatchObject({ code: "expert_not_found" });
    await expect(store.remove(created.id)).rejects.toMatchObject({ code: "expert_not_found" });
  });

  it("surfaces a corrupt manifest instead of silently hiding persisted data", async () => {
    const { expertsPath, store } = await createStore();
    const corruptPath = join(expertsPath, "corrupt-expert");
    await mkdir(corruptPath, { recursive: true });
    await writeFile(join(corruptPath, "expert.json"), "not-json", "utf8");

    await expect(store.list()).rejects.toMatchObject({
      code: "config_invalid",
    } satisfies Partial<ExpertDefinitionStoreError>);
  });

  it("rejects duplicate IDs", async () => {
    const { store } = await createStore();
    await store.create(createInput);

    await Promise.all(
      [createInput, { ...createInput, id: createInput.id.toUpperCase() }].map(async (input) => {
        await expect(store.create(input)).rejects.toMatchObject({
          code: "expert_exists",
        } satisfies Partial<ExpertDefinitionStoreError>);
      }),
    );
  });

  it("requires capability references to use valid IDs", async () => {
    const { store } = await createStore();

    await expect(
      store.create({
        ...createInput,
        capabilities: [
          {
            kind: "skill",
            capabilityId: "not-a-uuid",
            revision: 1,
          },
        ],
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("requires tool capability references to select at least one tool", async () => {
    const { store } = await createStore();

    await expect(
      store.create({
        ...createInput,
        capabilities: [
          {
            kind: "tools",
            capabilityId: "b4bda9e4-8f68-4f46-a4ef-fd4595512f22",
            revision: 1,
            toolNames: [],
          },
        ],
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
