import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";

import type {
  DocumentTrigger,
  ExpertAgentDocument,
  ExpertAgentDocumentCreateInput,
  ExpertAgentDocumentDeleteInput,
  ExpertAgentDocumentMetadata,
  ExpertAgentDocumentReadInput,
  ExpertAgentDocumentResult,
  ExpertAgentDocumentStore,
  ExpertAgentDocumentSummary,
  ExpertAgentDocumentUpdateInput
} from "./document-indexer.ts";
import { error, normalizeDocument, normalizeTrigger, ok } from "./document-indexer.ts";

export interface FileSystemDocumentStoreOptions {
  readonly rootDir: string;
}

export class FileSystemDocumentStore implements ExpertAgentDocumentStore {
  readonly rootDir: string;

  constructor(options: FileSystemDocumentStoreOptions) {
    this.rootDir = resolve(options.rootDir);
  }

  async listDocuments(): Promise<ExpertAgentDocumentResult<readonly ExpertAgentDocumentSummary[]>> {
    try {
      const files = await collectMarkdownFiles(this.rootDir);
      const documents = await Promise.all(
        files.map(async (filePath) => {
          const rawContent = await readFile(filePath, "utf8");
          const parsed = parseMarkdownDocument(rawContent);

          return {
            id: toDocumentId(this.rootDir, filePath),
            metadata: parsed.metadata
          };
        })
      );

      return ok(documents);
    } catch (caught) {
      return error("store_error", "Failed to list file system documents.", toErrorDetails(caught));
    }
  }

  async readDocument(
    input: ExpertAgentDocumentReadInput
  ): Promise<ExpertAgentDocumentResult<ExpertAgentDocument>> {
    try {
      const filePath = this.resolveDocumentPath(input.id);

      if (!(await exists(filePath))) {
        return error("document_not_found", `Document not found: ${input.id}`, { id: input.id });
      }

      const rawContent = await readFile(filePath, "utf8");
      const parsed = parseMarkdownDocument(rawContent);

      return ok(
        normalizeDocument({
          id: input.id,
          content: parsed.content,
          metadata: parsed.metadata
        })
      );
    } catch (caught) {
      return error("store_error", `Failed to read document: ${input.id}`, toErrorDetails(caught));
    }
  }

  async createDocument(
    input: ExpertAgentDocumentCreateInput
  ): Promise<ExpertAgentDocumentResult<ExpertAgentDocument>> {
    try {
      const filePath = this.resolveDocumentPath(input.id);

      if (await exists(filePath)) {
        return error("document_already_exists", `Document already exists: ${input.id}`, {
          id: input.id
        });
      }

      const document = normalizeDocument({
        id: input.id,
        content: input.content,
        metadata: normalizeMetadata(input.metadata)
      });

      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, serializeMarkdownDocument(document), "utf8");

      return ok(document);
    } catch (caught) {
      return error("store_error", `Failed to create document: ${input.id}`, toErrorDetails(caught));
    }
  }

  async updateDocument(
    input: ExpertAgentDocumentUpdateInput
  ): Promise<ExpertAgentDocumentResult<ExpertAgentDocument>> {
    try {
      const existing = await this.readDocument({
        id: input.id,
        context: input.context
      });

      if (!existing.ok) {
        return existing;
      }

      const description = readUpdatedDescription(input, existing.value);
      const document = normalizeDocument({
        id: input.id,
        content: input.content ?? existing.value.content,
        metadata: {
          ...(description === undefined ? {} : { description }),
          trigger: normalizeTrigger(input.metadata?.trigger ?? existing.value.metadata.trigger)
        }
      });
      const filePath = this.resolveDocumentPath(input.id);
      await writeFile(filePath, serializeMarkdownDocument(document), "utf8");

      return ok(document);
    } catch (caught) {
      return error("store_error", `Failed to update document: ${input.id}`, toErrorDetails(caught));
    }
  }

  async deleteDocument(
    input: ExpertAgentDocumentDeleteInput
  ): Promise<ExpertAgentDocumentResult<{ readonly id: string }>> {
    try {
      const filePath = this.resolveDocumentPath(input.id);

      if (!(await exists(filePath))) {
        return error("document_not_found", `Document not found: ${input.id}`, { id: input.id });
      }

      await rm(filePath);

      return ok({ id: input.id });
    } catch (caught) {
      return error("store_error", `Failed to delete document: ${input.id}`, toErrorDetails(caught));
    }
  }

  private resolveDocumentPath(id: string): string {
    const filePath = resolve(this.rootDir, id);
    const relativePath = relative(this.rootDir, filePath);

    if (relativePath.startsWith("..") || relativePath === "" || relativePath.startsWith(sep)) {
      throw new Error(`Invalid document id: ${id}`);
    }

    return filePath;
  }
}

async function collectMarkdownFiles(directory: string): Promise<string[]> {
  const directoryStat = await stat(directory);

  if (!directoryStat.isDirectory()) {
    return extname(directory).toLowerCase() === ".md" ? [directory] : [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return collectMarkdownFiles(entryPath);
      }

      if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        return [entryPath];
      }

      return [];
    })
  );

  return nested.flat();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function toDocumentId(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).split(sep).join("/");
}

function parseMarkdownDocument(rawContent: string): {
  readonly metadata: ExpertAgentDocumentMetadata;
  readonly content: string;
} {
  if (!rawContent.startsWith("---\n")) {
    return {
      metadata: {
        trigger: "model_decision"
      },
      content: rawContent
    };
  }

  const closingIndex = rawContent.indexOf("\n---", 4);

  if (closingIndex === -1) {
    return {
      metadata: {
        trigger: "model_decision"
      },
      content: rawContent
    };
  }

  const metadataBlock = rawContent.slice(4, closingIndex);
  const contentStart = rawContent.startsWith("\n", closingIndex + 4)
    ? closingIndex + 5
    : closingIndex + 4;

  return {
    metadata: parseMetadataBlock(metadataBlock),
    content: rawContent.slice(contentStart)
  };
}

function parseMetadataBlock(metadataBlock: string): ExpertAgentDocumentMetadata {
  const metadata = Object.fromEntries(
    metadataBlock
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const separatorIndex = line.indexOf(":");

        if (separatorIndex === -1) {
          return [line, ""] as const;
        }

        const key = line.slice(0, separatorIndex).trim();
        const value = unquoteMetadataValue(line.slice(separatorIndex + 1).trim());

        return [key, value] as const;
      })
  );

  return normalizeMetadata({
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    trigger: normalizeTrigger(readMetadataTrigger(metadata.trigger))
  });
}

function normalizeMetadata(
  metadata: Partial<ExpertAgentDocumentMetadata> | undefined
): ExpertAgentDocumentMetadata {
  return {
    ...(metadata?.description === undefined ? {} : { description: metadata.description }),
    trigger: normalizeTrigger(metadata?.trigger)
  };
}

function readUpdatedDescription(
  input: ExpertAgentDocumentUpdateInput,
  existing: ExpertAgentDocument
): string | undefined {
  return input.metadata?.description === undefined
    ? existing.metadata.description
    : input.metadata.description;
}

function readMetadataTrigger(value: string | undefined): DocumentTrigger | undefined {
  if (value === "always_on" || value === "model_decision" || value === "manual") {
    return value;
  }

  return undefined;
}

function serializeMarkdownDocument(document: ExpertAgentDocument): string {
  return [
    "---",
    document.metadata.description === undefined
      ? undefined
      : `description: ${JSON.stringify(document.metadata.description)}`,
    `trigger: ${document.metadata.trigger}`,
    "---",
    document.content
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function unquoteMetadataValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function toErrorDetails(caught: unknown): unknown {
  if (caught instanceof Error) {
    return {
      name: caught.name,
      message: caught.message
    };
  }

  return caught;
}
