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

const createInput = {
  id: "market-research-analyst",
  name: "Market Research Analyst",
  description: "Analyzes market trends and consumer insights.",
  tags: ["research", "strategy"],
  version: "1.0.0",
  scope: "personal" as const,
  instructions: "Use evidence and state assumptions.",
  model: { modelName: "gpt-4.1" },
  skills: [],
  mcpServers: [
    {
      id: "docs",
      name: "docs",
      transport: "http" as const,
      url: "https://mcp.example.com",
      secretRefs: { token: "mcp/docs-token" },
    },
  ],
  toolIds: ["web-search"],
  toolApprovals: { "web-search": "ask" as const },
  plugins: [],
  contextStoreMounts: [],
};

describe("expert definition store", () => {
  it("stores a modular expert revision without binding it to a workspace", async () => {
    const { expertsPath, store } = await createStore();

    const expert = await store.create(createInput);

    expect(expert).toMatchObject({
      id: "market-research-analyst",
      scope: "personal",
      revision: 1,
      instructions: "Use evidence and state assumptions.",
      mcpServers: [expect.objectContaining({ secretRefs: { token: "mcp/docs-token" } })],
    });
    expect(await store.list()).toEqual([expect.objectContaining({ id: expert.id, revision: 1 })]);
    expect(await store.get(expert.id)).toEqual(expert);

    expect(await readFile(join(expertsPath, expert.id, "expert.json"), "utf8")).not.toContain(
      "workspace",
    );
    expect(
      await readFile(join(expertsPath, expert.id, "revisions", "000001", "mcp.json"), "utf8"),
    ).toContain("mcp/docs-token");
  });

  it("creates a new revision for updates while keeping the expert ID stable", async () => {
    const { expertsPath, store } = await createStore();
    const created = await store.create(createInput);

    const updated = await store.update(created.id, {
      ...createInput,
      name: "Market Intelligence Analyst",
      description: "Builds evidence-based market intelligence.",
      version: "1.1.0",
      instructions: "Prioritize traceable sources.",
    });

    expect(updated).toMatchObject({
      id: created.id,
      revision: 2,
      name: "Market Intelligence Analyst",
    });
    expect(
      await readFile(
        join(expertsPath, created.id, "revisions", "000002", "instructions.md"),
        "utf8",
      ),
    ).toBe("Prioritize traceable sources.");
    expect((await store.get(created.id)).revision).toBe(2);
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

    await expect(store.create(createInput)).rejects.toMatchObject({
      code: "expert_exists",
    } satisfies Partial<ExpertDefinitionStoreError>);
  });

  it("requires MCP secrets to use secret references", async () => {
    const { store } = await createStore();

    await expect(
      store.create({
        ...createInput,
        mcpServers: [
          {
            id: "docs",
            name: "docs",
            transport: "http",
            url: "https://mcp.example.com",
            env: { DOCS_TOKEN: "plaintext-secret" },
          },
        ],
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("requires transport-specific MCP connection fields", async () => {
    const { store } = await createStore();

    await expect(
      store.create({
        ...createInput,
        mcpServers: [{ id: "local", name: "local", transport: "stdio" }],
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      store.create({
        ...createInput,
        mcpServers: [{ id: "remote", name: "remote", transport: "http" }],
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});
