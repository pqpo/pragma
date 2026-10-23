import type { ExpertAgentManagedTool, ExpertAgentToolCallResult } from "@pragma/core";
import {
  MANAGED_RESOURCE_QUERY_SCHEMAS,
  type ManagedResourceCommand,
  type ManagedResourceQuery,
} from "@pragma/shared/integration";
import { z } from "zod";
import type { PragmaManagedResourceQueryPort } from "./ports.ts";

export const MANAGED_RESOURCE_QUERY_TOOLS = {
  "skill.list": "list_managed_skills",
  "skill.get": "get_managed_skill",
  "skill.files.list": "list_managed_skill_files",
  "skill.files.read": "read_managed_skill_file",
  "knowledge-store.get": "get_managed_knowledge_store",
  "knowledge-store.documents.list": "list_managed_knowledge_documents",
  "knowledge-store.documents.search": "search_managed_knowledge_documents",
  "knowledge-store.documents.read": "read_managed_knowledge_document",
} as const satisfies Record<ManagedResourceCommand, string>;

const descriptions: Record<ManagedResourceCommand, string> = {
  "skill.list":
    "Discover all managed Skills, including unmounted and system Skills. Filter by query, status or managedBy.",
  "skill.get":
    "Read a Skill summary, SKILL.md (view=content), or associated DSL definitions (view=definition). Defaults to the latest formal revision, never a draft.",
  "skill.files.list":
    "List files in an exact formal Skill package. Copy continuation for further pages.",
  "skill.files.read":
    "Read a formal Skill text file. Copy continuation for the next content range; binary files return an explicit unreadable result.",
  "knowledge-store.get":
    "Read a formal knowledge base summary or associated DSL definitions. storeId is not a DSL ref or Context namespace.",
  "knowledge-store.documents.list":
    "List documents in a formal knowledge base snapshot, whether or not it is mounted.",
  "knowledge-store.documents.search":
    "Search paths or content within one formal knowledge base snapshot. Returns bounded snippets and document identities.",
  "knowledge-store.documents.read":
    "Read one formal knowledge document and its metadata. Copy continuation to continue the same snapshot.",
};

export const PRAGMA_MANAGED_RESOURCE_TOOL_DEFINITIONS = Object.entries(
  MANAGED_RESOURCE_QUERY_SCHEMAS,
).map(([key, schemas]) => {
  const command = key as ManagedResourceCommand;
  return {
    name: MANAGED_RESOURCE_QUERY_TOOLS[command],
    description: descriptions[command],
    inputSchema: z.toJSONSchema(schemas.input),
    outputSchema: z.toJSONSchema(schemas.output),
    approval: { mode: "none" as const },
  };
});

export function createPragmaManagedResourceTools(
  port: PragmaManagedResourceQueryPort,
): readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] {
  return PRAGMA_MANAGED_RESOURCE_TOOL_DEFINITIONS.map((definition) => ({
    ...definition,
    async call(input) {
      const command = (Object.keys(MANAGED_RESOURCE_QUERY_TOOLS) as ManagedResourceCommand[]).find(
        (key) => MANAGED_RESOURCE_QUERY_TOOLS[key] === definition.name,
      )!;
      const schemas = MANAGED_RESOURCE_QUERY_SCHEMAS[command];
      const request = { command, input: schemas.input.parse(input) } as ManagedResourceQuery;
      const details = schemas.output.parse(await port.execute(request));
      return { text: JSON.stringify(details), details };
    },
  }));
}
