import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";

import type {
  ExpertAgentDocumentDeleteInput,
  ExpertAgentDocumentReadInput,
  ExpertAgentDocumentResult,
  ExpertAgentDocumentSummary,
  ExpertAgentDocumentStore,
  ExpertAgentStoredDocument,
  ExpertAgentStoredDocumentCreateInput,
  ExpertAgentStoredDocumentUpdateInput
} from "./document-indexer.ts";
import { error, ok, parseStoredDocument } from "./document-indexer.ts";

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
          const storedDocument = {
            id: toDocumentId(this.rootDir, filePath),
            content: await readFile(filePath, "utf8")
          };
          const document = parseStoredDocument(storedDocument);

          return {
            id: document.id,
            metadata: document.metadata
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
  ): Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>> {
    try {
      const filePath = this.resolveDocumentPath(input.id);

      if (!(await exists(filePath))) {
        return error("document_not_found", `Document not found: ${input.id}`, { id: input.id });
      }

      return ok(
        {
          id: input.id,
          content: await readFile(filePath, "utf8")
        }
      );
    } catch (caught) {
      return error("store_error", `Failed to read document: ${input.id}`, toErrorDetails(caught));
    }
  }

  async createDocument(
    input: ExpertAgentStoredDocumentCreateInput
  ): Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>> {
    try {
      const filePath = this.resolveDocumentPath(input.id);

      if (await exists(filePath)) {
        return error("document_already_exists", `Document already exists: ${input.id}`, {
          id: input.id
        });
      }

      const document = {
        id: input.id,
        content: input.content
      };

      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, document.content, "utf8");

      return ok(document);
    } catch (caught) {
      return error("store_error", `Failed to create document: ${input.id}`, toErrorDetails(caught));
    }
  }

  async updateDocument(
    input: ExpertAgentStoredDocumentUpdateInput
  ): Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>> {
    try {
      const existing = await this.readDocument({
        id: input.id,
        context: input.context
      });

      if (!existing.ok) {
        return existing;
      }

      const document = {
        id: input.id,
        content: input.content ?? existing.value.content
      };
      const filePath = this.resolveDocumentPath(input.id);
      await writeFile(filePath, document.content, "utf8");

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

function toErrorDetails(caught: unknown): unknown {
  if (caught instanceof Error) {
    return {
      name: caught.name,
      message: caught.message
    };
  }

  return caught;
}
