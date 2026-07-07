import { rm } from "node:fs/promises";

import type {
  ExpertAgentContextItemSearchMatch,
  ExpertAgentContextItemSummary,
  ExpertAgentContextResult,
  ExpertAgentContextStore,
  ExpertAgentStoredContextItem,
  ExpertAgentStoredContextItemDeleteInput,
  ExpertAgentStoredContextItemEditInput,
  ExpertAgentStoredContextItemEditResult,
  ExpertAgentStoredContextItemReadInput,
  ExpertAgentStoredContextItemReadResult,
  ExpertAgentStoredContextItemSearchInput,
  ExpertAgentStoredContextItemUpdateInput,
  ExpertAgentStoredContextRegisterInput,
  ExpertAgentPluginSetupContext,
} from "@pragma/core";
import { error, ok } from "@pragma/core";

import { SUMMARY_CONTEXT_ID } from "./constants.ts";
import { resolveConfig } from "./config.ts";
import {
  collectMemoryContextIds,
  createStoredContext,
  exists,
  readStoredContext,
  regenerateSummary,
  resolveContextPath,
  resolveMemoryRoot,
  toSummary,
  writeStoredMarkdown,
} from "./filesystem.ts";
import {
  calculateLineRange,
  inferSchemaVersion,
  normalizeMemoryContextId,
  normalizeWritableMemoryContextId,
  readContentRange,
  readContextLines,
  toErrorDetails,
  validateExpectedRevision,
} from "./utils.ts";

export function createSkillMemoryContextStore(
  context: ExpertAgentPluginSetupContext,
): ExpertAgentContextStore {
  return new FileSystemMemoryStore({
    agentId: context.agent?.id ?? "unknown-agent",
    context,
  });
}

export class FileSystemMemoryStore implements ExpertAgentContextStore {
  private readonly agentId: string;
  private readonly context: ExpertAgentPluginSetupContext;

  constructor(options: {
    readonly agentId: string;
    readonly context: ExpertAgentPluginSetupContext;
  }) {
    this.agentId = options.agentId;
    this.context = options.context;
  }

  async listContext(): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    try {
      const config = await resolveConfig(this.context);

      if (!config.enabled || !config.useMemories) {
        return ok([]);
      }

      const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
      const ids = await collectMemoryContextIds(rootDir);
      const summaries = await Promise.all(
        ids.map(async (id) => toSummary(await readStoredContext(rootDir, id))),
      );
      return ok(summaries);
    } catch (caught) {
      return error("store_error", "Failed to list skill memory.", toErrorDetails(caught));
    }
  }

  async readContext(
    input: ExpertAgentStoredContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>> {
    try {
      const config = await resolveConfig(this.context);

      if (!config.enabled || !config.useMemories) {
        return error("store_unavailable", "Skill memory is disabled.");
      }

      const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
      const id = normalizeMemoryContextId(input.id);

      if (!id.ok) {
        return id;
      }

      if (id.value === SUMMARY_CONTEXT_ID) {
        await regenerateSummary(rootDir, this.context, this.agentId);
      }

      const stored = await readStoredContext(rootDir, id.value);
      const range = readContentRange(stored.content, {
        start: input.start ?? 0,
        offset: input.offset,
      });
      const lineRange = calculateLineRange(stored.content, range.startOffset, range.endOffset);

      return ok({
        ...stored,
        content: range.content,
        contentRange: {
          requestedStartOffset: range.requestedStartOffset,
          startOffset: range.startOffset,
          endOffset: range.endOffset,
          nextStartOffset: range.nextStartOffset,
          truncated: range.truncated,
          sizeBytes: stored.sizeBytes,
          ...(input.offset === undefined ? {} : { maxBytes: Math.max(1, input.offset) }),
          startLine: lineRange.startLine,
          endLine: lineRange.endLine,
          totalLines: lineRange.totalLines,
        },
      });
    } catch (caught) {
      return error("context_not_found", `Skill memory context not found: ${input.id}`, {
        id: input.id,
        ...toErrorDetails(caught),
      });
    }
  }

  async addContext(
    input: ExpertAgentStoredContextRegisterInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    try {
      const config = await resolveConfig(this.context);
      const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
      const id = normalizeWritableMemoryContextId(input.id);

      if (!id.ok) {
        return id;
      }

      const filePath = resolveContextPath(rootDir, id.value);

      if (await exists(filePath)) {
        return error("context_already_exists", `Skill memory context already exists: ${id.value}`);
      }

      const stored = createStoredContext({
        id: id.value,
        content: input.content,
        metadata: input.metadata,
      });
      await writeStoredMarkdown(rootDir, stored, {
        schemaVersion: inferSchemaVersion(id.value),
        agentId: this.agentId,
        updatedAt: new Date().toISOString(),
        audit: { createdBy: "skill-memory" },
      });

      if (id.value.startsWith("skills/")) {
        await regenerateSummary(rootDir, this.context, this.agentId);
      }

      return ok(await readStoredContext(rootDir, id.value));
    } catch (caught) {
      return error("store_error", `Failed to add skill memory context: ${input.id}`, {
        id: input.id,
        ...toErrorDetails(caught),
      });
    }
  }

  async updateContext(
    input: ExpertAgentStoredContextItemUpdateInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    try {
      const config = await resolveConfig(this.context);
      const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
      const id = normalizeWritableMemoryContextId(input.id);

      if (!id.ok) {
        return id;
      }

      const existing = await readStoredContext(rootDir, id.value);
      const conflict = validateExpectedRevision(existing, input);

      if (conflict !== undefined) {
        return conflict;
      }

      const stored = createStoredContext({
        id: id.value,
        content: input.content ?? existing.content,
        metadata: input.metadata ?? existing.metadata,
      });
      await writeStoredMarkdown(rootDir, stored, {
        schemaVersion: inferSchemaVersion(id.value),
        agentId: this.agentId,
        updatedAt: new Date().toISOString(),
        audit: { createdBy: "skill-memory" },
      });

      if (id.value.startsWith("skills/")) {
        await regenerateSummary(rootDir, this.context, this.agentId);
      }

      return ok(await readStoredContext(rootDir, id.value));
    } catch (caught) {
      return error("store_error", `Failed to update skill memory context: ${input.id}`, {
        id: input.id,
        ...toErrorDetails(caught),
      });
    }
  }

  async editContext(
    input: ExpertAgentStoredContextItemEditInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemEditResult>> {
    try {
      const config = await resolveConfig(this.context);
      const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
      const id = normalizeWritableMemoryContextId(input.id);

      if (!id.ok) {
        return id;
      }

      const existing = await readStoredContext(rootDir, id.value);
      const conflict = validateExpectedRevision(existing, input);

      if (conflict !== undefined) {
        return conflict;
      }

      const replacementCount = existing.content.split(input.search).length - 1;

      if (replacementCount === 0) {
        return error("invalid_input", `Skill memory edit search did not match: ${id.value}`, {
          id: id.value,
          search: input.search,
        });
      }

      if (replacementCount > 1 && input.replaceAll !== true) {
        return error(
          "invalid_input",
          `Skill memory edit search matched multiple locations: ${id.value}`,
          {
            id: id.value,
            search: input.search,
            replacementCount,
          },
        );
      }

      const content =
        input.replaceAll === true
          ? existing.content.split(input.search).join(input.replace)
          : existing.content.replace(input.search, input.replace);
      const stored = createStoredContext({
        id: id.value,
        content,
        metadata: existing.metadata,
      });
      await writeStoredMarkdown(rootDir, stored, {
        schemaVersion: inferSchemaVersion(id.value),
        agentId: this.agentId,
        updatedAt: new Date().toISOString(),
        audit: { createdBy: "skill-memory" },
      });

      if (id.value.startsWith("skills/")) {
        await regenerateSummary(rootDir, this.context, this.agentId);
      }

      return ok({
        ...(await readStoredContext(rootDir, id.value)),
        replacementCount: input.replaceAll === true ? replacementCount : 1,
      });
    } catch (caught) {
      return error("store_error", `Failed to edit skill memory context: ${input.id}`, {
        id: input.id,
        ...toErrorDetails(caught),
      });
    }
  }

  async deleteContext(
    input: ExpertAgentStoredContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<{ readonly id: string }>> {
    try {
      const config = await resolveConfig(this.context);
      const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
      const id = normalizeWritableMemoryContextId(input.id);

      if (!id.ok) {
        return id;
      }

      const filePath = resolveContextPath(rootDir, id.value);

      if (!(await exists(filePath))) {
        return error("context_not_found", `Skill memory context not found: ${id.value}`, {
          id: id.value,
        });
      }

      await rm(filePath);

      if (id.value.startsWith("skills/")) {
        await regenerateSummary(rootDir, this.context, this.agentId);
      }

      return ok({ id: id.value });
    } catch (caught) {
      return error("store_error", `Failed to delete skill memory context: ${input.id}`, {
        id: input.id,
        ...toErrorDetails(caught),
      });
    }
  }

  async searchContext(
    input: ExpertAgentStoredContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    try {
      const config = await resolveConfig(this.context);

      if (!config.enabled || !config.useMemories) {
        return ok([]);
      }

      const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
      const ids = await collectMemoryContextIds(rootDir);
      const query = input.caseSensitive === true ? input.query : input.query.toLowerCase();
      const maxResults = input.maxResults ?? 20;
      const contextLines = input.contextLines ?? 0;
      const matches: ExpertAgentContextItemSearchMatch[] = [];

      for (const id of ids) {
        const stored = await readStoredContext(rootDir, id);
        const lines = stored.content.split("\n");

        for (const [index, line] of lines.entries()) {
          const searchedLine = input.caseSensitive === true ? line : line.toLowerCase();

          if (!searchedLine.includes(query)) {
            continue;
          }

          matches.push({
            id,
            lineNumber: index + 1,
            line,
            before: readContextLines(lines, index - contextLines, index),
            after: readContextLines(lines, index + 1, index + 1 + contextLines),
          });

          if (matches.length >= maxResults) {
            return ok(matches);
          }
        }
      }

      return ok(matches);
    } catch (caught) {
      return error("store_error", "Failed to search skill memory.", toErrorDetails(caught));
    }
  }
}
