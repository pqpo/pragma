import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ExpertAgentContextStore,
  ExpertAgentStoredContextItemReadInput,
} from "../../src/context-system/context-system.ts";
import {
  AGENTS_CONTEXT_ID,
  ContextSystem,
  HOST_CONTEXT_NAMESPACE,
  ok,
} from "../../src/context-system/context-system.ts";
import { ExpertAgent } from "../../src/agent/expert-agent.ts";
import type { FileSystemContextStoreCommandRunner } from "../../src/context-system/file-system-context-store.ts";
import { FileSystemContextStore } from "../../src/context-system/file-system-context-store.ts";
import {
  createInMemoryContextStore,
  InMemoryContextStore,
} from "../../src/context-system/in-memory-context-store.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createHostContextSystem(store: ExpertAgentContextStore): ContextSystem {
  const contextSystem = new ContextSystem();
  const result = contextSystem.register({
    namespace: HOST_CONTEXT_NAMESPACE,
    store,
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return contextSystem;
}

describe("FileSystemContextStore", () => {
  it("loads AGENTS.md as an always-on context", async () => {
    const rootDir = await createTempDir();
    await writeFile(join(rootDir, AGENTS_CONTEXT_ID), "Use direct instructions.", "utf8");

    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "test-agent",
      name: "Test Agent",
      description: "Tests context-backed instructions.",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace: rootDir,
      contextSystem: createHostContextSystem(new FileSystemContextStore({ rootDir })),
    });

    const context = await agent.buildContext();

    expect(context.context).toContainEqual(
      expect.objectContaining({
        id: AGENTS_CONTEXT_ID,
        metadata: {
          trigger: "always_on",
        },
      }),
    );
    expect(context.systemPrompt).toContain("Available context index");
    expect(context.systemPrompt).toContain(AGENTS_CONTEXT_ID);
    expect(context.systemPrompt).not.toContain("Use direct instructions.");
    expect(context.systemPrompt).not.toContain("Reference material only");
    expect(context.startupMessages).toEqual([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Use direct instructions."),
      }),
    ]);
    expect(context.startupMessages[0]?.content).toContain("Always-on reference context");
    expect(context.startupMessages[0]?.content).toContain("Reference material only");
    expect(context.snapshot.contextRevisions[0]).toMatchObject({
      id: AGENTS_CONTEXT_ID,
    });
    expect(context.systemPrompt).not.toContain("AGENTS.md instructions:");
  });

  it("returns raw AGENTS.md content without parsing metadata", async () => {
    const rootDir = await createTempDir();
    const store = new FileSystemContextStore({ rootDir });
    await writeFile(join(rootDir, AGENTS_CONTEXT_ID), "Plain instructions.", "utf8");

    const result = await store.readContext({ id: AGENTS_CONTEXT_ID });

    expect(result).toMatchObject({
      ok: true,
      value: {
        id: AGENTS_CONTEXT_ID,
        content: "Plain instructions.",
      },
    });
  });

  it("reads markdown metadata in the file store and applies ranges to content only", async () => {
    const rootDir = await createTempDir();
    const store = new FileSystemContextStore({ rootDir });
    await writeFile(
      join(rootDir, "guide.md"),
      "---\ndescription: Guide\ntrigger: always_on\n---\nAlpha Beta Gamma",
      "utf8",
    );

    await expect(
      store.readContext({
        id: "guide.md",
        start: 6,
        offset: 4,
      }),
    ).resolves.toMatchObject(
      ok({
        id: "guide.md",
        content: "Beta",
        metadata: {
          description: "Guide",
          trigger: "always_on",
        },
        contentRange: {
          requestedStartOffset: 6,
          startOffset: 6,
          endOffset: 10,
          truncated: true,
          sizeBytes: 16,
          maxBytes: 4,
        },
      }),
    );
  });

  it("writes markdown metadata in the file store", async () => {
    const rootDir = await createTempDir();
    const store = new FileSystemContextStore({ rootDir });

    const created = await store.addContext({
      id: "guide.md",
      content: "Guide content.",
      metadata: {
        description: "Guide",
        trigger: "manual",
      },
    });

    expect(created).toMatchObject(
      ok({
        id: "guide.md",
        content: "Guide content.",
        metadata: {
          description: "Guide",
          trigger: "manual",
        },
      }),
    );
    await expect(readFile(join(rootDir, "guide.md"), "utf8")).resolves.toBe(
      "---\ndescription: Guide\ntrigger: manual\n---\nGuide content.",
    );
    expect(created.ok).toBe(true);

    if (!created.ok) {
      return;
    }

    await expect(
      store.updateContext({
        id: "guide.md",
        content: "Updated guide content.",
        expectedRevision: created.value.revision,
      }),
    ).resolves.toMatchObject(
      ok({
        id: "guide.md",
        content: "Updated guide content.",
        metadata: {
          description: "Guide",
          trigger: "manual",
        },
      }),
    );
  });

  it("searches markdown context with context lines", async () => {
    const rootDir = await createTempDir();
    const store = new FileSystemContextStore({ rootDir });
    await mkdir(join(rootDir, "guides"));
    await writeFile(
      join(rootDir, "guides", "search.md"),
      ["Alpha line.", "Needle in a context.", "Omega line."].join("\n"),
      "utf8",
    );
    await writeFile(join(rootDir, "ignored.txt"), "Needle outside markdown.", "utf8");

    const result = await store.searchContext({
      query: "needle",
      contextLines: 1,
      maxResults: 5,
    });

    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: "guides/search.md",
          lineNumber: 2,
          line: "Needle in a context.",
          before: ["Alpha line."],
          after: ["Omega line."],
        },
      ],
    });
  });

  it("falls back to grep when ripgrep is unavailable", async () => {
    const rootDir = await createTempDir();
    const commands: { readonly command: string; readonly args: readonly string[] }[] = [];
    const contextPath = join(rootDir, "search.md");
    await writeFile(contextPath, ["Alpha line.", "Needle in a context."].join("\n"), "utf8");

    const commandRunner: FileSystemContextStoreCommandRunner = async (command, args) => {
      commands.push({ command, args });

      if (command === "rg") {
        throw Object.assign(new Error("rg not found"), { code: "ENOENT" });
      }

      return {
        stdout: `${contextPath}:2:Needle in a context.\n`,
      };
    };
    const store = new FileSystemContextStore({ rootDir, commandRunner });

    await expect(
      store.searchContext({
        query: "Needle",
        maxResults: 5,
      }),
    ).resolves.toEqual({
      ok: true,
      value: [
        {
          id: "search.md",
          lineNumber: 2,
          line: "Needle in a context.",
        },
      ],
    });
    expect(commands.map((command) => command.command)).toEqual(["rg", "grep"]);
    expect(commands[1]?.args).toContain("--recursive");
    expect(commands[1]?.args.at(-1)).toBe(rootDir);
  });
});

describe("ContextSystem", () => {
  it("creates an in-memory context store from context settings", async () => {
    const store = createInMemoryContextStore({
      context: [
        {
          id: "alpha.md",
          content: "Alpha content.",
          metadata: {
            description: "Alpha",
            trigger: "manual",
          },
        },
        {
          id: "beta.md",
          content: "Beta needle.",
        },
      ],
    });

    await expect(store.listContext()).resolves.toMatchObject(
      ok([
        {
          id: "alpha.md",
          metadata: {
            description: "Alpha",
            trigger: "manual",
          },
        },
        {
          id: "beta.md",
          metadata: {
            trigger: "model_decision",
          },
        },
      ]),
    );
    await expect(
      store.searchContext({
        query: "needle",
        contextLines: 1,
        maxResults: 5,
      }),
    ).resolves.toEqual(
      ok([
        {
          id: "beta.md",
          lineNumber: 1,
          line: "Beta needle.",
        },
      ]),
    );
  });

  it("normalizes AGENTS.md as always-on for any context store", async () => {
    const store = new CountingContextStore({
      context: [
        {
          id: AGENTS_CONTEXT_ID,
          content: "Shared instructions.",
          metadata: {
            description: "Store metadata should be preserved.",
            trigger: "manual",
          },
        },
      ],
    });
    const contextSystem = new ContextSystem({ store });

    await expect(contextSystem.index()).resolves.toMatchObject(
      ok([
        {
          namespace: HOST_CONTEXT_NAMESPACE,
          id: AGENTS_CONTEXT_ID,
          metadata: {
            description: "Store metadata should be preserved.",
            trigger: "always_on",
          },
        },
      ]),
    );

    await expect(
      contextSystem.read({ namespace: HOST_CONTEXT_NAMESPACE, id: AGENTS_CONTEXT_ID }),
    ).resolves.toMatchObject(
      ok({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: AGENTS_CONTEXT_ID,
        content: "Shared instructions.",
        metadata: {
          description: "Store metadata should be preserved.",
          trigger: "always_on",
        },
      }),
    );
  });

  it("builds the index from store summaries without reading every context", async () => {
    const store = new CountingContextStore({
      context: [
        {
          id: "indexed.md",
          content: "Indexed content.",
          metadata: {
            trigger: "manual",
          },
        },
      ],
    });
    const contextSystem = new ContextSystem({ store });

    await expect(contextSystem.index()).resolves.toMatchObject(
      ok([
        {
          namespace: HOST_CONTEXT_NAMESPACE,
          id: "indexed.md",
          metadata: {
            trigger: "manual",
          },
        },
      ]),
    );
    expect(store.readCount).toBe(0);
  });

  it("passes run context into context assembly and snapshots truncated always-on context", async () => {
    const store = new CountingContextStore({
      context: [
        {
          id: "instructions.md",
          content: "Alpha " + "Gamma ".repeat(20),
          metadata: {
            trigger: "always_on",
          },
        },
      ],
    });
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "context-agent",
      name: "Context Agent",
      description: "Tests context assembly.",
      tags: [],
      version: "1.2.3",
      scope: "test",
      workspace: "/tmp/pragma-context-test",
      contextSystem: createHostContextSystem(store),
    });
    const runContext = {
      source: {
        type: "user",
        id: "user-1",
      },
      attributes: {
        tenantId: "tenant-1",
      },
    };

    const context = await agent.buildContext(runContext, {
      characterBudget: 1_000,
      contextReadByteBudget: 32,
    });

    expect(store.lastListContext).toEqual(runContext);
    expect(store.lastReadContext).toEqual(runContext);
    expect(store.lastReadInput).toMatchObject({
      id: "instructions.md",
      offset: 32,
    });
    expect(context.systemPrompt).toContain("instructions.md");
    expect(context.systemPrompt).not.toContain("Alpha");
    expect(context.systemPrompt).not.toContain("Context truncated");
    expect(context.startupMessages[0]?.content).toContain("Alpha");
    expect(context.startupMessages[0]?.content).toContain("Context truncated");
    expect(context.startupMessages[0]?.content).toContain("lines 1-1");
    expect(context.startupMessages[0]?.content).toContain(
      "Continue with read_expert_context start=32",
    );
    expect(context.startupMessages[0]?.content).toContain("offset<=32 bytes");
    expect(context.snapshot).toMatchObject({
      releaseDigest: "context-agent@1.2.3",
      truncationReason: "always_on_context_budget_exceeded",
      retrievedChunks: [
        {
          namespace: HOST_CONTEXT_NAMESPACE,
          contextId: "instructions.md",
          startOffset: 0,
          endOffset: 32,
          truncated: true,
        },
      ],
    });
  });

  it("keeps always-on content out of system prompt and injects it as startup context", async () => {
    const store = new CountingContextStore({
      context: [
        {
          id: "small.md",
          content: "Keep",
          metadata: {
            trigger: "always_on",
          },
        },
        {
          id: "large.md",
          content: "Drop this large always-on content. ".repeat(80),
          metadata: {
            trigger: "always_on",
          },
        },
      ],
    });
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "budget-agent",
      name: "Budget Agent",
      description: "Tests context budget downgrades.",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: "/tmp/pragma-budget-test",
      contextSystem: createHostContextSystem(store),
    });

    const context = await agent.buildContext(undefined, {
      characterBudget: 1_000,
    });

    expect(context.systemPrompt).toContain("small.md");
    expect(context.systemPrompt).toContain("large.md");
    expect(context.systemPrompt).not.toContain("Keep");
    expect(context.systemPrompt).not.toContain("Drop this large always-on content.");
    expect(context.startupMessages[0]?.content).toContain("Keep");
    expect(context.startupMessages[0]?.content).toContain("Drop this large always-on content.");
    expect(context.context).toContainEqual(
      expect.objectContaining({
        id: "large.md",
        metadata: expect.objectContaining({
          trigger: "always_on",
        }),
      }),
    );
    expect(context.snapshot.downgradedAlwaysOnContexts).toBeUndefined();
    expect(context.snapshot.truncationReason).toBeUndefined();
  });

  it("keeps namespaced always-on context indexed when prompt overhead exceeds the budget", async () => {
    const store = new CountingContextStore({
      context: [
        {
          id: "brief.md",
          content: "A",
          metadata: {
            trigger: "always_on",
          },
        },
      ],
    });
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "tiny-budget-agent",
      name: "Tiny Budget Agent",
      description: "Tests namespaced context budget downgrades.",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: "/tmp/pragma-tiny-budget-test",
      contextSystem: createHostContextSystem(store),
    });

    const context = await agent.buildContext(undefined, {
      characterBudget: 10,
    });

    expect(context.systemPrompt).not.toContain("content:");
    expect(context.context).toContainEqual(
      expect.objectContaining({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "brief.md",
        metadata: expect.objectContaining({
          trigger: "always_on",
        }),
      }),
    );
    expect(context.startupMessages[0]?.content).toContain("A");
    expect(context.snapshot.downgradedAlwaysOnContexts).toBeUndefined();
    expect(context.snapshot).toMatchObject({
      truncationReason: "context_budget_exceeded",
    });
  });

  it("drops AGENTS.md update metadata before calling the context store", async () => {
    const store = new InMemoryContextStore({
      context: [
        {
          id: AGENTS_CONTEXT_ID,
          content: "Old instructions.",
          metadata: {
            trigger: "manual",
          },
        },
      ],
    });
    const contextSystem = new ContextSystem({ store });

    await expect(
      contextSystem.update({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: AGENTS_CONTEXT_ID,
        content: "New instructions.",
        metadata: {
          description: "Ignored metadata",
          trigger: "manual",
        },
      }),
    ).resolves.toMatchObject(
      ok({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: AGENTS_CONTEXT_ID,
        content: "New instructions.",
        metadata: {
          trigger: "always_on",
        },
      }),
    );
    expect(store.context.get(AGENTS_CONTEXT_ID)).toMatchObject({
      id: AGENTS_CONTEXT_ID,
      content: "New instructions.",
    });
  });

  it("updates in-memory metadata without serializing frontmatter", async () => {
    const store = new InMemoryContextStore({
      context: [
        {
          id: "guide.md",
          content: "Old content.",
          metadata: {
            description: "Old guide",
            trigger: "manual",
          },
        },
      ],
    });
    const contextSystem = new ContextSystem({ store });

    await expect(
      contextSystem.update({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "guide.md",
        content: "New content.",
        metadata: {
          description: "New guide",
          trigger: "always_on",
        },
      }),
    ).resolves.toMatchObject(
      ok({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "guide.md",
        content: "New content.",
        metadata: {
          description: "New guide",
          trigger: "always_on",
        },
      }),
    );
    expect(store.context.get("guide.md")).toMatchObject({
      id: "guide.md",
      content: "New content.",
      metadata: {
        description: "New guide",
        trigger: "always_on",
      },
    });
  });

  it("rejects stale context updates with optimistic locking", async () => {
    const store = new InMemoryContextStore({
      context: {
        "guide.md": "Original content.",
      },
    });
    const contextSystem = new ContextSystem({ store });

    await expect(
      contextSystem.update({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "guide.md",
        content: "Changed content.",
        expectedRevision: "stale",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "context_conflict",
      },
    });
  });

  it("rejects context that exceed the configured size limit", async () => {
    const store = new InMemoryContextStore({
      maxContextBytes: 4,
    });
    const contextSystem = new ContextSystem({ store });

    await expect(
      contextSystem.add({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "large.md",
        content: "large",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "context_too_large",
      },
    });
  });

  it("does not enforce a framework context size limit when the store has no limit", async () => {
    const store = new InMemoryContextStore();
    const contextSystem = new ContextSystem({ store });

    await expect(
      contextSystem.add({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "large.md",
        content: "large",
      }),
    ).resolves.toMatchObject(
      ok({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "large.md",
        content: "large",
      }),
    );
  });

  it("reads context byte ranges", async () => {
    const store = new InMemoryContextStore({
      context: {
        "guide.md": "Alpha Beta Gamma",
      },
    });
    const contextSystem = new ContextSystem({ store });

    await expect(
      contextSystem.read({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "guide.md",
        start: 6,
        offset: 4,
      }),
    ).resolves.toMatchObject(
      ok({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "guide.md",
        content: "Beta",
        contentRange: {
          startOffset: 6,
          endOffset: 10,
          truncated: true,
          sizeBytes: 16,
          maxBytes: 4,
          startLine: 1,
          endLine: 1,
          totalLines: 1,
        },
      }),
    );
  });

  it("keeps ranged reads on valid UTF-8 boundaries", async () => {
    const store = new InMemoryContextStore({
      context: {
        "guide.md": "Alpha 你好 Gamma",
      },
    });
    const contextSystem = new ContextSystem({ store });

    await expect(
      contextSystem.read({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "guide.md",
        start: 6,
        offset: 5,
      }),
    ).resolves.toMatchObject(
      ok({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "guide.md",
        content: "你",
        contentRange: {
          requestedStartOffset: 6,
          startOffset: 6,
          endOffset: 9,
          nextStartOffset: 9,
          truncated: true,
        },
      }),
    );
  });

  it("preserves context metadata for partial reads", async () => {
    const store = new InMemoryContextStore({
      context: [
        {
          id: "guide.md",
          content: "Alpha Beta Gamma",
          metadata: {
            description: "Guide",
            trigger: "always_on",
          },
        },
      ],
    });
    const contextSystem = new ContextSystem({ store });

    await expect(
      contextSystem.read({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "guide.md",
        start: 8,
        offset: 5,
      }),
    ).resolves.toMatchObject(
      ok({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "guide.md",
        metadata: {
          description: "Guide",
          trigger: "always_on",
        },
      }),
    );
  });

  it("limits read tool output by default", async () => {
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "tool-agent",
      name: "Tool Agent",
      description: "Tests context tools.",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: "/tmp/pragma-tool-test",
      contextSystem: createHostContextSystem(
        new InMemoryContextStore({
          context: {
            "guide.md": "Alpha Beta Gamma",
          },
        }),
      ),
    });
    const readTool = agent
      .createDefaultTools({
        readByteBudget: 5,
        getContext: () => ({
          source: {
            type: "test",
          },
        }),
      })
      .find((tool) => tool.name === "read_expert_context");

    const result = await readTool?.call(
      {
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "guide.md",
      },
      undefined,
    );

    expect(result).toMatchObject({
      text: expect.stringContaining("Alpha"),
      details: {
        context: {
          content: "Alpha",
          contentRange: {
            endOffset: 5,
            truncated: true,
            maxBytes: 5,
            startLine: 1,
            endLine: 1,
            totalLines: 1,
          },
        },
      },
    });
    expect(result?.text).toContain("truncationNotice");
    expect(result?.text).toContain("16 total bytes");
    expect(result?.text).toContain("lines 1-1");
    expect(result?.text).toContain("Continue with start=5 and offset<=5 bytes");
  });

  it("searches context through the store and normalizes result ordering", async () => {
    const store = new InMemoryContextStore({
      context: [
        {
          id: "zeta.md",
          content: "Find the Search Term here.",
        },
        {
          id: "alpha.md",
          content: "Another search term here.",
        },
      ],
    });
    const contextSystem = new ContextSystem({ store });

    await expect(
      contextSystem.search({
        query: " search term ",
        maxResults: 10,
      }),
    ).resolves.toEqual(
      ok([
        {
          namespace: HOST_CONTEXT_NAMESPACE,
          id: "alpha.md",
          lineNumber: 1,
          line: "Another search term here.",
        },
        {
          namespace: HOST_CONTEXT_NAMESPACE,
          id: "zeta.md",
          lineNumber: 1,
          line: "Find the Search Term here.",
        },
      ]),
    );
  });

  it("searches all stores before sorting and applying maxResults", async () => {
    const firstStore = new InMemoryContextStore({
      context: [
        {
          id: "zeta.md",
          content: "Needle in zeta.",
        },
        {
          id: "omega.md",
          content: "Needle in omega.",
        },
      ],
    });
    const secondStore = new InMemoryContextStore({
      context: [
        {
          id: "alpha.md",
          content: "Needle in alpha.",
        },
      ],
    });
    const contextSystem = new ContextSystem({
      stores: [
        ["zzz", firstStore],
        ["aaa", secondStore],
      ],
    });

    await expect(
      contextSystem.search({
        query: "Needle",
        maxResults: 2,
      }),
    ).resolves.toEqual(
      ok([
        {
          namespace: "aaa",
          id: "alpha.md",
          lineNumber: 1,
          line: "Needle in alpha.",
        },
        {
          namespace: "zzz",
          id: "omega.md",
          lineNumber: 1,
          line: "Needle in omega.",
        },
      ]),
    );
  });

  it("returns no matches when searching all stores on an empty context system", async () => {
    const contextSystem = new ContextSystem();

    await expect(
      contextSystem.search({
        query: "Needle",
      }),
    ).resolves.toEqual(ok([]));
  });

  it("normalizes an explicit search namespace before returning matches", async () => {
    const contextSystem = new ContextSystem({
      stores: [
        [
          "docs",
          new InMemoryContextStore({
            context: {
              "guide.md": "Needle in guide.",
            },
          }),
        ],
      ],
    });

    await expect(
      contextSystem.search({
        namespace: " docs ",
        query: "Needle",
      }),
    ).resolves.toEqual(
      ok([
        {
          namespace: "docs",
          id: "guide.md",
          lineNumber: 1,
          line: "Needle in guide.",
        },
      ]),
    );
  });

  it("registers context stores by namespace and rejects invalid registrations", async () => {
    const contextSystem = new ContextSystem();
    const store = new InMemoryContextStore({
      context: {
        "guide.md": "Guide content.",
      },
    });

    expect(contextSystem.register({ namespace: "plugin.docs", store })).toEqual(
      ok({ namespace: "plugin.docs" }),
    );
    await expect(
      contextSystem.read({
        namespace: "plugin.docs",
        id: "guide.md",
      }),
    ).resolves.toMatchObject(
      ok({
        namespace: "plugin.docs",
        id: "guide.md",
        content: "Guide content.",
      }),
    );
    expect(contextSystem.register({ namespace: "plugin.docs", store })).toMatchObject({
      ok: false,
      error: {
        code: "context_already_exists",
      },
    });
    expect(contextSystem.register({ namespace: "bad/namespace", store })).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
      },
    });
  });

  it("returns namespace when deleting context through ContextSystem", async () => {
    const store = new InMemoryContextStore({
      context: {
        "guide.md": "Guide content.",
      },
    });
    const contextSystem = new ContextSystem({ store });

    await expect(
      contextSystem.delete({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "guide.md",
      }),
    ).resolves.toEqual(
      ok({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "guide.md",
      }),
    );
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pragma-agent-core-"));
  tempDirs.push(dir);
  return dir;
}

class CountingContextStore extends InMemoryContextStore {
  readCount = 0;
  lastListContext: unknown;
  lastReadContext: unknown;
  lastReadInput: ExpertAgentStoredContextItemReadInput | undefined;

  override async listContext(input = {}) {
    this.lastListContext = "context" in input ? input.context : undefined;
    return await super.listContext(input);
  }

  override async readContext(input: ExpertAgentStoredContextItemReadInput) {
    this.readCount += 1;
    this.lastReadContext = input.context;
    this.lastReadInput = input;
    return await super.readContext(input);
  }
}
