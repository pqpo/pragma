import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  error,
  matchContextPattern,
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
    required: true,
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return contextSystem;
}

describe("FileSystemContextStore", () => {
  it("loads AGENTS.md through generic preload and priority rules", async () => {
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
      contextSystem: new ContextSystem({
        store: new FileSystemContextStore({ rootDir }),
        roots: [
          {
            namespace: HOST_CONTEXT_NAMESPACE,
            load: {
              preloadPaths: [AGENTS_CONTEXT_ID],
              priorityRules: [{ pattern: AGENTS_CONTEXT_ID, priority: "critical" }],
            },
          },
        ],
      }),
    });

    const context = await agent.buildContext();

    expect(context.context).toContainEqual(
      expect.objectContaining({
        id: AGENTS_CONTEXT_ID,
        metadata: {
          trigger: "model_decision",
          priority: "critical",
        },
      }),
    );
    expect(context.systemPrompt).toContain("Available context index");
    expect(context.systemPrompt).toContain(AGENTS_CONTEXT_ID);
    expect(context.systemPrompt).toContain("Context access rules:");
    expect(context.systemPrompt).toContain("read_expert_context");
    expect(context.systemPrompt).toContain("edit_expert_context");
    expect(context.systemPrompt).toContain("not local filesystem paths");
    expect(context.systemPrompt).toContain("Do not use shell commands");
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
      "---\ndescription: Guide\ntrigger: manual\npriority: normal\n---\nGuide content.",
    );
    expect(created.ok).toBe(true);

    if (!created.ok) {
      return;
    }

    await expect(
      store.editContext({
        id: "guide.md",
        mode: "replace",
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
          matchType: "content",
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
          matchType: "content",
          lineNumber: 2,
          line: "Needle in a context.",
        },
      ],
    });
    expect(commands.map((command) => command.command)).toEqual(["rg", "grep"]);
    expect(commands[1]?.args).not.toContain("--recursive");
    expect(commands[1]?.args.at(-1)).toBe(contextPath);
  });

  it("searches context paths when scope=path", async () => {
    const rootDir = await createTempDir();
    const store = new FileSystemContextStore({ rootDir });
    await mkdir(join(rootDir, "guides"));
    await writeFile(join(rootDir, "guides", "guide.md"), "Guide", "utf8");

    await expect(
      store.searchContext({
        query: "guides/*.md",
        scope: "path",
      }),
    ).resolves.toEqual(
      ok([
        {
          id: "guides/guide.md",
          matchType: "path",
          line: "guides/guide.md",
        },
      ]),
    );
  });

  it("searches context paths case-insensitively for glob queries", async () => {
    const rootDir = await createTempDir();
    const store = new FileSystemContextStore({ rootDir });
    await mkdir(join(rootDir, "guides"));
    await writeFile(join(rootDir, "guides", "guide.md"), "Guide", "utf8");

    await expect(
      store.searchContext({
        query: "Guides/*.MD",
        scope: "path",
        caseSensitive: false,
      }),
    ).resolves.toEqual(
      ok([
        {
          id: "guides/guide.md",
          matchType: "path",
          line: "guides/guide.md",
        },
      ]),
    );
  });

  it("edits context content with search/replace", async () => {
    const rootDir = await createTempDir();
    const store = new FileSystemContextStore({ rootDir });
    await writeFile(join(rootDir, "guide.md"), "Alpha old old", "utf8");

    const created = await store.readContext({ id: "guide.md" });

    expect(created.ok).toBe(true);

    if (!created.ok) {
      return;
    }

    await expect(
      store.editContext({
        id: "guide.md",
        mode: "search_replace",
        search: "old",
        replace: "new",
        replaceAll: true,
        expectedRevision: created.value.revision,
      }),
    ).resolves.toMatchObject(
      ok({
        id: "guide.md",
        content: "Alpha new new",
        replacementCount: 2,
      }),
    );
  });

  it("discovers explicitly included non-Markdown text context", async () => {
    const rootDir = await createTempDir();
    await writeFile(join(rootDir, "notes.txt"), "Plain notes.", "utf8");

    await expect(new FileSystemContextStore({ rootDir }).listContext()).resolves.toEqual(ok([]));

    const store = new FileSystemContextStore({ rootDir, include: ["*.txt"] });
    await expect(store.listContext()).resolves.toMatchObject(
      ok([
        {
          id: "notes.txt",
          metadata: { trigger: "model_decision", priority: "normal" },
          sizeBytes: 12,
        },
      ]),
    );
    await expect(store.readContext({ id: "notes.txt" })).resolves.toMatchObject(
      ok({ id: "notes.txt", content: "Plain notes." }),
    );
  });

  it("rejects symlink escapes and excluded direct reads", async () => {
    const rootDir = await createTempDir();
    const outsideDir = await createTempDir();
    await writeFile(join(outsideDir, "secret.md"), "secret", "utf8");
    await symlink(join(outsideDir, "secret.md"), join(rootDir, "linked.md"));
    await writeFile(join(rootDir, "hidden.md"), "hidden", "utf8");
    const store = new FileSystemContextStore({ rootDir, exclude: ["hidden.md"] });

    await expect(store.readContext({ id: "linked.md" })).resolves.toMatchObject({
      ok: false,
      error: { code: "store_error" },
    });
    await expect(store.readContext({ id: "hidden.md" })).resolves.toMatchObject({
      ok: false,
      error: { code: "store_error" },
    });
  });

  it("enforces the store authorization callback", async () => {
    const rootDir = await createTempDir();
    await writeFile(join(rootDir, "guide.md"), "Guide", "utf8");
    const store = new FileSystemContextStore({
      rootDir,
      authorize: ({ operation, ids }) => (operation === "list" ? ids : []),
    });

    await expect(store.listContext()).resolves.toMatchObject({ ok: true });
    await expect(store.readContext({ id: "guide.md" })).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
  });

  it("batch-authorizes search matches after searching and before applying maxResults", async () => {
    const rootDir = await createTempDir();
    await writeFile(join(rootDir, "z-public.md"), "Needle public", "utf8");
    await writeFile(join(rootDir, "a-private.md"), "Needle private", "utf8");
    const privatePath = join(rootDir, "a-private.md");
    const publicPath = join(rootDir, "z-public.md");
    const authorizationCalls: Array<{
      readonly operation: string;
      readonly ids: readonly string[];
    }> = [];
    const store = new FileSystemContextStore({
      rootDir,
      commandRunner: async () => ({
        stdout: [
          JSON.stringify({
            type: "match",
            data: {
              path: { text: privatePath },
              lines: { text: "Needle private\n" },
              line_number: 1,
            },
          }),
          JSON.stringify({
            type: "match",
            data: {
              path: { text: publicPath },
              lines: { text: "Needle public\n" },
              line_number: 1,
            },
          }),
        ].join("\n"),
      }),
      authorize: ({ operation, ids }) => {
        authorizationCalls.push({ operation, ids });
        return ids.filter((id) => id === "z-public.md");
      },
    });

    await expect(store.listContext()).resolves.toMatchObject(
      ok([expect.objectContaining({ id: "z-public.md" })]),
    );
    await expect(store.searchContext({ query: "Needle", maxResults: 1 })).resolves.toEqual(
      ok([
        expect.objectContaining({
          id: "z-public.md",
          line: "Needle public",
        }),
      ]),
    );
    expect(authorizationCalls).toEqual([
      {
        operation: "list",
        ids: ["a-private.md", "z-public.md"],
      },
      {
        operation: "search",
        ids: ["a-private.md", "z-public.md"],
      },
    ]);
  });

  it("preserves file permissions when atomically editing context", async () => {
    const rootDir = await createTempDir();
    const filePath = join(rootDir, "private.md");
    await writeFile(filePath, "Private", "utf8");
    await chmod(filePath, 0o600);
    const store = new FileSystemContextStore({ rootDir });

    await expect(
      store.editContext({ id: "private.md", mode: "replace", content: "Updated" }),
    ).resolves.toMatchObject({ ok: true });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("lists a plain Markdown summary without decoding its full body", async () => {
    const rootDir = await createTempDir();
    await writeFile(join(rootDir, "binary-tail.md"), Buffer.from([0x23, 0x20, 0x41, 0x0a, 0xff]));
    const store = new FileSystemContextStore({ rootDir });

    await expect(store.listContext()).resolves.toMatchObject(
      ok([{ id: "binary-tail.md", sizeBytes: 5 }]),
    );
    await expect(store.readContext({ id: "binary-tail.md" })).resolves.toMatchObject({
      ok: false,
      error: { code: "store_error" },
    });
  });
});

describe("ContextSystem", () => {
  it("matches glob patterns without letting ? cross path separators", () => {
    expect(matchContextPattern("guides/a/guide.md", "guides/?/guide.md")).toBe(true);
    expect(matchContextPattern("guides/ab/guide.md", "guides/?/guide.md")).toBe(false);
    expect(matchContextPattern("guides/a/guide.md", "Guides/?/GUIDE.md", false)).toBe(true);
  });

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
    ).resolves.toMatchObject(
      ok([
        {
          id: "beta.md",
          matchType: "content",
          lineNumber: 1,
          line: "Beta needle.",
        },
      ]),
    );
  });

  it("does not assign special metadata to AGENTS.md", async () => {
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
      ok({
        items: [
          {
            namespace: HOST_CONTEXT_NAMESPACE,
            id: AGENTS_CONTEXT_ID,
            metadata: {
              description: "Store metadata should be preserved.",
              trigger: "manual",
              priority: "normal",
            },
          },
        ],
        issues: [],
      }),
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
          trigger: "manual",
          priority: "normal",
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
      ok({
        items: [
          {
            namespace: HOST_CONTEXT_NAMESPACE,
            id: "indexed.md",
            metadata: {
              trigger: "manual",
              priority: "normal",
            },
          },
        ],
        issues: [],
      }),
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
            priority: "critical",
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
      systemPromptCharacterBudget: 1_000,
      preloadByteBudget: 32,
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
  }, 10_000);

  it("keeps always-on content out of system prompt and injects it as startup context", async () => {
    const store = new CountingContextStore({
      context: [
        {
          id: "small.md",
          content: "Keep",
          metadata: {
            trigger: "always_on",
            priority: "critical",
          },
        },
        {
          id: "large.md",
          content: "Drop this large always-on content. ".repeat(80),
          metadata: {
            trigger: "always_on",
            priority: "low",
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
      systemPromptCharacterBudget: 1_000,
    });

    expect(context.systemPrompt).toContain("small.md");
    expect(context.systemPrompt).not.toContain("large.md");
    expect(context.systemPrompt).not.toContain("Keep");
    expect(context.systemPrompt).not.toContain("Drop this large always-on content.");
    expect(context.startupMessages[0]?.content).toContain("Keep");
    expect(context.startupMessages[0]?.content).toContain("Drop this large always-on content.");
    expect(context.context).not.toContainEqual(
      expect.objectContaining({
        id: "large.md",
        metadata: expect.objectContaining({
          trigger: "always_on",
        }),
      }),
    );
    expect(context.snapshot.truncationReason).toBe("context_budget_exceeded");
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

    await expect(
      agent.buildContext(undefined, {
        systemPromptCharacterBudget: 10,
      }),
    ).rejects.toMatchObject({
      code: "context_budget_exceeded",
    });
  });

  it("edits AGENTS.md metadata like any other context", async () => {
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
      contextSystem.edit({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: AGENTS_CONTEXT_ID,
        mode: "replace",
        content: "New instructions.",
        metadata: {
          description: "Updated metadata",
          trigger: "manual",
        },
      }),
    ).resolves.toMatchObject(
      ok({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: AGENTS_CONTEXT_ID,
        content: "New instructions.",
        metadata: {
          description: "Updated metadata",
          trigger: "manual",
          priority: "normal",
        },
      }),
    );
    expect(store.context.get(AGENTS_CONTEXT_ID)).toMatchObject({
      id: AGENTS_CONTEXT_ID,
      content: "New instructions.",
    });
  });

  it("edits in-memory metadata without serializing frontmatter", async () => {
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
      contextSystem.edit({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "guide.md",
        mode: "replace",
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

  it("rejects stale replace edits with optimistic locking", async () => {
    const store = new InMemoryContextStore({
      context: {
        "guide.md": "Original content.",
      },
    });
    const contextSystem = new ContextSystem({ store });

    await expect(
      contextSystem.edit({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "guide.md",
        mode: "replace",
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
          matchType: "content",
          lineNumber: 1,
          line: "Another search term here.",
        },
        {
          namespace: HOST_CONTEXT_NAMESPACE,
          id: "zeta.md",
          matchType: "content",
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
          matchType: "content",
          lineNumber: 1,
          line: "Needle in alpha.",
        },
        {
          namespace: "zzz",
          id: "omega.md",
          matchType: "content",
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
          matchType: "content",
          lineNumber: 1,
          line: "Needle in guide.",
        },
      ]),
    );
  });

  it("supports path search through ContextSystem without extra tools", async () => {
    const contextSystem = new ContextSystem({
      store: new InMemoryContextStore({
        context: {
          "guides/guide.md": "Guide content.",
        },
      }),
    });

    await expect(
      contextSystem.search({
        namespace: HOST_CONTEXT_NAMESPACE,
        query: "guides/*.md",
        scope: "path",
      }),
    ).resolves.toEqual(
      ok([
        {
          namespace: HOST_CONTEXT_NAMESPACE,
          id: "guides/guide.md",
          matchType: "path",
          line: "guides/guide.md",
        },
      ]),
    );
  });

  it("loads preloadPaths context and excludes forbidden paths from assembly", async () => {
    const store = new InMemoryContextStore({
      context: [
        {
          id: "manuals/index.md",
          content: "Summary",
          metadata: {
            trigger: "manual",
          },
        },
        {
          id: "manuals/profile.md",
          content: "Profile details.",
          metadata: {
            trigger: "manual",
          },
        },
        {
          id: "manuals/archive/old.md",
          content: "Archived",
          metadata: {
            trigger: "manual",
          },
        },
      ],
    });
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "root-agent",
      name: "Root Agent",
      description: "Tests root-based context assembly.",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: "/tmp/pragma-root-context-test",
      contextSystem: new ContextSystem({
        store,
        roots: [
          {
            namespace: HOST_CONTEXT_NAMESPACE,
            path: "manuals",
            load: {
              preloadPaths: ["manuals/profile.md"],
              forbiddenLoad: ["manuals/archive/**"],
            },
          },
        ],
      }),
    });

    const context = await agent.buildContext(undefined, {
      systemPromptCharacterBudget: 2_000,
    });

    expect(context.context.map((item) => item.id)).toEqual([
      "manuals/index.md",
      "manuals/profile.md",
    ]);
    expect(context.startupMessages[0]?.content).toContain("Profile details.");
    expect(context.snapshot.loadedContexts).toContainEqual({
      namespace: HOST_CONTEXT_NAMESPACE,
      id: "manuals/profile.md",
      reasons: ["preload_path"],
    });
    expect(context.snapshot.excludedContexts).toContainEqual({
      namespace: HOST_CONTEXT_NAMESPACE,
      id: "manuals/archive/old.md",
    });
  });

  it("tracks preload reasons from always_on and root preload paths", async () => {
    const contextSystem = new ContextSystem({
      store: new InMemoryContextStore({
        context: [
          {
            id: "manuals/index.md",
            content: "Summary",
            metadata: {
              trigger: "model_decision",
            },
          },
          {
            id: "manuals/profile.md",
            content: "Profile",
            metadata: {
              trigger: "manual",
            },
          },
        ],
      }),
      roots: [
        {
          namespace: HOST_CONTEXT_NAMESPACE,
          path: "manuals",
          load: {
            preloadPaths: ["manuals/profile.md"],
          },
        },
      ],
    });

    const indexed = await contextSystem.index();

    expect(indexed.ok).toBe(true);

    if (!indexed.ok) {
      return;
    }

    const selection = contextSystem.selectContext(indexed.value.items);

    expect(selection.context).toContainEqual(
      expect.objectContaining({
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "manuals/index.md",
        metadata: expect.objectContaining({
          trigger: "model_decision",
        }),
      }),
    );
    expect(selection.preload).toEqual([
      {
        namespace: HOST_CONTEXT_NAMESPACE,
        id: "manuals/profile.md",
        reasons: ["preload_path"],
      },
    ]);
  });

  it("orders preload selections after applying root priority rules", async () => {
    const contextSystem = new ContextSystem({
      store: new InMemoryContextStore({
        context: {
          "alpha.md": "Alpha",
          "critical.md": "Critical",
        },
      }),
      roots: [
        {
          namespace: HOST_CONTEXT_NAMESPACE,
          load: {
            preloadPaths: ["alpha.md", "critical.md"],
            priorityRules: [{ pattern: "critical.md", priority: "critical" }],
          },
        },
      ],
    });
    const indexed = await contextSystem.index();
    expect(indexed.ok).toBe(true);

    if (indexed.ok) {
      expect(
        contextSystem.selectContext(indexed.value.items).preload.map((item) => item.id),
      ).toEqual(["critical.md", "alpha.md"]);
    }
  });

  it("treats an empty root path as the namespace root", async () => {
    const contextSystem = new ContextSystem({
      store: new InMemoryContextStore({ context: { "guide.md": "Guide" } }),
      roots: [{ namespace: HOST_CONTEXT_NAMESPACE, path: "" }],
    });
    const indexed = await contextSystem.index();
    expect(indexed.ok).toBe(true);

    if (indexed.ok) {
      expect(contextSystem.selectContext(indexed.value.items).context).toContainEqual(
        expect.objectContaining({ id: "guide.md" }),
      );
    }
  });

  it("keeps the strongest priority across overlapping roots", async () => {
    const contextSystem = new ContextSystem({
      store: new InMemoryContextStore({ context: { "docs/guide.md": "Guide" } }),
      roots: [
        {
          namespace: HOST_CONTEXT_NAMESPACE,
          path: "docs",
          load: {
            priorityRules: [{ pattern: "docs/*.md", priority: "critical" }],
          },
        },
        {
          namespace: HOST_CONTEXT_NAMESPACE,
          load: {
            priorityRules: [{ pattern: "**", priority: "low" }],
          },
        },
      ],
    });
    const indexed = await contextSystem.index();
    expect(indexed.ok).toBe(true);

    if (indexed.ok) {
      expect(contextSystem.selectContext(indexed.value.items).context[0]?.metadata.priority).toBe(
        "critical",
      );
    }
  });

  it("registers context stores by namespace and rejects invalid registrations", async () => {
    const contextSystem = new ContextSystem();
    const store = new InMemoryContextStore({
      context: {
        "guide.md": "Guide content.",
      },
    });

    expect(contextSystem.register({ namespace: "plugin.docs", store })).toEqual(
      ok({ namespace: "plugin.docs", required: false }),
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

  it("keeps optional store failures as index issues and fails required stores", async () => {
    const available = new InMemoryContextStore({ context: { "guide.md": "Guide" } });
    const unavailable = new FailingListContextStore();
    const contextSystem = new ContextSystem();
    contextSystem.register({ namespace: "available", store: available });
    contextSystem.register({ namespace: "optional", store: unavailable });

    await expect(contextSystem.index()).resolves.toMatchObject(
      ok({
        items: [{ namespace: "available", id: "guide.md" }],
        issues: [
          {
            namespace: "optional",
            operation: "list",
            error: { code: "store_unavailable" },
          },
        ],
      }),
    );

    const requiredSystem = new ContextSystem();
    requiredSystem.register({ namespace: "required", store: unavailable, required: true });
    await expect(requiredSystem.index()).resolves.toMatchObject({
      ok: false,
      error: { code: "store_unavailable" },
    });
  });

  it("fails context assembly when a selected preload cannot be read", async () => {
    const store = new FailingReadContextStore({
      context: [
        {
          id: "required.md",
          content: "Required",
          metadata: { trigger: "always_on" },
        },
      ],
    });
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "failing-context-agent",
      name: "Failing Context Agent",
      description: "Tests preload failure handling.",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: "/tmp/pragma-failing-context-test",
      contextSystem: new ContextSystem({ store }),
    });

    await expect(agent.buildContext()).rejects.toMatchObject({
      code: "context_preload_failed",
    });
  });

  it("changes in-memory revisions for metadata-only edits", async () => {
    const store = new InMemoryContextStore({ context: { "guide.md": "Guide" } });
    const before = await store.readContext({ id: "guide.md" });
    expect(before.ok).toBe(true);

    if (!before.ok) {
      return;
    }

    const edited = await store.editContext({
      id: "guide.md",
      mode: "replace",
      metadata: { trigger: "manual", priority: "high" },
      expectedRevision: before.value.revision,
    });
    expect(edited.ok).toBe(true);

    if (edited.ok) {
      expect(edited.value.revision).not.toBe(before.value.revision);
    }
  });

  it("serializes concurrent file edits by expected revision", async () => {
    const rootDir = await createTempDir();
    const store = new FileSystemContextStore({ rootDir });
    await writeFile(join(rootDir, "guide.md"), "Original", "utf8");
    const before = await store.readContext({ id: "guide.md" });
    expect(before.ok).toBe(true);

    if (!before.ok) {
      return;
    }

    const results = await Promise.all([
      store.editContext({
        id: "guide.md",
        mode: "replace",
        content: "First",
        expectedRevision: before.value.revision,
      }),
      store.editContext({
        id: "guide.md",
        mode: "replace",
        content: "Second",
        expectedRevision: before.value.revision,
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)[0]).toMatchObject({
      ok: false,
      error: { code: "context_conflict" },
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

class FailingListContextStore extends InMemoryContextStore {
  override async listContext() {
    return error("store_unavailable", "Store is unavailable.");
  }
}

class FailingReadContextStore extends InMemoryContextStore {
  override async readContext() {
    return error("store_unavailable", "Context cannot be read.");
  }
}
