import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Capability } from "../../../../shared/contracts/index.ts";
import {
  CapabilityDetailFragment,
  formatFileSize,
  parseTestInput,
  skillMarkdownBody,
} from "./CapabilityDetailFragment.tsx";

const capability: Capability = {
  manifest: {
    schemaVersion: "pragma.capability/v1",
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
  it("shows capability metadata, tool details, and a JSON test panel", () => {
    const html = renderToStaticMarkup(
      <CapabilityDetailFragment
        capability={capability}
        onBack={() => undefined}
        onChanged={() => undefined}
      />,
    );

    expect(html).toContain("Back to Capabilities");
    expect(html).toContain("Revision 2");
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

    expect(skillMarkdownBody(source)).toBe("# Review\n\nRun tests.");
  });

  it("formats Skill file sizes for the file browser", () => {
    expect(formatFileSize(12)).toBe("12 B");
    expect(formatFileSize(1536)).toBe("1.5 KiB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.0 MiB");
  });

  it("requires test input to be a JSON object", () => {
    expect(parseTestInput('{"value":42}')).toEqual({ value: 42 });
    expect(() => parseTestInput("[]")).toThrow("Test input must be a JSON object.");
  });
});
