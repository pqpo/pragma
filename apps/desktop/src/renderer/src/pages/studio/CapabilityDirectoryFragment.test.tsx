import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Capability } from "../../../../shared/desktop-api.ts";
import {
  CapabilityDirectoryFragment,
  capabilityDeleteErrorMessage,
  codeDraftFromDefinition,
  fieldsToObjectSchema,
  formatCommandArguments,
  httpDraftFromDefinition,
  isEditableCapability,
  parseCommandArguments,
  toHttpToolDefinition,
} from "./CapabilityDirectoryFragment.tsx";

describe("code service field builder", () => {
  it("converts recursive object and array fields to a closed JSON Schema", () => {
    const fields: Parameters<typeof fieldsToObjectSchema>[0] = [
      {
        id: "records",
        name: "records",
        description: "Records to format.",
        required: true,
        value: {
          type: "array",
          fields: [],
          item: {
            type: "object",
            fields: [
              {
                id: "id",
                name: "id",
                description: "",
                required: true,
                value: { type: "string", fields: [] },
              },
            ],
          },
        },
      },
    ];

    expect(fieldsToObjectSchema(fields)).toEqual({
      type: "object",
      properties: {
        records: {
          type: "array",
          description: "Records to format.",
          items: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["records"],
      additionalProperties: false,
    });
  });

  it("round-trips nested schemas into an editable code draft", () => {
    const definition = {
      kind: "code_service" as const,
      name: "Formatter",
      description: "Formats records.",
      language: "javascript" as const,
      timeoutMs: 4_000,
      tool: {
        name: "format_records",
        description: "Format records.",
        inputSchema: {
          type: "object" as const,
          properties: {
            records: {
              type: "array" as const,
              description: "Records to format.",
              items: {
                type: "object" as const,
                properties: { id: { type: "string" as const } },
                required: ["id"],
                additionalProperties: false as const,
              },
            },
          },
          required: ["records"],
          additionalProperties: false as const,
        },
        outputSchema: {
          type: "object" as const,
          properties: { count: { type: "integer" as const } },
          required: ["count"],
          additionalProperties: false as const,
        },
        source: "function main(input) { return { count: input.records.length }; }",
      },
    };

    const draft = codeDraftFromDefinition(definition);

    expect(fieldsToObjectSchema(draft.inputFields)).toEqual(definition.tool.inputSchema);
    expect(fieldsToObjectSchema(draft.outputFields)).toEqual(definition.tool.outputSchema);
    expect(draft.timeoutMs).toBe(4_000);
  });
});

describe("capability edit drafts", () => {
  it("round-trips MCP command arguments containing whitespace and quotes", () => {
    const args = ["-y", "folder with spaces", "it's-ready", "", "line\nfeed"];

    expect(parseCommandArguments(formatCommandArguments(args))).toEqual(args);
    expect(() => parseCommandArguments("'unfinished")).toThrow("unfinished quote");
  });

  it("preserves HTTP parameter details and body schemas", () => {
    const definition = {
      kind: "http_service" as const,
      name: "Customer API",
      description: "Customer records.",
      baseUrl: "https://api.example.test/v1",
      auth: {
        type: "api_key_header" as const,
        headerName: "X-Customer-Key",
        credentialRef: "customer-key",
      },
      timeoutMs: 45_000,
      tools: [
        {
          name: "update_customer",
          description: "Update a customer.",
          method: "POST" as const,
          path: "/customers/{id}",
          parameters: [
            {
              name: "id",
              location: "path" as const,
              required: true,
              type: "integer" as const,
              description: "Customer ID.",
            },
            {
              name: "notify",
              location: "query" as const,
              required: true,
              type: "boolean" as const,
              description: "Send a notification.",
            },
          ],
          bodySchema: {
            type: "object" as const,
            properties: { name: { type: "string" as const } },
            required: ["name"],
            additionalProperties: false as const,
          },
        },
      ],
    };

    const draft = httpDraftFromDefinition(definition);

    expect(draft).toMatchObject({
      authType: "api_key_header",
      headerName: "X-Customer-Key",
      credentialRef: "customer-key",
      hasSavedCredential: true,
      timeoutMs: 45_000,
    });
    expect(toHttpToolDefinition(draft.tools[0]!)).toEqual(definition.tools[0]);
  });
});

describe("capability row actions", () => {
  const capability: Capability = {
    manifest: {
      schemaVersion: "pragma.capability/v1",
      id: "00000000-0000-4000-8000-000000000000",
      runtimeKey: "test_skill_00000000",
      name: "Test Skill",
      kind: "skill",
      latestRevision: 1,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    },
    health: { revision: 1, status: "ready", checkedAt: "2026-07-11T00:00:00.000Z" },
    definition: {
      kind: "skill",
      name: "Test Skill",
      description: "Test capability actions.",
      entryPath: "SKILL.md",
      contentHash: "a".repeat(64),
    },
  };

  it("presents the overflow button as a menu trigger instead of a delete action", () => {
    const html = renderToStaticMarkup(
      <CapabilityDirectoryFragment
        capabilities={[capability]}
        onOpen={() => undefined}
        onChanged={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="More actions for Test Skill"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('aria-label="Delete Test Skill"');
  });

  it("excludes Skills from editing while allowing all three tool capability kinds", () => {
    expect(isEditableCapability(capability)).toBe(false);
    for (const definition of [
      {
        kind: "mcp_server" as const,
        name: "MCP",
        description: "MCP server.",
        connection: {
          transport: "stdio" as const,
          command: "node",
          args: [],
          env: {},
          secretEnv: {},
        },
        timeoutMs: 30_000,
        tools: [],
      },
      {
        kind: "http_service" as const,
        name: "HTTP",
        description: "HTTP service.",
        baseUrl: "https://example.test",
        auth: { type: "none" as const },
        timeoutMs: 30_000,
        tools: [
          {
            name: "get_status",
            description: "Get status.",
            method: "GET" as const,
            path: "/status",
            parameters: [],
          },
        ],
      },
      {
        kind: "code_service" as const,
        name: "Code",
        description: "Code service.",
        language: "javascript" as const,
        timeoutMs: 2_000,
        tool: {
          name: "run",
          description: "Run code.",
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
          source: "function main() { return {}; }",
        },
      },
    ]) {
      expect(
        isEditableCapability({
          ...capability,
          definition,
          manifest: { ...capability.manifest, kind: definition.kind },
        }),
      ).toBe(true);
    }
  });

  it("maps referenced and unknown delete failures to friendly copy", () => {
    expect(capabilityDeleteErrorMessage("capability_referenced")).toContain(
      "still used by one or more Experts",
    );
    expect(capabilityDeleteErrorMessage()).toBe(
      "This capability could not be deleted. Please try again.",
    );
  });
});
