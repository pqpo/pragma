import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

export type DocumentTrigger = "always_on" | "model_decision" | "manual";

export interface IndexedDocumentMetadata {
  readonly description?: string;
  readonly trigger: DocumentTrigger;
}

export interface IndexedDocument {
  readonly id: string;
  readonly path: string;
  readonly relativePath: string;
  readonly content: string;
  readonly metadata: IndexedDocumentMetadata;
}

export interface DocumentIndexerOptions {
  readonly documentsDir?: string | undefined;
}

export class DocumentIndexer {
  readonly documentsDir: string | undefined;

  #documents: readonly IndexedDocument[] = [];

  constructor(options: DocumentIndexerOptions = {}) {
    this.documentsDir = options.documentsDir;
  }

  get documents(): readonly IndexedDocument[] {
    return this.#documents;
  }

  async index(): Promise<readonly IndexedDocument[]> {
    if (this.documentsDir === undefined) {
      this.#documents = [];
      return this.#documents;
    }

    const documentsRoot = resolve(this.documentsDir);
    const markdownFiles = await collectMarkdownFiles(documentsRoot);
    const documents = await Promise.all(
      markdownFiles.map(async (filePath) => {
        const rawContent = await readFile(filePath, "utf8");
        const parsed = parseMarkdownDocument(rawContent);
        const absolutePath = resolve(filePath);
        const relativePath = relative(documentsRoot, absolutePath);

        return {
          id: relativePath,
          path: absolutePath,
          relativePath,
          content: parsed.content,
          metadata: parsed.metadata
        };
      })
    );

    this.#documents = documents.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    );

    return this.#documents;
  }

  getByTrigger(trigger: DocumentTrigger): readonly IndexedDocument[] {
    return this.#documents.filter((document) => document.metadata.trigger === trigger);
  }

  getAlwaysOnDocuments(): readonly IndexedDocument[] {
    return this.getByTrigger("always_on");
  }

  getManualDocuments(): readonly IndexedDocument[] {
    return this.getByTrigger("manual");
  }

  getModelDecisionDocuments(): readonly IndexedDocument[] {
    return this.getByTrigger("model_decision");
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
      const entryPath = join(directory, entry.name);

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

function parseMarkdownDocument(rawContent: string): {
  readonly metadata: IndexedDocumentMetadata;
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

function parseMetadataBlock(metadataBlock: string): IndexedDocumentMetadata {
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

  const parsed: { description?: string; trigger: DocumentTrigger } = {
    trigger: parseDocumentTrigger(metadata.trigger)
  };

  if (metadata.description !== undefined) {
    parsed.description = metadata.description;
  }

  return parsed;
}

function parseDocumentTrigger(value: string | undefined): DocumentTrigger {
  if (value === "always_on" || value === "model_decision" || value === "manual") {
    return value;
  }

  return "model_decision";
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
