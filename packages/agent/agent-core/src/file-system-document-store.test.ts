import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ExpertAgentDocumentDeleteInput,
  ExpertAgentDocumentReadInput,
  ExpertAgentDocumentResult,
  ExpertAgentDocumentStore,
  ExpertAgentStoredDocument,
  ExpertAgentStoredDocumentCreateInput,
  ExpertAgentStoredDocumentSummary,
  ExpertAgentStoredDocumentUpdateInput
} from "./document-indexer.ts";
import { AGENTS_DOCUMENT_ID, DocumentIndexer, ok } from "./document-indexer.ts";
import { ExpertAgent } from "./expert-agent.ts";
import { FileSystemDocumentStore } from "./file-system-document-store.ts";

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
      documents: new FileSystemDocumentStore({ rootDir })
    });

    const context = await agent.buildContext();

    expect(context.documents).toContainEqual({
      id: AGENTS_DOCUMENT_ID,
      metadata: {
        trigger: "always_on"
      }
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
        content: "Plain instructions."
      }
    });
  });
});

describe("DocumentIndexer", () => {
  it("normalizes AGENTS.md as always-on for any document store", async () => {
    const store = new MemoryDocumentStore([
      {
        id: AGENTS_DOCUMENT_ID,
        content:
          "---\n" +
          'description: "Store metadata should be preserved."\n' +
          "trigger: manual\n" +
          "---\n" +
          "Shared instructions."
      }
    ]);
    const indexer = new DocumentIndexer({ store });

    await expect(indexer.index()).resolves.toEqual(
      ok([
        {
          id: AGENTS_DOCUMENT_ID,
          metadata: {
            description: "Store metadata should be preserved.",
            trigger: "always_on"
          }
        }
      ])
    );

    await expect(indexer.read({ id: AGENTS_DOCUMENT_ID })).resolves.toEqual(
      ok({
        id: AGENTS_DOCUMENT_ID,
        content: "Shared instructions.",
        metadata: {
          description: "Store metadata should be preserved.",
          trigger: "always_on"
        }
      })
    );
  });

  it("drops AGENTS.md update metadata before calling the document store", async () => {
    const store = new MemoryDocumentStore([
      {
        id: AGENTS_DOCUMENT_ID,
        content: "---\ntrigger: manual\n---\nOld instructions."
      }
    ]);
    const indexer = new DocumentIndexer({ store });

    await expect(
      indexer.update({
        id: AGENTS_DOCUMENT_ID,
        content: "New instructions.",
        metadata: {
          description: "Ignored metadata",
          trigger: "manual"
        }
      })
    ).resolves.toEqual(
      ok({
        id: AGENTS_DOCUMENT_ID,
        content: "New instructions.",
        metadata: {
          trigger: "always_on"
        }
      })
    );
    expect(store.documents.get(AGENTS_DOCUMENT_ID)).toEqual({
      id: AGENTS_DOCUMENT_ID,
      content: "New instructions."
    });
  });

  it("updates markdown frontmatter outside the document store", async () => {
    const store = new MemoryDocumentStore([
      {
        id: "guide.md",
        content: "---\ndescription: Old guide\ntrigger: manual\n---\nOld content."
      }
    ]);
    const indexer = new DocumentIndexer({ store });

    await expect(
      indexer.update({
        id: "guide.md",
        content: "New content.",
        metadata: {
          description: "New guide",
          trigger: "always_on"
        }
      })
    ).resolves.toEqual(
      ok({
        id: "guide.md",
        content: "New content.",
        metadata: {
          description: "New guide",
          trigger: "always_on"
        }
      })
    );
    expect(store.documents.get("guide.md")).toEqual({
      id: "guide.md",
      content: "---\ndescription: New guide\ntrigger: always_on\n---\nNew content."
    });
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "expertmesh-agent-core-"));
  tempDirs.push(dir);
  return dir;
}

class MemoryDocumentStore implements ExpertAgentDocumentStore {
  readonly documents = new Map<string, ExpertAgentStoredDocument>();

  constructor(documents: readonly ExpertAgentStoredDocument[]) {
    for (const document of documents) {
      this.documents.set(document.id, document);
    }
  }

  async listDocuments(): Promise<
    ExpertAgentDocumentResult<readonly ExpertAgentStoredDocumentSummary[]>
  > {
    return ok(
      [...this.documents.values()].map((document) => ({
        id: document.id
      }))
    );
  }

  async readDocument(
    input: ExpertAgentDocumentReadInput
  ): Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>> {
    return ok(this.documents.get(input.id) as ExpertAgentStoredDocument);
  }

  async createDocument(
    input: ExpertAgentStoredDocumentCreateInput
  ): Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>> {
    const document = {
      id: input.id,
      content: input.content
    } satisfies ExpertAgentStoredDocument;
    this.documents.set(input.id, document);
    return ok(document);
  }

  async updateDocument(
    input: ExpertAgentStoredDocumentUpdateInput
  ): Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>> {
    const existing = this.documents.get(input.id) as ExpertAgentStoredDocument;
    const document = {
      id: input.id,
      content: input.content ?? existing.content
    } satisfies ExpertAgentStoredDocument;
    this.documents.set(input.id, document);
    return ok(document);
  }

  async deleteDocument(
    input: ExpertAgentDocumentDeleteInput
  ): Promise<ExpertAgentDocumentResult<{ readonly id: string }>> {
    this.documents.delete(input.id);
    return ok({ id: input.id });
  }
}
