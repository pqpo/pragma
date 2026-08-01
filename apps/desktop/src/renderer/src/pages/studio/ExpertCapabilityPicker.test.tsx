import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Capability } from "../../../../shared/contracts/index.ts";
import { ExpertCapabilityPicker, matchingToolNames } from "./ExpertCapabilityPicker.tsx";

const toolCapability = {
  manifest: {
    schemaVersion: "pragma.capability/v2",
    id: "codewiki",
    runtimeKey: "codewiki",
    name: "CodeWiki",
    kind: "mcp_server",
    latestRevision: 1,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  },
  health: {
    revision: 1,
    status: "ready",
    checkedAt: "2026-07-17T00:00:00.000Z",
  },
  definition: {
    kind: "mcp_server",
    name: "CodeWiki",
    description: "Search and read repository documentation.",
    connection: {
      transport: "streamable-http",
      url: "https://example.com/mcp",
    },
    timeoutMs: 30_000,
    tools: [
      {
        name: "searchCodeWiki",
        description: "Semantic repository search",
        schemaHash: "a".repeat(64),
      },
      { name: "getCodeWikiPageContent", description: "Read a page", schemaHash: "b".repeat(64) },
      {
        name: "getCodeWikiStructure",
        description: "Browse the repository tree",
        schemaHash: "c".repeat(64),
      },
      { name: "createWorkspaceDoc", description: "Create a document", schemaHash: "d".repeat(64) },
      { name: "updateWorkspaceDoc", description: "Update a document", schemaHash: "e".repeat(64) },
    ],
  },
} satisfies Capability;

describe("ExpertCapabilityPicker", () => {
  it("keeps large capability collections behind compact category summaries", () => {
    const html = renderToStaticMarkup(
      <ExpertCapabilityPicker
        currentExpertId="current"
        resources={[]}
        contextStores={[]}
        capabilities={[toolCapability]}
        resourceTools={[]}
        contextStoreMounts={[]}
        capabilityReferences={[]}
        toolApprovals={{}}
        onResourceToolsChange={() => undefined}
        onContextStoreMountsChange={() => undefined}
        onCapabilityReferencesChange={() => undefined}
        onToolApprovalsChange={() => undefined}
      />,
    );

    expect(html).toContain("Capability library");
    expect(html).toContain("Experts, teams &amp; flows");
    expect(html).toContain("5 available");
    expect(html).not.toContain("searchCodeWiki");
    expect(html).not.toContain('role="dialog"');
  });

  it("searches tool names, descriptions, and their parent service", () => {
    expect(matchingToolNames(toolCapability, "semantic")).toEqual(["searchCodeWiki"]);
    expect(matchingToolNames(toolCapability, "tree")).toEqual(["getCodeWikiStructure"]);
    expect(matchingToolNames(toolCapability, "CodeWiki")).toHaveLength(5);
    expect(matchingToolNames(toolCapability, "calendar")).toEqual([]);
  });
});
