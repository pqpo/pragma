import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ExpertAgentDocumentReadInput,
} from "./document-indexer.ts";
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

    expect(context.documents).toContainEqual({
      id: AGENTS_DOCUMENT_ID,
      metadata: {
        trigger: "always_on",
      },
    });
    expect(context.systemPrompt).toContain("Always-on documents");
    expect(context.systemPrompt).toContain(AGENTS_DOCUMENT_ID);
    expect(context.systemPrompt).toContain("Use direct instructions.");
    expect(context.systemPrompt).not.toContain("AGENTS.md instructions:");
  });

  it("returns raw AGENTS.md content without parsing metadata", async () => {
    const rootDir = await createTempDir();
    const store = new FileSystemDocumentStore({ rootDir });
    await writeFile(join(rootDir, AGENTS_DOCUMENT_ID), "Plain instructions.", "utf8");

    const result = await store.readDocument({ id: AGENTS_DOCUMENT_ID });

    expect(result).toEqual({
      ok: true,
      value: {
        id: AGENTS_DOCUMENT_ID,
        content: "Plain instructions.",
      },
    });
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
      documents: {
        "alpha.md": "---\ndescription: Alpha\ntrigger: manual\n---\nAlpha content.",
        "beta.md": "Beta needle.",
      },
    });

    await expect(store.listDocuments()).resolves.toEqual(
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
          content:
            "---\n" +
            'description: "Store metadata should be preserved."\n' +
            "trigger: manual\n" +
            "---\n" +
            "Shared instructions.",
        },
      ],
    });
    const indexer = new DocumentIndexer({ store });

    await expect(indexer.index()).resolves.toEqual(
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

    await expect(indexer.read({ id: AGENTS_DOCUMENT_ID })).resolves.toEqual(
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
          content: "---\ntrigger: manual\n---\nIndexed content.",
        },
      ],
    });
    const indexer = new DocumentIndexer({ store });

    await expect(indexer.index()).resolves.toEqual(
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

  it("drops AGENTS.md update metadata before calling the document store", async () => {
    const store = new InMemoryDocumentStore({
      documents: [
        {
          id: AGENTS_DOCUMENT_ID,
          content: "---\ntrigger: manual\n---\nOld instructions.",
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
    ).resolves.toEqual(
      ok({
        id: AGENTS_DOCUMENT_ID,
        content: "New instructions.",
        metadata: {
          trigger: "always_on",
        },
      }),
    );
    expect(store.documents.get(AGENTS_DOCUMENT_ID)).toEqual({
      id: AGENTS_DOCUMENT_ID,
      content: "New instructions.",
    });
  });

  it("updates markdown frontmatter outside the document store", async () => {
    const store = new InMemoryDocumentStore({
      documents: [
        {
          id: "guide.md",
          content: "---\ndescription: Old guide\ntrigger: manual\n---\nOld content.",
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
    ).resolves.toEqual(
      ok({
        id: "guide.md",
        content: "New content.",
        metadata: {
          description: "New guide",
          trigger: "always_on",
        },
      }),
    );
    expect(store.documents.get("guide.md")).toEqual({
      id: "guide.md",
      content: "---\ndescription: New guide\ntrigger: always_on\n---\nNew content.",
    });
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

  override async readDocument(input: ExpertAgentDocumentReadInput) {
    this.readCount += 1;
    return await super.readDocument(input);
  }
}
