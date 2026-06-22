import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ExpertAgentDocumentReadInput } from "./document-indexer.ts";
import { AGENTS_DOCUMENT_ID, DocumentIndexer, ok } from "./document-indexer.ts";
import { ExpertAgent } from "../agent/expert-agent.ts";
import type { FileSystemDocumentStoreCommandRunner } from "./file-system-document-store.ts";
import { FileSystemDocumentStore } from "./file-system-document-store.ts";
import { createInMemoryDocumentStore, InMemoryDocumentStore } from "./in-memory-document-store.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FileSystemDocumentStore", () => {
  it("loads AGENTS.md as an always-on document", async () => {
    const rootDir = await createTempDir();
    await writeFile(join(rootDir, AGENTS_DOCUMENT_ID), "Use direct instructions.", "utf8");

    const agent = new ExpertAgent({
      schemaVersion: "expertmesh.expert/v1",
      id: "test-agent",
      displayName: "Test Agent",
      description: "Tests document-backed instructions.",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace: rootDir,
      documents: new FileSystemDocumentStore({ rootDir }),
    });

    const context = await agent.buildContext();

    expect(context.documents).toContainEqual(
      expect.objectContaining({
        id: AGENTS_DOCUMENT_ID,
        metadata: {
          trigger: "always_on",
        },
      }),
    );
    expect(context.systemPrompt).toContain("Always-on reference documents");
    expect(context.systemPrompt).toContain(AGENTS_DOCUMENT_ID);
    expect(context.systemPrompt).toContain("Use direct instructions.");
    expect(context.systemPrompt).toContain("Reference material only");
    expect(context.snapshot.documentRevisions[0]).toMatchObject({
      id: AGENTS_DOCUMENT_ID,
    });
    expect(context.systemPrompt).not.toContain("AGENTS.md instructions:");
  });

  it("returns raw AGENTS.md content without parsing metadata", async () => {
    const rootDir = await createTempDir();
    const store = new FileSystemDocumentStore({ rootDir });
    await writeFile(join(rootDir, AGENTS_DOCUMENT_ID), "Plain instructions.", "utf8");

    const result = await store.readDocument({ id: AGENTS_DOCUMENT_ID });

    expect(result).toMatchObject({
      ok: true,
      value: {
        id: AGENTS_DOCUMENT_ID,
        content: "Plain instructions.",
      },
    });
  });

  it("reads markdown metadata in the file store and applies ranges to content only", async () => {
    const rootDir = await createTempDir();
    const store = new FileSystemDocumentStore({ rootDir });
    await writeFile(
      join(rootDir, "guide.md"),
      "---\ndescription: Guide\ntrigger: always_on\n---\nAlpha Beta Gamma",
      "utf8",
    );

    await expect(
      store.readDocument({
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
    const store = new FileSystemDocumentStore({ rootDir });

    const created = await store.createDocument({
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
      store.updateDocument({
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

  it("searches markdown documents with context lines", async () => {
    const rootDir = await createTempDir();
    const store = new FileSystemDocumentStore({ rootDir });
    await mkdir(join(rootDir, "guides"));
    await writeFile(
      join(rootDir, "guides", "search.md"),
      ["Alpha line.", "Needle in a document.", "Omega line."].join("\n"),
      "utf8",
    );
    await writeFile(join(rootDir, "ignored.txt"), "Needle outside markdown.", "utf8");

    const result = await store.searchDocuments({
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
          line: "Needle in a document.",
          before: ["Alpha line."],
          after: ["Omega line."],
        },
      ],
    });
  });

  it("falls back to grep when ripgrep is unavailable", async () => {
    const rootDir = await createTempDir();
    const commands: { readonly command: string; readonly args: readonly string[] }[] = [];
    const documentPath = join(rootDir, "search.md");
    await writeFile(documentPath, ["Alpha line.", "Needle in a document."].join("\n"), "utf8");

    const commandRunner: FileSystemDocumentStoreCommandRunner = async (command, args) => {
      commands.push({ command, args });

      if (command === "rg") {
        throw Object.assign(new Error("rg not found"), { code: "ENOENT" });
      }

      return {
        stdout: `${documentPath}:2:Needle in a document.\n`,
      };
    };
    const store = new FileSystemDocumentStore({ rootDir, commandRunner });

    await expect(
      store.searchDocuments({
        query: "Needle",
        maxResults: 5,
      }),
    ).resolves.toEqual({
      ok: true,
      value: [
        {
          id: "search.md",
          lineNumber: 2,
          line: "Needle in a document.",
        },
      ],
    });
    expect(commands.map((command) => command.command)).toEqual(["rg", "grep"]);
    expect(commands[1]?.args).toContain("--recursive");
    expect(commands[1]?.args.at(-1)).toBe(rootDir);
  });
});

describe("DocumentIndexer", () => {
  it("creates an in-memory document store from document settings", async () => {
    const store = createInMemoryDocumentStore({
      documents: [
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

    await expect(store.listDocuments()).resolves.toMatchObject(
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
      store.searchDocuments({
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

  it("normalizes AGENTS.md as always-on for any document store", async () => {
    const store = new CountingDocumentStore({
      documents: [
        {
          id: AGENTS_DOCUMENT_ID,
          content: "Shared instructions.",
          metadata: {
            description: "Store metadata should be preserved.",
            trigger: "manual",
          },
        },
      ],
    });
    const indexer = new DocumentIndexer({ store });

    await expect(indexer.index()).resolves.toMatchObject(
      ok([
        {
          id: AGENTS_DOCUMENT_ID,
          metadata: {
            description: "Store metadata should be preserved.",
            trigger: "always_on",
          },
        },
      ]),
    );

    await expect(indexer.read({ id: AGENTS_DOCUMENT_ID })).resolves.toMatchObject(
      ok({
        id: AGENTS_DOCUMENT_ID,
        content: "Shared instructions.",
        metadata: {
          description: "Store metadata should be preserved.",
          trigger: "always_on",
        },
      }),
    );
  });

  it("builds the index from store summaries without reading every document", async () => {
    const store = new CountingDocumentStore({
      documents: [
        {
          id: "indexed.md",
          content: "Indexed content.",
          metadata: {
            trigger: "manual",
          },
        },
      ],
    });
    const indexer = new DocumentIndexer({ store });

    await expect(indexer.index()).resolves.toMatchObject(
      ok([
        {
          id: "indexed.md",
          metadata: {
            trigger: "manual",
          },
        },
      ]),
    );
    expect(store.readCount).toBe(0);
  });

  it("passes run context into context assembly and snapshots truncated always-on documents", async () => {
    const store = new CountingDocumentStore({
      documents: [
        {
          id: "instructions.md",
          content: "Alpha " + "Gamma ".repeat(20),
          metadata: {
            trigger: "always_on",
          },
        },
      ],
    });
    const agent = new ExpertAgent({
      schemaVersion: "expertmesh.expert/v1",
      id: "context-agent",
      displayName: "Context Agent",
      description: "Tests context assembly.",
      tags: [],
      version: "1.2.3",
      scope: "test",
      workspace: "/tmp/expertmesh-context-test",
      documents: store,
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
      documentReadByteBudget: 32,
    });

    expect(store.lastListContext).toEqual(runContext);
    expect(store.lastReadContext).toEqual(runContext);
    expect(store.lastReadInput).toMatchObject({
      id: "instructions.md",
      offset: 32,
    });
    expect(context.systemPrompt).toContain("Alpha");
    expect(context.systemPrompt).toContain("Document truncated");
    expect(context.systemPrompt).toContain("lines 1-1");
    expect(context.systemPrompt).toContain("Continue with read_expert_document start=32");
    expect(context.systemPrompt).toContain("offset<=32 bytes");
    expect(context.snapshot).toMatchObject({
      releaseDigest: "context-agent@1.2.3",
      truncationReason: "always_on_document_budget_exceeded",
      retrievedChunks: [
        {
          documentId: "instructions.md",
          startOffset: 0,
          endOffset: 32,
          truncated: true,
        },
      ],
    });
  });

  it("downgrades always-on documents to model decision until context fits", async () => {
    const store = new CountingDocumentStore({
      documents: [
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
    const agent = new ExpertAgent({
      schemaVersion: "expertmesh.expert/v1",
      id: "budget-agent",
      displayName: "Budget Agent",
      description: "Tests context budget downgrades.",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: "/tmp/expertmesh-budget-test",
      documents: store,
    });

    const context = await agent.buildContext(undefined, {
      characterBudget: 1_000,
    });

    expect(context.systemPrompt).toContain("Keep");
    expect(context.systemPrompt).not.toContain("Drop this large always-on content.");
    expect(context.documents).toContainEqual(
      expect.objectContaining({
        id: "large.md",
        metadata: expect.objectContaining({
          trigger: "model_decision",
        }),
      }),
    );
    expect(context.snapshot).toMatchObject({
      downgradedAlwaysOnDocuments: ["large.md"],
      truncationReason: "always_on_document_budget_exceeded",
    });
  });

  it("drops AGENTS.md update metadata before calling the document store", async () => {
    const store = new InMemoryDocumentStore({
      documents: [
        {
          id: AGENTS_DOCUMENT_ID,
          content: "Old instructions.",
          metadata: {
            trigger: "manual",
          },
        },
      ],
    });
    const indexer = new DocumentIndexer({ store });

    await expect(
      indexer.update({
        id: AGENTS_DOCUMENT_ID,
        content: "New instructions.",
        metadata: {
          description: "Ignored metadata",
          trigger: "manual",
        },
      }),
    ).resolves.toMatchObject(
      ok({
        id: AGENTS_DOCUMENT_ID,
        content: "New instructions.",
        metadata: {
          trigger: "always_on",
        },
      }),
    );
    expect(store.documents.get(AGENTS_DOCUMENT_ID)).toMatchObject({
      id: AGENTS_DOCUMENT_ID,
      content: "New instructions.",
    });
  });

  it("updates in-memory metadata without serializing frontmatter", async () => {
    const store = new InMemoryDocumentStore({
      documents: [
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
    const indexer = new DocumentIndexer({ store });

    await expect(
      indexer.update({
        id: "guide.md",
        content: "New content.",
        metadata: {
          description: "New guide",
          trigger: "always_on",
        },
      }),
    ).resolves.toMatchObject(
      ok({
        id: "guide.md",
        content: "New content.",
        metadata: {
          description: "New guide",
          trigger: "always_on",
        },
      }),
    );
    expect(store.documents.get("guide.md")).toMatchObject({
      id: "guide.md",
      content: "New content.",
      metadata: {
        description: "New guide",
        trigger: "always_on",
      },
    });
  });

  it("rejects stale document updates with optimistic locking", async () => {
    const store = new InMemoryDocumentStore({
      documents: {
        "guide.md": "Original content.",
      },
    });
    const indexer = new DocumentIndexer({ store });

    await expect(
      indexer.update({
        id: "guide.md",
        content: "Changed content.",
        expectedRevision: "stale",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "document_conflict",
      },
    });
  });

  it("rejects documents that exceed the configured size limit", async () => {
    const store = new InMemoryDocumentStore({
      maxDocumentBytes: 4,
    });
    const indexer = new DocumentIndexer({ store });

    await expect(
      indexer.create({
        id: "large.md",
        content: "large",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "document_too_large",
      },
    });
  });

  it("does not enforce a framework document size limit when the store has no limit", async () => {
    const store = new InMemoryDocumentStore();
    const indexer = new DocumentIndexer({ store });

    await expect(
      indexer.create({
        id: "large.md",
        content: "large",
      }),
    ).resolves.toMatchObject(
      ok({
        id: "large.md",
        content: "large",
      }),
    );
  });

  it("reads document byte ranges", async () => {
    const store = new InMemoryDocumentStore({
      documents: {
        "guide.md": "Alpha Beta Gamma",
      },
    });
    const indexer = new DocumentIndexer({ store });

    await expect(
      indexer.read({
        id: "guide.md",
        start: 6,
        offset: 4,
      }),
    ).resolves.toMatchObject(
      ok({
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
    const store = new InMemoryDocumentStore({
      documents: {
        "guide.md": "Alpha 你好 Gamma",
      },
    });
    const indexer = new DocumentIndexer({ store });

    await expect(
      indexer.read({
        id: "guide.md",
        start: 6,
        offset: 5,
      }),
    ).resolves.toMatchObject(
      ok({
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

  it("preserves document metadata for partial reads", async () => {
    const store = new InMemoryDocumentStore({
      documents: [
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
    const indexer = new DocumentIndexer({ store });

    await expect(
      indexer.read({
        id: "guide.md",
        start: 8,
        offset: 5,
      }),
    ).resolves.toMatchObject(
      ok({
        id: "guide.md",
        metadata: {
          description: "Guide",
          trigger: "always_on",
        },
      }),
    );
  });

  it("limits read tool output by default", async () => {
    const agent = new ExpertAgent({
      schemaVersion: "expertmesh.expert/v1",
      id: "tool-agent",
      displayName: "Tool Agent",
      description: "Tests document tools.",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: "/tmp/expertmesh-tool-test",
      documents: new InMemoryDocumentStore({
        documents: {
          "guide.md": "Alpha Beta Gamma",
        },
      }),
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
      .find((tool) => tool.name === "read_expert_document");

    const result = await readTool?.call(
      {
        id: "guide.md",
      },
      undefined,
    );

    expect(result).toMatchObject({
      text: expect.stringContaining("Alpha"),
      details: {
        document: {
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

  it("searches documents through the store and normalizes result ordering", async () => {
    const store = new InMemoryDocumentStore({
      documents: [
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
    const indexer = new DocumentIndexer({ store });

    await expect(
      indexer.search({
        query: " search term ",
        maxResults: 10,
      }),
    ).resolves.toEqual(
      ok([
        {
          id: "alpha.md",
          lineNumber: 1,
          line: "Another search term here.",
        },
        {
          id: "zeta.md",
          lineNumber: 1,
          line: "Find the Search Term here.",
        },
      ]),
    );
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "expertmesh-agent-core-"));
  tempDirs.push(dir);
  return dir;
}

class CountingDocumentStore extends InMemoryDocumentStore {
  readCount = 0;
  lastListContext: unknown;
  lastReadContext: unknown;
  lastReadInput: ExpertAgentDocumentReadInput | undefined;

  override async listDocuments(input = {}) {
    this.lastListContext = "context" in input ? input.context : undefined;
    return await super.listDocuments(input);
  }

  override async readDocument(input: ExpertAgentDocumentReadInput) {
    this.readCount += 1;
    this.lastReadContext = input.context;
    this.lastReadInput = input;
    return await super.readDocument(input);
  }
}
