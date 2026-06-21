import type {
  ExpertAgentDocumentDeleteInput,
  ExpertAgentDocumentReadInput,
  ExpertAgentDocumentResult,
  ExpertAgentDocumentSearchInput,
  ExpertAgentDocumentSearchMatch,
  ExpertAgentDocumentStore,
  ExpertAgentDocumentSummary,
  ExpertAgentStoredDocument,
  ExpertAgentStoredDocumentCreateInput,
  ExpertAgentStoredDocumentUpdateInput,
} from "./document-indexer.ts";
import { error, ok, parseStoredDocument } from "./document-indexer.ts";

export type InMemoryDocumentStoreDocumentMap = Readonly<Record<string, string>>;

export interface InMemoryDocumentStoreOptions {
  readonly documents?:
    | readonly ExpertAgentStoredDocument[]
    | InMemoryDocumentStoreDocumentMap
    | undefined;
}

export class InMemoryDocumentStore implements ExpertAgentDocumentStore {
  readonly documents = new Map<string, ExpertAgentStoredDocument>();

  constructor(options: InMemoryDocumentStoreOptions = {}) {
    for (const document of normalizeSeedDocuments(options.documents)) {
      this.documents.set(document.id, document);
    }
  }

  async listDocuments(): Promise<ExpertAgentDocumentResult<readonly ExpertAgentDocumentSummary[]>> {
    return ok(
      [...this.documents.values()].map((storedDocument) => {
        const document = parseStoredDocument(storedDocument);

        return {
          id: document.id,
          metadata: document.metadata,
        };
      }),
    );
  }

  async readDocument(
    input: ExpertAgentDocumentReadInput,
  ): Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>> {
    const existing = this.documents.get(input.id);

    if (existing === undefined) {
      return error("document_not_found", `Document not found: ${input.id}`, { id: input.id });
    }

    return ok(existing);
  }

  async createDocument(
    input: ExpertAgentStoredDocumentCreateInput,
  ): Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>> {
    if (this.documents.has(input.id)) {
      return error("document_already_exists", `Document already exists: ${input.id}`, {
        id: input.id,
      });
    }

    const document = {
      id: input.id,
      content: input.content,
    } satisfies ExpertAgentStoredDocument;
    this.documents.set(input.id, document);

    return ok(document);
  }

  async updateDocument(
    input: ExpertAgentStoredDocumentUpdateInput,
  ): Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>> {
    const existing = this.documents.get(input.id);

    if (existing === undefined) {
      return error("document_not_found", `Document not found: ${input.id}`, { id: input.id });
    }

    const document = {
      id: input.id,
      content: input.content ?? existing.content,
    } satisfies ExpertAgentStoredDocument;
    this.documents.set(input.id, document);

    return ok(document);
  }

  async deleteDocument(
    input: ExpertAgentDocumentDeleteInput,
  ): Promise<ExpertAgentDocumentResult<{ readonly id: string }>> {
    if (!this.documents.has(input.id)) {
      return error("document_not_found", `Document not found: ${input.id}`, { id: input.id });
    }

    this.documents.delete(input.id);

    return ok({ id: input.id });
  }

  async searchDocuments(
    input: ExpertAgentDocumentSearchInput,
  ): Promise<ExpertAgentDocumentResult<readonly ExpertAgentDocumentSearchMatch[]>> {
    const query = input.caseSensitive === true ? input.query : input.query.toLocaleLowerCase();
    const matches: ExpertAgentDocumentSearchMatch[] = [];
    const maxResults = input.maxResults ?? 20;
    const contextLines = input.contextLines ?? 0;

    for (const document of this.documents.values()) {
      const lines = document.content.split("\n");

      for (const [index, line] of lines.entries()) {
        const searchedLine = input.caseSensitive === true ? line : line.toLocaleLowerCase();

        if (!searchedLine.includes(query)) {
          continue;
        }

        matches.push({
          id: document.id,
          lineNumber: index + 1,
          line: trimLineEnd(line),
          before: readContextLines(lines, index - contextLines, index),
          after: readContextLines(lines, index + 1, index + 1 + contextLines),
        });

        if (matches.length >= maxResults) {
          return ok(matches);
        }
      }
    }

    return ok(matches);
  }
}

export function createInMemoryDocumentStore(
  options: InMemoryDocumentStoreOptions = {},
): InMemoryDocumentStore {
  return new InMemoryDocumentStore(options);
}

function normalizeSeedDocuments(
  documents: InMemoryDocumentStoreOptions["documents"],
): readonly ExpertAgentStoredDocument[] {
  if (documents === undefined) {
    return [];
  }

  if (Array.isArray(documents)) {
    return documents.map((document) => ({
      id: document.id,
      content: document.content,
    }));
  }

  return Object.entries(documents).map(([id, content]) => ({
    id,
    content,
  }));
}

function readContextLines(
  lines: readonly string[],
  start: number,
  end: number,
): readonly string[] | undefined {
  const context = lines.slice(Math.max(0, start), Math.max(0, end)).map(trimLineEnd);

  return context.length === 0 ? undefined : context;
}

function trimLineEnd(line: string): string {
  return line.replace(/\r?\n$/, "");
}
