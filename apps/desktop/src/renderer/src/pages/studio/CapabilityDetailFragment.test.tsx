import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { skillPreviewBody } from "./SkillFileWorkspace.tsx";
import type { Capability } from "../../../../shared/contracts/index.ts";
import { CapabilityDetailFragment, parseTestInput } from "./CapabilityDetailFragment.tsx";

const capability: Capability = {
  manifest: {
    schemaVersion: "pragma.capability/v4",
    id: "00000000-0000-4000-8000-000000000000",
    runtimeKey: "customer_api_00000000",
    name: "Customer API",
    kind: "http_service",
    latestRevision: 2,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  },
  health: {
    revision: 2,
    status: "ready",
    checkedAt: "2026-07-11T00:00:00.000Z",
  },
  definition: {
    kind: "http_service",
    name: "Customer API",
    description: "Customer records.",
    baseUrl: "https://api.example.test/v1",
    auth: { type: "bearer", credentialRef: "service-auth" },
    timeoutMs: 30_000,
    tools: [
      {
        name: "get_customer",
        description: "Get a customer.",
        method: "GET",
        path: "/customers/{id}",
        parameters: [{ name: "id", location: "path", required: true, type: "string" }],
      },
    ],
  },
};

describe("CapabilityDetailFragment", () => {
  it("shows a built-in Skill version and suppresses every mutation action", () => {
    const html = renderToStaticMarkup(
      <CapabilityDetailFragment
        capability={{
          ...capability,
          managedBy: "system",
          manifest: { ...capability.manifest, name: "Author Pragma Flow", kind: "skill" },
          definition: {
            kind: "skill",
            name: "Author Pragma Flow",
            description: "Flow authoring",
            entryPath: "SKILL.md",
            contentHash: "0".repeat(64),
          },
        }}
        onBack={() => undefined}
        onChanged={() => undefined}
      />,
    );
    expect(html).toContain("Built-in");
    expect(html).toContain("Author Pragma Flow");
    expect(html).toContain("Revision 2");
    for (const action of [
      "Update from package",
      "Submit revision",
      "Delete",
      "Git settings",
      "Publish",
    ])
      expect(html).not.toContain(`>${action}<`);
  });

  it("shows connector tool details and a JSON test panel", () => {
    const html = renderToStaticMarkup(
      <CapabilityDetailFragment
        capability={capability}
        onBack={() => undefined}
        onChanged={() => undefined}
      />,
    );

    expect(html).toContain("Back to Capabilities");
    expect(html).toContain("Revision 2");
    expect(html).not.toContain('class="capability-detail-meta"');
    expect(html).toContain("get_customer");
    expect(html).toContain("/customers/{id}");
    expect(html).toContain("JSON input");
    expect(html).toContain("Run test");
    expect(html).not.toContain("service-auth");
    expect(html).toContain("capability-detail has-tool-workspace");
    expect(html.indexOf("capability-tool-detail")).toBeLessThan(
      html.indexOf("capability-tool-list"),
    );
    expect(html).toMatch(
      /studio-screen-header.*Back to Capabilities.*studio-screen-body.*Customer API/s,
    );
  });

  it("marks a system capability as built-in, keeps testing, and hides refresh", () => {
    const html = renderToStaticMarkup(
      <CapabilityDetailFragment
        capability={{
          ...capability,
          managedBy: "system",
          manifest: { ...capability.manifest, kind: "mcp_server" },
          definition: {
            kind: "mcp_server",
            name: "Pragma management tools",
            description: "Built-in Host tools.",
            connection: { transport: "streamable-http", url: "http://pragma.invalid/builtin" },
            timeoutMs: 30_000,
            tools: [
              {
                name: "knowledge_revision_list_targets",
                description: "List targets.",
                schemaHash: "sha256:test",
                inputSchema: {},
              },
            ],
          },
        }}
        onBack={() => undefined}
        onChanged={() => undefined}
      />,
    );

    expect(html).toContain("Built-in");
    expect(html).toContain('class="capability-detail-name-row"');
    expect(html).toContain('class="capability-built-in-chip">Built-in');
    expect(html).toContain("Run test");
    expect(html).not.toContain("Refresh tools");
  });

  it("renders Skill content with a submit revision action", () => {
    const html = renderToStaticMarkup(
      <CapabilityDetailFragment
        capability={{
          ...capability,
          manifest: { ...capability.manifest, kind: "skill", name: "Review Skill" },
          definition: {
            kind: "skill",
            name: "Review Skill",
            description: "Review code.",
            entryPath: "SKILL.md",
            contentHash: "a".repeat(64),
          },
        }}
        onBack={() => undefined}
        onChanged={() => undefined}
        onOpenRevisions={() => undefined}
        onExport={async () => undefined}
        onPublish={async () => undefined}
      />,
    );

    expect(html).toContain("skill-file-workspace");
    expect(html).not.toContain('class="capability-detail-meta"');
    expect(html).not.toContain("Documentation bundled with this Skill revision.");
    expect(html).not.toContain('class="skill-content-tabs"');
    expect(html).not.toContain("View source");
    expect(html).toContain('aria-label="Submit revision"');
    expect(html).toContain('role="tooltip">Submit revision</span>');
    expect(html).toContain('aria-label="Update from package"');
    expect(html).not.toContain("Revision tasks");
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('aria-label="Delete"');
    expect(html).toContain('aria-label="Export"');
    expect(html).toContain('aria-label="Publish to source"');
    const actions = Array.from(
      html.matchAll(/class="studio-action-button"[^>]*aria-label="([^"]+)"/g),
      (match) => match[1],
    );
    expect(actions).toEqual([
      "Save Skill",
      "Publish to source",
      "Submit revision",
      "Export",
      "Update from package",
      "Settings",
      "Delete",
      "More",
    ]);
    expect(html).not.toContain("Update Skill");
    expect(html).not.toContain("Prepare revision");
    expect(html).not.toContain("skill-revisions-heading");
  });

  it.each([
    {
      name: "MCP",
      definition: {
        kind: "mcp_server" as const,
        name: "Issue MCP",
        description: "Issue tools.",
        connection: {
          transport: "stdio" as const,
          command: "node",
          args: [],
          env: {},
          secretEnv: {},
        },
        timeoutMs: 30_000,
        tools: [
          {
            name: "find_issue",
            description: "Find an issue.",
            schemaHash: "sha256:test",
            inputSchema: {},
          },
        ],
      },
    },
    {
      name: "code",
      definition: {
        kind: "code_service" as const,
        name: "Formatter",
        description: "Formatting tool.",
        language: "javascript" as const,
        timeoutMs: 2_000,
        tool: {
          name: "format",
          description: "Format a value.",
          inputSchema: {
            type: "object" as const,
            properties: {},
            additionalProperties: false as const,
          },
          outputSchema: {
            type: "object" as const,
            properties: {},
            additionalProperties: false as const,
          },
          source: "function main(input) { return input; }",
        },
      },
    },
  ])("uses the same detail-left, list-right workspace for $name services", ({ definition }) => {
    const html = renderToStaticMarkup(
      <CapabilityDetailFragment
        capability={{
          ...capability,
          manifest: { ...capability.manifest, kind: definition.kind, name: definition.name },
          definition,
        }}
        onBack={() => undefined}
        onChanged={() => undefined}
      />,
    );

    expect(html).toContain("capability-detail has-tool-workspace");
    expect(html.indexOf("capability-tool-detail")).toBeLessThan(
      html.indexOf("capability-tool-list"),
    );
  });

  it("strips Skill frontmatter only from the rendered Markdown body", () => {
    const source = "---\nname: review\ndescription: Review code.\n---\n\n# Review\n\nRun tests.";

    expect(skillPreviewBody("SKILL.md", source)).toBe("# Review\n\nRun tests.");
  });

  it("requires test input to be a JSON object", () => {
    expect(parseTestInput('{"value":42}')).toEqual({ value: 42 });
    expect(() => parseTestInput("[]")).toThrow("Test input must be a JSON object.");
  });
});
